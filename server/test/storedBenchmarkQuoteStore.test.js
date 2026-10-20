import assert from 'node:assert/strict';
import test from 'node:test';
import {
  benchmarkQuoteIndexesReady,
  benchmarkQuoteStorageConfig,
  readStoredBenchmarkQuotes,
} from '../services/marketData/StoredBenchmarkQuoteStore.js';
import { buildObservationOperations } from '../services/marketData/MarketDataRepository.js';

const env = {
  NODE_ENV: 'test', MARKET_BENCHMARK_QUOTE_STORE_ENABLED: 'true',
  MARKET_BENCHMARK_QUOTE_RETENTION_SECONDS: '3600',
};
const now = new Date('2026-10-20T12:00:00.000Z');
const sourceUrl = 'https://api.upstox.com/v3/market-quote/quotes?instrument_key=NSE_INDEX%7CNifty%2050';
function row(id, instrumentId, observedAt) {
  return {
    schemaVersion: 'market-snapshot-1.0.0', kind: 'MARKET_QUOTE',
    canonicalProductId: id, value: 25123.45, unit: 'INDEX_POINTS', currency: null,
    availabilityStatus: 'AVAILABLE', dataClass: 'LIVE',
    observedAt: new Date(observedAt), providerTimestamp: new Date(observedAt),
    lastFetchedAt: new Date('2026-10-20T11:45:00.000Z'),
    retainedUntil: new Date('2026-10-20T12:40:00.000Z'),
    freshness: { status: 'FRESH', maxAgeSeconds: 900 },
    source: { provider: 'UPSTOX', instrumentId, url: sourceUrl },
    metrics: { close: 25123.45 },
  };
}
const nifty = row('market:index:nifty-50', 'NSE_INDEX|Nifty 50', '2026-10-20T11:40:00.000Z');
const vix = {
  ...row('market:index:india-vix', 'NSE_INDEX|India VIX', '2026-10-20T11:50:00.000Z'),
  lastFetchedAt: new Date('2026-10-20T11:51:00.000Z'),
  retainedUntil: new Date('2026-10-20T12:50:00.000Z'),
};
function fakeModel(rows, queries = []) {
  return {
    find(query) { queries.push(query); let max = Infinity; return {
      sort() { return this; }, limit(value) { max = value; return this; },
      async lean() { return rows.filter(item => item.canonicalProductId === query.canonicalProductId
        && item.source.provider === query['source.provider']
        && item.retainedUntil > query.retainedUntil.$gt)
        .sort((left, right) => right.observedAt - left.observedAt).slice(0, max); },
    }; },
  };
}

test('storage configuration is explicit and bounded; TTL/read indexes are required', async () => {
  assert.equal(benchmarkQuoteStorageConfig({}).enabled, false);
  assert.equal(benchmarkQuoteStorageConfig({ ...env,
    MARKET_BENCHMARK_QUOTE_RETENTION_SECONDS: '86401' }).enabled, false);
  const indexes = [
    { name: 'expire_retained_market_observation', key: { retainedUntil: 1 }, expireAfterSeconds: 0 },
    { name: 'latest_retained_benchmark_quote',
      key: { kind: 1, canonicalProductId: 1, 'source.provider': 1, observedAt: -1 } },
  ];
  assert.equal(await benchmarkQuoteIndexesReady({ collection: { async indexes() { return indexes; } } }), true);
  assert.equal(await benchmarkQuoteIndexesReady({ collection: { async indexes() { return indexes.slice(1); } } }), false);
});

test('stored read recalculates freshness while retaining authorized last-observed values', async () => {
  const result = await readStoredBenchmarkQuotes({ env, now, Model: fakeModel([nifty, vix]),
    rightsCheck: () => true });
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.provider, 'UPSTOX');
  assert.equal(result.facts.length, 2);
  assert.equal(result.facts[0].freshness.status, 'STALE');
  assert.equal(result.facts[0].value, 25123.45);
  assert.equal(result.facts[0].observedAt, nifty.observedAt.toISOString());
  assert.equal(result.facts[1].freshness.status, 'FRESH');
});

test('stored read hides revoked, expired, and identity-mismatched provider rows', async () => {
  const revoked = await readStoredBenchmarkQuotes({ env, now, Model: fakeModel([nifty, vix]),
    rightsCheck: () => false });
  assert.equal(revoked.status, 'UNAVAILABLE');
  assert.deepEqual(revoked.facts, []);
  const wrongKey = { ...nifty, source: { ...nifty.source, instrumentId: 'NSE_INDEX|Other' } };
  const expired = { ...vix, retainedUntil: new Date('2026-10-20T11:00:00.000Z') };
  const invalid = await readStoredBenchmarkQuotes({ env, now, Model: fakeModel([wrongKey, expired]),
    rightsCheck: () => true });
  assert.equal(invalid.status, 'UNAVAILABLE');
});

test('source-separated bounded reads cannot let revoked provider rows hide an authorized source', async () => {
  const unauthorized = Array.from({ length: 30 }, (_, offset) => {
    const observedAt = new Date(now.getTime() - (offset + 1) * 60_000);
    return { ...nifty, observedAt, providerTimestamp: observedAt,
      lastFetchedAt: observedAt, retainedUntil: new Date(observedAt.getTime() + 3_600_000) };
  });
  const nseObservedAt = new Date('2026-10-20T11:35:00.000Z');
  const nse = { ...nifty, observedAt: nseObservedAt, providerTimestamp: nseObservedAt,
    lastFetchedAt: nseObservedAt,
    retainedUntil: new Date('2026-10-20T12:35:00.000Z'),
    source: { provider: 'NSE', instrumentId: 'NIFTY 50',
      url: 'https://www.nseindia.com/api/allIndices' } };
  const queries = [];
  const result = await readStoredBenchmarkQuotes({ env, now,
    Model: fakeModel([...unauthorized, nse], queries),
    rightsCheck: provider => provider === 'NSE' });
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.provider, 'NSE');
  assert.equal(result.facts[0].source.provider, 'NSE');
  assert.equal(queries.length, 4);
  assert.ok(queries.some(query => query['source.provider'] === 'NSE'));
  assert.ok(queries.some(query => query['source.provider'] === 'UPSTOX'));
});

test('benchmark quote writes require configured retention and preserve nonquote persistence', () => {
  const fact = {
    schemaVersion: nifty.schemaVersion, kind: nifty.kind,
    canonicalProductId: nifty.canonicalProductId, value: nifty.value,
    currency: null, unit: nifty.unit, observedAt: nifty.observedAt.toISOString(),
    fetchedAt: nifty.lastFetchedAt.toISOString(), dataClass: 'LIVE',
    availabilityStatus: 'AVAILABLE', freshness: nifty.freshness, source: nifty.source,
  };
  assert.deepEqual(buildObservationOperations({ facts: [fact] }, { env: {}, now }), []);
  const [quoteOperation] = buildObservationOperations({ facts: [fact] }, {
    env, now, rightsCheck: () => true,
  });
  assert.equal(quoteOperation.updateOne.filter.value, fact.value);
  assert.equal(quoteOperation.updateOne.update.$set, undefined);
  assert.equal(quoteOperation.updateOne.update.$setOnInsert.retainedUntil.toISOString(),
    '2026-10-20T12:40:00.000Z');
  const nonquote = { ...fact, kind: 'SCHEME_INTEREST_RATE', canonicalProductId: 'government:test' };
  assert.equal(buildObservationOperations({ facts: [nonquote] }, { env: {}, now }).length, 1);
});
