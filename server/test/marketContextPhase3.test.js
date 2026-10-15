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
  buildMarketSnapshot,
  getLiveMarketContext,
  getLatestQualifiedMarketContextForRecommendation,
  resetMarketContextProcessStateForTest,
} from '../services/marketContextService.js';
import { MARKET_BENCHMARKS } from '../services/marketData/marketBenchmarks.js';
import { createMarketDataTestFixtureRightsCapability } from '../services/marketData/marketDataTestFixtures.js';
import {
  buildNseHistoricalIndexRequestUrl,
  buildUpstoxQuoteRequestUrl,
} from '../services/marketData/marketDataSourceUrls.js';

const NOW = new Date('2026-09-08T12:00:00.000Z');
const TEST_MARKET_DATA_RIGHTS_CAPABILITY = createMarketDataTestFixtureRightsCapability({
  env: { NODE_ENV: 'test' },
  transport: { get: async () => ({ data: null }) },
});
const NIFTY = 'NSE_INDEX|Nifty 50';
const VIX = 'NSE_INDEX|India VIX';

function quoteFact(instrumentId, canonicalProductId, value, {
  previousClose = null,
  freshness = 'FRESH',
  provider = 'NSE',
  sourceUrl = null,
} = {}) {
  return {
    canonicalProductId,
    value,
    availabilityStatus: 'AVAILABLE',
    observedAt: '2026-09-08T11:59:00.000Z',
    fetchedAt: NOW.toISOString(),
    dataClass: 'LIVE',
    freshness: { status: freshness, ageSeconds: 60, maxAgeSeconds: 900 },
    source: {
      provider,
      instrumentId: provider === 'NSE'
        ? canonicalProductId === MARKET_BENCHMARKS.INDIA_VIX.canonicalProductId
          ? MARKET_BENCHMARKS.INDIA_VIX.nseIndexName
          : MARKET_BENCHMARKS.NIFTY_50.nseIndexName
        : instrumentId,
      url: sourceUrl || (provider === 'NSE'
        ? 'https://www.nseindia.com/api/allIndices'
        : buildUpstoxQuoteRequestUrl([NIFTY, VIX])),
    },
    metrics: { previousClose },
  };
}

function quoteSnapshot({ nifty = 160, previousClose = 159, vix = 14, niftyFreshness = 'FRESH', vixFreshness = 'FRESH', includeVix = true, provider = 'NSE' } = {}) {
  const sourceUrl = provider === 'NSE'
    ? 'https://www.nseindia.com/api/allIndices'
    : buildUpstoxQuoteRequestUrl(includeVix ? [NIFTY, VIX] : [NIFTY]);
  return {
    status: 'AVAILABLE',
    marketSession: { status: 'MARKET_CLOSED', tradingDate: '2026-09-08' },
    ...(provider === 'NSE' ? { calendar: {
      status: 'AVAILABLE',
      source: { provider: 'NSE', url: 'https://www.nseindia.com/api/holiday-master?type=trading' },
      fetchedAt: NOW.toISOString(),
    } } : {}),
    facts: [
      quoteFact(NIFTY, MARKET_BENCHMARKS.NIFTY_50.canonicalProductId, nifty, {
        previousClose, freshness: niftyFreshness, provider, sourceUrl,
      }),
      ...(includeVix ? [quoteFact(VIX, MARKET_BENCHMARKS.INDIA_VIX.canonicalProductId, vix, {
        freshness: vixFreshness, provider, sourceUrl,
      })] : []),
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
    source: {
      provider,
      instrumentId: provider === 'UPSTOX' ? NIFTY : 'NIFTY 50',
      url: provider === 'NSE'
        ? 'https://www.nseindia.com/api/historicalOR/indicesHistory'
        : 'https://api.upstox.com/v3/historical-candle/NSE_INDEX%7CNifty%2050/days/1/2026-09-08/2026-06-01',
      ...(provider === 'NSE' ? { requestUrls: [buildNseHistoricalIndexRequestUrl({
        indexType: 'NIFTY 50', from: '01-06-2026', to: '30-07-2026',
      })] } : {}),
    },
    ...(provider === 'NSE' ? { calendar: {
      status: 'AVAILABLE',
      source: { provider: 'NSE', url: 'https://www.nseindia.com/api/holiday-master?type=trading' },
      fetchedAt: NOW.toISOString(),
    } } : {}),
    candles: closes.map((close, index) => ({
      timestamp: new Date(start + index * 86400000).toISOString(),
      open: close,
      high: close + 1,
      low: close - 1,
      close,
    })),
  };
}

function buildQualifiedSnapshot({ session = 'MARKET_CLOSED', observedAt = '2026-09-08T11:59:00.000Z' } = {}) {
  const quotes = quoteSnapshot();
  quotes.marketSession = { status: session, tradingDate: '2026-09-08', checkedAt: NOW.toISOString() };
  const originalObservedAt = quotes.facts[0].observedAt;
  quotes.facts = quotes.facts.map(fact => ({ ...fact, observedAt: originalObservedAt }));
  const history = historySnapshot(Array.from({ length: 60 }, (_, index) => 100 + index));
  const features = computeMarketContextFeatures({ quoteSnapshot: quotes, historicalSnapshot: history });
  return buildMarketSnapshot({
    quoteSnapshot: quotes,
    historicalSnapshot: history,
    features,
    policy: {
      status: 'MARKET_CONTEXT_AVAILABLE',
      context: 'NORMAL',
      classification: MARKET_CONTEXT_CLASSIFICATION,
      policyVersion: MARKET_CONTEXT_POLICY_VERSION,
      reasonCodes: [],
      observedAt,
      sources: features.sources,
    },
    evaluatedAt: NOW.toISOString(),
    now: NOW,
  });
}

function buildFixtureMarketSnapshot(quotes, history) {
  const features = computeMarketContextFeatures({ quoteSnapshot: quotes, historicalSnapshot: history });
  return buildMarketSnapshot({
    quoteSnapshot: quotes,
    historicalSnapshot: history,
    features,
    policy: {
      status: 'MARKET_CONTEXT_AVAILABLE',
      context: 'NORMAL',
      classification: MARKET_CONTEXT_CLASSIFICATION,
      policyVersion: MARKET_CONTEXT_POLICY_VERSION,
      reasonCodes: [],
      observedAt: '2026-09-08T11:59:00.000Z',
      sources: features.sources,
    },
    evaluatedAt: NOW.toISOString(),
    now: NOW,
  });
}

async function assertLkgRejectsSourceIdentity(snapshot) {
  const result = await getLatestQualifiedMarketContextForRecommendation({ now: NOW }, {
    marketDataTestFixtureRightsCapability: TEST_MARKET_DATA_RIGHTS_CAPABILITY,
    getCache: async () => ({ marketContext: { marketSnapshot: snapshot, reasonCodes: [] } }),
    getDurableLkg: async () => null,
  });
  assert.equal(result.status, 'MARKET_CONTEXT_UNAVAILABLE');
  assert(result.reasonCodes.includes('MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED'));
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
    marketDataTestFixtureRightsCapability: TEST_MARKET_DATA_RIGHTS_CAPABILITY,
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

test('available injected market observations without exact source provenance cannot reach policy or persistence', async () => {
  resetMarketContextProcessStateForTest();
  const validQuotes = quoteSnapshot();
  const validHistory = historySnapshot(Array.from({ length: 60 }, (_, index) => 100 + index));
  const quotesWithoutSource = {
    ...validQuotes,
    provider: null,
    facts: validQuotes.facts.map(({ source: _source, sourceProvider: _sourceProvider, ...fact }) => fact),
  };
  const historyWithWrongHost = {
    ...validHistory,
    source: { ...validHistory.source, url: 'https://unregistered.invalid/api/historicalOR/indicesHistory' },
  };
  const result = await getLiveMarketContext({ now: NOW }, {
    marketDataTestFixtureRightsCapability: TEST_MARKET_DATA_RIGHTS_CAPABILITY,
    fetchBenchmarkQuotes: async () => quotesWithoutSource,
    fetchNiftyHistoricalCandles: async () => historyWithWrongHost,
    env: { NODE_ENV: 'test' },
    getCache: async () => null,
    setCache: async () => { assert.fail('source-unverified evidence must not advance hysteresis'); },
    persistDurableLkg: async () => { assert.fail('source-unverified evidence must not be persisted'); },
  });

  assert.equal(result.status, 'MARKET_CONTEXT_UNAVAILABLE');
  assert.equal(result.context, null);
  assert(result.reasonCodes.includes('MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED'));
  assert.deepEqual(result.marketSnapshot.provenance.sources, []);
});

test('mixed quote and history providers cannot reach policy, hysteresis, or LKG writes', async () => {
  resetMarketContextProcessStateForTest();
  const mixed = await getLiveMarketContext({ now: NOW }, {
    marketDataTestFixtureRightsCapability: TEST_MARKET_DATA_RIGHTS_CAPABILITY,
    fetchQualifiedMarketContextSnapshots: async () => ({
      quoteSnapshot: quoteSnapshot({ provider: 'NSE' }),
      historicalSnapshot: historySnapshot(
        Array.from({ length: 60 }, (_, index) => 100 + index),
        { provider: 'UPSTOX' },
      ),
      providerSelection: {
        attemptedProviders: ['NSE', 'UPSTOX'],
        selectedProvider: 'NSE',
        providerFailures: [],
        fallbackUsed: false,
      },
    }),
    getLkgCache: async () => null,
    getDurableLkg: async () => null,
    getCache: async () => null,
    setCache: async () => { assert.fail('mixed-source evidence must not advance hysteresis'); },
    persistDurableLkg: async () => { assert.fail('mixed-source evidence must not be persisted'); },
    setLkgCache: async () => { assert.fail('mixed-source evidence must not be cached as LKG'); },
  });

  assert.equal(mixed.status, 'MARKET_CONTEXT_UNAVAILABLE');
  assert.equal(mixed.context, null);
  assert(mixed.reasonCodes.includes('MARKET_PROVIDER_PAIR_MISMATCH'));
  assert.equal(mixed.statePersistence, 'NOT_WRITTEN_UNAVAILABLE_OBSERVATION');
});

test('production context reads suppress live Upstox evidence when distribution is unconfirmed', async () => {
  resetMarketContextProcessStateForTest();
  const selection = {
    attemptedProviders: ['UPSTOX'],
    selectedProvider: 'UPSTOX',
    providerFailures: [],
    fallbackUsed: false,
  };
  const suppressed = await getLiveMarketContext({ now: NOW }, {
    env: { NODE_ENV: 'production', UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED: 'false' },
    fetchQualifiedMarketContextSnapshots: async () => ({
      quoteSnapshot: { ...quoteSnapshot({ provider: 'UPSTOX' }), providerSelection: selection },
      historicalSnapshot: {
        ...historySnapshot(Array.from({ length: 60 }, (_, index) => 100 + index), { provider: 'UPSTOX' }),
        providerSelection: selection,
      },
      providerSelection: selection,
    }),
    getCache: async () => null,
    getDurableLkg: async () => null,
    setCache: async () => { assert.fail('unavailable Upstox evidence must not advance hysteresis'); },
    persistDurableLkg: async () => { assert.fail('blocked Upstox evidence must not be persisted'); },
  });

  assert.equal(suppressed.status, 'MARKET_CONTEXT_UNAVAILABLE');
  assert.equal(suppressed.context, null);
  assert(suppressed.reasonCodes.includes('MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED'));
  assert(suppressed.marketSnapshot.observedFacts.every(fact => (
    fact.value === null && fact.source === null && fact.availabilityStatus === 'UNAVAILABLE'
  )));
  assert.deepEqual(suppressed.marketSnapshot.provenance.sources, []);
  assert.equal(suppressed.marketSnapshot.providerStatus.quotes.provider, null);
});

test('production recommendation reads do not reuse an Upstox-derived last-known-good snapshot', async () => {
  resetMarketContextProcessStateForTest();
  const result = await getLatestQualifiedMarketContextForRecommendation({ now: NOW }, {
    env: { NODE_ENV: 'production', UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED: 'false' },
    getCache: async () => ({ marketContext: {
      status: 'MARKET_CONTEXT_AVAILABLE',
      context: 'RISK_OFF',
      reasonCodes: [],
      marketSnapshot: {
        status: 'LAST_AVAILABLE',
        observedAt: '2026-09-08T11:59:00.000Z',
        providerSelection: { selectedProvider: 'UPSTOX' },
        providerStatus: {
          quotes: { provider: 'UPSTOX', status: 'AVAILABLE' },
          history: { provider: 'UPSTOX', status: 'AVAILABLE' },
        },
        observedFacts: [{ value: 25000, source: { provider: 'UPSTOX' } }],
      },
    } }),
    getDurableLkg: async () => null,
  });

  assert.equal(result.status, 'MARKET_CONTEXT_UNAVAILABLE');
  assert.equal(result.context, null);
  assert(result.reasonCodes.includes('MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED'));
  assert.deepEqual(result.marketSnapshot.observedFacts, []);
  assert.equal(result.marketSnapshot.status, 'UNAVAILABLE');
});

test('qualified market context survives hot-cache expiry through last-known-good recommendation reads', async () => {
  resetMarketContextProcessStateForTest();
  const values = new Map();
  const cache = {
    get: async key => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); return true; },
  };
  const qualified = await getLiveMarketContext({ now: NOW }, {
    marketDataTestFixtureRightsCapability: TEST_MARKET_DATA_RIGHTS_CAPABILITY,
    fetchBenchmarkQuotes: async () => quoteSnapshot(),
    fetchNiftyHistoricalCandles: async () => historySnapshot(Array.from({ length: 60 }, (_, index) => 100 + index)),
    getCache: cache.get,
    setCache: cache.set,
  });
  assert.equal(qualified.status, 'MARKET_CONTEXT_AVAILABLE');
  assert.equal(qualified.recommendationUsability.status, 'USABLE');

  const recommendationRead = await getLatestQualifiedMarketContextForRecommendation({ now: NOW }, {
    marketDataTestFixtureRightsCapability: TEST_MARKET_DATA_RIGHTS_CAPABILITY,
    getCache: cache.get,
  });
  assert.equal(recommendationRead.recommendationUsability.status, 'USABLE');
  assert.equal(recommendationRead.marketSnapshot.recoveredFromLastKnownGood, true);

  const unavailable = await getLiveMarketContext({ now: new Date('2026-09-08T12:05:00.000Z') }, {
    marketDataTestFixtureRightsCapability: TEST_MARKET_DATA_RIGHTS_CAPABILITY,
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
    marketDataTestFixtureRightsCapability: TEST_MARKET_DATA_RIGHTS_CAPABILITY,
    fetchBenchmarkQuotes: async () => quoteSnapshot(),
    fetchNiftyHistoricalCandles: async () => completeHistory,
    getCache: cache.get,
    setCache: cache.set,
  });
  assert.equal(qualified.recommendationUsability.status, 'USABLE');

  const partialQuotes = quoteSnapshot({ includeVix: false, nifty: 999 });
  const recovered = await getLiveMarketContext({ now: new Date('2026-09-08T12:05:00.000Z') }, {
    marketDataTestFixtureRightsCapability: TEST_MARKET_DATA_RIGHTS_CAPABILITY,
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
    marketDataTestFixtureRightsCapability: TEST_MARKET_DATA_RIGHTS_CAPABILITY,
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
    marketDataTestFixtureRightsCapability: TEST_MARKET_DATA_RIGHTS_CAPABILITY,
    getCache: async () => null,
    getDurableLkg: async () => durableSnapshot,
  });
  assert.equal(recovered.recoveredFromLastKnownGood, true);
  assert.equal(recovered.marketSnapshot.status, 'LAST_AVAILABLE');
  assert.equal(recovered.recommendationUsability.status, 'USABLE');
});

test('LKG with an unknown market session is not recommendation-usable inside the age window', async () => {
  const snapshot = buildQualifiedSnapshot({ session: 'UNKNOWN' });
  const result = await getLatestQualifiedMarketContextForRecommendation({ now: NOW }, {
    marketDataTestFixtureRightsCapability: TEST_MARKET_DATA_RIGHTS_CAPABILITY,
    getCache: async () => ({ marketContext: { marketSnapshot: snapshot, reasonCodes: [] } }),
    getDurableLkg: async () => null,
  });
  assert.equal(result.recommendationUsability.status, 'NOT_USABLE');
  assert(result.recommendationUsability.reasonCodes.includes('MARKET_SESSION_UNVERIFIED'));
});

test('future-dated LKG market evidence is not recommendation-usable', async () => {
  const snapshot = buildQualifiedSnapshot({ observedAt: '2026-09-08T12:00:01.000Z' });
  const result = await getLatestQualifiedMarketContextForRecommendation({ now: NOW }, {
    marketDataTestFixtureRightsCapability: TEST_MARKET_DATA_RIGHTS_CAPABILITY,
    getCache: async () => ({ marketContext: { marketSnapshot: snapshot, reasonCodes: [] } }),
    getDurableLkg: async () => null,
  });
  assert.equal(result.recommendationUsability.status, 'NOT_USABLE');
  assert.deepEqual(result.recommendationUsability.reasonCodes, ['MARKET_SNAPSHOT_NOT_CURRENT_OR_LAST_AVAILABLE']);
});

test('LKG rejects forged visible fact provenance even when its content digest is recomputed', async () => {
  const baseQuotes = quoteSnapshot();
  const history = historySnapshot(Array.from({ length: 60 }, (_, index) => 100 + index));
  const baseFeatures = computeMarketContextFeatures({ quoteSnapshot: baseQuotes, historicalSnapshot: history });
  const forgedFeatures = {
    ...baseFeatures,
    observedFacts: baseFeatures.observedFacts.map((fact, index) => index === 0
      ? { ...fact, source: { ...fact.source, url: 'https://attacker.invalid/api/allIndices' } }
      : fact),
  };
  const snapshot = buildMarketSnapshot({
    quoteSnapshot: baseQuotes,
    historicalSnapshot: history,
    features: forgedFeatures,
    policy: {
      status: 'MARKET_CONTEXT_AVAILABLE',
      context: 'NORMAL',
      classification: MARKET_CONTEXT_CLASSIFICATION,
      policyVersion: MARKET_CONTEXT_POLICY_VERSION,
      reasonCodes: [],
      observedAt: '2026-09-08T11:59:00.000Z',
      sources: baseFeatures.sources,
    },
    evaluatedAt: NOW.toISOString(),
    now: NOW,
  });
  const result = await getLatestQualifiedMarketContextForRecommendation({ now: NOW }, {
    marketDataTestFixtureRightsCapability: TEST_MARKET_DATA_RIGHTS_CAPABILITY,
    getCache: async () => ({ marketContext: { marketSnapshot: snapshot, reasonCodes: [] } }),
    getDurableLkg: async () => null,
  });
  assert.equal(result.status, 'MARKET_CONTEXT_UNAVAILABLE');
  assert(result.reasonCodes.includes('MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED'));
});

test('LKG rejects visible fact mutations that no longer match the stored content revision', async () => {
  const snapshot = buildQualifiedSnapshot();
  snapshot.observedFacts[0].value += 1;
  const result = await getLatestQualifiedMarketContextForRecommendation({ now: NOW }, {
    marketDataTestFixtureRightsCapability: TEST_MARKET_DATA_RIGHTS_CAPABILITY,
    getCache: async () => ({ marketContext: { marketSnapshot: snapshot, reasonCodes: [] } }),
    getDurableLkg: async () => null,
  });
  assert.equal(result.status, 'MARKET_CONTEXT_UNAVAILABLE');
  assert(result.reasonCodes.includes('MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED'));
});

test('LKG rejects forged NSE calendar provenance even when its content digest is recomputed', async () => {
  const quotes = quoteSnapshot();
  const history = historySnapshot(Array.from({ length: 60 }, (_, index) => 100 + index));
  const baseFeatures = computeMarketContextFeatures({ quoteSnapshot: quotes, historicalSnapshot: history });
  const forgedFeatures = {
    ...baseFeatures,
    providerStatus: {
      ...baseFeatures.providerStatus,
      quotes: {
        ...baseFeatures.providerStatus.quotes,
        calendar: {
          ...baseFeatures.providerStatus.quotes.calendar,
          source: { provider: 'NSE', url: 'https://attacker.invalid/api/holiday-master?type=trading' },
        },
      },
    },
  };
  const snapshot = buildMarketSnapshot({
    quoteSnapshot: quotes,
    historicalSnapshot: history,
    features: forgedFeatures,
    policy: {
      status: 'MARKET_CONTEXT_AVAILABLE',
      context: 'NORMAL',
      classification: MARKET_CONTEXT_CLASSIFICATION,
      policyVersion: MARKET_CONTEXT_POLICY_VERSION,
      reasonCodes: [],
      observedAt: '2026-09-08T11:59:00.000Z',
      sources: baseFeatures.sources,
    },
    evaluatedAt: NOW.toISOString(),
    now: NOW,
  });
  const result = await getLatestQualifiedMarketContextForRecommendation({ now: NOW }, {
    marketDataTestFixtureRightsCapability: TEST_MARKET_DATA_RIGHTS_CAPABILITY,
    getCache: async () => ({ marketContext: { marketSnapshot: snapshot, reasonCodes: [] } }),
    getDurableLkg: async () => null,
  });
  assert.equal(result.status, 'MARKET_CONTEXT_UNAVAILABLE');
  assert(result.reasonCodes.includes('MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED'));
});

test('LKG requires the historical source summary to bind its query URLs to the canonical NSE endpoint', async () => {
  const quotes = quoteSnapshot();
  const history = historySnapshot(Array.from({ length: 60 }, (_, index) => 100 + index));
  const baseFeatures = computeMarketContextFeatures({ quoteSnapshot: quotes, historicalSnapshot: history });
  const forgedSources = baseFeatures.sources.map(source => source.instrumentId === 'NIFTY 50'
    && source.requestUrls
    ? { ...source, url: 'https://attacker.invalid/api/historicalOR/indicesHistory' }
    : source);
  const forgedFeatures = {
    ...baseFeatures,
    sources: forgedSources,
    derivedFacts: baseFeatures.derivedFacts.map(fact => ({
      ...fact,
      provenance: { ...fact.provenance, evidence: forgedSources },
    })),
  };
  const snapshot = buildMarketSnapshot({
    quoteSnapshot: quotes,
    historicalSnapshot: history,
    features: forgedFeatures,
    policy: {
      status: 'MARKET_CONTEXT_AVAILABLE',
      context: 'NORMAL',
      classification: MARKET_CONTEXT_CLASSIFICATION,
      policyVersion: MARKET_CONTEXT_POLICY_VERSION,
      reasonCodes: [],
      observedAt: '2026-09-08T11:59:00.000Z',
      sources: forgedSources,
    },
    evaluatedAt: NOW.toISOString(),
    now: NOW,
  });
  const result = await getLatestQualifiedMarketContextForRecommendation({ now: NOW }, {
    marketDataTestFixtureRightsCapability: TEST_MARKET_DATA_RIGHTS_CAPABILITY,
    getCache: async () => ({ marketContext: { marketSnapshot: snapshot, reasonCodes: [] } }),
    getDurableLkg: async () => null,
  });
  assert.equal(result.status, 'MARKET_CONTEXT_UNAVAILABLE');
  assert(result.reasonCodes.includes('MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED'));
});

test('LKG binds each observed quote key to its canonical NSE instrument identity', async () => {
  const quotes = quoteSnapshot();
  quotes.facts = quotes.facts.map(fact => fact.canonicalProductId === MARKET_BENCHMARKS.NIFTY_50.canonicalProductId
    ? { ...fact, source: { ...fact.source, instrumentId: MARKET_BENCHMARKS.INDIA_VIX.nseIndexName } }
    : fact);
  const history = historySnapshot(Array.from({ length: 60 }, (_, index) => 100 + index));

  await assertLkgRejectsSourceIdentity(buildFixtureMarketSnapshot(quotes, history));
});

test('LKG requires NSE historical evidence to identify and query NIFTY 50', async () => {
  const quotes = quoteSnapshot();
  const history = historySnapshot(Array.from({ length: 60 }, (_, index) => 100 + index));
  history.source = {
    ...history.source,
    instrumentId: MARKET_BENCHMARKS.INDIA_VIX.nseIndexName,
    requestUrls: [buildNseHistoricalIndexRequestUrl({
      indexType: MARKET_BENCHMARKS.INDIA_VIX.nseIndexName,
      from: '01-06-2026',
      to: '30-07-2026',
    })],
  };

  await assertLkgRejectsSourceIdentity(buildFixtureMarketSnapshot(quotes, history));
});

test('LKG requires Upstox historical evidence to identify the NIFTY 50 instrument key', async () => {
  const quotes = quoteSnapshot({ provider: 'UPSTOX' });
  const history = historySnapshot(Array.from({ length: 60 }, (_, index) => 100 + index), { provider: 'UPSTOX' });
  const vixKey = MARKET_BENCHMARKS.INDIA_VIX.upstoxInstrumentKey;
  history.source = {
    ...history.source,
    instrumentId: vixKey,
    url: `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(vixKey)}/days/1/2026-09-08/2026-06-01`,
  };

  await assertLkgRejectsSourceIdentity(buildFixtureMarketSnapshot(quotes, history));
});
