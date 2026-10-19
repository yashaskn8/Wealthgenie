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
  coverage: { status: 'COMPLETE_FOR_UPSTOX_NSE_CALENDAR', expectedSessionCount: 2, observedSessionCount: 2 },
  source: {
    provider: 'TEJHQ', instrumentId: 'NSE:INE002A01018',
    url: 'https://api.tejhq.dev/v1/ohlcv',
    requestUrls: ['https://api.tejhq.dev/v1/ohlcv/nse/RELIANCE?from=2026-10-15&to=2026-10-16'],
  },
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
  assert.deepEqual(first.filter, {
    provider: 'TEJHQ', exchange: 'NSE', isin: request.isin,
    priceBasis: 'RAW_UNADJUSTED', tradingDate: '2026-10-15',
  });
  assert.equal(first.update.$set.providerObservedAt, null);
  assert.equal(first.update.$set.source.requestUrls.length, 1);
  assert.equal(first.update.$set.retainedUntil.toISOString(), '2026-11-18T12:00:00.000Z');
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
});
