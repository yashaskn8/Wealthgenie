import assert from 'node:assert/strict';
import test from 'node:test';
import AmfiNavProvider from '../services/marketData/AmfiNavProvider.js';
import AmfiNavHistoryProvider from '../services/marketData/AmfiNavHistoryProvider.js';
import GovernmentSmallSavingsProvider from '../services/marketData/GovernmentSmallSavingsProvider.js';
import NseHistoricalDataProvider from '../services/marketData/NseHistoricalDataProvider.js';
import NseMarketDataProvider from '../services/marketData/NseMarketDataProvider.js';
import { MARKET_BENCHMARKS } from '../services/marketData/marketBenchmarks.js';
import { fetchNseTradingHolidays } from '../services/marketData/nseTradingCalendar.js';
import RbiFloatingRateSavingsBondProvider from '../services/marketData/RbiFloatingRateSavingsBondProvider.js';
import SbiTermDepositProvider from '../services/marketData/SbiTermDepositProvider.js';
import UpstoxHistoricalCandleProvider from '../services/marketData/UpstoxHistoricalCandleProvider.js';
import UpstoxMarketDataProvider from '../services/marketData/UpstoxMarketDataProvider.js';

const NOW = new Date('2026-10-05T11:00:00.000Z');
const FROM = '2026-10-01';
const TO = '2026-10-05';

function makeFault(fault) {
  if (fault.status) {
    return Object.assign(new Error(`HTTP ${fault.status}`), {
      response: { status: fault.status },
    });
  }
  return Object.assign(new Error(fault.message), { code: fault.code });
}

const TRANSPORT_FAULTS = [
  { name: 'DNS resolution failure', code: 'ENOTFOUND', message: 'dns lookup failed' },
  { name: 'connection refused', code: 'ECONNREFUSED', message: 'connection refused' },
  { name: 'request timeout', code: 'ETIMEDOUT', message: 'request timed out' },
  { name: 'connection reset', code: 'ECONNRESET', message: 'connection reset' },
  ...[429, 500, 502, 503, 504].map(status => ({ name: `HTTP ${status}`, status })),
];

const ACTIVE_PROVIDER_CALLS = [
  ['AMFI current NAV', (httpClient, forceRefresh = true) => new AmfiNavProvider({ httpClient, clock: () => NOW })
    .getSnapshot({ forceRefresh })],
  ['AMFI historical NAV', (httpClient, forceRefresh = true) => new AmfiNavHistoryProvider({ httpClient, clock: () => NOW })
    .getSnapshot({ targetDate: '2026-10-05', forceRefresh })],
  ['India Post / DEA small savings', (httpClient, forceRefresh = true) => new GovernmentSmallSavingsProvider({ httpClient, clock: () => NOW })
    .getSnapshot({ forceRefresh })],
  ['SBI retail term deposits', (httpClient, forceRefresh = true) => new SbiTermDepositProvider({ httpClient, clock: () => NOW })
    .getSnapshot({ forceRefresh })],
  ['RBI Floating Rate Savings Bond', (httpClient, forceRefresh = true) => new RbiFloatingRateSavingsBondProvider({ httpClient, clock: () => NOW })
    .getSnapshot({ forceRefresh })],
  ['NSE market quotes', (httpClient, forceRefresh = true) => new NseMarketDataProvider({
    httpClient,
    clock: () => NOW,
    holidayLoader: async () => ({ status: 'SOURCE_ERROR', dates: [], fetchedAt: NOW.toISOString() }),
  }).getQuotes([MARKET_BENCHMARKS.NIFTY_50.canonicalProductId], { forceRefresh })],
  ['NSE historical candles', (httpClient, forceRefresh = true) => new NseHistoricalDataProvider({
    httpClient,
    clock: () => NOW,
    holidayLoader: async () => ({ status: 'SOURCE_ERROR', dates: [], fetchedAt: NOW.toISOString() }),
  }).getDailyCandles(MARKET_BENCHMARKS.NIFTY_50.canonicalProductId, {
    fromDate: FROM,
    toDate: TO,
    forceRefresh,
  })],
  ['NSE trading calendar', (httpClient, forceRefresh = true) => fetchNseTradingHolidays({
    httpClient,
    clock: () => NOW,
    forceRefresh,
  })],
  ['Upstox market quotes', (httpClient, forceRefresh = true) => new UpstoxMarketDataProvider({
    httpClient,
    clock: () => NOW,
    accessToken: 'test-only-token',
  }).getQuotes(['NSE_INDEX|Nifty 50'], { forceRefresh })],
  ['Upstox historical candles', (httpClient, forceRefresh = true) => new UpstoxHistoricalCandleProvider({
    httpClient,
    clock: () => NOW,
    accessToken: 'test-only-token',
  }).getDailyCandles('NSE_INDEX|Nifty 50', {
    fromDate: FROM,
    toDate: TO,
    forceRefresh,
  })],
];

test('every active market-data adapter fails closed across network and HTTP chaos', async () => {
  for (const fault of TRANSPORT_FAULTS) {
    for (const [name, call] of ACTIVE_PROVIDER_CALLS) {
      let calls = 0;
      const httpClient = {
        async get() {
          calls += 1;
          throw makeFault(fault);
        },
      };
      const result = await call(httpClient, true);
      assert.ok(calls > 0, `${name} must exercise its transport for ${fault.name}`);
      assert.equal(result.status, 'SOURCE_ERROR', `${name} must fail closed for ${fault.name}`);
      assert.notEqual(result.status, 'AVAILABLE');
      assert.notEqual(result.status, 'PARTIAL');
      for (const fact of result.facts || []) {
        assert.notEqual(fact.value, 0, `${name} must not synthesize zero facts for ${fault.name}`);
      }
      for (const candle of result.candles || []) {
        assert.notEqual(candle.close, 0, `${name} must not synthesize zero candles for ${fault.name}`);
      }
    }
  }
});

test('malformed, truncated, and empty source payloads never become available facts', async () => {
  const payloads = [
    ['malformed', null],
    ['truncated', '<html><body><table><tr><td>'],
    ['empty', ''],
  ];
  for (const [payloadName, payload] of payloads) {
    for (const [name, call] of ACTIVE_PROVIDER_CALLS) {
      const result = await call({ get: async () => ({ data: payload }) }, true);
      assert.notEqual(result.status, 'AVAILABLE', `${name} must reject ${payloadName} data`);
      assert.equal(result.availableFactCount || 0, 0, `${name} must not expose facts from ${payloadName} data`);
      for (const fact of result.facts || []) {
        assert.notEqual(fact.availabilityStatus, 'AVAILABLE', `${name} must not qualify a ${payloadName} fact`);
        assert.notEqual(fact.value, 0, `${name} must not turn ${payloadName} data into zero`);
      }
    }
  }
});

test('provider SOURCE_ERROR is never cached as valid data, including after a forced refresh', async () => {
  for (const [name, call] of ACTIVE_PROVIDER_CALLS) {
    let calls = 0;
    const httpClient = {
      async get() {
        calls += 1;
        throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
      },
    };
    const forced = await call(httpClient, true);
    const callsAfterForcedRefresh = calls;
    const ordinary = await call(httpClient, false);
    assert.equal(forced.status, 'SOURCE_ERROR', name);
    assert.equal(ordinary.status, 'SOURCE_ERROR', name);
    assert.ok(calls > callsAfterForcedRefresh, `${name} must retry the source after SOURCE_ERROR`);
  }
});

test('a provider response arriving after its timeout cannot replace SOURCE_ERROR', async () => {
  for (const [name, call] of ACTIVE_PROVIDER_CALLS) {
    const latePayload = { data: { data: { last_price: 1 } } };
    const httpClient = {
      get() {
        return new Promise((resolve, reject) => {
          setTimeout(() => reject(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })), 1);
          setTimeout(() => resolve(latePayload), 20);
        });
      },
    };
    const result = await call(httpClient, true);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(result.status, 'SOURCE_ERROR', name);
    assert.equal(result.availableFactCount || 0, 0, `${name} must not publish a timed-out late result`);
  }
});

test('concurrent refreshes coalesce to one source load per active adapter', async () => {
  for (const [name, call] of ACTIVE_PROVIDER_CALLS) {
    let calls = 0;
    let signalFirstRequest;
    const firstRequest = new Promise(resolve => { signalFirstRequest = resolve; });
    let rejectFirstRequest;
    const httpClient = {
      get() {
        calls += 1;
        if (calls === 1) {
          signalFirstRequest();
          return new Promise((_resolve, reject) => { rejectFirstRequest = reject; });
        }
        return Promise.reject(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
      },
    };
    const first = call(httpClient, true);
    await firstRequest;
    const second = call(httpClient, true);
    await Promise.resolve();
    rejectFirstRequest(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
    const results = await Promise.all([first, second]);
    assert.equal(results[0].status, 'SOURCE_ERROR', name);
    assert.equal(results[1].status, 'SOURCE_ERROR', name);
    const expectedCalls = name.startsWith('Upstox ') ? 3 : name.startsWith('NSE ') ? 2 : 1;
    assert.equal(calls, expectedCalls, `${name} must share one bounded retry sequence`);
  }
});
