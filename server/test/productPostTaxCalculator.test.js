import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyProductTaxType,
  calculateProductPostTaxOutcome,
  generateBeginnerSuitability,
  enrichProductsWithPostTaxAndSuitability,
} from '../services/productPostTaxCalculator.js';
import { taxCalculationContextSchema } from '../validation/taxSchemas.js';
import whereToInvestCatalog from '../data/whereToInvestCatalog.js';
import { RBI_FRSB_NOTIFICATION_URL, RBI_RATE_DATA_CLASS } from '../services/marketData/RbiFloatingRateSavingsBondProvider.js';
import { SBI_RATE_DATA_CLASS, SBI_TERM_DEPOSIT_URL } from '../services/marketData/SbiTermDepositProvider.js';

const AMFI_CURRENT_URL = 'https://portal.amfiindia.com/spages/NAVAll.txt';
const AMFI_HISTORY_URL = 'https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?frmdt=28-Sep-2025&todt=04-Oct-2025';
const FIXED_INCOME_CALCULATION_NOW = new Date('2026-10-14T15:00:00.000Z');
const SBI_RATE_OBSERVED_AT = '2026-10-14T14:58:00.000Z';
const SBI_RATE_FETCHED_AT = '2026-10-14T14:59:00.000Z';

function indiaPeriodFreshness(effectiveFrom, effectiveTo, fetchedAt, evaluatedAt = fetchedAt) {
  const intervalStart = Date.parse(`${effectiveFrom}T00:00:00.000+05:30`);
  const intervalEnd = Date.parse(`${effectiveTo}T23:59:59.999+05:30`);
  return {
    status: 'FRESH',
    ageSeconds: Math.floor((Date.parse(evaluatedAt) - intervalStart) / 1000),
    maxAgeSeconds: Math.floor((intervalEnd - intervalStart) / 1000),
  };
}

function qualifiedSbiRateProduct(value, tenureId = '1y-lt2y', depositor = 'public', overrides = {}) {
  const canonicalProductId = `deposit:sbi:retail-domestic:${tenureId}:${depositor}`;
  return {
    id: canonicalProductId,
    canonicalProductId,
    name: 'SBI Retail Domestic Term Deposit',
    productType: 'BANK_TERM_DEPOSIT',
    parentInstrumentId: 'sbi_fd',
    source: {
      provider: 'SBI',
      instrumentId: `retail-domestic:${tenureId}:${depositor}`,
      url: SBI_TERM_DEPOSIT_URL,
      ...(overrides.source || {}),
    },
    availabilityStatus: 'AVAILABLE',
    freshness: {
      status: 'FRESH',
      ageSeconds: 60,
      maxAgeSeconds: 180 * 24 * 60 * 60,
      ...overrides.freshness,
    },
    officialRate: {
      value,
      unit: 'PERCENT_PER_ANNUM',
      basis: 'OFFICIAL_NOMINAL_CARD_RATE_PER_ANNUM',
      dataClass: SBI_RATE_DATA_CLASS,
      observedAt: SBI_RATE_OBSERVED_AT,
      fetchedAt: SBI_RATE_FETCHED_AT,
      ...overrides.officialRate,
    },
    ...overrides,
  };
}

function qualifiedRbiRateProduct(value) {
  const referenceRateValue = Number((value - 0.35).toFixed(4));
  return {
    id: 'government:rbi:frsb-2020-taxable',
    canonicalProductId: 'government:rbi:frsb-2020-taxable',
    name: 'Floating Rate Savings Bonds, 2020 (Taxable)',
    productType: 'GOVERNMENT_BOND',
    parentInstrumentId: 'rbi_bonds',
    source: { provider: 'RBI', instrumentId: 'frsb-2020-taxable', url: RBI_FRSB_NOTIFICATION_URL },
    availabilityStatus: 'AVAILABLE',
    freshness: indiaPeriodFreshness('2026-07-01', '2026-12-31', '2026-09-08T12:00:00.000Z'),
    officialRate: {
      value,
      unit: 'PERCENT_PER_ANNUM',
      basis: 'NSC_REFERENCE_RATE_PLUS_35_BPS',
      dataClass: RBI_RATE_DATA_CLASS,
      observedAt: '2026-07-01T00:00:00.000Z',
      fetchedAt: '2026-09-08T12:00:00.000Z',
      effectiveFrom: '2026-07-01',
      effectiveTo: '2026-12-31',
      referenceRate: 'NSC',
      referenceRateValue,
      spreadBps: 35,
      resetDate: '2026-07-01',
      referenceRateFact: {
        canonicalProductId: 'government:india-post:nsc',
        kind: 'SCHEME_INTEREST_RATE',
        availabilityStatus: 'AVAILABLE',
        source: {
          provider: 'GOVERNMENT_OF_INDIA',
          instrumentId: 'nsc',
          url: 'https://www.indiapost.gov.in/banking-services/savings',
        },
        value: referenceRateValue,
        unit: 'PERCENT_PER_ANNUM',
        rateBasis: 'OFFICIAL_NOMINAL_RATE_PER_ANNUM',
        dataClass: 'QUARTERLY_OFFICIAL_RATE',
        observedAt: '2026-07-01T00:00:00.000Z',
        fetchedAt: '2026-09-08T12:00:00.000Z',
        effectiveFrom: '2026-07-01',
        effectiveTo: '2026-09-30',
        freshness: indiaPeriodFreshness('2026-07-01', '2026-09-30', '2026-09-08T12:00:00.000Z'),
      },
    },
  };
}

function qualifiedHistoricalProduct(valuePct, product = {}, historicalOverrides = {}) {
  const startDate = '2025-10-01';
  const endDate = '2026-10-01';
  const elapsedDays = 365;
  const startNav = 100;
  const endNav = startNav * Math.pow(1 + valuePct / 100, elapsedDays / 365);
  const historicalReturn = {
    valuePct: Number(((Math.pow(endNav / startNav, 365 / elapsedDays) - 1) * 100).toFixed(6)),
    basis: 'HISTORICAL_POINT_TO_POINT_NAV_RETURN_1Y',
    annualized: true,
    isExpectedReturn: false,
    startNav,
    startDate,
    endNav,
    endDate,
    elapsedDays,
    source: {
      provider: 'AMFI',
      startInstrumentId: '101',
      endInstrumentId: '101',
      startObservationUrl: AMFI_HISTORY_URL,
      endObservationUrl: AMFI_CURRENT_URL,
      historyTargetDate: '2025-10-01',
    },
    ...historicalOverrides,
  };
  return {
    id: 'mf:amfi:101',
    canonicalProductId: 'mf:amfi:101',
    productType: 'MUTUAL_FUND',
    parentInstrumentId: 'large_cap_mf',
    source: { provider: 'AMFI', instrumentId: '101', url: AMFI_CURRENT_URL },
    nav: { value: endNav, unit: 'NAV_PER_UNIT', valuationDate: endDate, observedAt: `${endDate}T00:00:00.000Z` },
    availabilityStatus: 'AVAILABLE',
    freshness: { status: 'FRESH', ageSeconds: 60, maxAgeSeconds: 3600 },
    returnBasis: historicalReturn.basis,
    expectedReturn: null,
    historicalReturn,
    ...product,
  };
}

test('classifyProductTaxType identifies correct tax categories', () => {
  assert.equal(classifyProductTaxType({}, 'ppf'), 'PPF_ACCOUNT_EXCLUSION_CONDITIONAL');
  assert.equal(classifyProductTaxType({}, 'sukanya'), 'SSY_ACCOUNT_EXCLUSION_CONDITIONAL');
  assert.equal(classifyProductTaxType({}, 'rbi_bonds'), 'RBI_FRSB_INTEREST');
  assert.equal(classifyProductTaxType({}, 'fd'), 'BANK_DEPOSIT_INTEREST');
  assert.equal(classifyProductTaxType({}, 'sbi_fd'), 'BANK_DEPOSIT_INTEREST');
  assert.equal(classifyProductTaxType({}, 'scss'), 'TAX_CLASSIFICATION_UNAVAILABLE');
  assert.equal(classifyProductTaxType({}, 'nsc'), 'TAX_CLASSIFICATION_UNAVAILABLE');
  assert.equal(classifyProductTaxType({}, 'corporate_bond_mf'), 'TAX_CLASSIFICATION_UNAVAILABLE');
  assert.equal(classifyProductTaxType({}, 'large_cap_mf'), 'TAX_CLASSIFICATION_UNAVAILABLE');
  assert.equal(classifyProductTaxType({ name: 'Public Provident Fund' }, 'unknown'), 'TAX_CLASSIFICATION_UNAVAILABLE');
});

test('PPF and SSY tax outcomes fail closed unless account and payment facts are established', () => {
  for (const [parentInstrumentId, requiredInputs] of [
    ['ppf', ['verifiedAccountEligibility', 'contributionHistory', 'withdrawalOrMaturityFacts']],
    ['sukanya', ['verifiedAccountEligibility', 'eligibleBeneficiary', 'paymentFacts']],
  ]) {
    const outcome = calculateProductPostTaxOutcome({
      product: { id: `${parentInstrumentId}:fact`, name: parentInstrumentId, parentInstrumentId, officialRate: { value: 7.1 } },
      profile: { age: 30 },
      taxCalculationContext: null,
    });

    assert.equal(outcome.status, 'TAX_CLASSIFICATION_REQUIRES_ACQUISITION_FACTS');
    assert.equal(outcome.incrementalTax, null);
    assert.equal(outcome.postTaxRatePct, null);
    assert.equal(outcome.netGain, null);
    assert.deepEqual(outcome.requiredTaxInputs, requiredInputs);
    assert.match(outcome.disclosure, /No tax-free result/);
  }
});

test('Taxable product without explicit tax context returns REQUIRES_TAX_INPUTS without crashing or showing fake 0%', () => {
  const fdProduct = {
    id: 'sbi:fd:1y',
    name: 'SBI 1-Year Term Deposit',
    parentInstrumentId: 'sbi_fd',
    officialRate: { value: 6.8 },
  };
  const outcome = calculateProductPostTaxOutcome({
    product: fdProduct,
    profile: { age: 35 },
    taxCalculationContext: null,
  });

  assert.equal(outcome.status, 'REQUIRES_TAX_INPUTS');
  assert.equal(outcome.postTaxRatePct, null);
  assert.equal(outcome.message, 'Additional tax inputs are required for this product.');
});

test('Taxable SBI FD calculates incremental tax using versioned taxEngine', () => {
  const fdProduct = qualifiedSbiRateProduct(7.0);
  const outcome = calculateProductPostTaxOutcome({
    product: fdProduct,
    profile: { age: 35 },
    now: FIXED_INCOME_CALCULATION_NOW,
    taxCalculationContext: {
      annualGrossIncome: 1500000,
      regime: 'new',
      fiscalYear: 'FY2025-26',
      incomeSource: 'salary',
      userAge: 35,
      illustrativePrincipal: 10000,
    },
  });

  assert.equal(outcome.status, 'CALCULATED');
  assert.equal(outcome.illustrativePrincipal, 10000);
  assert.equal(outcome.grossGain, 700);
  assert.ok(outcome.incrementalTax > 0);
  assert.ok(outcome.netGain < 700);
  assert.ok(outcome.postTaxRatePct < 7.0);
  assert.ok(outcome.postTaxRatePct > 0);
  assert.deepEqual(
    [...new Set(outcome.sourceReferences.map(source => source.role))].sort(),
    ['PRODUCT_FACT', 'TAX_POLICY'],
  );
  assert.ok(outcome.sourceReferences.some(source => source.role === 'PRODUCT_FACT'
    && source.provider === 'SBI'
    && source.instrumentId === 'retail-domestic:1y-lt2y:public'
    && source.observedValue === 7
    && source.url === fdProduct.source.url));
  assert.equal(
    outcome.sourceReferences.length,
    new Set(outcome.sourceReferences.map(source => [source.authority, source.title, source.url, source.role].join('|'))).size,
  );
  assert.equal(outcome.isHistoricalEstimate, false);
});

test('an explicit zero official rate remains a calculated zero after-tax result', () => {
  const outcome = calculateProductPostTaxOutcome({
    product: qualifiedSbiRateProduct(0, '1y-lt2y', 'public', { name: 'SBI deposit with an explicit zero rate' }),
    now: FIXED_INCOME_CALCULATION_NOW,
    taxCalculationContext: {
      annualGrossIncome: 0,
      regime: 'new',
      fiscalYear: 'FY2025-26',
      incomeSource: 'salary',
      userAge: 35,
      illustrativePrincipal: 10000,
    },
  });

  assert.equal(outcome.status, 'CALCULATED');
  assert.equal(outcome.grossGain, 0);
  assert.equal(outcome.postTaxRatePct, 0);
});

test('fixed-income tax results require a fresh rate fact bound to the official source and product identity', () => {
  const context = {
    annualGrossIncome: 500000,
    incomeSource: 'salary',
    regime: 'new',
    fiscalYear: 'FY2026-27',
    userAge: 35,
    illustrativePrincipal: 10000,
  };
  const invalidFacts = [
    product => { delete product.source; },
    product => { delete product.source.instrumentId; },
    product => { product.source.url = 'https://example.invalid/rates'; },
    product => { product.freshness.status = 'STALE'; },
    product => { product.officialRate.dataClass = 'MODEL_ASSUMPTION'; },
    product => { product.officialRate.observedAt = '2026-10-14T15:00:01.000Z'; },
    product => { product.officialRate.fetchedAt = '2026-10-14T15:00:01.000Z'; },
    product => { product.freshness.ageSeconds = 3600; },
    product => { product.officialRate.observedAt = '2026-03-01T00:00:00.000Z'; },
  ];
  for (const mutate of invalidFacts) {
    const product = qualifiedSbiRateProduct(7);
    mutate(product);
    const outcome = calculateProductPostTaxOutcome({
      product,
      taxCalculationContext: context,
      now: FIXED_INCOME_CALCULATION_NOW,
    });
    assert.equal(outcome.status, 'PRODUCT_FACTS_UNAVAILABLE');
    assert.ok(outcome.unavailableReasons.includes('QUALIFIED_OFFICIAL_RATE_UNAVAILABLE'));
    for (const field of ['grossGain', 'incrementalTax', 'netGain', 'postTaxRatePct']) {
      assert.equal(outcome[field], null, `${field} remains unknown without a qualified source rate`);
    }
  }
});

test('missing or blank annual income stays required while an explicit zero income is accepted', () => {
  const product = qualifiedSbiRateProduct(7.0, '1y-lt2y', 'public', { name: 'SBI 1-Year Term Deposit' });
  const taxContext = {
    incomeSource: 'salary',
    regime: 'new',
    fiscalYear: 'FY2025-26',
    userAge: 35,
    illustrativePrincipal: 10000,
  };

  for (const annualGrossIncome of [null, '']) {
    const outcome = calculateProductPostTaxOutcome({
      product,
      now: FIXED_INCOME_CALCULATION_NOW,
      taxCalculationContext: { ...taxContext, annualGrossIncome },
    });

    assert.equal(outcome.status, 'REQUIRES_TAX_INPUTS');
    assert.deepEqual(outcome.requiredTaxInputs, ['annualGrossIncome']);
    assert.equal(outcome.postTaxRatePct, null);
  }

  const zeroIncomeOutcome = calculateProductPostTaxOutcome({
    product,
    now: FIXED_INCOME_CALCULATION_NOW,
    taxCalculationContext: { ...taxContext, annualGrossIncome: 0 },
  });
  assert.equal(zeroIncomeOutcome.status, 'CALCULATED');
  assert.equal(zeroIncomeOutcome.postTaxRatePct, 7);
});

test('missing or blank historical return facts are unavailable while an explicit zero remains calculated', () => {
  const product = qualifiedHistoricalProduct(15, {
    name: 'Qualified equity fund',
    taxMetadata: {
      sourceQualified: true,
      taxClass: 'EQUITY_MF_SECTION_112A',
      sourceReferences: [{ authority: 'AMFI', title: 'Qualified product tax adapter', url: 'https://www.amfiindia.com/' }],
    },
  });
  const taxCalculationContext = {
    annualGrossIncome: 1000000,
    incomeSource: 'salary',
    regime: 'new',
    fiscalYear: 'FY2025-26',
    userAge: 35,
    holdingPeriodMonths: 13,
    section112AExemptionUsed: 0,
    sttConditionAssumedSatisfied: true,
  };

  for (const valuePct of [null, '']) {
    const outcome = calculateProductPostTaxOutcome({
      product: { ...product, historicalReturn: { ...product.historicalReturn, valuePct } },
      taxCalculationContext,
    });

    assert.equal(outcome.status, 'PRODUCT_FACTS_UNAVAILABLE');
    assert.equal(outcome.postTaxRatePct, null);
    assert.ok(outcome.unavailableReasons.includes('QUALIFIED_HISTORICAL_RETURN_UNAVAILABLE'));
  }

  const zeroReturnOutcome = calculateProductPostTaxOutcome({
    product: qualifiedHistoricalProduct(0, { name: product.name, taxMetadata: product.taxMetadata }),
    taxCalculationContext,
  });
  assert.equal(zeroReturnOutcome.status, 'CALCULATED');
  assert.equal(zeroReturnOutcome.grossGain, 0);
  assert.equal(zeroReturnOutcome.postTaxRatePct, 0);
  assert.deepEqual(zeroReturnOutcome.sourceReferences.filter(reference => reference.role === 'PRODUCT_FACT')
    .map(({ authority, instrumentId, title, url, observedValue, unit, observedAt, role }) => ({
      authority, instrumentId, title, url, observedValue, unit, observedAt, role,
    })), [
    {
      authority: 'AMFI',
      instrumentId: '101',
      title: 'Historical starting NAV observation',
      url: AMFI_HISTORY_URL,
      observedValue: 100,
      unit: 'NAV_PER_UNIT',
      observedAt: '2025-10-01',
      role: 'PRODUCT_FACT',
    },
    {
      authority: 'AMFI',
      instrumentId: '101',
      title: 'Historical ending NAV observation',
      url: AMFI_CURRENT_URL,
      observedValue: 100,
      unit: 'NAV_PER_UNIT',
      observedAt: '2026-10-01',
      role: 'PRODUCT_FACT',
    },
  ]);

  const malformedFacts = [
    product => ({ ...product, historicalReturn: { ...product.historicalReturn, basis: 'EXPECTED_RETURN' } }),
    product => ({ ...product, historicalReturn: { ...product.historicalReturn, annualized: false } }),
    product => ({ ...product, historicalReturn: { ...product.historicalReturn, isExpectedReturn: true } }),
    product => ({ ...product, historicalReturn: { ...product.historicalReturn, source: { ...product.historicalReturn.source, startInstrumentId: '102' } } }),
    product => ({ ...product, historicalReturn: { ...product.historicalReturn, source: { ...product.historicalReturn.source, endInstrumentId: '102' } } }),
    product => ({ ...product, historicalReturn: { ...product.historicalReturn, source: { ...product.historicalReturn.source, startObservationUrl: 'https://portal.amfiindia.com/ReportPublication.aspx?SchemeCode=101' } } }),
    product => ({ ...product, historicalReturn: { ...product.historicalReturn, source: { ...product.historicalReturn.source, endObservationUrl: 'https://example.invalid/nav' } } }),
    product => ({ ...product, freshness: { ...product.freshness, status: 'STALE' } }),
    product => ({ ...product, nav: { ...product.nav, value: product.nav.value + 1 } }),
    product => ({ ...product, historicalReturn: { ...product.historicalReturn, valuePct: product.historicalReturn.valuePct + 1 } }),
  ];
  for (const mutate of malformedFacts) {
    const unavailable = calculateProductPostTaxOutcome({
      product: mutate(product),
      taxCalculationContext,
    });
    assert.equal(unavailable.status, 'PRODUCT_FACTS_UNAVAILABLE');
    assert.ok(unavailable.unavailableReasons.includes('QUALIFIED_HISTORICAL_RETURN_UNAVAILABLE'));
    for (const field of ['grossGain', 'incrementalTax', 'netGain', 'postTaxRatePct']) {
      assert.equal(unavailable[field], null, `${field} remains unknown when historical evidence is invalid`);
    }
  }
});

test('RBI FRSB labels outcome as Current coupon after tax and disclaims 6-month reset without 7-year guarantee', () => {
  const rbiBond = qualifiedRbiRateProduct(8.05);
  const outcome = calculateProductPostTaxOutcome({
    product: rbiBond,
    profile: { age: 40 },
    now: FIXED_INCOME_CALCULATION_NOW,
    taxCalculationContext: {
      annualGrossIncome: 1200000,
      regime: 'new',
      fiscalYear: 'FY2025-26',
      incomeSource: 'salary',
      userAge: 40,
      illustrativePrincipal: 10000,
    },
  });

  assert.equal(outcome.status, 'CALCULATED');
  assert.equal(outcome.metricLabel, 'Current coupon after tax');
  assert.ok(outcome.disclosure.includes('resets every six months'));
  assert.ok(outcome.disclosure.includes('not a fixed 7-year return'));
  assert.equal(outcome.isHistoricalEstimate, false);
  assert.ok(outcome.sourceReferences.some(reference => reference.provider === 'GOVERNMENT_OF_INDIA'));
});

test('RBI FRSB post-tax calculation requires qualified NSC reset evidence and coupon arithmetic', () => {
  const malformedProducts = [
    product => ({ ...product, officialRate: { ...product.officialRate, referenceRateFact: null } }),
    product => ({ ...product, officialRate: { ...product.officialRate, referenceRateFact: {
      ...product.officialRate.referenceRateFact,
      source: { ...product.officialRate.referenceRateFact.source, url: 'https://www.indiapost.gov.in/not-the-rate-table' },
    } } }),
    product => ({ ...product, officialRate: { ...product.officialRate, referenceRateFact: {
      ...product.officialRate.referenceRateFact, effectiveFrom: '2026-04-01', effectiveTo: '2026-06-30',
    } } }),
    product => ({ ...product, officialRate: { ...product.officialRate, referenceRateValue: 7.8 } }),
    product => ({ ...product, officialRate: { ...product.officialRate, spreadBps: 50 } }),
    product => ({ ...product, officialRate: { ...product.officialRate, observedAt: '2026-09-08T12:00:01.000Z' } }),
    product => ({ ...product, officialRate: { ...product.officialRate, fetchedAt: '2026-10-14T15:00:01.000Z' } }),
    product => ({ ...product, freshness: { ...product.freshness, ageSeconds: 0 } }),
    product => ({ ...product, officialRate: { ...product.officialRate, referenceRateFact: {
      ...product.officialRate.referenceRateFact,
      freshness: { ...product.officialRate.referenceRateFact.freshness, ageSeconds: 0 },
    } } }),
    product => ({ ...product, officialRate: { ...product.officialRate, referenceRateFact: {
      ...product.officialRate.referenceRateFact,
      fetchedAt: '2026-10-14T15:00:01.000Z',
    } } }),
  ];
  for (const mutate of malformedProducts) {
    const outcome = calculateProductPostTaxOutcome({
      product: mutate(qualifiedRbiRateProduct(8.05)),
      now: FIXED_INCOME_CALCULATION_NOW,
      taxCalculationContext: {
        annualGrossIncome: 1200000, regime: 'new', fiscalYear: 'FY2025-26',
        incomeSource: 'salary', userAge: 40, illustrativePrincipal: 10000,
      },
    });
    assert.equal(outcome.status, 'PRODUCT_FACTS_UNAVAILABLE');
    assert.ok(outcome.unavailableReasons.includes('QUALIFIED_OFFICIAL_RATE_UNAVAILABLE'));
    assert.equal(outcome.grossGain, null);
    assert.equal(outcome.postTaxRatePct, null);
  }
});

test('FRSB accepts NSC evidence evaluated after India Post’s bounded sequential fetch window', () => {
  const product = qualifiedRbiRateProduct(8.05);
  const referenceFact = product.officialRate.referenceRateFact;
  const evaluatedAt = new Date(Date.parse(referenceFact.fetchedAt) + 6 * 60 * 1000).toISOString();
  referenceFact.freshness = indiaPeriodFreshness(
    referenceFact.effectiveFrom,
    referenceFact.effectiveTo,
    referenceFact.fetchedAt,
    evaluatedAt,
  );

  const outcome = calculateProductPostTaxOutcome({
    product,
    now: FIXED_INCOME_CALCULATION_NOW,
    taxCalculationContext: {
      annualGrossIncome: 1200000, regime: 'new', fiscalYear: 'FY2025-26',
      incomeSource: 'salary', userAge: 40, illustrativePrincipal: 10000,
    },
  });

  assert.equal(outcome.status, 'CALCULATED');
  assert.equal(outcome.metricLabel, 'Current coupon after tax');
});

test('FRSB rejects stale or implausibly delayed NSC fetch timestamps', () => {
  const context = {
    annualGrossIncome: 1200000, regime: 'new', fiscalYear: 'FY2025-26',
    incomeSource: 'salary', userAge: 40, illustrativePrincipal: 10000,
  };
  const stale = qualifiedRbiRateProduct(8.05);
  stale.officialRate.referenceRateFact.fetchedAt = '2026-10-01T00:00:00.000Z';
  const implausiblyDelayed = qualifiedRbiRateProduct(8.05);
  const lateReference = implausiblyDelayed.officialRate.referenceRateFact;
  const evaluatedAt = new Date(Date.parse(lateReference.fetchedAt) + 10 * 60 * 1000).toISOString();
  lateReference.freshness = indiaPeriodFreshness(
    lateReference.effectiveFrom,
    lateReference.effectiveTo,
    lateReference.fetchedAt,
    evaluatedAt,
  );

  for (const product of [stale, implausiblyDelayed]) {
    const outcome = calculateProductPostTaxOutcome({
      product,
      now: FIXED_INCOME_CALCULATION_NOW,
      taxCalculationContext: context,
    });
    assert.equal(outcome.status, 'PRODUCT_FACTS_UNAVAILABLE');
    assert.ok(outcome.unavailableReasons.includes('QUALIFIED_OFFICIAL_RATE_UNAVAILABLE'));
    assert.equal(outcome.grossGain, null);
    assert.equal(outcome.postTaxRatePct, null);
  }
});

test('specified-mutual-fund tax fails closed without product-bound annual-average evidence', () => {
  const product = qualifiedHistoricalProduct(9, {
    name: 'Unverified debt-fund fixture',
    taxMetadata: {
      sourceQualified: true,
      taxClass: 'DEBT_MF_SECTION_50AA',
      sourceReferences: [{ authority: 'Fund source', title: 'Product description only', url: 'https://example.test/debt-fund-tax' }],
      rulesApplied: ['SPECIFIED_MUTUAL_FUND_CLASSIFICATION'],
    },
  });
  assert.equal(classifyProductTaxType(product), 'TAX_CLASSIFICATION_UNAVAILABLE');

  for (const fiscalYear of ['FY2025-26', 'FY2026-27']) {
    const outcome = calculateProductPostTaxOutcome({
      product,
      taxCalculationContext: {
        annualGrossIncome: 1_000_000,
        regime: 'new',
        fiscalYear,
        incomeSource: 'salary',
        userAge: 35,
        acquisitionDate: '2023-04-01',
        redemptionDate: fiscalYear === 'FY2025-26' ? '2026-03-31' : '2026-04-01',
        illustrativePrincipal: 10_000,
      },
    });
    assert.equal(outcome.status, 'TAX_CLASSIFICATION_UNAVAILABLE');
    assert.ok(outcome.unavailableReasons.includes('SPECIFIED_MUTUAL_FUND_ELIGIBILITY_EVIDENCE_UNAVAILABLE'));
    assert.match(outcome.disclosure, /annual-average portfolio-composition evidence/i);
    for (const field of ['grossGain', 'taxableGain', 'netGain', 'postTaxRatePct', 'incrementalTax']) {
      assert.equal(outcome[field], null, `${field} remains unavailable in ${fiscalYear}`);
    }
  }
});

test('Mutual fund returns are labelled HISTORICAL and NOT A FORECAST', () => {
  const equityMf = qualifiedHistoricalProduct(15, {
    name: 'Nifty 50 Index Fund',
    taxMetadata: {
      sourceQualified: true,
      taxClass: 'EQUITY_MF_SECTION_112A',
      sourceReferences: [{ authority: 'AMFI', title: 'Qualified product tax adapter', url: 'https://www.amfiindia.com/' }],
      rulesApplied: ['SECTION_112A_LTCG_SPECIAL_RATE'],
    },
  });
  const outcome = calculateProductPostTaxOutcome({
    product: equityMf,
    profile: { age: 30 },
    taxCalculationContext: {
      annualGrossIncome: 1000000,
      regime: 'new',
      fiscalYear: 'FY2025-26',
      incomeSource: 'salary',
      userAge: 30,
      holdingPeriodMonths: 13,
      section112AExemptionUsed: 0,
      sttConditionAssumedSatisfied: true,
      illustrativePrincipal: 10000,
    },
  });

  assert.equal(outcome.status, 'CALCULATED');
  assert.equal(outcome.metricLabel, 'Historical 1Y after-tax return');
  assert.ok(outcome.disclosure.includes('HISTORICAL — NOT A FORECAST'));
  assert.equal(outcome.isHistoricalEstimate, true);
  assert.ok(outcome.postTaxRatePct <= 15.0);
  assert.ok(outcome.sourceReferences.some(source => source.role === 'TAX_POLICY'));
  assert.ok(outcome.sourceReferences.some(source => source.authority === 'AMFI' && source.role === 'PRODUCT_RULE'));
  assert.ok(outcome.sourceReferences.filter(source => source.role === 'PRODUCT_FACT')
    .every(source => source.instrumentId === '101'));
  assert.deepEqual(outcome.sourceReferences.filter(source => source.role === 'PRODUCT_FACT').map(source => source.url).sort(), [
    AMFI_CURRENT_URL,
    AMFI_HISTORY_URL,
  ].sort());
});

test('exact-date WTI tax classification keeps the anniversary short-term without fake month conversion', () => {
  const outcome = calculateProductPostTaxOutcome({
    product: qualifiedHistoricalProduct(15, {
      name: 'Qualified equity fund',
      taxMetadata: {
        sourceQualified: true,
        taxClass: 'EQUITY_MF_SECTION_112A',
        sourceReferences: [{ authority: 'AMFI', title: 'Qualified product tax adapter', url: 'https://www.amfiindia.com/' }],
      },
    }),
    taxCalculationContext: {
      annualGrossIncome: 1500000,
      regime: 'new',
      fiscalYear: 'FY2026-27',
      incomeSource: 'salary',
      userAge: 35,
      acquisitionDate: '2025-04-01',
      redemptionDate: '2026-04-01',
      section112AExemptionUsed: 125000,
      sttConditionAssumedSatisfied: true,
      illustrativePrincipal: 10000,
    },
  });

  assert.equal(outcome.status, 'CALCULATED');
  assert.equal(outcome.holdingPeriodBasis, 'EXACT_TRANSACTION_DATES');
  assert.ok(outcome.rulesApplied.includes('INCOME_TAX_ACT_2025_EQUITY_STCG_SPECIAL_RATE_POLICY'));
  assert.ok(!outcome.rulesApplied.includes('INCOME_TAX_ACT_2025_EQUITY_LTCG_SPECIAL_RATE_POLICY'));
  assert.ok(outcome.taxRuleMetadata.legacyAliases.includes('SECTION_111A_STCG_SPECIAL_RATE'));
});

test('exact-date equity tax binds the redemption date to the supplied fiscal year at the March-April boundary', () => {
  const product = qualifiedHistoricalProduct(15, {
    name: 'Qualified equity fund',
    taxMetadata: {
      sourceQualified: true,
      taxClass: 'EQUITY_MF_SECTION_112A',
      sourceReferences: [{ authority: 'AMFI', title: 'Qualified product tax adapter', url: 'https://www.amfiindia.com/' }],
    },
  });
  const calculate = (fiscalYear, acquisitionDate, redemptionDate) => calculateProductPostTaxOutcome({
    product,
    taxCalculationContext: {
      annualGrossIncome: 1_500_000,
      regime: 'new',
      fiscalYear,
      incomeSource: 'salary',
      userAge: 35,
      acquisitionDate,
      redemptionDate,
      section112AExemptionUsed: 0,
      sttConditionAssumedSatisfied: true,
      illustrativePrincipal: 10_000,
    },
  });

  for (const [fiscalYear, redemptionDate] of [
    ['FY2025-26', '2026-03-31'],
    ['FY2026-27', '2026-04-01'],
  ]) {
    const matchingYear = calculate(fiscalYear, '2025-04-01', redemptionDate);
    assert.equal(matchingYear.status, 'CALCULATED');
    assert.equal(matchingYear.fiscalYear, fiscalYear);
  }

  for (const [fiscalYear, redemptionDate] of [
    ['FY2025-26', '2026-04-01'],
    ['FY2026-27', '2026-03-31'],
  ]) {
    const mismatchedYear = calculate(fiscalYear, '2025-04-01', redemptionDate);
    assert.equal(mismatchedYear.status, 'TAX_CLASSIFICATION_UNAVAILABLE');
    assert.ok(mismatchedYear.unavailableReasons.includes('CAPITAL_GAINS_REDEMPTION_FISCAL_YEAR_MISMATCH'));
    for (const field of ['grossGain', 'taxableGain', 'netGain', 'postTaxRatePct', 'incrementalTax']) {
      assert.equal(mismatchedYear[field], null, `${field} stays null when redemption FY conflicts with supplied policy`);
    }
  }
});

test('generateBeginnerSuitability produces deterministic plain-English reasons, risk tiers, and liquidity copy', () => {
  const ppf = {
    id: 'ppf:fact',
    name: 'Public Provident Fund',
    parentInstrumentId: 'ppf',
    officialRate: { value: 7.1 },
  };
  const suitability = generateBeginnerSuitability({
    product: ppf,
    profile: {
      investmentGoals: ['Retirement', 'Wealth Growth'],
      investmentHorizonYears: 15,
      riskTolerance: 'Conservative',
    },
  });

  assert.equal(suitability.riskTier, 'Product-specific risk unavailable');
  assert.equal(suitability.productRiskClassification.status, 'UNAVAILABLE');
  assert.equal(suitability.accessToMoney, 'Product-specific access terms unavailable');
  assert.equal(suitability.parentCategorySuitability.status, 'NOT_ESTABLISHED');
  assert.match(suitability.whyThisFitsYou, /eligibility, risk rating, and redemption terms have not been established/i);
  assert.equal(suitability.verifiedFactLabel, 'Verified fact unavailable');
  assert.equal(suitability.verifiedFactValue, 'Unavailable');
  assert.equal(suitability.sourceProvider, 'Source unavailable');
});

test('verified metrics require available fresh source facts with matching semantic metadata', () => {
  const bankSource = {
    provider: 'SBI',
    instrumentId: 'retail-domestic-1y',
    url: 'https://sbi.co.in/web/interest-rates/deposit-rates/retail-domestic-term-deposit',
  };
  const officialRateProduct = {
    id: 'deposit:sbi:test',
    canonicalProductId: 'deposit:sbi:test',
    parentInstrumentId: 'sbi_fd',
    source: bankSource,
    availabilityStatus: 'AVAILABLE',
    freshness: { status: 'FRESH' },
    officialRate: {
      value: 0,
      dataClass: 'OFFICIAL_BANK_PUBLISHED_RATE',
      basis: 'OFFICIAL_NOMINAL_CARD_RATE_PER_ANNUM',
    },
  };

  const explicitZero = generateBeginnerSuitability({ product: officialRateProduct });
  assert.equal(explicitZero.verifiedFactLabel, 'Current official bank rate');
  assert.equal(explicitZero.verifiedFactValue, '0.00% p.a.');

  for (const officialRate of [
    { ...officialRateProduct.officialRate, dataClass: null },
    { ...officialRateProduct.officialRate, basis: 'MODEL_ASSUMPTION' },
    { ...officialRateProduct.officialRate, value: null },
  ]) {
    const unavailable = generateBeginnerSuitability({
      product: { ...officialRateProduct, officialRate },
    });
    assert.equal(unavailable.verifiedFactValue, 'Unavailable');
  }

  const mutualFundSource = {
    provider: 'AMFI',
    instrumentId: '12345',
    url: 'https://portal.amfiindia.com/ReportPublication.aspx?SchemeCode=12345',
  };
  const historicalZero = generateBeginnerSuitability({
    product: {
      id: 'mf:amfi:12345',
      canonicalProductId: 'mf:amfi:12345',
      parentInstrumentId: 'large_cap_mf',
      source: mutualFundSource,
      availabilityStatus: 'AVAILABLE',
      freshness: { status: 'FRESH' },
      historicalReturn: { valuePct: 0, basis: 'HISTORICAL_POINT_TO_POINT_NAV_RETURN_1Y' },
    },
  });
  assert.equal(historicalZero.verifiedFactLabel, 'Historical 1Y return');
  assert.equal(historicalZero.verifiedFactValue, '0.00% historical');

  const wrongBasis = generateBeginnerSuitability({
    product: {
      id: 'mf:amfi:12345',
      canonicalProductId: 'mf:amfi:12345',
      parentInstrumentId: 'large_cap_mf',
      source: mutualFundSource,
      availabilityStatus: 'AVAILABLE',
      freshness: { status: 'FRESH' },
      historicalReturn: { valuePct: 18, basis: 'EXPECTED_RETURN' },
    },
  });
  assert.equal(wrongBasis.verifiedFactValue, 'Unavailable');
});

test('retired Where-to-Invest catalog exposes neutral reference labels only', () => {
  assert.ok(Object.keys(whereToInvestCatalog).length > 0);
  for (const entry of Object.values(whereToInvestCatalog)) {
    assert.equal(entry.howToStart, null);
    assert.deepEqual(Object.keys(entry).sort(), ['howToStart', 'title']);
  }
});

test('SBI suitability copy does not make unsupported guarantee or deposit-insurance claims', () => {
  const suitability = generateBeginnerSuitability({
    product: { id: 'sbi-fd:tenure', name: 'SBI Term Deposit', parentInstrumentId: 'sbi_fd' },
    profile: { investmentGoals: ['Capital preservation'], investmentHorizonYears: 3, riskTolerance: 'Conservative' },
  });
  assert.match(suitability.whyThisFitsYou, /individual-product suitability, eligibility, risk rating, and redemption terms have not been established/i);
  assert.doesNotMatch(suitability.whyThisFitsYou, /guaranteed|DICGC|insurance|largest bank/i);
});

test('FRSB issuer and administrator claims remain unavailable without source-bound product identity', () => {
  const suitability = generateBeginnerSuitability({
    product: { id: 'rbi:frsb:current', name: 'RBI Floating Rate Savings Bond', parentInstrumentId: 'rbi_bonds' },
    profile: { investmentGoals: ['Capital preservation'], investmentHorizonYears: 7, riskTolerance: 'Conservative' },
  });
  assert.match(suitability.whyThisFitsYou, /individual-product suitability, eligibility, risk rating, and redemption terms have not been established/i);
  assert.doesNotMatch(suitability.whyThisFitsYou, /issued directly by the RBI/i);
});

test('enrichProductsWithPostTaxAndSuitability enriches product array without mutating historicalReturn', () => {
  const products = [qualifiedHistoricalProduct(18.25, {
    name: 'Test Fund',
    taxMetadata: {
      sourceQualified: true,
      taxClass: 'EQUITY_MF_SECTION_112A',
      sourceReferences: [{ authority: 'AMFI', title: 'Qualified product tax adapter', url: 'https://www.amfiindia.com/' }],
      rulesApplied: ['SECTION_112A_LTCG_SPECIAL_RATE'],
    },
    postTaxReturn: null,
  })];
  const enriched = enrichProductsWithPostTaxAndSuitability(products, {
    profile: { investmentGoals: ['Wealth Growth'], investmentHorizonYears: 10 },
    parentCatalog: { id: 'large_cap_mf' },
    taxCalculationContext: {
      annualGrossIncome: 1200000,
      regime: 'new',
      fiscalYear: 'FY2025-26',
      incomeSource: 'salary',
      userAge: 30,
      holdingPeriodMonths: 12,
      section112AExemptionUsed: 0,
      sttConditionAssumedSatisfied: true,
    },
  });

  assert.equal(enriched.length, 1);
  assert.equal(enriched[0].historicalReturn.valuePct, 18.25); // Invariant: historicalReturn is untouched
  assert.ok(enriched[0].beginnerSuitability);
  assert.ok(enriched[0].postTaxAnalysis);
  assert.equal(enriched[0].postTaxReturn, null);
  assert.equal(enriched[0].postTaxAnalysis.calculationClass, 'HISTORICAL_RETURN_POST_TAX_ILLUSTRATION');
});

test('product enrichment calculates every returned top-five option in order and does not pad shorter results', () => {
  const products = [
    ['7d-45d', 5], ['46d-179d', 6], ['180d-210d', 7], ['211d-lt1y', 8], ['1y-lt2y', 9],
  ].map(([tenureId, rate], index) => qualifiedSbiRateProduct(rate, tenureId, 'public', {
    name: `SBI deposit option ${index + 1}`,
    rank: index + 1,
    postTaxReturn: null,
  }));
  const options = {
    now: FIXED_INCOME_CALCULATION_NOW,
    taxCalculationContext: {
      annualGrossIncome: 1500000,
      incomeSource: 'salary',
      regime: 'new',
      fiscalYear: 'FY2025-26',
      userAge: 35,
      illustrativePrincipal: 10000,
    },
  };

  const enriched = enrichProductsWithPostTaxAndSuitability(products, options);
  assert.deepEqual(enriched.map(product => product.id), products.map(product => product.id));
  assert.deepEqual(enriched.map(product => product.rank), [1, 2, 3, 4, 5]);
  assert.equal(new Set(enriched.map(product => product.id)).size, 5);
  assert.deepEqual(enriched.map(product => product.postTaxAnalysis.status), Array(5).fill('CALCULATED'));
  assert.deepEqual(enriched.map(product => product.postTaxAnalysis.grossGain), [500, 600, 700, 800, 900]);
  assert.ok(enriched.every(product => product.postTaxReturn === null));

  const threeEligibleOptions = enrichProductsWithPostTaxAndSuitability(products.slice(0, 3), options);
  assert.equal(threeEligibleOptions.length, 3);
  assert.deepEqual(threeEligibleOptions.map(product => product.id), products.slice(0, 3).map(product => product.id));
});

test('equity fund tax requires an explicit STT scenario assumption and never calculates when absent or false', () => {
  const product = qualifiedHistoricalProduct(15, {
    name: 'Qualified equity fund',
    taxMetadata: {
      sourceQualified: true,
      taxClass: 'EQUITY_MF_SECTION_112A',
      sourceReferences: [{ authority: 'AMFI', title: 'Qualified product tax adapter', url: 'https://www.amfiindia.com/', role: 'PRODUCT_RULE' }],
    },
  });
  const requiredContext = {
    annualGrossIncome: 500000,
    incomeSource: 'salary',
    regime: 'new',
    fiscalYear: 'FY2026-27',
    userAge: 35,
    holdingPeriodMonths: 18,
    section112AExemptionUsed: 0,
    illustrativePrincipal: 10000,
  };
  const missing = calculateProductPostTaxOutcome({ product, taxCalculationContext: requiredContext });
  assert.equal(missing.status, 'REQUIRES_TAX_INPUTS');
  assert.ok(missing.requiredTaxInputs.includes('sttConditionAssumedSatisfied'));
  for (const field of ['grossGain', 'taxableGain', 'exemptionApplied', 'incrementalTax', 'cess', 'surcharge', 'netGain', 'postTaxRatePct']) {
    assert.equal(missing[field], null, `${field} must remain absent without the STT scenario prerequisite`);
  }

  const notAssumed = calculateProductPostTaxOutcome({
    product,
    taxCalculationContext: { ...requiredContext, sttConditionAssumedSatisfied: false },
  });
  assert.equal(notAssumed.status, 'UNAVAILABLE');
  assert.ok(notAssumed.unavailableReasons.includes('EQUITY_FUND_STT_CONDITION_NOT_ESTABLISHED'));
  assert.deepEqual(notAssumed.requiredTaxInputs, []);
  for (const field of ['grossGain', 'taxableGain', 'exemptionApplied', 'incrementalTax', 'cess', 'surcharge', 'netGain', 'postTaxRatePct']) {
    assert.equal(notAssumed[field], null, `${field} must remain absent when the scenario does not satisfy the STT prerequisite`);
  }
  assert.match(notAssumed.disclosure, /does not establish.*securities transaction tax condition/i);
});

test('WTI tax context accepts only a boolean STT scenario assumption and remains strict', () => {
  const context = {
    annualGrossIncome: 500000,
    incomeSource: 'salary',
    regime: 'new',
    fiscalYear: 'FY2026-27',
  };
  assert.equal(taxCalculationContextSchema.validate({ ...context, sttConditionAssumedSatisfied: true }).error, undefined);
  assert.equal(taxCalculationContextSchema.validate({ ...context, sttConditionAssumedSatisfied: false }).error, undefined);
  assert.ok(taxCalculationContextSchema.validate({ ...context, sttConditionAssumedSatisfied: 'true' }).error);
  assert.ok(taxCalculationContextSchema.validate({ ...context, sttConditionAssumedSatisfied: true, assumedBypass: true }).error);
  assert.ok(taxCalculationContextSchema.validate({ ...context, holdingPeriodMonths: -1 }).error);
  assert.ok(taxCalculationContextSchema.validate({ ...context, fiscalYear: 'not-a-fiscal-year' }).error);
  assert.ok(taxCalculationContextSchema.validate({
    ...context,
    acquisitionDate: '2026-02-30',
    redemptionDate: '2026-03-01',
  }).error);
  assert.ok(taxCalculationContextSchema.validate({
    ...context,
    acquisitionDate: '2026-01-01',
  }).error, 'acquisition and redemption dates must be supplied together');
  assert.ok(taxCalculationContextSchema.validate({
    ...context,
    acquisitionDate: '2026-01-02',
    redemptionDate: '2026-01-01',
  }).error, 'redemption cannot precede acquisition');
  assert.equal(taxCalculationContextSchema.validate({
    ...context,
    acquisitionDate: '2024-02-29',
    redemptionDate: '2024-03-01',
  }).error, undefined);
});

test('missing and null product risk evidence never becomes a product risk rating or access promise', () => {
  const product = {
    canonicalProductId: 'mf:amfi:123',
    name: 'Liquid Overnight ELSS Fund',
    productType: 'MUTUAL_FUND',
    parentInstrumentId: 'large_cap_mf',
    source: { provider: 'AMFI', instrumentId: '123', url: 'https://portal.amfiindia.com/ReportPublication.aspx?SchemeCode=123' },
    riskEvidence: null,
    accessTermsEvidence: null,
    productEligibility: {
      eligible: true,
      status: 'ELIGIBLE_WITHIN_SUITABLE_PARENT',
      scope: 'PARENT_HARD_SUITABILITY_VERIFIED_AMFI_CATEGORY_AND_EXPLICIT_DIRECT_PLAN',
    },
  };
  const result = generateBeginnerSuitability({
    product,
    parentCatalog: { id: 'large_cap_mf', riskScore: 3, suitabilityStatus: 'PASSED' },
    profile: { age: 35, riskTolerance: 'Moderate', investmentGoals: ['Wealth Growth'] },
  });

  assert.equal(result.riskTier, 'Product-specific risk unavailable');
  assert.equal(result.productRiskClassification.status, 'UNAVAILABLE');
  assert.equal(result.productRiskClassification.level, null);
  assert.deepEqual(result.parentCategoryRisk, {
    status: 'AVAILABLE',
    riskScore: 3,
    basis: 'WEALTHGENIE_PARENT_CATEGORY_RISK_MODEL',
    scope: 'PARENT_CATEGORY_ONLY',
  });
  assert.equal(result.parentCategorySuitability.status, 'PASSED');
  assert.equal(result.parentCategorySuitability.scope, 'PARENT_CATEGORY_ONLY');
  assert.equal(result.productSpecificSuitability.status, 'NOT_ESTABLISHED');
  assert.equal(result.accessToMoney, 'Product-specific access terms unavailable');
  assert.equal(result.productAccessTerms.status, 'UNAVAILABLE');
  assert.doesNotMatch(result.accessToMoney, /redeem anytime|business days|penalty.free|lock.in/i);
});

test('product names do not establish ELSS lock-in, debt risk, or liquidity terms', () => {
  const result = generateBeginnerSuitability({
    product: {
      canonicalProductId: 'mf:amfi:456',
      name: 'ELSS Liquid Low Risk Fund',
      productType: 'MUTUAL_FUND',
      parentInstrumentId: 'large_cap_mf',
    },
    parentCatalog: { id: 'large_cap_mf', riskScore: 3, suitabilityStatus: 'PASSED' },
    profile: { investmentGoals: ['Wealth Growth'] },
  });

  assert.equal(result.riskTier, 'Product-specific risk unavailable');
  assert.equal(result.accessToMoney, 'Product-specific access terms unavailable');
  assert.doesNotMatch(result.accessToMoney, /3-year|redeem anytime|1–3 business days/i);
});

test('fresh identity-bound provider risk evidence is preserved while stale or conflicting evidence fails closed', () => {
  const source = { provider: 'AMFI', instrumentId: '123', url: 'https://portal.amfiindia.com/ReportPublication.aspx?SchemeCode=123' };
  const product = {
    canonicalProductId: 'mf:amfi:123',
    parentInstrumentId: 'large_cap_mf',
    productType: 'MUTUAL_FUND',
    source,
    riskEvidence: {
      status: 'VERIFIED',
      scope: 'PRODUCT_SPECIFIC',
      canonicalProductId: 'mf:amfi:123',
      level: 'Moderately High',
      ratingSystem: 'AMFI risk-o-meter',
      source,
      observedAt: '2026-10-12T00:00:00.000Z',
      freshness: { status: 'FRESH', maxAgeSeconds: 172800 },
    },
  };
  const now = new Date('2026-10-13T00:00:00.000Z');
  const verified = generateBeginnerSuitability({ product, now });
  assert.equal(verified.productRiskClassification.status, 'VERIFIED');
  assert.equal(verified.productRiskClassification.level, 'Moderately High');
  assert.equal(verified.riskTier, 'Moderately High');

  const noRatingSystem = generateBeginnerSuitability({
    product: { ...product, riskEvidence: { ...product.riskEvidence, ratingSystem: undefined } },
    now,
  });
  assert.equal(noRatingSystem.productRiskClassification.status, 'UNAVAILABLE');

  const stale = generateBeginnerSuitability({
    product: { ...product, riskEvidence: { ...product.riskEvidence, observedAt: '2026-10-01T00:00:00.000Z', freshness: { status: 'FRESH', maxAgeSeconds: 60 } } },
    now,
  });
  assert.equal(stale.productRiskClassification.status, 'UNAVAILABLE');

  const conflicting = generateBeginnerSuitability({
    product: { ...product, riskEvidence: { ...product.riskEvidence, source: { ...source, provider: 'RBI' } } },
    now,
  });
  assert.equal(conflicting.productRiskClassification.status, 'UNAVAILABLE');
});

test('access terms require fresh product-bound evidence and profile applicability', () => {
  const source = { provider: 'SBI', instrumentId: '1y-public', url: 'https://sbi.co.in/web/interest-rates/deposit-rates/retail-domestic-term-deposit' };
  const product = {
    canonicalProductId: 'deposit:sbi:retail-domestic:1y-lt2y:public',
    parentInstrumentId: 'sbi_fd',
    productType: 'BANK_TERM_DEPOSIT',
    source,
    accessTermsEvidence: {
      status: 'VERIFIED',
      scope: 'PRODUCT_ACCESS_TERMS',
      canonicalProductId: 'deposit:sbi:retail-domestic:1y-lt2y:public',
      summary: 'The source-published early-exit exception applies to depositors aged 60 or older.',
      source,
      observedAt: '2026-10-12T00:00:00.000Z',
      freshness: { status: 'FRESH', maxAgeSeconds: 172800 },
      applicability: { minimumAge: 60 },
    },
  };
  const now = new Date('2026-10-13T00:00:00.000Z');
  const senior = generateBeginnerSuitability({ product, profile: { age: 65 }, now });
  assert.equal(senior.productAccessTerms.status, 'VERIFIED');
  assert.equal(senior.accessToMoney, product.accessTermsEvidence.summary);

  const notApplicable = generateBeginnerSuitability({ product, profile: { age: 59 }, now });
  assert.equal(notApplicable.productAccessTerms.status, 'NOT_APPLICABLE_TO_PROFILE');
  assert.equal(notApplicable.accessToMoney, 'Product-specific access terms unavailable');

  const stale = generateBeginnerSuitability({
    product: { ...product, accessTermsEvidence: { ...product.accessTermsEvidence, observedAt: '2026-10-01T00:00:00.000Z', freshness: { status: 'FRESH', maxAgeSeconds: 60 } } },
    profile: { age: 65 },
    now,
  });
  assert.equal(stale.productAccessTerms.status, 'UNAVAILABLE');

  const conflicting = generateBeginnerSuitability({
    product: { ...product, accessTermsEvidence: { ...product.accessTermsEvidence, source: { ...source, url: 'https://rbi.org.in/unrelated' } } },
    profile: { age: 65 },
    now,
  });
  assert.equal(conflicting.productAccessTerms.status, 'UNAVAILABLE');
});

test('tax inputs treat null income as missing and reject impossible exact calendar dates', () => {
  const product = {
    id: 'amfi:101',
    name: 'Qualified equity fund',
    parentInstrumentId: 'large_cap_mf',
    historicalReturn: { valuePct: 15 },
    taxMetadata: {
      sourceQualified: true,
      taxClass: 'EQUITY_MF_SECTION_112A',
      sourceReferences: [{ authority: 'AMFI', title: 'Qualified product tax adapter', url: 'https://www.amfiindia.com/', role: 'PRODUCT_RULE' }],
    },
  };
  const missingIncome = calculateProductPostTaxOutcome({
    product,
    taxCalculationContext: {
      annualGrossIncome: null,
      incomeSource: 'salary',
      regime: 'new',
      fiscalYear: 'FY2026-27',
      userAge: 35,
      holdingPeriodMonths: 18,
      section112AExemptionUsed: 0,
      sttConditionAssumedSatisfied: true,
    },
  });
  assert.equal(missingIncome.status, 'REQUIRES_TAX_INPUTS');
  assert.ok(missingIncome.requiredTaxInputs.includes('annualGrossIncome'));

  for (const annualGrossIncome of ['', '0x10', Number.NaN, Number.POSITIVE_INFINITY]) {
    const unavailable = calculateProductPostTaxOutcome({
      product,
      taxCalculationContext: {
        annualGrossIncome,
        incomeSource: 'salary', regime: 'new', fiscalYear: 'FY2026-27', userAge: 35,
        holdingPeriodMonths: 18, section112AExemptionUsed: 0, sttConditionAssumedSatisfied: true,
      },
    });
    assert.equal(unavailable.status, 'REQUIRES_TAX_INPUTS');
    assert.ok(unavailable.requiredTaxInputs.includes('annualGrossIncome'));
  }

  for (const field of ['holdingPeriodMonths', 'section112AExemptionUsed']) {
    const missingFact = calculateProductPostTaxOutcome({
      product,
      taxCalculationContext: {
        annualGrossIncome: 500000, incomeSource: 'salary', regime: 'new', fiscalYear: 'FY2026-27', userAge: 35,
        holdingPeriodMonths: 18, section112AExemptionUsed: 0, sttConditionAssumedSatisfied: true,
        [field]: null,
      },
    });
    assert.equal(missingFact.status, 'REQUIRES_TAX_INPUTS');
    assert.ok(missingFact.requiredTaxInputs.includes(field));
  }

  const context = {
    annualGrossIncome: 500000,
    incomeSource: 'salary',
    regime: 'new',
    fiscalYear: 'FY2026-27',
    userAge: 35,
    acquisitionDate: '2026-02-31',
    redemptionDate: '2026-10-01',
  };
  assert.ok(taxCalculationContextSchema.validate(context, { convert: false }).error);
});
