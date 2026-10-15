import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  FINANCIAL_PROFILE_SCHEMA_VERSION,
  RECOMMENDATION_PROFILE_KEYS,
  buildLlmFinancialContext,
  buildMlProfileInput,
  buildProfileGroundedSimulation,
  buildRecommendationProfile,
  buildRecommendationProfileHash,
  deriveRecommendationMetrics,
  getMissingMlProfileFields,
  getUnknownOptionalProfileFields,
  toProfileApiResponse,
  toProfilePersistence,
} from '../services/recommendationProfile.js';
import { assessSuitabilityRisk } from '../services/riskProfiler.js';
import { assertPortfolioSuitable, filterEligible } from '../services/RecommendationPipeline.js';
import { financialProfileSchema, customGoalSchema } from '../validation/financialSchemas.js';
import FinancialProfile from '../models/FinancialProfile.js';
import {
  LEGACY_FIELDS_TO_UNSET,
  NEVER_INFER_FROM,
  planFinancialProfileMigration,
} from '../scripts/migrateFinancialProfilesV4.js';
import { generateProjections, computeCAGR } from '../services/projectionEngine.js';
import { getInstrumentVolatility, runMonteCarloWithGoal } from '../services/monteCarloEngine.js';
import { calculatePostTaxReturn } from '../services/postTaxCalculator.js';
import { FinancialToolRegistry } from '../services/financialToolRegistry.js';
import { canonicalProfile, canonicalProfilePayload } from './helpers/canonicalProfile.js';

test('the recommendation boundary returns exactly the frozen PICK allowlist', () => {
  const output = buildRecommendationProfile({
    ...canonicalProfile(), annualIncome: 9_999_999, totalCTC: 20_000_000,
    taxRegime: 'old', customGoalName: 'Ignored', currentPortfolio: { Equity_MF: 1 },
  });
  assert.deepEqual(Object.keys(output), RECOMMENDATION_PROFILE_KEYS);
  assert.equal('annualIncome' in output, false);
  assert.equal('currentPortfolio' in output, false);
});

test('missing core facts and conflicting aliases fail closed while optional facts remain unknown', () => {
  assert.throws(() => buildRecommendationProfile({ monthlyTakeHome: 100000 }), { code: 'RECOMMENDATION_PROFILE_INVALID' });
  assert.throws(() => buildRecommendationProfile({
    ...canonicalProfile(), monthly_take_home: 90000,
  }), /conflicting aliases for monthlyTakeHome/);
  const { emiBurdenPct: _removed, ...withoutRatio } = canonicalProfile();
  const incomplete = buildRecommendationProfile({ ...withoutRatio, existing_debt: 10 });
  assert.equal(incomplete.emiBurdenPct, null, 'debt amounts must not be guessed as EMI percentages');
  const suitability = assessSuitabilityRisk(incomplete);
  assert.equal(suitability.finalLevel, 1);
  assert.ok(suitability.reasonCodes.includes('CAPACITY_FACT_UNKNOWN_EMI_BURDEN_PCT'));
  assert.deepEqual(getMissingMlProfileFields(incomplete), ['emiBurdenPct']);
  assert.deepEqual(getUnknownOptionalProfileFields(incomplete), ['emiBurdenPct']);
  assert.throws(() => buildMlProfileInput(incomplete, suitability), /ML input unavailable/);
  const { monthlyTakeHome: _takeHome, ...withoutTakeHome } = canonicalProfile();
  assert.throws(
    () => buildRecommendationProfile({ ...withoutTakeHome, income: 100000 }),
    /monthlyTakeHome is required/,
    'ambiguous plain income must not be treated as monthly take-home',
  );
});

test('transport validation is exact, strict, and equivalent to the boundary', () => {
  const valid = canonicalProfilePayload();
  assert.equal(financialProfileSchema.validate(valid, { abortEarly: false }).error, undefined);
  assert.equal(financialProfileSchema.validate({
    ...valid, monthly_take_home: 1, monthly_savings: 0.5,
  }, { abortEarly: false }).error, undefined);
  assert.ok(financialProfileSchema.validate({ ...valid, annualIncome: 1200000 }).error);
  assert.ok(financialProfileSchema.validate({ ...valid, investment_horizon_years: 31 }).error);
  assert.ok(financialProfileSchema.validate({ ...valid, monthly_savings: valid.monthly_take_home }).error);
  const coreOnly = {
    monthly_take_home: 100000,
    monthly_savings: 20000,
    age: 35,
    risk_tolerance: 'Moderate',
    investment_goals: ['Wealth Growth'],
    investment_horizon_years: 10,
  };
  assert.equal(financialProfileSchema.validate(coreOnly, { abortEarly: false }).error, undefined);
  assert.equal(financialProfileSchema.validate({
    ...coreOnly,
    sold_property_proceeds: null,
    has_lump_sum: null,
    lump_sum_amount: null,
    liquid_savings: null,
    emi_burden_pct: null,
    financial_dependents: null,
    emergency_fund_months: null,
  }, { abortEarly: false }).error, undefined);
});

test('new persistence and API representations do not duplicate legacy financial sources', () => {
  const profile = canonicalProfile();
  const suitability = assessSuitabilityRisk(profile);
  const persisted = toProfilePersistence(profile, suitability);
  for (const forbidden of ['monthlyIncome', 'savings', 'investableAmount', 'oneTimeInvestableAmount', 'annualIncome', 'taxRegime']) {
    assert.equal(forbidden in persisted, false, forbidden);
  }
  const api = toProfileApiResponse({ _id: new mongoose.Types.ObjectId(), version: 4, ...profile });
  assert.deepEqual(Object.keys(api).sort(), [
    'age', 'emergency_fund_months', 'emi_burden_pct', 'financial_dependents', 'has_lump_sum',
    'investment_goals', 'investment_horizon_years', 'liquid_savings', 'lump_sum_amount',
    'monthly_investment_capacity', 'monthly_savings', 'monthly_take_home', 'one_time_investment_capacity',
    'profileId', 'profile_schema_version', 'risk_tolerance', 'sold_property_proceeds', 'version',
  ].sort());
});

test('model validation requires core facts and schema version while preserving optional nulls', async () => {
  const valid = new FinancialProfile({
    userId: new mongoose.Types.ObjectId(),
    ...toProfilePersistence(canonicalProfile(), assessSuitabilityRisk(canonicalProfile())),
  });
  await valid.validate();
  const incompleteCanonical = buildRecommendationProfile({
    monthlyTakeHome: 100000,
    monthlySavings: 20000,
    age: 35,
    riskTolerance: 'Moderate',
    investmentGoals: ['Wealth Growth'],
    investmentHorizonYears: 10,
  });
  const incompleteSuitability = assessSuitabilityRisk(incompleteCanonical);
  const optionalNulls = new FinancialProfile({
    userId: new mongoose.Types.ObjectId(),
    ...toProfilePersistence(incompleteCanonical, incompleteSuitability),
  });
  await optionalNulls.validate();
  assert.equal(optionalNulls.liquidSavings, null);
  assert.equal(optionalNulls.finalSuitabilityRisk, 'Conservative');
  const invalid = new FinancialProfile({ userId: new mongoose.Types.ObjectId(), monthlyTakeHome: 100000 });
  await assert.rejects(invalid.validate(), /required/);
});

test('model persistence recomputes suitability instead of trusting supplied derived fields', async () => {
  const profile = new FinancialProfile({
    userId: new mongoose.Types.ObjectId(),
    ...canonicalProfile(),
    recommendationProfileVersion: FINANCIAL_PROFILE_SCHEMA_VERSION,
    riskCapacityScore: 100,
    riskCapacityLevel: 5,
    finalSuitabilityRisk: 'Aggressive',
    suitabilityReasonCodes: ['FORGED'],
  });
  await profile.validate();
  const expected = assessSuitabilityRisk(canonicalProfile());
  assert.equal(profile.riskCapacityScore, expected.capacityScore);
  assert.equal(profile.riskCapacityLevel, expected.capacityLevel);
  assert.equal(profile.finalSuitabilityRisk, expected.finalRisk);
  assert.deepEqual(profile.suitabilityReasonCodes, expected.reasonCodes);
});

test('property proceeds never become deployable initial capital', () => {
  const profile = canonicalProfile({ soldPropertyProceeds: 8_000_000 });
  assert.equal(deriveRecommendationMetrics(profile).deployableLumpSum, 0);
  assert.equal(
    assessSuitabilityRisk(profile).capacityScore,
    assessSuitabilityRisk(canonicalProfile({ soldPropertyProceeds: 0 })).capacityScore,
    'sold-property proceeds cannot increase risk capacity',
  );
  assert.equal(buildProfileGroundedSimulation(profile, { monthlyInvestment: 10000, years: 5 }).initialCapital, 0);
  const declared = canonicalProfile({
    soldPropertyProceeds: 8_000_000, hasLumpSum: true, lumpSumAmount: 250000,
  });
  assert.equal(buildProfileGroundedSimulation(declared, { monthlyInvestment: 10000, years: 5 }).initialCapital, 250000);
});

test('profile-grounded simulations require explicit values within both savings and horizon caps', () => {
  const profile = canonicalProfile();
  assert.throws(() => buildProfileGroundedSimulation(profile), /simulation request/);
  assert.throws(() => buildProfileGroundedSimulation(profile, { monthlyInvestment: 20001, years: 5 }), /monthlyInvestment/);
  assert.throws(() => buildProfileGroundedSimulation(profile, { monthlyInvestment: 10000, years: 11 }), /years/);
});

test('stated risk preference is a hard ceiling and capacity may only reduce it', () => {
  const conservative = assessSuitabilityRisk(canonicalProfile({ riskTolerance: 'Conservative' }));
  assert.equal(conservative.finalLevel, 1);
  const constrained = assessSuitabilityRisk(canonicalProfile({
    riskTolerance: 'Aggressive', age: 65, monthlySavings: 1000, liquidSavings: 0,
    emiBurdenPct: 75, financialDependents: 5, emergencyFundMonths: 0, investmentHorizonYears: 2,
  }));
  assert.ok(constrained.finalLevel < constrained.preferenceLevel);
  assert.ok(constrained.reasonCodes.includes('RISK_CAPACITY_REDUCED_PREFERENCE'));
});

test('unknown eligibility and unknown portfolio instruments are explicit exclusions', () => {
  const instrument = {
    id: 'known', type: 'FD', name: 'Known', riskLevel: 1, expectedReturn: 7, liquidityScore: 4,
    expenseRatio: 0.001, goalTags: ['Wealth Growth'], idealHorizon: { min: 1, max: 30 }, lockIn: 0,
  };
  const result = filterEligible([instrument], canonicalProfile(), 3);
  assert.equal(result.eligible.length, 0);
  assert.equal(result.excluded[0].reasonCode, 'ELIGIBILITY_NOT_ESTABLISHED');
  assert.throws(() => assertPortfolioSuitable(canonicalProfile(), ['not-in-catalog']), error => (
    error.code === 'PORTFOLIO_SUITABILITY_VIOLATION'
      && error.violations[0].reasonCode === 'CATALOG_INSTRUMENT_NOT_ESTABLISHED'
  ));
});

test('canonical model instruments use model risk and lock-in instead of an arbitrary catalog product', () => {
  const conservativeFiveYear = canonicalProfile({
    riskTolerance: 'Conservative',
    investmentHorizonYears: 5,
  });

  assert.equal(assertPortfolioSuitable(conservativeFiveYear, ['FD']).finalLevel, 1);
  assert.throws(() => assertPortfolioSuitable(conservativeFiveYear, ['Equity_MF']), error => (
    error.code === 'PORTFOLIO_SUITABILITY_VIOLATION'
      && error.violations[0].reasonCode === 'RISK_EXCEEDS_FINAL_SUITABILITY'
  ));
  assert.throws(() => assertPortfolioSuitable(conservativeFiveYear, ['PPF']), error => (
    error.code === 'PORTFOLIO_SUITABILITY_VIOLATION'
      && error.violations[0].reasonCode === 'LOCK_IN_EXCEEDS_HORIZON'
  ));
});

test('catalog-backed model keys retain explicit eligibility gates', () => {
  assert.throws(() => assertPortfolioSuitable(canonicalProfile({
    age: 59,
    monthlySavings: 2000,
  }), ['SCSS']), error => (
    error.code === 'PORTFOLIO_SUITABILITY_VIOLATION'
      && error.violations.some(violation => violation.reasonCode === 'MINIMUM_AGE_NOT_MET')
  ));

  assert.throws(() => assertPortfolioSuitable(canonicalProfile({
    age: 35,
    monthlySavings: 2000,
    investmentHorizonYears: 21,
  }), ['SSY']), error => (
    error.code === 'PORTFOLIO_SUITABILITY_VIOLATION'
      && error.violations.some(violation => violation.reasonCode === 'GIRL_CHILD_ELIGIBILITY_NOT_ESTABLISHED')
  ));

  assert.throws(() => assertPortfolioSuitable(canonicalProfile({
    age: 41,
    monthlySavings: 2000,
    investmentHorizonYears: 21,
  }), ['SSY']), error => (
    error.code === 'PORTFOLIO_SUITABILITY_VIOLATION'
      && error.violations.some(violation => violation.reasonCode === 'MAXIMUM_AGE_EXCEEDED')
  ));

  assert.doesNotThrow(() => assertPortfolioSuitable(canonicalProfile({
    age: 60,
    monthlySavings: 2000,
    investmentHorizonYears: 10,
  }), ['SCSS']));
});

test('ML and LLM DTOs contain only approved facts and deterministic derived outputs', () => {
  const suitability = assessSuitabilityRisk(canonicalProfile());
  const ml = buildMlProfileInput(canonicalProfile(), suitability);
  assert.equal(ml.feature_schema_version, 'recommendation-features-4.0.0');
  for (const forbidden of ['annual_income', 'total_ctc', 'sold_property_proceeds', 'tax_regime']) {
    assert.equal(forbidden in ml, false);
  }
  const llm = buildLlmFinancialContext(canonicalProfile(), suitability);
  assert.equal(llm.taxEligibilityStatus, 'NOT_EVALUATED');
  assert.equal('annualIncome' in llm, false);
  assert.equal('soldPropertyProceeds' in llm, false);
});

test('hashes require a model version and ignore all unauthorized raw fields', () => {
  const profile = canonicalProfile();
  assert.throws(() => buildRecommendationProfileHash(profile), /modelVersion is required/);
  const base = buildRecommendationProfileHash(profile, { modelVersion: 'model-4' });
  const noisy = buildRecommendationProfileHash({ ...profile, annualIncome: 1, goal_name: 'Injected' }, { modelVersion: 'model-4' });
  assert.equal(noisy, base);
  assert.notEqual(buildRecommendationProfileHash({ ...profile, age: 36 }, { modelVersion: 'model-4' }), base);
});

test('migration uses only equivalent aliases and refuses to guess from forbidden legacy fields', () => {
  const ready = planFinancialProfileMigration({
    _id: new mongoose.Types.ObjectId(), monthly_income: 100000, monthly_savings: 20000,
    age: 35, risk_tolerance: 'Moderate', sold_property_amount: 0, has_lump_sum: false,
    lump_sum_amount: 0, liquid_savings: 300000, existing_debt_emi_ratio_pct: 10,
    dependents: 1, emergency_fund_months: 6, goals: ['Wealth Growth'], investment_horizon: 10,
  });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.set.recommendationProfileVersion, FINANCIAL_PROFILE_SCHEMA_VERSION);
  assert.equal(ready.unset.monthly_income, '');
  assert.equal(ready.unset.existing_debt_emi_ratio_pct, '');
  const blocked = planFinancialProfileMigration({
    _id: new mongoose.Types.ObjectId(), annualIncome: 1200000, existing_debt: 10,
    goal_type: 'wealth-building', investableAmount: 20000,
  });
  assert.equal(blocked.status, 'manual_remediation_required');
  assert.ok(NEVER_INFER_FROM.every(field => typeof field === 'string'));
  assert.ok(blocked.ignoredNonEquivalentFields.includes('annualIncome'));
  for (const retired of LEGACY_FIELDS_TO_UNSET) {
    assert.equal(FinancialProfile.schema.path(retired), undefined, `${retired} must not remain a schema path`);
  }
});

test('custom goal transport remains separate and profile-bound', () => {
  const goal = {
    goal_name: 'Dream Studio', target_amount: 500000, target_date: '2030-01-01',
    current_savings: 10000, profileId: '64b000000000000000000001', priority: 'High',
  };
  assert.equal(customGoalSchema.validate(goal).error, undefined);
  assert.ok(customGoalSchema.validate({ ...goal, profileId: undefined }).error);
  assert.ok(customGoalSchema.validate({ ...goal, investment_goals: ['Retirement'] }).error);
});

test('projection, Monte Carlo, and parameter helpers reject missing assumptions', () => {
  assert.throws(() => computeCAGR(0, 100, 1), /initialValue/);
  assert.throws(() => generateProjections(1000, [{ name: 'FD', type: 'FD' }], {}, [1], 0.05, 0, 0), /annual rate/);
  assert.equal(getInstrumentVolatility('unknown'), null);
  assert.throws(() => runMonteCarloWithGoal({
    monthlyInvestment: 1000, annualExpectedReturn: 0.07, annualVolatility: 0.01,
    years: 1, simulations: 100, targetAmount: null,
  }), /currentSavings|inflationRate/);
});

test('post-tax calculation requires a complete, separate tax context', () => {
  assert.throws(() => calculatePostTaxReturn('FD', 0.07, 1000000, 3, 'new', 10000, 35), /incomeSource/);
  assert.throws(() => calculatePostTaxReturn('UNKNOWN', 0.07, 1000000, 3, 'new', 10000, 35, 'salary', true, 'FY2026-27'), /Unsupported instrument/);
});

test('agent tools label what-if calculations and enforce profile caps', async () => {
  const context = { profile: canonicalProfile() };
  const accepted = await FinancialToolRegistry.executeTool('sip_projection', {
    monthlyInvestment: 10000, annualRate: 0.1, years: 5,
  }, context);
  assert.equal(accepted.success, true);
  assert.equal(accepted.result.classification, 'NON_RECOMMENDATION_PROFILE_CONSTRAINED_WHAT_IF');
  const rejected = await FinancialToolRegistry.executeTool('sip_projection', {
    monthlyInvestment: 25000, annualRate: 0.1, years: 5,
  }, context);
  assert.equal(rejected.success, false);
  assert.match(rejected.error, /exceeds Financial Profile capacity/);
  const tax = await FinancialToolRegistry.executeTool('tax_calculator', {
    income: 1000000, incomeSource: 'salary', fiscalYear: 'FY2026-27', age: 35, regime: 'new', section80C: 0,
    nps80CCD1B: 0, section80D_self: 0, section80D_parents: 0,
    parentsSenior: false, hra: 0,
  });
  assert.equal(tax.success, true);
  assert.equal(tax.result.classification, 'SEPARATE_TAX_WHAT_IF');

  const conservativeContext = { profile: canonicalProfile({ riskTolerance: 'Conservative' }) };
  const unsafeOptimiser = await FinancialToolRegistry.executeTool('portfolio_optimizer', {
    strategy: 'max_sharpe', assets: ['Equity_MF', 'Debt_MF'],
  }, conservativeContext);
  assert.equal(unsafeOptimiser.success, false);
  assert.match(unsafeOptimiser.error, /outside the profile suitability boundary/);
  const unsafeRebalance = await FinancialToolRegistry.executeTool('rebalance_calculator', {
    current_allocation: { FD: 100000 }, target_allocation: { Equity_MF: 100 },
    threshold: 2, partial_ratio: 1, holding_months: 24,
  }, conservativeContext);
  assert.equal(unsafeRebalance.success, false);

  const ungroundedOptimiser = await FinancialToolRegistry.executeTool('portfolio_optimizer', {
    strategy: 'min_variance', assets: ['Equity_MF', 'Debt_MF'],
  });
  assert.equal(ungroundedOptimiser.success, true);
  assert.equal(ungroundedOptimiser.result.classification, 'NON_RECOMMENDATION_WHAT_IF');
});
