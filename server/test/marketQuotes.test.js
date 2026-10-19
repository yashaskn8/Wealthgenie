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

test('Upstox quote registry contains only exact, source-documented index identities', () => {
  assert.deepEqual(Object.keys(UPSTOX_INSTRUMENT_REGISTRY).sort(), [
    'market:index:india-vix',
    'market:index:nifty-50',
  ]);
  const [identity] = resolveUpstoxQuoteIdentities(['market:index:nifty-50']);
  assert.equal(identity.upstoxInstrumentKey, 'NSE_INDEX|Nifty 50');
  assert.equal(identity.unit, 'INDEX_POINTS');
  assert.equal(identity.isin, null);
  assert.equal(identity.providerAccessStatus, 'NOT_LIVE_VERIFIED');
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

test('private demo route returns only for authenticated loopback development and marks response no-store', async () => {
  const env = {
    NODE_ENV: 'development',
    MARKET_DATA_PRIVATE_DEMO_ENABLED: 'true',
    TEJHQ_PRIVATE_DEMO_ENABLED: 'true',
  };
  let receivedCapability = false;
  const router = createMarketQuotesRouter({
    env,
    privateDemoLimiter: passLimiter,
    verifySession: (req, _res, next) => { req.user = { userId: 'user-1' }; next(); },
    fetchPrivateDemo: async ({ privateDemoCapability }) => {
      receivedCapability = Boolean(privateDemoCapability);
      return { status: 'AVAILABLE', mode: 'AUTHENTICATED_LOOPBACK_PRIVATE_DEMO', persistence: 'NOT_PERSISTED' };
    },
  });
  await withServer(buildApp(router), async baseUrl => {
    const { response, body } = await jsonRequest(`${baseUrl}/api/market-data/private-demo`);
    assert.equal(response.status, 200);
    assert.equal(body.mode, 'AUTHENTICATED_LOOPBACK_PRIVATE_DEMO');
    assert.equal(response.headers.get('cache-control'), 'no-store, private, max-age=0');
  });
  assert.equal(receivedCapability, true);
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

test('coverage matrix accounts for all catalog entries without treating parent categories as live quotes', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../data/investment_master.json', import.meta.url), 'utf8'));
  const generatedFile = JSON.parse(fs.readFileSync(new URL('../data/market_data_coverage.json', import.meta.url), 'utf8'));
  const coverage = buildMarketDataCoverage(catalog);
  const generatedIds = new Set(generatedFile.entries.map(entry => entry.catalogId));

  assert.equal(catalog.instruments.length, 155);
  assert.equal(generatedFile.schemaVersion, coverage.schemaVersion);
  assert.equal(coverage.totalCatalogEntries, 155);
  assert.equal(generatedFile.totalCatalogEntries, 155);
  assert.equal(generatedIds.size, 155);
  assert.ok(catalog.instruments.every(instrument => generatedIds.has(instrument.id)));
  assert.equal(coverage.classificationCounts.LIVE_EXCHANGE_QUOTE || 0, 0);
  assert.equal(coverage.classificationCounts.DAILY_NAV || 0, 0);
  assert.equal(coverage.entries.find(entry => entry.catalogId === 'ppf').dataClass, 'PUBLISHED_RATE');
  assert.equal(coverage.entries.find(entry => entry.catalogId === 'rbi_bonds').dataClass, 'AUCTION_OR_BOND_TERMS');
  assert.equal(coverage.entries.find(entry => entry.catalogId === 'futures_and_options').dataClass, 'UNSUPPORTED');
  assert.equal(coverage.entries.find(entry => entry.catalogId === 'index_mf').dataClass, 'EDUCATIONAL_ONLY');
  assert.ok(coverage.entries.every(entry => entry.tejHqIdentityCoverage === false));
  assert.equal(generatedFile.providerPaths.length, coverage.providerPaths.length);
  assert.ok(coverage.providerPaths.every(path => path.implementedConsumers
    && Array.isArray(path.rightsChecks)
    && Object.hasOwn(path, 'productionUseAllowed')
    && Array.isArray(path.validConsumers.api)));
  const nsePath = coverage.providerPaths.find(path => path.pathId === 'nse.market-context-pair');
  const nseQuotesPath = coverage.providerPaths.find(path => path.pathId === 'nse.index-quotes');
  const nseHistoryPath = coverage.providerPaths.find(path => path.pathId === 'nse.index-history');
  const amfiPath = coverage.providerPaths.find(path => path.pathId === 'amfi.mutual-fund-nav-and-history');
  const upstoxPath = coverage.providerPaths.find(path => path.pathId === 'upstox.market-context-pair');
  const upstoxQuotesPath = coverage.providerPaths.find(path => path.pathId === 'upstox.index-quotes');
  const upstoxEquityHistoryPath = coverage.providerPaths.find(path => path.pathId === 'upstox.nse-equity-history');
  const tejHqHistoryPath = coverage.providerPaths.find(path => path.pathId === 'tejhq.nse-equity-history-fallback');
  const tejHqAdjustedHistoryPath = coverage.providerPaths.find(path => path.pathId === 'tejhq.adjusted-equity-history');
  const tejHqCorporateActionsPath = coverage.providerPaths.find(path => path.pathId === 'tejhq.corporate-actions');
  assert.equal(nsePath.authorizedUseStatus, 'LICENSE_UNVERIFIED');
  assert.equal(nsePath.productionUseAllowed, false);
  assert.deepEqual(nsePath.validConsumers.api, []);
  assert.ok(nsePath.rightsChecks.some(check => check.url === NSE_TRADING_HOLIDAY_URL));
  assert.ok(nsePath.implementedConsumers.api.some(consumer => consumer.method === 'POST' && consumer.path === '/api/market/refresh'));
  const nseQualification = nsePath.implementedConsumers.operatorScripts.find(consumer => consumer.command === 'npm run qualify:nse --prefix server');
  assert.deepEqual(nseQualification.requiredGates, [
    'Exact source rights for every endpoint and the intended-use scope.',
    'MARKET_DATA_QUALIFICATION_LIVE_ENABLED=true.',
  ]);
  assert.equal(Object.hasOwn(nsePath.validConsumers, 'operatorScripts'), false);
  assert.ok(!nsePath.implementedConsumers.api.some(consumer => consumer.path === '/api/market/benchmarks'));
  assert.ok(!nsePath.implementedConsumers.api.some(consumer => consumer.path === '/api/market-data/quotes'));
  assert.ok(nseQuotesPath.implementedConsumers.api.some(consumer => consumer.path === '/api/market/benchmarks'));
  assert.ok(nseQuotesPath.implementedConsumers.api.some(consumer => consumer.path === '/api/market/rates'));
  assert.ok(nseQuotesPath.rightsChecks.some(check => check.url === NSE_TRADING_HOLIDAY_URL));
  assert.equal(Object.hasOwn(nseQuotesPath.implementedConsumers, 'operatorScripts'), false);
  assert.deepEqual(nseQuotesPath.validConsumers.api, []);
  assert.ok(nseHistoryPath.rightsChecks.some(check => check.url === NSE_HISTORICAL_INDEX_RIGHTS_URL));
  assert.ok(nseHistoryPath.rightsChecks.some(check => check.url === NSE_TRADING_HOLIDAY_URL));
  assert.ok(nseHistoryPath.implementedConsumers.operatorScripts.some(consumer => consumer.command.startsWith('npm run export:market-regime-data')));
  assert.deepEqual(nseHistoryPath.validConsumers.api, []);
  assert.equal(amfiPath.authorizedUseStatus, 'BLOCKED_REUSE_RIGHTS');
  assert.equal(amfiPath.productionUseAllowed, false);
  assert.ok(amfiPath.implementedConsumers.api.some(consumer => consumer.method === 'POST' && consumer.path === '/api/market/refresh'));
  assert.equal(amfiPath.rightsChecks.length, 2);
  assert.equal(upstoxPath.authorizedUseStatus, 'DEVELOPMENT_RESEARCH_ONLY');
  assert.equal(upstoxPath.productionUseAllowed, false);
  assert.equal(upstoxPath.availability, 'UNAVAILABLE_SOURCE_RIGHTS');
  assert.deepEqual(upstoxPath.validConsumers.api, []);
  assert.ok(upstoxPath.implementedConsumers.api.some(consumer => consumer.method === 'POST' && consumer.path === '/api/market/refresh'));
  assert.ok(!upstoxPath.implementedConsumers.api.some(consumer => ['/api/market/benchmarks', '/api/market-data/quotes'].includes(consumer.path)));
  assert.deepEqual(upstoxPath.exactIdentity.providerKeys.sort(), ['NSE_INDEX|India VIX', 'NSE_INDEX|Nifty 50']);
  assert.equal(upstoxPath.providerAccessStatus, 'NOT_LIVE_VERIFIED');
  assert.match(upstoxPath.freshnessSemantics, /does not apply the NSE expected-session coverage check/i);
  assert.match(upstoxPath.authorizationGate, /operator gate.*cannot grant rights/i);
  assert.deepEqual(upstoxQuotesPath.rightsChecks.map(check => check.url), [UPSTOX_QUOTE_RIGHTS_URL]);
  assert.ok(upstoxQuotesPath.implementedConsumers.api.some(consumer => consumer.path === '/api/market/benchmarks'));
  assert.ok(upstoxQuotesPath.implementedConsumers.api.some(consumer => consumer.path === '/api/market-data/quotes'));
  assert.ok(!upstoxQuotesPath.rightsChecks.some(check => check.url.includes('historical-candle')));
  assert.deepEqual(upstoxQuotesPath.validConsumers.api, []);
  assert.ok(upstoxEquityHistoryPath.rightsChecks.some(check => check.url === NSE_TRADING_HOLIDAY_URL));
  assert.ok(upstoxEquityHistoryPath.rightsChecks.some(check => check.url.includes('/v3/historical-candle/{instrumentKey}')));
  for (const historyPath of [tejHqHistoryPath, tejHqAdjustedHistoryPath]) {
    const endpointUrls = historyPath.rightsChecks.map(check => check.url);
    assert.ok(endpointUrls.some(url => url.includes('/v1/symbols/nse?isin={isin}')));
    assert.ok(endpointUrls.some(url => url.endsWith('/v1/status')));
    assert.ok(endpointUrls.some(url => url === NSE_TRADING_HOLIDAY_URL));
    assert.deepEqual(historyPath.validConsumers.api, []);
  }
  assert.ok(tejHqHistoryPath.rightsChecks.some(check => check.url.includes('/v1/ohlcv/nse/{symbol}?from={fromDate}&to={toDate}')));
  assert.ok(tejHqAdjustedHistoryPath.rightsChecks.some(check => check.url.includes('/v1/adjusted/nse/{symbol}?from={fromDate}&to={toDate}')));
  assert.ok(tejHqCorporateActionsPath.rightsChecks.some(check => check.url.endsWith('/v1/actions/{symbol}')));
  assert.ok(tejHqCorporateActionsPath.rightsChecks.some(check => check.url.endsWith('/v1/symbols/{exchange}?isin={isin}')));
  assert.ok(!tejHqCorporateActionsPath.rightsChecks.some(check => check.url.endsWith('/v1/actions/symbol')));
  assert.deepEqual(tejHqCorporateActionsPath.validConsumers.api, []);
  const selectedPaths = coverage.providerPaths.filter(path => path.marketMode === 'UPSTOX_TEJHQ');
  assert.equal(selectedPaths.length, 4);
  assert.ok(selectedPaths.every(path => path.rightsChecks.every(check => check.provider !== 'NSE')));
  const selectedContext = selectedPaths.find(path => path.pathId === 'two-provider.upstox-market-context');
  assert.deepEqual(selectedContext.rightsChecks.map(check => check.url), [
    UPSTOX_QUOTE_RIGHTS_URL,
    UPSTOX_HISTORICAL_CANDLE_V3_RIGHTS_URL,
    UPSTOX_TRADING_HOLIDAYS_URL,
    UPSTOX_NSE_MARKET_STATUS_URL,
    UPSTOX_MARKET_TIMINGS_RIGHTS_URL,
  ]);
  assert.ok(selectedPaths.every(path => path.productionUseAllowed === false));
  for (const pathId of [
    'two-provider.upstox-market-context',
    'two-provider.upstox-equity-history',
    'two-provider.tejhq-raw-eod',
    'two-provider.tejhq-adjusted-eod',
    'nse.market-context-pair',
    'nse.index-quotes',
    'nse.index-history',
    'upstox.market-context-pair',
    'upstox.index-quotes',
    'upstox.nse-equity-history',
    'tejhq.nse-equity-history-fallback',
    'tejhq.adjusted-equity-history',
    'tejhq.corporate-actions',
    'amfi.mutual-fund-nav-and-history',
    'india-post.small-savings-rates',
    'sbi.retail-domestic-term-deposit-rates',
    'rbi.floating-rate-savings-bond',
  ]) {
    const generatedPath = generatedFile.providerPaths.find(path => path.pathId === pathId);
    const currentPath = coverage.providerPaths.find(path => path.pathId === pathId);
    assert.deepEqual(generatedPath.rightsChecks, currentPath.rightsChecks, `${pathId} rights endpoints are current in the saved report`);
    assert.deepEqual(generatedPath.implementedConsumers, currentPath.implementedConsumers, `${pathId} consumers are current in the saved report`);
    assert.deepEqual(generatedPath.validConsumers, currentPath.validConsumers, `${pathId} authorization result is current in the saved report`);
  }
  const indiaPostPath = coverage.providerPaths.find(path => path.pathId === 'india-post.small-savings-rates');
  assert.ok(indiaPostPath.rightsChecks.some(check => check.url === 'https://www.indiapost.gov.in/_next/static/chunks/{chunk}'));
  assert.equal(indiaPostPath.rightsChecks.length, 2);
  for (const providerPath of coverage.providerPaths.filter(path => ['UPSTOX', 'TEJHQ'].includes(path.provider))) {
    assert.equal(providerPath.productionUseAllowed, false);
    assert.equal(providerPath.availability, 'UNAVAILABLE_SOURCE_RIGHTS');
    assert.deepEqual(providerPath.validConsumers.api, []);
  }
  for (const pathId of [
    'amfi.mutual-fund-nav-and-history',
    'india-post.small-savings-rates',
    'sbi.retail-domestic-term-deposit-rates',
  ]) {
    const providerPath = coverage.providerPaths.find(path => path.pathId === pathId);
    assert.ok(providerPath.implementedConsumers.api.some(consumer => consumer.path === '/api/instruments/rank-wti'));
    assert.ok(providerPath.validConsumers.api.every(consumer => consumer.path !== '/api/instruments/rank-wti'));
  }
  for (const pathId of [
    'india-post.small-savings-rates',
    'sbi.retail-domestic-term-deposit-rates',
    'rbi.floating-rate-savings-bond',
  ]) {
    const providerPath = coverage.providerPaths.find(path => path.pathId === pathId);
    if (pathId !== 'rbi.floating-rate-savings-bond') {
      assert.ok(providerPath.implementedConsumers.api.some(consumer => consumer.method === 'POST' && consumer.path === '/api/market/refresh'));
    }
    const qualification = providerPath.implementedConsumers.operatorScripts.find(consumer => consumer.command === 'npm run qualify:fixed-income --prefix server');
    assert.ok(qualification);
    assert.ok(qualification.requiredGates.includes('MARKET_DATA_QUALIFICATION_LIVE_ENABLED=true.'));
    assert.equal(Object.hasOwn(providerPath.validConsumers, 'operatorScripts'), false);
  }
  for (const catalogId of ['ppf', 'scss', 'sukanya', 'nsc', 'kvp', 'pomis', 'po_rd', 'po_td_1yr']) {
    const entry = coverage.entries.find(item => item.catalogId === catalogId);
    assert.equal(entry.authorizedUseStatus, 'BLOCKED_REUSE_RIGHTS');
    assert.equal(entry.productionUseAllowed, false);
    assert.equal(entry.rightsChecks.length, 2);
    assert.ok(entry.rightsChecks.some(check => check.url === 'https://www.indiapost.gov.in/_next/static/chunks/{chunk}'));
    assert.deepEqual(entry.validConsumers, []);
  }
});
