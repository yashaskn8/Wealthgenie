import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import test from 'node:test';
import { errorHandler } from '../middleware/errorHandler.js';
import { createUpstoxPublicDataGate } from '../middleware/upstoxPublicDataGate.js';
import { createMarketQuotesRouter } from '../routes/marketQuotes.js';
import { fetchUpstoxCanonicalQuotes } from '../services/marketDataService.js';
import { buildMarketDataCoverage } from '../scripts/generateMarketDataCoverage.js';
import {
  MAX_CANONICAL_UPSTOX_QUOTE_IDS,
  UPSTOX_INSTRUMENT_REGISTRY,
  resolveUpstoxQuoteIdentities,
} from '../services/marketData/upstoxInstrumentRegistry.js';
import { jsonRequest, withServer } from '../test-utils/httpTestUtils.js';

function buildApp(router) {
  const app = express();
  app.use('/api/market-data', router);
  app.use(errorHandler);
  return app;
}

const passLimiter = (_req, _res, next) => next();

test('Upstox quote registry contains only exact, source-documented index identities', () => {
  assert.deepEqual(Object.keys(UPSTOX_INSTRUMENT_REGISTRY).sort(), [
    'market:index:india-vix',
    'market:index:nifty-50',
  ]);
  const [identity] = resolveUpstoxQuoteIdentities(['market:index:nifty-50']);
  assert.equal(identity.upstoxInstrumentKey, 'NSE_INDEX|Nifty 50');
  assert.equal(identity.unit, 'INDEX_POINTS');
  assert.equal(identity.isin, null);
  assert.equal(identity.providerAccessStatus, 'NOT_LIVE_VERIFIED');
});

test('canonical resolver deduplicates request IDs and rejects unknown or oversized requests', () => {
  assert.equal(resolveUpstoxQuoteIdentities([
    'market:index:nifty-50',
    'market:index:nifty-50',
  ]).length, 1);
  assert.throws(
    () => resolveUpstoxQuoteIdentities(['market:index:unsupported']),
    error => error.code === 'UNSUPPORTED_MARKET_INSTRUMENT',
  );
  assert.throws(
    () => resolveUpstoxQuoteIdentities(Array.from(
      { length: MAX_CANONICAL_UPSTOX_QUOTE_IDS + 1 },
      (_, index) => `market:index:unsupported-${index}`,
    )),
    RangeError,
  );
});

test('canonical quote route calls only the injected allowlisted service and returns its DTO', async () => {
  const calls = [];
  const router = createMarketQuotesRouter({
    env: { NODE_ENV: 'test' },
    limiter: passLimiter,
    fetchQuotes: async ids => {
      calls.push(ids);
      return { provider: 'UPSTOX', status: 'UNAVAILABLE', facts: [] };
    },
  });
  await withServer(buildApp(router), async baseUrl => {
    const { response, body } = await jsonRequest(
      `${baseUrl}/api/market-data/quotes?ids=market:index:nifty-50,market:index:india-vix`,
    );
    assert.equal(response.status, 200);
    assert.equal(body.provider, 'UPSTOX');
    assert.deepEqual(calls, [[
      'market:index:nifty-50',
      'market:index:india-vix',
    ]]);
  });
});

test('canonical quote route rejects raw provider keys, unknown IDs, and oversized ID lists before fetching', async () => {
  let calls = 0;
  const router = createMarketQuotesRouter({
    env: { NODE_ENV: 'test' },
    limiter: passLimiter,
    fetchQuotes: async () => { calls += 1; return {}; },
  });
  await withServer(buildApp(router), async baseUrl => {
    for (const ids of [
      'NSE_INDEX|Nifty 50',
      'market:index:unknown',
      Array.from({ length: MAX_CANONICAL_UPSTOX_QUOTE_IDS + 1 }, (_, index) => `market:index:unsupported-${index}`).join(','),
    ]) {
      const { response } = await jsonRequest(`${baseUrl}/api/market-data/quotes?ids=${encodeURIComponent(ids)}`);
      assert.equal(response.status, 400);
    }
  });
  assert.equal(calls, 0);
});

test('production Upstox-derived public output remains disabled without explicit distribution clearance', async () => {
  const gate = createUpstoxPublicDataGate({
    requiresUpstox: true,
    env: { NODE_ENV: 'production', MARKET_DATA_PRIMARY_PROVIDER: 'UPSTOX' },
  });
  const router = createMarketQuotesRouter({
    env: { NODE_ENV: 'production', MARKET_DATA_PRIMARY_PROVIDER: 'UPSTOX' },
    limiter: passLimiter,
    fetchQuotes: async () => assert.fail('The distribution gate must run before quote retrieval.'),
  });
  assert.equal(typeof gate, 'function');
  await withServer(buildApp(router), async baseUrl => {
    const { response, body } = await jsonRequest(
      `${baseUrl}/api/market-data/quotes?ids=market:index:nifty-50`,
    );
    assert.equal(response.status, 503);
    assert.equal(body.code, 'UPSTOX_PUBLIC_DISTRIBUTION_DISABLED');
  });
});

test('production distribution gate allows a path only after explicit operator clearance', async () => {
  const router = createMarketQuotesRouter({
    env: {
      NODE_ENV: 'production',
      MARKET_DATA_PRIMARY_PROVIDER: 'UPSTOX',
      UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED: 'true',
    },
    limiter: passLimiter,
    fetchQuotes: async ids => ({ provider: 'UPSTOX', status: 'PROVIDER_NOT_CONFIGURED', facts: ids }),
  });
  await withServer(buildApp(router), async baseUrl => {
    const { response, body } = await jsonRequest(
      `${baseUrl}/api/market-data/quotes?ids=market:index:nifty-50`,
    );
    assert.equal(response.status, 200);
    assert.equal(body.status, 'PROVIDER_NOT_CONFIGURED');
  });
});

test('canonical quote service preserves unavailable state when no live credential is injected', async () => {
  const snapshot = await fetchUpstoxCanonicalQuotes(['market:index:nifty-50']);
  assert.equal(snapshot.provider, 'UPSTOX');
  assert.equal(snapshot.status, 'PROVIDER_NOT_CONFIGURED');
  assert.equal(snapshot.facts.length, 1);
  assert.equal(snapshot.facts[0].value, null);
  assert.equal(snapshot.facts[0].unit, 'INDEX_POINTS');
  assert.equal(snapshot.facts[0].availabilityStatus, 'UNAVAILABLE');
  assert.equal(snapshot.facts[0].reasonCode, 'PROVIDER_NOT_CONFIGURED');
  assert.equal(snapshot.facts[0].sourceVerification.providerAccessStatus, 'NOT_LIVE_VERIFIED');
});

test('coverage matrix accounts for all catalog entries without treating parent categories as live quotes', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../data/investment_master.json', import.meta.url), 'utf8'));
  const generatedFile = JSON.parse(fs.readFileSync(new URL('../data/market_data_coverage.json', import.meta.url), 'utf8'));
  const coverage = buildMarketDataCoverage(catalog);
  const generatedIds = new Set(generatedFile.entries.map(entry => entry.catalogId));

  assert.equal(catalog.instruments.length, 155);
  assert.equal(coverage.totalCatalogEntries, 155);
  assert.equal(generatedFile.totalCatalogEntries, 155);
  assert.equal(generatedIds.size, 155);
  assert.ok(catalog.instruments.every(instrument => generatedIds.has(instrument.id)));
  assert.equal(coverage.classificationCounts.LIVE_EXCHANGE_QUOTE || 0, 0);
  assert.equal(coverage.classificationCounts.DAILY_NAV || 0, 0);
  assert.equal(coverage.entries.find(entry => entry.catalogId === 'ppf').dataClass, 'PUBLISHED_RATE');
  assert.equal(coverage.entries.find(entry => entry.catalogId === 'rbi_bonds').dataClass, 'AUCTION_OR_BOND_TERMS');
  assert.equal(coverage.entries.find(entry => entry.catalogId === 'futures_and_options').dataClass, 'UNSUPPORTED');
  assert.equal(coverage.entries.find(entry => entry.catalogId === 'index_mf').dataClass, 'EDUCATIONAL_ONLY');
  assert.ok(coverage.entries.every(entry => entry.tejHqIdentityCoverage === false));
});
