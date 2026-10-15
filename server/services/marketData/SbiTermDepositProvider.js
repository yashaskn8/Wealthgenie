import MarketDataProvider from './MarketDataProvider.js';
import {
  AVAILABILITY,
  FACT_KINDS,
  MARKET_DATA_SCHEMA_VERSION,
  PROVIDERS,
  createMarketFact,
} from './contracts.js';
import { readThroughMarketCache } from './requestCache.js';
import { SBI_TERM_DEPOSIT_URL } from './marketDataSourceUrls.js';
import { buildMarketDataRightsUnavailableSnapshot, isMarketDataProductionUseAllowed } from './marketDataRights.js';

export { SBI_TERM_DEPOSIT_URL };
export const SBI_TERM_DEPOSIT_CACHE_KEY = `market:sbi:retail-term-deposits:${MARKET_DATA_SCHEMA_VERSION}:qualified-identities-2`;
export const SBI_TERM_DEPOSIT_CACHE_TTL_SECONDS = 12 * 60 * 60;
export const SBI_TERM_DEPOSIT_FRESHNESS_SECONDS = 180 * 24 * 60 * 60;
export const SBI_RATE_DATA_CLASS = 'OFFICIAL_BANK_PUBLISHED_RATE';

function stripHtml(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDmyDate(value) {
  const match = String(value || '').match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseLongDate(value) {
  const match = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(String(value || '').trim());
  if (!match) return null;
  const months = new Map([
    ['jan', 1], ['january', 1], ['feb', 2], ['february', 2], ['mar', 3], ['march', 3],
    ['apr', 4], ['april', 4], ['may', 5], ['jun', 6], ['june', 6], ['jul', 7], ['july', 7],
    ['aug', 8], ['august', 8], ['sep', 9], ['september', 9], ['oct', 10], ['october', 10],
    ['nov', 11], ['november', 11], ['dec', 12], ['december', 12],
  ]);
  const month = months.get(match[1].toLowerCase());
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!month || year < 1000 || day < 1 || day > 31) return null;
  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(year, month - 1, day);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function tableRows(html) {
  return [...String(html || '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(rowMatch => (
    [...rowMatch[1].matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)]
      .map(cellMatch => stripHtml(cellMatch[1]))
  )).filter(row => row.length > 0);
}

function normalizeDepositorHeader(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized.includes('senior citizen')) return 'SENIOR_CITIZEN';
  if (normalized.includes('public')) return 'GENERAL_PUBLIC';
  return null;
}

function tenureIdentity(label) {
  const normalized = String(label || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const definitions = [
    { pattern: /^7 days to 45 days$/, id: '7d-45d', minDays: 7, maxDaysExclusive: 46 },
    { pattern: /^46 days to 179 days$/, id: '46d-179d', minDays: 46, maxDaysExclusive: 180 },
    { pattern: /^180 days to 210 days$/, id: '180d-210d', minDays: 180, maxDaysExclusive: 211 },
    { pattern: /^211 days to less than 1 year$/, id: '211d-lt1y', minDays: 211, maxDaysExclusive: 365 },
    { pattern: /^1 year to less than 2 years$/, id: '1y-lt2y', minDays: 365, maxDaysExclusive: 730 },
    { pattern: /^2 years to less than 3 years$/, id: '2y-lt3y', minDays: 730, maxDaysExclusive: 1095 },
    { pattern: /^3 years to less than 5 years$/, id: '3y-lt5y', minDays: 1095, maxDaysExclusive: 1825 },
    { pattern: /^5 years and up to 10 years$/, id: '5y-10y', minDays: 1825, maxDaysExclusive: 3651 },
  ];
  return definitions.find(definition => definition.pattern.test(normalized)) || null;
}

export function parseSbiRetailTermDepositPage(html, {
  fetchedAt = new Date().toISOString(),
  now = new Date(),
  sourceUrl = SBI_TERM_DEPOSIT_URL,
} = {}) {
  if (typeof html !== 'string' || !html.trim()) throw new Error('SBI_FD_EMPTY_RESPONSE');
  const rows = tableRows(html);
  const headerIndex = rows.findIndex(row => row.some(cell => /^tenors$/i.test(cell))
    && row.some(cell => /revised rates for public/i.test(cell))
    && row.some(cell => /revised rates for senior citizen/i.test(cell)));
  if (headerIndex < 0) throw new Error('SBI_FD_SCHEMA_MISMATCH:rate_header');
  const header = rows[headerIndex];
  const rateColumns = header.map((cell, index) => ({
    index,
    depositorType: normalizeDepositorHeader(cell),
    effectiveFrom: parseDmyDate(cell),
    isRevised: /revised rates/i.test(cell),
  })).filter(column => column.depositorType && column.effectiveFrom && column.isRevised);
  if (rateColumns.length !== 2) throw new Error('SBI_FD_SCHEMA_MISMATCH:revised_columns');
  const effectiveReference = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now instanceof Date ? now : new Date(now));
  if (rateColumns.some(column => column.effectiveFrom > effectiveReference)) {
    throw new Error('SBI_FD_SCHEMA_MISMATCH:future_effective_rates');
  }

  const plainText = stripHtml(html);
  const numericUpdatedMatch = plainText.match(
    /Last Updated On\s*:\s*(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s*)?(\d{1,2}[/-]\d{1,2}[/-]\d{4})/i,
  );
  const longUpdatedMatch = plainText.match(
    /Last Updated On\s*:\s*(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s*)?([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i,
  );
  const publicationDate = numericUpdatedMatch
    ? parseDmyDate(numericUpdatedMatch[1])
    : parseLongDate(longUpdatedMatch?.[1]);
  if (!publicationDate) throw new Error('SBI_FD_SCHEMA_MISMATCH:last_updated');

  const products = [];
  const facts = [];
  for (const row of rows.slice(headerIndex + 1)) {
    const tenure = tenureIdentity(row[0]);
    if (!tenure) continue;
    for (const column of rateColumns) {
      const valueText = row[column.index];
      if (!/^\s*\d+(?:\.\d+)?\s*\*?\s*$/.test(String(valueText || ''))) continue;
      const value = Number(String(valueText).replace('*', '').trim());
      const depositorSlug = column.depositorType === 'SENIOR_CITIZEN' ? 'senior' : 'public';
      const canonicalProductId = `deposit:sbi:retail-domestic:${tenure.id}:${depositorSlug}`;
      const fact = createMarketFact({
        kind: FACT_KINDS.TERM_DEPOSIT_RATE,
        canonicalProductId,
        sourceProvider: PROVIDERS.SBI,
        sourceInstrumentId: `retail-domestic:${tenure.id}:${depositorSlug}`,
        sourceUrl,
        value,
        unit: 'PERCENT_PER_ANNUM',
        observedAt: `${publicationDate}T00:00:00.000Z`,
        providerTimestamp: `${publicationDate}T00:00:00.000Z`,
        fetchedAt,
        effectiveFrom: column.effectiveFrom,
        effectiveTo: null,
        publicationDate,
        dataClass: SBI_RATE_DATA_CLASS,
        maxAgeSeconds: SBI_TERM_DEPOSIT_FRESHNESS_SECONDS,
        now,
      });
      fact.rateBasis = 'OFFICIAL_NOMINAL_CARD_RATE_PER_ANNUM';
      products.push({
        schemaVersion: MARKET_DATA_SCHEMA_VERSION,
        canonicalProductId,
        productType: 'BANK_TERM_DEPOSIT',
        name: `SBI Retail Domestic Term Deposit — ${row[0]}`,
        providerName: 'State Bank of India',
        externalIds: [{ source: 'SBI_TENURE_CLASS', value: tenure.id }],
        source: { provider: PROVIDERS.SBI, url: sourceUrl },
        sourceUpdatedAt: `${publicationDate}T00:00:00.000Z`,
        tenureLabel: row[0],
        tenureMinDays: tenure.minDays,
        tenureMaxDaysExclusive: tenure.maxDaysExclusive,
        depositorType: column.depositorType,
        depositType: 'RETAIL_DOMESTIC_TERM_DEPOSIT_BELOW_INR_3_CRORE',
        callability: 'CALLABLE_STANDARD_CARD_RATE',
        riskQuality: null,
      });
      facts.push(fact);
    }
  }
  const canonicalIds = products.map(product => product.canonicalProductId);
  const factIds = facts.map(fact => fact.canonicalProductId);
  const exactUniqueIdentitySet = canonicalIds.length === 16
    && new Set(canonicalIds).size === 16
    && factIds.length === 16
    && new Set(factIds).size === 16
    && factIds.every(id => canonicalIds.includes(id));
  if (!exactUniqueIdentitySet) throw new Error('SBI_FD_SCHEMA_MISMATCH:tenure_rows');
  const availableFactCount = facts.filter(fact => fact.availabilityStatus === AVAILABILITY.AVAILABLE).length;
  return {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    provider: PROVIDERS.SBI,
    status: availableFactCount === facts.length ? AVAILABILITY.AVAILABLE : AVAILABILITY.PARTIAL,
    qualification: 'OFFICIAL_SBI_RETAIL_TERM_DEPOSIT_TABLE_SCHEMA_VALIDATED',
    dataClass: SBI_RATE_DATA_CLASS,
    publicationDate,
    fetchedAt,
    productCount: products.length,
    availableFactCount,
    products,
    facts,
  };
}

export default class SbiTermDepositProvider extends MarketDataProvider {
  constructor(options = {}) {
    super({ providerName: PROVIDERS.SBI, ...options });
  }

  async getSnapshot({ forceRefresh = false } = {}) {
    if (!isMarketDataProductionUseAllowed(
      PROVIDERS.SBI,
      SBI_TERM_DEPOSIT_URL,
      this.env,
      this.marketDataTestFixtureRightsCapability,
    )) {
      return {
        ...buildMarketDataRightsUnavailableSnapshot(PROVIDERS.SBI, SBI_TERM_DEPOSIT_URL, {
          now: this.clock(),
          includeProducts: true,
        }),
        dataClass: SBI_RATE_DATA_CLASS,
      };
    }
    return readThroughMarketCache({
      cacheKey: SBI_TERM_DEPOSIT_CACHE_KEY,
      ttlSeconds: SBI_TERM_DEPOSIT_CACHE_TTL_SECONDS,
      forceRefresh,
      loader: async () => {
        const fetchedAt = this.nowIso();
        try {
          const response = await this.httpClient.get(SBI_TERM_DEPOSIT_URL, {
            timeout: 20_000,
            responseType: 'text',
            headers: { Accept: 'text/html' },
          });
          return parseSbiRetailTermDepositPage(response.data, {
            fetchedAt,
            now: this.clock(),
          });
        } catch (error) {
          return {
            schemaVersion: MARKET_DATA_SCHEMA_VERSION,
            provider: PROVIDERS.SBI,
            status: AVAILABILITY.SOURCE_ERROR,
            dataClass: SBI_RATE_DATA_CLASS,
            fetchedAt,
            productCount: 0,
            availableFactCount: 0,
            products: [],
            facts: [],
            error: { code: 'SBI_FD_FETCH_FAILED', message: error?.message || 'Official SBI request failed.' },
          };
        }
      },
    });
  }
}
