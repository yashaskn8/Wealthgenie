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
const qualifiedUpstox = {
  schemaVersion: 'market-fact-1.0.0',
  status: 'AVAILABLE', provider: 'UPSTOX', canonicalProductId: 'market:equity:nse:INE002A01018',
  instrumentIdentity: { exchange: 'NSE', symbol: null, isin: request.isin },
  priceBasis: 'UPSTOX_PROVIDER_NATIVE',
  candleCount: 2, fetchedAt: '2026-10-19T11:00:00.000Z',
  coverage: { status: 'COMPLETE_FOR_UPSTOX_NSE_CALENDAR', calendarProvider: 'UPSTOX',
    expectedSessionCount: 2, observedSessionCount: 2 },
  source: {
    provider: 'UPSTOX', instrumentId: 'NSE_EQ|INE002A01018',
    url: 'https://api.upstox.com/v3/historical-candle/NSE_EQ%7CINE002A01018/days/1/2026-10-16/2026-10-15',
  },
  qualificationSourceUrls: [
    { provider: 'UPSTOX', url: 'https://api.upstox.com/v3/historical-candle/NSE_EQ%7CINE002A01018/days/1/2026-10-16/2026-10-15' },
    { provider: 'UPSTOX', url: 'https://api.upstox.com/v2/market/holidays' },
  ],
  candles: [
    { timestamp: '2026-10-15T04:00:00.000Z', open: 101, high: 104, low: 99, close: 102, volume: 100 },
    { timestamp: '2026-10-16T04:00:00.000Z', open: 102, high: 107, low: 101, close: 106, volume: 110 },
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

test('missing session coverage, missing source chain, and unknown licensing forbid storage', () => {
  const denied = buildQualifiedHistoryWriteOperations(qualifiedUpstox, request, { env, now });
  assert.equal(denied.status, 'UNAVAILABLE');
  assert.equal(denied.code, 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
  assert.equal(buildQualifiedHistoryWriteOperations({
    ...qualifiedUpstox, source: { ...qualifiedUpstox.source, url: null },
  }, request, { env, now, rightsCheck: allow }).status, 'UNAVAILABLE');
  assert.equal(buildQualifiedHistoryWriteOperations({
    ...qualifiedUpstox, qualificationSourceUrls: qualifiedUpstox.qualificationSourceUrls.slice(0, 1),
  }, request, { env, now, rightsCheck: allow }).status, 'UNAVAILABLE');
  assert.equal(buildQualifiedHistoryWriteOperations({
    ...qualifiedUpstox, coverage: { ...qualifiedUpstox.coverage, observedSessionCount: 1 },
  }, request, { env, now, rightsCheck: allow }).status, 'UNAVAILABLE');
  assert.equal(buildQualifiedHistoryWriteOperations({
    ...qualifiedUpstox, candles: [qualifiedUpstox.candles[1], qualifiedUpstox.candles[0]],
  }, request, { env, now, rightsCheck: allow }).status, 'UNAVAILABLE');
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
  const stored = await persistQualifiedHistory(qualifiedUpstox, request, {
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
    env, now, Model, rightsCheck: (_provider, url) => !url.endsWith('/market/holidays'),
  });
  assert.equal(dependencyRevoked.status, 'UNAVAILABLE');
  assert.equal(dependencyRevoked.barCount, 0);
});

test('replayed fetch keeps its retention deadline and stale revisions cannot match the update predicate', () => {
  const first = buildQualifiedHistoryWriteOperations(qualifiedUpstox, request, { env, now, rightsCheck: allow });
  const later = buildQualifiedHistoryWriteOperations(qualifiedUpstox, request, {
    env, now: new Date(now.getTime() + 86_400_000), rightsCheck: allow,
  });
  assert.equal(first.qualificationBatchId, later.qualificationBatchId);
  assert.equal(first.operations[0].updateOne.update.$set.retainedUntil.toISOString(),
    later.operations[0].updateOne.update.$set.retainedUntil.toISOString());
  assert.equal(first.operations[0].updateOne.filter.$or[0].fetchedAt.$lt.toISOString(),
    qualifiedUpstox.fetchedAt);
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
  const result = await persistQualifiedHistory(qualifiedUpstox, request, {
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
    ...qualifiedUpstox,
    fetchedAt: '2026-10-19T11:30:00.000Z',
    candles: [{ ...qualifiedUpstox.candles[0], close: 103 }, qualifiedUpstox.candles[1]],
  };
  const result = await persistQualifiedHistory(corrected, request, {
    env, now, Model, rightsCheck: allow,
  });
  assert.deepEqual(result, { status: 'UNAVAILABLE', code: 'MARKET_HISTORY_REVISION_CONFLICT', written: 0 });
  assert.equal(ended, true);
});
