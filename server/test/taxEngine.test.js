import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CURRENT_FY,
  calculateTaxableIncome,
  computeTax as computeTaxForFiscalYear,
  computeTaxWithDeductions as computeTaxWithDeductionsForFiscalYear,
  getTaxSlab as getTaxSlabForFiscalYear,
  getTaxSlabsForFY,
  isFYVerified,
  compareTaxRegimes as compareTaxRegimesForFiscalYear,
  getEffectiveMarginalRate as getEffectiveMarginalRateForFiscalYear,
  buildTaxSlabBreakdown as buildTaxSlabBreakdownForFiscalYear,
  analyzeTaxOptimization as analyzeTaxOptimizationForFiscalYear,
} from '../services/taxEngine.js';
import { taxDeductionSchema } from '../validation/taxSchemas.js';

const TEST_FISCAL_YEAR = 'FY2026-27';
const withTaxAge = (regime, deductions = {}) => (
  regime === 'old' && deductions.age === undefined ? { ...deductions, age: 35 } : deductions
);
const computeTax = (income, regime, deductions, incomeSource, fiscalYear = TEST_FISCAL_YEAR) =>
  computeTaxForFiscalYear(income, regime, withTaxAge(regime, deductions), incomeSource, fiscalYear);
const computeTaxWithDeductions = (income, regime, deductions, incomeSource, fiscalYear = TEST_FISCAL_YEAR) =>
  computeTaxWithDeductionsForFiscalYear(income, regime, withTaxAge(regime, deductions), incomeSource, fiscalYear);
const getTaxSlab = (income, regime, deductions, incomeSource, fiscalYear = TEST_FISCAL_YEAR) =>
  getTaxSlabForFiscalYear(income, regime, withTaxAge(regime, deductions), incomeSource, fiscalYear);
const compareTaxRegimes = (income, deductions, incomeSource, fiscalYear = TEST_FISCAL_YEAR) =>
  compareTaxRegimesForFiscalYear(income, withTaxAge('old', deductions), incomeSource, fiscalYear);
const getEffectiveMarginalRate = (income, regime, deductions, incomeSource, fiscalYear = TEST_FISCAL_YEAR) =>
  getEffectiveMarginalRateForFiscalYear(income, regime, withTaxAge(regime, deductions), incomeSource, fiscalYear);

test('unclassified legacy other-deduction input cannot reduce taxable income', () => {
  assert.equal(taxDeductionSchema.validate({ other: 0 }).error, undefined);
  assert.ok(taxDeductionSchema.validate({ other: 20_000 }).error);
  assert.throws(
    () => calculateTaxableIncome(2_000_000, 'old', { other: 20_000, age: 30 }, 'salary', TEST_FISCAL_YEAR),
    /unclassified.*deduction/i,
  );
});
const buildTaxSlabBreakdown = (computation, fiscalYear = TEST_FISCAL_YEAR) =>
  buildTaxSlabBreakdownForFiscalYear(computation, fiscalYear);
const analyzeTaxOptimization = (income, deductions, incomeSource, fiscalYear = TEST_FISCAL_YEAR) =>
  analyzeTaxOptimizationForFiscalYear(income, withTaxAge('old', deductions), incomeSource, fiscalYear);

test('tax engine rejects conflicting 80CCD aliases and counts equal aliases once', () => {
  const conflictingAliases = { nps80CCD1B: 0, section80CCD: 50_000, age: 35 };
  assert.throws(
    () => calculateTaxableIncome(2_000_000, 'old', conflictingAliases, 'salary', TEST_FISCAL_YEAR),
    /80CCD.*conflicting amounts/,
  );
  assert.throws(
    () => computeTax(2_000_000, 'old', conflictingAliases, 'salary'),
    /80CCD.*conflicting amounts/,
  );

  const canonicalOnly = calculateTaxableIncome(2_000_000, 'old', {
    nps80CCD1B: 50_000,
    age: 35,
  }, 'salary', TEST_FISCAL_YEAR);
  const equalAliases = calculateTaxableIncome(2_000_000, 'old', {
    nps80CCD1B: 50_000,
    section80CCD: 50_000,
    age: 35,
  }, 'salary', TEST_FISCAL_YEAR);
  assert.equal(equalAliases.oldRegimeDeductions, canonicalOnly.oldRegimeDeductions);
  assert.equal(equalAliases.taxableIncome, canonicalOnly.taxableIncome);
});

test('tax optimization rejects conflicting 80CCD aliases and counts equal aliases once', () => {
  assert.throws(
    () => analyzeTaxOptimization(2_000_000, {
      nps80CCD1B: 0,
      section80CCD: 50_000,
      age: 35,
    }, 'salary', TEST_FISCAL_YEAR),
    /80CCD.*conflicting amounts/,
  );

  const canonicalOnly = analyzeTaxOptimization(2_000_000, {
    nps80CCD1B: 25_000,
    age: 35,
  }, 'salary', TEST_FISCAL_YEAR);
  const equalAliases = analyzeTaxOptimization(2_000_000, {
    nps80CCD1B: 25_000,
    section80CCD: 25_000,
    age: 35,
  }, 'salary', TEST_FISCAL_YEAR);
  assert.deepEqual(equalAliases.remaining, canonicalOnly.remaining);
  assert.equal(equalAliases.potentialSaving, canonicalOnly.potentialSaving);
  assert.equal(equalAliases.crossoverBreakpoint, canonicalOnly.crossoverBreakpoint);
});

test('new regime Section 87A rebate zeros tax at the FY2025-26 threshold', () => {
  const result = computeTax(1_275_000, 'new', {}, 'salary');
  assert.equal(result.taxableIncome, 1_200_000);
  assert.equal(result.taxAmount, 0);
  assert.equal(result.rebateApplied, true);
});

test('new regime marginal relief caps the rebate cliff immediately above threshold', () => {
  const result = computeTax(1_276_000, 'new', {}, 'salary');
  assert.equal(result.taxableIncome, 1_201_000);
  assert.equal(result.taxBeforeCess, 1_000);
  assert.equal(result.taxAmount, 1_040);
  assert.equal(result.marginalReliefApplied, true);
});

test('old regime applies granular Section 80D self and parent caps', () => {
  const result = calculateTaxableIncome(1_000_000, 'old', {
    section80D_self: 30_000,
    section80D_parents: 60_000,
    parents_senior: true,
    age: 35,
  }, 'salary');

  assert.equal(result.allowed80D, 75_000);
  assert.equal(result.oldRegimeDeductions, 75_000);
});

test('tax slabs are selected by fiscal-year key and unknown years fail closed', () => {
  const current = getTaxSlabsForFY(CURRENT_FY);
  const next = getTaxSlabsForFY('FY2026-27');

  assert.equal(current.new[1].rate, 0.05);
  assert.equal(next.new[1].rate, current.new[1].rate);
  assert.throws(() => getTaxSlabsForFY('UNKNOWN-FY'), /Verified tax slabs are unavailable/);
  assert.throws(
    () => computeTax(1_000_000, 'new', {}, 'salary', 'UNKNOWN-FY'),
    /Verified tax slabs are unavailable/,
  );
  assert.equal(getTaxSlab(3_000_000, 'new', {}, 'salary', CURRENT_FY), 0.30);
});

test('isFYVerified returns true for verified FYs and false for unverified or unknown FYs', () => {
  assert.equal(isFYVerified('FY2025-26'), true);
  assert.equal(isFYVerified('FY2026-27'), true);
  assert.equal(isFYVerified('UNKNOWN-FY'), false);
});

test('calculateTaxableIncome computes standard deduction based on income source', () => {
  // Salary
  const salNew = calculateTaxableIncome(1_000_000, 'new', {}, 'salary');
  assert.equal(salNew.standardDeduction, 75_000);
  assert.equal(salNew.taxableIncome, 925_000);

  const salOld = calculateTaxableIncome(1_000_000, 'old', { age: 35 }, 'salary');
  assert.equal(salOld.standardDeduction, 50_000);
  assert.equal(salOld.taxableIncome, 950_000);

  // Pension
  const penNew = calculateTaxableIncome(1_000_000, 'new', {}, 'pension');
  assert.equal(penNew.standardDeduction, 75_000);

  // Family Pension (min(income / 3, 25000) under the FY2025-26+ new regime)
  const famPenSmall = calculateTaxableIncome(30_000, 'new', {}, 'family_pension');
  assert.equal(famPenSmall.standardDeduction, 10_000);

  const famPenLarge = calculateTaxableIncome(300_000, 'new', {}, 'family_pension');
  assert.equal(famPenLarge.standardDeduction, 25_000);

  // Business / Other
  const biz = calculateTaxableIncome(1_000_000, 'new', {}, 'business');
  assert.equal(biz.standardDeduction, 0);
  assert.equal(biz.taxableIncome, 1_000_000);
});

test('calculateTaxableIncome computes Section 80CCD(2) employer NPS contributions for private vs govt employees', () => {
  // Private employee: the tax context must state salary facts explicitly.
  const pvtDefault = calculateTaxableIncome(1_000_000, 'new', {
    nps80CCD2: 60_000, basicSalary: 500_000, isGovtEmployee: false,
  }, 'salary');
  assert.equal(pvtDefault.nps80CCD2, 60_000);

  // Private employee explicit basic salary
  const pvtExplicit = calculateTaxableIncome(1_000_000, 'new', {
    basicSalary: 600_000, nps80CCD2: 70_000, isGovtEmployee: false,
  }, 'salary');
  // maxLimit = 84,000 -> allowed = 70,000 (requested contribution is lower)
  assert.equal(pvtExplicit.nps80CCD2, 70_000);

  // Government employee (14% of basic salary)
  const govt = calculateTaxableIncome(1_000_000, 'new', {
    basicSalary: 500_000, isGovtEmployee: true, nps80CCD2: 70_000,
  }, 'salary');
  // basicSalary = 500,000, maxLimit = 70,000 (14%) -> allowed = 70,000
  assert.equal(govt.nps80CCD2, 70_000);
});

test('calculateTaxableIncome applies old regime deductions (80C, 80CCD(1B), HRA, Home Loan Interest, 80EEA, 80TTA, 80TTB)', () => {
  // Age < 60 with 80TTA and explicit 80D self
  const young = calculateTaxableIncome(2_000_000, 'old', {
    section80C: 200_000, // capped at 150,000
    nps80CCD1B: 70_000, // capped at 50,000
    section80D_self: 30_000, // capped at 25,000 (non-senior)
    hra: 120_000,
    homeLoanInterest: 250_000, // capped at 200,000
    section80EEA: 200_000, // capped at 150,000
    savingsInterest: 15_000, // 80TTA capped at 10,000
    age: 30,
  }, 'salary');

  // Allowed: 150k + 50k + 25k + 120k + 200k + 150k + 10k = 705,000.
  assert.equal(young.allowed80D, 25_000);
  assert.equal(young.oldRegimeDeductions, 705_000);
  assert.equal(young.taxableIncome, 2_000_000 - 50_000 - 705_000);
  assert.throws(
    () => calculateTaxableIncome(2_000_000, 'old', { other: 20_000, age: 30 }, 'salary', TEST_FISCAL_YEAR),
    /unclassified.*deduction/i,
  );

  // Senior citizen (Age >= 60) with 80TTB
  const senior = calculateTaxableIncome(2_000_000, 'old', {
    section80D_self: 60_000, // capped at 50,000 (senior)
    savingsInterest: 60_000, // 80TTB capped at 50,000
    age: 65,
  }, 'salary');
  // Allowed 80D self (senior) = 50,000; allowed 80TTB = 50,000
  assert.equal(senior.allowed80D, 50_000);
  assert.equal(senior.oldRegimeDeductions, 100_000);
});

test('computeSurcharge and computeMarginalRelief handle high incomes under new vs old regime', () => {
  // ₹60 Lakhs (New Regime): 10% surcharge, base tax = 40k(5%) + 40k(10%) + 60k(15%) + 80k(20%) + 100k(25%) + 1.05M(30%) = 1.37M
  const res60LNew = computeTax(6_000_000, 'new', {}, 'business');
  assert.equal(res60LNew.surchargeApplied, true);
  assert.ok(res60LNew.surchargeAmount > 0);

  // ₹1.5 Crores (Old Regime): 15% surcharge
  const res150LOld = computeTax(15_000_000, 'old', {}, 'business');
  assert.equal(res150LOld.surchargeApplied, true);

  // ₹3.0 Crores (New Regime): 25% surcharge cap
  const res3CrNew = computeTax(30_000_000, 'new', {}, 'business');
  assert.equal(res3CrNew.surchargeApplied, true);

  // ₹6.0 Crores (Old Regime): 37% surcharge
  const res6CrOld = computeTax(60_000_000, 'old', {}, 'business');
  assert.equal(res6CrOld.surchargeApplied, true);

  // High income slightly above ₹50 Lakh threshold (triggers surcharge marginal relief)
  const res50L10kNew = computeTax(5_075_000, 'new', {}, 'business');
  assert.equal(res50L10kNew.marginalReliefApplied, true);
  assert.ok(res50L10kNew.marginalReliefAmount > 0);
});

test('computeTax rejects missing and invalid tax context and preserves its explicit alias', () => {
  assert.throws(() => computeTax(-500_000, 'new', {}, 'salary'), /annualIncome/);
  assert.throws(() => computeTax(1_000_000, 'invalid-regime', {}, 'salary'), /regime/);
  assert.throws(() => computeTax(1_000_000, 'new'), /incomeSource/);
  assert.throws(
    () => computeTaxForFiscalYear(1_000_000, 'old', {}, 'salary', TEST_FISCAL_YEAR),
    /USER_AGE_REQUIRED_FOR_OLD_REGIME/,
  );

  // Alias wrapper computeTaxWithDeductions returns identical breakdown
  const aliasRes = computeTaxWithDeductions(1_000_000, 'new', {}, 'salary');
  assert.equal(aliasRes.taxAmount, computeTax(1_000_000, 'new', {}, 'salary').taxAmount);
});

test('compareTaxRegimes recommends lower tax regime between new and old', () => {
  // High deductions make old regime better
  const resOldBetter = compareTaxRegimes(1_500_000, { section80C: 150_000, hra: 300_000, homeLoanInterest: 200_000 }, 'salary');
  assert.equal(resOldBetter.recommended, 'old');

  // No deductions make new regime better
  const resNewBetter = compareTaxRegimes(1_500_000, {}, 'salary');
  assert.equal(resNewBetter.recommended, 'new');
});

test('getEffectiveMarginalRate computes exact marginal tax impact of additional income', () => {
  // At ₹20L (business, no standard deduction), delta ±10k crosses the 20%→25% slab boundary at ₹20L.
  // highIncome=2,010,000 (25% slab), lowIncome=1,990,000 (20% slab)
  // deltaTax after cess = (202500*1.04 rounded) - (198000*1.04 rounded) = 210600 - 205920 = 4680
  // effectiveMarginal = 4680 / 20000 = 0.234
  const rate20L = getEffectiveMarginalRate(2_000_000, 'new', {}, 'business');
  assert.equal(rate20L, 0.234);

  // At ₹15L business income, firmly in the 15% slab (12L-16L). marginal = 0.15 * 1.04 = 0.156
  const rate15L = getEffectiveMarginalRate(1_500_000, 'new', {}, 'business');
  assert.equal(rate15L, 0.156);

  // At 0 income
  const rateZero = getEffectiveMarginalRate(0, 'new', {}, 'salary');
  assert.equal(rateZero, 0);
});

test('WG-040: getEffectiveMarginalRate notch artifact fix at Section 87A rebate cliffs', () => {
  // 1. ₹12,66,000 through ₹12,75,000 (new regime) -> assert === 0 for every value in range
  const testIncomesNewRegime = [1266000, 1268000, 1270000, 1272000, 1275000];
  for (const inc of testIncomesNewRegime) {
    const rate = getEffectiveMarginalRate(inc, 'new', {}, 'salary');
    assert.equal(rate, 0, `Income ₹${inc} (new regime) owes ₹0 tax under 87A rebate and must report 0 marginal rate, got ${rate}`);
  }

  // 2. ₹12,80,000 (new regime) -> assert > 0 (real tax liability starts here, ₹5,200)
  const rate1280k = getEffectiveMarginalRate(1280000, 'new', {}, 'salary');
  assert.ok(rate1280k > 0, `Income ₹12,80,000 (new regime) has real tax liability and must report > 0 marginal rate, got ${rate1280k}`);

  // 3. ₹5,50,000 (old regime) -> assert === 0 (₹0 tax owed under old regime rebate)
  const rate550kOld = getEffectiveMarginalRate(550000, 'old', {}, 'salary');
  assert.equal(rate550kOld, 0, `Income ₹5,50,000 (old regime) owes ₹0 tax under 87A rebate and must report 0 marginal rate, got ${rate550kOld}`);

  // 4. Regression: ₹10,00,000 (new regime) still === 0
  const rate10L = getEffectiveMarginalRate(1000000, 'new', {}, 'salary');
  assert.equal(rate10L, 0, 'Income ₹10,00,000 (new regime) must report 0 marginal rate');

  // 5. Regression: ₹30,00,000 (new regime) returns a normal, non-zero, non-clamped rate
  const rate30L = getEffectiveMarginalRate(3000000, 'new', {}, 'salary');
  assert.ok(rate30L > 0 && rate30L < 0.45, `Income ₹30,00,000 (new regime) must report normal marginal rate (0 < rate < 0.45), got ${rate30L}`);
});

test('computeTax exact tax amounts at new regime slab boundaries', () => {
  // ₹4L: entirely in 0% slab -> tax = 0 (below rebate too)
  const res4L = computeTax(400_000, 'new', {}, 'business');
  assert.equal(res4L.taxAmount, 0);

  // ₹8L: 0-4L @ 0% + 4L-8L @ 5% = 20,000; below 12L rebate threshold -> 0
  const res8L = computeTax(800_000, 'new', {}, 'business');
  assert.equal(res8L.taxAmount, 0);

  // ₹12L: 0-4L@0 + 4-8L@5%(20k) + 8-12L@10%(40k) = 60,000; rebate limit 12L -> 0
  const res12L = computeTax(1_200_000, 'new', {}, 'business');
  assert.equal(res12L.taxAmount, 0);

  // ₹12,75,000 salary: taxable = 12,75,000 - 75,000(SD) = 12,00,000 -> rebate applies -> 0
  const res1275K = computeTax(1_275_000, 'new', {}, 'salary');
  assert.equal(res1275K.taxAmount, 0);
  assert.equal(res1275K.rebateApplied, true);

  // ₹16L: 0-4L@0 + 4-8L@5%(20k) + 8-12L@10%(40k) + 12-16L@15%(60k) = 120,000
  // No rebate (> 12L). Tax + 4% cess = 120,000 * 1.04 = 124,800
  const res16L = computeTax(1_600_000, 'new', {}, 'business');
  assert.equal(res16L.taxBeforeCess, 120_000);
  assert.equal(res16L.taxAmount, 124_800);

  // ₹24L: base tax = 20k + 40k + 60k + 80k + 100k + 0 = 300,000
  // Wait: 0-4L@0 + 4-8L@5%(20k) + 8-12L@10%(40k) + 12-16L@15%(60k) + 16-20L@20%(80k) + 20-24L@25%(100k) = 300,000
  const res24L = computeTax(2_400_000, 'new', {}, 'business');
  assert.equal(res24L.taxBeforeCess, 300_000);

  // ₹30L: above ₹24L at 30%: 300k + (30L-24L)@30% = 300k + 180k = 480k
  const res30L = computeTax(3_000_000, 'new', {}, 'business');
  assert.equal(res30L.taxBeforeCess, 480_000);
});

test('computeTax exact tax amounts at old regime slab boundaries', () => {
  // ₹2.5L: 0% slab -> 0
  const res25L = computeTax(250_000, 'old', {}, 'business');
  assert.equal(res25L.taxAmount, 0);

  // ₹5L: 0-2.5L@0 + 2.5-5L@5%(12,500) = 12,500; rebate applies under old regime (≤5L) -> 0
  const res5L = computeTax(500_000, 'old', {}, 'business');
  assert.equal(res5L.taxAmount, 0);
  assert.equal(res5L.rebateApplied, true);

  // ₹10L: 0-2.5L@0 + 2.5-5L@5%(12.5k) + 5-10L@20%(100k) = 112,500
  const res10L = computeTax(1_000_000, 'old', {}, 'business');
  assert.equal(res10L.taxBeforeCess, 112_500);

  // ₹15L: 112.5k + 5L@30%(150k) = 262,500
  const res15L = computeTax(1_500_000, 'old', {}, 'business');
  assert.equal(res15L.taxBeforeCess, 262_500);
});

test('getTaxSlab returns exact marginal rate at each new regime slab transition', () => {
  // Below ₹4L -> 0
  assert.equal(getTaxSlab(300_000, 'new', {}, 'business'), 0);

  // At ₹4L boundary -> 0% (since income exactly at 4L, taxable in 0% slab)
  assert.equal(getTaxSlab(400_000, 'new', {}, 'business'), 0);

  // ₹6L -> 5% slab
  assert.equal(getTaxSlab(600_000, 'new', {}, 'business'), 0.05);

  // ₹8L -> 5% (at boundary)
  assert.equal(getTaxSlab(800_000, 'new', {}, 'business'), 0.05);

  // ₹10L -> 10% slab
  assert.equal(getTaxSlab(1_000_000, 'new', {}, 'business'), 0.10);

  // ₹14L -> 15% slab
  assert.equal(getTaxSlab(1_400_000, 'new', {}, 'business'), 0.15);

  // ₹18L -> 20% slab
  assert.equal(getTaxSlab(1_800_000, 'new', {}, 'business'), 0.20);

  // ₹22L -> 25% slab
  assert.equal(getTaxSlab(2_200_000, 'new', {}, 'business'), 0.25);

  // ₹30L -> 30% slab
  assert.equal(getTaxSlab(3_000_000, 'new', {}, 'business'), 0.30);
});

test('getTaxSlab returns exact marginal rate for old regime slabs', () => {
  assert.equal(getTaxSlab(200_000, 'old', {}, 'business'), 0);
  assert.equal(getTaxSlab(400_000, 'old', {}, 'business'), 0.05);
  assert.equal(getTaxSlab(700_000, 'old', {}, 'business'), 0.20);
  assert.equal(getTaxSlab(1_500_000, 'old', {}, 'business'), 0.30);
});

test('computeTax surcharge rates at exact thresholds for both regimes', () => {
  // New regime surcharge tiers
  // ₹50L + 1: 10% surcharge
  const n50L = computeTax(5_000_001, 'new', {}, 'business');
  assert.equal(n50L.surchargeApplied, true);

  // ₹1Cr + 1: 15% surcharge
  const n1Cr = computeTax(10_000_001, 'new', {}, 'business');
  assert.equal(n1Cr.surchargeApplied, true);

  // ₹2Cr + 1: 25% surcharge (capped at 25% for new regime)
  const n2Cr = computeTax(20_000_001, 'new', {}, 'business');
  assert.equal(n2Cr.surchargeApplied, true);

  // Old regime surcharge tiers
  // ₹50L + 1: 10%
  const o50L = computeTax(5_000_001, 'old', {}, 'business');
  assert.equal(o50L.surchargeApplied, true);

  // ₹2Cr + 1: 25%
  const o2Cr = computeTax(20_000_001, 'old', {}, 'business');
  assert.equal(o2Cr.surchargeApplied, true);

  // ₹5Cr + 1: 37% (old regime only)
  const o5Cr = computeTax(50_000_001, 'old', {}, 'business');
  assert.equal(o5Cr.surchargeApplied, true);

  // Below ₹50L: no surcharge
  const below50L = computeTax(4_999_999, 'new', {}, 'business');
  assert.equal(below50L.surchargeApplied, false);
});

test('compareTaxRegimes returns exact savings between regimes', () => {
  // No deductions: new regime always better
  const noDeduct = compareTaxRegimes(1_000_000, {}, 'salary');
  assert.equal(noDeduct.recommended, 'new');
  assert.ok(typeof noDeduct.newRegime.taxAmount === 'number');
  assert.ok(typeof noDeduct.oldRegime.taxAmount === 'number');
  // New should have lower or equal tax
  assert.ok(noDeduct.newRegime.taxAmount <= noDeduct.oldRegime.taxAmount);

  // Heavy deductions: old regime better
  const heavyDeduct = compareTaxRegimes(2_000_000, {
    section80C: 150_000,
    hra: 300_000,
    homeLoanInterest: 200_000,
    section80D_self: 25_000,
    nps80CCD1B: 50_000,
    age: 35,
  }, 'salary');
  assert.equal(heavyDeduct.recommended, 'old');
  assert.ok(heavyDeduct.oldRegime.taxAmount < heavyDeduct.newRegime.taxAmount);
});

test('computeSurcharge exact rates for all 4 tiers in old regime vs 3 tiers in new regime', () => {
  // Tier 1: 50L < income <= 1Cr (10% surcharge)
  const new50L = computeTax(7_500_000, 'new', {}, 'business');
  assert.equal(new50L.surchargeAmount, Math.round(new50L.taxBeforeCess * 0.10));

  const old50L = computeTax(7_500_000, 'old', {}, 'business');
  assert.equal(old50L.surchargeAmount, Math.round(old50L.taxBeforeCess * 0.10));

  // Tier 2: 1Cr < income <= 2Cr (15% surcharge)
  const new1Cr = computeTax(15_000_000, 'new', {}, 'business');
  assert.equal(new1Cr.surchargeAmount, Math.round(new1Cr.taxBeforeCess * 0.15));

  const old1Cr = computeTax(15_000_000, 'old', {}, 'business');
  assert.equal(old1Cr.surchargeAmount, Math.round(old1Cr.taxBeforeCess * 0.15));

  // Tier 3: 2Cr < income <= 5Cr (25% surcharge)
  const new2Cr = computeTax(30_000_000, 'new', {}, 'business');
  assert.equal(new2Cr.surchargeAmount, Math.round(new2Cr.taxBeforeCess * 0.25));

  const old2Cr = computeTax(30_000_000, 'old', {}, 'business');
  assert.equal(old2Cr.surchargeAmount, Math.round(old2Cr.taxBeforeCess * 0.25));

  // Tier 4: income > 5Cr (New regime capped at 25%, Old regime 37%)
  const new5Cr = computeTax(60_000_000, 'new', {}, 'business');
  assert.equal(new5Cr.surchargeAmount, Math.round(new5Cr.taxBeforeCess * 0.25));

  const old5Cr = computeTax(60_000_000, 'old', {}, 'business');
  assert.equal(old5Cr.surchargeAmount, Math.round(old5Cr.taxBeforeCess * 0.37));
});

test('computeMarginalRelief at 50L, 1Cr, 2Cr, and 5Cr thresholds', () => {
  // Threshold 1: ₹50,05,000 (New & Old)
  const m50L = computeTax(5_005_000, 'new', {}, 'business');
  assert.equal(m50L.marginalReliefApplied, true);
  assert.ok(m50L.marginalReliefAmount > 0);

  // Threshold 2: ₹1,00,05,000 (Old regime)
  const m1Cr = computeTax(10_005_000, 'old', {}, 'business');
  assert.equal(m1Cr.marginalReliefApplied, true);
  assert.ok(m1Cr.marginalReliefAmount > 0);

  // Threshold 3: ₹2,00,05,000 (Old regime)
  const m2Cr = computeTax(20_005_000, 'old', {}, 'business');
  assert.equal(m2Cr.marginalReliefApplied, true);
  assert.ok(m2Cr.marginalReliefAmount > 0);

  // Threshold 4: ₹5,00,05,000 (Old regime 37% threshold)
  const m5Cr = computeTax(50_005_000, 'old', {}, 'business');
  assert.equal(m5Cr.marginalReliefApplied, true);
  assert.ok(m5Cr.marginalReliefAmount > 0);
});

test('calculateTaxableIncome section80D fallback and self_senior flag', () => {
  // section80D fallback when section80D_self and section80D_parents are not provided
  const fallback80D = calculateTaxableIncome(1_000_000, 'old', { section80D: 120_000, age: 35 }, 'salary');
  assert.equal(fallback80D.allowed80D, 100_000); // capped at 100,000

  // self_senior boolean flag overrides age
  const seniorFlag = calculateTaxableIncome(1_000_000, 'old', { section80D_self: 60_000, self_senior: true, age: 30 }, 'salary');
  assert.equal(seniorFlag.allowed80D, 50_000); // senior cap applied

  assert.throws(
    () => calculateTaxableIncome(1_000_000, 'old', { section80D: 50_000, section80D_self: 0, age: 30 }, 'salary'),
    /cannot be combined/,
  );
});

test('calculateTaxableIncome savingsInterest 80TTA vs 80TTB age boundaries', () => {
  // Age 59: 80TTA applies (capped at 10,000)
  const age59 = calculateTaxableIncome(1_000_000, 'old', { savingsInterest: 20_000, age: 59 }, 'salary');
  assert.equal(age59.oldRegimeDeductions, 10_000);

  // Age 60: 80TTB applies (capped at 50,000)
  const age60 = calculateTaxableIncome(1_000_000, 'old', { savingsInterest: 60_000, age: 60 }, 'salary');
  assert.equal(age60.oldRegimeDeductions, 50_000);
});

test('computeTax zero/invalid/NaN income, effectiveRate precision', () => {
  // Zero income
  const zeroRes = computeTax(0, 'new', {}, 'salary');
  assert.equal(zeroRes.taxAmount, 0);
  assert.equal(zeroRes.effectiveRate, 0);

  assert.throws(() => computeTax(NaN, 'new', {}, 'salary'), /annualIncome/);

  // Positive income effective rate calculation
  const posRes = computeTax(2_000_000, 'new', {}, 'business');
  const expectedEff = parseFloat(((posRes.taxAmount / 2_000_000) * 100).toFixed(2));
  assert.equal(posRes.effectiveRate, expectedEff);
});

test('tax helpers reject incomplete or invalid contexts', () => {
  assert.throws(() => getTaxSlab(1_000_000, 'invalid_regime', {}, 'salary'), /regime/);
  assert.throws(() => getTaxSlab(NaN, 'new', {}, 'salary'), /annualIncome/);
  assert.throws(() => getTaxSlab(-500_000, 'new', {}, 'salary'), /annualIncome/);
  assert.throws(() => compareTaxRegimes(NaN, {}, 'salary'), /annualIncome/);
  assert.throws(() => compareTaxRegimes(-100_000, {}, 'salary'), /annualIncome/);
  assert.throws(() => compareTaxRegimes(1_000_000, {}), /incomeSource/);

  // computeTaxWithDeductions with different income sources
  const pensionTax = computeTaxWithDeductions(1_000_000, 'new', {}, 'pension');
  const bizTax = computeTaxWithDeductions(1_000_000, 'new', {}, 'business');
  assert.ok(typeof pensionTax.taxAmount === 'number');
  assert.ok(typeof bizTax.taxAmount === 'number');
  // Salary/pension has standard deduction, business does not
  assert.ok(pensionTax.taxAmount <= bizTax.taxAmount);
});

test('server owns slab presentation rows and exact 80C/NPS optimization', () => {
  const current = computeTax(2_000_000, 'old', {
    section80C: 25_000,
    nps80CCD1B: 10_000,
    age: 40,
  }, 'salary');
  const rows = buildTaxSlabBreakdown(current);
  assert.ok(rows.some(row => row.rate === 30));
  assert.deepEqual(rows.at(-1), {
    label: 'Your Total Tax',
    rate: '',
    taxableInSlab: current.taxableIncome,
    taxInSlab: current.taxAmount,
    isTotalRow: true,
  });

  const optimization = analyzeTaxOptimization(2_000_000, {
    section80C: 25_000,
    nps80CCD1B: 10_000,
    age: 40,
  }, 'salary');
  assert.deepEqual(optimization.remaining, { section80C: 125_000, section80CCD1B: 40_000 });
  assert.equal(optimization.deductionLimits.section80DParents, null);
  assert.equal(optimization.potentialSaving, current.taxAmount - optimization.optimizedOld.taxAmount);
  assert.ok(optimization.optimizedOld.taxAmount <= current.taxAmount);
});
