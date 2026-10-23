import { Router } from 'express';
import { verifyJWT } from '../middleware/authMiddleware.js';
import { asyncHandler, createError } from '../middleware/errorHandler.js';
import { personalizedMonteCarloSchema, portfolioMonteCarloSchema, validateStrict } from '../validation/financialSchemas.js';
import { getInstrumentVolatility, MONTE_CARLO_MODEL_VERSION } from '../services/monteCarloEngine.js';
import { allocationCacheKey, monetaryTargetCacheKey } from '../services/monteCarloCacheIdentity.js';
import { executeMonteCarlo } from '../services/monteCarloExecutor.js';
import { getInstrumentModelAssumptions } from '../services/marketDataService.js';
import {
  buildRecommendationProfile,
  buildProfileGroundedSimulation,
  buildRecommendationProfileHash,
} from '../services/recommendationProfile.js';
import {
  assertPortfolioSuitable,
  resolveConcentrationCap,
  resolveInstrumentModelKey,
} from '../services/RecommendationPipeline.js';
import FinancialProfile from '../models/FinancialProfile.js';
import { getCache, setCache } from '../config/redis.js';
import {
  INSTRUMENT_PARAMS,
  PROJECTION_ASSUMPTION_DATA_CLASS,
  PROJECTION_ASSUMPTION_SOURCE,
  PROJECTION_ASSUMPTION_POLICY_HASH,
  PROJECTION_ASSUMPTION_VERSION,
} from '../services/instrumentConstants.js';
import { ASSET_KEYS, evaluatePortfolio } from '../services/portfolioEngine.js';
import { normalizeAllocationWeights } from '../utils/allocationWeights.js';
import { evaluateGbmScenarioAdmission } from '../services/marketScenarioPolicy.js';

const router = Router();
const MONTE_CARLO_INFLATION_ASSUMPTION = 0.05;
const MONTE_CARLO_SIMULATIONS = 10000;
const MONTE_CARLO_SCENARIO_SEED = 20261021; // public repeatable scenario seed

async function assertSimulationProfileCurrent({ userId, profileId, expectedHash, modelVersion }) {
  const latest = await FinancialProfile.findOne({ _id: profileId, userId }).lean();
  if (!latest) throw createError(409, 'SIMULATION_PROFILE_CHANGED',
    'The profile is no longer available; refresh financial state.');
  const currentHash = buildRecommendationProfileHash(
    buildRecommendationProfile(latest), { modelVersion });
  if (currentHash !== expectedHash) throw createError(409, 'SIMULATION_PROFILE_CHANGED',
    'Financial profile changed during simulation. Refresh and retry.');
}
async function executeForHttpClient(res, simulationInput) {
  const controller = new AbortController();
  const cancelOnDisconnect = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once('close', cancelOnDisconnect);
  try {
    return await executeMonteCarlo(simulationInput, { signal: controller.signal });
  } finally {
    res.off('close', cancelOnDisconnect);
  }
}

function buildMonteCarloResponse(result, context) {
  const chartData = result.years_array.map((year, index) => ({
    year,
    p10: result.p10[index], p25: result.p25[index], p50: result.p50[index],
    p75: result.p75[index], p90: result.p90[index], simulated_mean: result.mean[index],
    p10_real: result.p10_real?.[index], p50_real: result.p50_real?.[index],
    p90_real: result.p90_real?.[index], standard_error: result.standard_error?.[index],
  }));
  const terminalIndex = result.p50.length - 1;
  const interquartileSpreadRatio = terminalIndex >= 0 && result.p50[terminalIndex] > 0
    ? Number(((result.p75[terminalIndex] - result.p25[terminalIndex]) / result.p50[terminalIndex]).toFixed(3))
    : null;
  return {
    ...context,
    return_basis: 'PRE_TAX_NOMINAL',
    return_data_class: PROJECTION_ASSUMPTION_DATA_CLASS,
    return_assumption_version: PROJECTION_ASSUMPTION_VERSION,
    return_assumption_source: PROJECTION_ASSUMPTION_SOURCE,
    observed_market_fact: false,
    provider_forecast: false,
    chartData,
    goal_probability: result.goal_probability,
    target_amount: result.target_amount,
    simulations_run: result.simulations_run,
    standard_error_status: result.standard_error_status ?? 'NOT_ESTIMATED_DEPENDENT_SIMULATIONS',
    goal_probability_ci: result.goal_probability_ci ?? null,
    goal_probability_ci_status: result.goal_probability_ci_status ?? 'NOT_ESTIMATED_DEPENDENT_SIMULATIONS',
    variance_reduction: result.variance_reduction,
    model_version: result.model_version,
    seed_used: result.seed_used,
    is_reproducible: result.is_reproducible,
    terminal_wealth_cv: result.terminal_wealth_cv,
    percentile_summary: {
      p10: result.p10[terminalIndex], p25: result.p25[terminalIndex], p50: result.p50[terminalIndex],
      p75: result.p75[terminalIndex], p90: result.p90[terminalIndex],
    },
    percentile_labels: {
      p10: 'Simulated 10th percentile', p25: 'Simulated 25th percentile',
      p50: 'Simulated median', p75: 'Simulated 75th percentile', p90: 'Simulated 90th percentile',
    },
    percentile_summary_real: result.p50_real ? {
      p10: result.p10_real[terminalIndex], p25: result.p25_real[terminalIndex],
      p50: result.p50_real[terminalIndex], p75: result.p75_real[terminalIndex],
      p90: result.p90_real[terminalIndex],
    } : null,
    confidence_interval_width: null, // Retired: IQR ratio is not a confidence interval.
    interquartile_spread_ratio: interquartileSpreadRatio,
    sequence_of_returns_risk: null,
    sharpe_ratio_sensitivity: result.sharpe_ratio_sensitivity || null,
    inflation_rate: result.inflation_rate,
    ...simulationProvenance(result),
  };
}

function simulationProvenance(result) {
  return {
    simulation_model: 'GBM_LOGNORMAL',
    scenario_classification: 'MODEL_POLICY_ILLUSTRATIVE_SCENARIO',
    calibration_mode: 'MODEL_POLICY',
    empirical_calibration: null,
    asset_specific_cashflows_calculated: false,
    portfolio_aggregation: 'MOMENT_MATCHED_GBM_APPROXIMATION_NOT_ASSET_PATHS',
    post_tax_simulation_available: false,
    post_tax_return_percent: null,
    post_tax_future_value_inr: null,
    post_tax_status: 'UNAVAILABLE_EXACT_PRODUCT_AND_TAX_FACTS_REQUIRED',
    accuracy_certification: 'NOT_VERIFIED',
    covariance_provenance: 'WEALTHGENIE_MODEL_POLICY_STATIC_CORRELATION',
    inflation_assumption_source: 'WEALTHGENIE_MODEL_POLICY',
    real_value_method: 'DEFLATED_SAME_NOMINAL_PATH',
    control_variate_method: result.control_variate_method ?? 'none',
    dispersion_cv: result.dispersion_cv ?? null,
    tax_basis: 'PRE_TAX',
    monthly_rate_convention: 'EFFECTIVE_ANNUAL_EQUIVALENT',
    model_limitations: [
      'Returns and volatility are versioned model-policy assumptions, not observed or forecast market facts.',
      'Probabilities are conditional on model assumptions and are not guaranteed outcomes.',
      'Fees, taxes, corporate actions and regime changes are not modeled.',
      'FD, RD, government-scheme and bond product-specific cashflows are NOT modeled by this GBM policy scenario.',
      'Aggregated portfolio GBM is not a multi-asset correlated return-path engine.',
      'Monte Carlo uses an effective annual rate converted to monthly. The separate nominal-APR SIP calculator divides APR by twelve; their outputs are not interchangeable.',
    ],
  };
}

function validatePortfolioConcentration(allocations) {
  const grouped = new Map();
  for (const [key, weight] of Object.entries(allocations)) {
    const cap = resolveConcentrationCap({ id: key, type: key, name: key });
    if (cap) grouped.set(cap.key, { cap, total: (grouped.get(cap.key)?.total || 0) + (weight * 100) });
  }
  for (const { cap, total } of grouped.values()) {
    if (total > cap.maxPct + 0.0001) {
      throw createError(400, `${cap.key} allocation exceeds ${cap.maxPct}%`, 'Allocation exceeds suitability limits.');
    }
  }
}

router.post('/portfolio', verifyJWT, validateStrict(portfolioMonteCarloSchema), asyncHandler(async (req, res) => {
  const { profileId, allocations, years, target_amount } = req.body;
  const stored = await FinancialProfile.findOne({ _id: profileId, userId: req.user.userId }).lean();
  if (!stored) throw createError(404, 'Profile not found or access denied', 'Profile not found.');
  const profile = buildRecommendationProfile(stored);
  const allocationEntries = Object.entries(allocations);
  const normalizedWeights = normalizeAllocationWeights(allocationEntries.map(([, weight]) => weight));
  const normalizedAllocations = Object.fromEntries(allocationEntries.map(([key], index) => [key, normalizedWeights[index]]));
  const keys = Object.keys(normalizedAllocations).filter(key => normalizedAllocations[key] > 0);
  if (keys.some(key => !INSTRUMENT_PARAMS[key])) {
    throw createError(400, 'Allocation contains an unknown instrument.', 'Unknown instrument.');
  }
  if (keys.some(key => !ASSET_KEYS.includes(key))) {
    throw createError(422, 'Portfolio covariance is unavailable for one or more instruments.', 'Portfolio simulation is unavailable for this mix.');
  }
  const gbmAdmission = evaluateGbmScenarioAdmission(keys);
  if (!gbmAdmission.admitted) {
    throw createError(422, gbmAdmission.reasonCode,
      'Contractual products require verified cashflow simulations; market-price GBM is not applicable.');
  }
  const suitability = assertPortfolioSuitable(profile, keys);
  validatePortfolioConcentration(normalizedAllocations);
  const simulation = buildProfileGroundedSimulation(profile, {
    monthlyInvestment: profile.monthlySavings,
    years,
  });
  const nominalReturns = keys.map(key => INSTRUMENT_PARAMS[key].nominalRate / 100);
  const weights = Object.fromEntries(keys.map(key => [key, normalizedAllocations[key]]));
  const metrics = evaluatePortfolio(keys, nominalReturns, weights);
  const profileHash = buildRecommendationProfileHash(profile, { modelVersion: `portfolio-${MONTE_CARLO_MODEL_VERSION}` });
  const allocationKey = allocationCacheKey(normalizedAllocations);
  const targetKey = monetaryTargetCacheKey(target_amount);
  const cacheKey = [
    'portfolio-mc-v6', MONTE_CARLO_MODEL_VERSION, PROJECTION_ASSUMPTION_POLICY_HASH,
    MONTE_CARLO_SCENARIO_SEED, MONTE_CARLO_INFLATION_ASSUMPTION, MONTE_CARLO_SIMULATIONS, req.user.userId, profileId, profileHash, years,
    simulation.monthlyContribution, simulation.initialCapital, targetKey,
    allocationKey, metrics.expectedReturn, metrics.volatility,
  ].join(':');
  const cached = await getCache(cacheKey);
  if (cached) {
    await assertSimulationProfileCurrent({ userId: req.user.userId,
      profileId, expectedHash: profileHash, modelVersion: `portfolio-${MONTE_CARLO_MODEL_VERSION}` });
    return res.json({ ...cached, cached: true });
  }

  const result = await executeForHttpClient(res, {
    monthlyInvestment: simulation.monthlyContribution,
    annualExpectedReturn: metrics.expectedReturn,
    annualVolatility: metrics.volatility,
    years: simulation.years,
    simulations: MONTE_CARLO_SIMULATIONS,
    inflationRate: MONTE_CARLO_INFLATION_ASSUMPTION,
    targetAmount: target_amount ?? null,
    currentSavings: simulation.initialCapital,
    seed: MONTE_CARLO_SCENARIO_SEED,
  });
  await assertSimulationProfileCurrent({ userId: req.user.userId,
    profileId, expectedHash: profileHash, modelVersion: `portfolio-${MONTE_CARLO_MODEL_VERSION}` });
  const response = buildMonteCarloResponse(result, {
    simulation_classification: simulation.classification,
    years: simulation.years,
    monthly_investment: simulation.monthlyContribution,
    initial_capital: simulation.initialCapital,
    allocations: normalizedAllocations,
    portfolio_return_assumption: metrics.expectedReturn,
    portfolio_volatility: metrics.volatility,
    portfolio_sharpe_ratio: metrics.sharpe,
    data_source: PROJECTION_ASSUMPTION_SOURCE,
    assumptions: {
      inflation_rate: MONTE_CARLO_INFLATION_ASSUMPTION,
      simulations: MONTE_CARLO_SIMULATIONS,
      initial_capital_source: 'declared_lump_sum_only',
    },
    final_suitability_risk: suitability.finalRisk,
    suitability_reason_codes: suitability.reasonCodes,
    cached: false,
  });
  await setCache(cacheKey, response, 1800);
  return res.json(response);
}));

router.post('/montecarlo', verifyJWT, validateStrict(personalizedMonteCarloSchema), asyncHandler(async (req, res) => {
  const { instrument, monthly_investment, years, target_amount, profileId } = req.body;
  const stored = await FinancialProfile.findOne({ _id: profileId, userId: req.user.userId }).lean();
  if (!stored) throw createError(404, 'Profile not found or access denied', 'Profile not found.');
  const profile = buildRecommendationProfile(stored);
  const simulation = buildProfileGroundedSimulation(profile, {
    monthlyInvestment: monthly_investment,
    years,
  });
  const suitability = assertPortfolioSuitable(profile, [instrument]);
  const instrumentKey = resolveInstrumentModelKey(instrument);
  const gbmAdmission = evaluateGbmScenarioAdmission([instrumentKey]);
  if (!gbmAdmission.admitted) {
    throw createError(422, gbmAdmission.reasonCode,
      'Contractual products require verified cashflow simulations; market-price GBM is not applicable.');
  }
  const assumptionResult = await getInstrumentModelAssumptions();
  const modelParams = assumptionResult.params[instrumentKey] || getInstrumentVolatility(instrumentKey);
  if (!modelParams || !Number.isFinite(modelParams.mean) || !Number.isFinite(modelParams.stdDev)) {
    throw createError(422, `No simulation parameters for ${instrument}`, 'Simulation data is unavailable for this instrument.');
  }
  const annualReturn = modelParams.mean;
  const annualVolatility = modelParams.stdDev;
  const profileHash = buildRecommendationProfileHash(profile, { modelVersion: MONTE_CARLO_MODEL_VERSION });
  const targetKey = monetaryTargetCacheKey(target_amount);
  const cacheKey = [
    'mc-v7', MONTE_CARLO_MODEL_VERSION, PROJECTION_ASSUMPTION_POLICY_HASH,
    MONTE_CARLO_SCENARIO_SEED, req.user.userId, profileId, profileHash, instrumentKey, years,
    simulation.monthlyContribution, simulation.initialCapital, targetKey,
    annualReturn.toFixed(6), annualVolatility.toFixed(6),
    MONTE_CARLO_INFLATION_ASSUMPTION, MONTE_CARLO_SIMULATIONS,
  ].join(':');
  const cached = await getCache(cacheKey);
  if (cached) {
    await assertSimulationProfileCurrent({ userId: req.user.userId,
      profileId, expectedHash: profileHash, modelVersion: MONTE_CARLO_MODEL_VERSION });
    return res.json({ ...cached, cached: true });
  }

  const result = await executeForHttpClient(res, {
    monthlyInvestment: simulation.monthlyContribution,
    annualExpectedReturn: annualReturn,
    annualVolatility,
    years: simulation.years,
    simulations: MONTE_CARLO_SIMULATIONS,
    inflationRate: MONTE_CARLO_INFLATION_ASSUMPTION,
    targetAmount: target_amount ?? null,
    currentSavings: simulation.initialCapital,
    seed: MONTE_CARLO_SCENARIO_SEED,
  });
  await assertSimulationProfileCurrent({ userId: req.user.userId,
    profileId, expectedHash: profileHash, modelVersion: MONTE_CARLO_MODEL_VERSION });
  const chartData = result.years_array.map((year, index) => ({
    year,
    p10: result.p10[index], p25: result.p25[index], p50: result.p50[index],
    p75: result.p75[index], p90: result.p90[index], simulated_mean: result.mean[index],
    p10_real: result.p10_real?.[index], p50_real: result.p50_real?.[index],
    p90_real: result.p90_real?.[index], standard_error: result.standard_error?.[index],
  }));
  const terminalIndex = result.p50.length - 1;
  const interquartileSpreadRatio = terminalIndex >= 0 && result.p50[terminalIndex] > 0
    ? Number(((result.p75[terminalIndex] - result.p25[terminalIndex]) / result.p50[terminalIndex]).toFixed(3))
    : null;
  const response = {
    instrument,
    model_assumption_instrument_key: instrumentKey,
    years: simulation.years,
    monthly_investment: simulation.monthlyContribution,
    initial_capital: simulation.initialCapital,
    simulation_classification: simulation.classification,
    return_basis: 'PRE_TAX_NOMINAL',
    return_data_class: PROJECTION_ASSUMPTION_DATA_CLASS,
    return_assumption_version: PROJECTION_ASSUMPTION_VERSION,
    return_assumption_source: PROJECTION_ASSUMPTION_SOURCE,
    observed_market_fact: false,
    provider_forecast: false,
    chartData,
    goal_probability: result.goal_probability,
    target_amount: result.target_amount,
    simulations_run: result.simulations_run,
    standard_error_status: result.standard_error_status ?? 'NOT_ESTIMATED_DEPENDENT_SIMULATIONS',
    goal_probability_ci: result.goal_probability_ci ?? null,
    goal_probability_ci_status: result.goal_probability_ci_status ?? 'NOT_ESTIMATED_DEPENDENT_SIMULATIONS',
    variance_reduction: result.variance_reduction,
    model_version: result.model_version,
    seed_used: result.seed_used,
    is_reproducible: result.is_reproducible,
    terminal_wealth_cv: result.terminal_wealth_cv,
    percentile_summary: {
      p10: result.p10[terminalIndex], p25: result.p25[terminalIndex], p50: result.p50[terminalIndex],
      p75: result.p75[terminalIndex], p90: result.p90[terminalIndex],
    },
    percentile_labels: {
      p10: 'Simulated 10th percentile', p25: 'Simulated 25th percentile',
      p50: 'Simulated median', p75: 'Simulated 75th percentile', p90: 'Simulated 90th percentile',
    },
    percentile_summary_real: result.p50_real ? {
      p10: result.p10_real[terminalIndex], p25: result.p25_real[terminalIndex],
      p50: result.p50_real[terminalIndex], p75: result.p75_real[terminalIndex],
      p90: result.p90_real[terminalIndex],
    } : null,
    confidence_interval_width: null, // Retired: IQR ratio is not a confidence interval.
    interquartile_spread_ratio: interquartileSpreadRatio,
    data_source: PROJECTION_ASSUMPTION_SOURCE,
    nominal_return_assumption_used: annualReturn,
    volatility_used: annualVolatility,
    sequence_of_returns_risk: null,
    sharpe_ratio_sensitivity: result.sharpe_ratio_sensitivity || null,
    inflation_rate: result.inflation_rate,
    assumptions: {
      inflation_rate: MONTE_CARLO_INFLATION_ASSUMPTION,
      simulations: MONTE_CARLO_SIMULATIONS,
      initial_capital_source: 'declared_lump_sum_only',
    },
    final_suitability_risk: suitability.finalRisk,
    suitability_reason_codes: suitability.reasonCodes,
    ...simulationProvenance(result),
    cached: false,
  };
  await setCache(cacheKey, response, 1800);
  return res.json(response);
}));

export default router;
