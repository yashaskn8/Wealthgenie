import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import axios from 'axios';
import FinancialProfile from '../models/FinancialProfile.js';
import FinancialProfileState from '../models/FinancialProfileState.js';
import { generateAdvisory, getGoalAdvisory } from '../services/geminiService.js';
import { processChat } from '../services/geminiChatService.js';
import { buildGroundedEvidencePacket } from '../services/groundedEvidence.js';
import { buildChatEvidencePacket } from '../services/groundedExplanationService.js';
import {
  INSTRUMENT_PARAMS,
  PROJECTION_ASSUMPTION_DATA_CLASS,
  PROJECTION_ASSUMPTION_VERSION,
  buildRateLookup,
  getNominalRate,
  getVolatility,
  toMonthlyRate,
} from '../services/instrumentConstants.js';
import { fetchIndexStatistics, fetchMutualFundNAVs, checkFDRateStaleness, resolvePrimaryMarketProvider } from '../services/marketDataService.js';
import { checkMLHealth, getMLPrediction, getRuleBasedFallback } from '../services/mlClient.js';
import { queryRAG } from '../services/ragClient.js';
import { computeCAGR, generateAllocationSplit, generatePortfolioProjection, generateProjectionComparison, generateProjections, lumpSumFV, realReturn, reverseSIPFromFV, sipFV, stepUpSipFV } from '../services/projectionEngine.js';
import { normalizeAllocationWeights } from '../utils/allocationWeights.js';
import { calculatePostTaxReturn, calculatePostTaxReturnSafe } from '../services/postTaxCalculator.js';
import { assessSuitabilityRisk, encodeRiskCategory, getRiskProfile } from '../services/riskProfiler.js';
import { buildLlmFinancialContext, buildMlProfileInput } from '../services/recommendationProfile.js';
import { canonicalProfile } from './helpers/canonicalProfile.js';

process.env.JWT_SECRET = 'service-coverage-test-secret';
process.env.NODE_ENV = 'test';

function mlInput(overrides = {}) {
  const profile = canonicalProfile(overrides);
  return buildMlProfileInput(profile, assessSuitabilityRisk(profile));
}

function llmProfile(overrides = {}) {
  const profile = canonicalProfile(overrides);
  return buildLlmFinancialContext(profile, assessSuitabilityRisk(profile));
}

test('geminiService uses the shared grounded provider contract', async (t) => {
  const originalPost = axios.post;
  const originalGemini = process.env.GEMINI_API_KEY;
  const originalGroq = process.env.GROQ_API_KEY;
  const originalNvidia = process.env.NVIDIA_API_KEY;
  const originalPrimary = process.env.LLM_PRIMARY_PROVIDER;
  const calls = [];
  const providerInputs = [];

  process.env.GEMINI_API_KEY = 'gemini-test-key';
  process.env.GROQ_API_KEY = 'groq-test-key';
  process.env.NVIDIA_API_KEY = '';
  process.env.LLM_PRIMARY_PROVIDER = 'GEMINI';
  const groundedJson = JSON.stringify({
    text: 'The final suitability ceiling is Moderate [E_PROFILE_RISK].',
    evidenceIdsUsed: ['E_PROFILE_RISK'],
    claims: [{ text: 'The final suitability ceiling is Moderate [E_PROFILE_RISK].', evidenceIds: ['E_PROFILE_RISK'] }],
    financialClaims: [],
    unavailableFacts: [],
  });
  axios.post = async (url, requestBody) => {
    calls.push(url);
    providerInputs.push(JSON.stringify(requestBody));
    return { data: { modelVersion: 'gemini-3.6-flash', candidates: [{ content: { parts: [{ text: groundedJson }] }, finishReason: 'STOP' }] } };
  };
  t.after(() => {
    axios.post = originalPost;
    if (originalGemini === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalGemini;
    if (originalGroq === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = originalGroq;
    if (originalNvidia === undefined) delete process.env.NVIDIA_API_KEY; else process.env.NVIDIA_API_KEY = originalNvidia;
    if (originalPrimary === undefined) delete process.env.LLM_PRIMARY_PROVIDER; else process.env.LLM_PRIMARY_PROVIDER = originalPrimary;
  });

  const advisory = await generateAdvisory({
    profile: llmProfile({ age: 32, monthlySavings: 20000 }),
    instruments: [], modelVersion: 'test-model-4.0.0', policyVersion: 'suitability-freeze-1.0.0',
    shapExplanation: {
      top_reason: 'Your savings rate increased the likelihood of this allocation.',
      feature_contributions: [{ feature: 'monthly_take_home', raw_value: 987654, shap_value: 0.42 }],
    },
  });
  const goalAdvice = await getGoalAdvisory('Suggest one adjustment for me based on my risk profile.', llmProfile({ age: 32, monthlySavings: 20000 }));
  const privateGoalAdvice = await getGoalAdvisory('CUSTOM_GOAL_PRIVATE_SENTINEL target ₹9876543 over 19 years with SIP 45678', llmProfile({ age: 32, monthlySavings: 20000 }), {
    goalName: 'CUSTOM_GOAL_PRIVATE_SENTINEL',
    targetAmount: 9876543,
    yearsRemaining: 19,
    recommendedSip: 45678,
    monthlySavingsCapacity: 12345,
    status: 'at_risk',
  });

  assert.match(advisory.text, /Moderate \[E_PROFILE_RISK\]/);
  assert.equal(advisory.provider, 'GEMINI');
  assert.equal(advisory.model, 'gemini-3.6-flash');
  assert.match(goalAdvice, /Moderate \[E_PROFILE_RISK\]/);
  assert.equal(typeof privateGoalAdvice, 'string');
  assert.ok(privateGoalAdvice.length > 0);
  assert.ok(calls[0].includes('generativelanguage.googleapis.com'));
  assert.ok(calls[1].includes('generativelanguage.googleapis.com'));
  assert.match(providerInputs[0], /Your savings rate increased the likelihood/);
  assert.doesNotMatch(providerInputs[0], /987654|feature_contributions|raw_value|shap_value/);
  assert.match(providerInputs[2], /E_GOAL_PLAN/);
  assert.match(providerInputs[2], /contributionWithinSavingsCapacity/);
  const goalPacketText = JSON.parse(providerInputs[2]).contents[0].parts[0].text;
  const goalPacket = JSON.parse(goalPacketText).EVIDENCE_PACKET;
  const goalPlanEntry = goalPacket.entries.find(entry => entry.id === 'E_GOAL_PLAN');
  assert.deepEqual(Object.keys(goalPlanEntry.value).sort(), ['contributionWithinSavingsCapacity', 'status']);
  assert.deepEqual(goalPlanEntry.value, { status: 'at_risk', contributionWithinSavingsCapacity: false });
  assert.deepEqual(goalPacket.privacy.sentProfileFields, []);
  assert.doesNotMatch(providerInputs[2], /CUSTOM_GOAL_PRIVATE_SENTINEL|9876543|45678|12345|19 years|monthlySavingsCapacity|raw_value/);
});

test('geminiChatService returns profile setup guidance when no profile exists', async (t) => {
  const originalFindOne = FinancialProfile.findOne;
  const originalStateFindOne = FinancialProfileState.findOne;
  FinancialProfile.findOne = () => ({ sort: () => ({ lean: async () => null }) });
  FinancialProfileState.findOne = () => ({ lean: async () => ({
    currentProfileId: null,
    revision: 0,
    promotionFence: 0,
    resolutionStatus: 'NO_CURRENT',
  }) });
  t.after(() => {
    FinancialProfile.findOne = originalFindOne;
    FinancialProfileState.findOne = originalStateFindOne;
  });

  const result = await processChat({
    userId: new mongoose.Types.ObjectId().toString(),
    user: { email: 'user@example.com' },
    message: 'What should I invest in?',
    sessionId: 'session-1',
  });

  assert.equal(result.grounded, false);
  assert.match(result.response, /financial profile/i);
});

test('grounded evidence minimizes external profile data and excludes identity', () => {
  const packet = buildGroundedEvidencePacket({
    question: 'Why this recommendation?',
    profile: llmProfile({ age: 35, monthlySavings: 25000, investmentHorizonYears: 15 }),
    recommendation: { modelVersion: 'test', profileInputHash: 'hash', instruments: [] },
  });
  assert.ok(packet.entries.some(item => item.id === 'E_PROFILE_RISK'));
  assert.deepEqual([...packet.privacy.sentProfileFields].sort(), ['riskTolerance', 'suitabilityReasonCodes', 'suitabilityRisk'].sort());
  assert.equal(packet.entries.some(item => item.id === 'E_PROFILE_AGE'), false);
  assert.equal(packet.entries.some(item => item.id === 'E_PROFILE_SAVINGS'), false);
  assert.equal(packet.entries.some(item => item.id === 'E_PROFILE_GOALS'), false);
  assert.ok(packet.entries.some(item => item.id === 'E_REGULATORY_NOTICE'));
  assert.equal(JSON.stringify(packet).includes('p@example.com'), false);
  assert.ok(packet.privacy.excludedFields.includes('email'));
});

test('general financial education does not send personal profile or recommendation evidence externally', () => {
  const packet = buildGroundedEvidencePacket({
    question: 'What is NAV?',
    profile: llmProfile({ age: 35, monthlySavings: 25000 }),
    recommendation: {
      modelVersion: 'test',
      instruments: [{ id: 'private-fund', name: 'Private Fund', allocation_pct: 100 }],
    },
  });

  assert.deepEqual(packet.privacy.sentProfileFields, []);
  assert.equal(packet.entries.some(item => item.kind === 'PROFILE' || item.kind === 'SUITABILITY'), false);
  assert.equal(packet.entries.some(item => item.kind === 'RECOMMENDATION'), false);
});

test('generic recommendation and portfolio education does not attach the saved profile or plan', () => {
  for (const question of ['What is a recommendation?', 'How does portfolio rebalancing work?']) {
    const packet = buildGroundedEvidencePacket({
      question,
      profile: llmProfile(),
      recommendation: {
        modelVersion: 'test',
        instruments: [{ id: 'private-fund', name: 'Private Fund', allocation_pct: 100 }],
      },
    });

    assert.deepEqual(packet.privacy.sentProfileFields, [], question);
    assert.equal(packet.entries.some(item => item.kind === 'RECOMMENDATION'), false, question);
  }
});

test('generic expected-return education cannot attach saved recommendation instruments', async () => {
  const recommendation = {
    modelVersion: 'test',
    instruments: [{ id: 'PRIVATE_USER_INSTRUMENT_82', type: 'FD', allocation_pct: 100 }],
  };
  const dependencies = {
    getInstrumentModelAssumptions: async () => ({
      params: {
        FD: { mean: 0.075, stdDev: 0.005, assumptionVersion: 'fixture-v1', source: 'WEALTHGENIE_MODEL_POLICY' },
      },
    }),
  };

  const generic = await buildChatEvidencePacket({
    question: 'What is expected return?',
    profile: llmProfile({ age: 35, monthlySavings: 25000 }),
    recommendation,
  }, dependencies);
  const genericSerialized = JSON.stringify(generic);
  assert.deepEqual(generic.privacy.sentProfileFields, []);
  assert.equal(generic.entries.some(item => item.kind === 'RECOMMENDATION' || item.kind === 'PROJECTION'), false);
  assert.doesNotMatch(genericSerialized, /PRIVATE_USER_INSTRUMENT_82/);

  const personalized = await buildChatEvidencePacket({
    question: 'What is expected return for my portfolio?',
    profile: llmProfile({ age: 35, monthlySavings: 25000 }),
    recommendation,
  }, dependencies);
  assert.ok(personalized.entries.some(item => item.kind === 'RECOMMENDATION'));
  assert.ok(personalized.entries.some(item => item.kind === 'PROJECTION' && item.value.instrumentId === 'PRIVATE_USER_INSTRUMENT_82'));
});

test('instrumentConstants exposes immutable, versioned model assumptions', () => {
  assert.equal(getNominalRate('FD'), 7.5);
  assert.equal(getVolatility('FD'), 0.005);
  assert.equal(getNominalRate('UNKNOWN'), null);
  assert.equal(getVolatility('UNKNOWN'), null);
  assert.equal(toMonthlyRate(0.12), 0.01);
  assert.ok(toMonthlyRate(0.12, true) > 0.009);
  assert.throws(() => { INSTRUMENT_PARAMS.FD = {}; }, /read only|immutable/i);

  assert.equal(INSTRUMENT_PARAMS.FD.dataClass, PROJECTION_ASSUMPTION_DATA_CLASS);
  assert.equal(INSTRUMENT_PARAMS.FD.assumptionVersion, PROJECTION_ASSUMPTION_VERSION);
  assert.equal(INSTRUMENT_PARAMS.FD.observedMarketFact, false);
  assert.equal(INSTRUMENT_PARAMS.FD.providerForecast, false);
  assert.equal(buildRateLookup().FD, 7.5);
});

test('marketDataService blocks unqualified AMFI and NSE source rights before outbound requests', async (t) => {
  const originalGet = axios.get;
  let sourceCalls = 0;
  axios.get = async (url) => {
    sourceCalls += 1;
    if (url.includes('NAVAll.txt')) {
      return { data: 'Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date\n123;INF000A01010;;Example Fund;Direct;Growth;12.34;01-Jan-2026\n' };
    }
    if (url.includes('/api/holiday-master')) return { data: { CM: [] } };
    if (url.includes('/api/allIndices')) {
      return { data: {
        timestamp: '08-Sep-2026 15:30',
        data: [
          { index: 'NIFTY 50', last: 25000, previousClose: 24900, open: 24950, high: 25100, low: 24850 },
          { index: 'INDIA VIX', last: 14, previousClose: 13.5, open: 13.5, high: 14.2, low: 13.4 },
        ],
      } };
    }
    throw new Error(`Unexpected network request: ${url}`);
  };
  t.after(() => { axios.get = originalGet; });

  const navs = await fetchMutualFundNAVs();
  const stats = await fetchIndexStatistics('^NSEI');

  assert.equal(navs.status, 'UNAVAILABLE');
  assert.equal(navs.error.code, 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
  assert.equal(stats.symbol, '^NSEI');
  assert.equal(resolvePrimaryMarketProvider({}), 'NSE');
  assert.equal(resolvePrimaryMarketProvider({ MARKET_DATA_PRIMARY_PROVIDER: 'upstox' }), 'UPSTOX');
  assert.throws(() => resolvePrimaryMarketProvider({ MARKET_DATA_PRIMARY_PROVIDER: 'unknown' }), /must be one of/);
  assert.equal(stats.status, 'UNAVAILABLE');
  assert.equal(stats.latest_price, null);
  assert.equal(stats.data_source, null);
  assert.equal(stats.annualised_return, null);
  assert.equal(stats.annualised_volatility, null);
  assert.equal(sourceCalls, 0);
});

test('marketDataService FD staleness handles stale counts and model failures', async () => {
  const stale = await checkFDRateStaleness({ countDocuments: async () => 2 });
  const safe = await checkFDRateStaleness({ countDocuments: async () => { throw new Error('db down'); } });

  assert.equal(stale.needs_refresh, true);
  assert.equal(stale.stale_count, 2);
  assert.equal(safe.needs_refresh, false);
});

test('mlClient posts to enriched endpoint and falls back on service failure', async (t) => {
  const originalPost = axios.post;
  const originalGet = axios.get;
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  let postedUrl = '';
  let postedHeaders = null;
  let getHeaders = null;

  axios.post = async (url, payload, config) => {
    postedUrl = url;
    postedHeaders = config?.headers;
    assert.equal(payload.age, 40);
    assert.equal(payload.liquid_savings, 50000);
    return { data: {
      primary: 'ETF', secondary: 'Debt_MF', tertiary: 'ELSS',
      confidence_scores: { Equity_MF: 0.05, ELSS: 0.05, ETF: 0.7, Debt_MF: 0.1, FD: 0.05, RBI_Bond: 0.05 }, decision_path: ['risk = Moderate'],
      model_version: '4.0.0', dataset_version: '4.0.0', feature_schema_version: 'recommendation-features-4.0.0', explanation: null,
    } };
  };
  axios.get = async (url, config) => {
    getHeaders = config?.headers;
    return { data: { status: 'ok' } };
  };
  t.after(() => { axios.post = originalPost; axios.get = originalGet; console.warn = originalWarn; });

  const prediction = await getMLPrediction(mlInput({
    age: 40, monthlySavings: 25000, liquidSavings: 50000, emergencyFundMonths: 3,
  }));
  const health = await checkMLHealth();

  await assert.rejects(
    getMLPrediction({ age: 40, monthly_savings: 25000 }),
    /recommendation-features-4\.0\.0/,
  );

  axios.post = async () => { throw Object.assign(new Error('offline'), { code: 'ECONNRESET' }); };
  const fallback = await getMLPrediction(mlInput({
    age: 60, monthlyTakeHome: 200000, monthlySavings: 50000,
    liquidSavings: 100000, riskTolerance: 'Conservative', investmentGoals: ['Retirement'],
  }));

  assert.match(postedUrl, /\/predict\/enriched$/);
  // When ML_SERVICE_API_KEY is set, the header must carry its value.
  // When unset, mlClient intentionally omits the header (security: no empty key).
  const expectedKey = process.env.ML_SERVICE_API_KEY || undefined;
  assert.equal(postedHeaders?.['X-API-Key'], expectedKey);
  assert.equal(getHeaders?.['X-API-Key'], expectedKey);
  assert.equal(prediction.primary, 'ETF');
  assert.equal(health.status, 'ok');
  assert.equal(fallback.fallback, true);
  assert.ok(warnings.some(w => w.includes('fallback')));
});

test('mlClient rule fallback produces suitable picks from the v4 feature contract', () => {
  const fallback = getRuleBasedFallback(mlInput({
    age: 35, monthlyTakeHome: 200000, monthlySavings: 50000,
    riskTolerance: 'Aggressive', investmentHorizonYears: 20,
  }));

  assert.equal(fallback.primary, 'Index_MF');
  assert.equal(fallback.secondary, 'Hybrid_MF');
  assert.equal(fallback.fallback, true);
  assert.ok(Object.values(fallback.confidence_scores).every(Number.isFinite));
  assert.deepEqual(Object.keys(fallback.confidence_scores).sort(), [fallback.primary, fallback.secondary, fallback.tertiary].sort());
  assert.equal(fallback.confidence_scores.FD, undefined, 'unselected instruments must not receive invented fallback confidence');
});

test('mlClient reads the ML URL and API key at request time', async (t) => {
  const originalPost = axios.post;
  const originalUrl = process.env.ML_SERVICE_URL;
  const originalKey = process.env.ML_SERVICE_API_KEY;
  const calls = [];
  axios.post = async (url, _payload, config) => {
    calls.push({ url, headers: config.headers });
    return { data: {
      primary: 'ETF', secondary: 'Debt_MF', tertiary: 'ELSS',
      confidence_scores: { Equity_MF: 0.05, ELSS: 0.05, ETF: 0.7, Debt_MF: 0.1, FD: 0.05, RBI_Bond: 0.05 }, decision_path: ['risk = Moderate'],
      model_version: '4.0.0', dataset_version: '4.0.0', feature_schema_version: 'recommendation-features-4.0.0', explanation: null,
    } };
  };
  t.after(() => {
    axios.post = originalPost;
    if (originalUrl === undefined) delete process.env.ML_SERVICE_URL; else process.env.ML_SERVICE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.ML_SERVICE_API_KEY; else process.env.ML_SERVICE_API_KEY = originalKey;
  });

  const profile = mlInput({ age: 40, monthlySavings: 25000, emergencyFundMonths: 3 });

  process.env.ML_SERVICE_URL = 'http://ml-one:8000/';
  process.env.ML_SERVICE_API_KEY = 'first-key';
  await getMLPrediction(profile);
  process.env.ML_SERVICE_URL = 'http://ml-two:9000';
  process.env.ML_SERVICE_API_KEY = 'second-key';
  await getMLPrediction(profile);

  assert.deepEqual(calls.map(call => call.url), [
    'http://ml-one:8000/predict/enriched',
    'http://ml-two:9000/predict/enriched',
  ]);
  assert.deepEqual(calls.map(call => call.headers['X-API-Key']), ['first-key', 'second-key']);
});

test('projectionEngine formulas are numerically stable and internally consistent', () => {
  const target = 1000000;
  const sip = reverseSIPFromFV(target, 0.10, 10);
  const fv = sipFV(sip, 0.10, 10);
  const lump = lumpSumFV(100000, 0.10, 5);
  const stepUp = stepUpSipFV(10000, 0.10, 5, 0.10);
  const projections = generateProjections(
    10000, [{ name: 'ETF', type: 'ETF' }], { ETF: 10 }, [5, 10], 0.05, 0.10, 0,
  );

  assert.ok(Math.abs(fv - target) / target < 0.001);
  assert.ok(lump > 100000);
  assert.ok(stepUp > sipFV(10000, 0.10, 5));
  assert.ok(computeCAGR(100000, lump, 5) > 0.09);
  assert.ok(realReturn(0.12, 0.06) > 0.05);
  assert.equal(projections.chartData.length, 2);

  const comparison = generateProjectionComparison({
    monthlyInvestment: 10000,
    annualReturnRate: 0.12,
    benchmarkRate: 0.03,
    inflationRate: 0.06,
    years: 10,
  });
  assert.equal(comparison.yearlyBreakdown.length, 10);
  assert.equal(comparison.normalizedChart.length, 10);
  assert.equal(comparison.totalInvested, 1_200_000);
  assert.ok(comparison.investmentMaturity > comparison.benchmarkMaturity);
  assert.ok(comparison.investmentReal > comparison.benchmarkReal);
  assert.equal(comparison.assumptions.inflationRate, 0.06);
  assert.equal(comparison.return_basis, 'PRE_TAX_NOMINAL_WITH_EXPLICIT_INFLATION_VIEW');
  assert.equal(comparison.illustrativePurchasePowerMilestones.length, 17);
  assert.equal(comparison.purchasePowerMilestoneBasis, 'CURATED_ILLUSTRATIVE_THRESHOLDS_NOT_LIVE_PRICES');
  assert.throws(() => generateProjectionComparison({
    monthlyInvestment: 10000,
    annualReturnRate: 0.12,
    benchmarkRate: 0.03,
    inflationRate: 0.06,
    years: 0,
  }), /years must be an explicit integer/);

  const split = generateAllocationSplit({ monthlyInvestment: 15_001, equityPct: 62.5 });
  assert.equal(split.equityPct, 62.5);
  assert.equal(split.debtPct, 37.5);
  assert.equal(split.equityAmount + split.debtAmount, 15_001);
  assert.equal(split.calculation_classification, 'NON_RECOMMENDATION_ALLOCATION_WHAT_IF');
  assert.throws(
    () => generateAllocationSplit({ monthlyInvestment: 10_000, equityPct: 101 }),
    /equityPct must be an explicit percentage/,
  );
});

test('dashboard portfolio projection uses exact authorized weights and excludes property context', () => {
  const projection = generatePortfolioProjection({
    monthlyContribution: 20_000,
    initialLumpSum: 100_000,
    horizonYears: 5,
    instruments: [
      { id: 'equity', nominalReturn: 12, allocationWeight: 0.6 },
      { id: 'debt', nominalReturn: 7, allocationWeight: 0.4 },
    ],
  });

  assert.equal(projection.return_basis, 'PRE_TAX_NOMINAL');
  assert.equal(projection.annual_step_up_rate, 0);
  assert.equal(projection.initial_lump_sum, 100_000);
  assert.equal(projection.total_invested, 1_300_000);
  assert.equal(projection.performance_data[0].average, 100_000);
  assert.equal(projection.performance_data.at(-1).average, projection.total_projected);
  assert.equal(projection.monthly_timeline.at(-1).month, 60);
  assert.deepEqual(projection.instrument_monthly_allocations, { equity: 12_000, debt: 8_000 });
  assert.equal(
    Object.values(projection.instrument_projected_values).reduce((sum, value) => sum + value, 0),
    projection.total_projected,
  );
  assert.equal('sold_property_proceeds' in projection, false);
  assert.throws(() => generatePortfolioProjection({
    monthlyContribution: 20_000,
    initialLumpSum: 0,
    horizonYears: 5,
    instruments: [{ id: 'equity', nominalReturn: 12, allocationWeight: 0.9 }],
  }), /weights must total 1/);
});

test('portfolio projection normalizes tolerated weight drift consistently across every instrument cashflow', () => {
  const nearUnitWeights = [0.50005, 0.5];
  const normalizedWeights = normalizeAllocationWeights(nearUnitWeights);
  assert.equal(normalizedWeights.reduce((sum, weight) => sum + weight, 0), 1);
  assert.ok(Math.abs(normalizedWeights[0] - 0.5) < 0.0001);

  const projectionArgs = {
    monthlyContribution: 1_000_000.01,
    initialLumpSum: 10_000_000,
    horizonYears: 10,
  };
  const toleratedProjection = generatePortfolioProjection({
    ...projectionArgs,
    instruments: [
      { id: 'equity', nominalReturn: 12, allocationWeight: nearUnitWeights[0] },
      { id: 'debt', nominalReturn: 6, allocationWeight: nearUnitWeights[1] },
    ],
  });
  const explicitlyNormalizedProjection = generatePortfolioProjection({
    ...projectionArgs,
    instruments: [
      { id: 'equity', nominalReturn: 12, allocationWeight: normalizedWeights[0] },
      { id: 'debt', nominalReturn: 6, allocationWeight: normalizedWeights[1] },
    ],
  });

  assert.deepEqual(toleratedProjection.instrument_monthly_allocations, explicitlyNormalizedProjection.instrument_monthly_allocations);
  assert.deepEqual(toleratedProjection.instrument_projected_values, explicitlyNormalizedProjection.instrument_projected_values);
  assert.equal(toleratedProjection.total_projected, explicitlyNormalizedProjection.total_projected);
  assert.equal(
    Number(Object.values(toleratedProjection.instrument_monthly_allocations).reduce((sum, amount) => sum + amount, 0).toFixed(2)),
    1_000_000.01,
  );

  assert.equal(normalizeAllocationWeights([0.5001, 0.5]).reduce((sum, weight) => sum + weight, 0), 1);
  assert.equal(normalizeAllocationWeights([0.4999, 0.5]).reduce((sum, weight) => sum + weight, 0), 1);
  assert.throws(() => normalizeAllocationWeights([0.50010001, 0.5]), /must total 1 within/);
  assert.throws(() => normalizeAllocationWeights([0.49989999, 0.5]), /must total 1 within/);
});

test('dashboard portfolio projection preserves explicit zero allocations and rejects missing weights', () => {
  const projection = generatePortfolioProjection({
    monthlyContribution: 20_000,
    initialLumpSum: 100_000,
    horizonYears: 5,
    instruments: [
      { id: 'equity', nominalReturn: 12, allocationWeight: 0.4 },
      { id: 'excluded', nominalReturn: 8, allocationWeight: 0 },
      { id: 'debt', nominalReturn: 7, allocationWeight: 0.6 },
    ],
  });

  assert.deepEqual(projection.instrument_monthly_allocations, { equity: 8_000, excluded: 0, debt: 12_000 });
  assert.equal(projection.instrument_projected_values.excluded, 0);
  assert.equal(projection.total_projected, projection.instrument_projected_values.equity + projection.instrument_projected_values.debt);

  const zeroTailProjection = generatePortfolioProjection({
    monthlyContribution: 20_000,
    initialLumpSum: 0,
    horizonYears: 1,
    instruments: [
      { id: 'equity', nominalReturn: 12, allocationWeight: 0.6 },
      { id: 'debt', nominalReturn: 7, allocationWeight: 0.4 },
      { id: 'excluded-tail', nominalReturn: 8, allocationWeight: 0 },
    ],
  });
  assert.deepEqual(zeroTailProjection.instrument_monthly_allocations, { equity: 12_000, debt: 8_000, 'excluded-tail': 0 });

  const tinyContributionProjection = generatePortfolioProjection({
    monthlyContribution: 1.01,
    initialLumpSum: 0,
    horizonYears: 1,
    instruments: [
      { id: 'equity-a', nominalReturn: 12, allocationWeight: 0.3333 },
      { id: 'equity-b', nominalReturn: 12, allocationWeight: 0.3333 },
      { id: 'equity-c', nominalReturn: 12, allocationWeight: 0.3333 },
      { id: 'tiny-active', nominalReturn: 7, allocationWeight: 0.0001 },
      { id: 'excluded', nominalReturn: 7, allocationWeight: 0 },
    ],
  });
  const tinyAllocations = Object.values(tinyContributionProjection.instrument_monthly_allocations);
  assert.ok(tinyAllocations.every(amount => amount >= 0));
  assert.equal(Number(tinyAllocations.reduce((sum, amount) => sum + amount, 0).toFixed(2)), 1.01);
  assert.equal(tinyContributionProjection.instrument_monthly_allocations.excluded, 0);

  const tiedRemainderProjection = generatePortfolioProjection({
    monthlyContribution: 1.01,
    initialLumpSum: 0,
    horizonYears: 1,
    instruments: [
      { id: 'first-equal-share', nominalReturn: 8, allocationWeight: 1 / 3 },
      { id: 'second-equal-share', nominalReturn: 8, allocationWeight: 1 / 3 },
      { id: 'third-equal-share', nominalReturn: 8, allocationWeight: 1 / 3 },
      { id: 'explicit-zero-share', nominalReturn: 8, allocationWeight: 0 },
    ],
  });
  assert.deepEqual(tiedRemainderProjection.instrument_monthly_allocations, {
    'first-equal-share': 0.34,
    'second-equal-share': 0.34,
    'third-equal-share': 0.33,
    'explicit-zero-share': 0,
  });

  for (const allocationWeight of [null, undefined, '', false, []]) {
    assert.throws(() => generatePortfolioProjection({
      monthlyContribution: 20_000,
      initialLumpSum: 0,
      horizonYears: 5,
      instruments: [{ id: 'missing-weight', nominalReturn: 8, allocationWeight }],
    }), /explicit number from 0 to 1/);
  }
});

test('dashboard portfolio projection preserves negative net gains instead of reporting zero', () => {
  const projection = generatePortfolioProjection({
    monthlyContribution: 10_000,
    initialLumpSum: 0,
    horizonYears: 1,
    instruments: [{ id: 'declining-assumption', nominalReturn: -50, allocationWeight: 1 }],
  });

  const finalYear = projection.performance_data.at(-1);
  assert.ok(finalYear.average < finalYear.invested);
  assert.equal(finalYear.gains, finalYear.average - finalYear.invested);
  assert.ok(finalYear.gains < 0);
});

test('riskProfiler classifies profiles and encodes categories', () => {
  const aggressive = getRiskProfile(canonicalProfile({
    age: 25, monthlyTakeHome: 400000, monthlySavings: 120000,
    liquidSavings: 1000000, emergencyFundMonths: 12,
    riskTolerance: 'Aggressive', investmentHorizonYears: 30,
  }));
  const conservative = getRiskProfile(canonicalProfile({
    age: 70, monthlyTakeHome: 50000, monthlySavings: 5000,
    liquidSavings: 10000, emergencyFundMonths: 1, emiBurdenPct: 70,
    financialDependents: 4, riskTolerance: 'Conservative', investmentHorizonYears: 1,
  }));
  const preferenceCeiling = getRiskProfile(canonicalProfile({
    age: 25, monthlyTakeHome: 400000, monthlySavings: 120000,
    liquidSavings: 1000000, emergencyFundMonths: 12,
    riskTolerance: 'Conservative', investmentHorizonYears: 30,
  }));

  assert.equal(aggressive.category, 'Aggressive');
  assert.equal(conservative.category, 'Conservative');
  assert.equal(preferenceCeiling.capacityRisk, 'Aggressive');
  assert.equal(preferenceCeiling.category, 'Conservative');
  assert.equal(preferenceCeiling.riskScore, preferenceCeiling.finalLevel);
  assert.equal(encodeRiskCategory('Moderate-Aggressive'), 3);
  assert.throws(() => encodeRiskCategory('Unknown'), /Unknown risk category/);
});

test('postTaxCalculator does not infer PPF exemption without account facts and calculates taxable instruments', () => {
  const ppf = calculatePostTaxReturn('PPF', 0.071, 1200000, 15, 'new', 10000, 35, 'salary', true, 'FY2026-27');
  const fd = calculatePostTaxReturnSafe('FD', 0.07, 3000000, 3, 'new', 10000, 35, 'salary', true, 'FY2026-27');

  assert.equal(ppf.status, 'TAX_CLASSIFICATION_REQUIRES_ACQUISITION_FACTS');
  assert.equal(ppf.taxRate, null);
  assert.equal(ppf.postTaxReturn, null);
  assert.ok(fd.postTaxReturn < 0.07);
  assert.throws(
    () => calculatePostTaxReturn('FD', Number.NaN, -1, -1, 'new', 0, 35, 'salary'),
    /nominalRate/,
  );
});

test('ragClient and mlClient propagate verified X-Verified-User-Id header downstream', async (t) => {
  const originalPost = axios.post;
  const originalMlUrl = process.env.ML_SERVICE_URL;
  let ragCapturedHeaders = null;
  let ragCapturedBody = null;
  let ragCapturedUrl = null;
  let mlCapturedHeaders = null;

  axios.post = async (url, payload, config) => {
    if (url.includes('/rag/query')) {
      ragCapturedUrl = url;
      ragCapturedHeaders = config?.headers;
      ragCapturedBody = payload;
      return { status: 200, data: {
        answer: 'Grounded tax advice', grounded: true,
        citations: [{ chunk_id: 'tax#1' }], retrieved_chunks: [], metrics: {},
      } };
    }
    if (url.includes('/predict')) {
      mlCapturedHeaders = config?.headers;
      return { data: {
        primary: 'ETF', secondary: 'Debt_MF', tertiary: 'ELSS',
        confidence_scores: { Equity_MF: 0.05, ELSS: 0.05, ETF: 0.7, Debt_MF: 0.1, FD: 0.05, RBI_Bond: 0.05 }, decision_path: ['risk = Moderate'],
        model_version: '4.0.0', dataset_version: '4.0.0', feature_schema_version: 'recommendation-features-4.0.0', explanation: null,
      } };
    }
    return { data: {} };
  };

  t.after(() => {
    axios.post = originalPost;
    if (originalMlUrl === undefined) delete process.env.ML_SERVICE_URL; else process.env.ML_SERVICE_URL = originalMlUrl;
  });

  const testUserId = '654321098765432109876543';
  process.env.ML_SERVICE_URL = 'http://rag-service:8000/';

  // 1. Test ragClient queryRAG forwards verified user header and drops unverified body fields
  const ragRes = await queryRAG({
    query: 'What are Section 80C deductions?',
    userId: testUserId,
  }, 'test-corr-id-123');

  assert.ok(ragRes);
  assert.equal(ragCapturedUrl, 'http://rag-service:8000/rag/query');
  assert.equal(ragCapturedHeaders?.['X-Verified-User-Id'], testUserId);
  assert.equal(ragCapturedBody?.tenant_id, undefined, 'tenant_id must not be sent in RAG request body');
  assert.equal(ragCapturedBody?.jurisdiction, 'IN', 'RAG requests default to the supported India corpus');

  // 2. Test mlClient getMLPrediction forwards verified user header
  const mlRes = await getMLPrediction(
    mlInput({ age: 35, monthlySavings: 30000, liquidSavings: 100000 }),
    'test-corr-id-456',
    testUserId,
  );

  assert.ok(mlRes);
  assert.equal(mlCapturedHeaders?.['X-Verified-User-Id'], testUserId);
});
