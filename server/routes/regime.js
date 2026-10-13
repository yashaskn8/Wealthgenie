import express from 'express';
import { verifyJWT } from '../middleware/authMiddleware.js';
import { asyncHandler, createError } from '../middleware/errorHandler.js';
import { requireCurrentFinancialProfile } from '../services/currentFinancialProfile.js';
import {
  buildRecommendationProfile,
} from '../services/recommendationProfile.js';
import { getLiveMarketContext } from '../services/marketContextService.js';
import { applyProfileSafeMarketContextAdjustment } from '../services/regimeRotationEngine.js';
import { requireFreshRecommendationState } from '../services/recommendationState.js';
import {
  validate, validateQuery, regimeAdjustSchema, marketContextQuerySchema,
} from '../validation/schemas.js';

export function createRegimeRouter(dependencies = {}) {
  const getMarketContext = dependencies.getLiveMarketContext || getLiveMarketContext;
  const resolveCurrentProfile = dependencies.requireCurrentFinancialProfile || requireCurrentFinancialProfile;
  const createRecommendationProfile = dependencies.buildRecommendationProfile || buildRecommendationProfile;
  const resolveFreshRecommendation = dependencies.requireFreshRecommendationState || requireFreshRecommendationState;
  const calculateAdjustment = dependencies.applyProfileSafeMarketContextAdjustment || applyProfileSafeMarketContextAdjustment;
  const router = express.Router();

  // GET /api/regime/current — verified, source-backed market context only.
  // Query overrides are deliberately rejected: clients cannot select a regime.
  router.get('/current', validateQuery(marketContextQuerySchema), asyncHandler(async (_req, res) => {
    const current = await getMarketContext();
    res.json(current);
  }));

  // POST /api/regime/adjust — bounded preview over the latest server-owned
  // recommendation. Client-supplied weights and context overrides are forbidden.
  router.post('/adjust', verifyJWT, validate(regimeAdjustSchema), asyncHandler(async (req, res) => {
    const { profileId } = req.body;
    const { profile: profileDocument } = await resolveCurrentProfile({ userId: req.user.userId, profileId });
    if (!profileDocument) {
      throw createError(404, 'Profile not found or access denied', 'Financial profile not found.');
    }
    const profile = createRecommendationProfile(profileDocument);
    let state;
    try {
      state = await resolveFreshRecommendation({ userId: req.user.userId, profileId, profile });
    } catch (error) {
      const publicCode = error.reasonCodes?.some(reason => ['PROFILE_CHANGED', 'PROFILE_VERSION_CHANGED'].includes(reason))
        ? 'STALE_RECOMMENDATION_PROFILE'
        : (error.code || 'RECOMMENDATION_STALE');
      throw createError(error.status || 409, error.message, 'Regenerate recommendations before previewing a market-context adjustment.', {
        code: publicCode,
        details: { reasonCodes: error.reasonCodes, freshness: error.freshness },
      });
    }
    const marketContext = await getMarketContext();
    const result = calculateAdjustment({
      profile,
      instruments: state.currentAllocation.instruments,
      marketContext,
    });
    res.json({
      ...result,
      marketContext,
      recommendationId: String(state.recommendation._id),
      profileId: String(profileDocument._id),
      profile_version: state.profileVersion,
      allocation_revision: state.allocationRevision.revision,
      allocation_revision_id: String(state.allocationRevision._id),
      portfolio_fingerprint: state.portfolioFingerprint,
      recommendation_fingerprint: state.recommendationFingerprint,
      persisted: false,
    });
  }));

  return router;
}

export default createRegimeRouter();
