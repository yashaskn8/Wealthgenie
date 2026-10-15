import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import test from 'node:test';
import { errorHandler } from '../middleware/errorHandler.js';
import { requireRole, verifyJWT } from '../middleware/authMiddleware.js';
import { createMarketDataAdminRouter } from '../routes/marketDataAdmin.js';
import { fetchQualifiedEquityHistory } from '../services/marketDataService.js';
import { MARKET_DATA_SCHEMA_VERSION, PROVIDERS } from '../services/marketData/contracts.js';
import { NSE_TRADING_HOLIDAY_URL } from '../services/marketData/nseTradingCalendar.js';
import { jsonRequest, withServer } from '../test-utils/httpTestUtils.js';

const passLimiter = (_req, _res, next) => next();
const secret = 'market-data-admin-test-secret-at-least-32-characters';
const adminUserId = '64a000000000000000000001';
const ordinaryUserId = '64a000000000000000000002';
const validQuery = 'exchange=NSE&symbol=RELIANCE&isin=INE002A01018&fromDate=2026-10-08&toDate=2026-10-09';

function buildApp(router) {
  const app = express();
  app.use('/api/market-data', router);
  app.use(errorHandler);
  return app;
}

function token(userId, role) {
  return jwt.sign({ userId, role }, secret, { expiresIn: '5m' });
}

test('admin market-data routes authenticate, enforce current admin role, and validate before service access', async () => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = secret;
  const calls = [];
  const router = createMarketDataAdminRouter({
    authenticate: (req, res, next) => verifyJWT(req, res, next, {
      getCurrentUser: async userId => userId === adminUserId ? { role: 'admin' } : { role: 'user' },
      isDatabaseReady: () => true,
    }),
    limiter: passLimiter,
    authorizeAdmin: requireRole('admin', {
      findCurrentRole: async userId => userId === adminUserId ? 'admin' : 'user',
    }),
    fetchHistory: async query => { calls.push(['history', query]); return { status: 'UNAVAILABLE', candles: [] }; },
    fetchActions: async query => { calls.push(['actions', query]); return { status: 'AVAILABLE', events: [], completeness: 'NOT_CONCLUSIVE' }; },
    fetchStatus: async () => { calls.push(['status']); return { provider: 'TEJHQ', status: 'AVAILABLE' }; },
  });

  try {
    await withServer(buildApp(router), async baseUrl => {
      const unauthenticated = await jsonRequest(`${baseUrl}/api/market-data/admin/tejhq/status`);
      assert.equal(unauthenticated.response.status, 401);

      const userHeaders = { Authorization: `Bearer ${token(ordinaryUserId, 'user')}` };
      const forbidden = await jsonRequest(`${baseUrl}/api/market-data/admin/tejhq/status`, { headers: userHeaders });
      assert.equal(forbidden.response.status, 403);
      assert.equal(calls.length, 0);

      const adminHeaders = { Authorization: `Bearer ${token(adminUserId, 'admin')}` };
      const invalid = await jsonRequest(`${baseUrl}/api/market-data/admin/equity-history?${validQuery.replace('fromDate=2026-10-08', 'fromDate=2026-02-30')}`, { headers: adminHeaders });
      assert.equal(invalid.response.status, 400);
      assert.equal(calls.length, 0);

      const status = await jsonRequest(`${baseUrl}/api/market-data/admin/tejhq/status`, { headers: adminHeaders });
      assert.equal(status.response.status, 200);
      assert.equal(status.body.provider, 'TEJHQ');

      const history = await jsonRequest(`${baseUrl}/api/market-data/admin/equity-history?${validQuery}`, { headers: adminHeaders });
      assert.equal(history.response.status, 200);
      assert.equal(calls[1][0], 'history');
      assert.equal(calls[1][1].basis, 'RAW');

      const actions = await jsonRequest(`${baseUrl}/api/market-data/admin/tejhq/corporate-actions?exchange=NSE&symbol=RELIANCE&isin=INE002A01018`, { headers: adminHeaders });
      assert.equal(actions.response.status, 200);
      assert.equal(actions.body.completeness, 'NOT_CONCLUSIVE');
      assert.deepEqual(calls.map(call => call[0]), ['status', 'history', 'actions']);
    });
  } finally {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});

test('Upstox primary history is accepted only when identity, range, ordering, and OHLC invariants hold', async () => {
  const request = {
    exchange: 'NSE', symbol: 'RELIANCE', isin: 'INE002A01018',
    fromDate: '2026-10-08', toDate: '2026-10-09',
  };
  let tejCalls = 0;
  const validPrimary = {
    status: 'AVAILABLE', provider: 'UPSTOX', instrumentKey: 'NSE_EQ|INE002A01018',
    candles: [{
      timestamp: '2026-10-08T10:00:00.000Z', open: 100, high: 110, low: 99, close: 105, volume: 100,
    }],
  };
  const direct = await fetchQualifiedEquityHistory(request, {
    upstoxProvider: { getDailyCandles: async () => validPrimary },
    tejHqHistoricalProvider: { getRawHistory: async () => { tejCalls += 1; return {}; } },
  });
  assert.equal(direct.provider, PROVIDERS.UPSTOX);
  assert.equal(direct.fallbackUsed, false);
  assert.equal(tejCalls, 0);

  const malformedPrimary = { ...validPrimary, candles: [{ ...validPrimary.candles[0], timestamp: '2026-10-10T10:00:00.000Z' }] };
  const calendar = {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    provider: PROVIDERS.NSE,
    status: 'AVAILABLE',
    fetchedAt: new Date().toISOString(),
    dates: ['2026-01-01'],
    source: { provider: PROVIDERS.NSE, url: NSE_TRADING_HOLIDAY_URL },
  };
  const fallback = await fetchQualifiedEquityHistory(request, {
    upstoxProvider: { getDailyCandles: async () => malformedPrimary },
    tejHqHistoricalProvider: {
      getSymbolHistory: async () => ({
        status: 'AVAILABLE', exchange: 'NSE', isin: request.isin,
        intervals: [{ exchange: 'NSE', isin: request.isin, symbol: 'RELIANCE', validFrom: '2010-01-01', validTo: '2026-10-09' }],
      }),
      getStatus: async () => ({ provider: 'TEJHQ', status: 'AVAILABLE', publication: { datasetTradingDate: '2026-10-09' } }),
      getRawHistory: async options => ({
        status: 'AVAILABLE', provider: 'TEJHQ',
        instrumentIdentity: { exchange: options.exchange, tradingSymbol: options.symbol, isin: options.isin },
        candles: [
          { date: '2026-10-08', open: 100, high: 110, low: 99, close: 105, volume: 100 },
          { date: '2026-10-09', open: 105, high: 112, low: 104, close: 111, volume: 120 },
        ],
      }),
    },
    nseCalendarProvider: { holidayLoader: async () => calendar },
    env: { TEJHQ_HISTORICAL_FALLBACK_ENABLED: 'true' },
  });
  assert.equal(fallback.provider, PROVIDERS.TEJHQ);
  assert.equal(fallback.fallbackUsed, true);
  assert.equal(fallback.selection.primaryFailureCode, 'UPSTOX_HISTORY_RESPONSE_UNQUALIFIED');
  assert.equal(fallback.coverage.expectedSessionCount, 2);
  assert.equal(fallback.candles.length, 2);
});

test('production equity-history requests never fetch or return Upstox candles without distribution confirmation', async () => {
  let upstoxCalls = 0;
  const result = await fetchQualifiedEquityHistory({
    exchange: 'NSE', symbol: 'RELIANCE', isin: 'INE002A01018',
    fromDate: '2026-10-08', toDate: '2026-10-09',
  }, {
    env: {
      NODE_ENV: 'production',
      UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED: 'false',
      TEJHQ_HISTORICAL_FALLBACK_ENABLED: 'false',
    },
    upstoxProvider: {
      getDailyCandles: async () => {
        upstoxCalls += 1;
        return { status: 'AVAILABLE', provider: 'UPSTOX', candles: [{ close: 999 }] };
      },
    },
  });

  assert.equal(upstoxCalls, 0);
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.provider, null);
  assert.deepEqual(result.candles, []);
  assert.equal(result.selection.primaryFailureCode, 'UPSTOX_PUBLIC_DISTRIBUTION_DISABLED');
});
