import crypto from 'node:crypto';
import MarketDataProvider from './MarketDataProvider.js';
import {
  AVAILABILITY,
  FRESHNESS,
  MARKET_DATA_SCHEMA_VERSION,
  PROVIDERS,
  normalizeTimestamp,
  nullableFiniteNumber,
} from './contracts.js';
import { MARKET_BENCHMARKS, benchmarkByCanonicalId } from './marketBenchmarks.js';
import { isoDateInIndia } from './indiaMarketTime.js';
import { getNseJson, safeNseHttpError } from './nseHttp.js';
import {
  isUsableNseTradingCalendar,
  NSE_DAILY_HISTORY_MAX_AGE_SECONDS,
  evaluateNseDailyHistoryFreshness,
  fetchNseTradingHolidays,
  NSE_TRADING_HOLIDAY_URL,
  parseNseDate,
} from './nseTradingCalendar.js';
import { readThroughMarketCache } from './requestCache.js';
import { buildMarketDataRightsUnavailableSnapshot, isMarketDataProductionUseAllowed } from './marketDataRights.js';
import {
  buildNseHistoricalIndexRequestUrl,
  NSE_HISTORICAL_INDEX_RIGHTS_URL,
  NSE_HISTORICAL_INDEX_URL,
} from './marketDataSourceUrls.js';

export { NSE_HISTORICAL_INDEX_URL, NSE_HISTORICAL_INDEX_RIGHTS_URL };
export const NSE_HISTORY_CACHE_TTL_SECONDS = 6 * 60 * 60;
export const NSE_HISTORY_DATA_CLASS = 'DAILY';
export const NSE_HISTORY_MAX_WINDOW_DAYS = 90;

function requireIsoDate(value, fieldName) {
  const text = String(value || '').trim();
  const date = new Date(`${text}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(date.getTime())
      || date.toISOString().slice(0, 10) !== text) {
    throw new TypeError(`${fieldName} must use YYYY-MM-DD format.`);
  }
  return text;
}

function shiftDate(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatNseQueryDate(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${day}-${month}-${year}`;
}

export function buildNseHistoryWindows(fromDate, toDate, maxDays = NSE_HISTORY_MAX_WINDOW_DAYS) {
  const from = requireIsoDate(fromDate, 'fromDate');
  const to = requireIsoDate(toDate, 'toDate');
  if (from > to) throw new RangeError('fromDate must not be after toDate.');
  if (!Number.isInteger(maxDays) || maxDays < 1 || maxDays > 365) throw new RangeError('maxDays must be 1-365.');
  const windows = [];
  let start = from;
  while (start <= to) {
    const candidateEnd = shiftDate(start, maxDays - 1);
    const end = candidateEnd < to ? candidateEnd : to;
    windows.push({ fromDate: start, toDate: end });
    start = shiftDate(end, 1);
  }
  return windows;
}

function positiveNumber(value) {
  const number = nullableFiniteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function normalizedHistoryRow(row, index, benchmark) {
  if (row?.EOD_INDEX_NAME !== benchmark.nseIndexName) {
    throw new Error(`NSE_HISTORY_SCHEMA_MISMATCH:data[${index}].EOD_INDEX_NAME`);
  }
  const effectiveTradingDate = parseNseDate(row.EOD_TIMESTAMP);
  const timestamp = normalizeTimestamp(row.HI_TIMESTAMP);
  const open = positiveNumber(row.EOD_OPEN_INDEX_VAL);
  const high = positiveNumber(row.EOD_HIGH_INDEX_VAL);
  const low = positiveNumber(row.EOD_LOW_INDEX_VAL);
  const close = positiveNumber(row.EOD_CLOSE_INDEX_VAL);
  if (!effectiveTradingDate || !timestamp || isoDateInIndia(timestamp) !== effectiveTradingDate
      || open === null || high === null || low === null || close === null
      || high < low || high < open || high < close || low > open || low > close) {
    throw new Error(`NSE_HISTORY_INVALID_ROW:data[${index}]`);
  }
  return {
    timestamp,
    effectiveTradingDate,
    open,
    high,
    low,
    close,
    volume: nullableFiniteNumber(row.HIT_TRADED_QTY),
    openInterest: null,
  };
}

export function parseNseHistoricalData(payload, {
  fetchedAt,
  fromDate,
  toDate,
  canonicalProductId = MARKET_BENCHMARKS.NIFTY_50.canonicalProductId,
  now = new Date(),
  holidayDates = [],
  sourceUrl = NSE_HISTORICAL_INDEX_URL,
  requestUrls = [],
} = {}) {
  const normalizedFromDate = requireIsoDate(fromDate, 'fromDate');
  const normalizedToDate = requireIsoDate(toDate, 'toDate');
  const normalizedFetchedAt = normalizeTimestamp(fetchedAt);
  const benchmark = benchmarkByCanonicalId(canonicalProductId);
  if (!benchmark) throw new TypeError(`Unsupported canonical benchmark: ${canonicalProductId}`);
  if (!normalizedFetchedAt) throw new TypeError('fetchedAt must be a valid timestamp.');
  if (!payload || !Array.isArray(payload.data)) throw new Error('NSE_HISTORY_SCHEMA_MISMATCH:data');
  const byDate = new Map();
  let duplicateRowCount = 0;
  for (const [index, row] of payload.data.entries()) {
    const candle = normalizedHistoryRow(row, index, benchmark);
    if (candle.effectiveTradingDate < normalizedFromDate || candle.effectiveTradingDate > normalizedToDate) {
      throw new Error(`NSE_HISTORY_OUT_OF_RANGE:data[${index}]`);
    }
    const existing = byDate.get(candle.effectiveTradingDate);
    if (existing) {
      const comparable = key => existing[key] === candle[key];
      if (!['open', 'high', 'low', 'close', 'timestamp'].every(comparable)) {
        throw new Error(`NSE_HISTORY_CONFLICTING_DUPLICATE:${candle.effectiveTradingDate}`);
      }
      duplicateRowCount += 1;
      continue;
    }
    byDate.set(candle.effectiveTradingDate, candle);
  }
  const candles = [...byDate.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  if (candles.length === 0) throw new Error('NSE_HISTORY_NO_VALID_CANDLES');
  const latest = candles.at(-1);
  return {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    provider: PROVIDERS.NSE,
    status: AVAILABILITY.AVAILABLE,
    qualification: 'OFFICIAL_NSE_WEBSITE_ENDPOINT_UNDOCUMENTED_SCHEMA_VALIDATED',
    dataClass: NSE_HISTORY_DATA_CLASS,
    instrumentKey: benchmark.canonicalProductId,
    interval: '1 day',
    fetchedAt: normalizedFetchedAt,
    observedAt: latest.timestamp,
    providerTimestamp: latest.timestamp,
    effectiveTradingDate: latest.effectiveTradingDate,
    freshness: evaluateNseDailyHistoryFreshness({
      effectiveTradingDate: latest.effectiveTradingDate,
      requestedToDate: normalizedToDate,
      observedAt: latest.timestamp,
      fetchedAt: normalizedFetchedAt,
      now,
      holidayDates,
    }),
    candleCount: candles.length,
    duplicateRowCount,
    candles,
    source: {
      provider: PROVIDERS.NSE,
      instrumentId: benchmark.nseIndexName,
      url: sourceUrl,
      ...(requestUrls.length > 0 ? { requestUrls: [...requestUrls] } : {}),
    },
  };
}

function cacheKeyFor(canonicalProductId, fromDate, toDate) {
  const digest = crypto.createHash('sha256')
    .update(`${canonicalProductId}\n${fromDate}\n${toDate}`)
    .digest('hex');
  return `market:nse:daily-index-history:${MARKET_DATA_SCHEMA_VERSION}:${digest}`;
}

async function fetchHistoryWindows(httpClient, windows, benchmark) {
  const responses = [];
  const concurrency = 4;
  const requestUrls = windows.map(window => buildNseHistoricalIndexRequestUrl({
    indexType: benchmark.nseIndexName,
    from: formatNseQueryDate(window.fromDate),
    to: formatNseQueryDate(window.toDate),
  }));
  for (let offset = 0; offset < windows.length; offset += concurrency) {
    const batch = windows.slice(offset, offset + concurrency);
    const batchResponses = await Promise.all(batch.map((_window, index) => getNseJson(
      httpClient,
      requestUrls[offset + index],
      {
        referer: 'https://www.nseindia.com/reports-indices-historical-index-data',
        timeout: 15_000,
      },
    )));
    responses.push(...batchResponses);
  }
  return { responses, requestUrls };
}

export default class NseHistoricalDataProvider extends MarketDataProvider {
  constructor({ holidayLoader, ...options } = {}) {
    super({ providerName: PROVIDERS.NSE, ...options });
    this.holidayLoader = holidayLoader || ((loaderOptions = {}) => fetchNseTradingHolidays({
      httpClient: this.httpClient,
      clock: this.clock,
      env: this.env,
      fixtureCapability: this.marketDataTestFixtureRightsCapability,
      ...loaderOptions,
    }));
  }

  async getDailyCandles(canonicalProductId, { fromDate, toDate, forceRefresh = false } = {}) {
    const benchmark = benchmarkByCanonicalId(canonicalProductId);
    if (!benchmark) {
      throw new TypeError('NSE history requires a supported canonical benchmark.');
    }
    const normalizedFromDate = requireIsoDate(fromDate, 'fromDate');
    const normalizedToDate = requireIsoDate(toDate, 'toDate');
    if (normalizedFromDate > normalizedToDate) throw new RangeError('fromDate must not be after toDate.');
    const windows = buildNseHistoryWindows(normalizedFromDate, normalizedToDate);
    const requestUrls = windows.map(window => buildNseHistoricalIndexRequestUrl({
      indexType: benchmark.nseIndexName,
      from: formatNseQueryDate(window.fromDate),
      to: formatNseQueryDate(window.toDate),
    }));
    const deniedUrl = [...requestUrls, NSE_TRADING_HOLIDAY_URL]
      .find(url => !isMarketDataProductionUseAllowed(
        PROVIDERS.NSE,
        url,
        this.env,
        this.marketDataTestFixtureRightsCapability,
      ));
    if (deniedUrl) {
      return {
        ...buildMarketDataRightsUnavailableSnapshot(PROVIDERS.NSE, deniedUrl, {
          now: this.clock(),
          includeCandles: true,
        }),
        canonicalProductId: benchmark.canonicalProductId,
        requestedFromDate: normalizedFromDate,
        requestedToDate: normalizedToDate,
        candleCount: null,
      };
    }
    const snapshot = await readThroughMarketCache({
      cacheKey: cacheKeyFor(benchmark.canonicalProductId, normalizedFromDate, normalizedToDate),
      ttlSeconds: NSE_HISTORY_CACHE_TTL_SECONDS,
      forceRefresh,
      loader: async () => {
        const fetchedAt = this.nowIso();
        try {
          const [historyResult, calendarResult] = await Promise.allSettled([
            fetchHistoryWindows(this.httpClient, windows, benchmark),
            this.holidayLoader({ forceRefresh: false }),
          ]);
          if (historyResult.status !== 'fulfilled') throw historyResult.reason;
          const holidaySnapshot = calendarResult.status === 'fulfilled' ? calendarResult.value : null;
          const calendarAvailable = isUsableNseTradingCalendar(holidaySnapshot, this.clock());
          const rows = [];
          historyResult.value.responses.forEach((response, index) => {
            if (!response?.data || !Array.isArray(response.data.data)) {
              throw new Error(`NSE_HISTORY_SCHEMA_MISMATCH:window[${index}].data`);
            }
            rows.push(...response.data.data);
          });
          const snapshot = parseNseHistoricalData({ data: rows }, {
            fetchedAt,
            fromDate: normalizedFromDate,
            toDate: normalizedToDate,
            canonicalProductId: benchmark.canonicalProductId,
            now: this.clock(),
            holidayDates: calendarAvailable ? holidaySnapshot.dates : [],
            requestUrls: historyResult.value.requestUrls,
          });
          if (!calendarAvailable) {
            return {
              ...snapshot,
              freshness: {
                status: FRESHNESS.UNKNOWN,
                ageSeconds: null,
                maxAgeSeconds: NSE_DAILY_HISTORY_MAX_AGE_SECONDS,
              },
              calendar: {
                status: 'UNAVAILABLE',
                source: holidaySnapshot?.source ?? null,
                fetchedAt: holidaySnapshot?.fetchedAt ?? null,
                error: calendarResult.status === 'rejected'
                  ? { code: 'NSE_HOLIDAY_FETCH_FAILED', message: 'NSE trading calendar request failed.' }
                  : holidaySnapshot?.status === AVAILABILITY.AVAILABLE
                    ? { code: 'NSE_HOLIDAY_CALENDAR_UNQUALIFIED', message: 'NSE trading calendar provenance, freshness, or current-year coverage is not verified.' }
                    : holidaySnapshot?.error ?? { code: 'NSE_HOLIDAY_FETCH_FAILED', message: 'NSE trading calendar was unavailable.' },
              },
              reasonCodes: ['NSE_TRADING_CALENDAR_UNAVAILABLE'],
            };
          }
          return {
            ...snapshot,
            calendar: {
              schemaVersion: MARKET_DATA_SCHEMA_VERSION,
              provider: PROVIDERS.NSE,
              status: 'AVAILABLE',
              dates: holidaySnapshot.dates,
              source: holidaySnapshot.source,
              fetchedAt: holidaySnapshot.fetchedAt,
            },
          };
        } catch (error) {
          return {
            schemaVersion: MARKET_DATA_SCHEMA_VERSION,
            provider: PROVIDERS.NSE,
            status: AVAILABILITY.SOURCE_ERROR,
            qualification: 'OFFICIAL_NSE_WEBSITE_ENDPOINT_UNDOCUMENTED_SCHEMA_VALIDATED',
            dataClass: NSE_HISTORY_DATA_CLASS,
            instrumentKey: canonicalProductId,
            fetchedAt,
            observedAt: null,
            providerTimestamp: null,
            effectiveTradingDate: null,
            freshness: {
              status: FRESHNESS.UNKNOWN,
              ageSeconds: null,
              maxAgeSeconds: NSE_DAILY_HISTORY_MAX_AGE_SECONDS,
            },
            candleCount: 0,
            candles: [],
            source: {
              provider: PROVIDERS.NSE,
              instrumentId: benchmark.nseIndexName,
              url: NSE_HISTORICAL_INDEX_URL,
              requestUrls,
            },
            error: {
              code: 'NSE_HISTORY_FETCH_FAILED',
              message: safeNseHttpError(error, 'NSE historical index request failed'),
            },
          };
        }
      },
    });
    if (snapshot?.status !== AVAILABILITY.AVAILABLE
        || isUsableNseTradingCalendar(snapshot.calendar, this.clock())) return snapshot;
    return {
      ...snapshot,
      freshness: {
        status: FRESHNESS.UNKNOWN,
        ageSeconds: null,
        maxAgeSeconds: NSE_DAILY_HISTORY_MAX_AGE_SECONDS,
      },
      calendar: {
        status: 'UNAVAILABLE',
        source: snapshot.calendar?.source ?? null,
        fetchedAt: snapshot.calendar?.fetchedAt ?? null,
        error: snapshot.calendar?.error
          ?? { code: 'NSE_HOLIDAY_CALENDAR_EXPIRED', message: 'NSE trading calendar qualification expired.' },
      },
      reasonCodes: [...new Set([...(snapshot.reasonCodes || []), 'NSE_TRADING_CALENDAR_UNAVAILABLE'])],
    };
  }
}
