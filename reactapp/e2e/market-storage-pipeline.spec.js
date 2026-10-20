import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test, expect } from '@playwright/test';
import MarketObservation from '../../server/models/MarketObservation.js';
import UpstoxMarketDataProvider from '../../server/services/marketData/UpstoxMarketDataProvider.js';
import { buildObservationOperations } from '../../server/services/marketData/MarketDataRepository.js';
import { readStoredBenchmarkQuotes } from '../../server/services/marketData/StoredBenchmarkQuoteStore.js';
import { createMarketQuotesRouter } from '../../server/routes/marketQuotes.js';
import { errorHandler } from '../../server/middleware/errorHandler.js';
import { setupTestDatabase, teardownTestDatabase } from '../../server/test/helpers/mongoTestHelper.js';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const express = requireServer('express');
const mongoose = requireServer('mongoose');

const now = new Date('2026-10-20T12:00:00.000Z');
const observedAt = new Date(now.getTime() - 60_000);
const env = { NODE_ENV: 'test', MARKET_BENCHMARK_QUOTE_STORE_ENABLED: 'true',
  MARKET_BENCHMARK_QUOTE_RETENTION_SECONDS: '3600' };
const identity = { kind: 'MARKET_QUOTE', canonicalProductId: 'market:index:nifty-50',
  'source.provider': 'UPSTOX' };

test('fixture provider → Mongo → authenticated API → React preserves one exact quote and survives server restart @market-storage', async ({ page }) => {
  await setupTestDatabase({ requireReplicaSet: true });
  let server;
  let rightsAllowed = true;
  const listen = () => new Promise((resolve, reject) => {
    const app = express();
    app.use('/api/market-data', createMarketQuotesRouter({
      env,
      limiter(_req, _res, next) { next(); },
      verifySession(req, res, next) {
        if (req.headers.authorization !== 'Bearer fixture-user') {
          res.status(401).json({ code: 'AUTH_REQUIRED' }); return;
        }
        req.user = { userId: '64a000000000000000000001' };
        next();
      },
      readStoredQuotes: () => readStoredBenchmarkQuotes({ env, now, rightsCheck: () => rightsAllowed }),
    }));
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    server.on('error', reject);
  });
  const stop = () => new Promise((resolve, reject) => {
    if (!server) { resolve(); return; }
    server.close(error => error ? reject(error) : resolve());
    server = null;
  });
  try {
    await MarketObservation.createIndexes();
    await MarketObservation.deleteMany(identity);
    const transport = { get: async () => ({ data: { status: 'success', data: {
      'NSE_INDEX:Nifty 50': {
        instrument_token: 'NSE_INDEX|Nifty 50', last_price: 25123.45,
        last_trade_time: String(observedAt.getTime()), timestamp: now.toISOString(),
        ohlc: { open: 25000, high: 25200, low: 24900, close: 25100 },
      },
    } } }) };
    const provider = new UpstoxMarketDataProvider({
      env, accessToken: 'fixture-token', clock: () => now, httpClient: transport,
      requestCache: ({ loader }) => loader(),
    });
    const snapshot = await provider.getQuotes(['NSE_INDEX|Nifty 50'], { forceRefresh: true });
    assert.equal(snapshot.status, 'AVAILABLE');
    assert.equal(snapshot.facts[0].value, 25123.45);
    assert.equal(snapshot.facts[0].observedAt, observedAt.toISOString());
    const operations = buildObservationOperations(snapshot, { env, now, rightsCheck: () => true });
    assert.equal(operations.length, 1);
    await MarketObservation.bulkWrite(operations, { ordered: true });
    assert.equal(await MarketObservation.countDocuments(identity), 1);

    let base = await listen();
    const readUrl = () => `${base}/api/market-data/quotes/persisted`;
    assert.equal((await fetch(readUrl())).status, 401);
    const apiResponse = await fetch(readUrl(), { headers: { Authorization: 'Bearer fixture-user' } });
    assert.equal(apiResponse.status, 200);
    const api = await apiResponse.json();
    assert.equal(api.facts[0].value, 25123.45);
    assert.equal(api.facts[0].observedAt, observedAt.toISOString());
    assert.equal(api.facts[0].source.provider, 'UPSTOX');

    await page.route('**/api/market-data/quotes/persisted', async route => {
      const response = await fetch(readUrl(), { headers: { Authorization: 'Bearer fixture-user' } });
      await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
    });
    await page.goto('/e2e/market-storage-harness.html');
    await page.getByRole('button', { name: 'View stored prices and history' }).click();
    await expect(page.getByText('25,123.45')).toBeVisible();
    await expect(page.getByText('Source: UPSTOX')).toBeVisible();
    await expect(page.getByText(/Provider observed: 20 Oct 2026/)).toBeVisible();

    await stop();
    base = await listen();
    await page.reload();
    await page.getByRole('button', { name: 'View stored prices and history' }).click();
    await expect(page.getByText('25,123.45')).toBeVisible();
    const persisted = await MarketObservation.findOne(identity).lean();
    assert.equal(persisted.value, api.facts[0].value);
    assert.equal(persisted.observedAt.toISOString(), api.facts[0].observedAt);
    assert.equal(persisted.source.url, api.facts[0].source.url);

    rightsAllowed = false;
    await page.reload();
    await page.getByRole('button', { name: 'View stored prices and history' }).click();
    await expect(page.getByText('No authorized stored benchmark observations are available.')).toBeVisible();
    await expect(page.getByText('25,123.45')).toHaveCount(0);
  } finally {
    await stop();
    if (mongoose.connection.readyState === 1) await MarketObservation.deleteMany(identity);
    await teardownTestDatabase();
  }
});
