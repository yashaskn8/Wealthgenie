import mongoose from 'mongoose';
import { Router } from 'express';
import { verifyJWT } from '../middleware/authMiddleware.js';
import { asyncHandler, createError, sendError } from '../middleware/errorHandler.js';
import {
  financialProfileSchema,
  financialProfileCompletionSchema,
  financialProfileUpdateSchema,
  validateStrict,
} from '../validation/financialSchemas.js';
import {
  buildRecommendationProfile,
  toProfilePersistence,
} from '../services/recommendationProfile.js';
import { assessSuitabilityRisk } from '../services/riskProfiler.js';
import FinancialProfile from '../models/FinancialProfile.js';
import { captureProfileStateForCompletion, requireCurrentFinancialProfile, resolveCurrentFinancialProfile } from '../services/currentFinancialProfile.js';
import { requireFreshRecommendationState } from '../services/recommendationState.js';
import { calculateFinancialHealthScore } from '../services/financialHealthEngine.js';
import { redisClient, redisAvailable } from '../config/redis.js';
import {
  completeMutationIdempotency,
  idempotency,
  resolveCommittedMutationForClaim,
} from '../middleware/idempotency.js';
import { persistAdvisoryAtomically } from '../services/advisoryPersistence.js';
import { getCurrentRegulatoryRuleVersion } from '../services/taxEngine.js';
import { PrometheusMetrics } from '../services/metricsCollector.js';
import { triggerPlanHealthCheck } from '../services/planHealthMonitor.js';
import {
  computeCoreRecommendation,
  readRecommendationMarketContext,
  assertCoreResultFinalSafety,
} from '../services/coreRecommendation.js';
import {
  storeProfileRecommendationCandidate,
  loadProfileRecommendationCandidate,
  validateProfileRecommendationCandidate,
  claimProfileCandidateForCommit,
  releaseProfileCandidateCommit,
  consumeProfileRecommendationCandidate,
  rebindCandidateForProfile,
} from '../services/profileCompletion.js';
import { claimAdvisoryIdempotency, releaseAdvisoryIdempotency } from '../middleware/idempotency.js';
import { createEndpointRateLimiter, ipKeyGenerator } from '../middleware/rateLimiter.js';
import { formatProfileResponse } from '../services/profileResponse.js';
import { reachFinancialStateTestHook } from '../services/financialStateTestHooks.js';
import { consumeProfileBuildQuota, PROFILE_BUILD_LIMIT } from '../services/profileRateLimit.js';

const router = Router();
const profilePrecomputeLimiter = createEndpointRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: 'Profile precomputation rate limit exceeded. Continue editing and try again shortly.',
  prefix: 'rl:profile-precompute:',
  keyGenerator: req => `user:${req.user?.userId || ipKeyGenerator(req.ip)}`,
});

function profilePersistenceDocument({ userId, profileId, canonical, suitability }) {
  return {
    _id: profileId,
    userId,
    ...toProfilePersistence(canonical, suitability),
    version: 1,
  };
}

function candidateMetricFor(reason) {
  if (reason === 'CANDIDATE_EXPIRED' || reason === 'CANDIDATE_EXPIRED_OR_MISSING') {
    PrometheusMetrics.inc('profile_complete_candidate_expired_total');
  }
  if (reason?.includes('PROFILE_MISMATCH')) {
    PrometheusMetrics.inc('profile_complete_candidate_profile_mismatch_total');
  }
  if (reason?.includes('VERSION_MISMATCH') || reason?.includes('SCHEMA_MISMATCH')) {
    PrometheusMetrics.inc('profile_complete_candidate_version_mismatch_total');
  }
}

export { formatProfileResponse };

async function resolveProfileBuildReplay(req, operation) {
  const profile = await FinancialProfile.findOne({
    _id: operation.resourceId,
    userId: req.user.userId,
    idempotencyOperationId: operation._id,
    idempotencyRequestHash: operation.requestHash,
  }).lean();
  if (!profile) {
    throw createError(503, 'Committed profile operation has no matching owned profile.', 'Refresh your profile before continuing.', {
      code: 'IDEMPOTENCY_STATE_CORRUPT',
    });
  }
  return formatProfileResponse(profile);
}

router.post(
  '/precompute',
  verifyJWT,
  profilePrecomputeLimiter,
  validateStrict(financialProfileSchema),
  asyncHandler(async (req, res) => {
    PrometheusMetrics.inc('profile_precompute_requested_total');
    try {
      const canonical = buildRecommendationProfile(req.body);
      const core = await computeCoreRecommendation({
        canonicalProfile: canonical,
        profileVersion: 1,
        userId: req.user.userId,
        correlationId: req.correlationId,
        traceId: req.traceId || req.correlationId,
        userRole: req.user.role,
      });
      const candidate = await storeProfileRecommendationCandidate({
        userId: req.user.userId,
        core,
      });
      PrometheusMetrics.inc('profile_precompute_ready_total');
      return res.status(200).json(candidate);
    } catch (error) {
      PrometheusMetrics.inc('profile_precompute_failed_total');
      throw error;
    }
  }),
);

router.post(
  '/complete',
  verifyJWT,
  validateStrict(financialProfileCompletionSchema),
  asyncHandler(async (req, res) => {
    const totalStart = performance.now();
    const validationStart = performance.now();
    const canonical = buildRecommendationProfile(req.body);
    const suitability = assessSuitabilityRisk(canonical);
    const regulatoryRuleVersion = getCurrentRegulatoryRuleVersion();
    if (!regulatoryRuleVersion) {
      throw createError(
        503,
        'No verified regulatory policy is available for the current fiscal year.',
        'Regulatory policy metadata is temporarily unavailable.',
        { code: 'REGULATORY_POLICY_UNAVAILABLE' },
      );
    }
    const validationMs = performance.now() - validationStart;

    const idempotencyStart = performance.now();
    const idempotencyClaim = await claimAdvisoryIdempotency({
      key: req.headers['idempotency-key'],
      userId: req.user.userId,
      profileId: null,
      payload: req.body,
      operation: 'profile.complete',
    });
    const idempotencyMs = performance.now() - idempotencyStart;
    if (idempotencyClaim.state === 'REPLAY') {
      res.setHeader('X-Cache-Lookup', 'HIT - Idempotent');
      // claimAdvisoryIdempotency has already reconstructed this replay from the
      // immutable recommendation linked to the operation ID. Its response may
      // describe a newer current profile, so never reinterpret the current
      // response's profileId/recommendationId as the original operation IDs.
      return res.status(idempotencyClaim.response.status).json(idempotencyClaim.response.body);
    }

    const profileStateBinding = await captureProfileStateForCompletion({ userId: req.user.userId });
    await reachFinancialStateTestHook('profile.complete.afterStateCapture', {
      userId: String(req.user.userId),
      profileStateBinding,
    });

    const profileId = new mongoose.Types.ObjectId();
    const candidateId = req.body.candidateId || null;
    let candidate = null;
    let candidateValidation = { valid: false, reason: 'CANDIDATE_NOT_PROVIDED' };
    let candidateLease = null;
    let candidateMarketContext = null;
    const candidateLookupStart = performance.now();
    const candidateValidationStart = performance.now();

    try {
      if (candidateId) {
        const loaded = await loadProfileRecommendationCandidate({
          candidateId,
          userId: req.user.userId,
        });
        candidate = loaded.candidate;
        if (loaded.reason === 'CANDIDATE_CONSUMED') {
          throw createError(409, 'This precomputed candidate has already been consumed.', 'Please precompute the profile again before completing it.', { code: loaded.reason });
        }
        if (!candidate) {
          candidateValidation.reason = loaded.reason;
          candidateMetricFor(loaded.reason);
        } else {
          candidateMarketContext = await readRecommendationMarketContext();
          candidateValidation = validateProfileRecommendationCandidate({
            candidate,
            userId: req.user.userId,
            canonicalProfile: canonical,
            regulatoryRuleVersion,
            marketContext: candidateMarketContext,
          });
          if (!candidateValidation.valid) candidateMetricFor(candidateValidation.reason);
          if (candidateValidation.valid) {
            candidateLease = await claimProfileCandidateForCommit(candidateId);
            if (!candidateLease) {
              candidateValidation = { valid: false, reason: 'CANDIDATE_CONSUME_RACE' };
            }
          }
        }
      }
      const candidateLookupMs = performance.now() - candidateLookupStart;
      let core;
      let candidateHit = candidateValidation.valid && Boolean(candidateLease);
      if (candidateHit) {
        try {
          core = rebindCandidateForProfile(candidate, {
            userId: req.user.userId,
            profileId,
            correlationId: req.correlationId,
            traceId: req.traceId || req.correlationId,
          });
          assertCoreResultFinalSafety(canonical, core);
        } catch {
          candidateHit = false;
          candidateValidation = { valid: false, reason: 'CANDIDATE_FINAL_SAFETY_FAILURE' };
          await releaseProfileCandidateCommit(candidateLease);
          candidateLease = null;
          candidateMetricFor(candidateValidation.reason);
          core = null;
        }
      }
      if (!candidateHit) {
        core = await computeCoreRecommendation({
          canonicalProfile: canonical,
          profileVersion: 1,
          userId: req.user.userId,
          profileId,
          correlationId: req.correlationId,
          traceId: req.traceId || req.correlationId,
          userRole: req.user.role,
          marketContext: candidateMarketContext,
        });
        assertCoreResultFinalSafety(canonical, core);
        PrometheusMetrics.inc('profile_complete_recomputed_total');
        PrometheusMetrics.inc('profile_complete_candidate_miss_total');
      } else {
        PrometheusMetrics.inc('profile_complete_candidate_hit_total');
        core.recommendationData.profileCompletionCandidateId = candidateId;
      }
      const candidateValidationMs = performance.now() - candidateValidationStart;
      const profileDocument = profilePersistenceDocument({
        userId: req.user.userId,
        profileId,
        canonical,
        suitability,
      });
      const response = {
        profile: formatProfileResponse(profileDocument),
        recommendation: core.response,
        completion: {
          status: 'COMMITTED',
          candidateHit,
          recomputed: !candidateHit,
          candidateReason: candidateValidation.reason,
          profileId: String(profileId),
          recommendationId: String(core.recommendationData._id),
        },
      };
      const transactionStart = performance.now();
      const persisted = await persistAdvisoryAtomically({
        profile: profileDocument,
        recommendation: core.recommendationData,
        auditRecord: core.auditRecordData,
        response,
        idempotencyClaim,
        profileStateBinding,
      });
      const transactionMs = performance.now() - transactionStart;
      if (candidateLease) await consumeProfileRecommendationCandidate(candidateLease);
      void triggerPlanHealthCheck({ userId: req.user.userId, profileId });

      const timings = core.timings || {};
      const totalMs = performance.now() - totalStart;
      res.setHeader('Server-Timing', [
        `validation;dur=${validationMs.toFixed(2)}`,
        `idempotency;dur=${idempotencyMs.toFixed(2)}`,
        `candidate-lookup;dur=${candidateLookupMs.toFixed(2)}`,
        `candidate-validation;dur=${candidateValidationMs.toFixed(2)}`,
        `ml;dur=${Number(candidateHit ? 0 : timings.ml || 0).toFixed(2)}`,
        `market-context;dur=${Number(candidateHit ? candidateLookupMs : timings.marketContext || 0).toFixed(2)}`,
        `pipeline;dur=${Number(candidateHit ? 0 : timings.pipeline || 0).toFixed(2)}`,
        `projection;dur=${Number(candidateHit ? 0 : timings.projection || 0).toFixed(2)}`,
        `transaction;dur=${transactionMs.toFixed(2)}`,
        `total;dur=${totalMs.toFixed(2)}`,
      ].join(', '));
      return res.status(200).json(persisted);
    } catch (error) {
      if (candidateLease && error?.code === 11000
          && (error.keyPattern?.profileCompletionCandidateId
            || error.keyValue?.profileCompletionCandidateId)) {
        await releaseProfileCandidateCommit(candidateLease).catch(() => {});
        candidateLease = null;
        await releaseAdvisoryIdempotency(idempotencyClaim).catch(() => {});
        throw createError(
          409,
          'This precomputed candidate has already been committed.',
          'Please precompute the profile again before completing it.',
          { code: 'PROFILE_CANDIDATE_ALREADY_COMMITTED' },
        );
      }
      if (candidateLease) await releaseProfileCandidateCommit(candidateLease).catch(() => {});
      await releaseAdvisoryIdempotency(idempotencyClaim).catch(() => {});
      throw error;
    }
  }),
);

router.get('/current', verifyJWT, asyncHandler(async (req, res) => {
  // Profile restoration is independent from recommendation availability. The
  // frontend restores the profile first and resolves its current recommendation
  // through the separately freshness-checked recommendation endpoint.
  const { profile } = await resolveCurrentFinancialProfile({
    userId: req.user.userId,
    requireRecommendation: false,
  });
  if (!profile) {
    throw createError(404, 'Financial profile not found', 'Financial profile not found.');
  }
  res.json(formatProfileResponse(profile));
}));

router.get('/:profileId/health-score', verifyJWT, asyncHandler(async (req, res) => {
  const { profile } = await requireCurrentFinancialProfile({ userId: req.user.userId, profileId: req.params.profileId });
  if (!profile) throw createError(404, 'Profile not found or access denied', 'Financial profile not found.');
  let instruments = [];
  try {
    const state = await requireFreshRecommendationState({ userId: req.user.userId, profileId: profile._id, profile });
    instruments = state.currentAllocation?.instruments || [];
  } catch (error) {
    if (error.code !== 'RECOMMENDATION_REQUIRED') {
      throw createError(error.status || 409, error.message, 'Regenerate recommendations before calculating financial health.', {
        code: error.code || 'RECOMMENDATION_STALE',
        details: { reasonCodes: error.reasonCodes, freshness: error.freshness },
      });
    }
  }
  res.json(calculateFinancialHealthScore(profile, instruments));
}));

router.post(
  '/build',
  verifyJWT,
  validateStrict(financialProfileSchema),
  idempotency({ operation: 'profile.build', resolveReplay: resolveProfileBuildReplay }),
  asyncHandler(async (req, res) => {
    const rateLimitDisabledForTests = process.env.NODE_ENV === 'test'
      && process.env.DISABLE_RATE_LIMIT !== 'false';
    const rateLimitDisabledForLocalDev = process.env.NODE_ENV !== 'production'
      && process.env.DISABLE_RATE_LIMIT === 'true';
    if (!rateLimitDisabledForTests && !rateLimitDisabledForLocalDev
        && !(await consumeProfileBuildQuota(req.user.userId, { client: redisClient, available: redisAvailable }))) {
      throw createError(
        429,
        'Profile creation rate limit exceeded',
        `Maximum ${PROFILE_BUILD_LIMIT} profile submissions per hour.`,
        { code: 'PROFILE_RATE_LIMIT_EXCEEDED' },
      );
    }

    await reachFinancialStateTestHook('profile.build.afterIdempotencyClaimBeforeTransaction', {
      userId: String(req.user.userId),
      operationId: req.idempotencyClaim.operationId,
    });
    const canonical = buildRecommendationProfile(req.body);
    const suitability = assessSuitabilityRisk(canonical);
    const profileId = new mongoose.Types.ObjectId();
    const session = await mongoose.startSession();
    let profile;
    let transactionCommitted = false;
    let committedReplay = null;
    try {
      await session.withTransaction(async () => {
        [profile] = await FinancialProfile.create([{
          _id: profileId,
          userId: req.user.userId,
          idempotencyOperationId: req.idempotencyClaim.operationId,
          idempotencyRequestHash: req.idempotencyClaim.requestHash,
          ...toProfilePersistence(canonical, suitability),
        }], { session });
        await reachFinancialStateTestHook('profile.build.afterInsertBeforeCommit', {
          userId: String(req.user.userId), profileId: String(profile._id), session,
          idempotencyClaim: req.idempotencyClaim,
          transactionActive: session.inTransaction(),
        });
        await completeMutationIdempotency(session, req.idempotencyClaim, {
          resourceType: 'FinancialProfile', resourceId: profileId, status: 201,
        });
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      transactionCommitted = true;
      req.idempotencyCommitted = true;
      clearInterval(req.idempotencyClaim.heartbeat);
    } catch (error) {
      committedReplay = await resolveCommittedMutationForClaim(req, req.idempotencyClaim);
      if (!committedReplay) throw error;
    } finally {
      try {
        await session.endSession();
      } catch (error) {
        if (!transactionCommitted) throw error;
        console.warn('[Profile] Session cleanup failed after committed create.', { error: error.message });
      }
    }

    if (committedReplay) {
      req.idempotencyCommitted = true;
      clearInterval(req.idempotencyClaim.heartbeat);
      res.setHeader('X-Cache-Lookup', 'HIT - Idempotent');
      return res.status(committedReplay.status).json(committedReplay.body);
    }

    await reachFinancialStateTestHook('profile.build.afterCommitBeforeResponse', {
      userId: String(req.user.userId),
      profileId: String(profile._id),
      operationId: req.idempotencyClaim.operationId,
    });
    res.status(201).json(formatProfileResponse(profile));
  }),
);

router.put(
  '/:profileId',
  verifyJWT,
  validateStrict(financialProfileUpdateSchema),
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.profileId)) {
      throw createError(400, 'Invalid profile ID format.', 'Invalid financial profile ID.', {
        code: 'PROFILE_ID_INVALID',
      });
    }
    const ownedTarget = await FinancialProfile.exists({
      _id: req.params.profileId,
      userId: req.user.userId,
    });
    if (!ownedTarget) {
      throw createError(404, 'Profile not found or access denied.', 'Financial profile not found.', {
        code: 'PROFILE_NOT_FOUND',
      });
    }

    const idempotencyClaim = await claimAdvisoryIdempotency({
      key: req.headers['idempotency-key'],
      userId: req.user.userId,
      profileId: req.params.profileId,
      payload: req.body,
      operation: 'profile.update_and_recommendation',
      method: 'PUT',
    });
    if (idempotencyClaim.state === 'REPLAY') {
      res.setHeader('X-Cache-Lookup', 'HIT - Idempotent');
      // The durable replay resolver is bound to the original idempotency
      // operation. Its financial body is already canonical; rebuilding from
      // that body would confuse current IDs with the committed operation IDs.
      return res.status(idempotencyClaim.response.status).json(idempotencyClaim.response.body);
    }

    try {
      const currentProfileState = await resolveCurrentFinancialProfile({ userId: req.user.userId });
      const existing = currentProfileState.profile;
      if (existing && String(existing._id) !== String(req.params.profileId)) {
        throw createError(409, 'The requested profile is no longer current.', 'Refresh the current financial profile before updating it.', {
          code: 'PROFILE_STATE_VERSION_CONFLICT',
          details: { currentProfileId: String(existing._id), profileStateRevision: currentProfileState.state.revision },
        });
      }
      if (!existing) throw createError(404, 'Profile not found or access denied', 'Profile not found.');
      const profileStateBinding = {
        revision: Number(currentProfileState.state.revision),
        currentProfileId: String(existing._id),
      };

      const expectedVersion = req.body.version;
      const currentVersion = existing.version ?? 1;
      if (currentVersion !== expectedVersion) {
        await releaseAdvisoryIdempotency(idempotencyClaim);
        return sendError(req, res, 409, 'Version conflict', 'PROFILE_VERSION_CONFLICT', {
          currentVersion,
          expectedVersion,
        });
      }

      const canonical = buildRecommendationProfile(req.body);
      const suitability = assessSuitabilityRisk(canonical);
      const nextVersion = currentVersion + 1;
      await reachFinancialStateTestHook('profile.update.beforeRecommendationCompute', {
        userId: String(req.user.userId), profileId: String(existing._id), expectedVersion: currentVersion, nextVersion,
      });
      const core = await computeCoreRecommendation({
        canonicalProfile: canonical,
        profileVersion: nextVersion,
        userId: req.user.userId,
        profileId: existing._id,
        correlationId: req.correlationId,
        traceId: req.traceId || req.correlationId,
        userRole: req.user.role,
      });
      await reachFinancialStateTestHook('profile.update.afterRecommendationCompute', {
        userId: String(req.user.userId), profileId: String(existing._id), expectedVersion: currentVersion, nextVersion,
      });
      const persisted = await persistAdvisoryAtomically({
        recommendation: core.recommendationData,
        auditRecord: core.auditRecordData,
        response: { ...core.response, response_kind: 'PROFILE_UPDATE' },
        idempotencyClaim,
        profileStateBinding,
        profileUpdate: {
          expectedVersion: currentVersion,
          expectedFinancialStateFence: Number(existing.financialStateFence ?? 0),
          fields: toProfilePersistence(canonical, suitability),
        },
        testHooks: {
          afterSourceProfileRead: session => reachFinancialStateTestHook('profile.update.afterSourceProfileRead', {
            session, profileId: String(existing._id), expectedVersion: currentVersion, nextVersion,
          }),
          afterProfileUpdateWrite: session => reachFinancialStateTestHook('profile.update.afterProfileWriteBeforeRecommendation', {
            session, profileId: String(existing._id), nextVersion,
          }),
          afterAuditCreate: session => reachFinancialStateTestHook('profile.update.afterAuditWriteBeforeCommit', {
            session, profileId: String(existing._id), nextVersion,
          }),
          afterProfileUpdateRecommendationCreate: session => reachFinancialStateTestHook('profile.update.afterRecommendationCreate', {
            session, profileId: String(existing._id), nextVersion,
          }),
          afterCommitBeforeReconcile: context => reachFinancialStateTestHook('profile.update.afterCommitBeforeResponse', {
            ...context, profileId: String(existing._id), userId: String(req.user.userId),
          }),
        },
      });

      void triggerPlanHealthCheck({ userId: req.user.userId, profileId: existing._id });
      return res.status(200).json(persisted);
    } catch (error) {
      await releaseAdvisoryIdempotency(idempotencyClaim).catch(releaseError => {
        console.error('[Profile] Failed to release profile-update idempotency claim:', releaseError.message);
      });
      throw error;
    }
  }),
);

export default router;
