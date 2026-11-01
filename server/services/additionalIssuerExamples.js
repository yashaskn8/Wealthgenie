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
  'Bandhan Mutual Fund': ['bandhanmutual.com'],
  'Axis Bank': ['www.axis.bank.in'],
  'Kotak Mahindra Bank': ['www.kotak.bank.in'],
  'HDFC Bank': ['www.hdfc.bank.in'],
  'Invesco India Mutual Fund': ['www.invescomutualfund.com'],
  'Mirae Asset Mutual Fund': ['www.miraeassetmf.co.in'],
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
  catalog_2026_index_nifty500_momentum: {
    benchmark: 'Nifty500 Momentum 50 TRI', instrument: 'INDEX_FUND',
    pattern: /nifty.?500.?momentum.?50.?index.?fund/i,
  },
  catalog_2026_bank_tax_saver_fd: {
    benchmark: 'FIVE_YEAR_BANK_TAX_SAVER_FD', instrument: 'BANK_DEPOSIT',
    pattern: /(?:tax.?saver|tax.?saving).?fixed.?deposit/i,
  },
  catalog_2026_index_nifty200_quality: {
    benchmark: 'Nifty200 Quality 30 TRI', instrument: 'INDEX_FUND',
    pattern: /nifty.?200.?quality.?30.?index.?fund/i,
  },
  catalog_2026_index_india_defence: {
    benchmark: 'Nifty India Defence TRI', instrument: 'INDEX_FUND',
    pattern: /nifty.?india.?defence.?index.?fund/i,
  },
  catalog_2026_etf_smallcap250: {
    benchmark: 'Nifty Smallcap 250 TRI', instrument: 'ETF',
    pattern: /nifty.?smallcap.?250.?etf/i,
  },
  catalog_2026_gilt_10y_constant: {
    benchmark: '10_YEAR_CONSTANT_MATURITY_GILT', instrument: 'DEBT_MUTUAL_FUND',
    pattern: /(?:constant.?maturity.?10.?year|10.?year.?constant.?maturity).*gilt.?fund/i,
  },
  catalog_2026_medium_long_duration_mf: {
    benchmark: 'MEDIUM_TO_LONG_DURATION_4_TO_7_YEARS', instrument: 'DEBT_MUTUAL_FUND',
    pattern: /medium.?to.?long.?(?:duration|term).?fund/i,
  },
  catalog_2026_long_duration_mf: {
    benchmark: 'LONG_DURATION_ABOVE_7_YEARS', instrument: 'DEBT_MUTUAL_FUND',
    pattern: /(?:long.?duration.?fund|nivesh.?lakshya.?long.?term.?fund|long.?term.?fund)/i,
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
