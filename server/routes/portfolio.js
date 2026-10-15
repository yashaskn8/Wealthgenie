import { Router } from 'express';
import { verifyJWT } from '../middleware/authMiddleware.js';
import { asyncHandler, createError } from '../middleware/errorHandler.js';
import { optimisePortfolio, computeRebalance, evaluatePortfolio } from '../services/portfolioEngine.js';
import {
  normalizeAllocationWeights,
  REBALANCE_TARGET_TOTAL_TOLERANCE_PERCENT,
} from '../utils/allocationWeights.js';
import {
  INSTRUMENT_PARAMS,
  PROJECTION_ASSUMPTION_DATA_CLASS,
  PROJECTION_ASSUMPTION_SOURCE,
  PROJECTION_ASSUMPTION_VERSION,
} from '../services/instrumentConstants.js';
import {
  assertPortfolioSuitable,
  enforceAllocationTargets,
  resolveConcentrationCap,
} from '../services/RecommendationPipeline.js';
import { buildRecommendationProfile } from '../services/recommendationProfile.js';
import FinancialProfile from '../models/FinancialProfile.js';
import {
  personalizedOptimiseSchema,
  personalizedRebalanceSchema,
  validateStrict,
} from '../validation/financialSchemas.js';

const router = Router();

function loadOwnedProfile(profileId, userId) {
  return FinancialProfile.findOne({ _id: profileId, userId }).lean();
}

function validateTargetConcentration(targetAllocation) {
  const groupTotals = new Map();
  for (const [key, weight] of Object.entries(targetAllocation)) {
    const cap = resolveConcentrationCap({ id: key, type: key, name: key });
    if (cap) groupTotals.set(cap.key, (groupTotals.get(cap.key) || 0) + Number(weight));
  }
  for (const [key, total] of groupTotals.entries()) {
    const cap = resolveConcentrationCap({ id: key, type: key, name: key });
    if (cap && total > cap.maxPct + 0.0001) {
      const error = createError(400, `${key} allocation exceeds ${cap.maxPct}%`, 'Allocation exceeds suitability limits.');
      error.code = 'CONCENTRATION_CAP_EXCEEDED';
      throw error;
    }
  }
}

router.post('/optimise', verifyJWT, validateStrict(personalizedOptimiseSchema), asyncHandler(async (req, res) => {
  const { profileId, assets, strategy } = req.body;
  const stored = await loadOwnedProfile(profileId, req.user.userId);
  if (!stored) throw createError(404, 'Profile not found or access denied', 'Financial profile not found.');
  const profile = buildRecommendationProfile(stored);

  for (const key of assets) {
    if (!INSTRUMENT_PARAMS[key]) throw createError(400, `Unknown asset key: ${key}`, 'Unknown instrument.');
  }
  const suitability = assertPortfolioSuitable(profile, assets);
  const nominalReturns = assets.map(key => INSTRUMENT_PARAMS[key].nominalRate / 100);
  const rawResult = optimisePortfolio(assets, nominalReturns, strategy);
  const capped = enforceAllocationTargets(assets.map(key => {
    const rawWeight = Number(rawResult.weights[key]);
    if (!Number.isFinite(rawWeight)) {
      throw createError(500, `Optimizer omitted a finite weight for ${key}`, 'Portfolio optimization failed.');
    }
    return {
      id: key,
      type: key,
      name: INSTRUMENT_PARAMS[key].name,
      score: rawWeight * 100,
    };
  }));
  const weights = Object.fromEntries(capped.map(instrument => [instrument.id, instrument.allocationWeight]));
  const metrics = evaluatePortfolio(assets, nominalReturns, weights);

  res.json({
    strategy: rawResult.strategy,
    weights,
    portfolio_return_assumption: metrics.expectedReturn,
    volatility: metrics.volatility,
    sharpe_ratio: metrics.sharpe,
    risk_contributions: metrics.riskContributions,
    return_basis: 'PRE_TAX_NOMINAL',
    return_data_class: PROJECTION_ASSUMPTION_DATA_CLASS,
    return_assumption_version: PROJECTION_ASSUMPTION_VERSION,
    return_assumption_source: PROJECTION_ASSUMPTION_SOURCE,
    observed_market_fact: false,
    provider_forecast: false,
    simulation_classification: 'PROFILE_GROUNDED',
    final_suitability_risk: suitability.finalRisk,
    suitability_reason_codes: suitability.reasonCodes,
  });
}));

router.post('/rebalance', verifyJWT, validateStrict(personalizedRebalanceSchema), asyncHandler(async (req, res) => {
  const {
    profileId, current_allocation, target_allocation, threshold, partial_ratio, holding_months,
  } = req.body;
  const stored = await loadOwnedProfile(profileId, req.user.userId);
  if (!stored) throw createError(404, 'Profile not found or access denied', 'Financial profile not found.');
  const profile = buildRecommendationProfile(stored);

  const currentKeys = Object.keys(current_allocation);
  if (currentKeys.some(key => !INSTRUMENT_PARAMS[key])) {
    throw createError(400, 'Current allocation contains an unknown instrument.', 'Unknown instrument.');
  }
  const targetKeys = Object.keys(target_allocation);
  if (targetKeys.some(key => !INSTRUMENT_PARAMS[key])) {
    throw createError(400, 'Target allocation contains an unknown instrument.', 'Unknown instrument.');
  }
  const targetTotal = Object.values(target_allocation).reduce((sum, value) => sum + Number(value), 0);
  if (Math.abs(targetTotal - 100) > REBALANCE_TARGET_TOTAL_TOLERANCE_PERCENT) {
    throw createError(400, 'Target allocation must sum to exactly 100%.', 'Invalid target allocation.');
  }
  const targetEntries = Object.entries(target_allocation);
  const normalizedTargetWeights = normalizeAllocationWeights(targetEntries.map(([, weight]) => weight / 100));
  const normalizedTargetAllocation = Object.fromEntries(targetEntries.map(([key], index) => [
    key,
    normalizedTargetWeights[index] * 100,
  ]));
  const positiveTargets = Object.entries(normalizedTargetAllocation).filter(([, weight]) => weight > 0).map(([key]) => key);
  const suitability = assertPortfolioSuitable(profile, positiveTargets);
  validateTargetConcentration(normalizedTargetAllocation);

  const result = computeRebalance(current_allocation, normalizedTargetAllocation, threshold, partial_ratio, holding_months);
  res.json({
    ...result,
    simulation_classification: 'PROFILE_GROUNDED',
    final_suitability_risk: suitability.finalRisk,
    suitability_reason_codes: suitability.reasonCodes,
  });
}));

export default router;
