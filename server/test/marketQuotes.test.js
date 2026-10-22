import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import test from 'node:test';
import { errorHandler } from '../middleware/errorHandler.js';
import { createUpstoxPublicDataGate } from '../middleware/upstoxPublicDataGate.js';
import { createMarketQuotesRouter } from '../routes/marketQuotes.js';
import { fetchUpstoxCanonicalQuotes } from '../services/marketDataService.js';
import { createMarketDataTestFixtureRightsCapability } from '../services/marketData/marketDataTestFixtures.js';
import { buildMarketDataCoverage } from '../scripts/generateMarketDataCoverage.js';
import {
  NSE_HISTORICAL_INDEX_RIGHTS_URL,
  NSE_TRADING_HOLIDAY_URL,
  UPSTOX_QUOTE_RIGHTS_URL,
  UPSTOX_HISTORICAL_CANDLE_V3_RIGHTS_URL,
  UPSTOX_TRADING_HOLIDAYS_URL,
  UPSTOX_NSE_MARKET_STATUS_URL,
  UPSTOX_MARKET_TIMINGS_RIGHTS_URL,
} from '../services/marketData/marketDataSourceUrls.js';
import {
  MAX_CANONICAL_UPSTOX_QUOTE_IDS,
  UPSTOX_INSTRUMENT_REGISTRY,
  resolveUpstoxProductQuoteIdentities,
  resolveUpstoxQuoteIdentities,
} from '../services/marketData/upstoxInstrumentRegistry.js';
import { jsonRequest, withServer } from '../test-utils/httpTestUtils.js';

function buildApp(router) {
  const app = express();
  app.use('/api/market-data', router);
  app.use(errorHandler);
  return app;
}

const passLimiter = (_req, _res, next) => next();
const testMarketDataEnv = { NODE_ENV: 'test' };
const testFixtureRightsCapability = createMarketDataTestFixtureRightsCapability({
  env: testMarketDataEnv,
  transport: { get: async () => ({ data: null }) },
});

test('private demo route returns only to authenticated loopback development with no-store headers', async () => {
  const env = { NODE_ENV: 'development', MARKET_DATA_PRIVATE_DEMO_ENABLED: 'true' };
  let receivedCapability = false;
  const router = createMarketQuotesRouter({
    env,
    privateDemoLimiter: passLimiter,
    verifySession: (req, _res, next) => { req.user = { userId: 'user-1' }; next(); },
    fetchPrivateDemo: async ({ privateDemoCapability, canonicalProductIds }) => {
      receivedCapability = Boolean(privateDemoCapability);
      assert.deepEqual(canonicalProductIds, ['etf:isin:INF204KB14I2']);
      return { status: 'AVAILABLE', mode: 'AUTHENTICATED_LOOPBACK_PRIVATE_DEMO', persistence: 'NOT_PERSISTED' };
    },
  });
  await withServer(buildApp(router), async baseUrl => {
    const { response, body } = await jsonRequest(
      `${baseUrl}/api/market-data/private-demo?ids=etf%3Aisin%3AINF204KB14I2`,
    );
    assert.equal(response.status, 200);
    assert.equal(body.mode, 'AUTHENTICATED_LOOPBACK_PRIVATE_DEMO');
    assert.equal(response.headers.get('cache-control'), 'no-store, private, max-age=0');
  });
  assert.equal(receivedCapability, true);
});

test('coverage matrix keeps every catalog entry without inventing live product quotes', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../data/investment_master.json', import.meta.url), 'utf8'));
  const generated = JSON.parse(fs.readFileSync(new URL('../data/market_data_coverage.json', import.meta.url), 'utf8'));
  const coverage = buildMarketDataCoverage(catalog);
  assert.equal(catalog.instruments.length, 155);
  assert.equal(coverage.totalCatalogEntries, catalog.instruments.length);
  assert.equal(generated.totalCatalogEntries, catalog.instruments.length);
  assert.equal(new Set(generated.entries.map(entry => entry.catalogId)).size, catalog.instruments.length);
  assert.equal(coverage.classificationCounts.LIVE_EXCHANGE_QUOTE || 0, 0);
  assert.equal(coverage.classificationCounts.DAILY_NAV || 0, 0);
  assert.equal(coverage.entries.find(entry => entry.catalogId === 'ppf').dataClass, 'PUBLISHED_RATE');
  assert.equal(coverage.entries.find(entry => entry.catalogId === 'futures_and_options').dataClass, 'UNSUPPORTED');
  assert.ok(coverage.providerPaths.every(path => Array.isArray(path.rightsChecks)
    && Object.hasOwn(path, 'productionUseAllowed')));
});

test('Upstox quote registry contains exact source-documented index and ETF identities', () => {
  assert.deepEqual(Object.keys(UPSTOX_INSTRUMENT_REGISTRY).sort(), [
    'etf:isin:INF204KB14I2',
    'market:index:india-vix',
    'market:index:nifty-50',
  ]);
  const [identity] = resolveUpstoxQuoteIdentities(['market:index:nifty-50']);
  assert.equal(identity.upstoxInstrumentKey, 'NSE_INDEX|Nifty 50');
  assert.equal(identity.unit, 'INDEX_POINTS');
  assert.equal(identity.isin, null);
  assert.equal(identity.providerAccessStatus, 'NOT_LIVE_VERIFIED');
  const [etf] = resolveUpstoxQuoteIdentities(['etf:isin:INF204KB14I2']);
  assert.equal(etf.upstoxInstrumentKey, 'NSE_EQ|INF204KB14I2');
  assert.equal(etf.unit, 'PRICE');
  assert.equal(etf.isin, 'INF204KB14I2');
  assert.equal(etf.dataClass, 'LIVE_EXCHANGE_QUOTE_OBSERVATION');
  assert.deepEqual(
    resolveUpstoxProductQuoteIdentities(['etf:isin:INF204KB14I2']).map(item => item.canonicalProductId),
    ['etf:isin:INF204KB14I2'],
  );
  assert.throws(
    () => resolveUpstoxProductQuoteIdentities(['market:index:nifty-50']),
    error => error.code === 'UNSUPPORTED_MARKET_INSTRUMENT',
  );
});

test('canonical resolver deduplicates request IDs and rejects unknown or oversized requests', () => {
  assert.equal(resolveUpstoxQuoteIdentities([
    'market:index:nifty-50',
    'market:index:nifty-50',
  ]).length, 1);
  assert.throws(
    () => resolveUpstoxQuoteIdentities(['market:index:unsupported']),
    error => error.code === 'UNSUPPORTED_MARKET_INSTRUMENT',
  );
  assert.throws(
    () => resolveUpstoxQuoteIdentities(Array.from(
      { length: MAX_CANONICAL_UPSTOX_QUOTE_IDS + 1 },
      (_, index) => `market:index:unsupported-${index}`,
    )),
    RangeError,
  );
});

test('canonical quote route calls only the injected allowlisted service and returns its DTO', async () => {
  const calls = [];
  const router = createMarketQuotesRouter({
    env: testMarketDataEnv,
    marketDataTestFixtureRightsCapability: testFixtureRightsCapability,
    limiter: passLimiter,
    fetchQuotes: async ids => {
      calls.push(ids);
      return { provider: 'UPSTOX', status: 'UNAVAILABLE', facts: [] };
    },
  });
  await withServer(buildApp(router), async baseUrl => {
    const { response, body } = await jsonRequest(
      `${baseUrl}/api/market-data/quotes?ids=market:index:nifty-50,market:index:india-vix`,
    );
    assert.equal(response.status, 200);
    assert.equal(body.provider, 'UPSTOX');
    assert.deepEqual(calls, [[
      'market:index:nifty-50',
      'market:index:india-vix',
    ]]);
  });
});

test('canonical quote route rejects raw provider keys, unknown IDs, and oversized ID lists before fetching', async () => {
  let calls = 0;
  const router = createMarketQuotesRouter({
    env: testMarketDataEnv,
    marketDataTestFixtureRightsCapability: testFixtureRightsCapability,
    limiter: passLimiter,
    fetchQuotes: async () => { calls += 1; return {}; },
  });
  await withServer(buildApp(router), async baseUrl => {
    for (const ids of [
      'NSE_INDEX|Nifty 50',
      'market:index:unknown',
      Array.from({ length: MAX_CANONICAL_UPSTOX_QUOTE_IDS + 1 }, (_, index) => `market:index:unsupported-${index}`).join(','),
    ]) {
      const { response } = await jsonRequest(`${baseUrl}/api/market-data/quotes?ids=${encodeURIComponent(ids)}`);
      assert.equal(response.status, 400);
    }
  });
  assert.equal(calls, 0);
});

test('private demo route requires a signed-in session and does not call providers unauthenticated', async () => {
  let calls = 0;
  const router = createMarketQuotesRouter({
    env: { NODE_ENV: 'development', MARKET_DATA_PRIVATE_DEMO_ENABLED: 'true' },
    privateDemoLimiter: passLimiter,
    fetchPrivateDemo: async () => { calls += 1; return {}; },
  });
  await withServer(buildApp(router), async baseUrl => {
    const { response, body } = await jsonRequest(`${baseUrl}/api/market-data/private-demo`);
    assert.equal(response.status, 401);
    assert.equal(body.code, 'AUTH_REQUIRED');
  });
  assert.equal(calls, 0);
});

test('persisted quote route requires authentication before reading stored observations', async () => {
  let reads = 0;
  const router = createMarketQuotesRouter({
    env: testMarketDataEnv,
    limiter: passLimiter,
    readStoredQuotes: async () => { reads += 1; return {}; },
  });
  await withServer(buildApp(router), async baseUrl => {
    const { response, body } = await jsonRequest(`${baseUrl}/api/market-data/quotes/persisted`);
    assert.equal(response.status, 401);
    assert.equal(body.code, 'AUTH_REQUIRED');
  });
  assert.equal(reads, 0);
});

test('persisted quote route is read-only, private, and rejects query parameters', async () => {
  let reads = 0;
  const router = createMarketQuotesRouter({
    env: testMarketDataEnv,
    limiter: passLimiter,
    verifySession: (req, _res, next) => { req.user = { userId: 'user-1' }; next(); },
    readStoredQuotes: async () => {
      reads += 1;
      return { status: 'UNAVAILABLE', facts: [], persistence: 'STORED_READ_ONLY' };
    },
  });
  await withServer(buildApp(router), async baseUrl => {
    const { response, body } = await jsonRequest(`${baseUrl}/api/market-data/quotes/persisted`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(body.persistence, 'STORED_READ_ONLY');
    const invalid = await jsonRequest(`${baseUrl}/api/market-data/quotes/persisted?ids=market:index:nifty-50`);
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.body.code, 'INVALID_STORED_MARKET_QUOTE_REQUEST');
  });
  assert.equal(reads, 1);
});

test('private demo rejects non-local browser origins and CI without invoking a provider', async () => {
  let providerCalls = 0;
  const env = { NODE_ENV: 'development', MARKET_DATA_PRIVATE_DEMO_ENABLED: 'true' };
  const createRouter = configuredEnv => createMarketQuotesRouter({
    env: configuredEnv,
    privateDemoLimiter: passLimiter,
    verifySession: (req, _res, next) => { req.user = { userId: 'user-1' }; next(); },
    fetchPrivateDemo: async () => {
      providerCalls += 1;
      return { status: 'UNAVAILABLE', persistence: 'NOT_PERSISTED' };
    },
  });
  await withServer(buildApp(createRouter(env)), async baseUrl => {
    const url = `${baseUrl}/api/market-data/private-demo?ids=etf%3Aisin%3AINF204KB14I2`;
    for (const origin of ['https://evil.example', 'null', 'http://localhost:5173/path']) {
      const { response, body } = await jsonRequest(url, { headers: { origin } });
      assert.equal(response.status, 404);
      assert.equal(body.code, 'PRIVATE_MARKET_DEMO_UNAVAILABLE');
    }
    const { response } = await jsonRequest(url, { headers: { origin: 'http://localhost:5173' } });
    assert.equal(response.status, 200);
  });
  assert.equal(providerCalls, 1);
  for (const flag of ['CI', 'GITHUB_ACTIONS']) {
    await withServer(buildApp(createRouter({ ...env, [flag]: 'true' })), async baseUrl => {
      const { response, body } = await jsonRequest(
        `${baseUrl}/api/market-data/private-demo?ids=etf%3Aisin%3AINF204KB14I2`,
      );
      assert.equal(response.status, 404);
      assert.equal(body.code, 'PRIVATE_MARKET_DEMO_UNAVAILABLE');
    });
  }
  assert.equal(providerCalls, 1);
});

test('private demo rejects index IDs and empty or unknown product mappings before provider access', async () => {
  let providerCalls = 0;
  const router = createMarketQuotesRouter({
    env: { NODE_ENV: 'development', MARKET_DATA_PRIVATE_DEMO_ENABLED: 'true' },
    privateDemoLimiter: passLimiter,
    verifySession: (req, _res, next) => { req.user = { userId: 'user-1' }; next(); },
    fetchPrivateDemo: async () => { providerCalls += 1; return {}; },
  });
  await withServer(buildApp(router), async baseUrl => {
    for (const ids of ['', 'market:index:nifty-50', 'etf:isin:unknown']) {
      const query = ids ? `?ids=${encodeURIComponent(ids)}` : '';
      const { response } = await jsonRequest(
        `${baseUrl}/api/market-data/private-demo${query}`,
        { headers: { origin: 'http://localhost:5173' } },
      );
      assert.equal(response.status, 400);
    }
  });
  assert.equal(providerCalls, 0);
});

test('production Upstox-derived public output remains disabled without explicit distribution clearance', async () => {
  const gate = createUpstoxPublicDataGate({
    requiresUpstox: true,
    env: { NODE_ENV: 'production', MARKET_DATA_PRIMARY_PROVIDER: 'UPSTOX' },
  });
  const router = createMarketQuotesRouter({
    env: { NODE_ENV: 'production', MARKET_DATA_PRIMARY_PROVIDER: 'UPSTOX' },
    limiter: passLimiter,
    fetchQuotes: async () => assert.fail('The distribution gate must run before quote retrieval.'),
  });
  assert.equal(typeof gate, 'function');
  await withServer(buildApp(router), async baseUrl => {
    const { response, body } = await jsonRequest(
      `${baseUrl}/api/market-data/quotes?ids=market:index:nifty-50`,
    );
    assert.equal(response.status, 503);
    assert.equal(body.code, 'UPSTOX_PUBLIC_DISTRIBUTION_DISABLED');
  });
});

test('production distribution flag cannot bypass unverified source rights at the route boundary', async () => {
  const router = createMarketQuotesRouter({
    env: {
      NODE_ENV: 'production',
      MARKET_DATA_PRIMARY_PROVIDER: 'UPSTOX',
      UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED: 'true',
    },
    limiter: passLimiter,
    fetchQuotes: async () => assert.fail('Unverified market-data rights must stop before the service is called.'),
  });
  await withServer(buildApp(router), async baseUrl => {
    const { response, body } = await jsonRequest(
      `${baseUrl}/api/market-data/quotes?ids=market:index:nifty-50`,
    );
    assert.equal(response.status, 503);
    assert.equal(body.code, 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
  });
});

test('production Upstox middleware stops after operator confirmation when exact source rights are unverified', () => {
  let nextCalls = 0;
  let statusCode = null;
  let body = null;
  const gate = createUpstoxPublicDataGate({
    requiresUpstox: true,
    env: {
      NODE_ENV: 'production',
      UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED: 'true',
    },
    marketDataTestFixtureRightsCapability: testFixtureRightsCapability,
  });
  gate({}, {
    status(code) { statusCode = code; return this; },
    json(value) { body = value; return this; },
  }, () => { nextCalls += 1; });

  assert.equal(statusCode, 503);
  assert.equal(body.code, 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
  assert.equal(nextCalls, 0);
});

test('canonical quote service preserves rights-blocked state when no qualified source is registered', async () => {
  const snapshot = await fetchUpstoxCanonicalQuotes(['market:index:nifty-50']);
  assert.equal(snapshot.provider, 'UPSTOX');
  assert.equal(snapshot.status, 'UNAVAILABLE');
  assert.equal(snapshot.error.code, 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
  assert.equal(snapshot.facts.length, 1);
  assert.equal(snapshot.facts[0].value, null);
  assert.equal(snapshot.facts[0].unit, 'INDEX_POINTS');
  assert.equal(snapshot.facts[0].availabilityStatus, 'UNAVAILABLE');
  assert.equal(snapshot.facts[0].reasonCode, 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
  assert.equal(snapshot.facts[0].sourceVerification.providerAccessStatus, 'NOT_LIVE_VERIFIED');
});
