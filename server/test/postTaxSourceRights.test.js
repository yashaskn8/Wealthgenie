import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { investmentDatabase } from '../data/investmentDatabase.js';
import { getWhereToInvestProviderCoverageMatrix } from '../services/RecommendationPipeline.js';
import {
  buildPostTaxCoverageMatrix,
} from '../services/postTaxCoverageMatrix.js';
import {
  isPostTaxSourceProductionAllowed,
  matchesSourceRightsEndpoint,
  POST_TAX_SOURCE_RIGHTS_STATES,
  resolvePostTaxProductRights,
  resolvePostTaxSourceRights,
} from '../services/postTaxSourceRights.js';
import { PROVIDERS } from '../services/marketData/contracts.js';
import { enrichProductsWithPostTaxAndSuitability } from '../services/productPostTaxCalculator.js';

const matrixPath = fileURLToPath(new URL('../data/postTaxCoverageMatrix.json', import.meta.url));

test('AMFI and India Post rights remain blocked for the current WealthGenie production use', () => {
  const amfi = resolvePostTaxSourceRights({
    provider: PROVIDERS.AMFI,
    url: 'https://portal.amfiindia.com/spages/NAVAll.txt',
  });
  assert.equal(amfi.status, POST_TAX_SOURCE_RIGHTS_STATES.BLOCKED_REUSE_RIGHTS);
  assert.equal(amfi.rights.commercialUse, POST_TAX_SOURCE_RIGHTS_STATES.BLOCKED_REUSE_RIGHTS);
  assert.equal(amfi.productionPostTaxUseAllowed, false);

  const indiaPost = resolvePostTaxSourceRights({
    provider: PROVIDERS.GOVERNMENT_OF_INDIA,
    url: 'https://www.indiapost.gov.in/banking-services/savings',
  });
  assert.equal(indiaPost.status, POST_TAX_SOURCE_RIGHTS_STATES.BLOCKED_REUSE_RIGHTS);
  assert.equal(indiaPost.rights.publicDisplay, POST_TAX_SOURCE_RIGHTS_STATES.BLOCKED_REUSE_RIGHTS);
  assert.equal(indiaPost.productionPostTaxUseAllowed, false);
});

test('unverified providers and exact-endpoint mismatches fail closed', () => {
  assert.equal(isPostTaxSourceProductionAllowed(PROVIDERS.SBI), false);
  assert.equal(isPostTaxSourceProductionAllowed(PROVIDERS.RBI), false);
  const sbi = resolvePostTaxSourceRights({
    provider: PROVIDERS.SBI,
    url: 'https://sbi.bank.in/web/interest-rates/deposit-rates/retail-domestic-term-deposits',
  });
  assert.equal(sbi.status, POST_TAX_SOURCE_RIGHTS_STATES.BLOCKED_REUSE_RIGHTS);
  assert.equal(sbi.rights.publicDisplay, POST_TAX_SOURCE_RIGHTS_STATES.BLOCKED_REUSE_RIGHTS);
  assert.equal(sbi.rights.extraction, POST_TAX_SOURCE_RIGHTS_STATES.LICENSE_UNVERIFIED);
  const wrongAmfiPath = resolvePostTaxSourceRights({
    provider: PROVIDERS.AMFI,
    url: 'https://portal.amfiindia.com/not-the-qualified-nav-file.txt',
  });
  assert.equal(wrongAmfiPath.status, POST_TAX_SOURCE_RIGHTS_STATES.LICENSE_UNVERIFIED);
  assert.equal(wrongAmfiPath.productionPostTaxUseAllowed, false);
  const wrongRbiDocument = resolvePostTaxSourceRights({
    provider: PROVIDERS.RBI,
    url: 'https://www.rbi.org.in/scripts/NotificationUser.aspx?Id=99999',
  });
  assert.equal(wrongRbiDocument.sourceId, null);
  assert.equal(wrongRbiDocument.status, POST_TAX_SOURCE_RIGHTS_STATES.LICENSE_UNVERIFIED);
  assert.equal(isPostTaxSourceProductionAllowed('UNREGISTERED_PROVIDER'), false);
});

test('NSE MCP is separately classified for development research and never production', () => {
  const decision = resolvePostTaxSourceRights({
    provider: 'NSE_MCP',
    url: 'https://mcp.nseindia.in/bhavcopy/cm/mcp',
  });
  assert.equal(decision.status, POST_TAX_SOURCE_RIGHTS_STATES.DEVELOPMENT_RESEARCH_ONLY);
  assert.equal(decision.productionPostTaxUseAllowed, false);
  assert.equal(resolvePostTaxSourceRights({
    provider: 'NSE_MCP',
    url: 'https://mcp.nseindia.in/cmmkt/mcp',
  }).productionPostTaxUseAllowed, false);
});

test('a historical calculation requires rights for every source observation', () => {
  const rights = resolvePostTaxProductRights({
    parentInstrumentId: 'large_cap_mf',
    source: {
      provider: PROVIDERS.AMFI,
      url: 'https://portal.amfiindia.com/spages/NAVAll.txt',
    },
    historicalReturn: {
      valuePct: 0,
      source: {
        provider: PROVIDERS.AMFI,
        startObservationUrl: 'https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?frmdt=01-Jan-2025',
        endObservationUrl: 'https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?frmdt=01-Jan-2026',
      },
    },
  });
  assert.equal(rights.status, POST_TAX_SOURCE_RIGHTS_STATES.BLOCKED_REUSE_RIGHTS);
  assert.equal(rights.sources.length, 3);
  assert.equal(rights.productionPostTaxUseAllowed, false);
});

test('RBI post-tax rights include the India Post NSC coupon dependency', () => {
  const rights = resolvePostTaxProductRights({
    source: {
      provider: PROVIDERS.RBI,
      url: 'https://www.rbi.org.in/scripts/NotificationUser.aspx?Id=11924',
    },
    officialRate: {
      referenceRateFact: {
        source: {
          provider: PROVIDERS.GOVERNMENT_OF_INDIA,
          instrumentId: 'nsc',
          url: 'https://www.indiapost.gov.in/banking-services/savings',
        },
      },
    },
  });
  const indiaPost = rights.sources.find(source => source.provider === PROVIDERS.GOVERNMENT_OF_INDIA);
  assert.ok(indiaPost);
  assert.equal(indiaPost.status, POST_TAX_SOURCE_RIGHTS_STATES.BLOCKED_REUSE_RIGHTS);
  assert.equal(rights.productionPostTaxUseAllowed, false);
});

test('tax-classification evidence is included in the post-tax source-rights decision', () => {
  const classificationUrl = 'https://mf.nipponindiaim.com/InvestorServices/SIDETF/NipponIndia-ETF-Nifty-50-BeES.pdf';
  const rights = resolvePostTaxProductRights({
    source: { provider: PROVIDERS.AMFI, url: 'https://portal.amfiindia.com/spages/NAVAll.txt' },
    taxMetadata: {
      sourceReferences: [{ authority: 'Nippon India Mutual Fund', title: 'NiftyBeES SID', url: classificationUrl }],
      productEvidence: { provider: 'NIPPON_INDIA_MUTUAL_FUND', officialSourceUrl: classificationUrl },
    },
  });

  const classificationSources = rights.sources.filter(source => source.url === classificationUrl);
  assert.equal(classificationSources.length, 2);
  assert.deepEqual(classificationSources.map(source => source.provider).sort(), [
    'NIPPON_INDIA_MUTUAL_FUND',
    'Nippon India Mutual Fund',
  ]);
  assert.ok(classificationSources.every(source => source.productionPostTaxUseAllowed === false));
  assert.equal(rights.productionPostTaxUseAllowed, false);
});

test('production enrichment returns no numeric amount when source permission is unqualified', () => {
  const [product] = enrichProductsWithPostTaxAndSuitability([{
    id: 'sbi:fd:1',
    parentInstrumentId: 'sbi_fd',
    provider: PROVIDERS.SBI,
    name: 'SBI term deposit',
    source: {
      provider: PROVIDERS.SBI,
      url: 'https://sbi.bank.in/web/interest-rates/deposit-rates/retail-domestic-term-deposits',
    },
    officialRate: { value: 7 },
  }], {
    enforceSourceRights: true,
    taxCalculationContext: {
      annualGrossIncome: 1500000,
      incomeSource: 'salary',
      regime: 'new',
      fiscalYear: 'FY2025-26',
      userAge: 35,
      illustrativePrincipal: 10000,
    },
  });
  assert.equal(product.postTaxAnalysis.status, 'SOURCE_RIGHTS_UNQUALIFIED');
  assert.equal(product.postTaxAnalysis.grossGain, null);
  assert.equal(product.postTaxAnalysis.incrementalTax, null);
  assert.equal(product.postTaxAnalysis.netGain, null);
  assert.equal(product.postTaxAnalysis.postTaxRatePct, null);
  assert.equal(product.postTaxAnalysis.dataClass, 'UNAVAILABLE');
});

test('generated matrix covers the complete canonical catalog and matches its checked-in snapshot', () => {
  const matrix = buildPostTaxCoverageMatrix();
  const checkedIn = JSON.parse(readFileSync(matrixPath, 'utf8'));
  const catalogIds = investmentDatabase.map(instrument => instrument.id);
  const providerRows = getWhereToInvestProviderCoverageMatrix();
  assert.deepEqual(checkedIn, matrix);
  assert.equal(matrix.catalog.instrumentCount, 155);
  assert.equal(matrix.rows.length, investmentDatabase.length);
  assert.deepEqual(matrix.rows.map(row => row.canonicalInstrumentId), catalogIds);
  assert.equal(new Set(matrix.rows.map(row => row.canonicalInstrumentId)).size, catalogIds.length);
  assert.equal(providerRows.length, investmentDatabase.length);
  assert.equal(matrix.summary.qualifiedProviderPathCount, 45);
  assert.equal(matrix.summary.productionRightsQualifiedPathCount, 0);
  assert.equal(matrix.summary.productionSourceBlockedPathCount, 45);
  assert.equal(matrix.summary.sourceQualifiedParentTaxClassCount, 6);
  assert.equal(matrix.summary.exactProductOnlyTaxClassCount, 1);
  assert.equal(matrix.summary.userDeclaredScenarioImplementedParentCount, 5);
  assert.equal(matrix.summary.userDeclaredScenarioAccountFactsRequiredCount, 2);
  assert.equal(matrix.summary.userDeclaredScenarioUnavailableCount, 148);
  assert.equal(matrix.summary.liveVerifiedInstrumentCount, 0);
  assert.deepEqual(
    matrix.rows.filter(row => row.userDeclaredScenario.status === 'IMPLEMENTED')
      .map(row => row.canonicalInstrumentId).sort(),
    ['fd', 'nifty_etf', 'rbi_bonds', 'sbi_fd', 'sgb'],
  );
  const byId = new Map(matrix.rows.map(row => [row.canonicalInstrumentId, row]));
  assert.equal(byId.get('ppf').calculation.taxCalculationCapability, 'REQUIRES_QUALIFIED_ACCOUNT_FACTS');
  assert.equal(byId.get('sukanya').calculation.taxCalculationCapability, 'REQUIRES_QUALIFIED_ACCOUNT_FACTS');
  assert.equal(byId.get('sgb').calculation.taxCalculationCapability, 'TAX_CALCULATOR_NOT_IMPLEMENTED');
  assert.equal(byId.get('nifty_etf').calculation.taxCalculationCapability, 'IMPLEMENTED_REQUIRES_PRODUCT_FACTS_AND_TAX_INPUTS');
  assert.equal(byId.get('nifty_etf').userDeclaredScenario.canonicalProductId, 'etf:isin:INF204KB14I2');
  assert.equal(byId.get('ppf').userDeclaredScenario.status, 'REQUIRES_QUALIFIED_ACCOUNT_FACTS');
  assert.equal(byId.get('sukanya').userDeclaredScenario.status, 'REQUIRES_QUALIFIED_ACCOUNT_FACTS');
  for (const row of matrix.rows) {
    assert.ok(row.canonicalInstrumentId);
    assert.ok(row.category);
    assert.ok(row.productDiscovery.status);
    assert.ok(row.sourceRights.status);
    assert.ok(row.taxClassification.status);
    assert.ok(row.calculation.status);
    assert.ok(row.calculation.taxCalculationCapability);
    assert.equal(row.calculation.lastVerifiedTest,
      'server/test/postTaxSourceRights.test.js::generated matrix covers the complete canonical catalog and matches its checked-in snapshot');
    assert.ok(row.userDeclaredScenario.status);
    if (row.userDeclaredScenario.status === 'IMPLEMENTED') {
      assert.equal(row.calculation.numericProductionResultEligible, false);
      assert.equal(row.userDeclaredScenario.requiresProviderData, false);
    }
    assert.equal(row.calculation.liveVerificationStatus, 'NOT_RUN');
    assert.equal(row.calculation.observationDate, null);
    if (row.taxClassification.status === 'UNAVAILABLE') {
      assert.equal(row.calculation.numericProductionResultEligible, false);
    }
    if (!['IMPLEMENTED_REQUIRES_PRODUCT_FACTS_AND_TAX_INPUTS'].includes(row.calculation.taxCalculationCapability)) {
      assert.equal(row.calculation.numericProductionResultEligible, false);
    }
    if (row.productDiscovery.productOptionsAvailable) {
      assert.equal(row.sourceRights.productionUseAllowed, false);
      assert.equal(row.calculation.status, 'BLOCKED_SOURCE_RIGHTS');
    }
  }
});
