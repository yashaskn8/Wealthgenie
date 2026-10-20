import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import mongoose from 'mongoose';
import MarketEquityDailyBar from '../models/MarketEquityDailyBar.js';
import MarketObservation from '../models/MarketObservation.js';
import InvestmentProduct from '../models/InvestmentProduct.js';
import { createMarketDataAdminRouter } from '../routes/marketDataAdmin.js';
import { createMarketQuotesRouter } from '../routes/marketQuotes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { buildObservationOperations, persistVerifiedMarketSnapshot } from '../services/marketData/MarketDataRepository.js';
import { persistQualifiedHistory, readQualifiedHistory } from '../services/marketData/QualifiedEquityHistoryStore.js';
import { readStoredBenchmarkQuotes } from '../services/marketData/StoredBenchmarkQuoteStore.js';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';
import { jsonRequest, withServer } from '../test-utils/httpTestUtils.js';

const isin = 'ZZ0000000001'; // Deterministic test-only identity, never a production instrument.
const request = { exchange: 'NSE', symbol: 'FIXTURE', isin,
  fromDate: '2026-10-15', toDate: '2026-10-16', basis: 'RAW' };
const env = { MARKET_EQUITY_HISTORY_STORE_ENABLED: 'true',
  MARKET_EQUITY_HISTORY_RETENTION_DAYS: '30' };
const now = new Date('2026-10-19T12:00:00.000Z');
const candleUrl = `https://api.upstox.com/v3/historical-candle/NSE_EQ%7C${isin}/days/1/2026-10-16/2026-10-15`;
const chain = [
  { provider: 'UPSTOX', url: candleUrl },
  { provider: 'UPSTOX', url: 'https://api.upstox.com/v2/market/holidays' },
];
const snapshot = {
  schemaVersion: 'market-fact-1.0.0', status: 'AVAILABLE', provider: 'UPSTOX',
  canonicalProductId: `market:equity:nse:${isin}`,
  instrumentIdentity: { exchange: 'NSE', symbol: null, isin },
  priceBasis: 'UPSTOX_PROVIDER_NATIVE',
  candleCount: 2, fetchedAt: '2026-10-19T11:00:00.000Z',
  coverage: { status: 'COMPLETE_FOR_UPSTOX_NSE_CALENDAR',
    calendarProvider: 'UPSTOX', expectedSessionCount: 2, observedSessionCount: 2 },
  qualificationSourceUrls: chain,
  source: { provider: 'UPSTOX', instrumentId: `NSE_EQ|${isin}`, url: candleUrl },
  candles: [
    { timestamp: '2026-10-15T04:00:00.000Z', open: 101, high: 104, low: 99, close: 102, volume: 100 },
    { timestamp: '2026-10-16T04:00:00.000Z', open: 102, high: 107, low: 101, close: 106, volume: 110 },
  ],
};

test('qualified fixture survives Mongo transaction, duplicate ingest, restart and rights recheck', async () => {
  await setupTestDatabase({ requireReplicaSet: true });
  try {
    await MarketEquityDailyBar.createIndexes();
    await MarketEquityDailyBar.deleteMany({ isin });
    const options = { env, now, rightsCheck: () => true };
    assert.equal((await persistQualifiedHistory(snapshot, request, options)).status, 'PERSISTED');
    assert.equal((await persistQualifiedHistory(snapshot, request, options)).status, 'PERSISTED');
    assert.equal(await MarketEquityDailyBar.countDocuments({ isin }), 2);
    const stored = await MarketEquityDailyBar.findOne({ isin, tradingDate: '2026-10-16' }).lean();
    assert.equal(stored.close, 106);
    assert.equal(stored.fetchedAt.toISOString(), snapshot.fetchedAt);
    assert.deepEqual(stored.source.qualificationSourceUrls.map(item => item.provider),
      chain.map(item => item.provider));

    const subset = { ...request, fromDate: '2026-10-16' };
    const firstRead = await readQualifiedHistory(subset, options);
    assert.equal(firstRead.status, 'AVAILABLE');
    assert.equal(firstRead.barCount, 1);
    assert.equal(firstRead.bars[0].close, 106);
    assert.equal(new Date(firstRead.bars[0].fetchedAt).toISOString(), snapshot.fetchedAt);
    const revoked = await readQualifiedHistory(subset, { ...options,
      rightsCheck: (_provider, url) => !url.endsWith('/market/holidays') });
    assert.equal(revoked.status, 'UNAVAILABLE');

    const corrected = { ...snapshot, fetchedAt: '2026-10-19T11:30:00.000Z',
      candles: [snapshot.candles[0], { ...snapshot.candles[1], close: 105 }] };
    const conflict = await persistQualifiedHistory(corrected, request, options);
    assert.equal(conflict.code, 'MARKET_HISTORY_REVISION_CONFLICT');
    assert.equal(await MarketEquityDailyBar.countDocuments({ isin }), 2);
    assert.equal((await MarketEquityDailyBar.findOne({ isin, tradingDate: '2026-10-16' }).lean()).close, 106);

    await mongoose.disconnect();
    await setupTestDatabase({ requireReplicaSet: true });
    const afterRestart = await readQualifiedHistory(subset, options);
    assert.equal(afterRestart.status, 'AVAILABLE');
    assert.equal(afterRestart.bars[0].close, 106);

    const app = express();
    app.use('/api/market-data', createMarketDataAdminRouter({
      authenticate(req, res, next) {
        if (req.headers.authorization !== 'Bearer fixture-user') {
          res.status(401).json({ code: 'AUTH_REQUIRED' }); return;
        }
        req.user = { userId: '64a000000000000000000001', role: 'user' };
        next();
      },
      limiter(_req, _res, next) { next(); },
      readStoredHistory: query => readQualifiedHistory(query, options),
    }));
    app.use(errorHandler);
    await withServer(app, async base => {
      const url = `${base}/api/market-data/equity-history/persisted?${new URLSearchParams(subset)}`;
      const denied = await jsonRequest(url);
      assert.equal(denied.response.status, 401);
      const authorized = await jsonRequest(url, {
        headers: { Authorization: 'Bearer fixture-user' },
      });
      assert.equal(authorized.response.status, 200);
      assert.equal(authorized.response.headers.get('cache-control'), 'private, no-store');
      assert.equal(authorized.body.status, 'AVAILABLE');
      assert.equal(authorized.body.barCount, 1);
      assert.equal(authorized.body.bars[0].close, 106);
      assert.equal(authorized.body.bars[0].provider, 'UPSTOX');
    });
  } finally {
    if (mongoose.connection.readyState === 1) await MarketEquityDailyBar.deleteMany({ isin });
    await teardownTestDatabase();
  }
});

test('rights-qualified benchmark fixture is retained in Mongo and exposed only to an authenticated read', async () => {
  await setupTestDatabase({ requireReplicaSet: true });
  const quoteEnv = { NODE_ENV: 'test', MARKET_BENCHMARK_QUOTE_STORE_ENABLED: 'true',
    MARKET_BENCHMARK_QUOTE_RETENTION_SECONDS: '3600' };
  const quoteNow = new Date('2026-10-20T12:00:00.000Z');
  const source = { provider: 'UPSTOX', instrumentId: 'NSE_INDEX|Nifty 50',
    url: 'https://api.upstox.com/v3/market-quote/quotes?instrument_key=NSE_INDEX%7CNifty%2050' };
  const quoteIdentity = { kind: 'MARKET_QUOTE', canonicalProductId: 'market:index:nifty-50',
    'source.provider': 'UPSTOX' };
  try {
    await MarketObservation.createIndexes();
    await MarketObservation.deleteMany(quoteIdentity);
    const fact = {
      schemaVersion: 'market-fact-1.0.0', kind: 'MARKET_QUOTE',
      canonicalProductId: 'market:index:nifty-50', value: 25123.45,
      unit: 'INDEX_POINTS', currency: null, availabilityStatus: 'AVAILABLE',
      dataClass: 'LIVE', observedAt: '2026-10-20T11:40:00.000Z',
      fetchedAt: '2026-10-20T11:45:00.000Z',
      freshness: { status: 'FRESH', ageSeconds: 300, maxAgeSeconds: 900 }, source,
    };
    const operations = buildObservationOperations({ facts: [fact] }, {
      env: quoteEnv, now: quoteNow, rightsCheck: () => true,
    });
    assert.equal(operations.length, 1);
    await MarketObservation.bulkWrite(operations, { ordered: true });
    const read = () => readStoredBenchmarkQuotes({ env: quoteEnv, now: quoteNow,
      rightsCheck: () => true });
    const stored = await read();
    assert.equal(stored.status, 'PARTIAL');
    assert.equal(stored.facts[0].value, 25123.45);
    assert.equal(stored.facts[0].freshness.status, 'STALE');
    assert.equal((await readStoredBenchmarkQuotes({ env: quoteEnv, now: quoteNow,
      rightsCheck: () => false })).status, 'UNAVAILABLE');

    const app = express();
    app.use('/api/market-data', createMarketQuotesRouter({
      env: quoteEnv, limiter(_req, _res, next) { next(); },
      verifySession(req, res, next) {
        if (req.headers.authorization !== 'Bearer fixture-user') {
          res.status(401).json({ code: 'AUTH_REQUIRED' }); return;
        }
        req.user = { userId: '64a000000000000000000001' };
        next();
      },
      readStoredQuotes: read,
    }));
    app.use(errorHandler);
    await withServer(app, async base => {
      const url = `${base}/api/market-data/quotes/persisted`;
      assert.equal((await jsonRequest(url)).response.status, 401);
      const result = await jsonRequest(url, {
        headers: { Authorization: 'Bearer fixture-user' },
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.response.headers.get('cache-control'), 'private, no-store');
      assert.equal(result.body.facts[0].value, 25123.45);
      assert.equal(result.body.facts[0].source.provider, 'UPSTOX');
    });
  } finally {
    if (mongoose.connection.readyState === 1) await MarketObservation.deleteMany(quoteIdentity);
    await teardownTestDatabase();
  }
});

test('catalog and immutable observations publish atomically, preserving first evidence on a conflicting correction', async () => {
  await setupTestDatabase({ requireReplicaSet: true });
  const canonicalProductId = 'mf:fixture:immutable-observation';
  const source = { provider: 'AMFI', instrumentId: 'fixture-scheme-123',
    url: 'https://portal.amfiindia.com/spages/NAVAll.txt' };
  const observedAt = '2026-10-19T00:00:00.000Z';
  const snapshot = (value, fetchedAt, name) => ({
    schemaVersion: 'market-fact-1.0.0', status: 'AVAILABLE', fetchedAt,
    products: [{ schemaVersion: 'market-fact-1.0.0', canonicalProductId,
      productType: 'MUTUAL_FUND', name, source: { provider: 'AMFI', url: source.url } }],
    facts: [{ schemaVersion: 'market-fact-1.0.0', kind: 'MUTUAL_FUND_NAV',
      canonicalProductId, value, unit: 'NAV_PER_UNIT', currency: 'INR',
      observedAt, fetchedAt, availabilityStatus: 'AVAILABLE', dataClass: 'DAILY',
      freshness: { status: 'FRESH', ageSeconds: 60, maxAgeSeconds: 86_400 }, source }],
  });
  const productFilter = { canonicalProductId };
  const observationFilter = { kind: 'MUTUAL_FUND_NAV', canonicalProductId };
  try {
    await InvestmentProduct.deleteMany(productFilter);
    await MarketObservation.deleteMany(observationFilter);
    assert.equal((await persistVerifiedMarketSnapshot(snapshot(12.34, '2026-10-20T10:00:00.000Z', 'Original name'))).status, 'PERSISTED');
    const original = await MarketObservation.findOne(observationFilter).lean();
    assert.equal(original.value, 12.34);
    assert.equal((await persistVerifiedMarketSnapshot(snapshot(12.34, '2026-10-20T11:00:00.000Z', 'Updated name'))).status, 'PERSISTED');
    const repeated = await MarketObservation.findOne(observationFilter).lean();
    assert.equal(repeated.firstFetchedAt.toISOString(), original.firstFetchedAt.toISOString());
    assert.equal(repeated.lastFetchedAt.toISOString(), original.lastFetchedAt.toISOString());
    assert.equal((await InvestmentProduct.findOne(productFilter).lean()).name, 'Updated name');
    await assert.rejects(
      persistVerifiedMarketSnapshot(snapshot(12.35, '2026-10-20T12:00:00.000Z', 'Unpublished correction')),
      error => error.code === 11000,
    );
    assert.equal((await InvestmentProduct.findOne(productFilter).lean()).name, 'Updated name');
    assert.equal((await MarketObservation.findOne(observationFilter).lean()).value, 12.34);
    assert.equal(await MarketObservation.countDocuments(observationFilter), 1);
    const provenanceCorrection = snapshot(12.34, '2026-10-20T12:30:00.000Z', 'Unpublished provenance');
    provenanceCorrection.facts[0].source = { ...source,
      url: 'https://example.invalid/changed-source' };
    await assert.rejects(
      persistVerifiedMarketSnapshot(provenanceCorrection),
      error => error.code === 11000,
    );
    assert.equal((await InvestmentProduct.findOne(productFilter).lean()).name, 'Updated name');
    assert.equal((await MarketObservation.findOne(observationFilter).lean()).source.url, source.url);
    await assert.rejects(
      persistVerifiedMarketSnapshot(snapshot(12.34, '2026-10-20T09:00:00.000Z', 'Stale name')),
      error => error.code === 11000,
    );
    assert.equal((await InvestmentProduct.findOne(productFilter).lean()).name, 'Updated name');
  } finally {
    if (mongoose.connection.readyState === 1) {
      await InvestmentProduct.deleteMany(productFilter);
      await MarketObservation.deleteMany(observationFilter);
    }
    await teardownTestDatabase();
  }
});
