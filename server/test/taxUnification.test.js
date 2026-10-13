import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyHoldingPeriodByDates,
  getCurrentFiscalYear,
} from '../services/taxEngine.js';
import {
  buildMonthlySipLots,
  calculateCanonicalPostTaxOutcome,
} from '../services/taxEventProjectionEngine.js';
import {
  calculatePostTaxProjection,
  calculatePostTaxReturn,
} from '../services/postTaxCalculator.js';

const FY = 'FY2026-27';

test('holding-period classification uses exact calendar dates at the boundary', () => {
  const before = classifyHoldingPeriodByDates({
    acquisitionDate: '2024-04-01', redemptionDate: '2025-03-31', thresholdMonths: 12,
  });
  const exact = classifyHoldingPeriodByDates({
    acquisitionDate: '2024-04-01', redemptionDate: '2025-04-01', thresholdMonths: 12,
  });
  const after = classifyHoldingPeriodByDates({
    acquisitionDate: '2024-04-01', redemptionDate: '2025-04-02', thresholdMonths: 12,
  });
  assert.equal(before.isLongTerm, false);
  assert.equal(exact.isLongTerm, false);
  assert.equal(after.isLongTerm, true);
  assert.equal(exact.holdingPeriodBasis, 'EXACT_TRANSACTION_DATES');
});

test('fiscal year uses Asia/Kolkata date parts and does not freeze at module load', () => {
  assert.equal(getCurrentFiscalYear(new Date('2026-03-31T17:00:00.000Z')), 'FY2025-26');
  assert.equal(getCurrentFiscalYear(new Date('2026-03-31T20:00:00.000Z')), 'FY2026-27');
});

test('ambiguous generic instruments fail closed instead of inheriting equity or debt tax law', () => {
  const result = calculatePostTaxReturn('ETF', 0.12, 1_500_000, 5, 'new', 10_000, 35, 'salary', undefined, FY);
  assert.equal(result.status, 'MODEL_TAX_CLASS_UNAVAILABLE');
  assert.equal(result.postTaxReturn, null);
  assert.match(result.unavailableReasons[0], /MODEL_TAX_CLASS_UNAVAILABLE/);
  assert.equal(calculatePostTaxReturn('Balanced_Advantage', 0.1, 5_000_000, 5, 'new', 10_000, 35, 'salary', undefined, FY).status, 'MODEL_TAX_CLASS_UNAVAILABLE');
  assert.equal(calculatePostTaxReturn('Debt_MF', 0.07, 5_000_000, 5, 'new', 10_000, 35, 'salary', undefined, FY).status, 'MODEL_TAX_CLASS_UNAVAILABLE');
});

test('equity projection requires explicit prior 112A exemption usage and accepts zero', () => {
  const shared = {
    instrumentType: 'Equity_MF', nominalRate: 0.12, annualIncome: 1_500_000,
    holdingYears: 2, regime: 'new', monthlySIP: 10_000, userAge: 35,
    incomeSource: 'salary', fiscalYear: FY, deductions: {},
  };
  const missing = calculateCanonicalPostTaxOutcome({ ...shared, options: {} });
  assert.equal(missing.status, 'REQUIRES_TAX_INPUTS');
  assert.equal(missing.postTaxReturn, null);
  assert.ok(missing.unavailableReasons.includes('section112AExemptionUsed'));

  const explicitZero = calculateCanonicalPostTaxOutcome({
    ...shared,
    options: { section112AExemptionUsed: 0 },
  });
  assert.equal(explicitZero.status, 'CALCULATED');
});

test('SIP lots retain FIFO acquisition order and produce mixed short/long buckets', () => {
  const lots = buildMonthlySipLots({ monthlySIP: 10_000, annualRate: 0.12, holdingYears: 2 });
  assert.equal(lots.length, 24);
  assert.equal(lots[0].lotNumber, 1);
  assert.equal(lots.at(-1).lotNumber, 24);
  assert.ok(lots.some(lot => lot.holdingPeriodMonths < 12));
  assert.ok(lots.some(lot => lot.holdingPeriodMonths > 12));
  const outcome = calculateCanonicalPostTaxOutcome({
    instrumentType: 'Equity_MF', nominalRate: 0.12, annualIncome: 1_500_000,
    holdingYears: 2, regime: 'new', monthlySIP: 10_000, userAge: 35,
    incomeSource: 'salary', fiscalYear: FY, deductions: {}, options: { section112AExemptionUsed: 0 },
  });
  assert.equal(outcome.status, 'CALCULATED');
  assert.ok(outcome.shortTermGain > 0);
  assert.ok(outcome.longTermGain > 0);
  assert.ok(outcome.lots.every(lot => lot.cost === 10_000));
});

test('equity tax requires explicit annual Section 112A usage; explicit zero remains a valid input', () => {
  const base = {
    instrumentType: 'Equity_MF', nominalRate: 0.12, annualIncome: 1_500_000,
    holdingYears: 2, regime: 'new', monthlySIP: 10_000, userAge: 35,
    incomeSource: 'salary', fiscalYear: FY, deductions: {},
  };
  const missing = calculateCanonicalPostTaxOutcome({ ...base, options: {} });
  assert.equal(missing.status, 'REQUIRES_TAX_INPUTS');
  assert.equal(missing.postTaxReturn, null);
  assert.ok(missing.unavailableReasons.includes('section112AExemptionUsed'));

  const explicitZero = calculateCanonicalPostTaxOutcome({ ...base, options: { section112AExemptionUsed: 0 } });
  assert.equal(explicitZero.status, 'CALCULATED');
  assert.ok(Number.isFinite(explicitZero.exemptionApplied));

  const fullyUsed = calculateCanonicalPostTaxOutcome({ ...base, options: { section112AExemptionUsed: 125_000 } });
  assert.equal(fullyUsed.status, 'CALCULATED');
  assert.equal(fullyUsed.exemptionApplied, 0);

  const legacyMissing = calculatePostTaxReturn(
    'Equity_MF', 0.12, 1_500_000, 2, 'new', 10_000, 35, 'salary', undefined, FY,
  );
  assert.equal(legacyMissing.status, 'REQUIRES_TAX_INPUTS');
  assert.equal(legacyMissing.postTaxReturn, null);
  assert.ok(legacyMissing.unavailableReasons.includes('section112AExemptionUsed'));
});

test('equity projection requires the same explicit Section 112A usage as its calculation', () => {
  const result = calculatePostTaxReturn(
    'Equity_MF', 0.12, 3_000_000, 2, 'new', 10_000, 35, 'salary', undefined, FY,
    { section112AExemptionUsed: 0 },
  );
  const instrument = { nominalRate: 0.12, monthlySIP: 10_000, holdingYears: 2 };
  const context = {
    annualGrossIncome: 3_000_000, regime: 'new', incomeSource: 'salary',
    fiscalYear: FY, userAge: 35, deductions: {},
  };
  const missing = calculatePostTaxProjection(result, instrument, 0.06, context);
  assert.equal(missing.status, 'MODELLED_POST_TAX_PROJECTION_UNAVAILABLE');
  assert.equal(missing.postTaxFutureValue, null);
  assert.ok(missing.unavailableReasons.includes('section112AExemptionUsed'));

  const explicitZero = calculatePostTaxProjection(result, instrument, 0.06, {
    ...context, section112AExemptionUsed: 0,
  });
  assert.equal(explicitZero.status, 'CALCULATED');
  assert.ok(Number.isFinite(explicitZero.postTaxFutureValue));
});

test('modeled SIP lots use more-than threshold for 11, 12, and 13 month listed holdings', () => {
  const outcome = calculateCanonicalPostTaxOutcome({
    instrumentType: 'Equity_MF', nominalRate: 0.12, annualIncome: 1_500_000,
    holdingYears: 13 / 12, regime: 'new', monthlySIP: 10_000, userAge: 35,
    incomeSource: 'salary', fiscalYear: FY, deductions: {}, options: { section112AExemptionUsed: 0 },
  });
  const thresholdMonths = 12;
  const edgeLots = outcome.lots.filter(lot => [11, 12, 13].includes(lot.holdingPeriodMonths));
  assert.deepEqual(edgeLots.map(lot => lot.holdingPeriodMonths).sort((a, b) => a - b), [11, 12, 13]);
  const expectedShortTermGain = outcome.lots
    .filter(lot => lot.holdingPeriodMonths <= thresholdMonths)
    .reduce((sum, lot) => sum + lot.gain, 0);
  const totalGain = outcome.lots.reduce((sum, lot) => sum + lot.gain, 0);
  const expectedLongTermGain = totalGain - expectedShortTermGain;
  assert.equal(outcome.shortTermGain, expectedShortTermGain);
  assert.equal(outcome.longTermGain, expectedLongTermGain);
  assert.equal(outcome.lots.find(lot => lot.holdingPeriodMonths === 11).holdingPeriodMonths <= thresholdMonths, true);
  assert.equal(outcome.lots.find(lot => lot.holdingPeriodMonths === 12).holdingPeriodMonths <= thresholdMonths, true);
  assert.equal(outcome.lots.find(lot => lot.holdingPeriodMonths === 13).holdingPeriodMonths > thresholdMonths, true);
});

test('modeled SIP lots use more-than threshold for 23, 24, and 25 month other holdings', () => {
  const outcome = calculateCanonicalPostTaxOutcome({
    instrumentType: 'Gold', nominalRate: 0.12, annualIncome: 1_500_000,
    holdingYears: 25 / 12, regime: 'new', monthlySIP: 10_000, userAge: 35,
    incomeSource: 'salary', fiscalYear: FY, deductions: {}, options: {},
  });
  const thresholdMonths = 24;
  const edgeLots = outcome.lots.filter(lot => [23, 24, 25].includes(lot.holdingPeriodMonths));
  assert.deepEqual(edgeLots.map(lot => lot.holdingPeriodMonths).sort((a, b) => a - b), [23, 24, 25]);
  const expectedShortTermGain = outcome.lots
    .filter(lot => lot.holdingPeriodMonths <= thresholdMonths)
    .reduce((sum, lot) => sum + lot.gain, 0);
  const totalGain = outcome.lots.reduce((sum, lot) => sum + lot.gain, 0);
  const expectedLongTermGain = totalGain - expectedShortTermGain;
  assert.equal(outcome.shortTermGain, expectedShortTermGain);
  assert.equal(outcome.longTermGain, expectedLongTermGain);
  assert.equal(outcome.lots.find(lot => lot.holdingPeriodMonths === 23).holdingPeriodMonths <= thresholdMonths, true);
  assert.equal(outcome.lots.find(lot => lot.holdingPeriodMonths === 24).holdingPeriodMonths <= thresholdMonths, true);
  assert.equal(outcome.lots.find(lot => lot.holdingPeriodMonths === 25).holdingPeriodMonths > thresholdMonths, true);
});

test('exact-date SIP horizon owns the lot window and never creates a post-redemption lot', () => {
  const lots = buildMonthlySipLots({
    monthlySIP: 10_000,
    annualRate: 0.12,
    holdingYears: 5,
    acquisitionDate: '2024-01-31',
    redemptionDate: '2025-02-28',
  });
  assert.equal(lots.length, 13);
  assert.ok(lots.every(lot => lot.acquisitionDate <= lot.redemptionDate));
  assert.equal(lots.at(-1).acquisitionDate, '2025-01-31');
});

test('Gold ETF remains unavailable without source-qualified product composition metadata', () => {
  const result = calculatePostTaxReturn('Gold_ETF', 0.1, 1_500_000, 5, 'new', 10_000, 35, 'salary', undefined, FY);
  assert.equal(result.status, 'MODEL_TAX_CLASS_UNAVAILABLE');
  assert.equal(result.postTaxReturn, null);
});

test('ordinary-interest projection applies annual tax events after gross cash flows', () => {
  const context = {
    annualGrossIncome: 3_000_000,
    regime: 'new',
    incomeSource: 'salary',
    fiscalYear: FY,
    userAge: 35,
    deductions: { section80C: 0 },
  };
  const result = calculatePostTaxReturn('FD', 0.07, 3_000_000, 2, 'new', 10_000, 35, 'salary', undefined, FY, { deductions: context.deductions });
  const projection = calculatePostTaxProjection(result, { nominalRate: 0.07, monthlySIP: 10_000, holdingYears: 2 }, 0.06, context);
  assert.equal(projection.status, 'CALCULATED');
  assert.equal(projection.taxEventModel, 'ORDINARY_INTEREST_ANNUAL_INCREMENTAL_TAX_EVENTS');
  assert.equal(projection.taxEvents.length, 2);
  assert.ok(projection.postTaxFutureValue < projection.nominalFutureValue);
  assert.ok(Number.isFinite(projection.postTaxCAGR));
  assert.ok(projection.assumptions.includes('TAX_POLICY_HELD_CONSTANT_FOR_PROJECTION'));
});

for (const { name, nominalRate, inflationRate, expectedSign } of [
  { name: 'zero return and zero inflation', nominalRate: 0, inflationRate: 0, expectedSign: 0 },
  { name: 'zero return and positive inflation', nominalRate: 0, inflationRate: 0.06, expectedSign: -1 },
  { name: 'positive return and zero inflation', nominalRate: 0.07, inflationRate: 0, expectedSign: 1 },
  { name: 'inflation above the post-tax return', nominalRate: 0.07, inflationRate: 0.1, expectedSign: -1 },
]) {
  test(`real-return projection uses growth factors: ${name}`, () => {
    const context = {
      annualGrossIncome: 3_000_000, regime: 'new', incomeSource: 'salary',
      fiscalYear: FY, userAge: 35, deductions: {},
    };
    const result = calculatePostTaxReturn('FD', nominalRate, context.annualGrossIncome,
      2, 'new', 10_000, 35, 'salary', undefined, FY);
    const projection = calculatePostTaxProjection(result,
      { nominalRate, monthlySIP: 10_000, holdingYears: 2 }, inflationRate, context);
    assert.equal(projection.status, 'CALCULATED');
    const postTaxRate = projection.postTaxCAGR;
    assert.ok(Number.isFinite(postTaxRate));
    const expected = Number((((1 + postTaxRate) / (1 + inflationRate) - 1) * 100).toFixed(4));
    assert.equal(projection.realReturnPercent, expected);
    assert.equal(Math.sign(projection.realReturnPercent), expectedSign);
    if (inflationRate === 0) assert.equal(projection.realReturnPercent, projection.postTaxReturnPercent);
  });
}

test('inflation matching post-tax CAGR gives zero real return without changing tax cash flows', () => {
  const context = {
    annualGrossIncome: 3_000_000, regime: 'new', incomeSource: 'salary',
    fiscalYear: FY, userAge: 35, deductions: {},
  };
  const result = calculatePostTaxReturn('FD', 0.07, context.annualGrossIncome,
    2, 'new', 10_000, 35, 'salary', undefined, FY);
  const instrument = { nominalRate: 0.07, monthlySIP: 10_000, holdingYears: 2 };
  const withoutInflation = calculatePostTaxProjection(result, instrument, 0, context);
  const withInflation = calculatePostTaxProjection(result, instrument, withoutInflation.postTaxCAGR, context);
  assert.equal(withInflation.realReturnPercent, 0);
  assert.equal(withInflation.postTaxFutureValue, withoutInflation.postTaxFutureValue);
  assert.equal(withInflation.postTaxReturnPercent, withoutInflation.postTaxReturnPercent);
  assert.deepEqual(withInflation.taxEvents, withoutInflation.taxEvents);
});

test('SGB requires an explicit redemption channel and separates coupon from capital gain', () => {
  const missingChannel = calculatePostTaxReturn('SGB', 0.13, 1_500_000, 8, 'new', 10_000, 35, 'salary', undefined, FY, { couponRate: 0.025 });
  assert.equal(missingChannel.status, 'REQUIRES_TAX_INPUTS');
  assert.equal(missingChannel.postTaxReturn, null);
  const maturity = calculatePostTaxReturn('SGB', 0.13, 1_500_000, 8, 'new', 10_000, 35, 'salary', undefined, FY, {
    redemptionChannel: 'MATURITY_REDEMPTION', couponRate: 0.025,
  });
  assert.equal(maturity.status, 'REQUIRES_TAX_INPUTS');
  assert.ok(maturity.unavailableReasons.includes('SGB_MATURITY_EXEMPTION_NOT_ESTABLISHED'));
  const qualifiedMaturity = calculatePostTaxReturn('SGB', 0.13, 1_500_000, 8, 'new', 10_000, 35, 'salary', undefined, FY, {
    redemptionChannel: 'MATURITY_REDEMPTION', couponRate: 0.025,
    acquiredAtOriginalIssue: true, heldContinuously: true,
  });
  assert.equal(qualifiedMaturity.status, 'CALCULATED');
  assert.equal(qualifiedMaturity.redemptionChannel, 'MATURITY_REDEMPTION');
  assert.ok(qualifiedMaturity.grossGain > qualifiedMaturity.incrementalTax);
  assert.match(qualifiedMaturity.notes, /original-issue|conditional/i);
});

test('gold long-term taxRate is derived from the same tax amount that includes cess', () => {
  const result = calculatePostTaxReturn('Gold', 0.1, 3_000_000, 3, 'new', 10_000, 35, 'salary', undefined, FY);
  assert.equal(result.status, 'CALCULATED');
  assert.ok(result.cess > 0);
  assert.equal(result.postTaxReturn, Number((0.1 * (1 - result.taxRate)).toFixed(4)));
});

test('projection remains explicitly unavailable when a generic model class is not qualified', () => {
  const result = calculatePostTaxReturn('ETF', 0.12, 1_500_000, 5, 'new', 10_000, 35, 'salary', undefined, FY);
  const projection = calculatePostTaxProjection(result, { nominalRate: 0.12, monthlySIP: 10_000, holdingYears: 5 }, 0.06, {
    annualGrossIncome: 1_500_000, regime: 'new', incomeSource: 'salary', fiscalYear: FY, userAge: 35,
  });
  assert.equal(projection.status, 'MODELLED_POST_TAX_PROJECTION_UNAVAILABLE');
  assert.equal(projection.postTaxFutureValue, null);
  assert.equal(projection.realFutureValue, null);
});
