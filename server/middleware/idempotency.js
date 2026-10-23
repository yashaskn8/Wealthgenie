import { randomUUID } from 'node:crypto';
import IdempotencyKey from '../models/IdempotencyKey.js';
import Recommendation from '../models/Recommendation.js';
import { canonicalSha256 } from '../utils/canonicalJson.js';
import { createError, errorEnvelope, sendError } from './errorHandler.js';
import { buildPostCommitAdvisoryResponse } from '../services/advisoryResponse.js';
import { reachFinancialStateTestHook } from '../services/financialStateTestHooks.js';
import { verifyPersistenceIndexes } from '../services/persistenceIndexReadiness.js';

const MUTATION_LEASE_MS = 30_000;
const MUTATION_HEARTBEAT_MS = 8_000;
const MUTATION_WAIT_MS = 5_000;
const POLL_INTERVAL_MS = 40;
const SAFE_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
async function ensureDurableIdempotencyReady() {
  // Read-only verification. Schema migration is an explicit deployment task;
  // a mutation request must never alter MongoDB's index catalog.
  return verifyPersistenceIndexes();
}

function mutationError(status, message, code, details) {
  return createError(status, message, message, { code, details });
}

export function assertValidIdempotencyKey(key) {
  if (typeof key !== 'string' || !SAFE_KEY.test(key)) {
    throw mutationError(400, 'A valid Idempotency-Key header (8-128 URL-safe characters) is required.', 'INVALID_IDEMPOTENCY_KEY');
  }
}

export function mutationOperationId({ operation, userId, key }) {
  return `mutation:${canonicalSha256({ version: 1, operation, userId: String(userId), key })}`;
}

export function mutationRequestHash(req, operation, userId) {
  return canonicalSha256({
    version: 1,
    operation,
    userId: String(userId),
    method: String(req.method || '').toUpperCase(),
    routePath: String(req.path || ''),
    resourceScope: req.params || {},
    query: req.query || {},
    payload: req.body || {},
  });
}

async function resolveMutationReplay(req, record, resolveReplay) {
  if (typeof resolveReplay !== 'function' || !record.resourceId || !record.resourceType) {
    throw mutationError(503, 'The committed operation cannot be safely reconciled.', 'IDEMPOTENCY_STATE_CORRUPT');
  }
  const body = await resolveReplay(req, record);
  return { status: record.responseStatus || 200, body };
}

/**
 * Reconcile a worker that lost its lease with a successor that already
 * committed the same operation. The resolver remains ownership-scoped and
 * rebuilds the response from the durable resource, not the old worker's body.
 */
export async function resolveCommittedMutationForClaim(req, claim) {
  if (!claim?.operationId || !claim?.requestHash || !req.user?.userId) return null;
  const record = await IdempotencyKey.findOne({
    _id: claim.operationId,
    userId: req.user.userId,
    requestHash: claim.requestHash,
    status: 'DONE',
  }).lean();
  if (!record) return null;
  return resolveMutationReplay(req, record, req.idempotencyResolveReplay);
}

async function pollForMutationCompletion({ req, operationId, requestHash, resolveReplay, firstState }) {
  const deadline = Date.now() + MUTATION_WAIT_MS;
  let state = firstState;
  while (Date.now() < deadline) {
    if (state.requestHash !== requestHash) {
      throw mutationError(409, 'This Idempotency-Key was already used for a different request.', 'IDEMPOTENCY_PAYLOAD_CONFLICT');
    }
    if (state.status === 'DONE') return resolveMutationReplay(req, state, resolveReplay);
    if (state.leaseExpiresAt && new Date(state.leaseExpiresAt).getTime() <= Date.now()) return null;
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    state = await IdempotencyKey.findById(operationId).lean();
    if (!state) return null;
  }
  throw mutationError(409, 'The matching mutation is still in progress. Retry with the same Idempotency-Key.', 'IDEMPOTENCY_IN_PROGRESS');
}

async function claimMutation({ req, operation, userId, key, requestHash }) {
  await ensureDurableIdempotencyReady();
  const operationId = mutationOperationId({ operation, userId, key });
  let ownerToken = randomUUID();
  for (;;) {
    const existing = await IdempotencyKey.findById(operationId).lean();
    if (!existing) {
      try {
        await IdempotencyKey.create({
          _id: operationId,
          status: 'LOCK',
          operation,
          method: req.method.toUpperCase(),
          userId,
          requestHash,
          lockOwnerId: ownerToken,
          leaseExpiresAt: new Date(Date.now() + MUTATION_LEASE_MS),
        });
        return { operationId, operation, userId, requestHash, ownerToken, lost: false };
      } catch (error) {
        if (error.code !== 11000) throw error;
        continue;
      }
    }
    if (existing.requestHash !== requestHash) {
      throw mutationError(409, 'This Idempotency-Key was already used for a different request.', 'IDEMPOTENCY_PAYLOAD_CONFLICT');
    }
    if (existing.status === 'DONE') return { replay: await resolveMutationReplay(req, existing, req.idempotencyResolveReplay) };

    await reachFinancialStateTestHook('idempotency.mutation.lockObserved', {
      operation,
      operationId,
      status: existing.status,
      leaseExpiresAt: existing.leaseExpiresAt,
    });

    const replay = await pollForMutationCompletion({
      req,
      operationId,
      requestHash,
      resolveReplay: req.idempotencyResolveReplay,
      firstState: existing,
    });
    if (replay) return { replay };

    // A lease only permits a new worker to try. The business transaction must
    // also complete this exact owner token, so an expired worker cannot commit.
    ownerToken = randomUUID();
    const now = new Date();
    const recovered = await IdempotencyKey.findOneAndUpdate({
      _id: operationId,
      status: 'LOCK',
      requestHash,
      lockOwnerId: existing.lockOwnerId,
      leaseExpiresAt: { $lte: now },
    }, {
      $set: { lockOwnerId: ownerToken, leaseExpiresAt: new Date(now.getTime() + MUTATION_LEASE_MS) },
    }, { new: true, runValidators: true }).lean();
    if (recovered) return { operationId, operation, userId, requestHash, ownerToken, lost: false };
  }
}

/** Complete the operation in the same Mongo transaction as the durable create. */
export async function completeMutationIdempotency(session, claim, { resourceType, resourceId, status = 201 } = {}) {
  if (!claim?.operationId || !claim?.ownerToken || !['FinancialProfile', 'Goal', 'CoverageResult'].includes(resourceType) || !resourceId) {
    throw mutationError(503, 'Mutation idempotency completion is not bound to a durable resource.', 'IDEMPOTENCY_STATE_CORRUPT');
  }
  if (claim.lost) throw mutationError(503, 'The mutation idempotency lease was lost before commit.', 'IDEMPOTENCY_UNAVAILABLE');
  const result = await IdempotencyKey.updateOne({
    _id: claim.operationId,
    status: 'LOCK',
    requestHash: claim.requestHash,
    lockOwnerId: claim.ownerToken,
  }, {
    $set: {
      status: 'DONE', resourceType, resourceId, responseStatus: status, committedAt: new Date(),
      lockOwnerId: null, leaseExpiresAt: null,
    },
  }, { session, runValidators: true });
  if (result.matchedCount !== 1) throw mutationError(503, 'Mutation idempotency ownership changed before commit.', 'IDEMPOTENCY_UNAVAILABLE');
}

export async function releaseMutationIdempotency(claim) {
  if (!claim?.operationId || !claim?.ownerToken) return;
  clearInterval(claim.heartbeat);
  const result = await IdempotencyKey.deleteOne({
    _id: claim.operationId,
    status: 'LOCK',
    requestHash: claim.requestHash,
    lockOwnerId: claim.ownerToken,
  });
  await reachFinancialStateTestHook('idempotency.mutation.released', {
    operation: claim.operation,
    operationId: claim.operationId,
    deletedCount: result.deletedCount,
  });
}

/** The exact lease refresh used by the timer; exported for deterministic fault tests. */
export async function heartbeatMutationIdempotency(claim) {
  if (!claim?.operationId || !claim?.ownerToken) return false;
  try {
    const updated = await IdempotencyKey.updateOne({
      _id: claim.operationId,
      status: 'LOCK',
      requestHash: claim.requestHash,
      lockOwnerId: claim.ownerToken,
    }, { $set: { leaseExpiresAt: new Date(Date.now() + MUTATION_LEASE_MS) } });
    if (updated.matchedCount !== 1) claim.lost = true;
  } catch {
    // A failed heartbeat is a lost lease. Transaction completion remains
    // guarded by the same owner-token check and refuses to commit.
    claim.lost = true;
  }
  return !claim.lost;
}

/**
 * Durable, operation-scoped idempotency middleware for create mutations.
 * A committed result is replayed from its owned resource, never a short-lived
 * Redis response cache. Route handlers must call completeMutationIdempotency
 * inside the same transaction as the resource write and set
 * req.idempotencyCommitted after withTransaction resolves.
 */
export const idempotency = ({ operation, resolveReplay } = {}) => {
  if (typeof operation !== 'string' || !operation || typeof resolveReplay !== 'function') {
    throw new TypeError('Durable idempotency requires an operation name and resource replay resolver.');
  }
  return async (req, res, next) => {
    try {
      const key = req.headers['idempotency-key'];
      assertValidIdempotencyKey(key);
      const userId = req.user?.userId;
      if (!userId) throw mutationError(503, 'Authenticated mutation identity is unavailable.', 'IDEMPOTENCY_UNAVAILABLE');
      const requestHash = mutationRequestHash(req, operation, userId);
      req.idempotencyResolveReplay = resolveReplay;
      const result = await claimMutation({ req, operation, userId, key, requestHash });
      if (result.replay) {
        res.setHeader('X-Cache-Lookup', 'HIT - Idempotent');
        return res.status(result.replay.status).json(result.replay.body);
      }

      req.idempotencyClaim = result;
      req.idempotencyCommitted = false;
      result.heartbeat = setInterval(() => { void heartbeatMutationIdempotency(result); }, MUTATION_HEARTBEAT_MS);
      result.heartbeat.unref?.();

      const originalJson = res.json.bind(res);
      res.json = body => {
        if (res.statusCode >= 200 && res.statusCode < 300 && !req.idempotencyCommitted) {
          clearInterval(result.heartbeat);
          res.statusCode = 503;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          return originalJson(errorEnvelope(req, 'Mutation did not record its durable idempotency commit.', 'IDEMPOTENCY_UNAVAILABLE'));
        }
        return originalJson(body);
      };
      res.once('finish', () => {
        clearInterval(result.heartbeat);
        if (!req.idempotencyCommitted) {
          releaseMutationIdempotency(result).catch(error => {
            console.warn('[Idempotency] Failed to release uncommitted mutation claim.', { operation, error: error.message });
          });
        }
      });
      return next();
    } catch (error) {
      if (error?.code === 'IDEMPOTENCY_PAYLOAD_CONFLICT') {
        return sendError(req, res, 409, error.clientMessage, error.code);
      }
      if (error?.code === 'INVALID_IDEMPOTENCY_KEY' || error?.code === 'IDEMPOTENCY_KEY_REQUIRED') {
        return sendError(req, res, 400, error.clientMessage, error.code);
      }
      if (error?.code === 'IDEMPOTENCY_IN_PROGRESS') return sendError(req, res, 409, error.clientMessage, error.code);
      return next(mutationError(503, 'Durable mutation idempotency is temporarily unavailable.', 'IDEMPOTENCY_UNAVAILABLE'));
    }
  };
};

const ADVISORY_OPERATION = 'recommendation.create';
const DEFAULT_WAIT_MS = 120000;

function idempotencyError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.clientMessage = message;
  error.code = code;
  return error;
}

function validateAdvisoryKey(key) {
  try {
    assertValidIdempotencyKey(key);
  } catch (error) {
    throw idempotencyError(error.status || 400, error.clientMessage, error.code || 'INVALID_IDEMPOTENCY_KEY');
  }
}

function advisoryIdentity({ operation, userId, key }) {
  return `advisory:${canonicalSha256({ operation, userId: String(userId), key })}`;
}

const PROFILE_UPDATE_OPERATION = 'profile.update_and_recommendation';

function advisoryRequestHash({ operation, method, userId, profileId, payload }) {
  return canonicalSha256({
    operation,
    method,
    userId: String(userId),
    profileId: profileId === null || profileId === undefined ? null : String(profileId),
    payload,
  });
}

function isLegacyProfileUpdateState(state, { operation, legacyRequestHash }) {
  return operation === PROFILE_UPDATE_OPERATION
    && Boolean(legacyRequestHash)
    && state?.operation === operation
    && state.method === 'POST'
    && state.requestHash === legacyRequestHash;
}

async function completedResponseFromRecommendation(recommendation) {
  if (!recommendation?.responseSnapshot) return null;
  return {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: await buildPostCommitAdvisoryResponse({
      userId: recommendation.userId,
      // The committed profile binds operation history only. The post-commit
      // resolver independently follows the user's canonical current pointer.
      profileId: recommendation.profileId,
      responseTemplate: recommendation.responseSnapshot,
      committedRecommendationId: recommendation._id,
      committedRecommendationGeneration: recommendation.recommendationGeneration,
      replayed: true,
    }),
  };
}

async function findCompletedAdvisory(operationId, requestHash, compatibility = {}) {
  const recommendation = await Recommendation.findOne({ idempotencyOperationId: operationId }).lean();
  if (!recommendation) return null;
  if (recommendation.idempotencyRequestHash !== requestHash) {
    const legacyState = recommendation.idempotencyRequestHash === compatibility.legacyRequestHash
      ? await IdempotencyKey.findById(operationId).lean()
      : null;
    if (!isLegacyProfileUpdateState(legacyState, compatibility)) {
      throw idempotencyError(
        409,
        'This Idempotency-Key was already used with a different advisory request.',
        'IDEMPOTENCY_PAYLOAD_CONFLICT',
      );
    }
  }
  const response = await completedResponseFromRecommendation(recommendation);
  if (!response) {
    throw idempotencyError(500, 'Completed advisory is missing its response snapshot.', 'IDEMPOTENCY_STATE_CORRUPT');
  }
  return response;
}

async function waitForAdvisory(operationId, requestHash, waitMs, compatibility = {}) {
  const deadline = Date.now() + waitMs;
  let committedWithoutReconciliation = false;
  while (Date.now() < deadline) {
    const completed = await findCompletedAdvisory(operationId, requestHash, compatibility);
    if (completed) return completed;

    const state = await IdempotencyKey.findById(operationId).lean();
    if (!state) return null;
    if (state.requestHash !== requestHash && !isLegacyProfileUpdateState(state, compatibility)) {
      throw idempotencyError(
        409,
        'This Idempotency-Key is already bound to a different advisory request.',
        'IDEMPOTENCY_PAYLOAD_CONFLICT',
      );
    }
    if (state.status === 'DONE') {
      committedWithoutReconciliation = true;
      const body = state.response?.body;
      const recommendationId = body?.recommendation?.recommendationId
        || body?.recommendationId
        || body?.recommendation_id;
      if (recommendationId) {
        const committed = await Recommendation.findOne({
          _id: recommendationId,
          idempotencyOperationId: operationId,
          idempotencyRequestHash: state.requestHash,
        }).lean();
        if (committed) {
          const response = await completedResponseFromRecommendation(committed);
          if (response) return response;
        }
      }
    }
    if (state.leaseExpiresAt && new Date(state.leaseExpiresAt).getTime() <= Date.now()) return null;
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  if (committedWithoutReconciliation) {
    throw idempotencyError(503, 'Committed advisory could not be reconciled to current financial state.', 'IDEMPOTENCY_STATE_CORRUPT');
  }
  throw idempotencyError(
    409,
    'The matching advisory request is still in progress. Retry with the same Idempotency-Key.',
    'IDEMPOTENCY_IN_PROGRESS',
  );
}

/**
 * Claims the existing Mongo-backed idempotency record for an advisory operation.
 * Completion is written by advisoryPersistence in the same transaction as the
 * Recommendation and AuditRecord. The Recommendation snapshot remains the
 * durable replay source after this short-lived coordination record expires.
 */
export async function claimAdvisoryIdempotency({
  key,
  userId,
  profileId,
  payload,
  operation = ADVISORY_OPERATION,
  method = 'POST',
  waitMs = DEFAULT_WAIT_MS,
}) {
  validateAdvisoryKey(key);
  const operationId = advisoryIdentity({ operation, userId, key });
  const normalizedMethod = String(method || 'POST').toUpperCase();
  const requestHash = advisoryRequestHash({ operation, method: normalizedMethod, userId, profileId, payload });
  const legacyRequestHash = operation === PROFILE_UPDATE_OPERATION && normalizedMethod === 'PUT'
    ? advisoryRequestHash({ operation, method: 'POST', userId, profileId, payload })
    : null;
  const compatibility = { operation, legacyRequestHash };

  const completed = await findCompletedAdvisory(operationId, requestHash, compatibility);
  if (completed) return { state: 'REPLAY', operationId, requestHash, response: completed };

  const ownerToken = randomUUID();
  try {
    await IdempotencyKey.create({
      _id: operationId,
      status: 'LOCK',
      operation,
      method: normalizedMethod,
      userId,
      profileId: profileId || null,
      requestHash,
      lockOwnerId: ownerToken,
      leaseExpiresAt: new Date(Date.now() + MUTATION_LEASE_MS),
    });
    return startAdvisoryHeartbeat({ state: 'CLAIMED', operationId, operation, requestHash, ownerToken, lost: false });
  } catch (error) {
    if (error.code !== 11000) throw error;
    const state = await IdempotencyKey.findById(operationId).lean();
    const legacyState = isLegacyProfileUpdateState(state, compatibility);
    if (state?.requestHash && state.requestHash !== requestHash && !legacyState) {
      throw idempotencyError(409, 'This Idempotency-Key is already bound to a different operation payload.', 'IDEMPOTENCY_PAYLOAD_CONFLICT');
    }
    const response = await waitForAdvisory(operationId, requestHash, waitMs, compatibility);
    if (response) return { state: 'REPLAY', operationId, requestHash, response };
    const reclaimedOwner = randomUUID();
    const now = new Date();
    const storedRequestHash = legacyState ? state.requestHash : requestHash;
    const reclaimed = await IdempotencyKey.findOneAndUpdate({
      _id: operationId,
      status: 'LOCK',
      requestHash: storedRequestHash,
      lockOwnerId: state?.lockOwnerId ?? null,
      leaseExpiresAt: { $lte: now },
    }, {
      // Identity fields are immutable; a matching existing lock already has the right values.
      $set: { lockOwnerId: reclaimedOwner, leaseExpiresAt: new Date(now.getTime() + MUTATION_LEASE_MS) },
    }, { new: true, runValidators: true }).lean();
    if (reclaimed) return startAdvisoryHeartbeat({ state: 'CLAIMED', operationId, operation, requestHash: storedRequestHash, ownerToken: reclaimedOwner, lost: false });
    throw idempotencyError(409, 'The matching advisory request is still in progress. Retry with the same Idempotency-Key.', 'IDEMPOTENCY_IN_PROGRESS');
  }
}

function startAdvisoryHeartbeat(claim) {
  claim.heartbeat = setInterval(async () => {
    try {
      const result = await IdempotencyKey.updateOne({
        _id: claim.operationId, status: 'LOCK', requestHash: claim.requestHash, lockOwnerId: claim.ownerToken,
      }, { $set: { leaseExpiresAt: new Date(Date.now() + MUTATION_LEASE_MS) } });
      if (result.matchedCount !== 1) claim.lost = true;
    } catch {
      claim.lost = true;
    }
  }, MUTATION_HEARTBEAT_MS);
  claim.heartbeat.unref?.();
  return claim;
}

export async function releaseAdvisoryIdempotency(claim) {
  if (!claim || claim.state !== 'CLAIMED') return;
  clearInterval(claim.heartbeat);
  await IdempotencyKey.deleteOne({
    _id: claim.operationId,
    status: 'LOCK',
    requestHash: claim.requestHash,
    lockOwnerId: claim.ownerToken,
  });
}
