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

test('Upstox NSE primary history requires exact qualified-calendar session coverage', async () => {
  const request = {
    exchange: 'NSE', symbol: 'RELIANCE', isin: 'INE002A01018',
    fromDate: '2026-10-08', toDate: '2026-10-09',
  };
  let tejCalls = 0;
  const validPrimary = {
    status: 'AVAILABLE', provider: 'UPSTOX', instrumentKey: 'NSE_EQ|INE002A01018',
    candles: [
      { timestamp: '2026-10-08T10:00:00.000Z', open: 100, high: 110, low: 99, close: 105, volume: 100 },
      { timestamp: '2026-10-09T10:00:00.000Z', open: 105, high: 112, low: 104, close: 111, volume: 120 },
    ],
  };
  const makeCalendar = (dates = ['2026-01-01'], fetchedAt = new Date().toISOString()) => ({
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    provider: PROVIDERS.NSE,
    status: 'AVAILABLE',
    fetchedAt,
    dates,
    source: { provider: PROVIDERS.NSE, url: NSE_TRADING_HOLIDAY_URL },
  });
  const direct = await fetchQualifiedEquityHistory(request, {
    upstoxProvider: { getDailyCandles: async () => validPrimary },
    tejHqHistoricalProvider: { getRawHistory: async () => { tejCalls += 1; return {}; } },
    nseCalendarProvider: { holidayLoader: async () => makeCalendar() },
  });
  assert.equal(direct.provider, PROVIDERS.UPSTOX);
  assert.equal(direct.fallbackUsed, false);
  assert.equal(direct.coverage.status, 'COMPLETE_FOR_NSE_WEEKDAY_HOLIDAY_CALENDAR');
  assert.equal(direct.coverage.expectedSessionCount, 2);
  assert.equal(direct.coverage.observedSessionCount, 2);
  assert.equal(tejCalls, 0);

  const currentSessionTime = new Date('2026-10-09T10:00:00.000Z');
  const currentSession = await fetchQualifiedEquityHistory(request, {
    upstoxProvider: { getDailyCandles: async () => validPrimary },
    nseCalendarProvider: { holidayLoader: async () => makeCalendar(['2026-01-01'], currentSessionTime.toISOString()) },
    env: { NODE_ENV: 'test', TEJHQ_HISTORICAL_FALLBACK_ENABLED: 'false' },
    clock: () => currentSessionTime,
  });
  assert.equal(currentSession.status, 'UNAVAILABLE');
  assert.equal(currentSession.selection.primaryFailureCode, 'UPSTOX_CURRENT_SESSION_NOT_VERIFIED_FINAL');

  const holidayAware = await fetchQualifiedEquityHistory(request, {
    upstoxProvider: {
      getDailyCandles: async () => ({
        ...validPrimary,
        candles: [validPrimary.candles[1]],
      }),
    },
    nseCalendarProvider: { holidayLoader: async () => makeCalendar(['2026-01-01', '2026-10-08']) },
  });
  assert.equal(holidayAware.provider, PROVIDERS.UPSTOX);
  assert.equal(holidayAware.coverage.expectedSessionCount, 1);
  assert.equal(holidayAware.coverage.observedSessionCount, 1);

  const adjusted = await fetchQualifiedEquityHistory({ ...request, basis: 'ADJUSTED' }, {
    tejHqHistoricalProvider: {
      getSymbolHistory: async () => ({
        status: 'AVAILABLE', exchange: 'NSE', isin: request.isin,
        intervals: [{ exchange: 'NSE', isin: request.isin, symbol: 'RELIANCE', validFrom: '2010-01-01', validTo: '2026-10-09' }],
      }),
      getStatus: async () => ({ provider: 'TEJHQ', status: 'AVAILABLE', publication: { datasetTradingDate: '2026-10-09' } }),
      getAdjustedHistory: async options => ({
        status: 'AVAILABLE', provider: 'TEJHQ', priceBasis: 'BACK_ADJUSTED',
        instrumentIdentity: { exchange: options.exchange, tradingSymbol: options.symbol, isin: options.isin },
        candles: ['2026-10-08', '2026-10-09'].map((date, index) => ({
          date, isin: request.isin, open: 100, high: 110, low: 99, close: 105,
          adjustedClose: 52.5, adjustmentFactor: 0.5, volume: 100 + index,
        })),
      }),
    },
    nseCalendarProvider: { holidayLoader: async () => makeCalendar() },
    env: { NODE_ENV: 'test', TEJHQ_ADJUSTED_HISTORY_ENABLED: 'true' },
  });
  assert.equal(adjusted.priceBasis, 'BACK_ADJUSTED');
  assert.deepEqual(adjusted.priceFieldSemantics, {
    openHighLowClose: 'RAW_UNADJUSTED',
    adjustedClose: 'BACK_ADJUSTED',
    adjustmentFactor: 'RAW_CLOSE_TO_BACK_ADJUSTED_CLOSE',
  });
  assert.equal(adjusted.candles[0].close, 105);
  assert.equal(adjusted.candles[0].adjustedClose, 52.5);

  const makeTejProvider = dates => ({
    getSymbolHistory: async () => ({
      status: 'AVAILABLE', exchange: 'NSE', isin: request.isin,
      intervals: [{ exchange: 'NSE', isin: request.isin, symbol: 'RELIANCE', validFrom: '2010-01-01', validTo: '2026-10-12' }],
    }),
    getStatus: async () => ({ provider: 'TEJHQ', status: 'AVAILABLE', publication: { datasetTradingDate: '2026-10-12' } }),
    getRawHistory: async options => ({
      status: 'AVAILABLE', provider: 'TEJHQ',
      instrumentIdentity: { exchange: options.exchange, tradingSymbol: options.symbol, isin: options.isin },
      candles: dates.filter(date => date >= options.fromDate && date <= options.toDate).map((date, index) => ({
        date, open: 100 + index, high: 110 + index, low: 99 + index, close: 105 + index, volume: 100 + index,
      })),
    }),
  });

  const partial = await fetchQualifiedEquityHistory(request, {
    upstoxProvider: { getDailyCandles: async () => ({ ...validPrimary, candles: [validPrimary.candles[0]] }) },
    tejHqHistoricalProvider: makeTejProvider(['2026-10-08', '2026-10-09']),
    nseCalendarProvider: { holidayLoader: async () => makeCalendar() },
    env: { NODE_ENV: 'test', TEJHQ_HISTORICAL_FALLBACK_ENABLED: 'true' },
  });
  assert.equal(partial.provider, PROVIDERS.TEJHQ);
  assert.equal(partial.fallbackUsed, true);
  assert.equal(partial.selection.primaryFailureCode, 'UPSTOX_HISTORY_SESSION_COVERAGE_INCOMPLETE');
  assert.equal(partial.coverage.expectedSessionCount, 2);
  assert.equal(partial.candles.length, 2);

  const gapRequest = { ...request, toDate: '2026-10-12' };
  const gap = await fetchQualifiedEquityHistory(gapRequest, {
    upstoxProvider: { getDailyCandles: async () => ({ ...validPrimary, candles: [validPrimary.candles[0], {
      timestamp: '2026-10-12T10:00:00.000Z', open: 111, high: 115, low: 110, close: 114, volume: 130,
    }] }) },
    tejHqHistoricalProvider: makeTejProvider(['2026-10-08', '2026-10-09', '2026-10-12']),
    nseCalendarProvider: { holidayLoader: async () => makeCalendar() },
    env: { NODE_ENV: 'test', TEJHQ_HISTORICAL_FALLBACK_ENABLED: 'true' },
  });
  assert.equal(gap.provider, PROVIDERS.TEJHQ);
  assert.equal(gap.selection.primaryFailureCode, 'UPSTOX_HISTORY_SESSION_COVERAGE_INCOMPLETE');
  assert.equal(gap.coverage.expectedSessionCount, 3);
  assert.equal(gap.candles.length, 3);

  let blockedCalendarTejCalls = 0;
  const calendarUnavailable = await fetchQualifiedEquityHistory(request, {
    upstoxProvider: { getDailyCandles: async () => validPrimary },
    tejHqHistoricalProvider: {
      getSymbolHistory: async () => { blockedCalendarTejCalls += 1; return {}; },
      getStatus: async () => { blockedCalendarTejCalls += 1; return {}; },
    },
    nseCalendarProvider: { holidayLoader: async () => { throw new Error('fixture calendar unavailable'); } },
    env: { NODE_ENV: 'test', TEJHQ_HISTORICAL_FALLBACK_ENABLED: 'true' },
  });
  assert.equal(calendarUnavailable.status, 'UNAVAILABLE');
  assert.equal(calendarUnavailable.provider, null);
  assert.equal(calendarUnavailable.selection.primaryFailureCode, 'NSE_TRADING_CALENDAR_UNAVAILABLE');
  assert.equal(blockedCalendarTejCalls, 0);
});

test('TejHQ fallback rejects publication lag, wrong identity, and missing sessions without returning partial history', async () => {
  const request = {
    exchange: 'NSE', symbol: 'RELIANCE', isin: 'INE002A01018',
    fromDate: '2026-10-08', toDate: '2026-10-09',
  };
  const calendar = {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    provider: PROVIDERS.NSE,
    status: 'AVAILABLE',
    fetchedAt: new Date().toISOString(),
    dates: ['2026-01-01'],
    source: { provider: PROVIDERS.NSE, url: NSE_TRADING_HOLIDAY_URL },
  };
  const primaryFailure = {
    provider: PROVIDERS.UPSTOX,
    status: 'SOURCE_ERROR',
    candles: [],
    error: { code: 'UPSTOX_FIXTURE_OUTAGE' },
  };
  const symbolHistory = ({ exchange = 'NSE', isin = request.isin, intervals = null } = {}) => ({
    status: 'AVAILABLE',
    exchange,
    isin,
    intervals: intervals || [{
      exchange: 'NSE', isin: request.isin, symbol: 'RELIANCE',
      validFrom: '2010-01-01', validTo: '2026-10-09',
    }],
  });
  const runFallback = async ({
    symbols = symbolHistory(), publicationDate = '2026-10-09', dates = ['2026-10-08', '2026-10-09'],
  } = {}) => {
    let rawHistoryCalls = 0;
    const result = await fetchQualifiedEquityHistory(request, {
      upstoxProvider: { getDailyCandles: async () => primaryFailure },
      tejHqHistoricalProvider: {
        getSymbolHistory: async () => symbols,
        getStatus: async () => ({
          provider: 'TEJHQ', status: 'AVAILABLE',
          publication: { datasetTradingDate: publicationDate },
        }),
        getRawHistory: async options => {
          rawHistoryCalls += 1;
          return {
            status: 'AVAILABLE', provider: 'TEJHQ',
            instrumentIdentity: { exchange: options.exchange, tradingSymbol: options.symbol, isin: options.isin },
            candles: dates.filter(date => date >= options.fromDate && date <= options.toDate).map((date, index) => ({
              date, open: 100 + index, high: 110 + index, low: 99 + index, close: 105 + index, volume: 100 + index,
            })),
          };
        },
      },
      nseCalendarProvider: { holidayLoader: async () => calendar },
      env: { NODE_ENV: 'test', TEJHQ_HISTORICAL_FALLBACK_ENABLED: 'true' },
    });
    return { result, rawHistoryCalls };
  };

  const laggingPublication = await runFallback({ publicationDate: '2026-10-08' });
  assert.equal(laggingPublication.result.status, 'UNAVAILABLE');
  assert.equal(laggingPublication.result.selection.reasonCode, 'TEJHQ_DATASET_NOT_PUBLISHED_THROUGH_REQUESTED_SESSION');
  assert.equal(laggingPublication.result.providerPublicationStatus.datasetTradingDate, '2026-10-08');
  assert.equal(laggingPublication.rawHistoryCalls, 0);
  assert.deepEqual(laggingPublication.result.candles, []);

  const mismatchedIdentity = await runFallback({ symbols: symbolHistory({ isin: 'INE999A01099' }) });
  assert.equal(mismatchedIdentity.result.status, 'UNAVAILABLE');
  assert.equal(mismatchedIdentity.result.selection.reasonCode, 'TEJHQ_SYMBOL_IDENTITY_UNAVAILABLE');
  assert.equal(mismatchedIdentity.rawHistoryCalls, 0);
  assert.deepEqual(mismatchedIdentity.result.candles, []);

  const missingSession = await runFallback({ dates: ['2026-10-08'] });
  assert.equal(missingSession.result.status, 'UNAVAILABLE');
  assert.equal(missingSession.result.selection.reasonCode, 'TEJHQ_HISTORICAL_SESSION_COVERAGE_INCOMPLETE');
  assert.equal(missingSession.rawHistoryCalls, 1);
  assert.deepEqual(missingSession.result.candles, []);
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

test('malformed Upstox NSE history still falls back only through exact TejHQ session coverage', async () => {
  const request = {
    exchange: 'NSE', symbol: 'RELIANCE', isin: 'INE002A01018',
    fromDate: '2026-10-08', toDate: '2026-10-09',
  };
  const calendar = {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    provider: PROVIDERS.NSE,
    status: 'AVAILABLE',
    fetchedAt: new Date().toISOString(),
    dates: ['2026-01-01'],
    source: { provider: PROVIDERS.NSE, url: NSE_TRADING_HOLIDAY_URL },
  };
  const malformedPrimary = {
    status: 'AVAILABLE', provider: 'UPSTOX', instrumentKey: 'NSE_EQ|INE002A01018',
    candles: [{ timestamp: '2026-10-10T10:00:00.000Z', open: 100, high: 110, low: 99, close: 105, volume: 100 }],
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
    env: { NODE_ENV: 'test', TEJHQ_HISTORICAL_FALLBACK_ENABLED: 'true' },
  });
  assert.equal(fallback.provider, PROVIDERS.TEJHQ);
  assert.equal(fallback.fallbackUsed, true);
  assert.equal(fallback.selection.primaryFailureCode, 'UPSTOX_HISTORY_RESPONSE_UNQUALIFIED');
  assert.equal(fallback.coverage.expectedSessionCount, 2);
  assert.equal(fallback.candles.length, 2);
});

test('production equity-history requests never fetch or return Upstox candles without source rights', async () => {
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
  assert.equal(result.selection.primaryFailureCode, 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
});
