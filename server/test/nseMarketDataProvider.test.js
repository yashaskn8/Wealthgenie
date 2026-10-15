import test from 'node:test';
import assert from 'node:assert/strict';
import NseMarketDataProvider, {
  NSE_ALL_INDICES_URL,
  parseNseIndexQuotes,
} from '../services/marketData/NseMarketDataProvider.js';
import NseHistoricalDataProvider, {
  buildNseHistoryWindows,
  parseNseHistoricalData,
} from '../services/marketData/NseHistoricalDataProvider.js';
import { buildNseHistoricalIndexRequestUrl } from '../services/marketData/marketDataSourceUrls.js';
import { MARKET_BENCHMARKS, DEFAULT_BENCHMARK_IDS } from '../services/marketData/marketBenchmarks.js';
import {
  evaluateNseQuoteFreshness,
  isUsableNseTradingCalendar,
  NSE_TRADING_HOLIDAY_CACHE_TTL_SECONDS,
  NSE_TRADING_HOLIDAY_URL,
  parseNseTradingHolidays,
} from '../services/marketData/nseTradingCalendar.js';
import { clearInFlightMarketRequestsForTest } from '../services/marketData/requestCache.js';
import { setRedisAvailable, setRedisClient } from '../config/redis.js';
import {
  buildCanonicalSessionSeries,
  computeMarketContextFeatures,
} from '../services/marketContextFeatureEngine.js';
import {
  MARKET_REGIME_DATASET_SCHEMA_VERSION,
  buildMarketRegimeDataset,
} from '../services/marketData/marketRegimeDataset.js';

const FETCHED_AT = '2026-09-08T10:01:00.000Z';
const QUOTE_PAYLOAD = Object.freeze({
  timestamp: '08-Sep-2026 15:30',
  data: [
    {
      index: 'NIFTY 50', last: 23635.1, previousClose: 23779.15,
      open: 23743.1, high: 23758.95, low: 23623.1,
    },
    {
      index: 'INDIA VIX', last: 11.1, previousClose: 11.16,
      open: 11.16, high: 11.4, low: 10.45,
    },
  ],
});

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function historyRow(isoDate, close, overrides = {}) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  const providerTimestamp = new Date(date.getTime() - 330 * 60 * 1000).toISOString();
  const displayDate = `${String(date.getUTCDate()).padStart(2, '0')}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
  return {
    EOD_INDEX_NAME: 'NIFTY 50',
    EOD_OPEN_INDEX_VAL: close - 2,
    EOD_HIGH_INDEX_VAL: close + 5,
    EOD_CLOSE_INDEX_VAL: close,
    EOD_LOW_INDEX_VAL: close - 5,
    HIT_TURN_OVER: 10000,
    HIT_TRADED_QTY: 100000,
    EOD_TIMESTAMP: displayDate,
    HI_TIMESTAMP: providerTimestamp,
    ...overrides,
  };
}

function makeHistory(count, endDate = '2026-09-07') {
  const end = new Date(`${endDate}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(end.getTime() - index * 86400000);
    return historyRow(date.toISOString().slice(0, 10), 24000 - index * 3);
  });
}

test('official NSE allIndices fixture maps current NIFTY, previous close, VIX, and provenance', () => {
  const snapshot = parseNseIndexQuotes(QUOTE_PAYLOAD, {
    fetchedAt: FETCHED_AT,
    now: new Date('2026-09-08T10:01:00.000Z'),
  });
  assert.equal(snapshot.provider, 'NSE');
  assert.equal(snapshot.status, 'AVAILABLE');
  assert.equal(snapshot.dataClass, 'LIVE');
  assert.equal(snapshot.providerTimestamp, '2026-09-08T10:00:00.000Z');
  assert.equal(snapshot.effectiveTradingDate, '2026-09-08');
  assert.equal(snapshot.facts[0].canonicalProductId, MARKET_BENCHMARKS.NIFTY_50.canonicalProductId);
  assert.equal(snapshot.facts[0].value, 23635.1);
  assert.equal(snapshot.facts[0].metrics.previousClose, 23779.15);
  assert.equal(snapshot.facts[1].canonicalProductId, MARKET_BENCHMARKS.INDIA_VIX.canonicalProductId);
  assert.equal(snapshot.facts[1].value, 11.1);
  assert.equal(snapshot.facts[0].source.url, NSE_ALL_INDICES_URL);
  assert.equal(snapshot.facts[0].freshness.status, 'FRESH');
  assert.equal(snapshot.marketSession.status, 'MARKET_CLOSED');
  assert.equal(snapshot.marketSession.tradingDate, '2026-09-08');
});

test('NSE quote schema drift and missing required facts fail closed without numeric fallbacks', () => {
  const options = { fetchedAt: FETCHED_AT, now: new Date(FETCHED_AT) };
  assert.throws(() => parseNseIndexQuotes({ timestamp: QUOTE_PAYLOAD.timestamp }, options), /SCHEMA_MISMATCH:data/);
  assert.throws(() => parseNseIndexQuotes({ data: QUOTE_PAYLOAD.data, timestamp: 'unknown' }, options), /SCHEMA_MISMATCH:timestamp/);

  const missingNifty = parseNseIndexQuotes({ ...QUOTE_PAYLOAD, data: [QUOTE_PAYLOAD.data[1]] }, options);
  assert.equal(missingNifty.status, 'PARTIAL');
  assert.equal(missingNifty.facts[0].availabilityStatus, 'UNAVAILABLE');
  assert.equal(missingNifty.facts[0].value, null);

  const missingVix = parseNseIndexQuotes({ ...QUOTE_PAYLOAD, data: [QUOTE_PAYLOAD.data[0]] }, options);
  assert.equal(missingVix.status, 'PARTIAL');
  assert.equal(missingVix.facts[1].availabilityStatus, 'UNAVAILABLE');

  const withoutPreviousClose = structuredClone(QUOTE_PAYLOAD);
  delete withoutPreviousClose.data[0].previousClose;
  const missingClose = parseNseIndexQuotes(withoutPreviousClose, options);
  assert.equal(missingClose.status, 'PARTIAL');
  assert.equal(missingClose.facts[0].metrics.previousClose, null);
  assert.equal(missingClose.facts[0].availabilityStatus, 'UNAVAILABLE');
});

test('NSE quote freshness distinguishes open market, closed market, weekend, and exchange holiday', () => {
  const preMarket = evaluateNseQuoteFreshness({
    observedAt: '2026-09-07T10:00:00.000Z',
    fetchedAt: '2026-09-08T03:30:00.000Z',
    now: new Date('2026-09-08T03:30:00.000Z'),
  });
  assert.equal(preMarket.status, 'FRESH');
  assert.equal(preMarket.marketSession, 'MARKET_CLOSED');

  const current = evaluateNseQuoteFreshness({
    observedAt: '2026-09-08T06:30:00.000Z',
    fetchedAt: '2026-09-08T06:31:00.000Z',
    now: new Date('2026-09-08T06:31:00.000Z'),
  });
  assert.equal(current.status, 'FRESH');
  assert.equal(current.marketSession, 'MARKET_OPEN');

  const staleDuringMarket = evaluateNseQuoteFreshness({
    observedAt: '2026-09-08T05:30:00.000Z',
    fetchedAt: '2026-09-08T06:31:00.000Z',
    now: new Date('2026-09-08T06:31:00.000Z'),
  });
  assert.equal(staleDuringMarket.status, 'STALE');

  const afterClose = evaluateNseQuoteFreshness({
    observedAt: '2026-09-08T10:00:00.000Z',
    fetchedAt: '2026-09-08T14:30:00.000Z',
    now: new Date('2026-09-08T14:30:00.000Z'),
  });
  assert.equal(afterClose.status, 'FRESH');

  const weekend = evaluateNseQuoteFreshness({
    observedAt: '2026-09-04T10:00:00.000Z',
    fetchedAt: '2026-09-06T06:30:00.000Z',
    now: new Date('2026-09-06T06:30:00.000Z'),
  });
  assert.equal(weekend.status, 'FRESH');

  const mondayHoliday = evaluateNseQuoteFreshness({
    observedAt: '2026-09-04T10:00:00.000Z',
    fetchedAt: '2026-09-07T06:30:00.000Z',
    now: new Date('2026-09-07T06:30:00.000Z'),
    holidayDates: ['2026-09-07'],
  });
  assert.equal(mondayHoliday.status, 'FRESH');
  assert.equal(mondayHoliday.marketSession, 'MARKET_HOLIDAY');
});

test('NSE capital-market holiday schema is strict and deduplicated', () => {
  assert.deepEqual(parseNseTradingHolidays({
    CM: [
      { tradingDate: '15-Jan-2026' },
      { tradingDate: '15-Jan-2026' },
      { tradingDate: '25-Dec-2026' },
    ],
  }), ['2026-01-15', '2026-12-25']);
  assert.throws(() => parseNseTradingHolidays({}), /SCHEMA_MISMATCH:CM/);
  assert.throws(() => parseNseTradingHolidays({ CM: [{ tradingDate: 'bad' }] }), /CM\[0\]/);
});

test('NSE historical parser sorts unordered rows and removes exact duplicates', () => {
  const duplicate = historyRow('2026-09-05', 24010);
  const snapshot = parseNseHistoricalData({
    data: [historyRow('2026-09-07', 24020), duplicate, historyRow('2026-09-06', 24015), { ...duplicate }],
  }, {
    fetchedAt: '2026-09-08T04:00:00.000Z',
    fromDate: '2026-09-01',
    toDate: '2026-09-07',
    now: new Date('2026-09-08T04:00:00.000Z'),
  });
  assert.equal(snapshot.candleCount, 3);
  assert.equal(snapshot.duplicateRowCount, 1);
  assert.deepEqual(snapshot.candles.map(candle => candle.effectiveTradingDate), [
    '2026-09-05', '2026-09-06', '2026-09-07',
  ]);
  assert.equal(snapshot.freshness.status, 'FRESH');
});

test('NSE historical adapter supports India VIX through the same provider-neutral contract', () => {
  const rows = [
    historyRow('2026-09-07', 11.2, { EOD_INDEX_NAME: 'INDIA VIX' }),
    historyRow('2026-09-05', 11.4, { EOD_INDEX_NAME: 'INDIA VIX' }),
  ];
  const snapshot = parseNseHistoricalData({ data: rows }, {
    fetchedAt: '2026-09-08T04:00:00.000Z',
    fromDate: '2026-09-01',
    toDate: '2026-09-07',
    canonicalProductId: MARKET_BENCHMARKS.INDIA_VIX.canonicalProductId,
    now: new Date('2026-09-08T04:00:00.000Z'),
  });
  assert.equal(snapshot.instrumentKey, MARKET_BENCHMARKS.INDIA_VIX.canonicalProductId);
  assert.equal(snapshot.source.instrumentId, 'INDIA VIX');
  assert.deepEqual(snapshot.candles.map(candle => candle.close), [11.4, 11.2]);
});

test('market-regime dataset joins only verified common sessions and records a stable content hash', () => {
  const options = {
    fetchedAt: '2026-09-08T04:00:00.000Z',
    fromDate: '2026-09-01',
    toDate: '2026-09-07',
    now: new Date('2026-09-08T04:00:00.000Z'),
  };
  const niftySnapshot = parseNseHistoricalData({ data: [
    historyRow('2026-09-04', 24000),
    historyRow('2026-09-05', 24010),
    historyRow('2026-09-07', 24020),
  ] }, options);
  const vixSnapshot = parseNseHistoricalData({ data: [
    historyRow('2026-09-05', 12.2, { EOD_INDEX_NAME: 'INDIA VIX' }),
    historyRow('2026-09-07', 11.8, { EOD_INDEX_NAME: 'INDIA VIX' }),
  ] }, {
    ...options,
    canonicalProductId: MARKET_BENCHMARKS.INDIA_VIX.canonicalProductId,
  });
  const verifiedCalendar = {
    status: 'AVAILABLE',
    source: { provider: 'NSE', url: NSE_TRADING_HOLIDAY_URL },
    fetchedAt: '2026-09-08T04:00:00.000Z',
  };
  niftySnapshot.calendar = verifiedCalendar;
  vixSnapshot.calendar = verifiedCalendar;
  const first = buildMarketRegimeDataset({
    niftySnapshot,
    vixSnapshot,
    retrievedAt: '2026-09-08T04:05:00.000Z',
  });
  const second = buildMarketRegimeDataset({
    niftySnapshot,
    vixSnapshot,
    retrievedAt: '2026-09-08T05:05:00.000Z',
  });
  assert.equal(first.schemaVersion, MARKET_REGIME_DATASET_SCHEMA_VERSION);
  assert.equal(first.rowCount, 2);
  assert.deepEqual(first.rows.map(row => row.effectiveTradingDate), ['2026-09-05', '2026-09-07']);
  assert.equal(first.missingObservations.nifty50WithoutIndiaVix, 1);
  assert.equal(first.missingObservations.policy, 'INNER_JOIN_NO_IMPUTATION_NO_FORWARD_FILL');
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.source.provider, 'NSE');
  assert.throws(() => buildMarketRegimeDataset({
    niftySnapshot,
    vixSnapshot,
    retrievedAt: '2020-01-01T00:00:00.000Z',
  }), /retrievedAt must not precede source fetches or observations/);
  assert.throws(() => buildMarketRegimeDataset({
    niftySnapshot,
    vixSnapshot,
    retrievedAt: '2026-09-08T03:59:00.000Z',
  }), /retrievedAt must not precede source fetches or observations/);
  assert.throws(() => buildMarketRegimeDataset({
    niftySnapshot,
    vixSnapshot,
    retrievedAt: '2026-02-30T00:00:00.000Z',
  }), /retrievedAt must be a valid timestamp/);
});

test('malformed OHLC, conflicting duplicates, schema drift, and stale history are rejected', () => {
  const options = {
    fetchedAt: '2026-09-08T04:00:00.000Z',
    fromDate: '2026-09-01',
    toDate: '2026-09-07',
    now: new Date('2026-09-08T04:00:00.000Z'),
  };
  assert.throws(() => parseNseHistoricalData({}, options), /SCHEMA_MISMATCH:data/);
  assert.throws(() => parseNseHistoricalData({ data: [
    historyRow('2026-09-07', 24020, { EOD_HIGH_INDEX_VAL: 23000 }),
  ] }, options), /INVALID_ROW/);
  assert.throws(() => parseNseHistoricalData({ data: [
    historyRow('2026-09-07', 24020),
    historyRow('2026-09-07', 24021),
  ] }, options), /CONFLICTING_DUPLICATE/);

  const stale = parseNseHistoricalData({ data: [historyRow('2026-09-04', 24000)] }, options);
  assert.equal(stale.freshness.status, 'STALE');
});

test('NSE history windows are bounded and cover the requested range without overlap', () => {
  const windows = buildNseHistoryWindows('2025-08-03', '2026-09-07');
  assert.equal(windows[0].fromDate, '2025-08-03');
  assert.equal(windows.at(-1).toDate, '2026-09-07');
  assert(windows.length >= 5);
  windows.forEach(window => {
    const days = ((Date.parse(`${window.toDate}T00:00:00Z`) - Date.parse(`${window.fromDate}T00:00:00Z`)) / 86400000) + 1;
    assert(days <= 90);
  });
  for (let index = 1; index < windows.length; index += 1) {
    assert.equal(Date.parse(`${windows[index].fromDate}T00:00:00Z`) - Date.parse(`${windows[index - 1].toDate}T00:00:00Z`), 86400000);
  }
});

test('NSE history sends exact query URLs and preserves each request URL in source provenance', async () => {
  const calls = [];
  const expectedUrl = buildNseHistoricalIndexRequestUrl({
    indexType: 'NIFTY 50', from: '01-09-2026', to: '07-09-2026',
  });
  const calendar = {
    status: 'AVAILABLE',
    provider: 'NSE',
    dates: ['2026-10-02'],
    fetchedAt: FETCHED_AT,
    source: { provider: 'NSE', url: NSE_TRADING_HOLIDAY_URL },
  };
  const provider = new NseHistoricalDataProvider({
    clock: () => new Date(FETCHED_AT),
    holidayLoader: async () => calendar,
    httpClient: {
      get: async (url, options) => {
        calls.push({ url, options });
        return { data: { data: [historyRow('2026-09-07', 24020)] } };
      },
    },
  });
  const snapshot = await provider.getDailyCandles(MARKET_BENCHMARKS.NIFTY_50.canonicalProductId, {
    fromDate: '2026-09-01', toDate: '2026-09-07', forceRefresh: true,
  });
  assert.equal(snapshot.status, 'AVAILABLE');
  assert.deepEqual(calls.map(call => call.url), [expectedUrl]);
  assert.equal(calls[0].options.params, undefined);
  assert.deepEqual(snapshot.source.requestUrls, [expectedUrl]);
});

test('provider HTTP and parser failures return SOURCE_ERROR with no quote or candle fallback', async () => {
  const holidays = async () => ({ status: 'AVAILABLE', dates: [] });
  const failingHttp = { get: async () => { throw Object.assign(new Error('outage'), { response: { status: 503 } }); } };
  const quoteProvider = new NseMarketDataProvider({
    httpClient: failingHttp,
    holidayLoader: holidays,
    clock: () => new Date(FETCHED_AT),
  });
  const quote = await quoteProvider.getQuotes(DEFAULT_BENCHMARK_IDS, { forceRefresh: true });
  assert.equal(quote.status, 'SOURCE_ERROR');
  assert.deepEqual(quote.facts, []);
  assert.equal(quote.error.code, 'NSE_QUOTE_FETCH_FAILED');

  const historyProvider = new NseHistoricalDataProvider({
    httpClient: { get: async () => ({ data: { unexpected: [] } }) },
    holidayLoader: holidays,
    clock: () => new Date(FETCHED_AT),
  });
  const history = await historyProvider.getDailyCandles(MARKET_BENCHMARKS.NIFTY_50.canonicalProductId, {
    fromDate: '2026-06-01', toDate: '2026-09-07', forceRefresh: true,
  });
  assert.equal(history.status, 'SOURCE_ERROR');
  assert.deepEqual(history.candles, []);
});

test('NSE quote and history providers withhold freshness for stale, empty, or unverified calendars', async () => {
  const now = new Date(FETCHED_AT);
  const staleCalendar = {
    schemaVersion: 'market-fact-1.0.0',
    provider: 'NSE',
    status: 'AVAILABLE',
    fetchedAt: '2020-01-01T00:00:00.000Z',
    dates: [],
    source: { provider: 'NSE', url: NSE_TRADING_HOLIDAY_URL },
  };
  assert.equal(isUsableNseTradingCalendar(staleCalendar, now), false);
  assert.equal(isUsableNseTradingCalendar({
    ...staleCalendar,
    fetchedAt: FETCHED_AT,
    dates: ['2026-10-02'],
  }, now), true);
  assert.equal(isUsableNseTradingCalendar({
    ...staleCalendar,
    fetchedAt: FETCHED_AT,
    dates: ['2025-10-02'],
  }, now), false);

  const quoteProvider = new NseMarketDataProvider({
    clock: () => now,
    holidayLoader: async () => staleCalendar,
    httpClient: { get: async () => ({ data: QUOTE_PAYLOAD }) },
  });
  const quote = await quoteProvider.getQuotes(DEFAULT_BENCHMARK_IDS, { forceRefresh: true });
  assert.equal(quote.status, 'AVAILABLE');
  assert.equal(quote.calendar.status, 'UNAVAILABLE');
  assert.equal(quote.calendar.error.code, 'NSE_HOLIDAY_CALENDAR_UNQUALIFIED');
  assert.equal(quote.marketSession.status, 'UNKNOWN');
  assert(quote.facts.every(fact => fact.freshness.status === 'UNKNOWN'));

  const historyProvider = new NseHistoricalDataProvider({
    clock: () => now,
    holidayLoader: async () => staleCalendar,
    httpClient: { get: async () => ({ data: { data: [historyRow('2026-09-07', 24020)] } }) },
  });
  const history = await historyProvider.getDailyCandles(
    MARKET_BENCHMARKS.NIFTY_50.canonicalProductId,
    { fromDate: '2026-09-01', toDate: '2026-09-07', forceRefresh: true },
  );
  assert.equal(history.status, 'AVAILABLE');
  assert.equal(history.calendar.status, 'UNAVAILABLE');
  assert.equal(history.calendar.error.code, 'NSE_HOLIDAY_CALENDAR_UNQUALIFIED');
  assert.equal(history.freshness.status, 'UNKNOWN');
});

test('cached NSE quote and history are demoted when their trusted calendar expires', async () => {
  let now = Date.parse('2026-09-08T10:00:30.000Z');
  const cache = new Map();
  let calendarLoads = 0;
  setRedisClient({
    get: async key => {
      const entry = cache.get(key);
      if (!entry || now >= entry.expiresAt) return null;
      return entry.value;
    },
    setEx: async (key, ttlSeconds, value) => {
      cache.set(key, { value, expiresAt: now + ttlSeconds * 1000 });
    },
  });
  setRedisAvailable(true);
  clearInFlightMarketRequestsForTest();
  const validCalendar = {
    schemaVersion: 'market-fact-1.0.0',
    provider: 'NSE',
    status: 'AVAILABLE',
    fetchedAt: new Date(now - NSE_TRADING_HOLIDAY_CACHE_TTL_SECONDS * 1000 + 30_000).toISOString(),
    dates: ['2026-10-02'],
    source: { provider: 'NSE', url: NSE_TRADING_HOLIDAY_URL },
  };
  const holidayLoader = async () => {
    calendarLoads += 1;
    return validCalendar;
  };
  const quoteProvider = new NseMarketDataProvider({
    clock: () => new Date(now),
    holidayLoader,
    httpClient: { get: async () => ({ data: QUOTE_PAYLOAD }) },
  });
  const historyProvider = new NseHistoricalDataProvider({
    clock: () => new Date(now),
    holidayLoader,
    httpClient: { get: async () => ({ data: { data: [historyRow('2026-09-07', 24020)] } }) },
  });
  try {
    const freshQuote = await quoteProvider.getQuotes(DEFAULT_BENCHMARK_IDS, { forceRefresh: true });
    const freshHistory = await historyProvider.getDailyCandles(
      MARKET_BENCHMARKS.NIFTY_50.canonicalProductId,
      { fromDate: '2026-09-01', toDate: '2026-09-07', forceRefresh: true },
    );
    assert.equal(freshQuote.calendar.status, 'AVAILABLE');
    assert.equal(freshQuote.facts[0].freshness.status, 'FRESH');
    assert.equal(freshHistory.calendar.status, 'AVAILABLE');
    assert.equal(freshHistory.freshness.status, 'FRESH');

    now += 31_000; // Market snapshots remain cached while the 24-hour calendar qualification expires.
    const expiredQuote = await quoteProvider.getQuotes(DEFAULT_BENCHMARK_IDS);
    const expiredHistory = await historyProvider.getDailyCandles(
      MARKET_BENCHMARKS.NIFTY_50.canonicalProductId,
      { fromDate: '2026-09-01', toDate: '2026-09-07' },
    );
    assert.equal(expiredQuote.cache.hit, true);
    assert.equal(expiredQuote.calendar.status, 'UNAVAILABLE');
    assert.equal(expiredQuote.facts[0].freshness.status, 'UNKNOWN');
    assert.equal(expiredHistory.cache.hit, true);
    assert.equal(expiredHistory.calendar.status, 'UNAVAILABLE');
    assert.equal(expiredHistory.freshness.status, 'UNKNOWN');
    assert.equal(calendarLoads, 2, 'cached market snapshots must be revalidated without refetching a calendar');
  } finally {
    clearInFlightMarketRequestsForTest();
    setRedisAvailable(false);
    setRedisClient(null);
  }
});

test('NSE calendar failure preserves valid quote and history facts but withholds freshness/session authority', async () => {
  const quoteProvider = new NseMarketDataProvider({
    clock: () => new Date(FETCHED_AT),
    holidayLoader: async () => { throw new Error('calendar outage'); },
    httpClient: { get: async () => ({ data: QUOTE_PAYLOAD }) },
  });
  const quote = await quoteProvider.getQuotes(DEFAULT_BENCHMARK_IDS, { forceRefresh: true });
  assert.equal(quote.status, 'AVAILABLE');
  assert.equal(quote.facts.length, 2);
  assert.equal(quote.facts[0].value, 23635.1);
  assert.equal(quote.facts[0].freshness.status, 'UNKNOWN');
  assert.equal(quote.marketSession.status, 'UNKNOWN');
  assert.equal(quote.calendar.status, 'UNAVAILABLE');

  const historyProvider = new NseHistoricalDataProvider({
    clock: () => new Date('2026-09-08T04:00:00.000Z'),
    holidayLoader: async () => { throw new Error('calendar outage'); },
    httpClient: { get: async () => ({ data: { data: [historyRow('2026-09-07', 24020)] } }) },
  });
  const history = await historyProvider.getDailyCandles(
    MARKET_BENCHMARKS.NIFTY_50.canonicalProductId,
    { fromDate: '2026-09-01', toDate: '2026-09-07', forceRefresh: true },
  );
  assert.equal(history.status, 'AVAILABLE');
  assert.equal(history.candleCount, 1);
  assert.equal(history.candles[0].close, 24020);
  assert.equal(history.freshness.status, 'UNKNOWN');
  assert.equal(history.calendar.status, 'UNAVAILABLE');
  assert.throws(() => buildMarketRegimeDataset({
    niftySnapshot: history,
    vixSnapshot: history,
    retrievedAt: '2026-09-08T05:00:00.000Z',
  }), /lacks qualified calendar\/freshness evidence/);

  const features = computeMarketContextFeatures({ quoteSnapshot: quote, historicalSnapshot: history });
  assert.equal(features.status, 'FEATURES_UNAVAILABLE');
  assert(features.reasonCodes.includes('NIFTY50_QUOTE_FRESHNESS_UNKNOWN'));
  assert(features.reasonCodes.includes('NIFTY50_HISTORY_FRESHNESS_UNKNOWN'));
});

test('canonical session series deduplicates current-session history and preserves completed-session order', () => {
  const series = buildCanonicalSessionSeries({
    currentQuoteFact: { effectiveTradingDate: '2026-09-08' },
    historyCandles: [
      { effectiveTradingDate: '2026-09-08', timestamp: '2026-09-08T10:00:00.000Z', close: 102, high: 104 },
      { effectiveTradingDate: '2026-09-07', timestamp: '2026-09-07T10:00:00.000Z', close: 101, high: 103 },
      { effectiveTradingDate: '2026-09-07', timestamp: '2026-09-07T11:00:00.000Z', close: 101.5, high: 104 },
      { effectiveTradingDate: '2026-09-05', timestamp: '2026-09-05T10:00:00.000Z', close: 99, high: 100 },
    ],
  });
  assert.deepEqual(series.allSessions.map(row => row.effectiveTradingDate), ['2026-09-05', '2026-09-07', '2026-09-08']);
  assert.deepEqual(series.completedSessions.map(row => row.effectiveTradingDate), ['2026-09-05', '2026-09-07']);
  assert.equal(series.completedSessions.at(-1).close, 101.5);
});

test('NSE quote provider coalesces concurrent requests and then serves Redis cache', async () => {
  const values = new Map();
  setRedisClient({
    get: async key => values.get(key) ?? null,
    setEx: async (key, _ttl, value) => { values.set(key, value); },
  });
  setRedisAvailable(true);
  clearInFlightMarketRequestsForTest();
  let calls = 0;
  try {
    const provider = new NseMarketDataProvider({
      clock: () => new Date(FETCHED_AT),
      holidayLoader: async () => ({ status: 'AVAILABLE', dates: [] }),
      httpClient: { get: async () => { calls += 1; return { data: QUOTE_PAYLOAD }; } },
    });
    const [first, coalesced] = await Promise.all([provider.getQuotes(), provider.getQuotes()]);
    const cached = await provider.getQuotes();
    assert.equal(calls, 1);
    assert.equal(first.cache.hit, false);
    assert.equal(coalesced.cache.hit, false);
    assert.equal(cached.cache.hit, true);
  } finally {
    clearInFlightMarketRequestsForTest();
    setRedisAvailable(false);
    setRedisClient(null);
  }
});

test('history-count boundaries keep context unavailable below 50 and expose MA50/MA200 only with evidence', () => {
  const quote = parseNseIndexQuotes(QUOTE_PAYLOAD, {
    fetchedAt: FETCHED_AT,
    now: new Date(FETCHED_AT),
  });
  function featuresFor(count) {
    const history = parseNseHistoricalData({ data: makeHistory(count) }, {
      fetchedAt: FETCHED_AT,
      fromDate: '2025-01-01',
      toDate: '2026-09-07',
      now: new Date(FETCHED_AT),
    });
    return computeMarketContextFeatures({ quoteSnapshot: quote, historicalSnapshot: history });
  }
  const belowMinimum = featuresFor(49);
  assert.equal(belowMinimum.status, 'FEATURES_UNAVAILABLE');
  assert(belowMinimum.reasonCodes.includes('INSUFFICIENT_NIFTY50_HISTORY'));

  const fifty = featuresFor(50);
  assert.equal(fifty.status, 'FEATURES_AVAILABLE');
  assert.equal(fifty.signals.movingAverage50Day.available, true);
  assert.equal(fifty.signals.movingAverage200Day.available, false);

  const oneNinetyNine = featuresFor(199);
  assert.equal(oneNinetyNine.signals.movingAverage200Day.available, false);

  const twoHundred = featuresFor(200);
  assert.equal(twoHundred.signals.movingAverage200Day.available, true);
});
