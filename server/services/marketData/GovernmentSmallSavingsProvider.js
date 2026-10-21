import MarketDataProvider from './MarketDataProvider.js';
import {
  AVAILABILITY,
  FACT_KINDS,
  FRESHNESS,
  MARKET_DATA_SCHEMA_VERSION,
  PROVIDERS,
  createMarketFact,
} from './contracts.js';
import { readThroughMarketCache } from './requestCache.js';
import {
  INDIA_POST_SAVINGS_URL,
  INDIA_POST_SCRIPT_CHUNK_RIGHTS_URL,
} from './marketDataSourceUrls.js';
import { buildMarketDataRightsUnavailableSnapshot, isMarketDataProductionUseAllowed } from './marketDataRights.js';

export { INDIA_POST_SAVINGS_URL, INDIA_POST_SCRIPT_CHUNK_RIGHTS_URL };
export const GOVERNMENT_SAVINGS_CACHE_KEY = `market:government:small-savings:${MARKET_DATA_SCHEMA_VERSION}:qualified-identities-2`;
export const GOVERNMENT_SAVINGS_CACHE_TTL_SECONDS = 12 * 60 * 60;
export const GOVERNMENT_RATE_DATA_CLASS = 'QUARTERLY_OFFICIAL_RATE';
const INDIA_TIME_ZONE = 'Asia/Kolkata';

function indiaCalendarParts(referenceDate) {
  const date = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid Indian government-rate cache date.');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: INDIA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}

export function governmentSavingsCacheKeyAt(referenceDate) {
  const { year, month } = indiaCalendarParts(referenceDate);
  const quarter = Math.ceil(Number(month) / 3);
  return `${GOVERNMENT_SAVINGS_CACHE_KEY}:${year}-Q${quarter}`;
}

const SCHEME_IDENTITIES = Object.freeze({
  'Post Office Savings Account': { id: 'post-office-savings', name: 'Post Office Savings Account' },
  '1 Year Time Deposit': { id: 'post-office-td-1y', name: 'Post Office 1-Year Time Deposit', tenureMonths: 12 },
  '2 Year Time Deposit': { id: 'post-office-td-2y', name: 'Post Office 2-Year Time Deposit', tenureMonths: 24 },
  '3 Year Time Deposit': { id: 'post-office-td-3y', name: 'Post Office 3-Year Time Deposit', tenureMonths: 36 },
  '5 Year Time Deposit': { id: 'post-office-td-5y', name: 'Post Office 5-Year Time Deposit', tenureMonths: 60 },
  '5 Year Recurring Deposit Scheme': { id: 'post-office-rd-5y', name: 'Post Office 5-Year Recurring Deposit', tenureMonths: 60 },
  'Senior Citizen Savings Scheme': { id: 'scss', name: 'Senior Citizens Savings Scheme' },
  'Monthly Income Account': { id: 'pomis', name: 'Post Office Monthly Income Scheme' },
  'National Savings Certificate (VIII Issue)': { id: 'nsc', name: 'National Savings Certificate (VIII Issue)', tenureMonths: 60 },
  'Public Provident Fund Scheme': { id: 'ppf', name: 'Public Provident Fund' },
  'Kisan Vikas Patra': { id: 'kvp', name: 'Kisan Vikas Patra' },
  'Sukanya Samriddhi Account Scheme': { id: 'sukanya', name: 'Sukanya Samriddhi Account' },
});
const COMPOUNDING_BASIS_LABELS = new Map([
  ['annually', 'Annually'],
  ['quarterly', 'Quarterly'],
  ['quarterly and paid', 'Quarterly and Paid'],
  ['monthly and paid', 'Monthly and paid'],
]);

function parseCompoundingBasis(value) {
  if (typeof value !== 'string') return null;
  return COMPOUNDING_BASIS_LABELS.get(value.trim().toLowerCase()) ?? null;
}

function parseIndianDate(value) {
  const match = String(value || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return null;
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso ? null : iso;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export function extractOfficialScriptUrls(html, pageUrl = INDIA_POST_SAVINGS_URL) {
  if (typeof html !== 'string' || !html.trim()) throw new Error('INDIA_POST_EMPTY_PAGE');
  const origin = new URL(pageUrl).origin;
  const urls = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
    .map(match => new URL(decodeHtml(match[1]), origin))
    .filter(url => url.origin === origin && url.pathname.startsWith('/_next/static/chunks/'))
    .map(url => url.toString());
  return [...new Set(urls)].slice(0, 20);
}

export function parseIndiaPostSavingsBundle(bundleText, {
  fetchedAt = new Date().toISOString(),
  now = new Date(),
  sourceUrl = INDIA_POST_SAVINGS_URL,
} = {}) {
  if (typeof bundleText !== 'string' || !bundleText.trim()) throw new Error('INDIA_POST_EMPTY_BUNDLE');
  const interval = bundleText.match(/Post Office Small Savings Schemes \(w\.e\.f\s+(\d{2}\.\d{2}\.\d{4})\s+to\s+(\d{2}\.\d{2}\.\d{4})\)/i);
  if (!interval) throw new Error('INDIA_POST_SCHEMA_MISMATCH:effective_interval');
  const effectiveFrom = parseIndianDate(interval[1]);
  const effectiveTo = parseIndianDate(interval[2]);
  if (!effectiveFrom || !effectiveTo || effectiveFrom > effectiveTo) {
    throw new Error('INDIA_POST_SCHEMA_MISMATCH:effective_interval');
  }

  const tableMatch = bundleText.match(/JSON\.parse\('(\[\{"slNo"[\s\S]*?\}\])'\)/);
  if (!tableMatch) throw new Error('INDIA_POST_SCHEMA_MISMATCH:rate_table');
  let rows;
  try {
    rows = JSON.parse(tableMatch[1]);
  } catch {
    throw new Error('INDIA_POST_SCHEMA_MISMATCH:rate_table_json');
  }
  if (!Array.isArray(rows)) throw new Error('INDIA_POST_SCHEMA_MISMATCH:rate_rows');

  const fetchedDate = new Date(fetchedAt);
  const intervalEnd = new Date(`${effectiveTo}T23:59:59.999+05:30`);
  const intervalStart = new Date(`${effectiveFrom}T00:00:00.000+05:30`);
  const nowDate = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(fetchedDate.getTime())
      || !Number.isFinite(nowDate.getTime())
      || fetchedDate > nowDate) {
    throw new Error('INDIA_POST_SCHEMA_MISMATCH:timestamps');
  }
  const freshnessStatus = nowDate >= intervalStart && nowDate <= intervalEnd
    ? FRESHNESS.FRESH
    : FRESHNESS.STALE;
  const products = [];
  const facts = [];

  for (const row of rows) {
    const identity = SCHEME_IDENTITIES[String(row?.instrument || '').trim()];
    if (!identity) continue;
    const rateMatch = String(row?.interestRate || '').trim().match(
      /^([+-]?\d+(?:\.\d+)?)\s*%(?:\s*\((?:Annual Interest|Quarterly Interest|Monthly Interest|Maturity Value|will mature in)\s+[^()%]+\))?$/i,
    );
    const parsedRate = rateMatch ? Number(rateMatch[1]) : null;
    const value = Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : null;
    // KVP doubling period must come from this effective-dated source row.
    const kvpTerm = identity.id === 'kvp'
      ? String(row.interestRate || '').match(/\bwill mature in\s+(\d{2,3})\s+months\b/i)
      : null;
    const parsedKvpMonths = kvpTerm ? Number(kvpTerm[1]) : null;
    const kvpMonths = Number.isInteger(parsedKvpMonths) && parsedKvpMonths >= 60 && parsedKvpMonths <= 240
      ? parsedKvpMonths : null;
    const canonicalProductId = `government:india-post:${identity.id}`;
    const fact = createMarketFact({
      kind: FACT_KINDS.SCHEME_INTEREST_RATE,
      canonicalProductId,
      sourceProvider: PROVIDERS.GOVERNMENT_OF_INDIA,
      sourceInstrumentId: identity.id,
      sourceUrl,
      value,
      unit: 'PERCENT_PER_ANNUM',
      observedAt: `${effectiveFrom}T00:00:00.000Z`,
      providerTimestamp: `${effectiveFrom}T00:00:00.000Z`,
      fetchedAt: fetchedDate.toISOString(),
      effectiveFrom,
      effectiveTo,
      dataClass: GOVERNMENT_RATE_DATA_CLASS,
      maxAgeSeconds: 0,
      now: nowDate,
    });
    fact.freshness = {
      status: freshnessStatus,
      ageSeconds: Math.max(0, Math.floor((nowDate - intervalStart) / 1000)),
      maxAgeSeconds: Math.floor((intervalEnd - intervalStart) / 1000),
    };
    fact.rateBasis = 'OFFICIAL_NOMINAL_RATE_PER_ANNUM';
    fact.compoundingBasis = parseCompoundingBasis(row.compoundingFrequency);
    products.push({
      schemaVersion: MARKET_DATA_SCHEMA_VERSION,
      canonicalProductId,
      productType: 'GOVERNMENT_SCHEME',
      name: identity.name,
      providerName: 'Department of Posts, Government of India',
      externalIds: [{ source: 'INDIA_POST_SCHEME_ID', value: identity.id }],
      source: { provider: PROVIDERS.GOVERNMENT_OF_INDIA, url: sourceUrl },
      sourceUpdatedAt: `${effectiveFrom}T00:00:00.000Z`,
      tenureMonths: identity.tenureMonths ?? kvpMonths ?? null,
      maturityEvidence: identity.id === 'kvp' && kvpMonths !== null ? 'INDIA_POST_RATE_ANNOTATION' : null,
    });
    facts.push(fact);
  }

  const expectedCanonicalIds = Object.values(SCHEME_IDENTITIES)
    .map(identity => `government:india-post:${identity.id}`)
    .sort();
  const productIds = products.map(product => product.canonicalProductId).sort();
  const factIds = facts.map(fact => fact.canonicalProductId).sort();
  const exactUniqueIdentitySet = productIds.length === expectedCanonicalIds.length
    && new Set(productIds).size === productIds.length
    && factIds.length === expectedCanonicalIds.length
    && new Set(factIds).size === factIds.length
    && productIds.every((id, index) => id === expectedCanonicalIds[index])
    && factIds.every((id, index) => id === expectedCanonicalIds[index]);
  if (!exactUniqueIdentitySet) {
    throw new Error('INDIA_POST_SCHEMA_MISMATCH:incomplete_rate_table');
  }
  const availableFactCount = facts.filter(fact => fact.availabilityStatus === AVAILABILITY.AVAILABLE).length;
  return {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    provider: PROVIDERS.GOVERNMENT_OF_INDIA,
    status: availableFactCount === facts.length ? AVAILABILITY.AVAILABLE : AVAILABILITY.PARTIAL,
    qualification: 'OFFICIAL_INDIA_POST_PUBLIC_RATE_TABLE_SCHEMA_VALIDATED',
    dataClass: GOVERNMENT_RATE_DATA_CLASS,
    effectiveFrom,
    effectiveTo,
    fetchedAt: fetchedDate.toISOString(),
    productCount: products.length,
    availableFactCount,
    products,
    facts,
  };
}

export default class GovernmentSmallSavingsProvider extends MarketDataProvider {
  constructor({ env = process.env, ...options } = {}) {
    super({ providerName: PROVIDERS.GOVERNMENT_OF_INDIA, env, ...options });
    this.env = env;
  }

  async getSnapshot({ forceRefresh = false } = {}) {
    const deniedEndpoint = [
      INDIA_POST_SAVINGS_URL,
      INDIA_POST_SCRIPT_CHUNK_RIGHTS_URL,
    ].find(url => !isMarketDataProductionUseAllowed(
      PROVIDERS.GOVERNMENT_OF_INDIA,
      url,
      this.env,
      this.marketDataTestFixtureRightsCapability,
    ));
    if (deniedEndpoint) {
      return {
        ...buildMarketDataRightsUnavailableSnapshot(PROVIDERS.GOVERNMENT_OF_INDIA, deniedEndpoint, {
          now: this.clock(),
          includeProducts: true,
        }),
        dataClass: GOVERNMENT_RATE_DATA_CLASS,
      };
    }

    return readThroughMarketCache({
      cacheKey: governmentSavingsCacheKeyAt(this.clock()),
      ttlSeconds: GOVERNMENT_SAVINGS_CACHE_TTL_SECONDS,
      forceRefresh,
      shouldCache: result => result?.status !== AVAILABILITY.SOURCE_ERROR
        && result?.error?.code !== 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED',
      loader: async () => {
        const fetchedAt = this.nowIso();
        try {
          const page = await this.httpClient.get(INDIA_POST_SAVINGS_URL, {
            timeout: 20_000,
            responseType: 'text',
            headers: { Accept: 'text/html' },
          });
          const scriptUrls = extractOfficialScriptUrls(page.data);
          if (scriptUrls.length === 0) throw new Error('INDIA_POST_SCHEMA_MISMATCH:scripts');
          for (const scriptUrl of scriptUrls) {
            if (!isMarketDataProductionUseAllowed(
              PROVIDERS.GOVERNMENT_OF_INDIA,
              scriptUrl,
              this.env,
              this.marketDataTestFixtureRightsCapability,
            )) {
              return buildMarketDataRightsUnavailableSnapshot(PROVIDERS.GOVERNMENT_OF_INDIA, scriptUrl, {
                now: this.clock(),
                includeProducts: true,
              });
            }
            const script = await this.httpClient.get(scriptUrl, {
              timeout: 20_000,
              responseType: 'text',
              headers: { Accept: 'application/javascript' },
            });
            if (!String(script.data).includes('Post Office Small Savings Schemes')) continue;
            return parseIndiaPostSavingsBundle(script.data, {
              fetchedAt,
              now: this.clock(),
              sourceUrl: INDIA_POST_SAVINGS_URL,
            });
          }
          throw new Error('INDIA_POST_SCHEMA_MISMATCH:rate_bundle_not_found');
        } catch (error) {
          return {
            schemaVersion: MARKET_DATA_SCHEMA_VERSION,
            provider: PROVIDERS.GOVERNMENT_OF_INDIA,
            status: AVAILABILITY.SOURCE_ERROR,
            dataClass: GOVERNMENT_RATE_DATA_CLASS,
            fetchedAt,
            productCount: 0,
            availableFactCount: 0,
            products: [],
            facts: [],
            error: { code: 'GOVERNMENT_SAVINGS_FETCH_FAILED', message: error?.message || 'Official India Post request failed.' },
          };
        }
      },
    });
  }
}
