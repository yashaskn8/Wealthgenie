import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isPrivateMarketDemoConfigured,
  isPrivateMarketDemoLoopback,
  normalizePrivateBenchmarkQuotes,
  normalizePrivateTejHqEod,
  readPrivateMarketDemo,
} from '../services/marketData/privateMarketDemoService.js';

const env = {
  NODE_ENV: 'development',
  PRIVATE_MARKET_DEMO_ENABLED: 'true',
  PRIVATE_MARKET_DEMO_TERMS_ACKNOWLEDGED: 'true',
  PRIVATE_MARKET_DEMO_TEJHQ_ENABLED: 'true',
  UPSTOX_ANALYTICS_TOKEN: 'fixture-token-secret',
  TEJHQ_API_KEY: 'fixture-tejhq-secret',
};
const clock = () => new Date('2026-10-19T06:00:00.000Z');

test('private demo never enables production, CI, or an unacknowledged environment', async () => {
  assert.equal(isPrivateMarketDemoConfigured(env), true);
  for (const extra of [{ NODE_ENV: 'production' }, { NODE_ENV: 'test' },
    { CI: 'true' }, { GITHUB_ACTIONS: 'true' },
    { PRIVATE_MARKET_DEMO_TERMS_ACKNOWLEDGED: 'false' },
    { PRIVATE_MARKET_DEMO_ENABLED: 'false' }]) {
    const e = { ...env, ...extra };
    assert.equal(isPrivateMarketDemoConfigured(e), false);
    assert.deepEqual(await readPrivateMarketDemo({
      env: e, fetchImpl: () => { throw new Error('No network expected'); },
    }), { status: 'DISABLED', code: 'PRIVATE_DEMO_NOT_CONFIGURED' });
  }
});

test('private demo rejects external hosts/peers/origins even if headers are forged', () => {
  const request = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:5000', origin: 'http://localhost:5173' },
  };
  assert.equal(isPrivateMarketDemoLoopback(request), true);
  assert.equal(isPrivateMarketDemoLoopback({ ...request, socket: { remoteAddress: '198.51.100.12' } }), false);
  assert.equal(isPrivateMarketDemoLoopback({ ...request, headers: { host: 'wealthgenie.example' } }), false);
  assert.equal(isPrivateMarketDemoLoopback({ ...request, headers: { host: 'localhost:5000', origin: 'https://wealthgenie.example' } }), false);
});

test('bounded provider reads produce normalized snapshots and reuse short-lived cache', async () => {
  const cached = new Map(), calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(new URL(url).protocol, 'https:');
    assert.ok(['api.upstox.com', 'api.tejhq.dev'].includes(new URL(url).hostname));
    assert.ok(!url.includes('fixture-token-secret') && !url.includes('fixture-tejhq-secret'));
    if (url.includes('upstox.com')) {
      assert.equal(options.headers.Authorization, 'Bearer fixture-token-secret');
      return { status: 200, json: async () => ({
        status: 'success', data: {
          nifty: { instrument_token: 'NSE_INDEX|Nifty 50', last_price: 22932.05,
            last_trade_time: Date.parse('2026-10-19T05:59:00Z') },
          vix: { instrument_token: 'NSE_INDEX|India VIX', last_price: 14.8,
            last_trade_time: Date.parse('2026-10-19T05:59:00Z') },
        },
      }) };
    }
    assert.equal(options.headers.Authorization, undefined);
    const u = new URL(url);
    return { status: 200, json: async () => ({
      meta: { exchange: 'NSE', symbol: 'RELIANCE',
        from: u.searchParams.get('from'), to: u.searchParams.get('to'), count: 1 },
      data: [{ date: '2026-10-16', open: 100, high: 105, low: 99,
        close: 103, volume: 1000 }],
    }) };
  };
  const first = await readPrivateMarketDemo({ env, fetchImpl, now: clock, cache: cached });
  assert.equal(first.status, 'PRIVATE_DEVELOPMENT_ONLY');
  assert.equal(first.quotes.status, 'AVAILABLE');
  assert.equal(first.quotes.facts[0].price, 22932.05);
  assert.equal(first.eod.status, 'AVAILABLE');
  assert.equal(first.eod.candles[0].close, 103);
  assert.equal(first.storedIn, 'PROCESS_MEMORY_ONLY');
  assert.equal(first.persistentWrites, 0);
  assert.equal(calls.length, 2);
  const second = await readPrivateMarketDemo({ env, fetchImpl, now: clock, cache: cached });
  assert.equal(second.cache.quoteHit, true);
  assert.equal(second.cache.eodHit, true);
  assert.deepEqual(second.quotes, first.quotes);
  assert.equal(calls.length, 2);
  assert.ok(!JSON.stringify(first).includes('fixture-token-secret'));
  assert.ok(!JSON.stringify(first).includes('fixture-tejhq-secret'));
});

test('credential rotation gets a separate cache key', async () => {
  const cache = new Map(), now = clock;
  let calls = 0;
  const fetchImpl = async (_url, _options) => {
    calls++;
    return { status: 403, json: async () => ({}) };
  };
  await readPrivateMarketDemo({ env: { ...env, PRIVATE_MARKET_DEMO_TEJHQ_ENABLED: 'false' }, fetchImpl, now, cache });
  await readPrivateMarketDemo({ env: { ...env, UPSTOX_ANALYTICS_TOKEN: 'other-secret', PRIVATE_MARKET_DEMO_TEJHQ_ENABLED: 'false' }, fetchImpl, now, cache });
  assert.equal(calls, 2);
});

test('invalid or conflicting provider data fail closed without fabricated prices', () => {
  const observedAt = new Date('2026-10-19T06:00:00.000Z').toISOString();
  const quotes = normalizePrivateBenchmarkQuotes({ status: 'success', data: {
    wrong: { instrument_token: 'NSE_INDEX|Nifty 50', last_price: -1,
      last_trade_time: Date.now() },
  } }, observedAt);
  assert.equal(quotes.status, 'UNAVAILABLE');
  assert.equal(quotes.facts[0].price, null);
  const history = normalizePrivateTejHqEod({
    meta: { exchange: 'NSE', symbol: 'RELIANCE', from: '2026-09-07', to: '2026-10-17', count: 2 },
    data: [
      { date: '2026-10-16', open: 100, high: 110, low: 90, close: 101, volume: 100 },
      { date: '2026-10-16', open: 100, high: 110, low: 90, close: 101, volume: 100 },
    ],
  }, { from: '2026-09-07', to: '2026-10-17', receivedAt: observedAt });
  assert.equal(history.status, 'UNAVAILABLE');
});

test('missing credentials and denied responses never leak provider details', async () => {
  const snapshot = await readPrivateMarketDemo({
    env: { ...env, UPSTOX_ANALYTICS_TOKEN: '', PRIVATE_MARKET_DEMO_TEJHQ_ENABLED: 'true' },
    now: clock, cache: new Map(),
    fetchImpl: async () => { throw new Error('SECRET FROM NETWORK ERROR'); },
  });
  assert.equal(snapshot.quotes.code, 'UPSTOX_TOKEN_NOT_CONFIGURED');
  assert.equal(snapshot.eod.code, 'PROVIDER_NETWORK_OR_RESPONSE_ERROR');
  assert.ok(!JSON.stringify(snapshot).includes('SECRET FROM NETWORK ERROR'));
});
