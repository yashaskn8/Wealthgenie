import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMarketContextFeatures } from '../services/marketContextFeatureEngine.js';
import {
  MARKET_CONTEXT_CLASSIFICATION,
  MARKET_CONTEXT_POLICY_VERSION,
  applyMarketContextHysteresis,
  classifyDeterministicMarketContext,
} from '../services/marketContextPolicy.js';
import {
  getLiveMarketContext,
  getLatestQualifiedMarketContextForRecommendation,
  resetMarketContextProcessStateForTest,
} from '../services/marketContextService.js';
import { MARKET_BENCHMARKS } from '../services/marketData/marketBenchmarks.js';

const NOW = new Date('2026-09-08T12:00:00.000Z');
const NIFTY = 'NSE_INDEX|Nifty 50';
const VIX = 'NSE_INDEX|India VIX';

function quoteFact(instrumentId, canonicalProductId, value, { previousClose = null, freshness = 'FRESH', provider = 'NSE' } = {}) {
  return {
    canonicalProductId,
    value,
    availabilityStatus: 'AVAILABLE',
    observedAt: '2026-09-08T11:59:00.000Z',
    fetchedAt: NOW.toISOString(),
    dataClass: 'LIVE',
    freshness: { status: freshness, ageSeconds: 60, maxAgeSeconds: 900 },
    source: { provider, instrumentId, url: provider === 'NSE' ? 'https://www.nseindia.com/api/allIndices' : 'https://api.upstox.com/v3/market-quote/quotes' },
    metrics: { previousClose },
  };
}

function quoteSnapshot({ nifty = 160, previousClose = 159, vix = 14, niftyFreshness = 'FRESH', vixFreshness = 'FRESH', includeVix = true, provider = 'NSE' } = {}) {
  return {
    status: 'AVAILABLE',
    marketSession: { status: 'MARKET_CLOSED', tradingDate: '2026-09-08' },
    facts: [
      quoteFact(NIFTY, MARKET_BENCHMARKS.NIFTY_50.canonicalProductId, nifty, { previousClose, freshness: niftyFreshness, provider }),
      ...(includeVix ? [quoteFact(VIX, MARKET_BENCHMARKS.INDIA_VIX.canonicalProductId, vix, { freshness: vixFreshness, provider })] : []),
    ],
    provider,
  };
}

function historySnapshot(closes, { freshness = 'FRESH', status = 'AVAILABLE', provider = 'NSE' } = {}) {
  const start = Date.parse('2026-06-01T00:00:00.000Z');
  return {
    status,
    provider,
    fetchedAt: NOW.toISOString(),
    observedAt: new Date(start + (closes.length - 1) * 86400000).toISOString(),
    freshness: { status: freshness, ageSeconds: 86400, maxAgeSeconds: 345600 },
    source: { provider, instrumentId: 'NIFTY 50', url: provider === 'NSE' ? 'https://www.nseindia.com/api/historicalOR/indicesHistory' : 'https://api.upstox.com/v3/historical-candle' },
    candles: closes.map((close, index) => ({
      timestamp: new Date(start + index * 86400000).toISOString(),
      open: close,
      high: close + 1,
      low: close - 1,
      close,
    })),
  };
}

function policyFeatures(overrides = {}) {
  const values = {
    indiaVixCurrent: 15,
    return20DayPct: 2,
    drawdownFromRecentHighPct: -1,
    realizedVolatility20DayAnnualizedPct: 12,
    priceVsMovingAverage50Pct: 2,
    ...overrides,
  };
  return {
    status: 'FEATURES_AVAILABLE',
    signals: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {
      value, unit: 'PERCENT', basis: 'TEST_VERIFIED_SIGNAL', available: true,
    }])),
    reasonCodes: [],
    observedAt: '2026-09-08T11:59:00.000Z',
    freshness: { status: 'FRESH' },
    sources: [{ provider: 'NSE' }],
  };
}

test('fresh verified NIFTY and VIX observations produce deterministic normal context', () => {
  const closes = Array.from({ length: 60 }, (_, index) => 100 + index);
  const features = computeMarketContextFeatures({
    quoteSnapshot: quoteSnapshot(),
    historicalSnapshot: historySnapshot(closes),
  });
  const context = classifyDeterministicMarketContext(features);
  assert.equal(features.status, 'FEATURES_AVAILABLE');
  assert.equal(context.status, 'MARKET_CONTEXT_AVAILABLE');
  assert.equal(context.context, 'NORMAL');
  assert.equal(context.classification, MARKET_CONTEXT_CLASSIFICATION);
  assert.equal(context.policyVersion, MARKET_CONTEXT_POLICY_VERSION);
  assert.equal(context.confidence, null);
  assert.equal(features.signals.return1DayPct.value, 0.628931);
  for (const key of ['nifty50Current', 'nifty50PreviousClose', 'indiaVixCurrent']) {
    assert.equal(features.signals[key].semanticClass, 'OBSERVED', `${key} is directly supplied by the quote source`);
  }
  for (const key of ['return1DayPct', 'return20DayPct', 'movingAverage50Day', 'realizedVolatility20DayAnnualizedPct']) {
    assert.equal(features.signals[key].semanticClass, 'DERIVED', `${key} is computed from observed quote/history facts`);
  }
  assert.equal(features.signals.movingAverage50Day.available, true);
  assert.equal(features.signals.movingAverage200Day.available, false);
  assert.equal(features.observedFacts.find(fact => fact.key === 'nifty50Current').semanticClass, 'OBSERVED');
  assert.equal(features.observedFacts.find(fact => fact.key === 'nifty50Current').dataClass, 'LIVE');
  assert.equal(features.derivedFacts.find(fact => fact.key === 'return20DayPct').semanticClass, 'DERIVED');
  assert.equal(features.derivedFacts.find(fact => fact.key === 'return20DayPct').dataClass, null);
});

test('risk-off requires verified drawdown, 20-day loss, and price below MA50 evidence', () => {
  const closes = Array.from({ length: 60 }, (_, index) => 140 - (index * 0.5));
  const features = computeMarketContextFeatures({
    quoteSnapshot: quoteSnapshot({ nifty: 85, previousClose: 88, vix: 18 }),
    historicalSnapshot: historySnapshot(closes),
  });
  const context = classifyDeterministicMarketContext(features);
  assert.equal(context.context, 'RISK_OFF');
  assert(context.reasonCodes.includes('DRAWDOWN_AT_OR_BELOW_RISK_OFF_THRESHOLD'));
  assert(context.reasonCodes.includes('RETURN_20D_AT_OR_BELOW_RISK_OFF_THRESHOLD'));
  assert(context.reasonCodes.includes('PRICE_BELOW_MA50'));
});

test('stale NIFTY, stale VIX, missing VIX, and insufficient history fail closed', () => {
  const sixtyCloses = Array.from({ length: 60 }, (_, index) => 100 + index);
  const cases = [
    [quoteSnapshot({ niftyFreshness: 'STALE' }), historySnapshot(sixtyCloses), 'NIFTY50_QUOTE_STALE'],
    [quoteSnapshot({ vixFreshness: 'STALE' }), historySnapshot(sixtyCloses), 'INDIA_VIX_STALE'],
    [quoteSnapshot({ includeVix: false }), historySnapshot(sixtyCloses), 'INDIA_VIX_UNAVAILABLE'],
    [quoteSnapshot(), historySnapshot(sixtyCloses.slice(0, 49)), 'INSUFFICIENT_NIFTY50_HISTORY'],
  ];
  cases.forEach(([quotes, history, reason]) => {
    const features = computeMarketContextFeatures({ quoteSnapshot: quotes, historicalSnapshot: history });
    const context = classifyDeterministicMarketContext(features);
    assert.equal(context.status, 'MARKET_CONTEXT_UNAVAILABLE');
    assert.equal(context.context, null);
    assert(features.reasonCodes.includes(reason), `missing ${reason}`);
  });
});

test('policy boundaries are explicit and inclusive where documented', () => {
  assert.equal(classifyDeterministicMarketContext(policyFeatures({ indiaVixCurrent: 20 })).context, 'CAUTIOUS');
  assert.equal(classifyDeterministicMarketContext(policyFeatures({ indiaVixCurrent: 25 })).context, 'HIGH_VOLATILITY');
  assert.equal(classifyDeterministicMarketContext(policyFeatures({ realizedVolatility20DayAnnualizedPct: 30 })).context, 'HIGH_VOLATILITY');
  assert.equal(classifyDeterministicMarketContext(policyFeatures({
    drawdownFromRecentHighPct: -10,
    return20DayPct: -5,
    priceVsMovingAverage50Pct: -0.01,
  })).context, 'RISK_OFF');
  assert.equal(classifyDeterministicMarketContext(policyFeatures({
    indiaVixCurrent: 19.99,
    drawdownFromRecentHighPct: -4.99,
    return20DayPct: -2.99,
    priceVsMovingAverage50Pct: 0.01,
    realizedVolatility20DayAnnualizedPct: 29.99,
  })).context, 'NORMAL');
});

test('hysteresis ignores duplicate observations and requires distinct worsening/recovery confirmations', () => {
  const initialCandidate = classifyDeterministicMarketContext(policyFeatures());
  const initial = applyMarketContextHysteresis(initialCandidate, null, new Date('2026-09-08T12:00:00Z'));
  assert.equal(initial.result.context, 'NORMAL');

  const cautiousOne = classifyDeterministicMarketContext({
    ...policyFeatures({ indiaVixCurrent: 20 }),
    observedAt: '2026-09-08T12:01:00.000Z',
  });
  const held = applyMarketContextHysteresis(cautiousOne, initial.state, new Date('2026-09-08T12:01:00Z'));
  assert.equal(held.result.context, 'NORMAL');
  assert.equal(held.result.hysteresis.confirmationsObserved, 1);

  const duplicate = applyMarketContextHysteresis(cautiousOne, held.state, new Date('2026-09-08T12:02:00Z'));
  assert.equal(duplicate.result.context, 'NORMAL');
  assert.equal(duplicate.result.hysteresis.status, 'DUPLICATE_OBSERVATION_IGNORED');
  assert.equal(duplicate.result.hysteresis.confirmationsObserved, 1);

  const cautiousTwo = { ...cautiousOne, observedAt: '2026-09-08T12:03:00.000Z' };
  const worsened = applyMarketContextHysteresis(cautiousTwo, duplicate.state, new Date('2026-09-08T12:03:00Z'));
  assert.equal(worsened.result.context, 'CAUTIOUS');

  let recoveryState = worsened.state;
  for (let confirmation = 1; confirmation <= 3; confirmation += 1) {
    const recovery = classifyDeterministicMarketContext({
      ...policyFeatures(),
      observedAt: `2026-09-08T12:0${3 + confirmation}:00.000Z`,
    });
    const transition = applyMarketContextHysteresis(recovery, recoveryState, new Date(`2026-09-08T12:0${3 + confirmation}:00Z`));
    recoveryState = transition.state;
    assert.equal(transition.result.context, confirmation < 3 ? 'CAUTIOUS' : 'NORMAL');
  }
});

test('unconfigured provider and provider failures never create a normal fallback or advance state', async () => {
  resetMarketContextProcessStateForTest();
  const providerNotConfigured = async () => ({
    status: 'PROVIDER_NOT_CONFIGURED',
    facts: [],
    candles: [],
    freshness: { status: 'UNKNOWN' },
    error: { code: 'PROVIDER_NOT_CONFIGURED' },
  });
  const unavailable = await getLiveMarketContext({ now: NOW }, {
    fetchBenchmarkQuotes: providerNotConfigured,
    fetchNiftyHistoricalCandles: providerNotConfigured,
    getCache: async () => null,
    setCache: async () => { throw new Error('must not write unavailable state'); },
  });
  assert.equal(unavailable.status, 'MARKET_CONTEXT_UNAVAILABLE');
  assert.equal(unavailable.context, null);
  assert(unavailable.reasonCodes.includes('PROVIDER_NOT_CONFIGURED'));
  assert.equal(unavailable.statePersistence, 'NOT_WRITTEN_UNAVAILABLE_OBSERVATION');

  const failed = await getLiveMarketContext({ now: NOW }, {
    fetchBenchmarkQuotes: async () => { throw new Error('quote outage'); },
    fetchNiftyHistoricalCandles: async () => { throw new Error('history outage'); },
    getCache: async () => null,
    setCache: async () => { throw new Error('must not write failed state'); },
  });
  assert.equal(failed.status, 'MARKET_CONTEXT_UNAVAILABLE');
  assert.equal(failed.context, null);
  assert(failed.reasonCodes.includes('MARKET_QUOTE_SOURCE_ERROR'));
  assert(failed.reasonCodes.includes('MARKET_HISTORY_SOURCE_ERROR'));
  assert.equal(failed.statePersistence, 'NOT_WRITTEN_UNAVAILABLE_OBSERVATION');
});

test('market snapshot preserves qualified failover diagnostics and selected-provider provenance', async () => {
  resetMarketContextProcessStateForTest();
  const selection = {
    attemptedProviders: ['NSE', 'UPSTOX'],
    selectedProvider: 'UPSTOX',
    providerFailures: [{ provider: 'NSE', reasonCodes: ['MARKET_HISTORY_SOURCE_ERROR'] }],
    fallbackUsed: true,
  };
  const pair = await getLiveMarketContext({ now: NOW }, {
    fetchQualifiedMarketContextSnapshots: async () => ({
      quoteSnapshot: { ...quoteSnapshot({ provider: 'UPSTOX' }), providerSelection: selection },
      historicalSnapshot: {
        ...historySnapshot(Array.from({ length: 60 }, (_, index) => 100 + index), { provider: 'UPSTOX' }),
        providerSelection: selection,
      },
      providerSelection: selection,
    }),
    getCache: async () => null,
    setCache: async () => false,
    persistDurableLkg: async () => ({ status: 'PERSISTED' }),
  });
  assert.equal(pair.marketSnapshot.providerSelection.selectedProvider, 'UPSTOX');
  assert.deepEqual(pair.marketSnapshot.providerSelection.attemptedProviders, ['NSE', 'UPSTOX']);
  assert.equal(pair.marketSnapshot.providerSelection.fallbackUsed, true);
  assert(pair.marketSnapshot.observedFacts.every(fact => fact.source.provider === 'UPSTOX'));
  assert(pair.marketSnapshot.provenance.sources.every(source => source.provider === 'UPSTOX'));
});

test('qualified market context survives hot-cache expiry through last-known-good recommendation reads', async () => {
  resetMarketContextProcessStateForTest();
  const values = new Map();
  const cache = {
    get: async key => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); return true; },
  };
  const qualified = await getLiveMarketContext({ now: NOW }, {
    fetchBenchmarkQuotes: async () => quoteSnapshot(),
    fetchNiftyHistoricalCandles: async () => historySnapshot(Array.from({ length: 60 }, (_, index) => 100 + index)),
    getCache: cache.get,
    setCache: cache.set,
  });
  assert.equal(qualified.status, 'MARKET_CONTEXT_AVAILABLE');
  assert.equal(qualified.recommendationUsability.status, 'USABLE');

  const recommendationRead = await getLatestQualifiedMarketContextForRecommendation({ now: NOW }, {
    getCache: cache.get,
  });
  assert.equal(recommendationRead.recommendationUsability.status, 'USABLE');
  assert.equal(recommendationRead.marketSnapshot.recoveredFromLastKnownGood, true);

  const unavailable = await getLiveMarketContext({ now: new Date('2026-09-08T12:05:00.000Z') }, {
    fetchBenchmarkQuotes: async () => { throw new Error('quote outage'); },
    fetchNiftyHistoricalCandles: async () => { throw new Error('history outage'); },
    getCache: cache.get,
    setCache: cache.set,
  });
  assert.equal(unavailable.recoveredFromLastKnownGood, true);
  assert.equal(unavailable.marketSnapshot.status, 'LAST_AVAILABLE');
  assert.equal(unavailable.recommendationUsability.status, 'USABLE');
});

test('partial live evidence uses one complete LKG snapshot instead of suppressing recovery or mixing epochs', async () => {
  resetMarketContextProcessStateForTest();
  const values = new Map();
  const cache = {
    get: async key => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); return true; },
  };
  const completeHistory = historySnapshot(Array.from({ length: 60 }, (_, index) => 100 + index));
  const qualified = await getLiveMarketContext({ now: NOW }, {
    fetchBenchmarkQuotes: async () => quoteSnapshot(),
    fetchNiftyHistoricalCandles: async () => completeHistory,
    getCache: cache.get,
    setCache: cache.set,
  });
  assert.equal(qualified.recommendationUsability.status, 'USABLE');

  const partialQuotes = quoteSnapshot({ includeVix: false, nifty: 999 });
  const recovered = await getLiveMarketContext({ now: new Date('2026-09-08T12:05:00.000Z') }, {
    fetchBenchmarkQuotes: async () => partialQuotes,
    fetchNiftyHistoricalCandles: async () => completeHistory,
    getCache: cache.get,
    setCache: cache.set,
  });

  assert.equal(recovered.recoveredFromLastKnownGood, true);
  assert.equal(recovered.marketSnapshot.status, 'LAST_AVAILABLE');
  assert.equal(recovered.marketSnapshot.observedFacts.find(fact => fact.key === 'nifty50Current').value, 160);
  assert.equal(recovered.marketSnapshot.provenance.sources[0].provider, 'NSE');
  assert(recovered.reasonCodes.includes('RECOVERED_LAST_KNOWN_GOOD'));
  assert(recovered.reasonCodes.includes('INDIA_VIX_UNAVAILABLE'));
});

test('qualified market context survives Redis and process-memory loss through durable observation recovery', async () => {
  resetMarketContextProcessStateForTest();
  let durableSnapshot = null;
  const qualified = await getLiveMarketContext({ now: NOW }, {
    fetchBenchmarkQuotes: async () => quoteSnapshot(),
    fetchNiftyHistoricalCandles: async () => historySnapshot(Array.from({ length: 60 }, (_, index) => 100 + index)),
    getCache: async () => null,
    setCache: async () => false,
    persistDurableLkg: async value => {
      durableSnapshot = value;
      return { status: 'PERSISTED' };
    },
  });
  assert.equal(qualified.recommendationUsability.status, 'USABLE');
  assert.ok(durableSnapshot?.marketContext?.marketSnapshot);

  resetMarketContextProcessStateForTest();
  const recovered = await getLatestQualifiedMarketContextForRecommendation({ now: new Date('2026-09-08T12:05:00.000Z') }, {
    getCache: async () => null,
    getDurableLkg: async () => durableSnapshot,
  });
  assert.equal(recovered.recoveredFromLastKnownGood, true);
  assert.equal(recovered.marketSnapshot.status, 'LAST_AVAILABLE');
  assert.equal(recovered.recommendationUsability.status, 'USABLE');
});

test('LKG with an unknown market session is not recommendation-usable inside the age window', async () => {
  const snapshot = {
    status: 'LAST_AVAILABLE',
    observedAt: '2026-09-07T00:00:00.000Z',
    marketSession: { status: 'UNKNOWN' },
    policyAvailability: 'AVAILABLE',
    policyOutput: { status: 'MARKET_CONTEXT_AVAILABLE' },
  };
  const result = await getLatestQualifiedMarketContextForRecommendation({ now: NOW }, {
    getCache: async () => ({ marketContext: { marketSnapshot: snapshot, reasonCodes: [] } }),
    getDurableLkg: async () => null,
  });
  assert.equal(result.recommendationUsability.status, 'NOT_USABLE');
  assert(result.recommendationUsability.reasonCodes.includes('MARKET_SESSION_UNVERIFIED'));
});

test('future-dated LKG market evidence is not recommendation-usable', async () => {
  const snapshot = {
    status: 'LAST_AVAILABLE',
    observedAt: '2026-09-08T12:00:01.000Z',
    marketSession: { status: 'MARKET_CLOSED' },
    policyAvailability: 'AVAILABLE',
    policyOutput: { status: 'MARKET_CONTEXT_AVAILABLE' },
  };
  const result = await getLatestQualifiedMarketContextForRecommendation({ now: NOW }, {
    getCache: async () => ({ marketContext: { marketSnapshot: snapshot, reasonCodes: [] } }),
    getDurableLkg: async () => null,
  });
  assert.equal(result.recommendationUsability.status, 'NOT_USABLE');
});
