import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveWeights,
  enforceAllocationTargets,
  filterEligible,
  getInstrumentRisk,
  getWhereToInvestProviderCoverageMatrix,
  instrumentRiskTier,
  normaliseConfidenceScores,
  parseProfile,
  rankInstruments,
  rankWhereToInvestBackend,
  reconcileRisk,
  resolveBackendType,
  resolveInstrumentModelKey,
  runPipeline,
} from '../services/RecommendationPipeline.js';
import { investmentDatabase } from '../data/investmentDatabase.js';
import whereToInvestCatalog from '../data/whereToInvestCatalog.js';
import { canonicalProfile } from './helpers/canonicalProfile.js';

test('instrument mapping and risk classification return explicit unknown states', () => {
  assert.equal(resolveBackendType({ id: 'ppf' }), 'PPF');
  assert.equal(resolveBackendType({ recommendationType: 'Index_MF', name: 'Nifty Index Mutual Fund' }), 'Index_MF');
  assert.equal(resolveBackendType({ name: 'Nifty Index Mutual Fund' }), null);
  assert.equal(resolveBackendType({ name: 'Unmapped product' }), null);
  assert.equal(getInstrumentRisk({}), null);
  assert.equal(instrumentRiskTier({}), 'UNKNOWN');
  assert.equal(instrumentRiskTier({ riskLevel: 5 }), 'HIGH');
});

test('projection model keys resolve exact catalog identities without bypassing unknowns', () => {
  assert.equal(resolveInstrumentModelKey('liquid_mf'), 'Liquid_MF');
  assert.equal(resolveInstrumentModelKey('liquid_etf'), 'Liquid_MF');
  assert.equal(resolveInstrumentModelKey('ppf'), 'PPF');
  assert.equal(resolveInstrumentModelKey('sbi_fd'), 'FD');
  assert.equal(resolveInstrumentModelKey('FD'), 'FD');
  assert.equal(resolveInstrumentModelKey('unknown-product'), null);
  assert.equal(resolveInstrumentModelKey(''), null);
});

test('eligibility fails closed and recognizes a fully established eligible instrument', () => {
  const established = {
    id: 'fixture', type: 'FD', name: 'Fixture Instrument', riskLevel: 2, expectedReturn: 7,
    liquidityScore: 4, expenseRatio: 0.001, goalTags: ['Wealth Growth'],
    idealHorizon: { min: 1, max: 20 }, lockIn: 0,
    eligibility: {
      minAge: 18, maxAge: null, minAnnualIncome: 0, minMonthlySavings: 500,
      hasGirlChild: null, requiresDemat: null,
    },
  };
  const result = filterEligible([
    established,
    { ...established, id: 'unknown', eligibility: undefined },
    { ...established, id: 'partial', eligibility: { minAge: 18, minMonthlySavings: 500 } },
  ], canonicalProfile(), 3);
  assert.deepEqual(result.eligible.map(item => item.id), ['fixture']);
  assert.deepEqual(result.excluded, [
    { id: 'unknown', name: 'Fixture Instrument', reasonCode: 'ELIGIBILITY_NOT_ESTABLISHED' },
    { id: 'partial', name: 'Fixture Instrument', reasonCode: 'ELIGIBILITY_NOT_ESTABLISHED' },
  ]);
});

test('gross-income, family, and demat eligibility that is not in the profile is excluded explicitly', () => {
  const base = {
    name: 'Fixture', type: 'FD', riskLevel: 1, expectedReturn: 7, liquidityScore: 4, expenseRatio: 0,
    goalTags: ['Wealth Growth'], idealHorizon: { min: 1, max: 20 }, lockIn: 0,
    eligibility: {
      minAge: 18, maxAge: null, minAnnualIncome: 0, minMonthlySavings: 500,
      hasGirlChild: null, requiresDemat: null,
    },
  };
  const variants = [
    { id: 'income', eligibility: { ...base.eligibility, minAnnualIncome: 1 } },
    { id: 'girl', eligibility: { ...base.eligibility, hasGirlChild: true } },
    { id: 'demat', eligibility: { ...base.eligibility, requiresDemat: true } },
  ].map(item => ({ ...base, ...item }));
  assert.deepEqual(filterEligible(variants, canonicalProfile(), 3).excluded.map(item => item.reasonCode), [
    'GROSS_INCOME_ELIGIBILITY_NOT_ESTABLISHED',
    'GIRL_CHILD_ELIGIBILITY_NOT_ESTABLISHED',
    'DEMAT_ELIGIBILITY_NOT_ESTABLISHED',
  ]);
});

test('profile parsing and weights use only canonical profile facts', () => {
  const parsed = parseProfile(canonicalProfile());
  assert.deepEqual(Object.keys(parsed).sort(), [
    'age', 'emiBurdenPct', 'emergencyFundMonths', 'financialDependents', 'goals',
    'horizon', 'liquidSavings', 'monthlySavings', 'monthlyTakeHome', 'risk', 'riskLevel',
  ].sort());
  const weights = deriveWeights(parsed);
  assert.ok(Math.abs(Object.values(weights).reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
  assert.equal('tax' in weights, false);
});

test('risk reconciliation preserves the hard preference ceiling', () => {
  const result = reconcileRisk(canonicalProfile({ riskTolerance: 'Conservative' }));
  assert.equal(result.preference_score, 1);
  assert.equal(result.final_score, 1);
  assert.ok(result.reason_codes.includes('RISK_PREFERENCE_CONSERVATIVE'));
});

test('allocation normalization respects aggregate concentration caps and sums to one', () => {
  const result = enforceAllocationTargets([
    { id: 'smallcap_mf', type: 'Smallcap_MF', name: 'Smallcap A', score: 100 },
    { id: 'smallcap_b', type: 'Smallcap_MF', name: 'Smallcap B', score: 80 },
    { id: 'fd', type: 'FD', name: 'FD', score: 20 },
  ]);
  const smallcap = result.filter(item => item.type === 'Smallcap_MF')
    .reduce((sum, item) => sum + item.allocation_pct, 0);
  assert.ok(smallcap <= 15.01);
  assert.ok(Math.abs(result.reduce((sum, item) => sum + item.allocationWeight, 0) - 1) <= 0.0002);
  assert.throws(() => enforceAllocationTargets([
    { id: 'smallcap_mf', type: 'Smallcap_MF', name: 'Smallcap A', score: 100 },
    { id: 'smallcap_b', type: 'Smallcap_MF', name: 'Smallcap B', score: 80 },
  ]), /no uncapped instrument/);
});

test('pipeline output is backend-owned, pre-tax nominal, suitable, and capacity-bounded', () => {
  const profile = canonicalProfile();
  const output = runPipeline(profile, { confidence_scores: { Index_MF: 0.9 } });
  const forbiddenNoise = runPipeline({
    ...profile, annualIncome: 999999999, totalCTC: 999999999,
    taxRegime: 'old', goal_type: 'house purchase',
  }, { confidence_scores: { Index_MF: 0.9 } });
  assert.ok(output.instruments.length > 0);
  assert.ok(output.instruments.every(item => item.returnBasis === 'PRE_TAX_NOMINAL'));
  assert.ok(output.instruments.every(item => item.postTaxReturn === null));
  assert.ok(output.instruments.every(item => item.tags.every(tag => [
    'Retirement', 'Wealth Growth', 'Tax Saving', 'Emergency Fund',
  ].includes(tag))));
  assert.ok(output.instruments.every(item => item.riskScore <= output.riskReconciliation.final_score));
  assert.ok(Math.abs(output.instruments.reduce((sum, item) => sum + item.allocationWeight, 0) - 1) <= 0.001);
  assert.deepEqual(forbiddenNoise, output, 'forbidden profile fields cannot change ranking or allocation');
});

test('ML outputs are observational only and cannot change financial ranking or allocation', () => {
  const profile = canonicalProfile();
  const parsed = parseProfile(profile);
  const weights = deriveWeights(parsed);
  const baseline = runPipeline(profile, {});
  const eligible = filterEligible(investmentDatabase, profile, baseline.riskReconciliation.final_score).eligible;
  const expectedRanking = rankInstruments(eligible, parsed, weights).map(({ instrument, score, factors }) => ({
    id: instrument.id,
    score,
    factors,
  }));
  const financialProjection = result => ({
    instruments: result.instruments,
    riskReconciliation: result.riskReconciliation,
    computedWeights: result.computedWeights,
  });
  const variants = [
    {
      primary: 'Equity_MF', secondary: 'FD', tertiary: 'PPF',
      confidence_scores: { Equity_MF: 1, FD: 0, PPF: 0 },
      decision_path: ['equity'], explanation: 'ML vector A', model_version: 'model-a',
    },
    {
      primary: 'FD', secondary: 'PPF', tertiary: 'Equity_MF',
      confidence_scores: { FD: 1, PPF: 0, Equity_MF: 0 },
      decision_path: ['fixed-income'], explanation: 'ML vector B', model_version: 'model-b',
    },
    {
      primary: 'PPF', secondary: 'Equity_MF', tertiary: 'FD',
      confidence_scores: { Equity_MF: 1 / 3, FD: 1 / 3, PPF: 1 / 3 },
      decision_path: ['uniform'], explanation: 'ML vector C', model_version: 'model-c',
    },
    null,
    { primary: 'FD', secondary: 'Equity_MF', tertiary: 'PPF', confidence_scores: { FD: NaN } },
  ];

  assert.deepEqual(expectedRanking, rankInstruments(eligible, parsed, weights).map(({ instrument, score, factors }) => ({
    id: instrument.id,
    score,
    factors,
  })));
  for (const mlResult of variants) {
    const candidate = runPipeline(profile, mlResult);
    assert.deepEqual(financialProjection(candidate), financialProjection(baseline));
    assert.deepEqual(candidate.instruments.map(item => item.id), baseline.instruments.map(item => item.id));
  }
  assert.equal(Object.hasOwn(baseline.computedWeights, 'mlConfidence'), false);
  assert.equal(Object.hasOwn(baseline.instruments[0].scoreFactors, 'mlConfidence'), false);
});

test('WTI unsupported categories fail closed while preserving parent suitability', async () => {
  const products = await rankWhereToInvestBackend(canonicalProfile(), { parentInstrumentId: 'index_mf' });
  assert.equal(products.length, 0);
  assert.equal(products.metadata.catalog.title.length > 0, true);
  assert.equal(products.metadata.catalog.dataClass, 'REFERENCE_METADATA');
  assert.equal(products.metadata.catalog.howToStart, null);
  assert.equal(products.metadata.ranking.status, 'UNAVAILABLE');
  assert.equal(products.metadata.ranking.authority, 'NONE');
  assert.deepEqual(products.metadata.ranking.reasonCodes, ['PRODUCT_CLASS_NOT_SUPPORTED_PHASE_2']);
  const unknown = await rankWhereToInvestBackend(canonicalProfile(), { parentInstrumentId: 'missing' });
  assert.equal(unknown.length, 0);
  assert.equal(unknown.metadata.excluded[0].reasonCode, 'CATALOG_INSTRUMENT_NOT_ESTABLISHED');
  const excessiveRisk = await rankWhereToInvestBackend(
    canonicalProfile({ riskTolerance: 'Conservative' }),
    { parentInstrumentId: 'smallcap_mf' },
  );
  assert.equal(excessiveRisk.length, 0);
  assert.equal(excessiveRisk.metadata.excluded[0].reasonCode, 'RISK_EXCEEDS_FINAL_SUITABILITY');
});

test('WTI provider coverage matrix audits every catalog parent and never substitutes unsupported products', () => {
  const matrix = getWhereToInvestProviderCoverageMatrix();
  assert.equal(matrix.length, investmentDatabase.length);
  assert.equal(new Set(matrix.map(item => item.parentInstrumentId)).size, investmentDatabase.length);
  assert(matrix.every(item => item.productSubstitutionAllowed === false));
  assert(matrix.some(item => item.parentInstrumentId === 'ppf' && item.provider === 'GOVERNMENT_OF_INDIA'));
  assert(matrix.some(item => item.parentInstrumentId === 'fd' && item.provider === 'SBI'));
  assert(matrix.some(item => item.parentInstrumentId === 'index_mf' && item.status === 'UNSUPPORTED_FAIL_CLOSED'));
});

test('WTI legacy catalog exports reference text only and cannot expose product or financial authority', () => {
  const instrumentIds = investmentDatabase.map(instrument => instrument.id);
  assert.equal(instrumentIds.length, 155);
  assert.deepEqual(Object.keys(whereToInvestCatalog).sort(), [...instrumentIds].sort());

  for (const instrumentId of instrumentIds) {
    const entry = whereToInvestCatalog[instrumentId];
    assert.equal(typeof entry.title, 'string', `${instrumentId} must have a title`);
    assert.equal(entry.howToStart, null, `${instrumentId} must not expose unqualified account instructions`);
    assert.deepEqual(Object.keys(entry).sort(), ['howToStart', 'title']);
    assert.equal('products' in entry, false);
    assert.equal('rate' in entry, false);
    assert.equal('riskLevel' in entry, false);
  }
});

test('ML confidence normalization rejects non-finite and out-of-range values', () => {
  assert.deepEqual(normaliseConfidenceScores({ confidence_scores: { FD: 0.8 } }), { FD: 0.8 });
  assert.throws(() => normaliseConfidenceScores({ confidence_scores: { Index_MF: 2 } }), /between 0 and 1/);
  assert.throws(() => normaliseConfidenceScores({ confidence_scores: { bad: 'not-a-number' } }), /between 0 and 1/);
  assert.throws(() => normaliseConfidenceScores({ confidence_scores: { FD: '0.8' } }), /between 0 and 1/);
});

test('generation candidate counts partition the authoritative legacy catalog without promoting extensions', () => {
 const output=runPipeline(canonicalProfile());
 const counts=output.riskReconciliation.candidate_counts;
 assert.equal(counts.legacy_catalog,investmentDatabase.length);
 assert.equal(counts.eligible+counts.excluded,counts.legacy_catalog);
 assert.equal(counts.ranked,counts.eligible);
 assert.equal(counts.selected,output.instruments.length);
 assert.equal(counts.eligible_not_selected,counts.eligible-counts.selected);
 assert.equal(output.riskReconciliation.eligible_not_selected.length,counts.eligible_not_selected);
 const selectedIds=new Set(output.instruments.map(item=>item.id));
 for(const item of output.riskReconciliation.eligible_not_selected){
  assert.equal(selectedIds.has(item.id),false);
  assert.equal(item.reasonCode,'RANKED_BUT_NOT_SELECTED');
  assert.ok(Number.isFinite(item.score));
 }
 const conservative=runPipeline(canonicalProfile({riskTolerance:'Conservative'}));
 assert.equal(conservative.riskReconciliation.candidate_counts.excluded+
  conservative.riskReconciliation.candidate_counts.eligible,investmentDatabase.length);
});
