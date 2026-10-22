import { Router } from 'express';
import crypto from 'node:crypto';
import { verifyJWT, isValidObjectId } from '../middleware/authMiddleware.js';
import { asyncHandler, createError, sendError } from '../middleware/errorHandler.js';
import {
  recommendationAuditQuerySchema,
  recommendationCurrentQuerySchema,
  validateQuery,
} from '../validation/schemas.js';
import {
  recommendationRequestSchema,
  recommendationWeightsSchema,
  validateStrict,
} from '../validation/financialSchemas.js';
import FinancialProfile from '../models/FinancialProfile.js';
import { requireCurrentFinancialProfile, resolveCurrentFinancialProfile } from '../services/currentFinancialProfile.js';
import Recommendation from '../models/Recommendation.js';
import RecommendationState from '../models/RecommendationState.js';
import AuditRecord from '../models/AuditRecord.js';
import logger from '../utils/logger.js';
import { generateAdvisory } from '../services/geminiService.js';
import {
  assertPortfolioSuitable,
  resolveConcentrationCap,
} from '../services/RecommendationPipeline.js';
import {
  buildRecommendationProfile,
  buildLlmFinancialContext,
  RECOMMENDATION_POLICY_VERSION,
} from '../services/recommendationProfile.js';
import { assessSuitabilityRisk } from '../services/riskProfiler.js';
import { claimAdvisoryIdempotency, releaseAdvisoryIdempotency } from '../middleware/idempotency.js';
import { persistAdvisoryAtomically } from '../services/advisoryPersistence.js';
import { resolveStablePostCommitCurrentState } from '../services/advisoryResponse.js';
import { setCache, delCache } from '../config/redis.js';
import { verifyAuditChain } from '../services/auditChain.js';
import { assertRecommendationMarketDistributionAllowed } from '../services/recommendationMarketProvenance.js';
import { triggerPlanHealthCheck } from '../services/planHealthMonitor.js';
import { requireFreshRecommendationState, createManualAllocationRevision } from '../services/recommendationState.js';
import { buildCurrentRecommendationResponse } from '../services/recommendationResponse.js';
import { assessAdvisoryStateBinding } from '../services/advisoryBinding.js';
import { reachFinancialStateTestHook } from '../services/financialStateTestHooks.js';
import {
  computeCoreRecommendation,
  buildRecommendationCacheKey,
} from '../services/coreRecommendation.js';

export { buildRecommendationCacheKey, canonicalAuditInputs } from '../services/coreRecommendation.js';

const router = Router();
// The grounded provider chain has a bounded deadline. Give the database and
// response path additional time before another request may reclaim a worker
// claim abandoned by process loss. Claim-token fencing prevents the old worker
// from persisting if it later resumes.
const ADVISORY_STALE_CLAIM_MS = 2 * 60 * 1000;

export function recommendationPayloadFromSnapshot(snapshot) {
  if (snapshot?.recommendation && snapshot?.completion) return snapshot.recommendation;
  return snapshot;
}

function advisoryExplanationFromMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Object.keys(metadata).length === 0) return null;
  return {
    status: metadata.status,
    provider: metadata.provider,
    model: metadata.model,
    prompt_version: metadata.promptVersion ?? metadata.prompt_version,
    grounding_version: metadata.groundingVersion ?? metadata.grounding_version,
    evidence_ids_used: metadata.evidenceIdsUsed ?? metadata.evidence_ids_used ?? [],
    unavailable_facts: metadata.unavailableFacts ?? metadata.unavailable_facts ?? [],
    citations: metadata.citations ?? [],
    validation_status: metadata.validation?.status ?? metadata.validation_status,
    generated_at: metadata.generatedAt ?? metadata.generated_at,
  };
}

function buildAdvisoryResponse({ recommendationId, state, advisoryText, advisoryExplanation }) {
  const allocationRevision = state?.allocationRevision?.revision;
  const allocationRevisionId = state?.allocationRevision?._id;
  const portfolioFingerprint = state?.portfolioFingerprint;
  if (!Number.isSafeInteger(Number(allocationRevision))
      || Number(allocationRevision) < 1
      || !allocationRevisionId
      || typeof portfolioFingerprint !== 'string'
      || portfolioFingerprint.length === 0) {
    throw createError(503, 'The advisory source-state binding is unavailable.', 'Refresh the current recommendation before loading its advisory.', {
      code: 'ADVISORY_PROVENANCE_MISSING',
    });
  }

  const binding = {
    recommendationId: String(recommendationId),
    profileId: String(state.profile?._id || state.recommendation?.profileId || ''),
    profile_version: Number(state.profileVersion),
    profile_input_hash: state.recommendation?.profileInputHash || null,
    recommendation_fingerprint: state.recommendationFingerprint || null,
    recommendation_policy_version: state.recommendation?.recommendationPolicyVersion || null,
    regulatory_rule_version: state.recommendation?.regulatoryRuleVersion || null,
    return_assumption_hash: state.allocationRevision?.returnAssumptionHash || null,
    allocation_revision: Number(allocationRevision),
    allocation_revision_id: String(allocationRevisionId),
    portfolio_fingerprint: portfolioFingerprint,
  };
  return {
    ...binding,
    advisory_text: advisoryText ?? null,
    advisory_explanation: {
      ...(advisoryExplanation || {}),
      ...binding,
    },
  };
}

export async function persistAdvisoryIfCurrent({ recommendationId, userId, state, claimToken, advisoryText, advisoryMetadata }) {
  await reachFinancialStateTestHook('recommendation.advisory.beforePersistence', { recommendationId, userId, state });
  const session = await Recommendation.startSession();
  try {
    await session.withTransaction(async () => {
      const profileCas = await FinancialProfile.updateOne({
        _id: state.recommendation.profileId,
        userId,
        version: state.profileVersion,
      }, {
        // A real write fence serializes an overlapping profile edit with this
        // provenance-bound advisory write under Mongo snapshot isolation.
        $inc: { financialStateFence: 1 },
      }, { session });
      if (profileCas.matchedCount !== 1) {
        const error = new Error('The financial profile changed while advisory text was being generated.');
        error.code = 'ADVISORY_SOURCE_STATE_CHANGED';
        error.status = 409;
        throw error;
      }
      const pointer = await RecommendationState.findOne({
        _id: state.provenance?.stateId,
        userId,
        profileId: state.recommendation.profileId,
        currentRecommendationId: recommendationId,
        currentAllocationRevision: state.allocationRevision.revision,
        currentAllocationRevisionId: state.allocationRevision._id,
        profileInputHash: state.recommendation.profileInputHash,
        portfolioFingerprint: state.portfolioFingerprint,
      }).session(session);
      if (!pointer) {
        const error = new Error('The financial state changed while advisory text was being generated.');
        error.code = 'ADVISORY_SOURCE_STATE_CHANGED';
        error.status = 409;
        throw error;
      }
      const stateCas = await RecommendationState.updateOne({
        _id: pointer._id,
        userId,
        profileId: state.recommendation.profileId,
        currentRecommendationId: recommendationId,
        currentAllocationRevision: state.allocationRevision.revision,
        currentAllocationRevisionId: state.allocationRevision._id,
        profileInputHash: state.recommendation.profileInputHash,
        portfolioFingerprint: state.portfolioFingerprint,
      }, {
        $set: {
          currentRecommendationId: recommendationId,
          currentAllocationRevision: state.allocationRevision.revision,
          currentAllocationRevisionId: state.allocationRevision._id,
          profileInputHash: state.recommendation.profileInputHash,
          portfolioFingerprint: state.portfolioFingerprint,
          returnAssumptionVersion: state.allocationRevision.returnAssumptionVersion,
          returnAssumptionHash: state.allocationRevision.returnAssumptionHash,
          returnAssumptionSource: state.allocationRevision.returnAssumptionSource,
        },
        $inc: { financialStateFence: 1 },
      }, { session });
      if (stateCas.matchedCount !== 1) {
        const error = new Error('The financial state changed while advisory text was being generated.');
        error.code = 'ADVISORY_SOURCE_STATE_CHANGED';
        error.status = 409;
        throw error;
      }
      const result = await Recommendation.updateOne({
        _id: recommendationId,
        userId,
        'advisoryMetadata.status': 'GENERATING',
        'advisoryMetadata.claimToken': claimToken,
        'advisoryMetadata.allocationRevision': state.allocationRevision.revision,
        'advisoryMetadata.allocationRevisionId': String(state.allocationRevision._id),
        'advisoryMetadata.portfolioFingerprint': state.portfolioFingerprint,
      }, {
        $set: { advisoryText, advisoryMetadata },
      }, { session });
      if (result.matchedCount !== 1) {
        const error = new Error('The advisory generation claim is no longer current.');
        error.code = 'ADVISORY_SOURCE_STATE_CHANGED';
        error.status = 409;
        throw error;
      }
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
  } finally {
    await session.endSession();
  }
}

router.post('/', verifyJWT, validateStrict(recommendationRequestSchema), asyncHandler(async (req, res) => {
  const tTotalStart = performance.now();
  const { profileId } = req.body;
  const ownedProfile = await FinancialProfile.exists({ _id: profileId, userId: req.user.userId });
  if (!ownedProfile) {
    throw createError(404, 'Profile not found or access denied', 'Profile not found.', { code: 'PROFILE_NOT_FOUND' });
  }
  const tIdempotencyStart = performance.now();
  const idempotencyClaim = await claimAdvisoryIdempotency({
    key: req.headers['idempotency-key'],
    userId: req.user.userId,
    profileId,
    payload: { profileId: String(profileId) },
    operation: 'recommendation.generate',
  });
  const tIdempotency = performance.now() - tIdempotencyStart;
  if (idempotencyClaim.state === 'REPLAY') {
    res.setHeader('X-Cache-Lookup', 'HIT - Idempotent');
    return res.status(idempotencyClaim.response.status).json(idempotencyClaim.response.body);
  }

  try {
    // A durable completed operation must be replayed before checking whether
    // its originally requested profile is still current. New operations still
    // fail closed on stale profile state and release their uncommitted claim.
    const tProfileStart = performance.now();
    const currentProfileState = await resolveCurrentFinancialProfile({ userId: req.user.userId });
    const stored = currentProfileState.profile;
    if (stored && String(stored._id) !== String(profileId)) {
      throw createError(409, 'The requested profile is no longer current.', 'Refresh the current profile before generating a recommendation.', {
        code: 'PROFILE_STATE_VERSION_CONFLICT',
        details: { profileStateRevision: currentProfileState.state.revision },
      });
    }
    const tProfile = performance.now() - tProfileStart;
    if (!stored) throw createError(404, 'Profile not found or access denied', 'Profile not found.', { code: 'PROFILE_NOT_FOUND' });

    const profile = buildRecommendationProfile(stored);
    const core = await computeCoreRecommendation({
      canonicalProfile: profile,
      profileVersion: stored.version ?? 1,
      userId: req.user.userId,
      profileId: stored._id,
      correlationId: req.correlationId,
      traceId: req.traceId || req.correlationId,
      userRole: req.user.role,
    });
    const tPersistStart = performance.now();
    const persisted = await persistAdvisoryAtomically({
      recommendation: core.recommendationData,
      auditRecord: core.auditRecordData,
      response: core.response,
      idempotencyClaim,
      profileStateBinding: {
        revision: Number(currentProfileState.state.revision),
        currentProfileId: String(stored._id),
      },
    });
    const tPersist = performance.now() - tPersistStart;
    const tCacheStart = performance.now();
    const cacheKey = buildRecommendationCacheKey(req.user.userId, stored._id, profile, core.modelVersion);
    await setCache(cacheKey, persisted, 86400).catch(error => {
      logger.warn('Recommendation cache write failed after committed advisory', { error: error.message });
    });
    const tCache = performance.now() - tCacheStart;
    const tTotal = performance.now() - tTotalStart;
    const timings = core.timings || {};

    res.setHeader('Server-Timing', [
      `profile;dur=${tProfile.toFixed(2)}`,
      `idempotency;dur=${tIdempotency.toFixed(2)}`,
      `ml;dur=${Number(timings.ml || 0).toFixed(2)}`,
      `pipeline;dur=${Number(timings.pipeline || 0).toFixed(2)}`,
      `market-context;dur=${Number(timings.marketContext || 0).toFixed(2)}`,
      `projection;dur=${Number(timings.projection || 0).toFixed(2)}`,
      `persistence;dur=${tPersist.toFixed(2)}`,
      `cache;dur=${tCache.toFixed(2)}`,
      `total;dur=${tTotal.toFixed(2)}`,
    ].join(', '));

    void triggerPlanHealthCheck({ userId: req.user.userId, profileId: stored._id });
    return res.json(persisted);
  } catch (error) {
    await releaseAdvisoryIdempotency(idempotencyClaim).catch(releaseError => {
      logger.error('Failed to release advisory idempotency claim', { error: releaseError.message });
    });
    throw error;
  }
}));

router.get('/current', verifyJWT, validateQuery(recommendationCurrentQuerySchema), asyncHandler(async (req, res) => {
  const { profileId } = req.query;
  if (!isValidObjectId(profileId)) {
    throw createError(400, 'Invalid profile ID format', 'Invalid profile ID.');
  }

  const profileState = await requireCurrentFinancialProfile({ userId: req.user.userId, profileId });
  const profile = profileState.profile;
  if (!profile) {
    throw createError(404, 'Profile not found or access denied', 'Recommendation not found.');
  }

  let state;
  try {
    state = await requireFreshRecommendationState({ userId: req.user.userId, profileId, profile });
  } catch (error) {
    if (error.code === 'RECOMMENDATION_REQUIRED') throw createError(404, error.message, 'Recommendation not found.');
    if (error.code === 'RECOMMENDATION_STALE') {
      // Diagnose stale state without disclosing profile contents or user IDs.
      const reasonCodes = (Array.isArray(error.reasonCodes) ? error.reasonCodes : [])
        .filter(code => typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code)).slice(0,24);
      logger.warn('Authoritative recommendation rejected by freshness gate', {
        reasonCodes, requestId: req.correlationId || null,
      });
      throw createError(error.status || 409, error.message, 'Regenerate recommendations before opening the dashboard.', {
        code: error.reasonCodes?.includes('REGULATORY_VERSION_UNAVAILABLE') ? 'REGULATORY_POLICY_UNAVAILABLE' : 'STALE_RECOMMENDATION',
        details: {
          reasonCodes: error.reasonCodes,
          freshness: error.freshness,
          provenance: error.provenance,
        },
      });
    }
    if ([
      'FINANCIAL_STATE_MISSING', 'FINANCIAL_STATE_POINTER_INVALID', 'CURRENT_RECOMMENDATION_MISMATCH',
      'ALLOCATION_REVISION_MISSING', 'ALLOCATION_REVISION_ID_MISMATCH', 'ALLOCATION_REVISION_NUMBER_MISMATCH',
      'ALLOCATION_REVISION_POINTER_STALE', 'PROFILE_HASH_MISMATCH', 'PROFILE_VERSION_MISMATCH',
      'MODEL_VERSION_MISMATCH', 'RECOMMENDATION_POLICY_MISMATCH', 'REGULATORY_POLICY_MISMATCH',
      'ASSUMPTION_HASH_MISMATCH', 'ALLOCATION_FINGERPRINT_MISMATCH', 'RECOMMENDATION_FINGERPRINT_MISMATCH',
      'ALLOCATION_AUDIT_BINDING_MISSING', 'ALLOCATION_AUDIT_BINDING_MISMATCH', 'ALLOCATION_AUDIT_HASH_MISMATCH',
      'ALLOCATION_PREVIOUS_REVISION_FINGERPRINT_MISMATCH', 'RECOMMENDATION_SUPERSEDED',
    ].includes(error.code)) {
      throw createError(503, error.message, 'Authoritative financial state is temporarily unavailable.', {
        code: error.code,
        details: { reasonCodes: error.reasonCodes, provenance: error.provenance },
      });
    }
    throw error;
  }
  const { recommendation, allocationRevision, freshness, provenance, portfolioFingerprint } = state;
  const advisoryBinding = assessAdvisoryStateBinding(recommendation.advisoryMetadata, state);
  const currentAdvisoryExplanation = recommendation.advisoryMetadata?.status === 'PENDING'
    ? { status: 'PENDING' }
    : advisoryBinding.fresh
    ? advisoryExplanationFromMetadata(recommendation.advisoryMetadata)
    : { status: 'STALE', unavailable_facts: [advisoryBinding.reason] };
  const currentResponse = buildCurrentRecommendationResponse({
    profile,
    recommendation,
    allocationRevision,
    freshness,
    provenance,
    portfolioFingerprint,
    recommendationFingerprint: state.recommendationFingerprint,
    advisoryExplanation: currentAdvisoryExplanation,
    advisoryText: advisoryBinding.fresh ? recommendation.advisoryText : null,
  });
  return res.json(currentResponse);
}));

router.post('/:recommendationId/advisory', verifyJWT, asyncHandler(async (req, res) => {
  const { recommendationId } = req.params;
  if (!isValidObjectId(recommendationId)) {
    throw createError(400, 'Invalid recommendation ID format', 'Invalid recommendation ID.');
  }

  const recommendation = await Recommendation.findById(recommendationId);
  if (!recommendation) {
    throw createError(404, 'Recommendation not found or access denied', 'Recommendation not found.');
  }
  if (recommendation.userId.toString() !== req.user.userId.toString() && req.user.role !== 'admin') {
    throw createError(403, 'Access denied to recommendation', 'Access denied.');
  }

  await requireCurrentFinancialProfile({ userId: recommendation.userId, profileId: recommendation.profileId });

  let recommendationState;
  try {
    recommendationState = await requireFreshRecommendationState({
      userId: req.user.userId,
      profileId: recommendation.profileId,
      recommendationId,
    });
  } catch (error) {
    throw createError(error.status || 409, error.message, 'Regenerate recommendations before generating advisory text.', {
      code: error.code || 'RECOMMENDATION_STALE',
      details: { reasonCodes: error.reasonCodes, freshness: error.freshness },
    });
  }
  const currentAllocationRevision = recommendationState.allocationRevision?.revision || 1;
  const currentPortfolioFingerprint = recommendationState.portfolioFingerprint;
  const advisoryBinding = assessAdvisoryStateBinding(recommendation.advisoryMetadata, recommendationState);

  const isReady = advisoryBinding.fresh && (recommendation.advisoryMetadata?.status === 'READY'
    || recommendation.advisoryMetadata?.status === 'GROUNDED_EXPLANATION_AVAILABLE'
    || recommendation.advisoryMetadata?.status === 'GROUNDED_EXPLANATION_FALLBACK'
    || (Boolean(recommendation.advisoryText) && !['PENDING', 'GENERATING', 'FAILED'].includes(recommendation.advisoryMetadata?.status)));

  if (isReady) {
    return res.json(buildAdvisoryResponse({
      recommendationId: recommendation._id,
      state: recommendationState,
      advisoryText: recommendation.advisoryText,
      advisoryExplanation: {
        status: recommendation.advisoryMetadata?.status || 'GROUNDED_EXPLANATION_AVAILABLE',
        provider: recommendation.advisoryMetadata?.provider,
        model: recommendation.advisoryMetadata?.model,
        prompt_version: recommendation.advisoryMetadata?.promptVersion || recommendation.advisoryMetadata?.prompt_version,
        grounding_version: recommendation.advisoryMetadata?.groundingVersion || recommendation.advisoryMetadata?.grounding_version,
        evidence_ids_used: recommendation.advisoryMetadata?.evidenceIdsUsed || recommendation.advisoryMetadata?.evidence_ids_used || [],
        unavailable_facts: recommendation.advisoryMetadata?.unavailableFacts || recommendation.advisoryMetadata?.unavailable_facts || [],
        citations: recommendation.advisoryMetadata?.citations || [],
        validation_status: recommendation.advisoryMetadata?.validation?.status || recommendation.advisoryMetadata?.validation_status,
        generated_at: recommendation.advisoryMetadata?.generatedAt || recommendation.advisoryMetadata?.generated_at,
      },
    }));
  }

  await reachFinancialStateTestHook('recommendation.advisory.beforeClaim', {
    recommendationId,
    userId: req.user.userId,
    state: recommendationState,
  });

  const claimToken = crypto.randomUUID();
  const staleClaimBefore = new Date(Date.now() - ADVISORY_STALE_CLAIM_MS);
  // Atomic PENDING/FAILED/expired GENERATING -> GENERATING claim.
  const claimed = await Recommendation.findOneAndUpdate(
    {
      _id: recommendationId,
      userId: req.user.userId,
      $or: [
        { 'advisoryMetadata.status': 'PENDING' },
        { 'advisoryMetadata.status': 'FAILED' },
        {
          'advisoryMetadata.status': 'GENERATING',
          'advisoryMetadata.claimedAt': { $lte: staleClaimBefore },
        },
        { advisoryMetadata: null },
        { advisoryMetadata: { $exists: false } },
        {
          'advisoryMetadata.status': { $in: ['READY', 'GROUNDED_EXPLANATION_AVAILABLE', 'GROUNDED_EXPLANATION_FALLBACK'] },
          $or: [
            { 'advisoryMetadata.recommendationId': { $ne: String(recommendation._id) } },
            { 'advisoryMetadata.profileId': { $ne: String(recommendation.profileId) } },
            { 'advisoryMetadata.allocationRevision': { $ne: currentAllocationRevision } },
            { 'advisoryMetadata.allocationRevisionId': { $ne: String(recommendationState.allocationRevision._id) } },
            { 'advisoryMetadata.portfolioFingerprint': { $ne: currentPortfolioFingerprint } },
            { 'advisoryMetadata.profileInputHash': { $ne: recommendation.profileInputHash } },
            { 'advisoryMetadata.recommendationPolicyVersion': { $ne: recommendation.recommendationPolicyVersion || RECOMMENDATION_POLICY_VERSION } },
            { 'advisoryMetadata.regulatoryRuleVersion': { $ne: recommendation.regulatoryRuleVersion } },
            { 'advisoryMetadata.returnAssumptionHash': { $ne: recommendationState.allocationRevision.returnAssumptionHash } },
            { 'advisoryMetadata.recommendationFingerprint': { $ne: recommendationState.recommendationFingerprint } },
            { 'advisoryMetadata.profileVersion': { $ne: recommendationState.profileVersion } },
          ],
        },
      ],
    },
    {
      $set: {
        'advisoryMetadata.status': 'GENERATING',
        'advisoryMetadata.claimedAt': new Date(),
        'advisoryMetadata.claimToken': claimToken,
        'advisoryMetadata.recommendationId': String(recommendation._id),
        'advisoryMetadata.profileId': String(recommendation.profileId),
        'advisoryMetadata.allocationRevision': currentAllocationRevision,
        'advisoryMetadata.allocationRevisionId': String(recommendationState.allocationRevision._id),
        'advisoryMetadata.portfolioFingerprint': currentPortfolioFingerprint,
        'advisoryMetadata.profileInputHash': recommendation.profileInputHash,
        'advisoryMetadata.recommendationPolicyVersion': recommendation.recommendationPolicyVersion || RECOMMENDATION_POLICY_VERSION,
        'advisoryMetadata.regulatoryRuleVersion': recommendation.regulatoryRuleVersion,
        'advisoryMetadata.returnAssumptionHash': recommendationState.allocationRevision.returnAssumptionHash,
        'advisoryMetadata.recommendationFingerprint': recommendationState.recommendationFingerprint,
        'advisoryMetadata.profileVersion': recommendationState.profileVersion,
      },
    },
    { new: true },
  );

  if (!claimed) {
    const current = await Recommendation.findById(recommendationId);
    const currentIsReady = current?.advisoryMetadata?.status === 'READY'
      || current?.advisoryMetadata?.status === 'GROUNDED_EXPLANATION_AVAILABLE'
      || current?.advisoryMetadata?.status === 'GROUNDED_EXPLANATION_FALLBACK'
      || (Boolean(current?.advisoryText) && !['PENDING', 'GENERATING', 'FAILED'].includes(current?.advisoryMetadata?.status));

    if (currentIsReady) {
      const currentBinding = assessAdvisoryStateBinding(current.advisoryMetadata, recommendationState);
      if (!currentBinding.fresh) {
        throw createError(409, 'Advisory text describes an older allocation revision.', 'Refresh the advisory after reviewing the current portfolio.', {
          code: currentBinding.reason || 'ADVISORY_STALE',
          allocation_revision: currentAllocationRevision,
          portfolio_fingerprint: currentPortfolioFingerprint,
        });
      }
      return res.json(buildAdvisoryResponse({
        recommendationId: current._id,
        state: recommendationState,
        advisoryText: current.advisoryText,
        advisoryExplanation: {
          status: current.advisoryMetadata?.status || 'GROUNDED_EXPLANATION_AVAILABLE',
          provider: current.advisoryMetadata?.provider,
          model: current.advisoryMetadata?.model,
          prompt_version: current.advisoryMetadata?.promptVersion || current.advisoryMetadata?.prompt_version,
          grounding_version: current.advisoryMetadata?.groundingVersion || current.advisoryMetadata?.grounding_version,
          evidence_ids_used: current.advisoryMetadata?.evidenceIdsUsed || current.advisoryMetadata?.evidence_ids_used || [],
          unavailable_facts: current.advisoryMetadata?.unavailableFacts || current.advisoryMetadata?.unavailable_facts || [],
          citations: current.advisoryMetadata?.citations || [],
          validation_status: current.advisoryMetadata?.validation?.status || current.advisoryMetadata?.validation_status,
          generated_at: current.advisoryMetadata?.generatedAt || current.advisoryMetadata?.generated_at,
        },
      }));
    }

    return sendError(req, res, 409, 'Advisory generation already in progress.', 'ADVISORY_GENERATION_IN_PROGRESS', {
      status: 'GENERATING',
      recommendationId: String(recommendation._id),
    });
  }

  try {
    const storedProfile = await FinancialProfile.findOne({
      _id: recommendation.profileId,
      userId: req.user.userId,
    }).lean();
    if (!storedProfile) {
      throw createError(404, 'Source financial profile not found', 'Profile not found.');
    }

    const profile = buildRecommendationProfile(storedProfile);
    const currentState = await requireFreshRecommendationState({
      userId: req.user.userId,
      profileId: recommendation.profileId,
      recommendationId,
      profile: storedProfile,
    });
    const suitability = assessSuitabilityRisk(profile);
    const recommendationSnapshot = recommendationPayloadFromSnapshot(recommendation.responseSnapshot);
    const shapExplanation = Number(currentState.allocationRevision.revision) === 1
      ? recommendationSnapshot?.explanation || null
      : null;

    const advisory = await generateAdvisory({
      profile: buildLlmFinancialContext(profile, suitability),
      instruments: currentState.currentAllocation.instruments.map(instrument => ({
        id: instrument.id,
        name: instrument.name,
        type: instrument.type,
        nominalReturn: instrument.nominalReturn,
        allocationWeight: instrument.allocationWeight,
      })),
      shapExplanation,
      modelVersion: recommendation.modelVersion,
      policyVersion: RECOMMENDATION_POLICY_VERSION,
    });

    const advisoryMetadata = {
      status: advisory.status,
      provider: advisory.provider,
      model: advisory.model,
      promptVersion: advisory.promptVersion,
      groundingVersion: advisory.groundingVersion,
      evidenceIdsUsed: advisory.evidenceIdsUsed,
      unavailableFacts: advisory.unavailableFacts,
      citations: advisory.citations,
      validation: advisory.validation,
      generatedAt: advisory.generatedAt,
      recommendationId: String(recommendation._id),
      profileId: String(recommendation.profileId),
      allocationRevision: currentState.allocationRevision.revision,
      allocationRevisionId: String(currentState.allocationRevision._id),
      portfolioFingerprint: currentState.portfolioFingerprint,
      profileInputHash: recommendation.profileInputHash,
      recommendationPolicyVersion: recommendation.recommendationPolicyVersion || RECOMMENDATION_POLICY_VERSION,
      regulatoryRuleVersion: recommendation.regulatoryRuleVersion,
      returnAssumptionHash: currentState.allocationRevision.returnAssumptionHash,
      recommendationFingerprint: currentState.recommendationFingerprint,
      profileVersion: currentState.profileVersion,
      claimToken,
    };

    await persistAdvisoryIfCurrent({
      recommendationId,
      userId: req.user.userId,
      state: currentState,
      claimToken,
      advisoryText: advisory.text,
      advisoryMetadata,
    });

    await reachFinancialStateTestHook('recommendation.advisory.afterPersistenceBeforeResponse', {
      recommendationId,
      userId: req.user.userId,
      state: currentState,
    });
    const reconciled = await resolveStablePostCommitCurrentState({ userId: req.user.userId });
    if (String(reconciled.current.profile._id) !== String(recommendation.profileId)
        || String(reconciled.state.recommendation._id) !== String(recommendation._id)) {
      throw createError(409, 'The recommendation changed after advisory generation.', 'Refresh the current recommendation before loading its advisory.', {
        code: 'RECOMMENDATION_SUPERSEDED',
      });
    }
    const persistedRecommendation = reconciled.state.recommendation;
    const persistedBinding = assessAdvisoryStateBinding(persistedRecommendation.advisoryMetadata, reconciled.state);
    const persistedMetadata = persistedRecommendation.advisoryMetadata || {};
    return res.json(buildAdvisoryResponse({
      recommendationId: persistedRecommendation._id,
      state: reconciled.state,
      advisoryText: persistedBinding.fresh ? persistedRecommendation.advisoryText : null,
      advisoryExplanation: persistedBinding.fresh
        ? advisoryExplanationFromMetadata(persistedMetadata)
        : { status: 'STALE', unavailable_facts: [persistedBinding.reason || 'ADVISORY_SOURCE_STATE_CHANGED'] },
    }));
  } catch (error) {
    await Recommendation.updateOne(
      {
        _id: recommendationId,
        userId: req.user.userId,
        'advisoryMetadata.status': 'GENERATING',
        'advisoryMetadata.claimToken': claimToken,
      },
      {
        $set: {
          'advisoryMetadata.status': 'FAILED',
          'advisoryMetadata.error': error.message,
        },
      },
    ).catch(() => {});
    throw error;
  }
}));

router.get('/audit', verifyJWT, validateQuery(recommendationAuditQuerySchema), asyncHandler(async (req, res) => {
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
  const skip = req.query.skip === undefined ? 0 : Number(req.query.skip);
  const query = { userId: req.user.userId };
  if (req.query.correlationId) query.correlationId = req.query.correlationId;
  if (req.query.profileId) query.profileId = req.query.profileId;
  const [records, total] = await Promise.all([
    AuditRecord.find(query).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
    AuditRecord.countDocuments(query),
  ]);
  records.forEach(assertRecommendationMarketDistributionAllowed);
  res.json({ status: 'success', total, count: records.length, skip, limit, records });
}));

router.get('/audit/verify', verifyJWT, asyncHandler(async (req, res) => {
  const verification = await verifyAuditChain(req.user.userId);
  res.status(verification.valid ? 200 : 409).json({ status: verification.valid ? 'valid' : 'invalid', ...verification });
}));

router.get('/audit/:id', verifyJWT, asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw createError(400, 'Invalid audit ID format', 'Invalid audit ID.');
  const record = await AuditRecord.findById(req.params.id).lean();
  if (!record) throw createError(404, 'Audit record not found', 'Audit record not found.');
  if (record.userId.toString() !== req.user.userId.toString() && req.user.role !== 'admin') {
    throw createError(403, 'Access denied to audit record', 'Access denied.');
  }
  assertRecommendationMarketDistributionAllowed(record);
  res.json({ status: 'success', record });
}));

router.post('/weights', verifyJWT, validateStrict(recommendationWeightsSchema), asyncHandler(async (req, res) => {
  const { profileId, recommendationId, weights, expectedAllocationRevision, expectedPortfolioFingerprint } = req.body;
  const currentProfile = await requireCurrentFinancialProfile({ userId: req.user.userId, profileId });
  const stored = currentProfile.profile;
  if (!stored) throw createError(404, 'Profile not found or access denied', 'Profile not found.');
  const profile = buildRecommendationProfile(stored);
  let state;
  try {
    state = await requireFreshRecommendationState({ userId: req.user.userId, profileId, profile });
  } catch (error) {
    throw createError(error.status || 409, error.message, 'Regenerate recommendations before changing weights.', {
      code: error.code || 'RECOMMENDATION_STALE',
      details: { reasonCodes: error.reasonCodes, freshness: error.freshness },
    });
  }
  const recommendation = state.recommendation;
  if (String(recommendationId) !== String(recommendation._id)) {
    throw createError(409, 'The requested recommendation has been superseded.', 'Refresh before changing weights.', { code: 'RECOMMENDATION_SUPERSEDED' });
  }
  const currentInstruments = state.currentAllocation?.instruments || [];
  const instrumentIds = currentInstruments.map(instrument => String(instrument.id));
  const suppliedIds = Object.keys(weights);
  if (instrumentIds.length !== suppliedIds.length || instrumentIds.some(id => !suppliedIds.includes(id))) {
    throw createError(400, 'Weights must identify every recommended instrument by id and may not add instruments.', 'Invalid instrument weights.');
  }
  assertPortfolioSuitable(profile, instrumentIds);

  const groupTotals = new Map();
  currentInstruments.forEach(instrument => {
    const cap = resolveConcentrationCap(instrument.toObject ? instrument.toObject() : instrument);
    if (cap) groupTotals.set(cap.key, (groupTotals.get(cap.key) || 0) + weights[instrument.id] * 100);
  });
  for (const [key, total] of groupTotals.entries()) {
    const cap = resolveConcentrationCap(currentInstruments.find(instrument => resolveConcentrationCap(instrument)?.key === key));
    if (cap && total > cap.maxPct + 0.0001) {
      throw createError(400, `Allocation exceeds ${key} concentration cap of ${cap.maxPct}%`, 'Allocation exceeds suitability limits.');
    }
  }

  const updatedInstruments = currentInstruments.map(instrument => ({
    ...instrument,
    allocationWeight: Number(weights[instrument.id].toFixed(4)),
    allocation_pct: Number((weights[instrument.id] * 100).toFixed(2)),
  }));
  if (Math.abs(updatedInstruments.reduce((sum, item) => sum + item.allocationWeight, 0) - 1) > 0.001) {
    throw createError(400, 'Allocation weights must total 100%.', 'Invalid allocation weights.');
  }
  let revisionResult;
  try {
    revisionResult = await createManualAllocationRevision({
      userId: req.user.userId,
      profileId,
      recommendationId: recommendation._id,
      expectedRevision: expectedAllocationRevision,
      expectedRecommendationId: recommendationId,
      expectedPortfolioFingerprint,
      instruments: updatedInstruments,
      correlationId: req.correlationId,
      traceId: req.traceId,
    });
  } catch (error) {
    if (error.code === 'ALLOCATION_REVISION_CONFLICT') {
      throw createError(409, error.message, 'This portfolio changed before the rebalance completed. Refresh and retry.', { code: error.code });
    }
    if (error.code === 'RECOMMENDATION_STALE') {
      throw createError(409, error.message, 'Regenerate recommendations before changing weights.', { code: error.code });
    }
    if (error.code === 'ALLOCATION_STATE_CHANGED') {
      throw createError(409, error.message, 'This portfolio changed before the rebalance completed. Refresh and retry.', { code: error.code });
    }
    if (error.code === 'PROFILE_STATE_CHANGED') {
      throw createError(409, error.message, 'The Financial Profile changed before the rebalance completed. Refresh and retry.', { code: error.code });
    }
    if (error.code === 'PROFILE_STATE_VERSION_CONFLICT') {
      throw createError(409, error.message, 'The current Financial Profile changed before the rebalance completed. Refresh and retry.', { code: error.code });
    }
    throw error;
  }
  await delCache(buildRecommendationCacheKey(req.user.userId, stored._id, profile, recommendation.modelVersion)).catch(error => {
    // The revision and audit record have already committed atomically. Cache
    // invalidation is best-effort and must not turn a committed rebalance into
    // a client-visible failure that may be retried as a second mutation.
    logger.warn('Recommendation cache invalidation failed after committed allocation revision', {
      error: error.message,
      recommendationId: String(recommendation._id),
      allocationRevision: revisionResult.revision.revision,
    });
  });
  await reachFinancialStateTestHook('allocation.afterCommitBeforeReconcile', {
    userId: req.user.userId,
    profileId: String(stored._id),
    committedRecommendationId: String(recommendation._id),
    committedAllocationRevisionId: String(revisionResult.revision._id),
  });
  let committedState;
  try {
    // The write and audit chain have committed. Reconcile against the current
    // canonical pointer; do not treat a valid later revision as a failed write.
    const reconciled = await resolveStablePostCommitCurrentState({ userId: req.user.userId });
    committedState = reconciled.state;
  } catch (error) {
    logger.error('Committed allocation revision could not be reconciled to verified current state', {
      userId: String(req.user.userId),
      profileId: String(stored._id),
      committedRecommendationId: String(recommendation._id),
      committedAllocationRevisionId: String(revisionResult.revision._id),
      reasonCode: error.code || 'CURRENT_STATE_UNAVAILABLE',
    });
    throw createError(503, 'Allocation committed, but the current financial state could not be verified. Refresh before retrying.', 'The allocation was committed but could not be safely reconciled. Refresh the portfolio before retrying.', {
      code: 'COMMITTED_BUT_RESPONSE_RECONCILIATION_FAILED',
      details: { committed: true, reasonCode: error.code || 'CURRENT_STATE_UNAVAILABLE' },
    });
  }
  const supersededBeforeResponse = String(committedState.recommendation._id) !== String(recommendation._id)
    || String(committedState.allocationRevision._id) !== String(revisionResult.revision._id);
  if (supersededBeforeResponse) {
    logger.info('Committed allocation revision was superseded before response reconciliation', {
      userId: String(req.user.userId),
      profileId: String(stored._id),
      committedRecommendationId: String(recommendation._id),
      committedAllocationRevisionId: String(revisionResult.revision._id),
      currentRecommendationId: String(committedState.recommendation._id),
      currentAllocationRevisionId: String(committedState.allocationRevision._id),
    });
  }
  const currentResponse = buildCurrentRecommendationResponse({
    profile: committedState.profile,
    recommendation: committedState.recommendation,
    allocationRevision: committedState.allocationRevision,
    freshness: committedState.freshness,
    provenance: committedState.provenance,
    portfolioFingerprint: committedState.portfolioFingerprint,
    recommendationFingerprint: committedState.recommendationFingerprint,
    advisoryExplanation: { status: 'STALE', unavailable_facts: ['ADVISORY_SOURCE_STATE_CHANGED'] },
    advisoryText: null,
  });
  res.json({
    ...currentResponse,
    status: 'success',
    message: 'Recommendation weights updated.',
    operation_result: {
      committed: true,
      generated_recommendation_id: String(recommendation._id),
      generated_allocation_revision: revisionResult.revision.revision,
      generated_allocation_revision_id: String(revisionResult.revision._id),
      superseded_before_response: supersededBeforeResponse,
    },
  });
}));

export default router;
