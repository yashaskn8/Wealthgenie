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
  const fdProduct = {
    id: 'sbi:fd:1y',
    name: 'SBI 1-Year Term Deposit',
    parentInstrumentId: 'sbi_fd',
    officialRate: { value: 7.0 },
  };
  const outcome = calculateProductPostTaxOutcome({
    product: fdProduct,
    profile: { age: 35 },
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
    ['TAX_POLICY'],
  );
  assert.equal(
    outcome.sourceReferences.length,
    new Set(outcome.sourceReferences.map(source => [source.authority, source.title, source.url, source.role].join('|'))).size,
  );
  assert.equal(outcome.isHistoricalEstimate, false);
});

test('an explicit zero official rate remains a calculated zero after-tax result', () => {
  const outcome = calculateProductPostTaxOutcome({
    product: {
      id: 'sbi:fd:zero',
      name: 'SBI deposit with an explicit zero rate',
      parentInstrumentId: 'sbi_fd',
      officialRate: { value: 0 },
    },
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

test('missing or blank annual income stays required while an explicit zero income is accepted', () => {
  const product = {
    id: 'sbi:fd:1y',
    name: 'SBI 1-Year Term Deposit',
    parentInstrumentId: 'sbi_fd',
    officialRate: { value: 7.0 },
  };
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
      taxCalculationContext: { ...taxContext, annualGrossIncome },
    });

    assert.equal(outcome.status, 'REQUIRES_TAX_INPUTS');
    assert.deepEqual(outcome.requiredTaxInputs, ['annualGrossIncome']);
    assert.equal(outcome.postTaxRatePct, null);
  }

  const zeroIncomeOutcome = calculateProductPostTaxOutcome({
    product,
    taxCalculationContext: { ...taxContext, annualGrossIncome: 0 },
  });
  assert.equal(zeroIncomeOutcome.status, 'CALCULATED');
  assert.equal(zeroIncomeOutcome.postTaxRatePct, 7);
});

test('missing or blank historical return facts are unavailable while an explicit zero remains calculated', () => {
  const product = {
    id: 'amfi:101',
    name: 'Qualified equity fund',
    productType: 'MUTUAL_FUND',
    parentInstrumentId: 'large_cap_mf',
    taxMetadata: {
      sourceQualified: true,
      taxClass: 'EQUITY_MF_SECTION_112A',
      sourceReferences: [{ authority: 'AMFI', title: 'Qualified product tax adapter', url: 'https://www.amfiindia.com/' }],
    },
  };
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
      product: { ...product, historicalReturn: { valuePct } },
      taxCalculationContext,
    });

    assert.equal(outcome.status, 'PRODUCT_FACTS_UNAVAILABLE');
    assert.equal(outcome.postTaxRatePct, null);
    assert.ok(outcome.unavailableReasons.includes('QUALIFIED_HISTORICAL_RETURN_UNAVAILABLE'));
  }

  const zeroReturnOutcome = calculateProductPostTaxOutcome({
    product: { ...product, historicalReturn: { valuePct: 0 } },
    taxCalculationContext,
  });
  assert.equal(zeroReturnOutcome.status, 'CALCULATED');
  assert.equal(zeroReturnOutcome.grossGain, 0);
  assert.equal(zeroReturnOutcome.postTaxRatePct, 0);
});

test('RBI FRSB labels outcome as Current coupon after tax and disclaims 6-month reset without 7-year guarantee', () => {
  const rbiBond = {
    id: 'rbi:frsb:current',
    name: 'RBI Floating Rate Savings Bond',
    parentInstrumentId: 'rbi_bonds',
    officialRate: { value: 8.05 },
  };
  const outcome = calculateProductPostTaxOutcome({
    product: rbiBond,
    profile: { age: 40 },
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
});

test('Mutual fund returns are labelled HISTORICAL and NOT A FORECAST', () => {
  const equityMf = {
    id: 'amfi:101',
    name: 'Nifty 50 Index Fund',
    productType: 'MUTUAL_FUND',
    parentInstrumentId: 'large_cap_mf',
    historicalReturn: { valuePct: 15.0 },
    taxMetadata: {
      sourceQualified: true,
      taxClass: 'EQUITY_MF_SECTION_112A',
      sourceReferences: [{ authority: 'AMFI', title: 'Qualified product tax adapter', url: 'https://www.amfiindia.com/' }],
      rulesApplied: ['SECTION_112A_LTCG_SPECIAL_RATE'],
    },
  };
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
});

test('exact-date WTI tax classification keeps the anniversary short-term without fake month conversion', () => {
  const outcome = calculateProductPostTaxOutcome({
    product: {
      name: 'Qualified equity fund',
      parentInstrumentId: 'large_cap_mf',
      historicalReturn: { valuePct: 15 },
      taxMetadata: {
        sourceQualified: true,
        taxClass: 'EQUITY_MF_SECTION_112A',
        sourceReferences: [{ authority: 'AMFI', title: 'Qualified product tax adapter', url: 'https://www.amfiindia.com/' }],
      },
    },
    taxCalculationContext: {
      annualGrossIncome: 1500000,
      regime: 'new',
      fiscalYear: 'FY2026-27',
      incomeSource: 'salary',
      userAge: 35,
      acquisitionDate: '2024-04-01',
      redemptionDate: '2025-04-01',
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
  const products = [
    {
      id: 'amfi:101',
      name: 'Test Fund',
    productType: 'MUTUAL_FUND',
    parentInstrumentId: 'large_cap_mf',
    historicalReturn: { valuePct: 18.25 },
    taxMetadata: {
      sourceQualified: true,
      taxClass: 'EQUITY_MF_SECTION_112A',
      sourceReferences: [{ authority: 'AMFI', title: 'Qualified product tax adapter', url: 'https://www.amfiindia.com/' }],
      rulesApplied: ['SECTION_112A_LTCG_SPECIAL_RATE'],
    },
      postTaxReturn: null,
    },
  ];
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
  const products = [5, 6, 7, 8, 9].map((rate, index) => ({
    id: `sbi:fd:${index + 1}`,
    parentInstrumentId: 'sbi_fd',
    name: `SBI deposit option ${index + 1}`,
    rank: index + 1,
    officialRate: { value: rate },
    postTaxReturn: null,
  }));
  const options = {
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
