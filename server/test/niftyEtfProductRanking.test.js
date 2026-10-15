import assert from 'node:assert/strict';
import test from 'node:test';
import { rankWhereToInvestBackend } from '../services/RecommendationPipeline.js';
import { qualifiesCalculatedNiftyEtfTax } from '../scripts/demoPreflight.js';
import {
  isQualifiedNiftyEtfIdentity,
  rankQualifiedNiftyEtfProducts,
  supportsQualifiedEtfParentCategory,
} from '../services/niftyEtfProductRanking.js';
import { canonicalProfile } from './helpers/canonicalProfile.js';

const NOW = '2026-10-01T10:00:00.000Z';
const AMFI_NAV_URL = 'https://portal.amfiindia.com/spages/NAVAll.txt';
const AMFI_HISTORY_URL = 'https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?frmdt=28-Sep-2025&todt=04-Oct-2025';
const ETF_CATEGORY = 'Open Ended Schemes(Other Scheme - Other ETFs)';

function amfiProduct({
  schemeCode = '140084',
  isin = 'INF204KB14I2',
  name = 'Issuer-provided ETF scheme name',
  category = ETF_CATEGORY,
} = {}) {
  return {
    canonicalProductId: `mf:amfi:${schemeCode}`,
    productType: 'MUTUAL_FUND',
    name,
    providerName: 'Nippon India Mutual Fund',
    schemeCategory: category,
    externalIds: [
      { source: 'AMFI_SCHEME_CODE', value: schemeCode },
      { source: 'ISIN', value: isin },
    ],
    source: { provider: 'AMFI', url: AMFI_NAV_URL },
  };
}

function amfiNavFact({
  schemeCode = '140084',
  value = 250,
  observedAt = '2026-10-01T09:55:00.000Z',
  fetchedAt = NOW,
  sourceUrl = AMFI_NAV_URL,
  freshness = 'FRESH',
} = {}) {
  return {
    kind: 'MUTUAL_FUND_NAV',
    canonicalProductId: `mf:amfi:${schemeCode}`,
    value,
    currency: 'INR',
    unit: 'NAV_PER_UNIT',
    observedAt,
    fetchedAt,
    historicalContext: { targetDate: '2025-10-01' },
    availabilityStatus: 'AVAILABLE',
    freshness: { status: freshness, ageSeconds: 300, maxAgeSeconds: 345600 },
    source: { provider: 'AMFI', instrumentId: schemeCode, url: sourceUrl },
  };
}

function snapshots({ product, currentFact, historyFact } = {}) {
  return {
    current: {
      provider: 'AMFI',
      status: 'AVAILABLE',
      fetchedAt: NOW,
      products: [product || amfiProduct()],
      facts: [currentFact || amfiNavFact()],
    },
    historical: {
      provider: 'AMFI',
      status: 'AVAILABLE',
      fetchedAt: NOW,
      targetDate: '2025-10-01',
      facts: [historyFact || amfiNavFact({
        value: 200,
        observedAt: '2025-10-01T09:55:00.000Z',
        sourceUrl: AMFI_HISTORY_URL,
        freshness: 'STALE',
      })],
    },
  };
}

function exactIdentity() {
  return {
    canonicalProductId: 'etf:isin:INF204KB14I2',
    amfiSchemeCode: '140084',
    isin: 'INF204KB14I2',
    exchange: 'NSE',
    ticker: 'NIFTYBEES',
    benchmark: { id: 'NIFTY_50', name: 'NIFTY 50', returnVariant: 'NIFTY 50 TRI' },
    identityEvidence: { url: 'https://nsearchives.nseindia.com/trading_security/mf/pdf/Nippon_20032026171200_NipponMutualFund.pdf' },
    listingEvidence: { url: 'https://nsearchives.nseindia.com/content/circulars/CMPT74390.pdf' },
    benchmarkEvidence: { url: 'https://mf.nipponindiaim.com/FundsAndPerformance/ProductNotes/NipponIndia-ETF-Nifty-50-BeES-Feb-2026.pdf' },
  };
}

test('the exact Nifty 50 ETF identity is source-ID based and requires official benchmark evidence', () => {
  assert.equal(supportsQualifiedEtfParentCategory('nifty_etf'), true);
  assert.equal(isQualifiedNiftyEtfIdentity(exactIdentity()), true);

  const wrongBenchmark = exactIdentity();
  wrongBenchmark.benchmark = { ...wrongBenchmark.benchmark, id: 'NIFTY_NEXT_50' };
  assert.equal(isQualifiedNiftyEtfIdentity(wrongBenchmark), false);

  const missingBenchmark = exactIdentity();
  missingBenchmark.benchmark = null;
  assert.equal(isQualifiedNiftyEtfIdentity(missingBenchmark), false);

  const wrongIsin = exactIdentity();
  wrongIsin.isin = 'INF204KB15I9';
  assert.equal(isQualifiedNiftyEtfIdentity(wrongIsin), false);
  const wrongOfficialDocument = exactIdentity();
  wrongOfficialDocument.benchmarkEvidence.url = 'https://mf.nipponindiaim.com/FundsAndPerformance/Pages/unrelated-scheme.aspx';
  assert.equal(isQualifiedNiftyEtfIdentity(wrongOfficialDocument), false);
  assert.equal(supportsQualifiedEtfParentCategory('sensex_etf'), false);
});

test('an exact scheme with fresh AMFI NAV is returned as one comparable option, not a ranking', () => {
  const { current, historical } = snapshots({ product: amfiProduct({ name: 'Display label may change' }) });
  const result = rankQualifiedNiftyEtfProducts({
    parentInstrumentId: 'nifty_etf',
    currentSnapshot: current,
    historicalSnapshot: historical,
  });

  assert.equal(result.products.length, 1);
  const [product] = result.products;
  assert.equal(product.id, 'etf:isin:INF204KB14I2');
  assert.equal(product.productType, 'ETF');
  assert.equal(product.name, 'Display label may change');
  assert.equal(product.benchmark.canonicalProductId, 'market:index:nifty-50');
  assert.equal(product.exchange, 'NSE');
  assert.equal(product.ticker, 'NIFTYBEES');
  assert.equal(product.isin, 'INF204KB14I2');
  assert.equal(product.nav.value, 250);
  assert.equal(product.nav.source.provider, 'AMFI');
  assert.equal(product.marketPrice.value, null);
  assert.equal(product.marketPrice.availabilityStatus, 'UNAVAILABLE');
  assert.equal(product.primaryFact.kind, 'MUTUAL_FUND_NAV');
  assert.equal(product.primaryFact.canonicalProductId, 'mf:amfi:140084');
  assert.equal(product.primaryFact.value, product.nav.value);
  assert.equal(product.historicalReturn.isExpectedReturn, false);
  assert.equal(product.historicalReturn.source.startInstrumentId, product.source.instrumentId);
  assert.equal(product.historicalReturn.source.endInstrumentId, product.source.instrumentId);
  assert.equal(product.historicalReturn.source.historyTargetDate, '2025-10-01');
  assert.equal(product.returnBasis, 'HISTORICAL_POINT_TO_POINT_NAV_RETURN_1Y');
  assert.equal(product.expectedReturn, null);
  assert.equal(product.nominalReturn, null);
  assert.equal(product.postTaxReturn, null);
  assert.equal(product.expenseRatio, null);
  assert.equal(product.trackingError, null);
  assert.equal(product.trackingDifference, null);
  assert.equal(product.liquidityEvidence, null);
  assert.equal(product.riskEvidence, null);
  assert.equal(product.productTaxClassification, null);
  assert.equal(product.productEligibility.eligible, null);
  assert.equal(product.productEligibility.status, 'PARENT_SUITABILITY_PASSED_PRODUCT_ACCESS_FACTS_UNAVAILABLE');
  assert.equal(result.ranking.status, 'VERIFIED_COMPARABLE_OPTIONS');
  assert.equal(result.ranking.hasUniqueLeader, false);
  assert.equal(product.rank, null);
});

test('ETF historical NAV requires the exact AMFI query window bound to the snapshot target date', () => {
  const malformedUrls = [
    'https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?frmdt=28-Sep-2025&todt=04-Oct-2025&extra=1',
    'https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?frmdt=27-Sep-2025&todt=03-Oct-2025',
    'https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?frmdt=28-Sep-2025&frmdt=28-Sep-2025&todt=04-Oct-2025',
  ];
  for (const sourceUrl of malformedUrls) {
    const { current, historical } = snapshots();
    historical.facts[0].source.url = sourceUrl;
    const [product] = rankQualifiedNiftyEtfProducts({
      parentInstrumentId: 'nifty_etf', currentSnapshot: current, historicalSnapshot: historical,
    }).products;
    assert.equal(product.historicalReturn, null);
  }

  const missingTargetDate = snapshots();
  delete missingTargetDate.historical.targetDate;
  const [withoutTarget] = rankQualifiedNiftyEtfProducts({
    parentInstrumentId: 'nifty_etf',
    currentSnapshot: missingTargetDate.current,
    historicalSnapshot: missingTargetDate.historical,
  }).products;
  assert.equal(withoutTarget.historicalReturn, null);
});

test('name-only and wrong-benchmark-like ETF rows cannot pass exact ID matching', () => {
  const wrongScheme = amfiProduct({
    schemeCode: '140085',
    isin: 'INF204KB15I9',
    name: 'Nifty 50 ETF',
  });
  const source = snapshots({
    product: wrongScheme,
    currentFact: amfiNavFact({ schemeCode: '140085' }),
  });
  const result = rankQualifiedNiftyEtfProducts({
    parentInstrumentId: 'nifty_etf',
    currentSnapshot: source.current,
    historicalSnapshot: source.historical,
  });
  assert.equal(result.products.length, 0);
  assert.equal(result.ranking.status, 'UNAVAILABLE');
});

test('wrong category, conflicting ISIN, stale NAV, and future-dated NAV fail closed', () => {
  const cases = [
    snapshots({ product: amfiProduct({ category: 'Open Ended Schemes(Equity Scheme - Large Cap Fund)' }) }),
    snapshots({ product: amfiProduct({ isin: 'INF204KB15I9' }) }),
    snapshots({ currentFact: amfiNavFact({ freshness: 'STALE' }) }),
    snapshots({ currentFact: amfiNavFact({ observedAt: '2026-10-01T10:02:00.000Z' }) }),
  ];
  for (const { current, historical } of cases) {
    const result = rankQualifiedNiftyEtfProducts({
      parentInstrumentId: 'nifty_etf', currentSnapshot: current, historicalSnapshot: historical,
    });
    assert.deepEqual(result.products, []);
  }
});

test('ambiguous duplicate product identities or current NAV facts fail closed', () => {
  const duplicateProducts = snapshots();
  duplicateProducts.current.products.push({ ...duplicateProducts.current.products[0] });
  const duplicateFacts = snapshots();
  duplicateFacts.current.facts.push({ ...duplicateFacts.current.facts[0] });

  for (const { current, historical } of [duplicateProducts, duplicateFacts]) {
    const result = rankQualifiedNiftyEtfProducts({
      parentInstrumentId: 'nifty_etf', currentSnapshot: current, historicalSnapshot: historical,
    });
    assert.deepEqual(result.products, []);
    assert.equal(result.ranking.status, 'UNAVAILABLE');
  }
});

test('exact ETF source facts reject missing, mismatched, duplicate, or wrong-provider current identity', () => {
  const missingId = snapshots();
  delete missingId.current.facts[0].canonicalProductId;

  const mismatchedId = snapshots();
  mismatchedId.current.facts[0].canonicalProductId = 'mf:amfi:140085';

  const wrongScheme = snapshots();
  wrongScheme.current.products[0].externalIds[0].value = '140085';

  const duplicateFacts = snapshots();
  duplicateFacts.current.facts.push({ ...duplicateFacts.current.facts[0] });

  const wrongProvider = snapshots();
  wrongProvider.current.provider = 'UPSTOX';

  for (const { current, historical } of [missingId, mismatchedId, wrongScheme, duplicateFacts, wrongProvider]) {
    const result = rankQualifiedNiftyEtfProducts({
      parentInstrumentId: 'nifty_etf', currentSnapshot: current, historicalSnapshot: historical,
    });
    assert.deepEqual(result.products, []);
    assert.equal(result.ranking.status, 'UNAVAILABLE');
  }
});

test('provider failure or missing NAV never inserts catalog or market-price fallback values', () => {
  const sourceError = {
    provider: 'AMFI', status: 'SOURCE_ERROR', fetchedAt: NOW, products: [], facts: [],
  };
  const result = rankQualifiedNiftyEtfProducts({
    parentInstrumentId: 'nifty_etf', currentSnapshot: sourceError, historicalSnapshot: null,
  });
  assert.equal(result.products.length, 0);
  assert.equal(result.ranking.status, 'UNAVAILABLE');
});

test('WTI integrates exact ETF facts and exposes qualified tax classification while requiring explicit tax inputs', async () => {
  const { current, historical } = snapshots();
  const timingEvents = [];
  const result = await rankWhereToInvestBackend(
    canonicalProfile(),
    { parentInstrumentId: 'nifty_etf' },
    {
      fetchAmfiProductSnapshot: async () => current,
      fetchAmfiHistoricalNavSnapshot: async () => historical,
      onStageTiming: event => timingEvents.push(event),
    },
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].canonicalProductId, 'etf:isin:INF204KB14I2');
  assert.equal(result[0].postTaxAnalysis.status, 'REQUIRES_TAX_INPUTS');
  assert.equal(result[0].taxMetadata.taxClass, 'EQUITY_MF_SECTION_112A');
  assert.equal(result[0].taxMetadata.productEvidence.officialSourceUrl, 'https://mf.nipponindiaim.com/InvestorServices/SIDETF/NipponIndia-ETF-Nifty-50-BeES.pdf');
  assert.equal(result[0].postTaxAnalysis.incrementalTax, null);
  assert.deepEqual(result.metadata.ranking.reasonCodes.includes('NIFTY_50_BENCHMARK_VERIFIED'), true);
  assert.equal(result.metadata.catalog.providerCoverage.status, 'QUALIFIED_PROVIDER_PATH');
  assert.deepEqual(timingEvents.map(event => event.stage), ['exact_etf_qualification', 'tax_enrichment']);
  assert.ok(timingEvents.every(event => Number.isInteger(event.elapsedMs) && event.elapsedMs >= 0));
});

test('exact NIFTYBEES uses versioned tax policy, explicit STT scenario, holding boundary, and exemption inputs', async () => {
  const { current, historical } = snapshots();
  const baseContext = {
    annualGrossIncome: 500000,
    incomeSource: 'salary',
    regime: 'new',
    fiscalYear: 'FY2026-27',
    userAge: 35,
    holdingPeriodMonths: 18,
    section112AExemptionUsed: 0,
    sttConditionAssumedSatisfied: true,
    illustrativePrincipal: 1000000,
  };
  const rank = taxCalculationContext => rankWhereToInvestBackend(
    canonicalProfile(),
    { parentInstrumentId: 'nifty_etf', taxCalculationContext },
    {
      fetchAmfiProductSnapshot: async () => current,
      fetchAmfiHistoricalNavSnapshot: async () => historical,
    },
  );

  const shortTerm = (await rank({ ...baseContext, holdingPeriodMonths: 12 }))[0];
  assert.equal(shortTerm.postTaxAnalysis.status, 'CALCULATED');
  assert.ok(shortTerm.postTaxAnalysis.rulesApplied.includes('INCOME_TAX_ACT_2025_EQUITY_STCG_SPECIAL_RATE_POLICY'));
  assert.ok(shortTerm.postTaxAnalysis.taxRuleMetadata.currentRuleReferences.some(reference => reference.reference === 'Section 196'));

  const firstLongTermMonth = (await rank({ ...baseContext, holdingPeriodMonths: 13 }))[0];
  assert.equal(firstLongTermMonth.postTaxAnalysis.status, 'CALCULATED');
  assert.ok(firstLongTermMonth.postTaxAnalysis.rulesApplied.includes('INCOME_TAX_ACT_2025_EQUITY_LTCG_SPECIAL_RATE_POLICY'));
  assert.ok(firstLongTermMonth.postTaxAnalysis.taxRuleMetadata.currentRuleReferences.some(reference => reference.reference === 'Section 198'));

  const longTerm = (await rank(baseContext))[0];
  assert.equal(longTerm.postTaxAnalysis.status, 'CALCULATED');
  assert.ok(longTerm.postTaxAnalysis.rulesApplied.includes('INCOME_TAX_ACT_2025_EQUITY_LTCG_SPECIAL_RATE_POLICY'));
  assert.ok(longTerm.postTaxAnalysis.taxRuleMetadata.currentRuleReferences.some(reference => reference.reference === 'Section 198'));
  assert.equal(longTerm.postTaxAnalysis.taxRuleMetadata.statute, 'INCOME_TAX_ACT_2025');
  assert.equal(longTerm.postTaxAnalysis.taxRuleMetadata.fiscalYear, 'FY2026-27');
  assert.equal(longTerm.postTaxAnalysis.taxRuleMetadata.taxYear, 'TY2026-27');
  assert.equal(longTerm.postTaxAnalysis.taxClassificationMetadata.productEvidence.classification, 'EQUITY_ORIENTED_FUND');
  assert.equal(longTerm.postTaxAnalysis.taxClassificationMetadata.productEvidence.binding.isin, 'INF204KB14I2');
  assert.ok(longTerm.postTaxAnalysis.sourceReferences.some(reference => reference.role === 'PRODUCT_RULE'
    && reference.url === 'https://mf.nipponindiaim.com/InvestorServices/SIDETF/NipponIndia-ETF-Nifty-50-BeES.pdf'));
  assert.ok(longTerm.postTaxAnalysis.sourceReferences.some(reference => reference.role === 'TAX_POLICY'
    && reference.url === 'https://www.incometaxindia.gov.in/documents/d/guest/income_tax_act_2025_as_amended_by_fa_act_2026-pdf'));
  assert.ok(longTerm.postTaxAnalysis.assumptions.includes('STT_CONDITION_ASSUMED_SATISFIED_FOR_HYPOTHETICAL_TRANSFER'));
  assert.equal(longTerm.historicalReturn.isExpectedReturn, false);
  assert.equal(longTerm.marketPrice.availabilityStatus, 'UNAVAILABLE');
  assert.equal(longTerm.expectedReturn, null);
  assert.equal(longTerm.postTaxReturn, null);

  const exhaustedExemption = (await rank({ ...baseContext, holdingPeriodMonths: 13, section112AExemptionUsed: 125000 }))[0];
  assert.equal(longTerm.postTaxAnalysis.exemptionApplied, 125000);
  assert.equal(exhaustedExemption.postTaxAnalysis.exemptionApplied, 0);
  assert.ok(exhaustedExemption.postTaxAnalysis.incrementalTax > longTerm.postTaxAnalysis.incrementalTax);

  const missingStt = (await rank({ ...baseContext, sttConditionAssumedSatisfied: undefined }))[0];
  const failedStt = (await rank({ ...baseContext, sttConditionAssumedSatisfied: false }))[0];
  assert.equal(missingStt.postTaxAnalysis.status, 'REQUIRES_TAX_INPUTS');
  assert.ok(missingStt.postTaxAnalysis.requiredTaxInputs.includes('sttConditionAssumedSatisfied'));
  assert.equal(missingStt.postTaxAnalysis.incrementalTax, null);
  assert.equal(failedStt.postTaxAnalysis.status, 'UNAVAILABLE');
  assert.equal(failedStt.postTaxAnalysis.incrementalTax, null);
});

test('negative NIFTYBEES historical return stays source-bound and does not enter the gain-only tax calculator', async () => {
  const { current, historical } = snapshots({
    currentFact: amfiNavFact({ value: 250 }),
    historyFact: amfiNavFact({
      value: 280,
      observedAt: '2025-10-01T09:55:00.000Z',
      sourceUrl: AMFI_HISTORY_URL,
      freshness: 'STALE',
    }),
  });
  const taxCalculationContext = {
    annualGrossIncome: 1200000,
    incomeSource: 'salary',
    regime: 'new',
    fiscalYear: 'FY2026-27',
    userAge: 22,
    holdingPeriodMonths: 18,
    section112AExemptionUsed: 0,
    sttConditionAssumedSatisfied: true,
    illustrativePrincipal: 100000,
  };
  const rank = context => rankWhereToInvestBackend(
    canonicalProfile(),
    { parentInstrumentId: 'nifty_etf', taxCalculationContext: context },
    {
      fetchAmfiProductSnapshot: async () => current,
      fetchAmfiHistoricalNavSnapshot: async () => historical,
    },
  );

  let result;
  await assert.doesNotReject(async () => { result = await rank(taxCalculationContext); });
  const serializedResult = JSON.parse(JSON.stringify(result));
  const [product] = serializedResult;
  assert.equal(product.canonicalProductId, 'etf:isin:INF204KB14I2');
  assert.ok(product.historicalReturn.valuePct < 0);
  assert.equal(product.postTaxAnalysis.status, 'CALCULATED');
  assert.ok(product.postTaxAnalysis.grossGain < 0);
  assert.equal(product.postTaxAnalysis.taxableGain, 0);
  assert.equal(product.postTaxAnalysis.exemptionApplied, 0);
  assert.equal(product.postTaxAnalysis.incrementalTax, 0);
  assert.equal(product.postTaxAnalysis.cess, 0);
  assert.equal(product.postTaxAnalysis.surcharge, 0);
  assert.equal(product.postTaxAnalysis.netGain, product.postTaxAnalysis.grossGain);
  assert.ok(product.postTaxAnalysis.postTaxRatePct < 0);
  assert.ok(product.postTaxAnalysis.rulesApplied.includes('INCOME_TAX_ACT_2025_EQUITY_LTCG_SPECIAL_RATE_POLICY'));
  assert.equal(product.postTaxAnalysis.rulesApplied.includes('INCOME_TAX_ACT_2025_EQUITY_STCG_SPECIAL_RATE_POLICY'), false);
  assert.ok(product.postTaxAnalysis.taxRuleMetadata.currentRuleReferences.some(reference => reference.reference === 'Section 198'));
  assert.ok(product.postTaxAnalysis.assumptions.includes('CAPITAL_LOSS_TAX_BENEFIT_NOT_MODELED'));
  assert.match(product.postTaxAnalysis.disclosure, /HISTORICAL\s*[—-]\s*NOT A FORECAST/i);
  assert.match(product.postTaxAnalysis.disclosure, /no tax is charged on this negative result/i);
  assert.match(product.postTaxAnalysis.disclosure, /loss set-off, carry-forward.*not modeled/i);
  assert.match(product.postTaxAnalysis.disclosure, /no realized transaction is asserted/i);
  assert.match(product.postTaxAnalysis.disclosure, /not verified for an actual transaction/i);
  assert.equal(qualifiesCalculatedNiftyEtfTax(product, taxCalculationContext), true);

  const shortTermContext = { ...taxCalculationContext, holdingPeriodMonths: 12 };
  const [shortTermLoss] = await rankWhereToInvestBackend(
    canonicalProfile(),
    { parentInstrumentId: 'nifty_etf', taxCalculationContext: shortTermContext },
    {
      fetchAmfiProductSnapshot: async () => current,
      fetchAmfiHistoricalNavSnapshot: async () => historical,
    },
  );
  assert.ok(shortTermLoss.postTaxAnalysis.rulesApplied.includes('INCOME_TAX_ACT_2025_EQUITY_STCG_SPECIAL_RATE_POLICY'));
  assert.ok(shortTermLoss.postTaxAnalysis.taxRuleMetadata.currentRuleReferences.some(reference => reference.reference === 'Section 196'));
  assert.equal(shortTermLoss.postTaxAnalysis.rulesApplied.includes('INCOME_TAX_ACT_2025_EQUITY_LTCG_SPECIAL_RATE_POLICY'), false);
  assert.equal(qualifiesCalculatedNiftyEtfTax(shortTermLoss, shortTermContext), true);

  const exactDateContext = {
    ...taxCalculationContext,
    acquisitionDate: '2026-01-01',
    redemptionDate: '2026-10-01',
  };
  const [exactDateLoss] = await rank(exactDateContext);
  assert.equal(exactDateLoss.postTaxAnalysis.holdingPeriodBasis, 'EXACT_TRANSACTION_DATES');
  assert.ok(exactDateLoss.postTaxAnalysis.rulesApplied.includes('INCOME_TAX_ACT_2025_EQUITY_STCG_SPECIAL_RATE_POLICY'));
  assert.equal(exactDateLoss.postTaxAnalysis.rulesApplied.includes('INCOME_TAX_ACT_2025_EQUITY_LTCG_SPECIAL_RATE_POLICY'), false);
  assert.equal(qualifiesCalculatedNiftyEtfTax(exactDateLoss, exactDateContext), true);
});

test('zero NIFTYBEES historical return retains the versioned holding-period rule and strict preflight evidence', async () => {
  const { current, historical } = snapshots({
    currentFact: amfiNavFact({ value: 250 }),
    historyFact: amfiNavFact({
      value: 250,
      observedAt: '2025-10-01T09:55:00.000Z',
      sourceUrl: AMFI_HISTORY_URL,
      freshness: 'STALE',
    }),
  });
  const taxCalculationContext = {
    annualGrossIncome: 1200000,
    incomeSource: 'salary',
    regime: 'new',
    fiscalYear: 'FY2026-27',
    userAge: 22,
    holdingPeriodMonths: 18,
    section112AExemptionUsed: 0,
    sttConditionAssumedSatisfied: true,
    illustrativePrincipal: 100000,
  };
  const [product] = await rankWhereToInvestBackend(
    canonicalProfile(),
    { parentInstrumentId: 'nifty_etf', taxCalculationContext },
    {
      fetchAmfiProductSnapshot: async () => current,
      fetchAmfiHistoricalNavSnapshot: async () => historical,
    },
  );

  assert.equal(product.canonicalProductId, 'etf:isin:INF204KB14I2');
  assert.equal(product.historicalReturn.valuePct, 0);
  assert.equal(product.postTaxAnalysis.status, 'CALCULATED');
  assert.equal(product.postTaxAnalysis.grossGain, 0);
  assert.equal(product.postTaxAnalysis.taxableGain, 0);
  assert.equal(product.postTaxAnalysis.exemptionApplied, 0);
  assert.equal(product.postTaxAnalysis.incrementalTax, 0);
  assert.equal(product.postTaxAnalysis.cess, 0);
  assert.equal(product.postTaxAnalysis.surcharge, 0);
  assert.equal(product.postTaxAnalysis.netGain, 0);
  assert.equal(product.postTaxAnalysis.postTaxRatePct, 0);
  assert.ok(product.postTaxAnalysis.rulesApplied.includes('INCOME_TAX_ACT_2025_EQUITY_LTCG_SPECIAL_RATE_POLICY'));
  assert.equal(product.postTaxAnalysis.rulesApplied.includes('INCOME_TAX_ACT_2025_EQUITY_STCG_SPECIAL_RATE_POLICY'), false);
  assert.ok(product.postTaxAnalysis.taxRuleMetadata.currentRuleReferences.some(reference => reference.reference === 'Section 198'));
  assert.ok(product.postTaxAnalysis.assumptions.includes('NO_POSITIVE_CAPITAL_GAIN_TAX_NOT_APPLIED'));
  assert.match(product.postTaxAnalysis.disclosure, /no positive capital gain/i);
  assert.match(product.postTaxAnalysis.disclosure, /no tax is charged on this zero result/i);
  assert.match(product.postTaxAnalysis.disclosure, /no realized transaction is asserted/i);
  assert.equal(qualifiesCalculatedNiftyEtfTax(product, taxCalculationContext), true);
});

test('NIFTYBEES tax analysis fails closed for an unsupported fiscal year', async () => {
  const { current, historical } = snapshots();
  const [product] = await rankWhereToInvestBackend(
    canonicalProfile(),
    {
      parentInstrumentId: 'nifty_etf',
      taxCalculationContext: {
        annualGrossIncome: 1200000,
        incomeSource: 'salary',
        regime: 'new',
        fiscalYear: 'FY2027-28',
        userAge: 22,
        holdingPeriodMonths: 18,
        section112AExemptionUsed: 0,
        sttConditionAssumedSatisfied: true,
        illustrativePrincipal: 100000,
      },
    },
    {
      fetchAmfiProductSnapshot: async () => current,
      fetchAmfiHistoricalNavSnapshot: async () => historical,
    },
  );

  assert.equal(product.canonicalProductId, 'etf:isin:INF204KB14I2');
  assert.equal(product.postTaxAnalysis.status, 'FISCAL_YEAR_UNSUPPORTED');
  assert.equal(product.postTaxAnalysis.incrementalTax, null);
  assert.equal(product.postTaxAnalysis.taxRuleMetadata, null);
});

test('WTI can rank exact AMFI evidence without synchronously persisting current or historical universes', async () => {
  const { current, historical } = snapshots();
  const fetchOptions = [];
  const result = await rankWhereToInvestBackend(
    canonicalProfile(),
    { parentInstrumentId: 'nifty_etf' },
    {
      persistAmfiSnapshots: false,
      fetchAmfiProductSnapshot: async options => {
        fetchOptions.push(['current', options]);
        return current;
      },
      fetchAmfiHistoricalNavSnapshot: async options => {
        fetchOptions.push(['historical', options]);
        return historical;
      },
    },
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].canonicalProductId, 'etf:isin:INF204KB14I2');
  assert.equal(result[0].postTaxAnalysis.status, 'REQUIRES_TAX_INPUTS');
  assert.ok(result[0].postTaxAnalysis.requiredTaxInputs.includes('sttConditionAssumedSatisfied'));
  assert.deepEqual(fetchOptions.map(([kind, options]) => [kind, options.persist]), [
    ['current', false],
    ['historical', false],
  ]);
  assert.equal(typeof fetchOptions[1][1].targetDate, 'string');
});
