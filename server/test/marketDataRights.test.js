import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import axios from 'axios';
import {
  fetchAmfiHistoricalNavSnapshot,
  fetchAmfiProductSnapshot,
  fetchBenchmarkQuotes,
  fetchGovernmentSavingsSnapshot,
  fetchNiftyHistoricalCandles,
  fetchQualifiedEquityHistory,
  fetchQualifiedMarketContextSnapshots,
  fetchRbiFloatingRateSavingsBondSnapshot,
  fetchSbiTermDepositSnapshot,
  fetchPrivateMarketDemoData,
  fetchTejHqCorporateActionEvidence,
  fetchTejHqProviderPublicationStatus,
  fetchUpstoxCanonicalQuotes,
} from '../services/marketDataService.js';
import { getLatestQualifiedMarketContextForRecommendation } from '../services/marketContextService.js';
import {
  assertMarketDataQualificationRights,
  createPrivateMarketDataDemoCapability,
  evaluateMarketDataProductionRights,
  isMarketDataPrivateDemoUseAllowed,
  isMarketDataProductionUseAllowed,
  MARKET_DATA_PRIVATE_DEMO_ENV,
} from '../services/marketData/marketDataRights.js';
import { createMarketDataTestFixtureRightsCapability } from '../services/marketData/marketDataTestFixtures.js';
import UpstoxMarketDataProvider from '../services/marketData/UpstoxMarketDataProvider.js';
import UpstoxHistoricalCandleProvider from '../services/marketData/UpstoxHistoricalCandleProvider.js';
import AmfiNavProvider from '../services/marketData/AmfiNavProvider.js';
import AmfiNavHistoryProvider from '../services/marketData/AmfiNavHistoryProvider.js';
import NseMarketDataProvider from '../services/marketData/NseMarketDataProvider.js';
import NseHistoricalDataProvider from '../services/marketData/NseHistoricalDataProvider.js';
import TejHqHistoricalDataProvider from '../services/marketData/TejHqHistoricalDataProvider.js';
import SbiTermDepositProvider from '../services/marketData/SbiTermDepositProvider.js';
import RbiFloatingRateSavingsBondProvider from '../services/marketData/RbiFloatingRateSavingsBondProvider.js';
import { fetchNseTradingHolidays } from '../services/marketData/nseTradingCalendar.js';
import { AMFI_NAV_URL } from '../services/marketData/AmfiNavProvider.js';
import { AMFI_NAV_HISTORY_URL } from '../services/marketData/AmfiNavHistoryProvider.js';
import { NSE_ALL_INDICES_URL } from '../services/marketData/NseMarketDataProvider.js';
import {
  NSE_HISTORICAL_INDEX_RIGHTS_URL,
  NSE_HISTORICAL_INDEX_URL,
} from '../services/marketData/NseHistoricalDataProvider.js';
import GovernmentSmallSavingsProvider, {
  INDIA_POST_SAVINGS_URL,
  INDIA_POST_SCRIPT_CHUNK_RIGHTS_URL,
} from '../services/marketData/GovernmentSmallSavingsProvider.js';
import { SBI_TERM_DEPOSIT_URL } from '../services/marketData/SbiTermDepositProvider.js';
import { RBI_FRSB_NOTIFICATION_URL } from '../services/marketData/RbiFloatingRateSavingsBondProvider.js';
import { buildNseHistoricalIndexRequestUrl, buildUpstoxQuoteRequestUrl, UPSTOX_QUOTE_RIGHTS_URL } from '../services/marketData/marketDataSourceUrls.js';
import { matchesSourceRightsEndpoint } from '../services/postTaxSourceRights.js';

const production = { NODE_ENV: 'production' };
const productionWithOperatorFlags = {
  NODE_ENV: 'production',
  UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED: 'true',
  TEJHQ_ENABLED: 'true',
  TEJHQ_LICENSE_CONFIRMED: 'true',
  TEJHQ_HISTORICAL_FALLBACK_ENABLED: 'true',
  TEJHQ_ADJUSTED_HISTORY_ENABLED: 'true',
  TEJHQ_CORPORATE_ACTIONS_ENABLED: 'true',
};

test('market-data source-rights decisions are exact and fail closed for blocked or unregistered endpoints', () => {
  assert.equal(evaluateMarketDataProductionRights('AMFI', AMFI_NAV_URL).status, 'BLOCKED_REUSE_RIGHTS');
  assert.equal(evaluateMarketDataProductionRights('AMFI', AMFI_NAV_HISTORY_URL).productionUseAllowed, false);
  assert.equal(evaluateMarketDataProductionRights('GOVERNMENT_OF_INDIA', INDIA_POST_SAVINGS_URL).productionUseAllowed, false);
  assert.equal(evaluateMarketDataProductionRights('GOVERNMENT_OF_INDIA', INDIA_POST_SCRIPT_CHUNK_RIGHTS_URL).productionUseAllowed, false);
  assert.equal(evaluateMarketDataProductionRights('SBI', SBI_TERM_DEPOSIT_URL).status, 'BLOCKED_REUSE_RIGHTS');
  assert.equal(evaluateMarketDataProductionRights('RBI', RBI_FRSB_NOTIFICATION_URL).status, 'LICENSE_UNVERIFIED');
  assert.equal(evaluateMarketDataProductionRights('NSE', NSE_ALL_INDICES_URL).status, 'LICENSE_UNVERIFIED');
  assert.equal(evaluateMarketDataProductionRights('NSE', NSE_HISTORICAL_INDEX_URL).productionUseAllowed, false);
  assert.equal(evaluateMarketDataProductionRights('AMFI', 'https://portal.amfiindia.com/unqualified').productionUseAllowed, false);
});

test('Upstox service facade cannot be enabled by operator attestation without qualified endpoint rights', async () => {
  let providerCalls = 0;
  const snapshot = await fetchUpstoxCanonicalQuotes(['market:index:nifty-50'], {
    env: productionWithOperatorFlags,
    upstoxMarketDataProvider: { getQuotes: async () => { providerCalls += 1; return { status: 'AVAILABLE', facts: [] }; } },
  });
  assert.equal(providerCalls, 0);
  assert.equal(snapshot.status, 'UNAVAILABLE');
  assert.equal(snapshot.error.code, 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
  assert.equal(snapshot.availableFactCount, null);
  assert.equal(snapshot.facts[0].value, null);
});

test('market-data rights require source approval in every environment except explicit injected test fixtures', () => {
  for (const env of [
    { NODE_ENV: 'staging' },
    { NODE_ENV: 'preview' },
    { NODE_ENV: 'production' },
    {},
  ]) {
    assert.equal(isMarketDataProductionUseAllowed('NSE', NSE_ALL_INDICES_URL, env), false);
  }
  assert.equal(isMarketDataProductionUseAllowed('NSE', NSE_ALL_INDICES_URL, { NODE_ENV: 'development' }), false);
  assert.equal(isMarketDataProductionUseAllowed('NSE', NSE_ALL_INDICES_URL, { NODE_ENV: 'test' }), false);
  const fixtureCapability = createMarketDataTestFixtureRightsCapability({
    env: { NODE_ENV: 'test' },
      transport: { get: async () => ({ data: null }) },
  });
  assert.ok(fixtureCapability);
  assert.equal(isMarketDataProductionUseAllowed('NSE', NSE_ALL_INDICES_URL, { NODE_ENV: 'test' }, fixtureCapability), true);
  assert.equal(isMarketDataProductionUseAllowed('NSE', NSE_ALL_INDICES_URL, production, fixtureCapability), false);
  assert.equal(createMarketDataTestFixtureRightsCapability({
    env: { NODE_ENV: 'test' },
  }), null, 'test mode alone cannot obtain a fixture capability');
});

test('private demo capability is authenticated, loopback-only, development-only, and separate from production rights', () => {
  const env = {
    NODE_ENV: 'development',
    [MARKET_DATA_PRIVATE_DEMO_ENV]: 'true',
    TEJHQ_PRIVATE_DEMO_ENABLED: 'true',
  };
  const makeRequest = ({ host = '127.0.0.1:5000', remoteAddress = '::ffff:127.0.0.1', userId = 'user-1' } = {}) => ({
    get: () => host,
    socket: { remoteAddress },
    user: userId ? { userId } : null,
  });
  const capability = createPrivateMarketDataDemoCapability(makeRequest(), env);
  assert.ok(capability);
  const quoteUrl = buildUpstoxQuoteRequestUrl(['NSE_INDEX|Nifty 50', 'NSE_INDEX|India VIX']);
  assert.equal(isMarketDataPrivateDemoUseAllowed('UPSTOX', quoteUrl, env, capability), true);
  assert.equal(isMarketDataProductionUseAllowed('UPSTOX', quoteUrl, env), false);
  assert.equal(isMarketDataPrivateDemoUseAllowed('TEJHQ', 'https://api.tejhq.dev/v1/ohlcv/nse/INFY?from=2026-10-01&to=2026-10-10', env, capability), false,
    'loopback and operator flags do not replace an exact TejHQ rights record');
  assert.equal(isMarketDataPrivateDemoUseAllowed('TEJHQ', 'https://api.tejhq.dev/v1/unknown', env, capability), false);
  assert.equal(createPrivateMarketDataDemoCapability(makeRequest({ userId: null }), env), null);
  assert.equal(createPrivateMarketDataDemoCapability(makeRequest({ remoteAddress: '203.0.113.9' }), env), null);
  assert.equal(createPrivateMarketDataDemoCapability(makeRequest(), { ...env, NODE_ENV: 'production' }), null);
  assert.equal(createPrivateMarketDataDemoCapability(makeRequest(), { ...env, [MARKET_DATA_PRIVATE_DEMO_ENV]: 'false' }), null);
});

test('market-data fixture capability requires the exact injected provider transport', async () => {
  let axiosCalls = 0;
  const originalGet = axios.get;
  axios.get = async () => { axiosCalls += 1; return { data: {} }; };
  try {
    const decoyTransport = { get: async () => ({ data: {} }) };
    const historyProvider = new NseHistoricalDataProvider({
      env: { NODE_ENV: 'test' },
      testFixtureTransport: decoyTransport,
    });
    const snapshot = await historyProvider.getDailyCandles('market:index:nifty-50', {
      fromDate: '2026-10-01', toDate: '2026-10-02',
    });
    assert.equal(snapshot.status, 'UNAVAILABLE');
    assert.equal(snapshot.error.code, 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
    assert.equal(axiosCalls, 0);

    let fixtureCalls = 0;
    const injectedHttpClient = { get: async () => { fixtureCalls += 1; return { data: {} }; } };
    const actualFixture = new NseHistoricalDataProvider({
      env: { NODE_ENV: 'test' },
      httpClient: injectedHttpClient,
    });
  assert.equal(actualFixture.httpClient, injectedHttpClient);
  const fixtureQuoteProvider = new NseMarketDataProvider({
    env: { NODE_ENV: 'test' },
    httpClient: injectedHttpClient,
  });
  await fixtureQuoteProvider.getQuotes();
    assert.equal(fixtureCalls, 2, 'the explicitly injected fixture transport receives quote and calendar requests');
    assert.equal(axiosCalls, 0, 'default Axios is never used by the fixture-backed adapter');
  assert.ok(fixtureQuoteProvider.marketDataTestFixtureRightsCapability);
  } finally {
    axios.get = originalGet;
  }
});

test('source rights templates require every endpoint query parameter and reject extras', () => {
  const nseValid = buildNseHistoricalIndexRequestUrl({
    indexType: 'NIFTY 50', from: '01-10-2026', to: '02-10-2026',
  });
  const nseTemplate = { provider: 'NSE', url: NSE_HISTORICAL_INDEX_RIGHTS_URL };
  assert.equal(matchesSourceRightsEndpoint(nseTemplate, 'NSE', nseValid), true);
  assert.equal(matchesSourceRightsEndpoint(nseTemplate, 'NSE', NSE_HISTORICAL_INDEX_URL), false);
  assert.equal(matchesSourceRightsEndpoint(nseTemplate, 'NSE', `${nseValid}&unexpected=true`), false);
  assert.equal(matchesSourceRightsEndpoint(nseTemplate, 'NSE', nseValid.replace('&to=', '&from=extra&to=')), false);
  assert.equal(evaluateMarketDataProductionRights('NSE', nseValid).productionUseAllowed, false);

  const upstoxValid = buildUpstoxQuoteRequestUrl(['NSE_INDEX|Nifty 50']);
  const upstoxTemplate = { provider: 'UPSTOX', url: UPSTOX_QUOTE_RIGHTS_URL };
  assert.equal(matchesSourceRightsEndpoint(upstoxTemplate, 'UPSTOX', upstoxValid), true);
  assert.equal(matchesSourceRightsEndpoint(upstoxTemplate, 'UPSTOX', `${UPSTOX_QUOTE_RIGHTS_URL.split('?')[0]}?instrument_key=`), false);
  assert.equal(matchesSourceRightsEndpoint(upstoxTemplate, 'UPSTOX', `${upstoxValid}&unexpected=true`), false);
  assert.equal(evaluateMarketDataProductionRights('UPSTOX', upstoxValid).productionUseAllowed, false);
});

test('NODE_ENV=test with default Axios cannot make direct adapter or calendar requests without rights', async t => {
  const originalGet = axios.get;
  let httpCalls = 0;
  axios.get = async () => { httpCalls += 1; return { data: {} }; };
  t.after(() => { axios.get = originalGet; });
  const env = { NODE_ENV: 'test' };
  const snapshots = await Promise.all([
    new AmfiNavProvider({ env }).getSnapshot(),
    new AmfiNavHistoryProvider({ env }).getSnapshot({ targetDate: '2026-10-01' }),
    new NseMarketDataProvider({ env }).getQuotes(),
    new NseHistoricalDataProvider({ env }).getDailyCandles('market:index:nifty-50', {
      fromDate: '2026-10-01', toDate: '2026-10-02',
    }),
    new UpstoxMarketDataProvider({ env }).getQuotes(['NSE_INDEX|Nifty 50']),
    new UpstoxHistoricalCandleProvider({ env }).getDailyCandles('NSE_INDEX|Nifty 50', {
      fromDate: '2026-10-01', toDate: '2026-10-02',
    }),
    new TejHqHistoricalDataProvider({ env, apiKey: 'test-only-key' }).getStatus(),
    new GovernmentSmallSavingsProvider({ env }).getSnapshot(),
    new SbiTermDepositProvider({ env }).getSnapshot(),
    new RbiFloatingRateSavingsBondProvider({ env }).getSnapshot(),
    fetchNseTradingHolidays({ httpClient: axios, env }),
    fetchBenchmarkQuotes({ env, persist: false }),
    fetchAmfiProductSnapshot({ env, persist: false }),
  ]);

  assert(snapshots.every(snapshot => snapshot.status === 'UNAVAILABLE'));
  assert(snapshots.every(snapshot => snapshot.error?.code === 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED'));
  assert.equal(httpCalls, 0);
});

test('live qualification scripts require a separate opt-in and exact rights even in development/test', () => {
  const requiredEndpoints = [{ provider: 'NSE', url: NSE_ALL_INDICES_URL }];
  assert.throws(
    () => assertMarketDataQualificationRights(requiredEndpoints, { NODE_ENV: 'test' }),
    error => error.code === 'MARKET_DATA_QUALIFICATION_LIVE_DISABLED',
  );
  assert.throws(
    () => assertMarketDataQualificationRights(requiredEndpoints, {
      NODE_ENV: 'development',
      MARKET_DATA_QUALIFICATION_LIVE_ENABLED: 'true',
    }),
    error => error.code === 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED',
  );
});

test('all live market-data operator entrypoints gate rights before constructing providers', async () => {
  const scripts = [
    { url: new URL('../scripts/qualifyNseProvider.js', import.meta.url), firstProviderUse: 'new NseMarketDataProvider(' },
    {
      url: new URL('../scripts/qualifyFixedIncomeProviders.js', import.meta.url),
      firstProviderUse: 'new GovernmentSmallSavingsProvider(',
      requiredSources: ['INDIA_POST_SCRIPT_CHUNK_RIGHTS_URL'],
    },
    {
      url: new URL('../scripts/exportMarketRegimeDataset.js', import.meta.url),
      firstProviderUse: 'new NseHistoricalDataProvider(',
      requiredSources: ['NSE_HISTORICAL_INDEX_RIGHTS_URL', 'NSE_TRADING_HOLIDAY_URL'],
    },
  ];
  for (const { url, firstProviderUse, requiredSources = [] } of scripts) {
    const source = await readFile(url, 'utf8');
    const guard = source.indexOf('assertMarketDataQualificationRights([');
    const providerUse = source.indexOf(firstProviderUse);
    assert.ok(guard >= 0 && providerUse > guard, url.pathname + ' must gate before provider use.');
    for (const requiredSource of requiredSources) {
      assert.ok(source.includes(requiredSource), url.pathname + ' must gate ' + requiredSource + '.');
    }
  }
});

test('India Post page and dynamically selected script endpoints are rights-gated before cache or HTTP access', async () => {
  let httpCalls = 0;
  const provider = new GovernmentSmallSavingsProvider({
    env: production,
    httpClient: { get: async () => { httpCalls += 1; return { data: '' }; } },
  });
  const snapshot = await provider.getSnapshot();

  assert.equal(snapshot.status, 'UNAVAILABLE');
  assert.equal(snapshot.error.code, 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
  assert.equal(snapshot.cache.status, 'NOT_READ_SOURCE_RIGHTS_BLOCKED');
  assert.equal(snapshot.productCount, null);
  assert.equal(httpCalls, 0);
});

test('Upstox operator confirmation cannot access cache or provider when exact market-data rights are unverified', async () => {
  let cacheCalls = 0;
  let httpCalls = 0;
  const requestCache = async ({ loader }) => {
    cacheCalls += 1;
    return loader();
  };
  const httpClient = { get: async () => { httpCalls += 1; return { data: {} }; } };
  const quoteProvider = new UpstoxMarketDataProvider({
    accessToken: 'fixture-only-token',
    env: productionWithOperatorFlags,
    requestCache,
    httpClient,
  });
  const historyProvider = new UpstoxHistoricalCandleProvider({
    accessToken: 'fixture-only-token',
    env: productionWithOperatorFlags,
    requestCache,
    httpClient,
  });

  const [quote, history] = await Promise.all([
    quoteProvider.getQuotes(['NSE_INDEX|Nifty 50']),
    historyProvider.getDailyCandles('NSE_INDEX|Nifty 50', { fromDate: '2026-10-08', toDate: '2026-10-09' }),
  ]);

  for (const snapshot of [quote, history]) {
    assert.equal(snapshot.status, 'UNAVAILABLE');
    assert.equal(snapshot.error.code, 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
    assert.equal(snapshot.cache.status, 'NOT_READ_SOURCE_RIGHTS_BLOCKED');
  }
  assert.equal(cacheCalls, 0);
  assert.equal(httpCalls, 0);
});

test('TejHQ operator flags cannot access cache, budget, or provider for unverified endpoint rights', async () => {
  let cacheCalls = 0;
  let budgetCalls = 0;
  let httpCalls = 0;
  const provider = new TejHqHistoricalDataProvider({
    apiKey: 'fixture-only-token',
    env: productionWithOperatorFlags,
    requestCache: async () => { cacheCalls += 1; return { status: 'AVAILABLE' }; },
    budget: async () => { budgetCalls += 1; return { allowed: true }; },
    httpClient: { get: async () => { httpCalls += 1; return { data: {} }; } },
  });
  const identity = { exchange: 'NSE', symbol: 'RELIANCE', isin: 'INE002A01018' };
  const history = { ...identity, fromDate: '2026-10-08', toDate: '2026-10-09' };
  const snapshots = await Promise.all([
    provider.getRawHistory(history),
    provider.getAdjustedHistory(history),
    provider.getSymbolHistory(identity),
    provider.getCorporateActions({ symbol: identity.symbol }),
    provider.getStatus(),
  ]);

  for (const snapshot of snapshots) {
    assert.equal(snapshot.status, 'UNAVAILABLE');
    assert.equal(snapshot.error.code, 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
    assert.equal(snapshot.cache.status, 'NOT_READ_SOURCE_RIGHTS_BLOCKED');
  }
  assert.equal(cacheCalls, 0);
  assert.equal(budgetCalls, 0);
  assert.equal(httpCalls, 0);
});

test('TejHQ private-demo flags cannot bypass missing source rights or reach provider dependencies', async () => {
  let cacheCalls = 0;
  let budgetCalls = 0;
  let httpCalls = 0;
  const env = {
    NODE_ENV: 'development',
    [MARKET_DATA_PRIVATE_DEMO_ENV]: 'true',
    TEJHQ_PRIVATE_DEMO_ENABLED: 'true',
    TEJHQ_ENABLED: 'true',
    TEJHQ_LICENSE_CONFIRMED: 'true',
    TEJHQ_HISTORICAL_FALLBACK_ENABLED: 'true',
  };
  const capability = createPrivateMarketDataDemoCapability({
    get: () => '127.0.0.1:5000',
    socket: { remoteAddress: '127.0.0.1' },
    user: { userId: 'demo-user' },
  }, env);
  assert.ok(capability);
  const provider = new TejHqHistoricalDataProvider({
    apiKey: 'fixture-only-token',
    env,
    requestCache: async () => { cacheCalls += 1; return { status: 'AVAILABLE' }; },
    budget: async () => { budgetCalls += 1; return { allowed: true }; },
    httpClient: { get: async () => { httpCalls += 1; return { data: {} }; } },
  });
  const snapshot = await provider.getRawHistory({
    exchange: 'NSE', symbol: 'INFY', fromDate: '2026-10-08', toDate: '2026-10-09',
    privateDemoCapability: capability,
  });
  assert.equal(snapshot.status, 'UNAVAILABLE');
  assert.equal(snapshot.error.code, 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
  assert.equal(snapshot.cache.status, 'NOT_READ_SOURCE_RIGHTS_BLOCKED');
  assert.equal(cacheCalls, 0);
  assert.equal(budgetCalls, 0);
  assert.equal(httpCalls, 0);
});

test('private market demo reports TejHQ rights as unavailable without making a TejHQ request', async () => {
  const env = {
    NODE_ENV: 'development',
    [MARKET_DATA_PRIVATE_DEMO_ENV]: 'true',
    TEJHQ_PRIVATE_DEMO_ENABLED: 'true',
    TEJHQ_ENABLED: 'true',
    TEJHQ_LICENSE_CONFIRMED: 'true',
    TEJHQ_HISTORICAL_FALLBACK_ENABLED: 'true',
    TEJHQ_API_KEY: 'fixture-only-token',
  };
  const capability = createPrivateMarketDataDemoCapability({
    get: () => '127.0.0.1:5000',
    socket: { remoteAddress: '127.0.0.1' },
    user: { userId: 'demo-user' },
  }, env);
  assert.ok(capability);
  const originalGet = axios.get;
  let providerRequests = 0;
  axios.get = async () => { providerRequests += 1; return { data: {} }; };
  try {
    const result = await fetchPrivateMarketDemoData({
      privateDemoCapability: capability,
      env,
      now: new Date('2026-10-19T12:00:00.000Z'),
    });
    assert.equal(result.tejHq.status, 'UNAVAILABLE');
    assert.equal(result.tejHq.dataClass, 'HISTORICAL_EOD');
    assert.deepEqual(result.tejHq.reasonCodes, ['MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED']);
    assert.equal(result.tejHq.sourceRights.status, 'LICENSE_UNVERIFIED');
    assert.equal(result.tejHq.sourceRights.productionUseAllowed, false);
    assert.equal(result.tejHq.cache.status, 'PRIVATE_DEMO_NO_STORE');
    assert.equal(result.tejHq.fetchedAt, undefined);
    assert.equal(result.tejHq.checkedAt, '2026-10-19T12:00:00.000Z');
    assert.equal(result.fetchedAt, '2026-10-19T12:00:00.000Z');
  } finally {
    axios.get = originalGet;
  }
  assert.equal(providerRequests, 0);
});

test('production provider facade returns unavailable without fetching or persisting blocked source snapshots', async () => {
  const upstoxCalls = { quotes: 0, history: 0 };
  const nseCalls = { quotes: 0, history: 0 };
  const [amfi, historicalAmfi, indiaPost, sbi, rbi, quotes, history, pair] = await Promise.all([
    fetchAmfiProductSnapshot({ env: production }),
    fetchAmfiHistoricalNavSnapshot({ env: production }),
    fetchGovernmentSavingsSnapshot({ env: production }),
    fetchSbiTermDepositSnapshot({ env: production }),
    fetchRbiFloatingRateSavingsBondSnapshot({ env: production }),
    fetchBenchmarkQuotes({ env: productionWithOperatorFlags, persist: true }),
    fetchNiftyHistoricalCandles({ env: production, persist: true }),
    fetchQualifiedMarketContextSnapshots({
      env: productionWithOperatorFlags,
      persist: true,
      upstoxQuoteProvider: { getQuotes: async () => { upstoxCalls.quotes += 1; return {}; } },
      upstoxHistoryProviderOverride: { getDailyCandles: async () => { upstoxCalls.history += 1; return {}; } },
      nseQuoteProvider: { getQuotes: async () => { nseCalls.quotes += 1; return {}; } },
      nseHistoryProviderOverride: { getDailyCandles: async () => { nseCalls.history += 1; return {}; } },
    }),
  ]);

  for (const snapshot of [amfi, historicalAmfi, indiaPost, sbi, rbi]) {
    assert.equal(snapshot.status, 'UNAVAILABLE');
    assert.equal(snapshot.error.code, 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
    assert.equal(snapshot.persistence.status, 'NOT_PERSISTED');
    assert.deepEqual(snapshot.facts, []);
    assert.equal(snapshot.productCount, null);
    assert.equal(snapshot.availableFactCount, null);
  }
  for (const snapshot of [quotes, history]) {
    assert.equal(snapshot.status, 'UNAVAILABLE');
    assert.ok([
      'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED',
      'UPSTOX_PUBLIC_DISTRIBUTION_DISABLED',
    ].includes(snapshot.error.code));
    assert.equal(snapshot.persistence.status, 'NOT_PERSISTED');
    assert.deepEqual(snapshot.facts, []);
  }
  assert.deepEqual(history.candles, []);
  assert.deepEqual(pair.providerSelection.attemptedProviders, []);
  assert.equal(pair.providerSelection.selectedProvider, null);
  assert.deepEqual(upstoxCalls, { quotes: 0, history: 0 });
  assert.deepEqual(nseCalls, { quotes: 0, history: 0 });
  assert.deepEqual(pair.quoteSnapshot.facts, []);
  assert.deepEqual(pair.historicalSnapshot.candles, []);
});

test('production recommendation context cannot recover a cached NSE snapshot with unverified rights', async () => {
  const now = new Date('2026-10-15T12:00:00.000Z');
  const stored = {
    storedAt: now.toISOString(),
    marketContext: {
      marketSnapshot: {
        providerStatus: {
          quotes: { provider: 'NSE' },
          history: { provider: 'NSE' },
        },
        observedAt: now.toISOString(),
        policyOutput: { status: 'NORMAL', context: 'NORMAL', reasonCodes: [] },
      },
    },
  };
  let hotReads = 0;
  let durableReads = 0;
  const result = await getLatestQualifiedMarketContextForRecommendation({ now }, {
    env: production,
    getLkgCache: async () => { hotReads += 1; return stored; },
    getDurableLkg: async () => { durableReads += 1; return null; },
  });
  assert.equal(result.status, 'MARKET_CONTEXT_UNAVAILABLE');
  assert.deepEqual(result.reasonCodes, ['MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED']);
  assert.equal(result.marketSnapshot.observedFacts.length, 0);
  assert.equal(hotReads, 0);
  assert.equal(durableReads, 0);
});

test('production TejHQ service consumers reject unverified rights before injected providers are called', async () => {
  let historyCalls = 0;
  let calendarCalls = 0;
  let actionCalls = 0;
  let statusCalls = 0;
  const tejHqProvider = {
    getRawHistory: async () => { historyCalls += 1; return { status: 'AVAILABLE' }; },
    getAdjustedHistory: async () => { historyCalls += 1; return { status: 'AVAILABLE' }; },
    getSymbolHistory: async () => { historyCalls += 1; return { status: 'AVAILABLE' }; },
    getStatus: async () => { statusCalls += 1; return { status: 'AVAILABLE' }; },
    getCorporateActions: async () => { actionCalls += 1; return { status: 'AVAILABLE', events: [] }; },
  };
  const request = {
    exchange: 'NSE', symbol: 'RELIANCE', isin: 'INE002A01018',
    fromDate: '2026-10-08', toDate: '2026-10-09',
  };
  const history = await fetchQualifiedEquityHistory(request, {
    env: productionWithOperatorFlags,
    upstoxProvider: { getDailyCandles: async () => { historyCalls += 1; return { status: 'AVAILABLE' }; } },
    tejHqHistoricalProvider: tejHqProvider,
    nseCalendarProvider: { holidayLoader: async () => { calendarCalls += 1; return { status: 'AVAILABLE' }; } },
  });
  const actions = await fetchTejHqCorporateActionEvidence(request, {
    env: productionWithOperatorFlags, tejHqHistoricalProvider: tejHqProvider,
  });
  const status = await fetchTejHqProviderPublicationStatus({}, {
    env: productionWithOperatorFlags, tejHqHistoricalProvider: tejHqProvider,
  });

  for (const snapshot of [history, actions, status]) {
    assert.equal(snapshot.status, 'UNAVAILABLE');
    assert.ok(snapshot.reasonCodes.includes('MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED'));
  }
  assert.equal(historyCalls, 0);
  assert.equal(calendarCalls, 0);
  assert.equal(actionCalls, 0);
  assert.equal(statusCalls, 0);
});

test('NSE equity history checks holiday-calendar rights before any history or calendar provider call', async () => {
  let upstoxCalls = 0;
  let tejHqCalls = 0;
  let calendarCalls = 0;
  const result = await fetchQualifiedEquityHistory({
    exchange: 'NSE', symbol: 'RELIANCE', isin: 'INE002A01018',
    fromDate: '2026-10-08', toDate: '2026-10-09',
  }, {
    env: productionWithOperatorFlags,
    upstoxProvider: { getDailyCandles: async () => { upstoxCalls += 1; return { status: 'AVAILABLE' }; } },
    tejHqHistoricalProvider: {
      getRawHistory: async () => { tejHqCalls += 1; return { status: 'AVAILABLE' }; },
      getSymbolHistory: async () => { tejHqCalls += 1; return { status: 'AVAILABLE' }; },
      getStatus: async () => { tejHqCalls += 1; return { status: 'AVAILABLE' }; },
    },
    nseCalendarProvider: { holidayLoader: async () => { calendarCalls += 1; return { status: 'AVAILABLE' }; } },
  });

  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.selection.reasonCode, 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
  assert.deepEqual(result.candles, []);
  assert.equal(upstoxCalls, 0);
  assert.equal(tejHqCalls, 0);
  assert.equal(calendarCalls, 0);
});
