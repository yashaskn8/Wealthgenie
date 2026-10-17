import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchQualifiedMarketContextSnapshots,
  fetchQualifiedEquityHistory,
  isTwoProviderMarketDataMode,
  qualifyUpstoxBenchmarkHistory,
} from '../services/marketDataService.js';
import UpstoxTradingCalendarProvider, {
  expectedUpstoxNseSessions,
  parseUpstoxTradingCalendar,
  UPSTOX_TRADING_HOLIDAYS_URL,
} from '../services/marketData/UpstoxTradingCalendarProvider.js';
import { createMarketDataTestFixtureRightsCapability } from '../services/marketData/marketDataTestFixtures.js';
import { getUpstoxWithRetry } from '../services/marketData/upstoxRequestPolicy.js';
import {
  UPSTOX_NSE_MARKET_STATUS_URL,
  UPSTOX_MARKET_TIMINGS_RIGHTS_URL,
} from '../services/marketData/marketDataSourceUrls.js';

const fixtureEnv = { NODE_ENV: 'test', MARKET_DATA_MODE: 'UPSTOX_TEJHQ' };
const fixtureRights = createMarketDataTestFixtureRightsCapability({
  env: fixtureEnv,
  transport: { get: async () => ({ data: null }) },
});
const clock = () => new Date('2026-10-17T12:00:00.000Z');
const calendarPayload = {
  status: 'success',
  data: [
    { date: '2026-01-01', holiday_type: 'TRADING_HOLIDAY',
      closed_exchanges: ['NSE'], open_exchanges: [] },
    { date: '2026-10-10', holiday_type: 'SPECIAL_TIMING',
      closed_exchanges: [], open_exchanges: [{ exchange: 'NSE',
        start_time: Date.parse('2026-10-10T04:00:00.000Z'),
        end_time: Date.parse('2026-10-10T06:00:00.000Z') }] },
  ],
};

test('two-provider mode is explicit and rejects unknown configuration', () => {
  assert.equal(isTwoProviderMarketDataMode({}), false);
  assert.equal(isTwoProviderMarketDataMode(fixtureEnv), true);
  assert.throws(() => isTwoProviderMarketDataMode({ MARKET_DATA_MODE: 'UNKNOWN' }), /MARKET_DATA_MODE/);
});

test('Upstox read-only retries are bounded and respect authentication and Retry-After', async () => {
  let calls = 0;
  const delays = [];
  const options = { headers: { Authorization: 'Bearer fixture-only' } };
  const client = { get: async () => {
    calls += 1;
    if (calls <= 2) {
      const error = new Error('fixture');
      error.response = { status: 503 };
      throw error;
    }
    return { data: { status: 'success' } };
  } };
  const response = await getUpstoxWithRetry(client, 'https://api.upstox.com/fixture', options, {
    sleep: async delay => { delays.push(delay); }, random: () => 0.5,
  });
  assert.equal(response.data.status, 'success');
  assert.deepEqual(delays, [200, 400]);
  assert.equal(calls, 3);
  assert.equal(options.headers.Authorization, 'Bearer fixture-only');

  for (const [status, retryAfter] of [[401, null], [403, null], [429, '5']]) {
    let attempts = 0;
    await assert.rejects(getUpstoxWithRetry({ get: async () => {
      attempts += 1;
      const error = new Error('fixture');
      error.response = { status, headers: retryAfter ? { 'retry-after': retryAfter } : {} };
      throw error;
    } }, 'https://api.upstox.com/fixture', {}, { sleep: async () => assert.fail('must not retry') }));
    assert.equal(attempts, 1);
  }
  let quotaAttempts = 0;
  const quotaDelays = [];
  await getUpstoxWithRetry({ get: async () => {
    quotaAttempts += 1;
    if (quotaAttempts === 1) {
      const error = new Error('rate limited');
      error.response = { status: 429, headers: { 'retry-after': '0.1' } };
      throw error;
    }
    return { data: {} };
  } }, 'https://api.upstox.com/fixture', {}, {
    sleep: async delay => { quotaDelays.push(delay); },
  });
  assert.deepEqual(quotaDelays, [100]);
  assert.equal(quotaAttempts, 2);
});

test('Upstox calendar validates special Saturday sessions, closure, and annual range', () => {
  const calendar = parseUpstoxTradingCalendar(calendarPayload, {
    year: '2026', fetchedAt: clock().toISOString(),
  });
  assert.deepEqual(calendar.holidayDates, ['2026-01-01']);
  assert.deepEqual(calendar.specialTradingDates, ['2026-10-10']);
  assert.deepEqual(expectedUpstoxNseSessions('2026-10-08', '2026-10-11', calendar, clock()),
    ['2026-10-08', '2026-10-09', '2026-10-10']);
  assert.equal(expectedUpstoxNseSessions('2025-12-31', '2026-01-02', calendar, clock()), null);
  assert.equal(expectedUpstoxNseSessions('2026-10-08', '2026-10-09', {
    ...calendar, fetchedAt: '2026-10-01T00:00:00.000Z',
  }, clock()), null);
  assert.throws(() => parseUpstoxTradingCalendar({ ...calendarPayload,
    data: [...calendarPayload.data, { ...calendarPayload.data[0] }],
  }, { year: '2026', fetchedAt: clock().toISOString() }), /SCHEMA_INVALID/);
  assert.throws(() => parseUpstoxTradingCalendar({ ...calendarPayload,
    data: [{ ...calendarPayload.data[1], closed_exchanges: ['NSE'] }],
  }, { year: '2026', fetchedAt: clock().toISOString() }), /CONFLICTING_NSE_SESSION/);
});

test('selected benchmark history accepts exact current-year sessions and rejects a missing day', () => {
  const calendar = parseUpstoxTradingCalendar(calendarPayload, {
    year: '2026', fetchedAt: clock().toISOString(),
  });
  const expectedDates = expectedUpstoxNseSessions('2026-01-01', '2026-10-16', calendar, clock());
  const snapshot = {
    provider: 'UPSTOX', status: 'AVAILABLE', instrumentKey: 'NSE_INDEX|Nifty 50',
    candles: expectedDates.map(date => ({ timestamp: `${date}T10:00:00.000Z`,
      open: 100, high: 110, low: 90, close: 105, volume: 100 })),
  };
  const qualified = qualifyUpstoxBenchmarkHistory(snapshot, calendar, {
    now: clock(), toDate: '2026-10-16',
  });
  assert.equal(qualified.status, 'AVAILABLE');
  assert.equal(qualified.coverage.expectedSessionCount, expectedDates.length);
  assert.equal(qualified.coverage.calendarProvider, 'UPSTOX');
  const missing = qualifyUpstoxBenchmarkHistory({ ...snapshot,
    candles: snapshot.candles.filter(candle => !candle.timestamp.startsWith('2026-10-10')),
  }, calendar, { now: clock(), toDate: '2026-10-16' });
  assert.equal(missing.status, 'SOURCE_ERROR');
  assert.equal(missing.error.code, 'UPSTOX_BENCHMARK_SESSION_COVERAGE_INCOMPLETE');
  assert.deepEqual(missing.candles, []);
});

test('calendar adapter never reads a provider when rights or current-year coverage are absent', async () => {
  let calls = 0;
  const provider = new UpstoxTradingCalendarProvider({
    env: { NODE_ENV: 'production' }, accessToken: 'fixture-only', clock,
    httpClient: { get: async () => { calls += 1; return { data: calendarPayload }; } },
  });
  const rightsDenied = await provider.getCalendar({ fromDate: '2026-10-08', toDate: '2026-10-09' });
  const crossYear = await provider.getCalendar({ fromDate: '2025-12-31', toDate: '2026-01-02' });
  assert.equal(rightsDenied.error.code, 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
  assert.equal(crossYear.error.code, 'UPSTOX_CALENDAR_RANGE_NOT_COVERED');
  assert.equal(calls, 0);
});

test('calendar adapter classifies authentication, entitlement, quota, provider and timeout failures', async () => {
  for (const [failure, expected] of [
    [{ response: { status: 401 } }, 'UPSTOX_AUTHENTICATION_FAILED'],
    [{ response: { status: 403 } }, 'UPSTOX_PERMISSION_DENIED'],
    [{ response: { status: 429 } }, 'UPSTOX_RATE_LIMITED'],
    [{ response: { status: 503 } }, 'UPSTOX_PROVIDER_UNAVAILABLE'],
    [{ code: 'ECONNABORTED' }, 'UPSTOX_TIMEOUT'],
  ]) {
    const provider = new UpstoxTradingCalendarProvider({
      env: fixtureEnv, accessToken: 'fixture-only', clock,
      requestCache: async ({ loader }) => loader(),
      httpClient: { get: async () => { throw failure; } },
    });
    const result = await provider.getCalendar({ fromDate: '2026-10-08', toDate: '2026-10-09' });
    assert.equal(result.status, 'SOURCE_ERROR');
    assert.equal(result.error.code, expected);
  }
  const missingToken = new UpstoxTradingCalendarProvider({
    env: fixtureEnv, accessToken: '', clock,
    httpClient: { get: async () => { assert.fail('missing token cannot call provider'); } },
  });
  const result = await missingToken.getCalendar({ fromDate: '2026-10-08', toDate: '2026-10-09' });
  assert.equal(result.error.code, 'PROVIDER_NOT_CONFIGURED');
});

test('session adapter verifies Upstox exchange status and official date timings', async () => {
  let now = new Date('2026-10-09T05:00:00.000Z');
  const calls = [];
  const provider = new UpstoxTradingCalendarProvider({
    env: fixtureEnv, accessToken: 'fixture-only', clock: () => now,
    requestCache: async ({ loader }) => loader(),
    httpClient: { get: async url => {
      calls.push(url);
      if (url === UPSTOX_TRADING_HOLIDAYS_URL) return { data: calendarPayload };
      if (url === UPSTOX_NSE_MARKET_STATUS_URL) return { data: {
        status: 'success', data: { exchange: 'NSE', status: 'NORMAL_OPEN',
          last_updated: now.getTime() - 60 * 60 * 1000 },
      } };
      if (url === UPSTOX_MARKET_TIMINGS_RIGHTS_URL.replace('{date}', now.toISOString().slice(0, 10))) {
        return { data: { status: 'success', data: [{ exchange: 'NSE',
          start_time: Date.parse(`${now.toISOString().slice(0, 10)}T${now.toISOString().startsWith('2026-10-10') ? '04:00' : '03:45'}:00.000Z`),
          end_time: Date.parse(`${now.toISOString().slice(0, 10)}T${now.toISOString().startsWith('2026-10-10') ? '06:00' : '10:00'}:00.000Z`) }] } };
      }
      throw new Error('Unexpected provider URL');
    } },
  });
  const open = await provider.getCurrentSession();
  assert.equal(open.status, 'MARKET_OPEN');
  assert.equal(open.observedAt, '2026-10-09T04:00:00.000Z');
  assert.equal(open.source.provider, 'UPSTOX');
  assert.equal(calls.length, 3);

  now = new Date('2026-10-10T05:00:00.000Z');
  const special = await provider.getCurrentSession();
  assert.equal(special.status, 'MARKET_OPEN');
  assert.equal(special.calendar.specialTradingDates.includes('2026-10-10'), true);
});

test('selected mode never attempts NSE market providers when Upstox fails', async () => {
  const calls = { upstoxQuotes: 0, upstoxHistory: 0, nseQuotes: 0, nseHistory: 0 };
  const pair = await fetchQualifiedMarketContextSnapshots({
    env: fixtureEnv, persist: false, now: clock(),
    marketDataTestFixtureRightsCapability: fixtureRights,
    upstoxQuoteProvider: { getQuotes: async () => {
      calls.upstoxQuotes += 1;
      return { provider: 'UPSTOX', status: 'SOURCE_ERROR', facts: [] };
    } },
    upstoxHistoryProviderOverride: { getDailyCandles: async () => {
      calls.upstoxHistory += 1;
      return { provider: 'UPSTOX', status: 'SOURCE_ERROR', candles: [] };
    } },
    upstoxCalendarProviderOverride: { getCurrentSession: async () => ({ status: 'UNKNOWN' }) },
    nseQuoteProvider: { getQuotes: async () => { calls.nseQuotes += 1; return {}; } },
    nseHistoryProviderOverride: { getDailyCandles: async () => { calls.nseHistory += 1; return {}; } },
  });
  assert.deepEqual(calls, { upstoxQuotes: 1, upstoxHistory: 1, nseQuotes: 0, nseHistory: 0 });
  assert.deepEqual(pair.providerSelection.attemptedProviders, ['UPSTOX']);
  assert.equal(pair.providerSelection.selectedProvider, null);
  assert.equal(pair.providerSelection.fallbackUsed, false);
});

test('selected equity-history mode qualifies a special session without NSE calendar reads', async () => {
  const now = clock();
  const calendar = parseUpstoxTradingCalendar(calendarPayload, {
    year: '2026', fetchedAt: now.toISOString(),
  });
  let nseCalls = 0;
  let tejCalls = 0;
  const result = await fetchQualifiedEquityHistory({
    exchange: 'NSE', symbol: 'RELIANCE', isin: 'INE002A01018',
    fromDate: '2026-10-08', toDate: '2026-10-10',
  }, {
    env: fixtureEnv, clock,
    marketDataTestFixtureRightsCapability: fixtureRights,
    upstoxProvider: { getDailyCandles: async () => ({
      provider: 'UPSTOX', status: 'AVAILABLE', instrumentKey: 'NSE_EQ|INE002A01018',
      candles: ['2026-10-08', '2026-10-09', '2026-10-10'].map(date => ({
        timestamp: `${date}T05:00:00.000Z`, open: 100, high: 110, low: 90,
        close: 105, volume: 10,
      })),
    }) },
    upstoxCalendarProviderOverride: { getCalendar: async () => calendar },
    nseCalendarProvider: { holidayLoader: async () => { nseCalls += 1; return {}; } },
    tejHqHistoricalProvider: { getRawHistory: async () => { tejCalls += 1; return {}; } },
  });
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.provider, 'UPSTOX');
  assert.equal(result.coverage.calendarProvider, 'UPSTOX');
  assert.equal(result.coverage.expectedSessionCount, 3);
  assert.equal(nseCalls, 0);
  assert.equal(tejCalls, 0);
});

test('selected equity-history mode denies unqualified calendar before all provider calls', async () => {
  let calls = 0;
  const result = await fetchQualifiedEquityHistory({
    exchange: 'NSE', symbol: 'RELIANCE', isin: 'INE002A01018',
    fromDate: '2026-10-08', toDate: '2026-10-09',
  }, {
    env: { NODE_ENV: 'production', MARKET_DATA_MODE: 'UPSTOX_TEJHQ' },
    upstoxProvider: { getDailyCandles: async () => { calls += 1; return {}; } },
    nseCalendarProvider: { holidayLoader: async () => { calls += 1; return {}; } },
    upstoxCalendarProviderOverride: { getCalendar: async () => { calls += 1; return {}; } },
  });
  assert.equal(result.selection.reasonCode, 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
  assert.equal(calls, 0);
});

test('selected mode uses TejHQ EOD fallback with Upstox calendar provenance only', async () => {
  const calendar = parseUpstoxTradingCalendar(calendarPayload, {
    year: '2026', fetchedAt: clock().toISOString(),
  });
  const dates = ['2026-10-08', '2026-10-09', '2026-10-10'];
  let nseCalls = 0;
  const result = await fetchQualifiedEquityHistory({
    exchange: 'NSE', symbol: 'RELIANCE', isin: 'INE002A01018',
    fromDate: dates[0], toDate: dates.at(-1),
  }, {
    env: { ...fixtureEnv, TEJHQ_HISTORICAL_FALLBACK_ENABLED: 'true' },
    clock,
    marketDataTestFixtureRightsCapability: fixtureRights,
    upstoxProvider: { getDailyCandles: async () => ({
      provider: 'UPSTOX', status: 'SOURCE_ERROR', candles: [],
      error: { code: 'UPSTOX_TIMEOUT' },
    }) },
    upstoxCalendarProviderOverride: { getCalendar: async () => calendar },
    nseCalendarProvider: { holidayLoader: async () => { nseCalls += 1; return {}; } },
    tejHqHistoricalProvider: {
      getSymbolHistory: async () => ({
        status: 'AVAILABLE', exchange: 'NSE', isin: 'INE002A01018',
        sourceDatasetRevision: 'fixture-revision',
        intervals: [{ exchange: 'NSE', isin: 'INE002A01018', symbol: 'RELIANCE',
          validFrom: '2010-01-01', validTo: dates.at(-1) }],
      }),
      getStatus: async () => ({ provider: 'TEJHQ', status: 'AVAILABLE',
        publication: { datasetTradingDate: dates.at(-1) } }),
      getRawHistory: async options => ({
        status: 'AVAILABLE', provider: 'TEJHQ',
        instrumentIdentity: { exchange: options.exchange,
          tradingSymbol: options.symbol, isin: options.isin },
        candles: dates.map(date => ({ date, open: 100, high: 110,
          low: 90, close: 105, volume: 10 })),
      }),
    },
  });
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.provider, 'TEJHQ');
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.coverage.calendarSource.provider, 'UPSTOX');
  assert.equal(result.coverage.expectedSessionCount, 3);
  assert.equal(nseCalls, 0);
});
