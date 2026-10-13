import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.resolve(scriptDirectory, '..');
const catalogPath = path.join(serverDirectory, 'data', 'investment_master.json');
const outputPath = path.join(serverDirectory, 'data', 'market_data_coverage.json');

const OFFICIAL_RATE_FACTS = Object.freeze({
  ppf: {
    dataClass: 'PUBLISHED_RATE',
    canonicalSourceId: 'government:india-post:ppf',
    provider: 'Government of India / India Post',
    service: 'GovernmentSmallSavingsProvider',
    freshnessSemantics: 'Official effective interval; quarterly publication cycle.',
  },
  scss: {
    dataClass: 'PUBLISHED_RATE',
    canonicalSourceId: 'government:india-post:scss',
    provider: 'Government of India / India Post',
    service: 'GovernmentSmallSavingsProvider',
    freshnessSemantics: 'Official effective interval; quarterly publication cycle.',
  },
  sukanya: {
    dataClass: 'PUBLISHED_RATE',
    canonicalSourceId: 'government:india-post:sukanya',
    provider: 'Government of India / India Post',
    service: 'GovernmentSmallSavingsProvider',
    freshnessSemantics: 'Official effective interval; quarterly publication cycle.',
  },
  nsc: {
    dataClass: 'PUBLISHED_RATE',
    canonicalSourceId: 'government:india-post:nsc',
    provider: 'Government of India / India Post',
    service: 'GovernmentSmallSavingsProvider',
    freshnessSemantics: 'Official effective interval; quarterly publication cycle.',
  },
  kvp: {
    dataClass: 'PUBLISHED_RATE',
    canonicalSourceId: 'government:india-post:kvp',
    provider: 'Government of India / India Post',
    service: 'GovernmentSmallSavingsProvider',
    freshnessSemantics: 'Official effective interval; quarterly publication cycle.',
  },
  pomis: {
    dataClass: 'PUBLISHED_RATE',
    canonicalSourceId: 'government:india-post:pomis',
    provider: 'Government of India / India Post',
    service: 'GovernmentSmallSavingsProvider',
    freshnessSemantics: 'Official effective interval; quarterly publication cycle.',
  },
  po_rd: {
    dataClass: 'PUBLISHED_RATE',
    canonicalSourceId: 'government:india-post:post-office-rd-5y',
    provider: 'Government of India / India Post',
    service: 'GovernmentSmallSavingsProvider',
    freshnessSemantics: 'Official effective interval; five-year Post Office RD only.',
  },
  po_td_1yr: {
    dataClass: 'PUBLISHED_RATE',
    canonicalSourceId: 'government:india-post:post-office-td-1y',
    provider: 'Government of India / India Post',
    service: 'GovernmentSmallSavingsProvider',
    freshnessSemantics: 'Official effective interval; one-year Post Office TD only.',
  },
  sbi_fd: {
    dataClass: 'PUBLISHED_RATE',
    canonicalSourceId: null,
    provider: 'State Bank of India',
    service: 'SbiTermDepositProvider',
    freshnessSemantics: 'SBI retail domestic card-rate publication date; requires tenure and depositor category.',
  },
  rbi_bonds: {
    dataClass: 'AUCTION_OR_BOND_TERMS',
    canonicalSourceId: 'government:rbi:frsb-2020-taxable',
    provider: 'Reserve Bank of India / Government of India',
    service: 'RbiFloatingRateSavingsBondProvider',
    freshnessSemantics: 'Current reset-period coupon and official bond terms; not a fixed lifetime rate.',
  },
});

const SOURCE_UNAVAILABLE_IDS = new Set([
  'sgb', 'mssc', 'apy', 'fd', 'hdfc_fd', 'icici_fd', 'axis_fd', 'kotak_fd', 'indusind_fd',
  'idfc_fd', 'au_sfb_fd', 'ujjivan_fd', 'equitas_fd', 'canara_fd', 'pnb_fd', 'bob_fd',
  'sgb_secondary', 'embassy_reit', 'mindspace_reit', 'brookfield_reit', 'nexus_reit',
  'indigrid_invit', 'powergrid_invit', 'aaa_corporate_bond', 'aa_corporate_bond',
  'tax_free_bonds', 'bharat_bond_direct', 'municipal_bonds', 'bonds_54ec', 'nps',
  'nps_tier_2', 'epf', 'vpf', 'ulip', 'endowment_plan', 'term_mf_combo',
  'parag_parikh_flexi', 'sbi_bluechip', 'hdfc_midcap', 'mirae_elss', 'bajaj_finance_fd',
  'shriram_finance_fd', 'lic_housing_fd', 'pnb_housing_fd', 'mahindra_finance_fd',
  'jana_sfb_fd', 'suryoday_sfb_fd', 'esaf_sfb_fd', 'utkarsh_sfb_fd', 'rbi_retail_direct_gilt',
  'digital_gold', 'motilal_nasdaq100_fof', 'motilal_sp500_index', 'motilal_nasdaq_q50_etf',
  'icici_us_bluechip_fund', 'franklin_us_opportunities', 'edelweiss_us_tech_fof',
  'kotak_nasdaq100_fof', 'mirae_nyse_fang_etf_fof', 'edelweiss_greater_china_fof',
  'dsp_us_flexible_equity',
]);

const UNSUPPORTED_IDS = new Set([
  'p2p_lending', 'smallcase_thematic', 'pre_ipo_unlisted_shares', 'commodity_futures',
  'futures_and_options', 'crypto_vda', 'direct_us_stocks_megacap', 'us_sp500_etf_lrs',
  'us_nasdaq100_etf_lrs', 'us_dividend_etf_lrs', 'us_global_total_world_etf_lrs',
]);

function buildEntry(instrument) {
  const source = OFFICIAL_RATE_FACTS[instrument.id];
  const dataClass = source?.dataClass
    || (UNSUPPORTED_IDS.has(instrument.id) ? 'UNSUPPORTED'
      : SOURCE_UNAVAILABLE_IDS.has(instrument.id) ? 'SOURCE_UNAVAILABLE'
        : 'EDUCATIONAL_ONLY');
  const hasBoundSourceIdentity = Boolean(source?.canonicalSourceId);
  return {
    catalogId: instrument.id,
    name: instrument.name,
    category: instrument.category,
    assetClass: instrument.assetClass,
    dataClass,
    catalogSupport: 'PRESENT',
    productIdentityAvailability: hasBoundSourceIdentity
      ? 'SOURCE_QUALIFIED'
      : source ? 'PARENT_PRODUCT_NEEDS_TENURE_AND_DEPOSITOR' : 'NO_QUALIFIED_PRODUCT_BINDING',
    providerQualification: source ? 'QUALIFIED_BACKEND_PROVIDER' : 'NO_PRODUCT_BOUND_SOURCE',
    sourceProvider: source?.provider ?? null,
    sourceService: source?.service ?? null,
    canonicalSourceId: source?.canonicalSourceId ?? null,
    sourceSemantics: source?.freshnessSemantics
      ?? (dataClass === 'EDUCATIONAL_ONLY'
        ? 'Catalog entry is a parent/category description and has no individual market observation.'
        : 'No qualified product-level provider fact is currently bound to this catalog identity.'),
    productRiskEvidence: 'NOT_QUALIFIED_BY_MARKET_DATA_COVERAGE',
    productLiquidityEvidence: 'NOT_QUALIFIED_BY_MARKET_DATA_COVERAGE',
    taxClassification: 'AUTHORITATIVE_SERVER_TAX_POLICY_REQUIRED',
    investmentEligibility: 'EXISTING_SERVER_SUITABILITY_GATE_REMAINS_AUTHORITY',
    sourceFreshness: source ? 'PROVIDER_EFFECTIVE_OR_PUBLICATION_TIME' : 'NOT_AVAILABLE',
    marketDataAvailability: source ? 'SOURCE_SERVICE_EXISTS' : 'NO_PRODUCT_LEVEL_OBSERVATION',
    upstoxRegistryCoverage: false,
    tejHqIdentityCoverage: false,
    personalizedRecommendationEligibility: 'NOT_ESTABLISHED_BY_MARKET_DATA_COVERAGE',
  };
}

export function buildMarketDataCoverage(catalog) {
  if (!Array.isArray(catalog?.instruments)) throw new TypeError('Catalog must include an instruments array.');
  const ids = catalog.instruments.map(instrument => instrument.id);
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
    throw new Error('Catalog instrument IDs must be present and unique.');
  }
  const entries = catalog.instruments.map(buildEntry);
  return {
    schemaVersion: 'wealthgenie-market-data-coverage-1.0.0',
    catalogVersion: catalog.catalogVersion ?? null,
    generatedAt: new Date().toISOString(),
    totalCatalogEntries: entries.length,
    classificationCounts: Object.fromEntries([...new Set(entries.map(entry => entry.dataClass))].sort()
      .map(dataClass => [dataClass, entries.filter(entry => entry.dataClass === dataClass).length])),
    scope: 'Product-level market-data source coverage only; this matrix does not determine suitability, eligibility, tax or recommendation ranking.',
    entries,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const coverage = buildMarketDataCoverage(catalog);
  fs.writeFileSync(outputPath, `${JSON.stringify(coverage, null, 2)}\n`, 'utf8');
  process.stdout.write(`Wrote ${coverage.totalCatalogEntries} market-data coverage rows.\n`);
}
