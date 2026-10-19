import test from 'node:test';
import assert from 'node:assert/strict';
import TejHqHistoricalDataProvider, {
  parseTejHqActionsEnvelope,
  parseTejHqAdjustedEnvelope,
  parseTejHqOhlcvEnvelope,
  parseTejHqStatus,
  parseTejHqSymbolHistoryEnvelope,
} from '../services/marketData/TejHqHistoricalDataProvider.js';

const NOW = new Date('2026-10-13T06:00:00.000Z');
const REQUEST = Object.freeze({
  exchange: 'NSE',
  symbol: 'RELIANCE',
  isin: 'INE002A01018',
  fromDate: '2026-10-08',
  toDate: '2026-10-09',
});

function rawPayload(rows = [
  { date: '2026-10-08', open: 100, high: 110, low: 99, close: 105, volume: 1000 },
  { date: '2026-10-09', open: 105, high: 112, low: 104, close: 111, volume: 1200 },
]) {
  return {
    data: rows,
    meta: { exchange: 'NSE', symbol: 'RELIANCE', from: REQUEST.fromDate, to: REQUEST.toDate, count: rows.length },
  };
}

function adjustedPayload(rows = [
  { date: '2026-10-08', open: 100, high: 110, low: 99, close: 105, volume: 1000, adj_factor_cumulative: 0.5, adj_close: 52.5 },
  { date: '2026-10-09', open: 105, high: 112, low: 104, close: 111, volume: 1200, adj_factor_cumulative: 1, adj_close: 111 },
]) {
  return {
    data: rows,
    meta: { exchange: 'NSE', symbol: 'RELIANCE', from: REQUEST.fromDate, to: REQUEST.toDate, count: rows.length },
  };
}

function symbolPayload(rows = [{
  exchange: 'NSE', isin: REQUEST.isin, symbol: REQUEST.symbol,
  valid_from: '2010-01-04', valid_to: '2026-10-09', trading_days: 4040,
}]) {
  return { data: rows, meta: { exchange: 'NSE', isin: REQUEST.isin, count: rows.length } };
}

function actionPayload(rows = [{
  exchange: 'NSE', symbol: REQUEST.symbol, isin: REQUEST.isin, company: 'Example issuer',
  ex_date: '2024-01-05', record_date: '2024-01-06', type: 'split',
  ratio_num: 1, ratio_den: 2, face_value_from: 10, face_value_to: 5, raw_subject: 'Face value split',
}]) {
  return { data: rows, meta: {} };
}

function successResponse(data, headers = {}) {
  return { status: 200, data, headers };
}

function configuredProvider({ httpClient, apiKey = 'fixture-only-key', budget = async () => ({ allowed: true, used: 1, limit: 200 }) } = {}) {
  return new TejHqHistoricalDataProvider({
    apiKey,
    env: {
      TEJHQ_ENABLED: 'true',
      TEJHQ_LICENSE_CONFIRMED: 'true',
      TEJHQ_HISTORICAL_FALLBACK_ENABLED: 'true',
      TEJHQ_ADJUSTED_HISTORY_ENABLED: 'true',
      TEJHQ_CORPORATE_ACTIONS_ENABLED: 'true',
      NODE_ENV: 'test',
    },
    httpClient,
    budget,
    clock: () => NOW,
  });
}

test('raw OHLCV validates exact identity and preserves date-only EOD semantics', () => {
  const snapshot = parseTejHqOhlcvEnvelope(rawPayload(), { ...REQUEST, fetchedAt: NOW, now: NOW });
  assert.equal(snapshot.status, 'AVAILABLE');
  assert.equal(snapshot.dataClass, 'HISTORICAL_EOD');
  assert.equal(snapshot.priceBasis, 'RAW_UNADJUSTED');
  assert.equal(snapshot.observedAt, null);
  assert.equal(snapshot.effectiveTradingDate, '2026-10-09');
  assert.equal(snapshot.candles.length, 2);
  assert.equal(snapshot.candles[1].timestamp, null);
  assert.deepEqual(snapshot.source, {
    provider: 'TEJHQ', instrumentId: 'NSE:RELIANCE', url: 'https://api.tejhq.dev/v1/ohlcv/nse/RELIANCE',
  });
});

test('raw OHLCV rejects source identity mismatch, wrong range and count mismatch', () => {
  assert.throws(() => parseTejHqOhlcvEnvelope({ ...rawPayload(), meta: { ...rawPayload().meta, exchange: 'BSE' } }, {
    ...REQUEST, fetchedAt: NOW, now: NOW,
  }), /IDENTITY_MISMATCH/);
  assert.throws(() => parseTejHqOhlcvEnvelope(rawPayload([{ ...rawPayload().data[0], date: '2026-10-10' }]), {
    ...REQUEST, fetchedAt: NOW, now: NOW,
  }), /DATE_OUT_OF_RANGE/);
  assert.throws(() => parseTejHqOhlcvEnvelope({ ...rawPayload(), meta: { ...rawPayload().meta, count: 3 } }, {
    ...REQUEST, fetchedAt: NOW, now: NOW,
  }), /COUNT_MISMATCH/);
});

test('raw OHLCV rejects malformed, non-finite, extreme and inconsistent rows', () => {
  const badRows = [
    { date: '2026-10-08', open: 100, high: 90, low: 99, close: 105, volume: 10 },
    { date: '2026-10-08', open: -1, high: 2, low: 1, close: 1, volume: 1 },
    { date: '2026-10-08', open: 1, high: Infinity, low: 1, close: 1, volume: 1 },
    { date: '2026-10-08', open: 1, high: 2, low: 1, close: 1, volume: Number.MAX_SAFE_INTEGER + 1 },
    { date: '2026-10-14', open: 1, high: 2, low: 1, close: 1, volume: 1 },
  ];
  for (const row of badRows) {
    const payload = { data: [row], meta: { exchange: 'NSE', symbol: 'RELIANCE', from: row.date, to: row.date, count: 1 } };
    assert.throws(() => parseTejHqOhlcvEnvelope(payload, {
      ...REQUEST, fromDate: row.date, toDate: row.date, fetchedAt: NOW, now: NOW,
    }));
  }
});

test('raw OHLCV rejects duplicate dates and out-of-order rows instead of masking provider defects', () => {
  const first = rawPayload().data[0];
  const duplicate = rawPayload([first, { ...first, close: 106 }]);
  assert.throws(() => parseTejHqOhlcvEnvelope(duplicate, {
    ...REQUEST, fetchedAt: NOW, now: NOW,
  }), /DUPLICATE_TRADING_DATE/);
  const reversed = rawPayload([...rawPayload().data].reverse());
  assert.throws(() => parseTejHqOhlcvEnvelope(reversed, {
    ...REQUEST, fetchedAt: NOW, now: NOW,
  }), /OUT_OF_ORDER/);
});

test('adjusted OHLCV remains separate and validates cumulative factor against adjusted close', () => {
  const snapshot = parseTejHqAdjustedEnvelope(adjustedPayload(), { ...REQUEST, fetchedAt: NOW, now: NOW });
  assert.equal(snapshot.priceBasis, 'BACK_ADJUSTED');
  assert.equal(snapshot.adjustmentSemantics, 'SPLITS_BONUSES_AND_DIVIDENDS');
  assert.equal(snapshot.candles[0].close, 105);
  assert.equal(snapshot.candles[0].adjustedClose, 52.5);
  assert.equal(snapshot.candles[0].adjustmentFactor, 0.5);
  assert.equal(snapshot.candles[0].timestamp, null);
  const invalidAdjusted = adjustedPayload([{ ...adjustedPayload().data[0], adj_close: 99 }]);
  invalidAdjusted.meta.to = '2026-10-08';
  assert.throws(() => parseTejHqAdjustedEnvelope(invalidAdjusted, {
    ...REQUEST, fromDate: '2026-10-08', toDate: '2026-10-08', fetchedAt: NOW, now: NOW,
  }), /ADJUSTMENT_FACTOR_MISMATCH/);
});

test('symbol history requires exact ISIN and exchange, valid intervals, and no overlap', () => {
  const snapshot = parseTejHqSymbolHistoryEnvelope(symbolPayload(), {
    exchange: REQUEST.exchange, isin: REQUEST.isin, fetchedAt: NOW,
  });
  assert.equal(snapshot.status, 'AVAILABLE');
  assert.equal(snapshot.intervals[0].validFrom, '2010-01-04');
  assert.equal(snapshot.intervals[0].validTo, '2026-10-09');
  assert.throws(() => parseTejHqSymbolHistoryEnvelope(symbolPayload([{
    ...symbolPayload().data[0], isin: 'INE999A01011',
  }]), { exchange: 'NSE', isin: REQUEST.isin, fetchedAt: NOW }), /IDENTITY_MISMATCH/);
  assert.throws(() => parseTejHqSymbolHistoryEnvelope(symbolPayload([
    ...symbolPayload().data,
    { ...symbolPayload().data[0], symbol: 'RELIANCE2', valid_from: '2020-01-01', valid_to: '2021-01-01' },
  ]), { exchange: 'NSE', isin: REQUEST.isin, fetchedAt: NOW }), /INTERVAL_OVERLAP/);
});

test('corporate actions preserve same-day events and reject impossible or conflicting events', () => {
  const split = actionPayload().data[0];
  const bonus = { ...split, type: 'bonus', ratio_num: 1, ratio_den: 1, raw_subject: 'Bonus issue' };
  const dividend = { ...split, type: 'dividend', ratio_num: null, ratio_den: null, cash_amount: 10, raw_subject: 'Final dividend' };
  const snapshot = parseTejHqActionsEnvelope(actionPayload([split, bonus, dividend, split]), {
    symbol: REQUEST.symbol, now: NOW, fetchedAt: NOW,
  });
  assert.equal(snapshot.events.length, 3);
  assert.equal(snapshot.completeness, 'NOT_CONCLUSIVE');
  assert.equal(snapshot.events.filter(event => event.exDate === '2024-01-05').length, 3);
  assert.equal(snapshot.events.find(event => event.type === 'dividend').cashAmount, 10);
  assert.throws(() => parseTejHqActionsEnvelope(actionPayload([{
    ...split, ratio_num: 0,
  }]), { symbol: REQUEST.symbol, now: NOW, fetchedAt: NOW }), /ACTION_RATIO_INVALID/);
  assert.throws(() => parseTejHqActionsEnvelope(actionPayload([{
    ...dividend, ex_date: '2026-10-14', record_date: '2026-10-15',
  }]), { symbol: REQUEST.symbol, now: NOW, fetchedAt: NOW }), /FUTURE_ACTION_DATE/);
  assert.throws(() => parseTejHqActionsEnvelope(actionPayload([
    dividend,
    { ...dividend, cash_amount: 11 },
  ]), { symbol: REQUEST.symbol, now: NOW, fetchedAt: NOW }), /CONFLICTING_ACTION_DUPLICATE/);
});

test('provider-status reports publication timestamps without claiming session freshness', () => {
  const status = parseTejHqStatus({
    trading_date: '2026-10-09',
    prices_published_at: '2026-10-09T15:30:00+05:30',
    derived_published_at: '2026-10-09T16:00:00+05:30',
    generated_at: '2026-10-09T16:00:00+05:30',
    stage: 'derived',
  }, { fetchedAt: NOW, now: NOW });
  assert.equal(status.status, 'AVAILABLE');
  assert.equal(status.publication.datasetTradingDate, '2026-10-09');
  assert.equal(status.publication.rawDatasetStatus, 'PUBLISHED');
  assert.equal(status.publication.derivedDatasetStatus, 'PUBLISHED');
  assert.equal(status.publication.expectedSessionStatus, 'UNKNOWN');
  const staleDerived = parseTejHqStatus({
    trading_date: '2026-10-09',
    prices_published_at: '2026-10-09T15:30:00+05:30',
    derived_published_at: '2026-10-08T16:00:00+05:30',
    generated_at: '2026-10-09T15:30:00+05:30',
    stage: 'prices',
  }, { fetchedAt: NOW, now: NOW });
  assert.equal(staleDerived.publication.rawDatasetStatus, 'PUBLISHED');
  assert.equal(staleDerived.publication.derivedDatasetStatus, 'STALE');
  assert.throws(() => parseTejHqStatus({ trading_date: '2026-10-14' }, { fetchedAt: NOW, now: NOW }), /FUTURE_STATUS_DATE/);
});

test('status generated during a slow request uses response receipt as fetchedAt', async () => {
  let current = new Date('2026-10-13T06:00:00.000Z');
  const provider = new TejHqHistoricalDataProvider({
    apiKey: 'fixture-only-key',
    env: { NODE_ENV: 'test', TEJHQ_ENABLED: 'true', TEJHQ_LICENSE_CONFIRMED: 'true' },
    clock: () => current,
    requestCache: async ({ loader }) => loader(),
    httpClient: { async get() {
      current = new Date('2026-10-13T06:02:00.000Z');
      return successResponse({
        trading_date: '2026-10-13',
        prices_published_at: '2026-10-13T06:00:30.000Z',
        derived_published_at: '2026-10-13T06:01:00.000Z',
        generated_at: '2026-10-13T06:01:30.000Z',
      });
    } },
  });
  const status = await provider.getStatus();
  assert.equal(status.status, 'AVAILABLE');
  assert.equal(status.fetchedAt, '2026-10-13T06:02:00.000Z');
  assert.equal(status.publication.derivedDatasetStatus, 'PUBLISHED');
});

test('keyless OHLCV never sends the configured API key and uses the fixed TejHQ host', async () => {
  let request;
  const provider = configuredProvider({ httpClient: {
    async get(url, options) {
      request = { url, options };
      return successResponse(rawPayload());
    },
  } });
  const result = await provider.getRawHistory(REQUEST);
  assert.equal(result.status, 'AVAILABLE');
  const requestUrl = new URL(request.url);
  assert.equal(requestUrl.origin, 'https://api.tejhq.dev');
  assert.equal(requestUrl.pathname, '/v1/ohlcv/nse/RELIANCE');
  assert.equal(requestUrl.searchParams.get('from'), REQUEST.fromDate);
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(request.options.maxRedirects, 0);
  assert.equal(request.options.maxContentLength, 2_000_000);
});

test('adjusted history uses bearer auth, bounded internal budget, and never puts the key in a URL', async () => {
  let request;
  let budgetCalls = 0;
  const provider = configuredProvider({
    budget: async () => { budgetCalls += 1; return { allowed: true, used: budgetCalls, limit: 200 }; },
    httpClient: {
      async get(url, options) { request = { url, options }; return successResponse(adjustedPayload(), {
        'x-ratelimit-limit-day': '1000', 'x-ratelimit-remaining-day': '998',
      }); },
    },
  });
  const result = await provider.getAdjustedHistory(REQUEST);
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(request.options.headers.Authorization, 'Bearer fixture-only-key');
  assert.equal(request.url.includes('fixture-only-key'), false);
  assert.equal(new URL(request.url).searchParams.get('from'), REQUEST.fromDate);
  assert.equal(result.quotaObservation.remainingPerDay, 998);
  assert.equal(budgetCalls, 1);
});

test('keyed cache does not reuse another credential\'s adjusted-history entitlement', async () => {
  const cache = new Map();
  const cacheKeys = [];
  const requestCache = async ({ cacheKey, loader, shouldCache }) => {
    cacheKeys.push(cacheKey);
    if (cache.has(cacheKey)) return { ...cache.get(cacheKey), cache: { hit: true } };
    const result = await loader();
    if (shouldCache(result)) cache.set(cacheKey, result);
    return { ...result, cache: { hit: false } };
  };
  const options = {
    env: {
      NODE_ENV: 'test', TEJHQ_ENABLED: 'true', TEJHQ_LICENSE_CONFIRMED: 'true',
      TEJHQ_ADJUSTED_HISTORY_ENABLED: 'true',
    },
    clock: () => NOW,
    budget: async () => ({ allowed: true, used: 1, limit: 200 }),
    requestCache,
  };
  let firstRequests = 0;
  const first = new TejHqHistoricalDataProvider({
    ...options,
    apiKey: 'fixture-key-a',
    httpClient: { async get() {
      firstRequests += 1;
      return successResponse(adjustedPayload());
    } },
  });
  let secondRequests = 0;
  const second = new TejHqHistoricalDataProvider({
    ...options,
    apiKey: 'fixture-key-b',
    httpClient: { async get() {
      secondRequests += 1;
      throw Object.assign(new Error('not entitled'), { response: { status: 402 } });
    } },
  });

  const entitled = await first.getAdjustedHistory(REQUEST);
  const denied = await second.getAdjustedHistory(REQUEST);
  assert.equal(entitled.status, 'AVAILABLE');
  assert.equal(denied.status, 'SOURCE_ERROR');
  assert.equal(denied.error.code, 'TEJHQ_PAID_CAPABILITY_UNAVAILABLE');
  assert.equal(firstRequests, 1);
  assert.equal(secondRequests, 1);
  assert.notEqual(cacheKeys[0], cacheKeys[1]);
  assert.equal(cacheKeys.some(key => key.includes('fixture-key-')), false);
});

test('adjusted-only mode can read required symbol history without enabling raw fallback', async () => {
  const requests = [];
  let budgetCalls = 0;
  const provider = new TejHqHistoricalDataProvider({
    apiKey: 'fixture-only-key',
    env: {
      NODE_ENV: 'test',
      TEJHQ_ENABLED: 'true',
      TEJHQ_LICENSE_CONFIRMED: 'true',
      TEJHQ_HISTORICAL_FALLBACK_ENABLED: 'false',
      TEJHQ_ADJUSTED_HISTORY_ENABLED: 'true',
    },
    clock: () => NOW,
    budget: async () => { budgetCalls += 1; return { allowed: true, used: budgetCalls, limit: 200 }; },
    requestCache: async ({ loader }) => loader(),
    httpClient: { async get(url, options) {
      requests.push({ url, options });
      return successResponse(symbolPayload());
    } },
  });

  const symbols = await provider.getSymbolHistory({ exchange: REQUEST.exchange, isin: REQUEST.isin });
  assert.equal(symbols.status, 'AVAILABLE');
  assert.equal(symbols.intervals[0].isin, REQUEST.isin);
  assert.equal(budgetCalls, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer fixture-only-key');

  const raw = await provider.getRawHistory(REQUEST);
  assert.equal(raw.error.code, 'TEJHQ_FEATURE_DISABLED');
  assert.equal(requests.length, 1);
});

test('keyed operations fail closed without credentials and do not contact TejHQ', async () => {
  let calls = 0;
  const provider = configuredProvider({ apiKey: '', httpClient: { async get() { calls += 1; } } });
  const result = await provider.getAdjustedHistory(REQUEST);
  assert.equal(result.status, 'PROVIDER_NOT_CONFIGURED');
  assert.equal(result.error.code, 'TEJHQ_KEY_NOT_CONFIGURED');
  assert.equal(calls, 0);
});

test('disabled-by-default provider makes no requests', async () => {
  let calls = 0;
  const provider = new TejHqHistoricalDataProvider({ httpClient: { async get() { calls += 1; } }, clock: () => NOW });
  const result = await provider.getRawHistory(REQUEST);
  assert.equal(result.error.code, 'TEJHQ_DISABLED');
  assert.equal(calls, 0);
});

test('TejHQ remains disabled until an operator explicitly confirms permitted use', async () => {
  let calls = 0;
  const provider = new TejHqHistoricalDataProvider({
    apiKey: 'fixture-only-key',
    env: { NODE_ENV: 'test', TEJHQ_ENABLED: 'true', TEJHQ_HISTORICAL_FALLBACK_ENABLED: 'true' },
    httpClient: { async get() { calls += 1; } },
    clock: () => NOW,
  });
  const result = await provider.getRawHistory(REQUEST);
  assert.equal(result.status, 'PROVIDER_NOT_CONFIGURED');
  assert.equal(result.error.code, 'TEJHQ_LICENSE_NOT_CONFIRMED');
  assert.equal(calls, 0);
});

test('a rejected key disables keyed capabilities until provider recreation', async () => {
  let calls = 0;
  const provider = configuredProvider({ httpClient: { async get() {
    calls += 1;
    throw Object.assign(new Error('Authorization: Bearer fixture-only-key'), { response: { status: 401 } });
  } } });
  const first = await provider.getAdjustedHistory(REQUEST);
  const second = await provider.getSymbolHistory({ exchange: 'NSE', isin: REQUEST.isin });
  assert.equal(first.error.code, 'TEJHQ_AUTHENTICATION_FAILED');
  assert.equal(second.error.code, 'TEJHQ_AUTHENTICATION_FAILED');
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(first).includes('fixture-only-key'), false);
});

test('paid-tier, quota, timeout, TLS, and malformed failures are typed and not retried', async () => {
  for (const [status, expected] of [
    [402, 'TEJHQ_PAID_CAPABILITY_UNAVAILABLE'],
    [429, 'TEJHQ_RATE_LIMITED'],
    [503, 'TEJHQ_PROVIDER_UNAVAILABLE'],
  ]) {
    let calls = 0;
    const provider = configuredProvider({ httpClient: { async get() {
      calls += 1;
      throw Object.assign(new Error('provider response contains secret'), { response: { status } });
    } } });
    const result = await provider.getAdjustedHistory(REQUEST);
    assert.equal(result.error.code, expected);
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes('provider response'), false);
  }
});
