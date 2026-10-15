import MarketDataProvider from './MarketDataProvider.js';
import {
  AVAILABILITY,
  FACT_KINDS,
  MARKET_DATA_SCHEMA_VERSION,
  PROVIDERS,
  createMarketFact,
  evaluateFreshness,
  nullableFiniteNumber,
} from './contracts.js';
import { buildAmfiProductIdentity } from './productIdentity.js';
import { readThroughMarketCache } from './requestCache.js';
import { AMFI_NAV_URL } from './marketDataSourceUrls.js';
import { buildMarketDataRightsUnavailableSnapshot, isMarketDataProductionUseAllowed } from './marketDataRights.js';

export { AMFI_NAV_URL };
export const AMFI_CACHE_KEY = `market:amfi:nav:${MARKET_DATA_SCHEMA_VERSION}`;
export const AMFI_CACHE_TTL_SECONDS = 24 * 60 * 60;
export const AMFI_FRESHNESS_SECONDS = 4 * 24 * 60 * 60;

function refreshFactFreshness(snapshot, now) {
  for (const fact of snapshot?.facts || []) {
    fact.freshness = evaluateFreshness({
      observedAt: fact.observedAt,
      fetchedAt: fact.fetchedAt,
      maxAgeSeconds: fact.freshness?.maxAgeSeconds,
      now,
    });
  }
  return snapshot;
}

const MONTHS = Object.freeze({
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
});

export function normalizeAmfiHeader(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function parseAmfiDate(value) {
  const match = String(value || '').trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!match) return { observedDate: null, observedAt: null };
  const month = MONTHS[match[2].toLowerCase()];
  if (month === undefined) return { observedDate: null, observedAt: null };
  const day = Number(match[1]);
  const year = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month || parsed.getUTCDate() !== day) {
    return { observedDate: null, observedAt: null };
  }
  return {
    observedDate: `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    observedAt: parsed.toISOString(),
  };
}

function findColumn(headers, aliases, required = true) {
  const index = headers.findIndex(header => aliases.includes(header));
  if (index === -1 && required) throw new Error(`AMFI_SCHEMA_MISMATCH:${aliases[0]}`);
  return index;
}

export function isAmfiCategoryLine(line) {
  return /^(open ended schemes|close ended schemes|interval fund schemes)/i.test(line);
}

export function parseAmfiNavReport(text, { fetchedAt = new Date().toISOString(), now = new Date() } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('AMFI_EMPTY_RESPONSE');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const headerIndex = lines.findIndex(line => {
    const headers = line.split(';').map(normalizeAmfiHeader);
    return headers.includes('scheme code') && headers.includes('net asset value') && headers.includes('date');
  });
  if (headerIndex === -1) throw new Error('AMFI_SCHEMA_MISMATCH:header');

  const headers = lines[headerIndex].split(';').map(normalizeAmfiHeader);
  const columns = {
    schemeCode: findColumn(headers, ['scheme code']),
    primaryIsin: findColumn(headers, ['isin div payout/ isin growth', 'isin div payout/isin growth'], false),
    secondaryIsin: findColumn(headers, ['isin div reinvestment'], false),
    schemeName: findColumn(headers, ['scheme name']),
    // NAVAll deployments/formats do not consistently expose separate Plan and
    // Option columns. Missing columns remain null and are not classifications.
    plan: findColumn(headers, ['plan'], false),
    option: findColumn(headers, ['option'], false),
    nav: findColumn(headers, ['net asset value']),
    date: findColumn(headers, ['date']),
  };

  let currentCategory = null;
  let currentAmc = null;
  const products = [];
  const facts = [];

  for (const rawLine of lines.slice(headerIndex + 1)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!line.includes(';')) {
      if (isAmfiCategoryLine(line)) currentCategory = line;
      else currentAmc = line;
      continue;
    }

    const parts = line.split(';').map(part => part.trim());
    const schemeCode = parts[columns.schemeCode];
    const schemeName = parts[columns.schemeName];
    if (!/^\d+$/.test(schemeCode || '') || !schemeName) continue;

    const primaryIsin = columns.primaryIsin >= 0 ? parts[columns.primaryIsin] : null;
    const secondaryIsin = columns.secondaryIsin >= 0 ? parts[columns.secondaryIsin] : null;
    const identity = buildAmfiProductIdentity({ schemeCode, primaryIsin, secondaryIsin });
    const nav = nullableFiniteNumber(parts[columns.nav]);
    const { observedDate, observedAt } = parseAmfiDate(parts[columns.date]);
    const fact = createMarketFact({
      kind: FACT_KINDS.MUTUAL_FUND_NAV,
      canonicalProductId: identity.canonicalProductId,
      sourceProvider: PROVIDERS.AMFI,
      sourceInstrumentId: schemeCode,
      sourceUrl: AMFI_NAV_URL,
      value: nav !== null && nav > 0 ? nav : null,
      currency: 'INR',
      unit: 'NAV_PER_UNIT',
      observedAt,
      fetchedAt,
      maxAgeSeconds: AMFI_FRESHNESS_SECONDS,
      now,
    });

    products.push({
      schemaVersion: MARKET_DATA_SCHEMA_VERSION,
      canonicalProductId: identity.canonicalProductId,
      productType: 'MUTUAL_FUND',
      name: schemeName,
      providerName: currentAmc,
      schemeCategory: currentCategory,
      plan: columns.plan >= 0 ? parts[columns.plan] || null : null,
      option: columns.option >= 0 ? parts[columns.option] || null : null,
      externalIds: identity.externalIds,
      source: { provider: PROVIDERS.AMFI, url: AMFI_NAV_URL },
      sourceUpdatedAt: observedAt,
    });
    facts.push({ ...fact, observedDate });
  }

  if (products.length === 0) throw new Error('AMFI_NO_PRODUCT_ROWS');
  const availableFactCount = facts.filter(fact => fact.availabilityStatus === AVAILABILITY.AVAILABLE).length;
  return {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    provider: PROVIDERS.AMFI,
    status: availableFactCount === facts.length ? AVAILABILITY.AVAILABLE : AVAILABILITY.PARTIAL,
    fetchedAt,
    productCount: products.length,
    availableFactCount,
    products,
    facts,
  };
}

export default class AmfiNavProvider extends MarketDataProvider {
  constructor(options = {}) {
    super({ providerName: PROVIDERS.AMFI, ...options });
  }

  async getSnapshot({ forceRefresh = false } = {}) {
    if (!isMarketDataProductionUseAllowed(
      PROVIDERS.AMFI,
      AMFI_NAV_URL,
      this.env,
      this.marketDataTestFixtureRightsCapability,
    )) {
      return buildMarketDataRightsUnavailableSnapshot(PROVIDERS.AMFI, AMFI_NAV_URL, {
        now: this.clock(),
        includeProducts: true,
      });
    }
    const snapshot = await readThroughMarketCache({
      cacheKey: AMFI_CACHE_KEY,
      ttlSeconds: AMFI_CACHE_TTL_SECONDS,
      forceRefresh,
      loader: async () => {
        const fetchedAt = this.nowIso();
        try {
          const response = await this.httpClient.get(AMFI_NAV_URL, {
            timeout: 20_000,
            responseType: 'text',
            headers: { Accept: 'text/plain' },
          });
          return parseAmfiNavReport(response.data, { fetchedAt, now: this.clock() });
        } catch (error) {
          return {
            schemaVersion: MARKET_DATA_SCHEMA_VERSION,
            provider: PROVIDERS.AMFI,
            status: AVAILABILITY.SOURCE_ERROR,
            fetchedAt,
            productCount: 0,
            availableFactCount: 0,
            products: [],
            facts: [],
            error: { code: 'AMFI_FETCH_FAILED', message: error?.message || 'AMFI request failed.' },
          };
        }
      },
    });
    // The provider cache is intentionally longer-lived than AMFI's freshness
    // boundary. Recompute age at consumption time, retaining the same snapshot
    // object so concurrent consumers still share one persistence operation.
    return refreshFactFreshness(snapshot, this.clock());
  }
}
