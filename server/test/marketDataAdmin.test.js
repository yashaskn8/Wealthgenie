import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import test from 'node:test';
import { errorHandler } from '../middleware/errorHandler.js';
import { requireRole, verifyJWT } from '../middleware/authMiddleware.js';
import { createMarketDataAdminRouter } from '../routes/marketDataAdmin.js';
import { fetchQualifiedEquityHistory as fetchQualifiedEquityHistoryWithRights } from '../services/marketDataService.js';
import { MARKET_DATA_SCHEMA_VERSION, PROVIDERS } from '../services/marketData/contracts.js';
import { createMarketDataTestFixtureRightsCapability } from '../services/marketData/marketDataTestFixtures.js';
import { NSE_TRADING_HOLIDAY_URL } from '../services/marketData/nseTradingCalendar.js';
import { jsonRequest, withServer } from '../test-utils/httpTestUtils.js';

const passLimiter = (_req, _res, next) => next();
const secret = 'market-data-admin-test-secret-at-least-32-characters';
const adminUserId = '64a000000000000000000001';
const ordinaryUserId = '64a000000000000000000002';
const validQuery = 'exchange=NSE&symbol=RELIANCE&isin=INE002A01018&fromDate=2026-10-08&toDate=2026-10-09';
const testMarketDataEnv = { NODE_ENV: 'test' };
const testFixtureRightsCapability = createMarketDataTestFixtureRightsCapability({
  env: testMarketDataEnv,
  transport: { get: async () => ({ data: null }) },
});

function fetchQualifiedEquityHistory(request, options = {}) {
  return fetchQualifiedEquityHistoryWithRights(request, {
    ...options,
    env: options.env || testMarketDataEnv,
    marketDataTestFixtureRightsCapability: testFixtureRightsCapability,
  });
}

function buildApp(router) {
  const app = express();
  app.use('/api/market-data', router);
  app.use(errorHandler);
  return app;
}

function token(userId, role) {
  return jwt.sign({ userId, role }, secret, { expiresIn: '5m' });
}

test('equity-history admin route authenticates, authorizes, and validates before fetching', async () => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = secret;
  const calls = [];
  const router = createMarketDataAdminRouter({
    authenticate: (req, res, next) => verifyJWT(req, res, next, {
      getCurrentUser: async userId => ({ role: userId === adminUserId ? 'admin' : 'user' }),
      isDatabaseReady: () => true,
    }),
    limiter: passLimiter,
    authorizeAdmin: requireRole('admin', {
      findCurrentRole: async userId => userId === adminUserId ? 'admin' : 'user',
    }),
    fetchHistory: async query => {
      calls.push(query);
      return { status: 'UNAVAILABLE', candles: [] };
    },
  });
  try {
    await withServer(buildApp(router), async baseUrl => {
      const url = `${baseUrl}/api/market-data/admin/equity-history?${validQuery}`;
      assert.equal((await jsonRequest(url)).response.status, 401);
      assert.equal((await jsonRequest(url, {
        headers: { Authorization: `Bearer ${token(ordinaryUserId, 'user')}` },
      })).response.status, 403);
      assert.equal(calls.length, 0);
      const headers = { Authorization: `Bearer ${token(adminUserId, 'admin')}` };
      assert.equal((await jsonRequest(url.replace('2026-10-08', '2026-02-30'), { headers })).response.status, 400);
      assert.equal((await jsonRequest(`${url}&basis=ADJUSTED`, { headers })).response.status, 400);
      assert.equal(calls.length, 0);
      const result = await jsonRequest(url, { headers });
      assert.equal(result.response.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].basis, 'RAW');
    });
  } finally {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});

test('production equity-history rights denial prevents Upstox calls and data output', async () => {
  let providerCalls = 0;
  const result = await fetchQualifiedEquityHistoryWithRights({
    exchange: 'NSE', symbol: 'RELIANCE', isin: 'INE002A01018',
    fromDate: '2026-10-08', toDate: '2026-10-09',
  }, {
    env: { NODE_ENV: 'production', UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED: 'false' },
    marketDataTestFixtureRightsCapability: testFixtureRightsCapability,
    upstoxProvider: { getDailyCandles: async () => { providerCalls += 1; return { status: 'AVAILABLE' }; } },
  });
  assert.equal(providerCalls, 0);
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.provider, null);
  assert.deepEqual(result.candles, []);
  assert.equal(result.selection.reasonCode, 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
});

test('Upstox NSE history requires exact qualified calendar coverage', async () => {
  const request = {
    exchange: 'NSE', symbol: 'RELIANCE', isin: 'INE002A01018',
    fromDate: '2026-10-08', toDate: '2026-10-09',
  };
  const primary = {
    status: 'AVAILABLE', provider: 'UPSTOX', instrumentKey: 'NSE_EQ|INE002A01018',
    source: { provider: 'UPSTOX', url: 'https://api.upstox.com/v3/historical-candle/NSE_EQ%7CINE002A01018/days/1/2026-10-09/2026-10-08' },
    candles: [
      { timestamp: '2026-10-08T10:00:00.000Z', open: 100, high: 110, low: 99, close: 105, volume: 100 },
      { timestamp: '2026-10-09T10:00:00.000Z', open: 105, high: 112, low: 104, close: 111, volume: 120 },
    ],
  };
  const calendar = {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION, provider: PROVIDERS.NSE,
    status: 'AVAILABLE', fetchedAt: new Date().toISOString(), dates: ['2026-01-01'],
    source: { provider: PROVIDERS.NSE, url: NSE_TRADING_HOLIDAY_URL },
  };
  const options = {
    upstoxProvider: { getDailyCandles: async () => primary },
    nseCalendarProvider: { holidayLoader: async () => calendar },
  };
  const exact = await fetchQualifiedEquityHistory(request, options);
  assert.equal(exact.status, 'AVAILABLE');
  assert.equal(exact.provider, PROVIDERS.UPSTOX);
  assert.equal(exact.priceBasis, 'UPSTOX_PROVIDER_NATIVE');
  assert.equal(exact.coverage.expectedSessionCount, 2);
  assert.equal(exact.instrumentIdentity.symbolBindingStatus, 'UNVERIFIED');
  const missingDay = await fetchQualifiedEquityHistory(request, {
    ...options,
    upstoxProvider: { getDailyCandles: async () => ({ ...primary, candles: primary.candles.slice(0, 1) }) },
  });
  assert.equal(missingDay.status, 'UNAVAILABLE');
  assert.deepEqual(missingDay.candles, []);
  assert.equal(missingDay.selection.primaryFailureCode, 'UPSTOX_HISTORY_SESSION_COVERAGE_INCOMPLETE');
});

test('BSE Upstox history fails closed until a qualified BSE session calendar exists', async () => {
  const result = await fetchQualifiedEquityHistory({
    exchange: 'BSE', symbol: 'RELIANCE', isin: 'INE002A01018',
    fromDate: '2026-10-08', toDate: '2026-10-09',
  }, {
    upstoxProvider: { getDailyCandles: async () => ({
      status: 'AVAILABLE', provider: 'UPSTOX', instrumentKey: 'BSE_EQ|INE002A01018',
      candles: [{ timestamp: '2026-10-08T10:00:00.000Z', open: 100, high: 110, low: 99, close: 105, volume: 100 }],
    }) },
  });
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.provider, null);
  assert.equal(result.selection.primaryFailureCode, 'BSE_TRADING_CALENDAR_NOT_QUALIFIED');
  assert.deepEqual(result.candles, []);
});
