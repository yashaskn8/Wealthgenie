import assert from 'node:assert/strict';
import test from 'node:test';
import {
  postTaxReturnBatchSchema,
  postTaxReturnSchema,
  taxCompareSchema,
  taxComputeSchema,
  userDeclaredPostTaxScenarioSchema,
} from '../validation/schemas.js';
import { taxCalculationContextSchema } from '../validation/taxSchemas.js';
import { rankWtiProfileSchema } from '../validation/financialSchemas.js';

const MAX_ANNUAL_INCOME = 1_000_000_000;

test('tax request schemas accept the backend annual-income ceiling and reject values above it', () => {
  const sharedInputs = {
    income: MAX_ANNUAL_INCOME,
    incomeSource: 'salary',
    fiscalYear: 'FY2026-27',
    age: 35,
  };

  assert.equal(taxComputeSchema.validate({ ...sharedInputs, regime: 'new' }).error, undefined);
  assert.equal(taxCompareSchema.validate(sharedInputs).error, undefined);

  const invalidCompute = taxComputeSchema.validate({ ...sharedInputs, income: MAX_ANNUAL_INCOME + 1, regime: 'new' });
  const invalidCompare = taxCompareSchema.validate({ ...sharedInputs, income: MAX_ANNUAL_INCOME + 1 });
  assert.ok(invalidCompute.error?.details.some(detail => detail.path.join('.') === 'income'));
  assert.ok(invalidCompare.error?.details.some(detail => detail.path.join('.') === 'income'));
});

test('age-dependent savings-interest deductions require an explicit selected-year age', () => {
  const computeBase = {
    income: 1_000_000, incomeSource: 'salary', fiscalYear: 'FY2026-27', regime: 'new',
  };
  const contextBase = {
    annualGrossIncome: 1_000_000, incomeSource: 'salary', regime: 'new', fiscalYear: 'FY2026-27',
  };
  for (const field of ['savingsInterest', 'section80TTA', 'section80TTB']) {
    assert.ok(taxComputeSchema.validate({ ...computeBase, [field]: 1 }).error, `${field} requires age`);
    assert.equal(taxComputeSchema.validate({ ...computeBase, age: 45, [field]: 1 }).error, undefined);
    assert.equal(taxComputeSchema.validate({ ...computeBase, [field]: 0 }).error, undefined);

    assert.ok(taxCalculationContextSchema.validate({
      ...contextBase, deductions: { [field]: 1 },
    }).error, `${field} requires context userAge`);
    assert.equal(taxCalculationContextSchema.validate({
      ...contextBase, userAge: 45, deductions: { [field]: 1 },
    }).error, undefined);
    assert.equal(taxCalculationContextSchema.validate({
      ...contextBase, deductions: { [field]: 0 },
    }).error, undefined);
  }
});

test('transaction date integrity applies to partial WTI tax contexts', () => {
  assert.ok(taxCalculationContextSchema.validate({ acquisitionDate: '2026-01-01' }).error);
  assert.ok(taxCalculationContextSchema.validate({ redemptionDate: '2026-01-01' }).error);
  assert.ok(taxCalculationContextSchema.validate({
    acquisitionDate: '2026-02-30',
    redemptionDate: '2026-03-01',
  }).error);
  assert.ok(taxCalculationContextSchema.validate({
    acquisitionDate: '2026-01-02',
    redemptionDate: '2026-01-01',
  }).error);
  assert.equal(taxCalculationContextSchema.validate({
    acquisitionDate: '2026-01-01',
    redemptionDate: '2026-01-01',
  }).error, undefined);

  const rankRequest = {
    profileId: '507f1f77bcf86cd799439011',
    profileVersion: 1,
    recommendationId: '507f1f77bcf86cd799439012',
    expectedAllocationRevision: 1,
    expectedAllocationRevisionId: '507f1f77bcf86cd799439013',
    expectedPortfolioFingerprint: 'a'.repeat(64),
    expectedRecommendationFingerprint: 'b'.repeat(64),
    parentInstrumentId: 'large_cap_mf',
  };
  assert.equal(rankWtiProfileSchema.validate({
    ...rankRequest,
    taxCalculationContext: { illustrativePrincipal: 10_000 },
  }).error, undefined);
  assert.equal(rankWtiProfileSchema.validate({
    ...rankRequest,
    taxCalculationContext: { acquisitionDate: '2026-01-01', redemptionDate: '2026-01-01' },
  }).error, undefined);
  assert.ok(rankWtiProfileSchema.validate({
    ...rankRequest,
    taxCalculationContext: { annualGrossIncome: 1 },
  }).error);
});

test('single post-tax request enforces paired, real, chronological transaction dates', () => {
  const base = {
    instrumentType: 'FD', nominalRate: 0.07, holdingYears: 1, monthlySIP: 0,
    annualIncome: 1_000_000, regime: 'new', userAge: 35, incomeSource: 'salary', fiscalYear: 'FY2026-27',
  };
  assert.equal(postTaxReturnSchema.validate({
    ...base, acquisitionDate: '2026-01-01', redemptionDate: '2026-01-01',
  }).error, undefined);
  assert.ok(postTaxReturnSchema.validate({ ...base, acquisitionDate: '2026-01-01' }).error);
  assert.ok(postTaxReturnSchema.validate({ ...base, redemptionDate: '2026-01-01' }).error);
  assert.ok(postTaxReturnSchema.validate({
    ...base, acquisitionDate: '2026-02-30', redemptionDate: '2026-03-01',
  }).error);
  assert.ok(postTaxReturnSchema.validate({
    ...base, acquisitionDate: '2026-01-02', redemptionDate: '2026-01-01',
  }).error);
});

test('single post-tax text inputs are trimmed before Joi length validation', () => {
  const base = {
    instrumentType: ' FD ', nominalRate: 0.07, holdingYears: 1, monthlySIP: 0,
    annualIncome: 1_000_000, regime: 'new', userAge: 35, incomeSource: 'salary', fiscalYear: 'FY2026-27',
  };
  const normalized = postTaxReturnSchema.validate({ ...base, retirementTiming: '  after retirement  ' });
  assert.equal(normalized.error, undefined);
  assert.equal(normalized.value.instrumentType, 'FD');
  assert.equal(normalized.value.retirementTiming, 'after retirement');
  assert.ok(postTaxReturnSchema.validate({ ...base, instrumentType: '   ' }).error);
  assert.ok(postTaxReturnSchema.validate({ ...base, retirementTiming: '  ' }).error);
  assert.ok(postTaxReturnSchema.validate({ ...base, retirementTiming: ' X ' }).error,
    'minimum length applies after trimming surrounding whitespace');
});

test('tax request schemas reject ambiguous aggregate and granular Section 80D inputs', () => {
  const computeBase = {
    income: 1_000_000, incomeSource: 'salary', fiscalYear: 'FY2026-27', regime: 'old', age: 45,
  };
  const compareBase = { income: 1_000_000, incomeSource: 'salary', fiscalYear: 'FY2026-27', age: 45 };
  const postTaxBase = {
    instrumentType: 'FD', nominalRate: 0.07, holdingYears: 1, monthlySIP: 0,
    annualIncome: 1_000_000, regime: 'old', userAge: 45, incomeSource: 'salary', fiscalYear: 'FY2026-27',
  };
  const batchBase = {
    instruments: [{ instrumentType: 'FD', nominalRate: 0.07, holdingYears: 1, monthlySIP: 0 }],
    annualIncome: 1_000_000, regime: 'old', userAge: 45, incomeSource: 'salary', inflationRate: 0.02,
    fiscalYear: 'FY2026-27',
  };

  assert.equal(taxComputeSchema.validate({ ...computeBase, section80D: 50_000 }).error, undefined);
  assert.equal(taxComputeSchema.validate({ ...computeBase, section80D_self: 0 }).error, undefined);
  assert.equal(taxCompareSchema.validate({ ...compareBase, section80D_parents: 0 }).error, undefined);
  assert.ok(taxComputeSchema.validate({ ...computeBase, section80D: 50_000, section80D_self: 0 }).error);
  assert.ok(taxCompareSchema.validate({ ...compareBase, section80D: 50_000, section80D_parents: 0 }).error);
  assert.ok(postTaxReturnSchema.validate({ ...postTaxBase, deductions: { section80D: 50_000, section80D_self: 0 } }).error);
  assert.ok(postTaxReturnBatchSchema.validate({ ...batchBase, deductions: { section80D: 50_000, section80D_parents: 0 } }).error);
});

test('tax schemas require employer and parent-seniority facts for dependent deductions', () => {
  const computeBase = {
    income: 1_000_000, incomeSource: 'salary', fiscalYear: 'FY2026-27', regime: 'new',
  };
  assert.ok(taxComputeSchema.validate({ ...computeBase, nps80CCD2: 1 }).error);
  assert.equal(taxComputeSchema.validate({
    ...computeBase, nps80CCD2: 1, basicSalary: 500_000, isGovtEmployee: false,
  }).error, undefined);
  assert.ok(taxComputeSchema.validate({ ...computeBase, age: 45, section80D_parents: 1 }).error);
  assert.equal(taxComputeSchema.validate({
    ...computeBase, age: 45, section80D_parents: 1, parents_senior: false,
  }).error, undefined);

  const contextBase = {
    annualGrossIncome: 1_000_000,
    incomeSource: 'salary',
    regime: 'new',
    fiscalYear: 'FY2026-27',
  };
  assert.ok(taxCalculationContextSchema.validate({
    ...contextBase, deductions: { nps80CCD2: 1 },
  }).error);
  assert.equal(taxCalculationContextSchema.validate({
    ...contextBase,
    deductions: { nps80CCD2: 1, basicSalary: 500_000, isGovtEmployee: false },
  }).error, undefined);
  assert.ok(taxCalculationContextSchema.validate({
    ...contextBase, userAge: 45, deductions: { section80D_parents: 1 },
  }).error);
  assert.equal(taxCalculationContextSchema.validate({
    ...contextBase,
    userAge: 45,
    deductions: { section80D_parents: 1, parents_senior: false },
  }).error, undefined);

  const compareBase = {
    income: 1_000_000, incomeSource: 'salary', fiscalYear: 'FY2026-27', age: 45,
  };
  assert.ok(taxCompareSchema.validate({ ...compareBase, section80D_parents: 1 }).error);
  assert.equal(taxCompareSchema.validate({
    ...compareBase, section80D_parents: 1, parents_senior: false,
  }).error, undefined);
  assert.ok(taxCompareSchema.validate({ ...compareBase, nps80CCD2: 1 }).error);
  assert.equal(taxCompareSchema.validate({
    ...compareBase, nps80CCD2: 1, basicSalary: 500_000, isGovtEmployee: false,
  }).error, undefined);

  const postTaxBase = {
    instrumentType: 'FD', nominalRate: 0.07, holdingYears: 1, monthlySIP: 0,
    annualIncome: 1_000_000, regime: 'new', userAge: 45, incomeSource: 'salary', fiscalYear: 'FY2026-27',
  };
  assert.ok(postTaxReturnSchema.validate({ ...postTaxBase, deductions: { nps80CCD2: 1 } }).error);
  assert.equal(postTaxReturnSchema.validate({
    ...postTaxBase,
    deductions: { nps80CCD2: 1, basicSalary: 500_000, isGovtEmployee: false },
  }).error, undefined);
  assert.ok(postTaxReturnSchema.validate({ ...postTaxBase, deductions: { section80D_parents: 1 } }).error);
  assert.equal(postTaxReturnSchema.validate({
    ...postTaxBase,
    deductions: { section80D_parents: 1, parents_senior: false },
  }).error, undefined);
});

test('tax request schemas reject conflicting aliases for the Section 80CCD(1B) deduction', () => {
  const computeBase = {
    income: 1_000_000, incomeSource: 'salary', fiscalYear: 'FY2026-27', regime: 'old', age: 45,
  };
  const compareBase = {
    income: 1_000_000, incomeSource: 'salary', fiscalYear: 'FY2026-27', age: 45,
  };
  const postTaxBase = {
    instrumentType: 'FD', nominalRate: 0.07, holdingYears: 1, monthlySIP: 0,
    annualIncome: 1_000_000, regime: 'old', userAge: 45, incomeSource: 'salary', fiscalYear: 'FY2026-27',
  };
  const postTaxBatchBase = {
    instruments: [{ instrumentType: 'FD', nominalRate: 0.07, holdingYears: 1, monthlySIP: 0 }],
    annualIncome: 1_000_000, regime: 'old', userAge: 45, incomeSource: 'salary',
    inflationRate: 0.02, fiscalYear: 'FY2026-27',
  };
  const declaredScenarioBase = {
    canonicalInstrumentId: 'fd', scenarioType: 'INTEREST_INCOME', interestReceived: 10_000,
    annualGrossIncome: 1_000_000, incomeSource: 'salary', regime: 'old',
    fiscalYear: 'FY2026-27', userAge: 45,
  };
  const taxContextBase = {
    annualGrossIncome: 1_000_000, incomeSource: 'salary', regime: 'old',
    fiscalYear: 'FY2026-27', userAge: 45,
  };
  const conflictingAmounts = [
    { nps80CCD1B: 10_000, section80CCD: 20_000 },
    { section80CCD: 20_000, nps80CCD1B: 10_000 },
    { nps80CCD1B: 0, section80CCD: 50_000 },
    { section80CCD: 50_000, nps80CCD1B: 0 },
  ];

  for (const deductions of conflictingAmounts) {
    const computeResult = taxComputeSchema.validate({ ...computeBase, ...deductions });
    assert.ok(computeResult.error?.details.some(detail => detail.message.includes('NPS_80CCD1B_CONFLICTING_INPUTS')));

    const compareResult = taxCompareSchema.validate({ ...compareBase, ...deductions });
    assert.ok(compareResult.error?.details.some(detail => detail.message.includes('NPS_80CCD1B_CONFLICTING_INPUTS')));

    const postTaxResult = postTaxReturnSchema.validate({ ...postTaxBase, deductions });
    assert.ok(postTaxResult.error?.details.some(detail => detail.message.includes('NPS_80CCD1B_CONFLICTING_INPUTS')));

    const batchResult = postTaxReturnBatchSchema.validate({ ...postTaxBatchBase, deductions });
    assert.ok(batchResult.error?.details.some(detail => detail.message.includes('NPS_80CCD1B_CONFLICTING_INPUTS')));

    const scenarioResult = userDeclaredPostTaxScenarioSchema.validate({
      ...declaredScenarioBase, deductions,
    });
    assert.ok(scenarioResult.error?.details.some(detail => detail.message.includes('NPS_80CCD1B_CONFLICTING_INPUTS')));

    const contextResult = taxCalculationContextSchema.validate({ ...taxContextBase, deductions });
    assert.ok(contextResult.error?.details.some(detail => detail.message.includes('NPS_80CCD1B_CONFLICTING_INPUTS')));
  }

  for (const deductions of [
    { nps80CCD1B: 10_000, section80CCD: 10_000 },
    { nps80CCD1B: 10_000 },
    { section80CCD: 10_000 },
  ]) {
    assert.equal(taxComputeSchema.validate({ ...computeBase, ...deductions }).error, undefined);
    assert.equal(postTaxReturnSchema.validate({ ...postTaxBase, deductions }).error, undefined);
    assert.equal(postTaxReturnBatchSchema.validate({ ...postTaxBatchBase, deductions }).error, undefined);
    assert.equal(userDeclaredPostTaxScenarioSchema.validate({
      ...declaredScenarioBase, deductions,
    }).error, undefined);
    assert.equal(taxCalculationContextSchema.validate({ ...taxContextBase, deductions }).error, undefined);
  }
});

test('tax API age aliases reject conflicting request and deductions ages', () => {
  const postTaxBase = {
    instrumentType: 'FD', nominalRate: 0.07, holdingYears: 1, monthlySIP: 0,
    annualIncome: 1_000_000, regime: 'old', userAge: 45, incomeSource: 'salary', fiscalYear: 'FY2026-27',
  };
  const batchBase = {
    instruments: [{ instrumentType: 'FD', nominalRate: 0.07, holdingYears: 1, monthlySIP: 0 }],
    annualIncome: 1_000_000, regime: 'old', userAge: 45, incomeSource: 'salary', inflationRate: 0.02,
    fiscalYear: 'FY2026-27',
  };
  const equalAliases = { age: 45 };
  const conflictingAliases = { age: 46 };

  assert.equal(postTaxReturnSchema.validate({ ...postTaxBase, deductions: equalAliases }).error, undefined);
  assert.ok(postTaxReturnSchema.validate({ ...postTaxBase, deductions: conflictingAliases }).error
    ?.details.some(detail => detail.message.includes('USER_AGE_CONFLICTING_INPUTS')));
  assert.equal(postTaxReturnBatchSchema.validate({ ...batchBase, deductions: equalAliases }).error, undefined);
  assert.ok(postTaxReturnBatchSchema.validate({ ...batchBase, deductions: conflictingAliases }).error
    ?.details.some(detail => detail.message.includes('USER_AGE_CONFLICTING_INPUTS')));

  const declaredScenario = {
    canonicalInstrumentId: 'fd', scenarioType: 'INTEREST_INCOME', interestReceived: 10_000,
    annualGrossIncome: 1_000_000, incomeSource: 'salary', regime: 'old', fiscalYear: 'FY2026-27', userAge: 45,
  };
  assert.equal(userDeclaredPostTaxScenarioSchema.validate({ ...declaredScenario, deductions: equalAliases }).error, undefined);
  assert.ok(userDeclaredPostTaxScenarioSchema.validate({ ...declaredScenario, deductions: conflictingAliases }).error
    ?.details.some(detail => detail.message.includes('USER_AGE_CONFLICTING_INPUTS')));

  const context = {
    annualGrossIncome: 1_000_000, incomeSource: 'salary', regime: 'new', fiscalYear: 'FY2026-27',
  };
  assert.equal(taxCalculationContextSchema.validate({ ...context, userAge: 45, deductions: equalAliases }).error, undefined);
  assert.ok(taxCalculationContextSchema.validate({ ...context, userAge: 45, deductions: conflictingAliases }).error
    ?.details.some(detail => detail.message.includes('USER_AGE_CONFLICTING_INPUTS')));
  assert.equal(taxCalculationContextSchema.validate({ ...context, userAge: 45 }).error, undefined);
  assert.equal(taxCalculationContextSchema.validate({ ...context, deductions: equalAliases }).error, undefined);
});
