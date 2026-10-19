import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import { errorHandler } from '../middleware/errorHandler.js';
import { createRegimeRouter } from '../routes/regime.js';
import { createMarketQuotesRouter } from '../routes/marketQuotes.js';
import { withMockAuthAccountState } from './helpers/mockAuthAccountState.js';
import { jsonRequest, withServer } from '../test-utils/httpTestUtils.js';
import {
  getMarketAttemptedProvider,
  getMarketDisplayState,
  getMarketEvidenceSource,
} from '../../reactapp/src/utils/marketDataDisplay.js';
import UpstoxMarketDataProvider from '../services/marketData/UpstoxMarketDataProvider.js';
import UpstoxHistoricalCandleProvider from '../services/marketData/UpstoxHistoricalCandleProvider.js';
import UpstoxTradingCalendarProvider, {
  expectedUpstoxNseSessions,
  parseUpstoxTradingCalendar,
} from '../services/marketData/UpstoxTradingCalendarProvider.js';
import { createMarketDataTestFixtureRightsCapability } from '../services/marketData/marketDataTestFixtures.js';
import {
  UPSTOX_HISTORICAL_CANDLE_V3_URL,
  UPSTOX_MARKET_TIMINGS_RIGHTS_URL,
  UPSTOX_NSE_MARKET_STATUS_URL,
  UPSTOX_QUOTE_URL,
  UPSTOX_TRADING_HOLIDAYS_URL,
} from '../services/marketData/marketDataSourceUrls.js';
import { fetchQualifiedMarketContextSnapshots, fetchUpstoxCanonicalQuotes } from '../services/marketDataService.js';
import {
  getLiveMarketContext,
  resetMarketContextProcessStateForTest,
} from '../services/marketContextService.js';

const now = new Date('2026-10-16T09:55:00.000Z');
const env = Object.freeze({ NODE_ENV: 'test', MARKET_DATA_MODE: 'UPSTOX_TEJHQ' });
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

test('selected mode carries synthetic Upstox HTTP responses through adapters, coverage and policy', async () => {
  resetMarketContextProcessStateForTest();
  const calendar = parseUpstoxTradingCalendar(calendarPayload, {
    year: '2026', fetchedAt: now.toISOString(),
  });
  const dates = expectedUpstoxNseSessions('2026-01-01', '2026-10-15', calendar, now);
  assert.ok(dates.length >= 200, 'fixture covers the 200-session moving average');
  const closes = dates.map((_, index) => 20_000 + index * 2);
  const lastClose = closes.at(-1);
  const calls = [];
  const transport = { get: async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, 'Bearer synthetic-test-token');
    if (url.startsWith(UPSTOX_QUOTE_URL)) return { data: { status: 'success', data: {
      'NSE_INDEX:Nifty 50': {
        instrument_token: 'NSE_INDEX|Nifty 50', last_price: lastClose + 1,
        prev_close_price: lastClose,
        last_trade_time: String(Date.parse('2026-10-16T09:54:00.000Z')),
        timestamp: '2026-10-16T15:24:30.000+05:30',
      },
      'NSE_INDEX:India VIX': {
        instrument_token: 'NSE_INDEX|India VIX', last_price: 14,
        last_trade_time: String(Date.parse('2026-10-16T09:54:00.000Z')),
        timestamp: '2026-10-16T15:24:30.000+05:30',
      },
    } } };
    if (url.startsWith(UPSTOX_HISTORICAL_CANDLE_V3_URL)) return { data: {
      status: 'success', data: { candles: dates.map((date, index) => [
        `${date}T10:00:00.000Z`, closes[index], closes[index] + 3,
        closes[index] - 3, closes[index], 1000 + index, 0,
      ]) },
    } };
    if (url === UPSTOX_TRADING_HOLIDAYS_URL) return { data: calendarPayload };
    if (url === UPSTOX_NSE_MARKET_STATUS_URL) return { data: {
      status: 'success', data: { exchange: 'NSE', status: 'NORMAL_OPEN',
        last_updated: Date.parse('2026-10-16T03:45:00.000Z') },
    } };
    if (url === UPSTOX_MARKET_TIMINGS_RIGHTS_URL.replace('{date}', '2026-10-16')) {
      return { data: { status: 'success', data: [{ exchange: 'NSE',
        start_time: Date.parse('2026-10-16T03:45:00.000Z'),
        end_time: Date.parse('2026-10-16T10:00:00.000Z') }] } };
    }
    assert.fail(`Unexpected fixture endpoint: ${url}`);
  } };
  const requestCache = ({ loader }) => loader();
  const options = { env, httpClient: transport, accessToken: 'synthetic-test-token',
    clock: () => now, requestCache };
  const providers = {
    upstoxQuoteProvider: new UpstoxMarketDataProvider(options),
    upstoxHistoryProviderOverride: new UpstoxHistoricalCandleProvider(options),
    upstoxCalendarProviderOverride: new UpstoxTradingCalendarProvider(options),
    nseQuoteProvider: { getQuotes: () => assert.fail('selected mode cannot call NSE quotes') },
    nseHistoryProviderOverride: { getDailyCandles: () => assert.fail('selected mode cannot call NSE history') },
  };
  const fixtureCapability = createMarketDataTestFixtureRightsCapability({ env, transport });
  const pair = await fetchQualifiedMarketContextSnapshots({
    ...providers, env, now, persist: false,
    marketDataTestFixtureRightsCapability: fixtureCapability,
  });
  assert.equal(pair.providerSelection.selectedProvider, 'UPSTOX');
  assert.deepEqual(pair.providerSelection.attemptedProviders, ['UPSTOX']);
  assert.equal(pair.quoteSnapshot.status, 'AVAILABLE');
  assert.equal(pair.quoteSnapshot.marketSession.status, 'MARKET_OPEN');
  assert.equal(pair.historicalSnapshot.status, 'AVAILABLE');
  assert.equal(pair.historicalSnapshot.coverage.expectedSessionCount, dates.length);
  assert.equal(pair.historicalSnapshot.coverage.calendarProvider, 'UPSTOX');
  assert.equal(pair.historicalSnapshot.candles.length, dates.length);
  assert.equal(calls.filter(url => url.startsWith('https://www.nseindia.com/')).length, 0);

  const context = await getLiveMarketContext({ now }, {
    env, marketDataTestFixtureRightsCapability: fixtureCapability,
    fetchQualifiedMarketContextSnapshots: async () => pair,
    getCache: async () => null,
    setCache: async () => true,
    getLkgCache: async () => null,
    setLkgCache: async () => true,
    getDurableLkg: async () => null,
    persistDurableLkg: async () => ({ status: 'PERSISTED' }),
  });
  assert.equal(context.status, 'MARKET_CONTEXT_AVAILABLE');
  assert.equal(context.marketSnapshot.availability, 'AVAILABLE');
  assert.equal(context.marketSnapshot.derivedFacts.find(fact => (
    fact.key === 'movingAverage200Day'
  ))?.availabilityStatus, 'AVAILABLE');
  assert.equal(context.marketSnapshot.providerSelection.selectedProvider, 'UPSTOX');
  assert.ok(context.marketSnapshot.provenance.sources.length > 0);
  assert.ok(context.marketSnapshot.provenance.sources.every(source => source.provider === 'UPSTOX'));

  // Exercise the actual Express DTO boundary and the pure React display mapper
  // with the context assembled above, not a separately invented API response.
  const userId = '64b000000000000000000001';
  const profileId = '64b000000000000000000002';
  const profile = { _id: profileId, userId, version: 1, riskTolerance: 'Moderate' };
  const state = {
    profileVersion: 1,
    recommendation: { _id: '64b000000000000000000003' },
    currentAllocation: { instruments: [{ id: 'suitable-fixture', allocationWeight: 1 }] },
    allocationRevision: { _id: '64b000000000000000000004', revision: 1 },
    portfolioFingerprint: 'a'.repeat(64), recommendationFingerprint: 'b'.repeat(64),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/market', createMarketQuotesRouter({
    env,
    marketDataTestFixtureRightsCapability: fixtureCapability,
    limiter: (_request, _response, next) => next(),
    fetchQuotes: (ids, optionsForQuote) => fetchUpstoxCanonicalQuotes(ids, {
      ...optionsForQuote, now, upstoxMarketDataProvider: providers.upstoxQuoteProvider,
    }),
  }));
  app.use('/api/regime', createRegimeRouter({
    getLiveMarketContext: async () => context,
    requireCurrentFinancialProfile: async request => {
      assert.deepEqual(request, { userId, profileId });
      return { profile };
    },
    buildRecommendationProfile: value => value,
    requireFreshRecommendationState: async () => state,
    applyProfileSafeMarketContextAdjustment: ({ marketContext }) => {
      assert.equal(marketContext, context);
      return { applied: false, introducedInstrumentIds: [],
        suitabilityRevalidated: true, concentrationCapsRevalidated: true };
    },
  }));
  app.use(errorHandler);
  const oldSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'synthetic_market_success_test_secret_at_least_32_chars';
  const token = jwt.sign({ userId, role: 'user' }, process.env.JWT_SECRET,
    { algorithm: 'HS256' });
  try {
    await withMockAuthAccountState(() => withServer(app, async baseUrl => {
      const quoteResponse = await jsonRequest(`${baseUrl}/api/market/quotes?ids=market:index:nifty-50`);
      assert.equal(quoteResponse.response.status, 200);
      assert.equal(quoteResponse.body.facts[0].quoteLastTradeAt, '2026-10-16T09:54:00.000Z');
      assert.equal(quoteResponse.body.facts[0].quoteResponseGeneratedAt, '2026-10-16T09:54:30.000Z');
      assert.equal(quoteResponse.body.facts[0].providerResponseReceivedAt, now.toISOString());
      const current = await jsonRequest(`${baseUrl}/api/regime/current`);
      assert.equal(current.response.status, 200);
      assert.equal(current.body.marketSnapshot.providerSelection.selectedProvider,
        'UPSTOX');
      assert.equal(getMarketDisplayState(current.body).key, 'CURRENT');
      assert.equal(getMarketEvidenceSource(current.body), 'UPSTOX');
      assert.equal(getMarketAttemptedProvider(current.body), 'UPSTOX');
      const unauthorized = await jsonRequest(`${baseUrl}/api/regime/adjust`, {
        method: 'POST', body: JSON.stringify({ profileId }),
      });
      assert.equal(unauthorized.response.status, 401);
      const { response, body } = await jsonRequest(`${baseUrl}/api/regime/adjust`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ profileId }),
      });
      assert.equal(response.status, 200);
      assert.equal(body.persisted, false);
      assert.equal(body.profileId, profileId);
      assert.equal(body.marketContext.marketSnapshot.contentRevision.digest,
        context.marketSnapshot.contentRevision.digest);
      assert.equal(body.marketContext.marketSnapshot.providerSelection.selectedProvider,
        'UPSTOX');
      assert.deepEqual(body.marketContext, current.body);
    }));
  } finally {
    if (oldSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldSecret;
  }
});
