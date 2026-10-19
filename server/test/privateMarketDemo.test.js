import assert from 'node:assert/strict';
import express from 'express';
import test from 'node:test';
import { errorHandler } from '../middleware/errorHandler.js';
import { createPrivateMarketDemoRouter } from '../routes/privateMarketDemo.js';
import {
  isPrivateMarketDemoConfigured,
  isPrivateMarketDemoLoopback,
  normalizePrivateBenchmarkQuotes,
  normalizePrivateTejHqEod,
  readPrivateMarketDemo,
} from '../services/marketData/privateMarketDemoService.js';
import { createPrivateMarketDataDemoCapability } from '../services/marketData/marketDataRights.js';
import { jsonRequest, withServer } from '../test-utils/httpTestUtils.js';

const env = {
  NODE_ENV: 'development',
  PRIVATE_MARKET_DEMO_ENABLED: 'true',
  MARKET_DATA_PRIVATE_DEMO_ENABLED: 'true',
  PRIVATE_MARKET_DEMO_TERMS_ACKNOWLEDGED: 'true',
  PRIVATE_MARKET_DEMO_TEJHQ_ENABLED: 'true',
  UPSTOX_ANALYTICS_TOKEN: 'fixture-token-secret',
  TEJHQ_API_KEY: 'fixture-tejhq-secret',
};
const clock = () => new Date('2026-10-19T06:00:00.000Z');
const capabilityFor = demoEnv => createPrivateMarketDataDemoCapability({
  get: () => '127.0.0.1:5000',
  socket: { remoteAddress: '127.0.0.1' },
  user: { userId: 'demo-user' },
}, demoEnv);

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

test('private demo service requires a minted authenticated loopback rights capability', async () => {
  let calls = 0;
  const snapshot = await readPrivateMarketDemo({
    env,
    fetchImpl: async () => { calls += 1; throw new Error('Provider call must be denied.'); },
    now: clock,
  });
  assert.equal(snapshot.quotes.code, 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
  assert.equal(snapshot.eod.code, 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
  assert.equal(calls, 0);
});

test('legacy private demo route passes a request-bound capability after auth and loopback checks', async () => {
  let receivedCapability = false;
  const app = express();
  app.use('/api/market-data', createPrivateMarketDemoRouter({
    env,
    limiter: (_req, _res, next) => next(),
    authenticate: (req, _res, next) => { req.user = { userId: 'demo-user' }; next(); },
    readSnapshot: async ({ privateDemoCapability }) => {
      receivedCapability = Boolean(privateDemoCapability);
      return { status: 'PRIVATE_DEVELOPMENT_ONLY', storedIn: 'NONE' };
    },
  }));
  app.use(errorHandler);
  await withServer(app, async baseUrl => {
    const { response, body } = await jsonRequest(`${baseUrl}/api/market-data/private-demo`);
    assert.equal(response.status, 200);
    assert.equal(body.storedIn, 'NONE');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  });
  assert.equal(receivedCapability, true);
});

test('private demo reads qualified Upstox quotes only and retains no provider data', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(new URL(url).protocol, 'https:');
    assert.equal(new URL(url).hostname, 'api.upstox.com');
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
    assert.fail('An unqualified TejHQ endpoint must not be requested.');
  };
  const privateDemoCapability = capabilityFor(env);
  const first = await readPrivateMarketDemo({ env, fetchImpl, now: clock, privateDemoCapability });
  assert.equal(first.status, 'PRIVATE_DEVELOPMENT_ONLY');
  assert.equal(first.quotes.status, 'AVAILABLE');
  assert.equal(first.quotes.facts[0].price, 22932.05);
  assert.equal(first.eod.status, 'UNAVAILABLE');
  assert.equal(first.eod.code, 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
  assert.equal(first.storedIn, 'NONE');
  assert.equal(first.persistentWrites, 0);
  assert.deepEqual(first.cache, { quoteHit: false, eodHit: false });
  assert.equal(calls.length, 1);
  const second = await readPrivateMarketDemo({ env, fetchImpl, now: clock, privateDemoCapability });
  assert.equal(second.cache.quoteHit, false);
  assert.equal(second.cache.eodHit, false);
  assert.deepEqual(second.quotes, first.quotes);
  assert.equal(calls.length, 2);
  assert.ok(!JSON.stringify(first).includes('fixture-token-secret'));
  assert.ok(!JSON.stringify(first).includes('fixture-tejhq-secret'));
});

test('credential rotation is isolated without caching provider responses', async () => {
  const now = clock;
  let calls = 0;
  const fetchImpl = async (_url, _options) => {
    calls++;
    return { status: 403, json: async () => ({}) };
  };
  const firstEnv = { ...env, PRIVATE_MARKET_DEMO_TEJHQ_ENABLED: 'false' };
  const secondEnv = { ...firstEnv, UPSTOX_ANALYTICS_TOKEN: 'other-secret' };
  await readPrivateMarketDemo({ env: firstEnv, fetchImpl, now, privateDemoCapability: capabilityFor(firstEnv) });
  await readPrivateMarketDemo({ env: secondEnv, fetchImpl, now, privateDemoCapability: capabilityFor(secondEnv) });
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
    now: clock,
    privateDemoCapability: capabilityFor(env),
    fetchImpl: async () => { throw new Error('SECRET FROM NETWORK ERROR'); },
  });
  assert.equal(snapshot.quotes.code, 'UPSTOX_TOKEN_NOT_CONFIGURED');
  assert.equal(snapshot.eod.code, 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
  assert.ok(!JSON.stringify(snapshot).includes('SECRET FROM NETWORK ERROR'));
});
