import { Router } from 'express';
import { verifyJWT } from '../middleware/authMiddleware.js';
import { asyncHandler, createError } from '../middleware/errorHandler.js';
import { allocationSplitSchema, customPortfolioProjectionSchema, historicalXirrSchema, personalizedProjectionSchema, projectionComparisonSchema, stepUpProjectionSchema, stressScenarioSchema, validateStrict } from '../validation/financialSchemas.js';
import { requireCurrentFinancialProfile } from '../services/currentFinancialProfile.js';
import { generateAllocationSplit, generatePortfolioProjection, generateProjectionComparison, generateProjections, sipFV, stepUpSipFV } from '../services/projectionEngine.js';
import { normalizeAllocationWeights } from '../utils/allocationWeights.js';
import { computeXIRR, computeSIPXIRR } from '../services/xirrCalculator.js';
import {
  getNominalRate,
  INSTRUMENT_PARAMS,
  PROJECTION_ASSUMPTION_DATA_CLASS,
  PROJECTION_ASSUMPTION_SOURCE,
  PROJECTION_ASSUMPTION_VERSION,
} from '../services/instrumentConstants.js';
import { buildRecommendationProfile, buildProfileGroundedSimulation } from '../services/recommendationProfile.js';
import {
  assertPortfolioSuitable,
  resolveConcentrationCap,
  resolveInstrumentModelKey,
} from '../services/RecommendationPipeline.js';
import { resolveAssetKey } from '../services/portfolioEngine.js';
import { buildStressScenarioReport } from '../services/stressScenarioEngine.js';
import { requireFreshRecommendationState, resolveCurrentRecommendationState } from '../services/recommendationState.js';

const router = Router();

const PROJECTION_INFLATION_ASSUMPTION = 0.05;
const PERSONALIZED_CONTRIBUTION_STEP_UP = 0;
const MODEL_ASSUMPTION_METADATA = Object.freeze({
  return_data_class: PROJECTION_ASSUMPTION_DATA_CLASS,
  return_assumption_version: PROJECTION_ASSUMPTION_VERSION,
  return_assumption_source: PROJECTION_ASSUMPTION_SOURCE,
  observed_market_fact: false,
  provider_forecast: false,
});

const RISK_LEVEL_SCORE = Object.freeze({
  'Very Low': 1, Low: 1.5, 'Low-Medium': 2, 'Medium-Low': 2.5,
  Medium: 3, High: 4, 'Very High': 5,
});

function assertCustomConcentration(allocations) {
  const grouped = new Map();
  for (const [key, weight] of Object.entries(allocations)) {
    const cap = resolveConcentrationCap({ id: key, type: key, name: key });
    if (cap) grouped.set(cap.key, (grouped.get(cap.key) || 0) + (weight * 100));
  }
  for (const [group, total] of grouped.entries()) {
    const cap = resolveConcentrationCap({ id: group, type: group, name: group });
    if (cap && total > cap.maxPct + 0.0001) {
      throw createError(400, `${group} allocation exceeds ${cap.maxPct}%`, 'Allocation exceeds suitability limits.');
    }
  }
}

router.post('/stress-test', verifyJWT, validateStrict(stressScenarioSchema), asyncHandler(async (req, res) => {
  const { profileId, instrumentId, principal } = req.body;
  const { profile: stored } = await requireCurrentFinancialProfile({ userId: req.user.userId, profileId });
  if (!stored) throw createError(404, 'Profile not found or access denied', 'Profile not found.');

  const profile = buildRecommendationProfile(stored);
  let state;
  try {
    state = await requireFreshRecommendationState({ userId: req.user.userId, profileId, profile });
  } catch (error) {
    throw createError(error.status || 409, error.message, 'Refresh your recommendation before running a stress test.', {
      code: error.code || 'RECOMMENDATION_STALE',
      details: { reasonCodes: error.reasonCodes, freshness: error.freshness },
    });
  }

  const instrument = state.currentAllocation.instruments.find(entry => entry.id === instrumentId);
  if (!instrument) {
    throw createError(
      400,
      `Instrument ${instrumentId} is outside the authoritative recommendation.`,
      'Stress tests are available only for instruments in your current recommendation.',
      { code: 'INSTRUMENT_NOT_RECOMMENDED' },
    );
  }

  res.json({
    ...buildStressScenarioReport({ instrument, principal }),
    profile_id: profileId,
    recommendation_generated_at: state.recommendation.generatedAt,
    allocation_revision: state.allocationRevision.revision,
    portfolio_fingerprint: state.portfolioFingerprint,
  });
}));

router.post('/custom-portfolio', verifyJWT, validateStrict(customPortfolioProjectionSchema), asyncHandler(async (req, res) => {
  const { profileId, allocations, years } = req.body;
  const { profile: stored } = await requireCurrentFinancialProfile({ userId: req.user.userId, profileId });
  if (!stored) throw createError(404, 'Profile not found or access denied', 'Profile not found.');
  const profile = buildRecommendationProfile(stored);
  const allocationEntries = Object.entries(allocations);
  const normalizedWeights = normalizeAllocationWeights(allocationEntries.map(([, weight]) => weight));
  const normalizedAllocations = Object.fromEntries(allocationEntries.map(([key], index) => [key, normalizedWeights[index]]));
  const keys = Object.keys(normalizedAllocations).filter(key => normalizedAllocations[key] > 0);
  if (keys.some(key => !INSTRUMENT_PARAMS[key])) {
    throw createError(400, 'Allocation contains an unknown instrument.', 'Unknown instrument.');
  }
  const suitability = assertPortfolioSuitable(profile, keys);
  assertCustomConcentration(normalizedAllocations);
  const simulation = buildProfileGroundedSimulation(profile, {
    monthlyInvestment: profile.monthlySavings,
    years,
  });
  const instruments = keys.map(key => ({
    id: key,
    nominalReturn: getNominalRate(key),
    allocationWeight: normalizedAllocations[key],
  }));
  const projection = generatePortfolioProjection({
    monthlyContribution: simulation.monthlyContribution,
    initialLumpSum: simulation.initialCapital,
    horizonYears: simulation.years,
    instruments,
  });
  const portfolioNominalReturn = instruments.reduce(
    (sum, instrument) => sum + instrument.nominalReturn * instrument.allocationWeight,
    0,
  );
  const portfolioRiskScore = instruments.reduce((sum, instrument) => (
    sum + (RISK_LEVEL_SCORE[INSTRUMENT_PARAMS[instrument.id].riskLevel] * instrument.allocationWeight)
  ), 0);
  const safeWeight = instruments.reduce((sum, instrument) => (
    ['Very Low', 'Low', 'Low-Medium'].includes(INSTRUMENT_PARAMS[instrument.id].riskLevel)
      ? sum + instrument.allocationWeight
      : sum
  ), 0);
  const assetClassAllocation = { equity: 0, etf: 0, debt: 0 };
  for (const instrument of instruments) {
    if (instrument.id === 'ETF') assetClassAllocation.etf += instrument.allocationWeight * 100;
    else if (['Equity_MF', 'Index_MF', 'Midcap_MF', 'Smallcap_MF', 'ELSS'].includes(instrument.id)) {
      assetClassAllocation.equity += instrument.allocationWeight * 100;
    } else assetClassAllocation.debt += instrument.allocationWeight * 100;
  }

  const recommendationState = await resolveCurrentRecommendationState({ userId: req.user.userId, profileId, profile });
  let recommendationMatchPct = null;
  if (recommendationState?.freshness?.fresh && recommendationState.currentAllocation?.instruments?.length) {
    const reference = {};
    for (const instrument of recommendationState.currentAllocation.instruments) {
      const key = resolveAssetKey(instrument.id);
      reference[key] = (reference[key] || 0) + Number(instrument.allocationWeight);
    }
    const allKeys = new Set([...Object.keys(reference), ...Object.keys(normalizedAllocations)]);
    const totalVariation = [...allKeys].reduce(
      (sum, key) => sum + Math.abs((reference[key] || 0) - (normalizedAllocations[key] || 0)),
      0,
    ) / 2;
    recommendationMatchPct = Math.max(0, Math.round((1 - totalVariation) * 100));
  }

  res.json({
    ...projection,
    simulation_classification: simulation.classification,
    portfolio_nominal_return_assumption: Number(portfolioNominalReturn.toFixed(2)),
    ...MODEL_ASSUMPTION_METADATA,
    portfolio_risk_score: Number(portfolioRiskScore.toFixed(2)),
    recommendation_match_pct: recommendationMatchPct,
    allocation_match_pct: recommendationMatchPct,
    risk_match_pct: Math.max(0, Math.round(100 - (Math.abs(portfolioRiskScore - suitability.finalLevel) * 25))),
    goal_horizon_match_pct: 100,
    affordability_match_pct: 100,
    liquidity_warning: safeWeight < 0.15,
    asset_class_allocation: Object.fromEntries(Object.entries(assetClassAllocation).map(([key, value]) => [key, Math.round(value)])),
    allocation_percentages: Object.fromEntries(Object.entries(normalizedAllocations).map(([key, weight]) => [key, Number((weight * 100).toFixed(4))])),
    monthly_instrument_allocations: Object.fromEntries(Object.keys(normalizedAllocations).map(key => [
      key,
      projection.instrument_monthly_allocations[key] ?? 0,
    ])),
    final_suitability_risk: suitability.finalRisk,
    suitability_reason_codes: suitability.reasonCodes,
  });
}));

router.post('/compare', verifyJWT, validateStrict(projectionComparisonSchema), asyncHandler(async (req, res) => {
  res.json({
    ...generateProjectionComparison(req.body),
    return_data_class: 'USER_INPUT',
    return_assumption_source: 'USER_SUPPLIED_WHAT_IF',
    observed_market_fact: false,
    provider_forecast: false,
  });
}));

router.post('/allocation-split', verifyJWT, validateStrict(allocationSplitSchema), asyncHandler(async (req, res) => {
  res.json(generateAllocationSplit(req.body));
}));

router.post('/step-up', verifyJWT, validateStrict(stepUpProjectionSchema), asyncHandler(async (req, res) => {
  const { monthlyInvestment, annualReturnRate, years, annualStepUpRate } = req.body;
  const chartData = [];
  let steppedInvested = 0;
  let currentMonthlyInvestment = monthlyInvestment;
  for (let year = 1; year <= years; year += 1) {
    steppedInvested += currentMonthlyInvestment * 12;
    chartData.push({
      year,
      flatSIP: Math.round(sipFV(monthlyInvestment, annualReturnRate, year)),
      stepUpSIP: Math.round(stepUpSipFV(monthlyInvestment, annualReturnRate, year, annualStepUpRate)),
      flatInvested: Math.round(monthlyInvestment * 12 * year),
      stepUpInvested: Math.round(steppedInvested),
    });
    currentMonthlyInvestment *= 1 + annualStepUpRate;
  }
  const last = chartData.at(-1);
  res.json({
    calculation_classification: 'NON_RECOMMENDATION_STEP_UP_CALCULATION',
    return_basis: 'PRE_TAX_NOMINAL',
    return_data_class: 'USER_INPUT',
    return_assumption_source: 'USER_SUPPLIED_WHAT_IF',
    observed_market_fact: false,
    provider_forecast: false,
    assumptions: { monthlyInvestment, annualReturnRate, years, annualStepUpRate },
    chartData,
    flatFinal: last.flatSIP,
    stepUpFinal: last.stepUpSIP,
    flatInvested: last.flatInvested,
    stepUpInvested: last.stepUpInvested,
    additionalCorpus: last.stepUpSIP - last.flatSIP,
    additionalPercent: last.flatSIP > 0 ? ((last.stepUpSIP - last.flatSIP) / last.flatSIP) * 100 : 0,
  });
}));

/**
 * POST /api/projection [Protected]
 * Generate wealth projections for multiple instruments over time.
 */
router.post('/', verifyJWT, validateStrict(personalizedProjectionSchema), asyncHandler(async (req, res) => {
  const { profileId, instruments, monthly_investment, years } = req.body;

  const { profile: stored } = await requireCurrentFinancialProfile({ userId: req.user.userId, profileId });
  if (!stored) {
    throw createError(404, `Profile not found: ${profileId}`, 'Profile not found.');
  }
  const profile = buildRecommendationProfile(stored);
  const projectionYears = years;
  if (projectionYears.some(year => year > profile.investmentHorizonYears)) {
    throw createError(400, 'Projection years cannot exceed the Financial Profile horizon.', 'Projection horizon exceeds profile.');
  }
  const simulation = buildProfileGroundedSimulation(profile, {
    monthlyInvestment: monthly_investment,
    years: Math.max(...projectionYears),
  });
  const suitability = assertPortfolioSuitable(profile, instruments);

  // Suitability is evaluated against the exact catalog identities above. Only
  // after that hard gate do we resolve those identities to versioned model-
  // assumption keys for projection math.
  const instKeys = instruments.map(resolveInstrumentModelKey);
  const instList = instKeys.map(key => {
    const nominalRate = getNominalRate(key);
    if (nominalRate === null) {
      throw createError(400, `Unknown instrument key: ${key}`, 'Unknown instrument.');
    }
    return { name: key, type: key, nominalRate };
  });

  const annualRates = {};
  instList.forEach(i => { annualRates[i.name] = i.nominalRate; });

  const projections = generateProjections(
    simulation.monthlyContribution,
    instList,
    annualRates,
    projectionYears,
    PROJECTION_INFLATION_ASSUMPTION,
    PERSONALIZED_CONTRIBUTION_STEP_UP,
    simulation.initialCapital,
  );

  res.json({
    ...projections,
    simulation_classification: simulation.classification,
    return_basis: 'PRE_TAX_NOMINAL',
    ...MODEL_ASSUMPTION_METADATA,
    initial_capital: simulation.initialCapital,
    monthly_contribution: simulation.monthlyContribution,
    final_suitability_risk: suitability.finalRisk,
    assumptions: {
      inflation_rate: PROJECTION_INFLATION_ASSUMPTION,
      contribution_step_up_rate: PERSONALIZED_CONTRIBUTION_STEP_UP,
      contribution_step_up_reason: 'No future savings growth is inferred from the Financial Profile.',
    },
  });
}));

/**
 * POST /api/projection/xirr [Protected]
 * Compute XIRR (Extended Internal Rate of Return) for irregular cashflows.
 * Uses Newton-Raphson iteration — the institutional standard for evaluating
 * SIP performance where each installment has a different holding period.
 *
 * Body: { cashflows: [{amount, date}], guess?: number }
 *   OR: { monthlySIP, months, currentValue }  (SIP convenience mode)
 */
router.post('/xirr', verifyJWT, validateStrict(historicalXirrSchema), asyncHandler(async (req, res) => {
  const { cashflows, monthlySIP, months, currentValue, guess } = req.body;

  // SIP convenience mode
  if (monthlySIP !== undefined) {
    const result = computeSIPXIRR(monthlySIP, months, currentValue);
    return res.json({
      mode: 'sip',
      ...result,
      calculation_classification: 'NON_RECOMMENDATION_HISTORICAL_RETURN_CALCULATION',
    });
  }

  const result = computeXIRR(cashflows, guess);
  res.json({
    mode: 'general',
    ...result,
    calculation_classification: 'NON_RECOMMENDATION_HISTORICAL_RETURN_CALCULATION',
  });
}));

export default router;
