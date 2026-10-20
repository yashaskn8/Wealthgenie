import assert from 'node:assert/strict';
import test from 'node:test';
import MarketEquityDailyBar from '../models/MarketEquityDailyBar.js';
import {
  buildQualifiedHistoryWriteOperations,
  persistQualifiedHistory,
  qualifiedHistoryStorageConfig,
  readQualifiedHistory,
} from '../services/marketData/QualifiedEquityHistoryStore.js';

const env = {
  MARKET_EQUITY_HISTORY_STORE_ENABLED: 'true',
  MARKET_EQUITY_HISTORY_RETENTION_DAYS: '30',
};
const now = new Date('2026-10-19T12:00:00.000Z');
const request = { exchange: 'NSE', symbol: 'RELIANCE', isin: 'INE002A01018',
  fromDate: '2026-10-15', toDate: '2026-10-16', basis: 'RAW' };
const qualifiedTej = {
  schemaVersion: 'market-snapshot-1.0.0',
  status: 'AVAILABLE', provider: 'TEJHQ', canonicalProductId: 'market:equity:nse:INE002A01018',
  instrumentIdentity: { exchange: 'NSE', symbol: 'RELIANCE', isin: request.isin },
  priceBasis: 'RAW_UNADJUSTED', sourceDatasetRevision: 'revision-fixture',
  candleCount: 2, fetchedAt: '2026-10-19T11:00:00.000Z',
  coverage: { status: 'COMPLETE_FOR_UPSTOX_NSE_CALENDAR', calendarProvider: 'UPSTOX',
    expectedSessionCount: 2, observedSessionCount: 2 },
  source: {
    provider: 'TEJHQ', instrumentId: 'NSE:INE002A01018',
    url: 'https://api.tejhq.dev/v1/ohlcv',
    requestUrls: ['https://api.tejhq.dev/v1/ohlcv/nse/RELIANCE?from=2026-10-15&to=2026-10-16'],
  },
  qualificationSourceUrls: [
    { provider: 'TEJHQ', url: 'https://api.tejhq.dev/v1/ohlcv/nse/RELIANCE?from=2026-10-15&to=2026-10-16' },
    { provider: 'TEJHQ', url: 'https://api.tejhq.dev/v1/symbols/nse?isin=INE002A01018' },
    { provider: 'TEJHQ', url: 'https://api.tejhq.dev/v1/status' },
    { provider: 'UPSTOX', url: 'https://api.upstox.com/v2/market/holidays' },
  ],
  candles: [
    { date: '2026-10-15', timestamp: null, open: 101, high: 104, low: 99, close: 102, volume: 100 },
    { date: '2026-10-16', timestamp: null, open: 102, high: 107, low: 101, close: 106, volume: 110 },
  ],
};
const allow = () => true;

test('storage requires explicit valid retention configuration and has a bounded TTL index', () => {
  assert.deepEqual(qualifiedHistoryStorageConfig({}), { enabled: false, retentionDays: NaN });
  assert.equal(qualifiedHistoryStorageConfig({ ...env, MARKET_EQUITY_HISTORY_RETENTION_DAYS: '366' }).enabled, false);
  assert.equal(qualifiedHistoryStorageConfig(env).enabled, true);
  const ix = MarketEquityDailyBar.schema.indexes();
  assert.ok(ix.some(([keys, options]) => options.unique === true
    && keys.provider === 1 && keys.priceBasis === 1 && keys.tradingDate === 1));
  assert.ok(ix.some(([keys, options]) => keys.retainedUntil === 1
    && options.expireAfterSeconds === 0));
});

test('qualified TejHQ date-only EOD bars persist with distinct provider/basis identity and no invented clock', () => {
  const result = buildQualifiedHistoryWriteOperations(qualifiedTej, request, { env, now, rightsCheck: allow });
  assert.equal(result.status, 'READY');
  assert.equal(result.operations.length, 2);
  const first = result.operations[0].updateOne;
  assert.equal(first.filter.provider, 'TEJHQ');
  assert.equal(first.filter.exchange, 'NSE');
  assert.equal(first.filter.isin, request.isin);
  assert.equal(first.filter.priceBasis, 'RAW_UNADJUSTED');
  assert.equal(first.filter.tradingDate, '2026-10-15');
  assert.equal(first.filter.close, 102);
  assert.equal(first.filter.volume, 100);
  assert.equal(first.filter.$or[0].fetchedAt.$lt.toISOString(), qualifiedTej.fetchedAt);
  assert.equal(first.update.$set.providerObservedAt, null);
  assert.equal(first.update.$set.source.requestUrls.length, 1);
  assert.equal(first.update.$set.source.qualificationSourceUrls.length, 4);
  assert.equal(first.update.$set.retainedUntil.toISOString(), '2026-11-18T11:00:00.000Z');
  assert.equal(first.update.$set.coverageSessionCount, 2);
  assert.equal(first.update.$set.adjustedClose, null);
});

test('adjusted EOD is separate and never overwrites raw close or omits factor checks', () => {
  const adjusted = {
    ...qualifiedTej, priceBasis: 'BACK_ADJUSTED',
    candles: qualifiedTej.candles.map(bar => ({
      ...bar, isin: request.isin, adjustedClose: bar.close / 2, adjustmentFactor: 0.5,
    })),
    source: {
      ...qualifiedTej.source, url: 'https://api.tejhq.dev/v1/adjusted',
      requestUrls: ['https://api.tejhq.dev/v1/adjusted/nse/RELIANCE?from=2026-10-15&to=2026-10-16'],
    },
    qualificationSourceUrls: qualifiedTej.qualificationSourceUrls.map(entry => entry.url.includes('/v1/ohlcv/')
      ? { ...entry, url: 'https://api.tejhq.dev/v1/adjusted/nse/RELIANCE?from=2026-10-15&to=2026-10-16' }
      : entry),
  };
  const result = buildQualifiedHistoryWriteOperations(adjusted, { ...request, basis: 'ADJUSTED' }, {
    env, now, rightsCheck: allow,
  });
  assert.equal(result.status, 'READY');
  assert.equal(result.operations[0].updateOne.filter.priceBasis, 'BACK_ADJUSTED');
  assert.equal(result.operations[0].updateOne.update.$set.close, 102);
  assert.equal(result.operations[0].updateOne.update.$set.adjustedClose, 51);
  const bad = { ...adjusted, candles: [{ ...adjusted.candles[0], adjustedClose: 999 }, adjusted.candles[1]] };
  assert.equal(buildQualifiedHistoryWriteOperations(bad, { ...request, basis: 'ADJUSTED' }, {
    env, now, rightsCheck: allow,
  }).status, 'UNAVAILABLE');
});

test('missing session coverage, missing source chain, and unknown licensing forbid storage', () => {
  const denied = buildQualifiedHistoryWriteOperations(qualifiedTej, request, { env, now });
  assert.equal(denied.status, 'UNAVAILABLE');
  assert.equal(denied.code, 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
  assert.equal(buildQualifiedHistoryWriteOperations({
    ...qualifiedTej, source: { ...qualifiedTej.source, requestUrls: [] },
  }, request, { env, now, rightsCheck: allow }).status, 'UNAVAILABLE');
  assert.equal(buildQualifiedHistoryWriteOperations({
    ...qualifiedTej, qualificationSourceUrls: qualifiedTej.qualificationSourceUrls.slice(0, 1),
  }, request, { env, now, rightsCheck: allow }).status, 'UNAVAILABLE');
  assert.equal(buildQualifiedHistoryWriteOperations({
    ...qualifiedTej, coverage: { ...qualifiedTej.coverage, observedSessionCount: 1 },
  }, request, { env, now, rightsCheck: allow }).status, 'UNAVAILABLE');
  assert.equal(buildQualifiedHistoryWriteOperations({
    ...qualifiedTej, candles: [qualifiedTej.candles[1], qualifiedTej.candles[0]],
  }, request, { env, now, rightsCheck: allow }).status, 'UNAVAILABLE');
});

test('Upstox provider-native bars use exchange-local trading date without inventing a symbol', () => {
  const upstox = {
    ...qualifiedTej, provider: 'UPSTOX', priceBasis: 'UPSTOX_PROVIDER_NATIVE',
    source: {
      provider: 'UPSTOX', instrumentId: 'NSE_EQ|INE002A01018',
      url: 'https://api.upstox.com/v3/historical-candle/NSE_EQ%7CINE002A01018/days/1/2026-10-16/2026-10-15',
    },
    qualificationSourceUrls: [
      { provider: 'UPSTOX', url: 'https://api.upstox.com/v3/historical-candle/NSE_EQ%7CINE002A01018/days/1/2026-10-16/2026-10-15' },
      { provider: 'UPSTOX', url: 'https://api.upstox.com/v2/market/holidays' },
    ],
    candles: qualifiedTej.candles.map(bar => {
      const { date: d, ...rest } = bar;
      return { ...rest, timestamp: d + 'T18:40:00.000Z' };
    }),
  };
  const shifted = buildQualifiedHistoryWriteOperations(upstox, request, { env, now, rightsCheck: allow });
  assert.equal(shifted.status, 'UNAVAILABLE');
  const valid = { ...upstox, candles: upstox.candles.map((bar, index) => ({
    ...bar, timestamp: ['2026-10-15', '2026-10-16'][index] + 'T04:00:00.000Z',
  })) };
  const result = buildQualifiedHistoryWriteOperations(valid, request, { env, now, rightsCheck: allow });
  assert.equal(result.status, 'READY');
  assert.equal(result.operations[0].updateOne.filter.tradingDate, '2026-10-15');
  assert.equal(result.operations[0].updateOne.update.$set.symbol, null);
});
test('admin persistence is explicit and return records are rechecked for rights', async () => {
  const writes = [], cacheRows = [];
  const Model = {
    db: { async startSession() { return {
      async withTransaction(fn) { await fn(); },
      async endSession() {},
    }; } },
    async bulkWrite(operations) {
      writes.push(operations);
      for (const op of operations) {
        const value = op.updateOne.update.$set;
        cacheRows.push({ ...value });
      }
    },
    find() { return {
      sort() { return this; }, limit() { return this; },
      async lean() { return cacheRows; },
    }; },
  };
  const stored = await persistQualifiedHistory(qualifiedTej, request, {
    env, now, Model, rightsCheck: allow,
  });
  assert.equal(stored.status, 'PERSISTED');
  assert.equal(stored.written, 2);
  assert.equal(writes.length, 1);
  const read = await readQualifiedHistory(request, { env, now, Model, rightsCheck: allow });
  assert.equal(read.status, 'AVAILABLE');
  assert.equal(read.barCount, 2);
  assert.equal(read.bars[0].close, 102);
  const revoke = await readQualifiedHistory(request, { env, now, Model, rightsCheck: () => false });
  assert.equal(revoke.status, 'UNAVAILABLE');
  assert.equal(revoke.barCount, 0);
  const dependencyRevoked = await readQualifiedHistory(request, {
    env, now, Model, rightsCheck: (_provider, url) => !url.endsWith('/v1/status'),
  });
  assert.equal(dependencyRevoked.status, 'UNAVAILABLE');
  assert.equal(dependencyRevoked.barCount, 0);
});

test('incomplete batches are unavailable and source filtering cannot starve a permitted feed', async () => {
  const plan = buildQualifiedHistoryWriteOperations(qualifiedTej, request, { env, now, rightsCheck: allow });
  const tejRows = plan.operations.map(operation => operation.updateOne.update.$set);
  const blockedRows = tejRows.map(row => ({
    ...row, provider: 'UPSTOX', priceBasis: 'UPSTOX_PROVIDER_NATIVE',
    qualificationBatchId: 'blocked-upstox-batch',
    source: { requestUrls: ['https://api.upstox.com/v3/historical-candle/test'],
      qualificationSourceUrls: [
        { provider: 'UPSTOX', url: 'https://api.upstox.com/v3/historical-candle/test' },
        { provider: 'UPSTOX', url: 'https://api.upstox.com/v2/market/holidays' },
      ] },
  }));
  const limits = [];
  const Model = {
    find(query) { return {
      sort() { return this; },
      limit(value) { limits.push(value); this.max = value; return this; },
      async lean() { return [...blockedRows, ...tejRows]
        .filter(row => !query.qualificationBatchId
          || row.qualificationBatchId === query.qualificationBatchId)
        .filter(row => !query.tradingDate
          || row.tradingDate >= query.tradingDate.$gte && row.tradingDate <= query.tradingDate.$lte)
        .slice(0, this.max); },
    }; },
  };
  const permitted = await readQualifiedHistory(request, {
    env, now, Model, rightsCheck: provider => provider === 'TEJHQ' || provider === 'UPSTOX',
  });
  assert.equal(limits[0], 732);
  assert.equal(permitted.barCount, 4);
  const onlyTej = await readQualifiedHistory(request, {
    env, now, Model, rightsCheck: (_provider, url) => !url.includes('/historical-candle/'),
  });
  assert.equal(onlyTej.status, 'AVAILABLE');
  assert.equal(onlyTej.barCount, 2);
  const subset = await readQualifiedHistory({ ...request, fromDate: '2026-10-16' }, {
    env, now, Model, rightsCheck: (_provider, url) => !url.includes('/historical-candle/'),
  });
  assert.equal(subset.status, 'AVAILABLE');
  assert.equal(subset.barCount, 1);
  assert.equal(subset.bars[0].tradingDate, '2026-10-16');
  const partialModel = {
    find() { return { sort() { return this; }, limit() { return this; },
      async lean() { return tejRows.slice(0, 1); } }; },
  };
  const partial = await readQualifiedHistory(request, { env, now, Model: partialModel, rightsCheck: allow });
  assert.equal(partial.status, 'UNAVAILABLE');
  assert.equal(partial.barCount, 0);
});

test('replayed fetch keeps its retention deadline and stale revisions cannot match the update predicate', () => {
  const first = buildQualifiedHistoryWriteOperations(qualifiedTej, request, { env, now, rightsCheck: allow });
  const later = buildQualifiedHistoryWriteOperations(qualifiedTej, request, {
    env, now: new Date(now.getTime() + 86_400_000), rightsCheck: allow,
  });
  assert.equal(first.qualificationBatchId, later.qualificationBatchId);
  assert.equal(first.operations[0].updateOne.update.$set.retainedUntil.toISOString(),
    later.operations[0].updateOne.update.$set.retainedUntil.toISOString());
  assert.equal(first.operations[0].updateOne.filter.$or[0].fetchedAt.$lt.toISOString(),
    qualifiedTej.fetchedAt);
});

test('a failed transactional write returns no persisted rows and a safe error', async () => {
  let transactionEnded = false;
  const Model = {
    db: { async startSession() { return {
      async withTransaction(fn) { await fn(); },
      async endSession() { transactionEnded = true; },
    }; } },
    async bulkWrite(_operations, options) {
      assert.ok(options.session);
      throw Object.assign(new Error('private database detail'), { code: 11000 });
    },
  };
  const result = await persistQualifiedHistory(qualifiedTej, request, {
    env, now, Model, rightsCheck: allow,
  });
  assert.deepEqual(result, { status: 'UNAVAILABLE', code: 'MARKET_HISTORY_REVISION_CONFLICT', written: 0 });
  assert.equal(transactionEnded, true);
  assert.equal(JSON.stringify(result).includes('private database detail'), false);
});

test('a newer fetch cannot silently correct an already persisted daily price', async () => {
  const existingClose = 102;
  let ended = false;
  const Model = {
    db: { async startSession() { return {
      async withTransaction(fn) { await fn(); },
      async endSession() { ended = true; },
    }; } },
    async bulkWrite(operations) {
      const update = operations[0].updateOne;
      assert.equal(update.filter.close, 103);
      assert.equal(update.update.$set.close, 103);
      if (update.filter.close !== existingClose) {
        throw Object.assign(new Error('unique daily identity already exists'), { code: 11000 });
      }
    },
  };
  const corrected = {
    ...qualifiedTej,
    fetchedAt: '2026-10-19T11:30:00.000Z',
    candles: [{ ...qualifiedTej.candles[0], close: 103 }, qualifiedTej.candles[1]],
  };
  const result = await persistQualifiedHistory(corrected, request, {
    env, now, Model, rightsCheck: allow,
  });
  assert.deepEqual(result, { status: 'UNAVAILABLE', code: 'MARKET_HISTORY_REVISION_CONFLICT', written: 0 });
  assert.equal(ended, true);
});
