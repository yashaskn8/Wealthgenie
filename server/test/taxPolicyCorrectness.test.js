import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateTaxableIncome,
  computeCapitalGainsTaxBuckets,
  computeTax,
  getTaxPolicyCatalog,
  getTaxPolicyMetadata,
} from '../services/taxEngine.js';

const OLD_FY = 'FY2025-26';
const CURRENT_FY = 'FY2026-27';

test('FY2025-26 maps to AY2026-27 Section 87A policy and applies the actual boundary', () => {
  const policy = getTaxPolicyMetadata(OLD_FY);
  assert.equal(policy.rules.newRegime87ALimit, 1_200_000);
  assert.equal(policy.rules.newRegime87ARebate, 60_000);

  const below = computeTax(1_199_999, 'new', {}, 'business', OLD_FY);
  const exact = computeTax(1_200_000, 'new', {}, 'business', OLD_FY);
  const above = computeTax(1_200_001, 'new', {}, 'business', OLD_FY);
  assert.equal(below.taxAmount, 0);
  assert.equal(exact.taxAmount, 0);
  assert.equal(above.taxAmount, 1);
  assert.equal(above.marginalReliefApplied, true);
});

test('FY2024-25 and FY2025-26 are not confused in the verified policy catalog', () => {
  const catalog = getTaxPolicyCatalog();
  assert.equal(catalog.currentFiscalYear, CURRENT_FY);
  assert.ok(catalog.verifiedFiscalYears.includes(OLD_FY));
  assert.ok(catalog.verifiedFiscalYears.includes(CURRENT_FY));
  assert.equal(getTaxPolicyMetadata(OLD_FY).policyVersion, 'tax-policy-FY2025-26-v2');
  assert.throws(() => getTaxPolicyMetadata('FY2024-25'), error => error.code === 'FISCAL_YEAR_UNSUPPORTED');
  assert.throws(() => getTaxPolicyMetadata('FY2027-28'), error => error.code === 'FISCAL_YEAR_UNSUPPORTED');
});

test('old-regime basic exemption changes at ages 60 and 80', () => {
  const age59 = computeTax(600_000, 'old', { age: 59 }, 'business', CURRENT_FY);
  const age60 = computeTax(600_000, 'old', { age: 60 }, 'business', CURRENT_FY);
  const age79 = computeTax(600_000, 'old', { age: 79 }, 'business', CURRENT_FY);
  const age80 = computeTax(600_000, 'old', { age: 80 }, 'business', CURRENT_FY);

  assert.ok(age59.taxBeforeCess > age60.taxBeforeCess);
  assert.equal(age60.taxBeforeCess, age79.taxBeforeCess);
  assert.ok(age79.taxBeforeCess > age80.taxBeforeCess);
  assert.throws(
    () => computeTax(600_000, 'old', {}, 'business', CURRENT_FY),
    /USER_AGE_REQUIRED_FOR_OLD_REGIME/,
  );
});

test('special-rate gains fail closed when residency could change the basic-exemption result', () => {
  for (const fiscalYear of [OLD_FY, CURRENT_FY]) {
    const result = computeCapitalGainsTaxBuckets({
      longTerm112AGain: 600_000,
      annualIncome: 0,
      regime: 'new',
      incomeSource: 'other',
      fiscalYear,
    });
    assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(result.taxAmount, null);
    assert.deepEqual(result.unavailableReasons, ['TAX_RESIDENCY_REQUIRED_FOR_BASIC_EXEMPTION_INTERACTION']);
  }

  const noBasicExemptionHeadroom = computeCapitalGainsTaxBuckets({
    longTerm112AGain: 600_000,
    annualIncome: 500_000,
    regime: 'new',
    incomeSource: 'other',
    fiscalYear: CURRENT_FY,
  });
  assert.equal(noBasicExemptionHeadroom.status, 'CALCULATED');
  assert.equal(noBasicExemptionHeadroom.taxable112A, 475_000);
});

test('family-pension deduction is fiscal-year and regime policy, not a universal magic number', () => {
  for (const fiscalYear of [OLD_FY, CURRENT_FY]) {
    const belowNew = calculateTaxableIncome(30_000, 'new', {}, 'family_pension', fiscalYear);
    const belowOld = calculateTaxableIncome(30_000, 'old', { age: 35 }, 'family_pension', fiscalYear);
    const cappedNew = calculateTaxableIncome(90_000, 'new', {}, 'family_pension', fiscalYear);
    const cappedOld = calculateTaxableIncome(90_000, 'old', { age: 35 }, 'family_pension', fiscalYear);
    const zeroNew = calculateTaxableIncome(0, 'new', {}, 'family_pension', fiscalYear);

    assert.equal(belowNew.standardDeduction, 10_000);
    assert.equal(belowOld.standardDeduction, 10_000);
    assert.equal(cappedNew.standardDeduction, 25_000);
    assert.equal(cappedOld.standardDeduction, 15_000);
    assert.equal(zeroNew.standardDeduction, 0);
  }
  assert.throws(
    () => calculateTaxableIncome(90_000, 'new', {}, 'family_pension', 'FY2027-28'),
    error => error.code === 'FISCAL_YEAR_UNSUPPORTED',
  );
});

test('Section 80CCD(2) uses fiscal policy for government and regime-specific private limits', () => {
  for (const fiscalYear of [OLD_FY, CURRENT_FY]) {
    const governmentOld = calculateTaxableIncome(2_000_000, 'old', {
      nps80CCD2: 200_000, basicSalary: 1_000_000, isGovtEmployee: true, age: 35,
    }, 'salary', fiscalYear);
    const governmentNew = calculateTaxableIncome(2_000_000, 'new', {
      nps80CCD2: 200_000, basicSalary: 1_000_000, isGovtEmployee: true,
    }, 'salary', fiscalYear);
    const privateOld = calculateTaxableIncome(2_000_000, 'old', {
      nps80CCD2: 200_000, basicSalary: 1_000_000, isGovtEmployee: false, age: 35,
    }, 'salary', fiscalYear);
    const privateNew = calculateTaxableIncome(2_000_000, 'new', {
      nps80CCD2: 200_000, basicSalary: 1_000_000, isGovtEmployee: false,
    }, 'salary', fiscalYear);

    assert.equal(governmentOld.nps80CCD2, 140_000);
    assert.equal(governmentNew.nps80CCD2, 140_000);
    assert.equal(privateOld.nps80CCD2, 100_000);
    assert.equal(privateNew.nps80CCD2, 140_000);

    const underLimit = calculateTaxableIncome(2_000_000, 'new', {
      nps80CCD2: 50_000, basicSalary: 1_000_000, isGovtEmployee: false,
    }, 'salary', fiscalYear);
    assert.equal(underLimit.nps80CCD2, 50_000);
  }

  assert.throws(
    () => calculateTaxableIncome(2_000_000, 'new', { nps80CCD2: 1_000, isGovtEmployee: false }, 'salary', CURRENT_FY),
    /basicSalary and isGovtEmployee/,
  );
  assert.throws(
    () => calculateTaxableIncome(2_000_000, 'new', { nps80CCD2: 1_000, basicSalary: 1_000_000 }, 'salary', CURRENT_FY),
    /basicSalary and isGovtEmployee/,
  );
  assert.throws(
    () => calculateTaxableIncome(2_000_000, 'new', { nps80CCD2: 1_000, basicSalary: 1_000_000, isGovtEmployee: false }, 'salary', 'FY2027-28'),
    error => error.code === 'FISCAL_YEAR_UNSUPPORTED',
  );
});

test('health and education cess is applied once to tax plus surcharge', () => {
  const result = computeTax(1_600_000, 'new', {}, 'business', CURRENT_FY);
  assert.equal(result.cess, Math.round(result.taxBeforeCess * 0.04));
  assert.equal(result.taxAmount, result.taxBeforeCess + result.cess);
});
