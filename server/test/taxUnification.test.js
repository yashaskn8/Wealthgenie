import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyHoldingPeriodByDates,
  computeTax,
  getCurrentFiscalYear,
} from '../services/taxEngine.js';
import {
  buildMonthlySipLots,
  calculateCanonicalPostTaxOutcome,
  isSafelyRepresentableModelSip,
} from '../services/taxEventProjectionEngine.js';
import {
  calculatePostTaxProjection,
  calculatePostTaxReturn,
} from '../services/postTaxCalculator.js';

const FY = 'FY2026-27';

test('model projection never returns false-precision rupee proceeds on extreme inputs', () => {
  const huge = { monthlySIP: 100_000_000, nominalRate: 1, holdingYears: 100 };
  const safe = { monthlySIP: 10_000, nominalRate: 0.08, holdingYears: 3 };
  assert.equal(isSafelyRepresentableModelSip(huge), false);
  assert.equal(isSafelyRepresentableModelSip(safe), true);
  const context = {
    instrumentType: 'FD', annualIncome: 1_000_000, regime: 'new',
    userAge: 35, incomeSource: 'salary', fiscalYear: FY, deductions: {},
  };
  const result = calculateCanonicalPostTaxOutcome({ ...context,
    nominalRate: huge.nominalRate, monthlySIP: huge.monthlySIP,
    holdingYears: huge.holdingYears,
  });
  assert.equal(result.status, 'MODELLED_POST_TAX_PROJECTION_UNAVAILABLE');
  assert.deepEqual(result.unavailableReasons, ['PROJECTION_WEALTH_PRECISION_EXCEEDED']);
  const projection = calculatePostTaxProjection(result, huge, 0.05, {
    annualGrossIncome: context.annualIncome, regime: context.regime,
    incomeSource: context.incomeSource, fiscalYear: FY,
    userAge: context.userAge, deductions: {},
  });
  assert.equal(projection.status, 'MODELLED_POST_TAX_PROJECTION_UNAVAILABLE');
  assert.equal(projection.nominalFutureValue, null);
  assert.equal(projection.postTaxFutureValue, null);
  assert.equal(projection.sipReturnMetrics.status, 'UNAVAILABLE');
  assert.deepEqual(projection.unavailableReasons, ['PROJECTION_WEALTH_PRECISION_EXCEEDED']);
});

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

test('short-term equity SIP does not calculate without residency for basic-exemption interaction', () => {
  const outcome = calculateCanonicalPostTaxOutcome({
    instrumentType: 'Equity_MF', nominalRate: 0.12, annualIncome: 0,
    holdingYears: 0.5, regime: 'new', monthlySIP: 10_000, userAge: 35,
    incomeSource: 'salary', fiscalYear: FY, deductions: {},
    options: { section112AExemptionUsed: 0 },
  });

  assert.equal(outcome.status, 'MODELLED_POST_TAX_PROJECTION_UNAVAILABLE');
  assert.ok(outcome.unavailableReasons.includes('TAX_RESIDENCY_REQUIRED_FOR_BASIC_EXEMPTION_INTERACTION'));
  assert.equal(outcome.grossGain, null);
  assert.equal(outcome.incrementalTax, null);
  assert.equal(outcome.postTaxReturn, null);
});

test('interest TDS evidence distinguishes FRSB security interest, bank interest, and unidentified government securities', () => {
  const shared = {
    nominalRate: 0.12, annualIncome: 2_000_000, holdingYears: 1,
    regime: 'new', monthlySIP: 10_000, userAge: 35,
    incomeSource: 'salary', fiscalYear: FY, deductions: {}, options: {},
  };
  const frsb = calculateCanonicalPostTaxOutcome({ instrumentType: 'RBI_Bond', ...shared });
  const bankDeposit = calculateCanonicalPostTaxOutcome({ instrumentType: 'FD', ...shared });
  const unidentifiedSecurity = calculateCanonicalPostTaxOutcome({ instrumentType: 'G-Sec', ...shared });
  const priorFiscalYearFrsb = calculateCanonicalPostTaxOutcome({
    instrumentType: 'RBI_Bond', ...shared, fiscalYear: 'FY2025-26',
  });

  assert.ok(frsb.taxRuleMetadata.currentRuleIds.includes('INCOME_TAX_ACT_2025_SECURITY_INTEREST_TDS_THRESHOLD_POLICY'));
  assert.ok(frsb.taxRuleMetadata.currentRuleReferences.some(reference =>
    reference.ruleId === 'INCOME_TAX_ACT_2025_SECURITY_INTEREST_TDS_THRESHOLD_POLICY'
      && reference.reference === 'Section 393(1), Table 5(i)'
      && reference.sourceReferences.some(source => source.url.endsWith('/w/section-393-5'))));
  assert.ok(bankDeposit.taxRuleMetadata.currentRuleIds.includes('INCOME_TAX_ACT_2025_BANK_INTEREST_TDS_THRESHOLD_POLICY'));
  assert.ok(bankDeposit.taxRuleMetadata.currentRuleReferences.some(reference =>
    reference.reference === 'Section 393(1), Table 5(ii)'));
  assert.equal(unidentifiedSecurity.tdsTreatment, 'SECURITY_IDENTITY_REQUIRED');
  assert.ok(!unidentifiedSecurity.taxRuleMetadata.currentRuleIds.includes('INCOME_TAX_ACT_2025_SECURITY_INTEREST_TDS_THRESHOLD_POLICY'));
  assert.ok(priorFiscalYearFrsb.taxRuleMetadata.rulesApplied.includes('FY2025-26_SECURITY_INTEREST_TDS'));
  assert.deepEqual(priorFiscalYearFrsb.taxRuleMetadata.currentRuleReferences, []);
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

function expectedOrdinaryIncrementalTaxForAge(context, grossIncome, userAge) {
  const deductions = { ...(context.deductions || {}), age: userAge };
  const baseline = computeTax(
    context.annualGrossIncome, context.regime, deductions, context.incomeSource,
    context.fiscalYear, userAge,
  );
  const withIncome = computeTax(
    context.annualGrossIncome + grossIncome, context.regime, deductions, context.incomeSource,
    context.fiscalYear, userAge,
  );
  return Math.max(0, withIncome.taxAmount - baseline.taxAmount);
}

function makeAgeBoundaryProjection(userAge, annualGrossIncome) {
  const context = {
    annualGrossIncome,
    regime: 'new',
    incomeSource: 'salary',
    fiscalYear: FY,
    userAge,
    deductions: {},
  };
  const instrument = { nominalRate: 0.07, monthlySIP: 30_000, holdingYears: 2 };
  const result = calculatePostTaxReturn(
    'FD', instrument.nominalRate, annualGrossIncome, instrument.holdingYears,
    context.regime, instrument.monthlySIP, userAge, context.incomeSource,
    undefined, FY, { deductions: {} },
  );
  assert.equal(result.status, 'CALCULATED');
  return { context, instrument, result, projection: calculatePostTaxProjection(result, instrument, 0, context) };
}

test('ordinary-interest projection holds the selected fiscal-year age across unanchored events', () => {
  const { context, projection } = makeAgeBoundaryProjection(59, 1_250_000);
  assert.equal(projection.status, 'CALCULATED');
  assert.deepEqual(projection.taxEvents.map(event => event.taxpayerAgeForSelectedFiscalYear), [59, 59]);
  assert.ok(projection.taxEvents.every(event => !('projectedFiscalYearOffset' in event)));
  for (const event of projection.taxEvents) {
    assert.equal(event.tax, expectedOrdinaryIncrementalTaxForAge(
      context, event.grossIncome, event.taxpayerAgeForSelectedFiscalYear,
    ));
  }
  assert.ok(projection.taxEvents[0].tax > 0);
  assert.ok(projection.assumptions.includes(
    'SELECTED_FISCAL_YEAR_TAXPAYER_AGE_HELD_CONSTANT_FOR_PROJECTED_TAX_EVENTS',
  ));
  assert.ok(projection.assumptions.includes(
    'SELECTED_VERIFIED_FISCAL_YEAR_POLICY_HELD_CONSTANT_AS_MODEL_ASSUMPTION',
  ));
});

test('ordinary-interest projection preserves selected ages at the 80-year and maximum-age boundaries', () => {
  const { context, projection } = makeAgeBoundaryProjection(79, 535_000);
  assert.equal(projection.status, 'CALCULATED');
  assert.deepEqual(projection.taxEvents.map(event => event.taxpayerAgeForSelectedFiscalYear), [79, 79]);
  for (const event of projection.taxEvents) {
    assert.equal(event.tax, expectedOrdinaryIncrementalTaxForAge(
      context, event.grossIncome, event.taxpayerAgeForSelectedFiscalYear,
    ));
  }
  assert.equal(projection.taxEvents[0].tax, 0);

  const age80 = makeAgeBoundaryProjection(80, 535_000).projection;
  assert.ok(age80.taxEvents.every(event => event.taxpayerAgeForSelectedFiscalYear === 80));
  assert.ok(age80.taxEvents.every(event => event.tax === expectedOrdinaryIncrementalTaxForAge(
    { annualGrossIncome: 535_000, regime: 'new', incomeSource: 'salary', fiscalYear: FY, deductions: {} },
    event.grossIncome,
    80,
  )));
  const capped = makeAgeBoundaryProjection(120, 535_000).projection;
  assert.ok(capped.taxEvents.every(event => event.taxpayerAgeForSelectedFiscalYear === 120));
});

test('interest TDS remains an informational credit and is not subtracted again in projection events', () => {
  const context = {
    annualGrossIncome: 1_000_000,
    regime: 'new',
    incomeSource: 'salary',
    fiscalYear: FY,
    userAge: 59,
    deductions: {},
  };
  const instrument = { nominalRate: 0.07, monthlySIP: 100_000, holdingYears: 2 };
  const result = calculatePostTaxReturn(
    'FD', instrument.nominalRate, context.annualGrossIncome, instrument.holdingYears,
    context.regime, instrument.monthlySIP, context.userAge, context.incomeSource,
    undefined, FY, { deductions: {} },
  );
  assert.equal(result.status, 'CALCULATED');
  assert.equal(result.tdsApplicable, true);
  assert.equal(result.tdsThreshold, 50_000);

  const projection = calculatePostTaxProjection(result, instrument, 0, context);
  assert.equal(projection.status, 'CALCULATED');
  assert.ok(projection.assumptions.includes(
    'TDS_REMAINS_INFORMATIONAL_CREDIT_NOT_AN_EXTRA_PROJECTED_TAX_SUBTRACTION',
  ));
  const projectedTaxes = projection.taxEvents.reduce((sum, event) => sum + event.tax, 0);
  // Taxes leave the corpus on event dates. The gross-minus-tax shortcut
  // understates the cost because tax deducted in year one no longer compounds.
  assert.ok(projectedTaxes > 0);
  assert.ok(projection.nominalFutureValue - projection.postTaxFutureValue > projectedTaxes);
  assert.ok(projection.assumptions.includes('PROJECTED_TAX_DEDUCTED_FROM_BALANCE_AND_REDUCES_FUTURE_INTEREST'));
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

test('annual tax deductions reduce future interest rather than reusing the untaxed gross path', () => {
  const context = {
    annualGrossIncome: 3_000_000,
    regime: 'new', incomeSource: 'salary', fiscalYear: FY, userAge: 35, deductions: {},
  };
  const monthlySIP = 10_000;
  const annualRate = 0.07;
  const taxResult = calculatePostTaxReturn(
    'FD', annualRate, context.annualGrossIncome, 2, 'new', monthlySIP,
    context.userAge, context.incomeSource, undefined, FY, { deductions: {} },
  );
  const projection = calculatePostTaxProjection(
    taxResult, { nominalRate: annualRate, monthlySIP, holdingYears: 2 }, 0, context,
  );
  assert.equal(projection.status, 'CALCULATED');
  // Independent two-year annuity-due reference: Year 2 must compound the
  // post-tax Year 1 corpus, not gross Year 1 corpus.
  const r = annualRate / 12;
  const growth = (1 + r) ** 12;
  const annualContributionsAtYearEnd = monthlySIP * (1 + r) * ((growth - 1) / r);
  const tax1 = expectedOrdinaryIncrementalTaxForAge(
    context, annualContributionsAtYearEnd - 12 * monthlySIP, context.userAge,
  );
  const year1Net = annualContributionsAtYearEnd - tax1;
  const year2BeforeTax = year1Net * growth + annualContributionsAtYearEnd;
  const tax2 = expectedOrdinaryIncrementalTaxForAge(
    context, year2BeforeTax - year1Net - 12 * monthlySIP, context.userAge,
  );
  assert.ok(tax1 > 0);
  assert.ok(tax2 > 0);
  assert.equal(projection.postTaxFutureValue, Math.round(year2BeforeTax - tax2));
  assert.ok(Math.abs(projection.taxEvents[0].tax - tax1) < 0.01);
  assert.ok(Math.abs(projection.taxEvents[1].tax - tax2) < 0.01);
  assert.ok(projection.nominalFutureValue - projection.postTaxFutureValue > tax1 + tax2,
    'foregone future interest must be included in the wealth drag');
  assert.ok(projection.assumptions.includes('PROJECTED_TAX_DEDUCTED_FROM_BALANCE_AND_REDUCES_FUTURE_INTEREST'));
});

function futureValueForBeginningOfMonthContributions(monthlyContribution, monthlyRate, months) {
  let balance = 0;
  for (let month = 0; month < months; month += 1) {
    balance = (balance + monthlyContribution) * (1 + monthlyRate);
  }
  return balance;
}

test('SIP annualized return metrics round-trip the modeled start-of-month contribution schedule', () => {
  const context = {
    annualGrossIncome: 0, regime: 'new', incomeSource: 'salary', fiscalYear: FY,
    userAge: 35, deductions: {},
  };
  const instrument = { nominalRate: 0.12, monthlySIP: 10_000, holdingYears: 2 };
  const taxResult = calculatePostTaxReturn('FD', instrument.nominalRate, 0, 2,
    'new', instrument.monthlySIP, 35, 'salary', undefined, FY, { deductions: {} });
  const projection = calculatePostTaxProjection(taxResult, instrument, 0, context);

  assert.equal(projection.status, 'CALCULATED');
  assert.equal(projection.nominalReturnPercent, 12);
  assert.deepEqual(projection.sipReturnMetrics, {
    basis: 'MODELLED_MONTHLY_SIP_MONEY_WEIGHTED_EQUIVALENT_ANNUAL_RATE',
    status: 'CALCULATED',
    unavailableReason: null,
    preTaxAnnualizedReturnPercent: 12.6825,
    postTaxAnnualizedReturnPercent: 12.6825,
    realPostTaxAnnualizedReturnPercent: 12.6825,
    taxDragAnnualizedPercentagePoints: 0,
  });
  const impliedMonthlyRate = (1 + projection.sipReturnMetrics.postTaxAnnualizedReturnPercent / 100) ** (1 / 12) - 1;
  const reconstructedFutureValue = futureValueForBeginningOfMonthContributions(
    instrument.monthlySIP, impliedMonthlyRate, 24,
  );
  assert.ok(Math.abs(reconstructedFutureValue - projection.postTaxFutureValue) < 1);
});

test('taxable-interest SIP reports after-tax annualized money-weighted return separately from the model rate', () => {
  const context = {
    annualGrossIncome: 5_000_000, regime: 'new', incomeSource: 'salary', fiscalYear: FY,
    userAge: 35, deductions: {},
  };
  const instrument = { nominalRate: 0.07, monthlySIP: 10_000, holdingYears: 3 };
  const taxResult = calculatePostTaxReturn('FD', instrument.nominalRate, context.annualGrossIncome,
    instrument.holdingYears, context.regime, instrument.monthlySIP, context.userAge,
    context.incomeSource, undefined, FY, { deductions: {} });
  const projection = calculatePostTaxProjection(taxResult, instrument, 0.06, context);

  assert.equal(projection.status, 'CALCULATED');
  assert.equal(projection.nominalReturnPercent, 7);
  assert.equal(projection.sipReturnMetrics.status, 'CALCULATED');
  assert.ok(projection.sipReturnMetrics.preTaxAnnualizedReturnPercent > 7);
  assert.ok(projection.sipReturnMetrics.postTaxAnnualizedReturnPercent
    < projection.sipReturnMetrics.preTaxAnnualizedReturnPercent);
  assert.ok(projection.sipReturnMetrics.taxDragAnnualizedPercentagePoints > 0);
  assert.ok(Number.isFinite(projection.sipReturnMetrics.realPostTaxAnnualizedReturnPercent));
  const impliedMonthlyRate = (1 + projection.sipReturnMetrics.postTaxAnnualizedReturnPercent / 100) ** (1 / 12) - 1;
  const reconstructedFutureValue = futureValueForBeginningOfMonthContributions(
    instrument.monthlySIP, impliedMonthlyRate, 36,
  );
  assert.ok(Math.abs(reconstructedFutureValue - projection.postTaxFutureValue) < 1);
});

test('SIP return metrics remain explicitly unavailable for zero contributions and unqualified projections', () => {
  const context = {
    annualGrossIncome: 0, regime: 'new', incomeSource: 'salary', fiscalYear: FY,
    userAge: 35, deductions: {},
  };
  const zeroContributionInstrument = { nominalRate: 0.07, monthlySIP: 0, holdingYears: 2 };
  const zeroContributionTax = calculatePostTaxReturn('FD', 0.07, 0, 2, 'new', 0, 35, 'salary', undefined, FY);
  const zeroContributionProjection = calculatePostTaxProjection(
    zeroContributionTax, zeroContributionInstrument, 0.06, context,
  );
  assert.equal(zeroContributionProjection.status, 'CALCULATED');
  assert.equal(zeroContributionProjection.totalInvested, 0);
  assert.equal(zeroContributionProjection.postTaxReturnPercent, null);
  assert.equal(zeroContributionProjection.realReturnPercent, null);
  assert.equal(zeroContributionProjection.postTaxCAGR, null);
  assert.deepEqual(zeroContributionProjection.sipReturnMetrics, {
    basis: 'MODELLED_MONTHLY_SIP_MONEY_WEIGHTED_EQUIVALENT_ANNUAL_RATE',
    status: 'UNAVAILABLE',
    unavailableReason: 'NO_MONTHLY_CONTRIBUTIONS',
    preTaxAnnualizedReturnPercent: null,
    postTaxAnnualizedReturnPercent: null,
    realPostTaxAnnualizedReturnPercent: null,
    taxDragAnnualizedPercentagePoints: null,
  });

  const exactDatesProjection = calculatePostTaxProjection(zeroContributionTax, {
    ...zeroContributionInstrument, monthlySIP: 10_000,
  }, 0.06, { ...context, acquisitionDate: '2024-01-01' });
  assert.equal(exactDatesProjection.status, 'MODELLED_POST_TAX_PROJECTION_UNAVAILABLE');
  assert.equal(exactDatesProjection.sipReturnMetrics.status, 'UNAVAILABLE');
  assert.equal(exactDatesProjection.sipReturnMetrics.unavailableReason, 'PROJECTION_UNAVAILABLE');
  assert.equal(exactDatesProjection.sipReturnMetrics.postTaxAnnualizedReturnPercent, null);
});

test('zero nominal rate produces a finite zero SIP annualized result without a fallback assumption', () => {
  const context = {
    annualGrossIncome: 0, regime: 'new', incomeSource: 'salary', fiscalYear: FY,
    userAge: 35, deductions: {},
  };
  const taxResult = calculatePostTaxReturn('FD', 0, 0, 2, 'new', 10_000, 35,
    'salary', undefined, FY, { deductions: {} });
  const projection = calculatePostTaxProjection(
    taxResult, { nominalRate: 0, monthlySIP: 10_000, holdingYears: 2 }, 0, context,
  );

  assert.equal(projection.status, 'CALCULATED');
  assert.equal(projection.sipReturnMetrics.status, 'CALCULATED');
  assert.equal(projection.sipReturnMetrics.preTaxAnnualizedReturnPercent, 0);
  assert.equal(projection.sipReturnMetrics.postTaxAnnualizedReturnPercent, 0);
  assert.equal(projection.sipReturnMetrics.realPostTaxAnnualizedReturnPercent, 0);
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


test('post-tax projections fail closed on absent investor facts and a changed fiscal year', () => {
  const input = { monthlySIP: 10_000, nominalRate: 0.07, holdingYears: 1 };
  const rate = calculatePostTaxReturn('FD', 0.07, 1_000_000, 1, 'new', 10_000, 35, 'salary', undefined, FY);
  assert.equal(rate.status, 'CALCULATED');
  const context = {
    annualGrossIncome: 1_000_000, incomeSource: 'salary', regime: 'new',
    userAge: 35, fiscalYear: FY, deductions: {},
  };
  assert.equal(calculatePostTaxProjection(rate, input, 0.05, context).status, 'CALCULATED');
  for (const key of ['annualGrossIncome', 'incomeSource', 'regime', 'userAge', 'fiscalYear']) {
    const unavailable = calculatePostTaxProjection(rate, input, 0.05, { ...context, [key]: null });
    assert.equal(unavailable.status, 'MODELLED_POST_TAX_PROJECTION_UNAVAILABLE', key);
    assert.equal(unavailable.postTaxFutureValue, null, key);
    assert.ok(unavailable.unavailableReasons.includes(key), key);
  }
  const changedPolicyYear = calculatePostTaxProjection(rate, input, 0.05, {
    ...context, fiscalYear: 'FY2025-26',
  });
  assert.equal(changedPolicyYear.status, 'MODELLED_POST_TAX_PROJECTION_UNAVAILABLE');
  assert.ok(changedPolicyYear.unavailableReasons.includes('TAX_POLICY_FISCAL_YEAR_CHANGED'));
});
