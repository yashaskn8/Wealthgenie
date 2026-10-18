import crypto from 'node:crypto';
import MarketDataProvider from './MarketDataProvider.js';
import {
  AVAILABILITY,
  FRESHNESS,
  MARKET_DATA_SCHEMA_VERSION,
  PROVIDERS,
  evaluateFreshness,
  normalizeTimestamp,
  nullableFiniteNumber,
} from './contracts.js';
import { buildUpstoxInstrumentIdentity } from './productIdentity.js';
import { readThroughMarketCache } from './requestCache.js';
import { isoDateInIndia } from './indiaMarketTime.js';
import { classifyUpstoxError, safeUpstoxError } from './upstoxErrors.js';
import { resolveUpstoxAccessToken } from './upstoxCredentials.js';
import { getUpstoxWithRetry } from './upstoxRequestPolicy.js';
import {
  evaluateMarketDataProductionRights,
  isMarketDataProductionUseAllowed,
} from './marketDataRights.js';
import {
  UPSTOX_HISTORICAL_CANDLE_V3_URL,
  UPSTOX_HISTORICAL_CANDLE_V3_RIGHTS_URL,
} from './marketDataSourceUrls.js';

export { UPSTOX_HISTORICAL_CANDLE_V3_URL, UPSTOX_HISTORICAL_CANDLE_V3_RIGHTS_URL };
export const UPSTOX_HISTORY_CACHE_TTL_SECONDS = 6 * 60 * 60;
export const UPSTOX_HISTORY_CACHE_QUALIFIER = 'unique-timestamps-2';
export const UPSTOX_DAILY_HISTORY_FRESHNESS_SECONDS = 4 * 24 * 60 * 60;
export const NIFTY_50_INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';

function requireIsoDate(value, fieldName) {
  const text = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new TypeError(`${fieldName} must use YYYY-MM-DD format.`);
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const calendarDate = new Date(0);
  calendarDate.setUTCHours(0, 0, 0, 0);
  calendarDate.setUTCFullYear(year, month - 1, day);
  if (month < 1 || month > 12 || day < 1
      || calendarDate.getUTCFullYear() !== year
      || calendarDate.getUTCMonth() !== month - 1
      || calendarDate.getUTCDate() !== day) {
    throw new TypeError(`${fieldName} must use YYYY-MM-DD format.`);
  }
  return text;
}

function finitePositive(value) {
  const parsed = nullableFiniteNumber(value);
  return parsed !== null && parsed > 0 && parsed <= Number.MAX_SAFE_INTEGER ? parsed : null;
}

function sourceUrlFor(instrumentKey, toDate, fromDate) {
  return `${UPSTOX_HISTORICAL_CANDLE_V3_URL}/${encodeURIComponent(instrumentKey)}/days/1/${toDate}/${fromDate}`;
}

function cacheKeyFor(instrumentKey, toDate, fromDate) {
  const digest = crypto.createHash('sha256')
    .update(`${instrumentKey}\n${fromDate}\n${toDate}`)
    .digest('hex');
  return `market:upstox:daily-candles:${MARKET_DATA_SCHEMA_VERSION}:${UPSTOX_HISTORY_CACHE_QUALIFIER}:${digest}`;
}

/**
 * Parse the documented Upstox V3 candle tuple:
 * [timestamp, open, high, low, close, volume, openInterest].
 */
export function parseUpstoxDailyCandles(payload, {
  instrumentKey,
  fetchedAt,
  now = new Date(),
  sourceUrl,
} = {}) {
  buildUpstoxInstrumentIdentity(instrumentKey);
  const normalizedFetchedAt = normalizeTimestamp(fetchedAt);
  if (!normalizedFetchedAt) throw new TypeError('fetchedAt must be a valid timestamp.');
  const rows = payload?.data?.candles;
  if (!Array.isArray(rows)) throw new Error('UPSTOX_HISTORY_SCHEMA_MISMATCH:candles');

  const byTimestamp = new Map();
  const seenByTimestamp = new Map();
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const timestamp = normalizeTimestamp(row[0]);
    if (!timestamp) continue;
    const candle = {
      timestamp,
      open: finitePositive(row[1]),
      high: finitePositive(row[2]),
      low: finitePositive(row[3]),
      close: finitePositive(row[4]),
      volume: nullableFiniteNumber(row[5]),
      openInterest: nullableFiniteNumber(row[6]),
    };
    const previous = seenByTimestamp.get(timestamp);
    if (previous) {
      const sameCandle = ['open', 'high', 'low', 'close', 'volume', 'openInterest']
        .every(field => previous[field] === candle[field]);
      if (!sameCandle) throw new Error('UPSTOX_HISTORY_CONFLICTING_DUPLICATE_CANDLE');
      continue;
    }
    seenByTimestamp.set(timestamp, candle);

    const { open, high, low, close } = candle;
    if (row.length < 5 || open === null || high === null || low === null || close === null
        || high < low || high < open || high < close || low > open || low > close) continue;
    byTimestamp.set(timestamp, candle);
  }

  const candles = [...byTimestamp.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  if (candles.length === 0) throw new Error('UPSTOX_HISTORY_NO_VALID_CANDLES');
  const observedAt = candles.at(-1).timestamp;
  return {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    provider: PROVIDERS.UPSTOX,
    status: AVAILABILITY.AVAILABLE,
    instrumentKey,
    interval: '1 day',
    fetchedAt: normalizedFetchedAt,
    observedAt,
    providerTimestamp: observedAt,
    effectiveTradingDate: isoDateInIndia(observedAt),
    dataClass: 'DAILY',
    freshness: evaluateFreshness({
      observedAt,
      fetchedAt: normalizedFetchedAt,
      maxAgeSeconds: UPSTOX_DAILY_HISTORY_FRESHNESS_SECONDS,
      now,
    }),
    candleCount: candles.length,
    candles,
    source: {
      provider: PROVIDERS.UPSTOX,
      instrumentId: instrumentKey,
      url: sourceUrl,
    },
  };
}

export default class UpstoxHistoricalCandleProvider extends MarketDataProvider {
  constructor({
    accessToken = undefined,
    env = process.env,
    requestCache = readThroughMarketCache,
    ...options
  } = {}) {
    super({ providerName: PROVIDERS.UPSTOX, env, ...options });
    this.accessToken = String(accessToken ?? resolveUpstoxAccessToken(env)).trim();
    this.env = env;
    this.requestCache = requestCache;
  }

  isConfigured() {
    return this.accessToken.length > 0;
  }

  async getDailyCandles(instrumentKey, { fromDate, toDate, forceRefresh = false } = {}) {
    buildUpstoxInstrumentIdentity(instrumentKey);
    const normalizedFromDate = requireIsoDate(fromDate, 'fromDate');
    const normalizedToDate = requireIsoDate(toDate, 'toDate');
    if (normalizedFromDate > normalizedToDate) throw new RangeError('fromDate must not be after toDate.');
    const fetchedAt = this.nowIso();
    if (!isMarketDataProductionUseAllowed(
      PROVIDERS.UPSTOX,
      UPSTOX_HISTORICAL_CANDLE_V3_RIGHTS_URL,
      this.env,
      this.marketDataTestFixtureRightsCapability,
    )) {
      const rights = evaluateMarketDataProductionRights(PROVIDERS.UPSTOX, UPSTOX_HISTORICAL_CANDLE_V3_RIGHTS_URL);
      return {
        schemaVersion: MARKET_DATA_SCHEMA_VERSION,
        provider: PROVIDERS.UPSTOX,
        status: AVAILABILITY.UNAVAILABLE,
        instrumentKey,
        fetchedAt,
        observedAt: null,
        freshness: { status: FRESHNESS.UNKNOWN, ageSeconds: null, maxAgeSeconds: UPSTOX_DAILY_HISTORY_FRESHNESS_SECONDS },
        candleCount: null,
        candles: [],
        source: { provider: PROVIDERS.UPSTOX, instrumentId: instrumentKey, url: UPSTOX_HISTORICAL_CANDLE_V3_RIGHTS_URL },
        error: { code: 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED' },
        reasonCodes: ['MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED'],
        sourceRights: { status: rights.status, sourceId: rights.sourceId, productionUseAllowed: false },
        cache: { hit: false, backend: 'NONE', status: 'NOT_READ_SOURCE_RIGHTS_BLOCKED' },
      };
    }
    if (!this.isConfigured()) {
      return {
        schemaVersion: MARKET_DATA_SCHEMA_VERSION,
        provider: PROVIDERS.UPSTOX,
        status: AVAILABILITY.PROVIDER_NOT_CONFIGURED,
        instrumentKey,
        fetchedAt,
        observedAt: null,
        freshness: { status: FRESHNESS.UNKNOWN, ageSeconds: null, maxAgeSeconds: UPSTOX_DAILY_HISTORY_FRESHNESS_SECONDS },
        candleCount: 0,
        candles: [],
        source: { provider: PROVIDERS.UPSTOX, instrumentId: instrumentKey, url: null },
        error: {
          code: 'PROVIDER_NOT_CONFIGURED',
          message: 'Set UPSTOX_ANALYTICS_TOKEN or UPSTOX_ACCESS_TOKEN on the server to enable Upstox history.',
        },
        cache: { hit: false, backend: 'NONE' },
      };
    }

    const sourceUrl = sourceUrlFor(instrumentKey, normalizedToDate, normalizedFromDate);
    return this.requestCache({
      cacheKey: cacheKeyFor(instrumentKey, normalizedToDate, normalizedFromDate),
      ttlSeconds: UPSTOX_HISTORY_CACHE_TTL_SECONDS,
      forceRefresh,
      loader: async () => {
        const requestFetchedAt = this.nowIso();
        try {
          const response = await getUpstoxWithRetry(this.httpClient, sourceUrl, {
            timeout: 15_000,
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${this.accessToken}`,
            },
          });
          return parseUpstoxDailyCandles(response.data, {
            instrumentKey,
            fetchedAt: requestFetchedAt,
            now: this.clock(),
            sourceUrl,
          });
        } catch (error) {
          return {
            schemaVersion: MARKET_DATA_SCHEMA_VERSION,
            provider: PROVIDERS.UPSTOX,
            status: AVAILABILITY.SOURCE_ERROR,
            instrumentKey,
            fetchedAt: requestFetchedAt,
            observedAt: null,
            freshness: { status: FRESHNESS.UNKNOWN, ageSeconds: null, maxAgeSeconds: UPSTOX_DAILY_HISTORY_FRESHNESS_SECONDS },
            candleCount: 0,
            candles: [],
            source: { provider: PROVIDERS.UPSTOX, instrumentId: instrumentKey, url: sourceUrl },
            error: safeUpstoxError(classifyUpstoxError(error)),
          };
        }
      },
    });
  }
}
