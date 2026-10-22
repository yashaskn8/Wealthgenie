import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PROJECTION_ASSUMPTION_DATA_CLASS,
  PROJECTION_ASSUMPTION_POLICY_HASH,
  PROJECTION_ASSUMPTION_SOURCE,
  PROJECTION_ASSUMPTION_VERSION,
  INSTRUMENT_PARAMS,
} from '../services/instrumentConstants.js';
import { getInstrumentModelAssumptions } from '../services/marketDataService.js';
import {
  computeTax,
  getTaxPolicyMetadata,
  getTaxSlabsForFY,
} from '../services/taxEngine.js';
import { calculatePostTaxReturn } from '../services/postTaxCalculator.js';
import { INSTRUMENT_KEY_MAP, runPipeline } from '../services/RecommendationPipeline.js';
import { applyProfileSafeMarketContextAdjustment } from '../services/regimeRotationEngine.js';
import { canonicalProfile } from './helpers/canonicalProfile.js';
import { investmentDatabase, recommendationTypeForCatalogInstrument } from '../data/investmentDatabase.js';
import { postTaxReturnSchema } from '../validation/schemas.js';
import { FinancialToolRegistry } from '../services/financialToolRegistry.js';
import { buildGroundedEvidencePacket } from '../services/groundedEvidence.js';
import { buildLlmFinancialContext } from '../services/recommendationProfile.js';
import { assessSuitabilityRisk } from '../services/riskProfiler.js';

test('tax policies are independently versioned by fiscal year with official references', () => {
  const fy2025 = getTaxPolicyMetadata('FY2025-26');
  const fy2026 = getTaxPolicyMetadata('FY2026-27');
  assert.equal(fy2025.policyVersion, 'tax-policy-FY2025-26-v2');
  assert.equal(fy2026.policyVersion, 'tax-policy-FY2026-27-v2');
  assert.notStrictEqual(getTaxSlabsForFY('FY2025-26').new, getTaxSlabsForFY('FY2026-27').new);
  assert.ok(fy2025.sourceReferences.some(source => source.url.startsWith('https://www.indiabudget.gov.in/')));
  assert.ok(fy2026.sourceReferences.some(source => source.url.includes('incometax.gov.in')));
  assert.throws(() => getTaxPolicyMetadata('FY2027-28'), /unavailable/);
});

test('tax engine requires explicit income, regime and income source and exposes applied policy', () => {
  assert.throws(() => computeTax(undefined, 'new', {}, 'salary', 'FY2026-27'), /annualIncome/);
  assert.throws(() => computeTax(1_000_000, undefined, {}, 'salary', 'FY2026-27'), /regime/);
  assert.throws(() => computeTax(1_000_000, 'new', {}, undefined, 'FY2026-27'), /incomeSource/);
  assert.throws(() => computeTax(1_000_000, 'new', {}, 'salary'), /unavailable/);
  const result = computeTax(1_000_000, 'new', {}, 'salary', 'FY2026-27');
  assert.equal(result.policyVersion, 'tax-policy-FY2026-27-v2');
  assert.equal(result.inputsUsed.annualIncome, 1_000_000);
  assert.equal(result.inputsUsed.incomeSource, 'salary');
  assert.equal(result.assumptions.length, 0);
});

test('agent tax tool also requires an explicit supported fiscal year', async () => {
  const result = await FinancialToolRegistry.executeTool('tax_calculator', {
    income: 1_000_000, incomeSource: 'salary', age: 35, regime: 'new',
    section80C: 0, nps80CCD1B: 0, section80D_self: 0,
    section80D_parents: 0, parentsSenior: false, hra: 0,
  });
  assert.equal(result.success, false);
  assert.match(result.error, /fiscalYear/);
});

test('unsupported investment tax classification fails closed', () => {
  assert.throws(
    () => calculatePostTaxReturn('UNVERIFIED_FUND_CLASS', 0.1, 1_000_000, 3, 'new', 10_000, 35, 'salary', true, 'FY2026-27'),
    /Unsupported instrument type/,
  );
});

test('post-tax API contract rejects missing fiscal year instead of silently defaulting it', () => {
  const { error } = postTaxReturnSchema.validate({
    instrumentType: 'FD', nominalRate: 0.06, annualIncome: 1_000_000,
    holdingYears: 2, regime: 'new', monthlySIP: 10_000, userAge: 35,
    incomeSource: 'salary',
  });
  assert.match(error?.message || '', /fiscalYear/);
  assert.throws(
    () => calculatePostTaxReturn('FD', 0.06, 1_000_000, 2, 'new', 10_000, 35, 'salary'),
    /fiscalYear must be explicitly provided/,
  );
  assert.throws(
    () => calculatePostTaxReturn('FD', 0.06, 1_000_000, 2, 'new', 10_000, 35, 'salary', true, 'FY2027-28'),
    /unavailable/,
  );
});

test('supported fiscal years use Finance Act 2025 bank-interest TDS thresholds', () => {
  const generalBelow = calculatePostTaxReturn('FD', 0.05, 1_000_000, 1, 'new', 83_333, 35, 'salary', true, 'FY2026-27');
  const generalAbove = calculatePostTaxReturn('FD', 0.06, 1_000_000, 1, 'new', 83_333, 35, 'salary', true, 'FY2026-27');
  const seniorBelow = calculatePostTaxReturn('FD', 0.10, 1_000_000, 1, 'new', 83_333, 65, 'pension', true, 'FY2026-27');
  const seniorAbove = calculatePostTaxReturn('FD', 0.11, 1_000_000, 1, 'new', 83_333, 65, 'pension', true, 'FY2026-27');
  assert.equal(generalBelow.tdsApplicable, false);
  assert.equal(generalAbove.tdsApplicable, true);
  assert.equal(seniorBelow.tdsApplicable, false);
  assert.equal(seniorAbove.tdsApplicable, true);
});

test('FRSB uses the security-interest TDS threshold while generic G-Sec withholding stays unassessed', () => {
  const frsb = calculatePostTaxReturn(
    'RBI_Bond', 0.06, 1_000_000, 1, 'new', 20_000, 35, 'salary', true, 'FY2026-27',
  );
  assert.equal(frsb.grossGain, 14_400);
  assert.equal(frsb.tdsThreshold, 10_000);
  assert.equal(frsb.tdsApplicable, true);
  assert.equal(frsb.tdsRate, 0.10);
  assert.equal(frsb.tdsTreatment, 'FRSB_SECURITY_INTEREST');
  assert.match(frsb.notes, /payer-level aggregation/);

  const genericGovernmentSecurity = calculatePostTaxReturn(
    'G-Sec', 0.06, 1_000_000, 1, 'new', 100_000, 35, 'salary', true, 'FY2026-27',
  );
  assert.equal(genericGovernmentSecurity.grossGain, 72_000);
  assert.equal(genericGovernmentSecurity.tdsApplicable, null);
  assert.equal(genericGovernmentSecurity.tdsThreshold, null);
  assert.equal(genericGovernmentSecurity.tdsTreatment, 'SECURITY_IDENTITY_REQUIRED');
  assert.match(genericGovernmentSecurity.notes, /exact security identity/);
});

test('RBI Retail Direct Gilt catalog identities stay separate from the RBI floating-rate savings bond', () => {
  assert.equal(recommendationTypeForCatalogInstrument({ id: 'rbi_bonds' }), 'RBI_Bond');
  assert.equal(recommendationTypeForCatalogInstrument({ id: 'rbi_retail_direct_gilt' }), 'G-Sec');
  assert.equal(recommendationTypeForCatalogInstrument({ id: 'g_sec' }), 'G-Sec');
  assert.equal(INSTRUMENT_KEY_MAP.rbi_retail_direct_gilt, 'G-Sec');
});

test('TDS is withholding metadata and does not create a second final-tax charge', () => {
  const nominalRate = 0.06;
  const result = calculatePostTaxReturn(
    'FD', nominalRate, 2_000_000, 1, 'new', 100_000, 35, 'salary', true, 'FY2026-27',
  );

  assert.equal(result.tdsApplicable, true);
  assert.equal(result.tdsRate, 0.10);
  assert.equal(result.postTaxReturn, Number((nominalRate * (1 - result.taxRate)).toFixed(4)));
  assert.match(result.notes, /not an extra tax/);
});

test('projection parameters are immutable model assumptions and never provider forecasts', async () => {
  for (const params of Object.values(INSTRUMENT_PARAMS)) {
    assert.equal(params.dataClass, PROJECTION_ASSUMPTION_DATA_CLASS);
    assert.equal(params.assumptionVersion, PROJECTION_ASSUMPTION_VERSION);
    assert.equal(params.source, PROJECTION_ASSUMPTION_SOURCE);
    assert.equal(params.observedMarketFact, false);
    assert.equal(params.providerForecast, false);
  }
  const result = await getInstrumentModelAssumptions();
  assert.equal(result.status, 'MODEL_ASSUMPTIONS_ONLY');
  assert.equal(result.observed_market_fact, false);
  assert.equal(result.provider_forecast, false);
  assert.equal(result.assumption_version, PROJECTION_ASSUMPTION_VERSION);
  assert.equal(result.params.Equity_MF.dataClass, 'MODEL_ASSUMPTION');
});

test('chat evidence identifies recommendation returns as model assumptions', () => {
  const profile = canonicalProfile();
  const context = buildLlmFinancialContext(profile, assessSuitabilityRisk(profile));
  const packet = buildGroundedEvidencePacket({
    question: 'Explain my recommendation.',
    profile: context,
    recommendation: {
      modelVersion: 'test-model',
      profileInputHash: 'test-profile-hash',
      instruments: [{ id: 'equity', name: 'Equity', type: 'Equity_MF', nominalReturn: 12, allocationWeight: 1 }],
    },
  });
  const evidence = packet.entries.find(item => item.id === 'E_REC_001');
  assert.equal(evidence.value.returnDataClass, 'MODEL_ASSUMPTION');
  assert.equal(evidence.value.providerForecast, false);
  assert.match(evidence.displayValue, /pre-tax nominal model assumption/);
});

test('legacy catalog return fields are explicitly classified as model assumptions', () => {
  for (const instrument of investmentDatabase) {
    assert.equal(instrument.returnDataClass, 'MODEL_ASSUMPTION');
    assert.equal(instrument.returnAssumptionVersion, PROJECTION_ASSUMPTION_VERSION);
    assert.equal(instrument.returnAssumptionHash, PROJECTION_ASSUMPTION_POLICY_HASH);
    assert.equal(instrument.returnSource, PROJECTION_ASSUMPTION_SOURCE);
    assert.equal(instrument.observedMarketFact, false);
    assert.equal(instrument.providerForecast, false);
  }
});

test('authoritative recommendations preserve model-assumption provenance per instrument', () => {
  const result = runPipeline(canonicalProfile(), { model_version: 'test', confidence_scores: {} });
  assert.ok(result.instruments.length > 0);
  for (const instrument of result.instruments) {
    assert.equal(instrument.returnDataClass, 'MODEL_ASSUMPTION');
    assert.equal(instrument.returnAssumptionVersion, PROJECTION_ASSUMPTION_VERSION);
    assert.equal(instrument.returnAssumptionHash, PROJECTION_ASSUMPTION_POLICY_HASH);
    assert.equal(instrument.returnSource, 'WEALTHGENIE_MODEL_POLICY');
    assert.equal(instrument.observedMarketFact, false);
    assert.equal(instrument.providerForecast, false);
    assert.equal(instrument.postTaxReturn, null);
  }
});

test('deterministic market context cannot introduce instruments or mutate return assumptions', () => {
  const instruments = [
    { id: 'higher-risk', riskScore: 4, allocationWeight: 0.6, allocation_pct: 60, nominalReturn: 12, returnDataClass: 'MODEL_ASSUMPTION' },
    { id: 'lower-risk', riskScore: 1, allocationWeight: 0.4, allocation_pct: 40, nominalReturn: 6, returnDataClass: 'MODEL_ASSUMPTION' },
  ];
  const adjusted = applyProfileSafeMarketContextAdjustment({
    profile: canonicalProfile(), instruments,
    marketContext: { status: 'MARKET_CONTEXT_AVAILABLE', context: 'CAUTIOUS' },
  }, {
    assertPortfolioSuitable: () => ({ finalLevel: 5, reasonCodes: [] }),
    resolveConcentrationCap: () => null,
  });
  assert.deepEqual(adjusted.introducedInstrumentIds, []);
  assert.deepEqual(adjusted.adjustedInstruments.map(item => item.id), instruments.map(item => item.id));
  assert.deepEqual(adjusted.adjustedInstruments.map(item => item.nominalReturn), [12, 6]);
  assert.ok(adjusted.adjustedInstruments.every(item => item.returnDataClass === 'MODEL_ASSUMPTION'));
});

test('Monte Carlo contract labels assumptions and simulated percentiles while HMM remains shadow', () => {
  const monteCarlo = readFileSync(resolve(process.cwd(), 'routes/montecarlo.js'), 'utf8');
  const hmmIdentity = readFileSync(resolve(process.cwd(), '..', 'ml-service/market_context/__init__.py'), 'utf8');
  const hmmRegistry = readFileSync(resolve(process.cwd(), '..', 'ml-service/market_context/artifacts/registry.json'), 'utf8');
  assert.match(monteCarlo, /return_data_class: PROJECTION_ASSUMPTION_DATA_CLASS/);
  assert.match(monteCarlo, /provider_forecast: false/);
  assert.match(monteCarlo, /Simulated 10th percentile/);
  assert.match(monteCarlo, /simulated_mean/);
  assert.doesNotMatch(monteCarlo, /portfolio_expected_return\s*:/);
  assert.match(hmmIdentity, /MODEL_ROLE = "SHADOW"/);
  assert.deepEqual(JSON.parse(hmmRegistry).champion, {
    modelFamily: 'DETERMINISTIC_POLICY',
    modelVersion: 'market-context-policy-1.0.0',
    role: 'CHAMPION',
  });
});

test('React financial paths do not call official providers directly', () => {
  const files = [
    'reactapp/src/components/deepdive/WhereToInvestTab.jsx',
    'reactapp/src/PostTaxAnalysis.jsx',
  ];
  for (const file of files) {
    const source = readFileSync(resolve(process.cwd(), '..', file), 'utf8');
    assert.doesNotMatch(source, /indiapost\.gov\.in|sbi\.bank\.in|amfiindia\.com\/spages/i);
  }
});

test('React labels catalog returns, tax references, and Monte Carlo values by their true evidence class', () => {
  const comparison = readFileSync(resolve(process.cwd(), '..', 'reactapp/src/ComparisonTableModal.jsx'), 'utf8');
  const taxTab = readFileSync(resolve(process.cwd(), '..', 'reactapp/src/components/deepdive/TaxTab.jsx'), 'utf8');
  const jargon = readFileSync(resolve(process.cwd(), '..', 'reactapp/src/components/JargonTooltip.jsx'), 'utf8');
  const goals = readFileSync(resolve(process.cwd(), '..', 'reactapp/src/components/GoalPlanner.jsx'), 'utf8');
  assert.match(comparison, /MODEL RETURN ASSUMPTION/);
  assert.match(comparison, /TAX RESULT/);
  assert.match(comparison, /Use fiscal-year tax analysis/);
  assert.doesNotMatch(comparison, /Expected Growth|PRE-TAX NOMINAL/);
  assert.match(taxTab, /TAX_CLASSIFICATION_UNAVAILABLE/);
  assert.doesNotMatch(taxTab, /policy\?\.ltcg|inv\?\.tax_benefit/);
  assert.match(jargon, /Simulated 10th percentile/);
  assert.match(jargon, /Simulated median/);
  assert.match(jargon, /Simulated 90th percentile/);
  assert.doesNotMatch(jargon, /treat it as a best-case forecast|chance your actual wealth/);
  assert.match(goals, /AVERAGE INDIVIDUAL REACH RATE — NOT JOINT/);
  assert.doesNotMatch(goals, />SIMULATED GOAL REACH RATE<\/div>/);
  assert.doesNotMatch(goals, /real-time Monte Carlo wealth forecasting|Quant Success Forecast/);
});
