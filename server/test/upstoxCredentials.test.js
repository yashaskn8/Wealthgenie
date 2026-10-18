import assert from 'node:assert/strict';
import test from 'node:test';
import UpstoxHistoricalCandleProvider from '../services/marketData/UpstoxHistoricalCandleProvider.js';
import UpstoxMarketDataProvider from '../services/marketData/UpstoxMarketDataProvider.js';
import UpstoxTradingCalendarProvider from '../services/marketData/UpstoxTradingCalendarProvider.js';
import { createHealthRouter } from '../routes/health.js';
import { hasUpstoxAccessToken, resolveUpstoxAccessToken } from '../services/marketData/upstoxCredentials.js';

test('Upstox credential resolution trims each candidate before applying precedence', () => {
  assert.equal(resolveUpstoxAccessToken({
    UPSTOX_ANALYTICS_TOKEN: '  analytics-fixture-token  ',
    UPSTOX_ACCESS_TOKEN: '  access-fixture-token  ',
  }), 'analytics-fixture-token');
  assert.equal(resolveUpstoxAccessToken({
    UPSTOX_ANALYTICS_TOKEN: '   ',
    UPSTOX_ACCESS_TOKEN: '  access-fixture-token  ',
  }), 'access-fixture-token');
  assert.equal(resolveUpstoxAccessToken({
    UPSTOX_ANALYTICS_TOKEN: ' \t ',
    UPSTOX_ACCESS_TOKEN: '\n',
  }), '');
});

test('Upstox readiness reports only a nonblank resolved credential', () => {
  assert.equal(hasUpstoxAccessToken({
    UPSTOX_ANALYTICS_TOKEN: ' \t ',
    UPSTOX_ACCESS_TOKEN: ' access-fixture-token ',
  }), true);
  assert.equal(hasUpstoxAccessToken({
    UPSTOX_ANALYTICS_TOKEN: ' ',
    UPSTOX_ACCESS_TOKEN: '\t ',
  }), false);
});

test('health verification derives Upstox token presence from the trimmed fallback', { concurrency: false }, async () => {
  const names = [
    'MARKET_DATA_PRIMARY_PROVIDER',
    'UPSTOX_ANALYTICS_TOKEN',
    'UPSTOX_ACCESS_TOKEN',
    'DEMO_EXPECTED_MONGODB_DATABASE',
    'DEMO_EXPECTED_MONGODB_HOST',
    'DEMO_EXPECTED_MONGODB_PORT',
    'DEMO_EXPECTED_MONGODB_ENVIRONMENT_ID',
  ];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const readVerification = async () => {
    const router = createHealthRouter({
      isMongoConnected: () => false,
      verifyMongoTransaction: async () => false,
      verifyRedisConnection: async () => false,
    });
    const route = router.stack.find(layer => layer.route?.path === '/verification')?.route;
    assert.ok(route);
    const handler = route.stack[0].handle;
    return new Promise((resolve, reject) => {
      const response = {
        status(statusCode) { this.statusCode = statusCode; return this; },
        json(body) { resolve({ statusCode: this.statusCode, body }); return this; },
      };
      try {
        handler({ get: () => undefined }, response, reject);
      } catch (error) {
        reject(error);
      }
    });
  };

  try {
    for (const name of names.slice(3)) delete process.env[name];
    process.env.MARKET_DATA_PRIMARY_PROVIDER = 'UPSTOX';
    process.env.UPSTOX_ANALYTICS_TOKEN = '   ';
    process.env.UPSTOX_ACCESS_TOKEN = ' 	 ';
    const absent = await readVerification();
    assert.equal(absent.body.marketProviderTokenPresent, false);

    process.env.UPSTOX_ACCESS_TOKEN = ' health-fixture-token ';
    const fallback = await readVerification();
    assert.equal(fallback.body.marketProviderTokenPresent, true);
    assert.equal(fallback.body.marketProvider, 'UPSTOX');
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('quote and history adapters use the same fallback and fail closed when both credentials are blank', { concurrency: false }, () => {
  const names = ['UPSTOX_ANALYTICS_TOKEN', 'UPSTOX_ACCESS_TOKEN'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.UPSTOX_ANALYTICS_TOKEN = '   ';
    process.env.UPSTOX_ACCESS_TOKEN = '  adapter-fixture-token  ';
    const quoteProvider = new UpstoxMarketDataProvider();
    const historyProvider = new UpstoxHistoricalCandleProvider();
    assert.equal(quoteProvider.accessToken, 'adapter-fixture-token');
    assert.equal(historyProvider.accessToken, 'adapter-fixture-token');
    assert.equal(quoteProvider.isConfigured(), true);
    assert.equal(historyProvider.isConfigured(), true);

    process.env.UPSTOX_ACCESS_TOKEN = ' \t ';
    const unconfiguredQuoteProvider = new UpstoxMarketDataProvider();
    const unconfiguredHistoryProvider = new UpstoxHistoricalCandleProvider();
    assert.equal(unconfiguredQuoteProvider.isConfigured(), false);
    assert.equal(unconfiguredHistoryProvider.isConfigured(), false);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});


test('all Upstox adapters resolve credentials from the same injected server environment', () => {
  const injectedEnv = {
    NODE_ENV: 'production',
    UPSTOX_ANALYTICS_TOKEN: '  injected-analytics-only  ',
    UPSTOX_ACCESS_TOKEN: ' injected-fallback-only ',
  };
  for (const Provider of [UpstoxMarketDataProvider, UpstoxHistoricalCandleProvider, UpstoxTradingCalendarProvider]) {
    const configured = new Provider({ env: injectedEnv });
    assert.equal(configured.accessToken, 'injected-analytics-only');
    const fallback = new Provider({ env: { ...injectedEnv, UPSTOX_ANALYTICS_TOKEN: ' ' } });
    assert.equal(fallback.accessToken, 'injected-fallback-only');
    const explicitEmpty = new Provider({ env: injectedEnv, accessToken: '' });
    assert.equal(explicitEmpty.accessToken, '', 'explicit empty credentials must not silently fall back');
    const missing = new Provider({ env: { NODE_ENV: 'production' } });
    assert.equal(missing.accessToken, '', 'must never borrow credentials from unrelated process env');
  }
});
