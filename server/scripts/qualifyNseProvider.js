import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import axios from 'axios';
import { setRedisAvailable, setRedisClient } from '../config/redis.js';
import NseMarketDataProvider, { NSE_ALL_INDICES_URL } from '../services/marketData/NseMarketDataProvider.js';
import NseHistoricalDataProvider, { NSE_HISTORICAL_INDEX_RIGHTS_URL } from '../services/marketData/NseHistoricalDataProvider.js';
import { DEFAULT_BENCHMARK_IDS, MARKET_BENCHMARKS } from '../services/marketData/marketBenchmarks.js';
import { clearInFlightMarketRequestsForTest } from '../services/marketData/requestCache.js';
import { computeMarketContextFeatures } from '../services/marketContextFeatureEngine.js';
import {
  applyMarketContextHysteresis,
  classifyDeterministicMarketContext,
} from '../services/marketContextPolicy.js';
import { buildNiftyHistoryWindow, isUpstoxOnlyMarketDataMode } from '../services/marketDataService.js';
import { assertMarketDataQualificationRights } from '../services/marketData/marketDataRights.js';
import { NSE_TRADING_HOLIDAY_URL } from '../services/marketData/nseTradingCalendar.js';

try {
  if (isUpstoxOnlyMarketDataMode()) {
    const error = new Error('NSE live qualification is disabled in UPSTOX_ONLY mode.');
    error.code = 'NSE_MARKET_DATA_DISABLED_IN_TWO_PROVIDER_MODE';
    throw error;
  }
  assertMarketDataQualificationRights([
    { provider: 'NSE', url: NSE_ALL_INDICES_URL },
    { provider: 'NSE', url: NSE_HISTORICAL_INDEX_RIGHTS_URL },
    { provider: 'NSE', url: NSE_TRADING_HOLIDAY_URL },
  ]);
} catch (error) {
  console.error(`${error.code || 'MARKET_DATA_QUALIFICATION_BLOCKED'}: ${error.message}`);
  process.exit(1);
}

const storedValues = new Map();
const redisFacade = {
  get: async key => storedValues.get(key) ?? null,
  setEx: async (key, _ttlSeconds, value) => { storedValues.set(key, value); },
};
const requestCounts = new Map();
const httpClient = {
  get: async (url, options) => {
    requestCounts.set(url, (requestCounts.get(url) || 0) + 1);
    return axios.get(url, options);
  },
};

function signalValues(signals) {
  return Object.fromEntries(Object.entries(signals).map(([key, signal]) => [key, signal?.value ?? null]));
}

function publicFact(fact) {
  return {
    value: fact.value,
    previousClose: fact.metrics?.previousClose ?? null,
    providerTimestamp: fact.providerTimestamp,
    effectiveTradingDate: fact.effectiveTradingDate,
    fetchedAt: fact.fetchedAt,
    freshness: fact.freshness,
    source: fact.source,
  };
}

let httpServer;
try {
  setRedisClient(redisFacade);
  setRedisAvailable(true);
  clearInFlightMarketRequestsForTest();

  const quoteProvider = new NseMarketDataProvider({ httpClient });
  const historyProvider = new NseHistoricalDataProvider({ httpClient });
  const [quoteSnapshot, coalescedQuoteSnapshot] = await Promise.all([
    quoteProvider.getQuotes(DEFAULT_BENCHMARK_IDS),
    quoteProvider.getQuotes(DEFAULT_BENCHMARK_IDS),
  ]);
  const cachedQuoteSnapshot = await quoteProvider.getQuotes(DEFAULT_BENCHMARK_IDS);
  const forcedQuoteSnapshot = await quoteProvider.getQuotes(DEFAULT_BENCHMARK_IDS, { forceRefresh: true });

  assert.equal(quoteSnapshot.status, 'AVAILABLE');
  assert.equal(coalescedQuoteSnapshot.status, 'AVAILABLE');
  assert.equal(cachedQuoteSnapshot.cache.hit, true);
  assert.equal(forcedQuoteSnapshot.cache.hit, false);

  const window = buildNiftyHistoryWindow(new Date());
  const [historicalSnapshot, coalescedHistoricalSnapshot] = await Promise.all([
    historyProvider.getDailyCandles(MARKET_BENCHMARKS.NIFTY_50.canonicalProductId, window),
    historyProvider.getDailyCandles(MARKET_BENCHMARKS.NIFTY_50.canonicalProductId, window),
  ]);
  const cachedHistoricalSnapshot = await historyProvider.getDailyCandles(
    MARKET_BENCHMARKS.NIFTY_50.canonicalProductId,
    window,
  );
  assert.equal(historicalSnapshot.status, 'AVAILABLE');
  assert.equal(coalescedHistoricalSnapshot.status, 'AVAILABLE');
  assert.equal(cachedHistoricalSnapshot.cache.hit, true);
  assert(historicalSnapshot.candleCount >= 200);
  assert.equal(quoteSnapshot.calendar?.status, 'AVAILABLE');
  assert.equal(historicalSnapshot.calendar?.status, 'AVAILABLE');

  // The forced refresh is the latest authoritative quote snapshot and is also
  // the snapshot the HTTP route will read back from cache. Using the earlier
  // coalescing snapshot here creates a race during open-market ticks.
  const verifiedQuoteSnapshot = forcedQuoteSnapshot;
  const features = computeMarketContextFeatures({ quoteSnapshot: verifiedQuoteSnapshot, historicalSnapshot });
  const candidate = classifyDeterministicMarketContext(features);
  const published = applyMarketContextHysteresis(candidate, null, new Date()).result;
  assert.equal(features.status, 'FEATURES_AVAILABLE');
  assert.equal(features.policyAvailability, 'AVAILABLE');
  assert(['COMPLETE', 'PARTIAL'].includes(features.dataCompleteness));
  ['return1DayPct', 'return5DayPct', 'return20DayPct', 'drawdownFromRecentHighPct', 'realizedVolatility20DayAnnualizedPct']
    .forEach(key => assert.equal(features.signals[key].available, true, `${key} must be derived from verified sessions`));
  assert.equal(candidate.status, 'MARKET_CONTEXT_AVAILABLE');

  process.env.NODE_ENV = 'test';
  process.env.DISABLE_RATE_LIMIT = 'true';
  const { createApp } = await import('../app.js');
  httpServer = createServer(createApp({ env: process.env }));
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  const routeResponse = await fetch(`http://127.0.0.1:${address.port}/api/regime/current`);
  const routeBody = await routeResponse.json();
  assert.equal(routeResponse.status, 200);
  assert.equal(routeBody.status, candidate.status);
  assert.equal(routeBody.candidateContext, candidate.context);
  assert.deepEqual(signalValues(routeBody.signals), signalValues(candidate.signals));
  assert.equal(routeBody.marketSnapshot.policyOutput.context, routeBody.context);
  assert.equal(routeBody.marketSnapshot.policyAvailability, 'AVAILABLE');

  const serializedCache = [...storedValues.entries()].map(([key, value]) => `${key}\n${value}`).join('\n');
  const sensitiveCachePattern = /authorization|bearer|cookie|sessionid|analytics_token|access_token/i;
  assert.equal(sensitiveCachePattern.test(serializedCache), false);

  const nifty = verifiedQuoteSnapshot.facts.find(
    fact => fact.canonicalProductId === MARKET_BENCHMARKS.NIFTY_50.canonicalProductId,
  );
  const vix = verifiedQuoteSnapshot.facts.find(
    fact => fact.canonicalProductId === MARKET_BENCHMARKS.INDIA_VIX.canonicalProductId,
  );
  const report = {
    provider: verifiedQuoteSnapshot.provider,
    qualification: verifiedQuoteSnapshot.qualification,
    dataClasses: { quotes: verifiedQuoteSnapshot.dataClass, history: historicalSnapshot.dataClass },
    nifty50: publicFact(nifty),
    indiaVix: publicFact(vix),
    history: {
      candleCount: historicalSnapshot.candleCount,
      earliest: historicalSnapshot.candles[0]?.effectiveTradingDate ?? null,
      latest: historicalSnapshot.effectiveTradingDate,
      providerTimestamp: historicalSnapshot.providerTimestamp,
      fetchedAt: historicalSnapshot.fetchedAt,
      freshness: historicalSnapshot.freshness,
      ma50Available: features.signals.movingAverage50Day.available,
      ma200Available: features.signals.movingAverage200Day.available,
    },
    signals: signalValues(features.signals),
    candidateContext: candidate.context,
    publishedContext: published.context,
    reasonCodes: published.reasonCodes,
    observedAt: published.observedAt,
    freshness: published.freshness,
    route: {
      status: routeBody.status,
      candidateContext: routeBody.candidateContext,
      publishedContext: routeBody.context,
      matchedUnderlyingSignals: true,
    },
    cache: {
      quoteHit: cachedQuoteSnapshot.cache.hit,
      historyHit: cachedHistoricalSnapshot.cache.hit,
      coalescedQuoteRequests: requestCounts.get('https://www.nseindia.com/api/allIndices') === 2,
      cacheEntryCount: storedValues.size,
      sensitiveMaterialAbsent: true,
    },
    httpRequestCounts: Object.fromEntries(requestCounts),
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (httpServer) await new Promise(resolve => httpServer.close(resolve));
  clearInFlightMarketRequestsForTest();
  setRedisAvailable(false);
  setRedisClient(null);
}
