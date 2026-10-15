import MarketDataProvider from './MarketDataProvider.js';
import {
  AVAILABILITY,
  FACT_KINDS,
  MARKET_DATA_SCHEMA_VERSION,
  PROVIDERS,
  createMarketFact,
  nullableFiniteNumber,
} from './contracts.js';
import {
  isAmfiCategoryLine,
  normalizeAmfiHeader,
  parseAmfiDate,
} from './AmfiNavProvider.js';
import { buildAmfiProductIdentity } from './productIdentity.js';
import { readThroughMarketCache } from './requestCache.js';

export const AMFI_NAV_HISTORY_URL = 'https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx';
export const AMFI_HISTORY_CACHE_TTL_SECONDS = 24 * 60 * 60;
export const AMFI_HISTORY_WINDOW_RADIUS_DAYS = 3;

const MONTH_NAMES = Object.freeze([
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]);

function requireDate(value, fieldName) {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${fieldName} must be a valid date.`);
  parsed.setUTCHours(0, 0, 0, 0);
  return parsed;
}

function shiftUtcDays(date, days) {
  const shifted = new Date(date.getTime());
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted;
}

export function formatAmfiQueryDate(value) {
  const date = requireDate(value, 'AMFI query date');
  return `${String(date.getUTCDate()).padStart(2, '0')}-${MONTH_NAMES[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

export function buildAmfiHistoryWindow(targetDate) {
  const target = requireDate(targetDate, 'targetDate');
  const fromDate = shiftUtcDays(target, -AMFI_HISTORY_WINDOW_RADIUS_DAYS);
  const toDate = shiftUtcDays(target, AMFI_HISTORY_WINDOW_RADIUS_DAYS);
  return {
    targetDate: target.toISOString().slice(0, 10),
    fromDate: fromDate.toISOString().slice(0, 10),
    toDate: toDate.toISOString().slice(0, 10),
    fromParam: formatAmfiQueryDate(fromDate),
    toParam: formatAmfiQueryDate(toDate),
  };
}

export function isQualifiedAmfiNavHistoryUrl(sourceUrl, targetDate) {
  if (typeof targetDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) return false;
  const target = new Date(`${targetDate}T00:00:00.000Z`);
  if (!Number.isFinite(target.getTime()) || target.toISOString().slice(0, 10) !== targetDate) return false;
  const window = buildAmfiHistoryWindow(targetDate);
  return sourceUrl === `${AMFI_NAV_HISTORY_URL}?frmdt=${window.fromParam}&todt=${window.toParam}`;
}

function findColumn(headers, aliases, required = true) {
  const index = headers.findIndex(header => aliases.includes(header));
  if (index === -1 && required) throw new Error(`AMFI_HISTORY_SCHEMA_MISMATCH:${aliases[0]}`);
  return index;
}

function distanceFromTarget(observedAt, targetDate) {
  return Math.abs(Date.parse(observedAt) - Date.parse(targetDate));
}

function sameObservation(left, right) {
  const factFields = [
    'canonicalProductId', 'sourceInstrumentId', 'sourceProvider', 'observedAt',
    'observedDate', 'value', 'currency', 'unit',
  ];
  const contextFields = ['targetDate', 'schemeName', 'providerName', 'schemeCategory', 'plan', 'option'];
  return factFields.every(field => left[field] === right[field])
    && contextFields.every(field => left.historicalContext?.[field] === right.historicalContext?.[field]);
}

/**
 * Parse the official AMFI date-range report and retain one observation per
 * scheme: the reported NAV closest to the requested historical target date.
 * Columns are discovered by header name because AMFI has published more than
 * one report shape. Plan and Option remain null when the report omits them.
 */
export function parseAmfiNavHistoryReport(text, {
  targetDate,
  fetchedAt = new Date().toISOString(),
  now = new Date(),
  sourceUrl = AMFI_NAV_HISTORY_URL,
} = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('AMFI_HISTORY_EMPTY_RESPONSE');
  const target = requireDate(targetDate, 'targetDate');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const headerIndex = lines.findIndex(line => {
    const headers = line.split(';').map(normalizeAmfiHeader);
    return headers.includes('scheme code')
      && headers.includes('net asset value')
      && headers.includes('date')
      && (headers.includes('nav name') || headers.includes('scheme name'));
  });
  if (headerIndex === -1) throw new Error('AMFI_HISTORY_SCHEMA_MISMATCH:header');

  const headers = lines[headerIndex].split(';').map(normalizeAmfiHeader);
  const columns = {
    schemeCode: findColumn(headers, ['scheme code']),
    schemeName: findColumn(headers, ['nav name', 'scheme name']),
    plan: findColumn(headers, ['plan'], false),
    option: findColumn(headers, ['option'], false),
    primaryIsin: findColumn(headers, ['isin div payout/isin growth', 'isin div payout/ isin growth'], false),
    secondaryIsin: findColumn(headers, ['isin div reinvestment'], false),
    nav: findColumn(headers, ['net asset value']),
    date: findColumn(headers, ['date']),
  };

  let currentCategory = null;
  let currentAmc = null;
  const closestByProduct = new Map();

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
    const nav = nullableFiniteNumber(parts[columns.nav]);
    const { observedDate, observedAt } = parseAmfiDate(parts[columns.date]);
    if (!/^\d+$/.test(schemeCode || '') || !schemeName || nav === null || nav <= 0 || !observedAt) continue;

    const primaryIsin = columns.primaryIsin >= 0 ? parts[columns.primaryIsin] : null;
    const secondaryIsin = columns.secondaryIsin >= 0 ? parts[columns.secondaryIsin] : null;
    const identity = buildAmfiProductIdentity({ schemeCode, primaryIsin, secondaryIsin });
    const fact = {
      ...createMarketFact({
        kind: FACT_KINDS.MUTUAL_FUND_NAV,
        canonicalProductId: identity.canonicalProductId,
        sourceProvider: PROVIDERS.AMFI,
        sourceInstrumentId: schemeCode,
        sourceUrl,
        value: nav,
        currency: 'INR',
        unit: 'NAV_PER_UNIT',
        observedAt,
        fetchedAt,
        maxAgeSeconds: 4 * 24 * 60 * 60,
        now,
      }),
      observedDate,
      historicalContext: {
        targetDate: target.toISOString().slice(0, 10),
        schemeName,
        providerName: currentAmc,
        schemeCategory: currentCategory,
        plan: columns.plan >= 0 ? parts[columns.plan] || null : null,
        option: columns.option >= 0 ? parts[columns.option] || null : null,
      },
    };
    const existing = closestByProduct.get(identity.canonicalProductId);
    const candidateDistance = distanceFromTarget(observedAt, target);
    const existingDistance = existing ? distanceFromTarget(existing.observedAt, target) : Infinity;
    if (existing && existing.observedAt === fact.observedAt) {
      if (!sameObservation(existing, fact)) {
        throw Object.assign(new Error('AMFI historical NAV report contains conflicting observations.'), {
          code: 'AMFI_HISTORY_CONFLICTING_OBSERVATION',
        });
      }
      continue;
    }
    if (!existing || candidateDistance < existingDistance
        || (candidateDistance === existingDistance && observedAt > existing.observedAt)) {
      closestByProduct.set(identity.canonicalProductId, fact);
    }
  }

  const facts = [...closestByProduct.values()];
  if (facts.length === 0) throw new Error('AMFI_HISTORY_NO_PRODUCT_ROWS');
  return {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    provider: PROVIDERS.AMFI,
    status: AVAILABILITY.AVAILABLE,
    fetchedAt,
    targetDate: target.toISOString().slice(0, 10),
    productCount: facts.length,
    availableFactCount: facts.length,
    products: [],
    facts,
  };
}

export default class AmfiNavHistoryProvider extends MarketDataProvider {
  constructor(options = {}) {
    super({ providerName: PROVIDERS.AMFI, ...options });
  }

  async getSnapshot({ targetDate, forceRefresh = false } = {}) {
    const window = buildAmfiHistoryWindow(targetDate);
    const sourceUrl = `${AMFI_NAV_HISTORY_URL}?frmdt=${window.fromParam}&todt=${window.toParam}`;
    const cacheKey = `market:amfi:nav-history:${MARKET_DATA_SCHEMA_VERSION}:${window.targetDate}`;
    return readThroughMarketCache({
      cacheKey,
      ttlSeconds: AMFI_HISTORY_CACHE_TTL_SECONDS,
      forceRefresh,
      loader: async () => {
        const fetchedAt = this.nowIso();
        try {
          const response = await this.httpClient.get(AMFI_NAV_HISTORY_URL, {
            timeout: 60_000,
            responseType: 'text',
            params: { frmdt: window.fromParam, todt: window.toParam },
            headers: { Accept: 'text/plain' },
          });
          return parseAmfiNavHistoryReport(response.data, {
            targetDate: window.targetDate,
            fetchedAt,
            now: this.clock(),
            sourceUrl,
          });
        } catch (error) {
          const conflictingObservation = error?.code === 'AMFI_HISTORY_CONFLICTING_OBSERVATION';
          return {
            schemaVersion: MARKET_DATA_SCHEMA_VERSION,
            provider: PROVIDERS.AMFI,
            status: AVAILABILITY.SOURCE_ERROR,
            fetchedAt,
            targetDate: window.targetDate,
            productCount: 0,
            availableFactCount: 0,
            products: [],
            facts: [],
            error: {
              code: conflictingObservation ? error.code : 'AMFI_HISTORY_FETCH_FAILED',
              message: conflictingObservation
                ? 'AMFI historical NAV report contains conflicting observations.'
                : error?.message || 'AMFI historical NAV request failed.',
            },
          };
        }
      },
    });
  }
}
