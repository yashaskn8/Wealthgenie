import crypto from 'node:crypto';
import mongoose from 'mongoose';
import GenieProofCase from '../../models/GenieProofCase.js';
import ProofWatch from '../../models/ProofWatch.js';
import ProofBreakJob from '../../models/ProofBreakJob.js';
import ProofBreakEvent from '../../models/ProofBreakEvent.js';
import ProofNotificationOutbox from '../../models/ProofNotificationOutbox.js';
import ProofBreakWorkerHeartbeat from '../../models/ProofBreakWorkerHeartbeat.js';
import GenieProofSourceDefinition from '../../models/GenieProofSourceDefinition.js';
import { canonicalSha256 } from '../../utils/canonicalJson.js';
import { validateGenieProofSourceDefinition } from './genieProofEvidenceRegistryService.js';

export const PROOF_WATCH_CONSENT_VERSION = 'genieproof-proofbreak-watch/1';
export const PROOFBREAK_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SUPPORTED_PRODUCT_CLAIM = Object.freeze({ 'government:india-post:ppf': 'CURRENT_NOMINAL_RATE' });

function serviceError(status, code, message) {
  return Object.assign(new Error(message), { status, code, clientMessage: message });
}

function activeCaseFilter(userId, caseId, now) {
  return {
    userId,
    caseId,
    deletedAt: null,
    $or: [{ expiresAt: { $gt: now } }, { expiresAt: { $exists: false } }],
  };
}

function asPlain(row) {
  return row?.toObject ? row.toObject() : row;
}

function toPublicWatch(row, currentTime = new Date()) {
  const expired = row.expiresAt && new Date(row.expiresAt) <= currentTime
    && !['CANCELLED', 'EXPIRED'].includes(row.status);
  return {
    watchId: row.watchId,
    caseId: row.caseId,
    status: expired ? 'EXPIRED' : row.status,
    consentVersion: row.consentVersion,
    consentAt: row.consentAt,
    consentWithdrawnAt: row.consentWithdrawnAt,
    generation: row.generation,
    requestedClaimIds: row.requestedClaimIds,
    sourceAvailability: row.sourceAvailability,
    monitoredSourceIds: row.monitoredSourceIds,
    lastSuccessfulCheckAt: row.lastSuccessfulCheckAt,
    nextCheckAt: row.nextCheckAt,
    lastFailureCode: row.lastFailureCode,
    expiresAt: row.expiresAt,
  };
}

async function getSourceAvailability({ claims, sourceModel, session = null }) {
  const supported = (claims || []).filter(claim => SUPPORTED_PRODUCT_CLAIM[claim.productId] === claim.claimType);
  if (!supported.length) throw serviceError(422, 'GENIEPROOF_NO_MONITORABLE_CLAIMS', 'This passport has no claim type that ProofBreak can monitor.');
  // Read latest definitions before filtering claim scope so a narrowed newer
  // revision cannot leave an older approval usable for monitoring.
  const query = sourceModel.find({}).sort({ sourceId: 1, revision: -1 });
  if (session && typeof query.session === 'function') query.session(session);
  const rows = await query.lean();
  const latest = new Map();
  for (const row of rows) if (!latest.has(row.sourceId)) latest.set(row.sourceId, row);
  const matching = [...latest.values()].filter(source => supported.some(claim => (
    Array.isArray(source.productIds) && Array.isArray(source.claimTypes)
      && source.productIds.includes(claim.productId) && source.claimTypes.includes(claim.claimType)
  )));
  const isFetchQualified = source => {
    try {
      validateGenieProofSourceDefinition(source);
      return true;
    } catch {
      return false;
    }
  };
  const permitted = matching.filter(isFetchQualified);
  if (permitted.length) {
    return { status: 'AVAILABLE', sourceIds: permitted.map(source => source.sourceId).sort(), claimIds: supported.map(claim => claim.claimId) };
  }
  const revokedSource = matching.some(source => source.revocationReasonCode
    || source.qualificationStatus === 'REVOKED' || source.reusePermissionStatus === 'REVOKED');
  if (revokedSource || matching.some(source => ['BLOCKED_REUSE_RIGHTS', 'REVOKED'].includes(source.qualificationStatus)
    || ['BLOCKED', 'REVOKED'].includes(source.reusePermissionStatus))) {
    return {
      status: 'RIGHTS_BLOCKED',
      ...(revokedSource ? { reasonCode: 'GENIEPROOF_SOURCE_REVOKED' } : {}),
      sourceIds: [],
      claimIds: supported.map(claim => claim.claimId),
    };
  }
  if (matching.some(source => source.qualificationStatus === 'BLOCKED_TECHNICAL')) {
    return { status: 'TECHNICALLY_BLOCKED', sourceIds: [], claimIds: supported.map(claim => claim.claimId) };
  }
  if (matching.some(source => source.qualificationStatus === 'QUALIFIED_FOR_USER_PRESENTATION'
      && source.reusePermissionStatus === 'APPROVED' && !isFetchQualified(source))) {
    return { status: 'TECHNICALLY_BLOCKED', sourceIds: [], claimIds: supported.map(claim => claim.claimId) };
  }
  return { status: 'WAITING', sourceIds: [], claimIds: supported.map(claim => claim.claimId) };
}

function watchStateForAvailability(availability) {
  if (availability.status === 'AVAILABLE') return 'ACTIVE';
  if (availability.status === 'RIGHTS_BLOCKED') return 'BLOCKED_SOURCE_RIGHTS';
  if (availability.status === 'TECHNICALLY_BLOCKED') return 'FAILED_TERMINAL';
  return 'WAITING_FOR_SOURCE';
}

async function createCheckJob({ watch, jobModel, now, session }) {
  const scheduleKey = `initial:${watch.generation}:${new Date(watch.nextCheckAt || now).toISOString()}`;
  await jobModel.create([{
    jobId: crypto.randomUUID(),
    watchId: watch.watchId,
    userId: watch.userId,
    caseId: watch.caseId,
    scheduleKey,
    watchGeneration: watch.generation,
    status: 'QUEUED',
    scheduledAt: now,
    attempt: 0,
    maxAttempts: 4,
    executionGeneration: 0,
    expiresAt: watch.expiresAt,
  }], { session });
}

async function ownedCase({ userId, caseId, caseModel, now, session }) {
  const query = caseModel.findOne(activeCaseFilter(userId, caseId, now));
  if (session && typeof query.session === 'function') query.session(session);
  const row = await query.lean();
  if (!row) throw serviceError(404, 'GENIEPROOF_CASE_NOT_FOUND', 'The saved passport was not found.');
  if (row.consentWithdrawnAt) throw serviceError(403, 'GENIEPROOF_CONSENT_WITHDRAWN', 'ProofBreak is unavailable because private processing consent was withdrawn.');
  return row;
}

export async function createProofWatch({
  userId,
  caseId,
  watchConsent,
  idempotencyKey,
  caseModel = GenieProofCase,
  watchModel = ProofWatch,
  jobModel = ProofBreakJob,
  sourceModel = GenieProofSourceDefinition,
  workerHeartbeatModel = ProofBreakWorkerHeartbeat,
  startSession = () => mongoose.startSession(),
  now = () => new Date(),
}) {
  if (watchConsent !== true) throw serviceError(400, 'PROOFBREAK_CONSENT_REQUIRED', 'Confirm that you want ProofBreak to recheck the supported claims in this private passport.');
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    throw serviceError(400, 'GENIEPROOF_IDEMPOTENCY_KEY_REQUIRED', 'A valid request key is required.');
  }
  const createdAt = now();
  const creationKeyHash = canonicalSha256([String(userId), 'proof-watch', idempotencyKey]);
  const requestHash = canonicalSha256({ caseId, watchConsent: true, consentVersion: PROOF_WATCH_CONSENT_VERSION });
  const session = await startSession();
  try {
    session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
    const replayQuery = watchModel.findOne({ userId, creationKeyHash });
    if (typeof replayQuery.session === 'function') replayQuery.session(session);
    const replay = await replayQuery.lean();
    if (replay) {
      if (replay.requestHash !== requestHash) throw serviceError(409, 'GENIEPROOF_IDEMPOTENCY_CONFLICT', 'This request key was already used for a different watch.');
      await session.commitTransaction();
      return { created: false, watch: toPublicWatch(replay, createdAt) };
    }
    const row = await ownedCase({ userId, caseId, caseModel, now: createdAt, session });
    const availability = await getSourceAvailability({ claims: row.confirmedClaims || [], sourceModel, session });
    if (availability.status === 'AVAILABLE') {
      const workerQuery = workerHeartbeatModel.findOne({
        status: 'RUNNING',
        heartbeatAt: { $gt: new Date(createdAt.getTime() - 30_000) },
        lastSuccessfulPollAt: { $ne: null },
        lastPollErrorCode: null,
      });
      if (typeof workerQuery.session === 'function') workerQuery.session(session);
      if (!(await workerQuery.select('workerId').lean())) {
        throw serviceError(503, 'PROOFBREAK_WORKER_UNAVAILABLE', 'The monitoring worker is unavailable. No watch was created.');
      }
    }
    // Serialize watch creation against consent withdrawal and case deletion.
    // Both operations write/delete this same case row, so MongoDB surfaces a
    // transaction conflict instead of allowing a watch to commit behind them.
    const consentFence = await caseModel.updateOne({
      ...activeCaseFilter(userId, caseId, createdAt),
      consentWithdrawnAt: null,
    }, { $inc: { consentGeneration: 1 } }, { session });
    if (Number(consentFence?.modifiedCount ?? consentFence?.nModified ?? 0) !== 1) {
      throw serviceError(409, 'GENIEPROOF_CASE_CHANGED', 'The saved passport changed while ProofBreak was being enabled. Refresh and try again.');
    }
    const watch = {
      watchId: crypto.randomUUID(),
      userId,
      caseId,
      creationKeyHash,
      requestHash,
      status: watchStateForAvailability(availability),
      consentVersion: PROOF_WATCH_CONSENT_VERSION,
      consentAt: createdAt,
      consentWithdrawnAt: null,
      generation: 1,
      requestedClaimIds: availability.claimIds,
      sourceAvailability: availability.status,
      monitoredSourceIds: availability.sourceIds,
      lastSuccessfulCheckAt: null,
      nextCheckAt: availability.status === 'AVAILABLE' ? new Date(createdAt.getTime() + PROOFBREAK_CHECK_INTERVAL_MS) : null,
      lastFailureCode: availability.status === 'RIGHTS_BLOCKED'
        ? availability.reasonCode || 'SOURCE_REUSE_NOT_APPROVED'
        : null,
      expiresAt: row.expiresAt || new Date(createdAt.getTime() + 90 * 24 * 60 * 60 * 1000),
    };
    const [saved] = await watchModel.create([watch], { session });
    if (watch.status === 'ACTIVE') await createCheckJob({ watch, jobModel, now: createdAt, session });
    await session.commitTransaction();
    return { created: true, watch: toPublicWatch(asPlain(saved), createdAt) };
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(() => {});
    if (error?.code === 11000) {
      const replay = await watchModel.findOne({ userId, creationKeyHash }).lean();
      if (replay) {
        if (replay.requestHash !== requestHash) throw serviceError(409, 'GENIEPROOF_IDEMPOTENCY_CONFLICT', 'This request key was already used for a different watch.');
        return { created: false, watch: toPublicWatch(replay, createdAt) };
      }
      const existing = await watchModel.findOne({ userId, caseId, status: { $nin: ['CANCELLED', 'EXPIRED'] } }).lean();
      if (existing) throw serviceError(409, 'PROOFBREAK_WATCH_ALREADY_EXISTS', 'ProofBreak already has a watch for this passport.');
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

export async function listProofWatches({ userId, caseId = null, limit = 25, watchModel = ProofWatch, now = () => new Date() }) {
  const filter = { userId, ...(caseId ? { caseId } : {}) };
  const safeLimit = Math.max(1, Math.min(50, Number.isInteger(limit) ? limit : 25));
  const rows = await watchModel.find(filter).sort({ createdAt: -1, _id: -1 }).limit(safeLimit).lean();
  const currentTime = now();
  return rows.map(row => toPublicWatch(row, currentTime));
}

export async function updateProofWatchStatus({
  userId,
  watchId,
  action,
  caseModel = GenieProofCase,
  watchModel = ProofWatch,
  jobModel = ProofBreakJob,
  sourceModel = GenieProofSourceDefinition,
  workerHeartbeatModel = ProofBreakWorkerHeartbeat,
  eventModel = ProofBreakEvent,
  outboxModel = ProofNotificationOutbox,
  startSession = () => mongoose.startSession(),
  now = () => new Date(),
}) {
  const currentTime = now();
  if (action === 'pause' || action === 'disable') {
    const status = action === 'pause' ? 'PAUSED' : 'CANCELLED';
    const session = await startSession();
    try {
      session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
      const currentQuery = watchModel.findOne({ userId, watchId });
      if (typeof currentQuery.session === 'function') currentQuery.session(session);
      const current = await currentQuery.lean();
      if (!current) {
        await session.abortTransaction();
        return null;
      }
      const updatedQuery = watchModel.findOneAndUpdate({ userId, watchId, generation: current.generation }, {
        $set: {
          status,
          nextCheckAt: null,
          ...(action === 'disable' ? { consentWithdrawnAt: currentTime } : {}),
        },
        $inc: { generation: 1 },
      }, { new: true, session });
      const updated = await updatedQuery.lean();
      if (!updated) throw serviceError(409, 'PROOFBREAK_WATCH_CHANGED', 'The watch changed. Refresh its status and retry.');
      await jobModel.updateMany({ userId, watchId, status: { $in: ['QUEUED', 'LEASED'] } }, {
        $set: { status: 'CANCELLED', leaseOwner: null, leaseUntil: null, failureCode: action === 'disable' ? 'WATCH_DISABLED' : 'WATCH_PAUSED' },
        $inc: { executionGeneration: 1 },
      }, { session });
      if (action === 'disable') {
        await outboxModel.updateMany({
          userId,
          watchId,
          status: { $in: ['PENDING', 'LEASED', 'FAILED_RETRYABLE'] },
        }, {
          $set: { status: 'CANCELLED', leaseOwner: null, leaseUntil: null, failureCode: 'WATCH_DISABLED' },
          $inc: { executionGeneration: 1 },
        }, { session });
        await eventModel.updateMany({ userId, watchId, notificationStatus: 'PENDING' }, {
          $set: { notificationStatus: 'CANCELLED' },
        }, { session });
      }
      await session.commitTransaction();
      return toPublicWatch(updated, currentTime);
    } catch (error) {
      if (session.inTransaction()) await session.abortTransaction().catch(() => {});
      throw error;
    } finally {
      await session.endSession();
    }
  }
  const current = await watchModel.findOne({ userId, watchId }).lean();
  if (!current) return null;
  if (action !== 'resume') throw serviceError(400, 'PROOFBREAK_ACTION_INVALID', 'Choose pause, resume, or disable.');
  if (current.status === 'CANCELLED') throw serviceError(409, 'PROOFBREAK_WATCH_CANCELLED', 'A disabled watch cannot be resumed. Create a new watch with fresh consent.');
  const session = await startSession();
  try {
    session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
    const currentQuery = watchModel.findOne({ userId, watchId });
    if (typeof currentQuery.session === 'function') currentQuery.session(session);
    const transactionalCurrent = await currentQuery.lean();
    if (!transactionalCurrent) {
      await session.abortTransaction();
      return null;
    }
    if (transactionalCurrent.status === 'CANCELLED') {
      throw serviceError(409, 'PROOFBREAK_WATCH_CANCELLED', 'A disabled watch cannot be resumed. Create a new watch with fresh consent.');
    }

    const row = await ownedCase({ userId, caseId: transactionalCurrent.caseId, caseModel, now: currentTime, session });
    const availability = await getSourceAvailability({ claims: row.confirmedClaims || [], sourceModel, session });
    if (availability.status === 'AVAILABLE') {
      const workerReady = await workerHeartbeatModel.exists({
        status: 'RUNNING',
        heartbeatAt: { $gt: new Date(currentTime.getTime() - 30_000) },
        lastSuccessfulPollAt: { $ne: null },
        lastPollErrorCode: null,
      });
      if (!workerReady) throw serviceError(503, 'PROOFBREAK_WORKER_UNAVAILABLE', 'The monitoring worker is unavailable. The watch was not resumed.');
    }
    const nextGeneration = Number(transactionalCurrent.generation || 0) + 1;
    const state = watchStateForAvailability(availability);
    const updatedQuery = watchModel.findOneAndUpdate({
      userId,
      watchId,
      generation: transactionalCurrent.generation,
    }, {
      $set: {
        status: state,
        sourceAvailability: availability.status,
        monitoredSourceIds: availability.sourceIds,
        nextCheckAt: state === 'ACTIVE' ? currentTime : null,
        lastFailureCode: availability.status === 'RIGHTS_BLOCKED'
          ? availability.reasonCode || 'SOURCE_REUSE_NOT_APPROVED'
          : null,
      },
      $inc: { generation: 1 },
    }, { new: true, session });
    const updated = await updatedQuery.lean();
    if (!updated) throw serviceError(409, 'PROOFBREAK_WATCH_CHANGED', 'The watch changed. Refresh its status and retry.');
    if (state === 'ACTIVE') {
      await createCheckJob({ watch: { ...updated, generation: nextGeneration }, jobModel, now: currentTime, session });
    }
    await session.commitTransaction();
    return toPublicWatch(updated, currentTime);
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(() => {});
    throw error;
  } finally {
    await session.endSession();
  }
}

export async function getProofWatchAvailability({
  userId,
  caseId,
  caseModel = GenieProofCase,
  sourceModel = GenieProofSourceDefinition,
  workerHeartbeatModel = ProofBreakWorkerHeartbeat,
  now = () => new Date(),
}) {
  const currentTime = now();
  const row = await ownedCase({ userId, caseId, caseModel, now: currentTime });
  const supportedClaims = (row.confirmedClaims || []).filter(claim => SUPPORTED_PRODUCT_CLAIM[claim.productId] === claim.claimType);
  let availability = { status: 'WAITING', sourceIds: [], claimIds: [] };
  if (supportedClaims.length) availability = await getSourceAvailability({ claims: supportedClaims, sourceModel });
  const workerReady = Boolean(await workerHeartbeatModel.exists({
    status: 'RUNNING',
    heartbeatAt: { $gt: new Date(currentTime.getTime() - 30_000) },
    lastSuccessfulPollAt: { $ne: null },
    lastPollErrorCode: null,
  }));
  const claims = (row.confirmedClaims || []).map(claim => {
    const inScope = SUPPORTED_PRODUCT_CLAIM[claim.productId] === claim.claimType;
    const status = !inScope
      ? 'NOT_SUPPORTED'
      : availability.status === 'AVAILABLE'
        ? 'AVAILABLE'
        : availability.status === 'RIGHTS_BLOCKED'
          ? 'SOURCE_RIGHTS_BLOCKED'
          : availability.status === 'TECHNICALLY_BLOCKED'
            ? 'SOURCE_TECHNICALLY_BLOCKED'
            : 'WAITING_FOR_QUALIFIED_SOURCE';
    return { claimId: claim.claimId, claimType: claim.claimType, productId: claim.productId, status };
  });
  return {
    caseId,
    workerStatus: workerReady ? 'AVAILABLE' : 'UNAVAILABLE',
    canEnable: availability.status === 'AVAILABLE' && workerReady,
    claims,
    monitoringScope: 'Only exact current nominal PPF annual-rate claims are currently supported.',
    sourceStatus: availability.status,
    sourceReasonCode: availability.reasonCode || null,
  };
}

export async function deleteProofWatch({
  userId,
  watchId,
  watchModel = ProofWatch,
  jobModel = ProofBreakJob,
  eventModel = ProofBreakEvent,
  outboxModel = ProofNotificationOutbox,
  startSession = () => mongoose.startSession(),
}) {
  const session = await startSession();
  try {
    session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
    const deleted = await watchModel.findOneAndDelete({ userId, watchId }, { session });
    if (!deleted) {
      await session.abortTransaction();
      return false;
    }
    await jobModel.deleteMany({ userId, watchId }, { session });
    await eventModel.deleteMany({ userId, watchId }, { session });
    await outboxModel.deleteMany({ userId, watchId }, { session });
    await session.commitTransaction();
    return true;
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(() => {});
    throw error;
  } finally {
    await session.endSession();
  }
}

export function encodeProofBreakCursor(row) {
  if (!row) return null;
  return Buffer.from(JSON.stringify({ at: new Date(row.publishedAt).toISOString(), id: String(row._id) })).toString('base64url');
}

function decodeProofBreakCursor(cursor) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed.at !== 'string' || !Number.isFinite(Date.parse(parsed.at))
        || !/^[a-f0-9]{24}$/i.test(parsed.id || '')) return null;
    return { publishedAt: new Date(parsed.at), _id: new mongoose.Types.ObjectId(parsed.id) };
  } catch { return null; }
}

export async function listProofBreakEvents({ userId, caseId, limit = 25, cursor = null, eventModel = ProofBreakEvent }) {
  const safeLimit = Math.max(1, Math.min(50, Number.isInteger(limit) ? limit : 25));
  const decoded = decodeProofBreakCursor(cursor);
  if (cursor && !decoded) throw serviceError(400, 'PROOFBREAK_CURSOR_INVALID', 'The timeline cursor is invalid.');
  const filter = {
    userId,
    caseId,
    ...(decoded ? { $or: [
      { publishedAt: { $lt: decoded.publishedAt } },
      { publishedAt: decoded.publishedAt, _id: { $lt: decoded._id } },
    ] } : {}),
  };
  const rows = await eventModel.find(filter).sort({ publishedAt: -1, _id: -1 }).limit(safeLimit + 1).lean();
  const hasMore = rows.length > safeLimit;
  const events = rows.slice(0, safeLimit).map(row => ({
    eventId: row.eventId,
    caseId: row.caseId,
    watchId: row.watchId,
    claimId: row.claimId,
    previousAssessmentId: row.previousAssessmentId,
    newAssessmentId: row.newAssessmentId,
    previousEvidenceRevision: row.previousEvidenceRevision,
    newEvidenceRevision: row.newEvidenceRevision,
    retrievalReceiptIds: row.retrievalReceiptIds || [],
    changedFactFields: row.changedFactFields,
    effectivePeriodImplications: row.effectivePeriodImplications,
    eventType: row.eventType,
    detectedAt: row.detectedAt,
    publishedAt: row.publishedAt,
    notificationStatus: row.notificationStatus,
    acknowledgedAt: row.acknowledgedAt,
  }));
  return { events, nextCursor: hasMore ? encodeProofBreakCursor(rows[safeLimit - 1]) : null };
}

export async function acknowledgeProofBreakEvent({ userId, eventId, eventModel = ProofBreakEvent, now = () => new Date() }) {
  const updated = await eventModel.findOneAndUpdate({ userId, eventId, acknowledgedAt: null }, {
    $set: { acknowledgedAt: now() },
  }, { new: true }).lean();
  if (updated) return true;
  return Boolean(await eventModel.exists({ userId, eventId }));
}
