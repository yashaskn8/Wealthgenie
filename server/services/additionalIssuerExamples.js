/** First-party issuer links for public research; never an advice/product feed. */
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(
  new URL('../data/qualificationPilots/issuerAdditionalExamples2026-11-01.json', import.meta.url),
  'utf8',
));
const HOSTS = Object.freeze({
  'Motilal Oswal Mutual Fund': ['www.motilaloswalmf.com'],
  'Axis Mutual Fund': ['www.axismf.com'],
  'SBI Mutual Fund': ['www.sbimf.com'],
  'HDFC Mutual Fund': ['www.hdfcfund.com'],
  'UTI Mutual Fund': ['www.utimf.com'],
  'ICICI Prudential Mutual Fund': ['www.icicipruamc.com', 'digitalfactsheet.icicipruamc.com'],
  'Nippon India Mutual Fund': ['mf.nipponindiaim.com'],
  'Kotak Mutual Fund': ['www.kotakmf.com'],
  'Sundaram Mutual Fund': ['www.sundarammutual.com'],
  'DSP Mutual Fund': ['www.dspim.com'],
});
const EXPECTED = Object.freeze({
  catalog_2026_index_nifty500: {
    benchmark: 'Nifty 500 TRI', instrument: 'INDEX_FUND',
    pattern: /nifty.?500.?index.?fund/i,
  },
  catalog_2026_index_nifty50_equal: {
    benchmark: 'Nifty50 Equal Weight TRI', instrument: 'INDEX_FUND',
    pattern: /nifty.?50.?equal.?weight.?index.?fund/i,
  },
  catalog_2026_etf_nifty100: {
    benchmark: 'Nifty 100 TRI', instrument: 'ETF',
    pattern: /(?:nifty.?100.?etf|etf.?nifty.?100)/i,
  },
  catalog_2026_index_nifty100_equal: {
    benchmark: 'Nifty100 Equal Weight TRI', instrument: 'INDEX_FUND',
    pattern: /nifty.?100.?equal.?weight.?(?:index.?)?fund/i,
  },
  catalog_2026_etf_nifty50_equal: {
    benchmark: 'Nifty50 Equal Weight TRI', instrument: 'ETF',
    pattern: /nifty.?50.?equal.?weight.?etf/i,
  },
});
const invalid = code => { throw new Error('FINANCIAL_ISSUER_EXAMPLES_' + code); };
export function listAdditionalIssuerExamples(source = manifest) {
  if (source?.schemaVersion !== 'public-issuer-examples-v1'
    || source.reviewDate !== '2026-11-01'
    || source.status !== 'PUBLIC_ISSUER_RESEARCH_ONLY'
    || source.noPersonalizedRecommendation !== true
    || source.noMarketPriceOrReturnFacts !== true
    || source.sourcePermissionIndependentApproval !== false
    || !Array.isArray(source.families)
    || source.families.length !== Object.keys(EXPECTED).length) invalid('HEADER');
  const byFamily = new Map();
  for (const family of source.families) {
    const expected = EXPECTED[family?.familyId];
    if (!expected || byFamily.has(family.familyId)
      || family.benchmark !== expected.benchmark
      || family.instrument !== expected.instrument
      || !Array.isArray(family.products)
      || family.products.length !== 3) invalid('FAMILY_OR_BENCHMARK');
    const issuers = new Set(), names = new Set();
    const products = family.products.map(product => {
      if (!product || typeof product !== 'object'
        || Object.keys(product).sort().join(',') !== 'issuer,issuerUrl,name'
        || typeof product.name !== 'string'
        || !expected.pattern.test(product.name)
        || product.name.length < 12 || product.name.length > 140
        || typeof product.issuer !== 'string'
        || !Object.hasOwn(HOSTS, product.issuer)
        || issuers.has(product.issuer) || names.has(product.name.toLowerCase())) {
        invalid('INSTRUMENT_IDENTITY');
      }
      let url;
      try { url = new URL(product.issuerUrl); }
      catch { invalid('SOURCE_URL'); }
      if (url.protocol !== 'https:' || !HOSTS[product.issuer].includes(url.hostname)
        || url.username || url.password || url.hash) invalid('SOURCE_HOST');
      issuers.add(product.issuer);
      names.add(product.name.toLowerCase());
      return {
        name: product.name, issuer: product.issuer, issuerUrl: url.href,
        researchedOn: source.reviewDate,
        displayScope: 'PUBLIC_ISSUER_RESEARCH_ONLY',
      };
    });
    byFamily.set(family.familyId, products);
  }
  return byFamily;
}
