import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import InvestmentProduct from '../models/InvestmentProduct.js';
import MarketObservation from '../models/MarketObservation.js';
import { getRuntimeConfig } from '../config/runtime.js';
import {
  buildHistoryObservationOperations,
  buildMarketContextObservationOperation,
  buildObservationOperations,
  buildProductOperations,
} from '../services/marketData/MarketDataRepository.js';
import { AVAILABILITY } from '../services/marketData/contracts.js';
import {
  MARKET_DATA_INDEX_MODELS,
  migrateMarketDataPersistenceIndexes,
  verifyMarketDataPersistenceIndexes,
} from '../services/persistenceIndexReadiness.js';

const PRODUCT_IDENTITY = { canonicalProductId: 1 };
const OBSERVATION_IDENTITY = {
  kind: 1,
  'source.provider': 1,
  'source.instrumentId': 1,
  observedAt: 1,
};

function uniqueSchemaIndexes(model) {
  return model.schema.indexes()
    .filter(([, options]) => options.unique === true)
    .map(([key]) => key);
}

function fakeModel(model, { initialIndexes = [], createIndex } = {}) {
  let indexes = initialIndexes;
  const created = [];
  const dropped = [];
  return {
    modelName: model.modelName,
    schema: model.schema,
    collection: {
      collectionName: model.collection.collectionName,
      async indexes() { return indexes; },
      async createIndex(key, options) {
        created.push({ key, options });
        if (createIndex) return createIndex(key, options);
        const existing = indexes.find(index => JSON.stringify(index.key) === JSON.stringify(key));
        if (existing?.unique === true) return existing.name;
        const name = options.name || Object.keys(key).map(part => `${part.replaceAll('.', '_')}_${key[part]}`).join('_');
        indexes = [...indexes, { key, unique: options.unique === true, name }];
        return name;
      },
      async dropIndex(name) { dropped.push(name); },
    },
    created,
    dropped,
    async createCollection() {},
  };
}

test('market-data migration definition includes the exact product and observation unique identities', () => {
  assert.deepEqual(MARKET_DATA_INDEX_MODELS, [InvestmentProduct, MarketObservation]);
  assert.deepEqual(uniqueSchemaIndexes(InvestmentProduct), [PRODUCT_IDENTITY]);
  assert.deepEqual(uniqueSchemaIndexes(MarketObservation), [OBSERVATION_IDENTITY]);
  assert.equal(MarketObservation.schema.indexes().some(([key, options]) => (
    options.unique === true && options.name === 'unique_verified_market_observation'
      && JSON.stringify(key) === JSON.stringify(OBSERVATION_IDENTITY)
  )), true);
});

test('market-data migration is idempotent and does not drop any existing indexes', async () => {
  const product = fakeModel(InvestmentProduct);
  const observation = fakeModel(MarketObservation);

  await migrateMarketDataPersistenceIndexes({ models: [product, observation] });
  const afterFirstRun = [
    ...await product.collection.indexes(),
    ...await observation.collection.indexes(),
  ];
  await migrateMarketDataPersistenceIndexes({ models: [product, observation] });
  const afterSecondRun = [
    ...await product.collection.indexes(),
    ...await observation.collection.indexes(),
  ];

  assert.equal(afterFirstRun.length, 2);
  assert.deepEqual(afterSecondRun, afterFirstRun);
  assert.equal(product.created.length, 2);
  assert.equal(observation.created.length, 2);
  assert.deepEqual(product.dropped, []);
  assert.deepEqual(observation.dropped, []);
});

test('market-data migration surfaces duplicate-key failure without deleting data or indexes', async () => {
  const duplicate = Object.assign(new Error('E11000 duplicate key error'), {
    code: 11000,
    codeName: 'DuplicateKey',
    keyValue: { canonicalProductId: 'mf:duplicate' },
  });
  const product = fakeModel(InvestmentProduct, { createIndex: async () => { throw duplicate; } });
  const observation = fakeModel(MarketObservation);

  await assert.rejects(
    migrateMarketDataPersistenceIndexes({ models: [product, observation] }),
    error => error.code === 'MARKET_DATA_INDEX_DUPLICATES'
      && error.report.collection === InvestmentProduct.collection.collectionName
      && error.report.duplicateKey.canonicalProductId === 'mf:duplicate',
  );
  assert.equal(observation.created.length, 0, 'migration stops visibly at the conflicting identity index');
  assert.deepEqual(product.dropped, []);
  assert.deepEqual(observation.dropped, []);
});

test('market-data migration surfaces non-duplicate index creation failures', async () => {
  const product = fakeModel(InvestmentProduct, {
    createIndex: async () => { throw Object.assign(new Error('permission denied'), { code: 13 }); },
  });
  await assert.rejects(
    migrateMarketDataPersistenceIndexes({ models: [product] }),
    error => error.code === 'MARKET_DATA_INDEX_CREATION_FAILED'
      && error.report.collection === InvestmentProduct.collection.collectionName
      && error.report.mongoCode === 13,
  );
});

test('production defaults to autoIndex off and market-data startup verification is read-only', async () => {
  const production = getRuntimeConfig({ NODE_ENV: 'production' });
  assert.equal(production.mongo.autoIndex, false);

  const product = fakeModel(InvestmentProduct);
  let createCalls = 0;
  product.collection.createIndex = async () => { createCalls += 1; };
  await assert.rejects(
    verifyMarketDataPersistenceIndexes({ models: [product], force: true }),
    error => error.status === 503
      && error.code === 'PERSISTENCE_INDEXES_UNAVAILABLE'
      && error.clientDetails.missing.some(value => value.includes('canonicalProductId')),
  );
  assert.equal(createCalls, 0);
});

test('all market-data repository upsert filters match declared unique identity indexes', () => {
  const observedAt = new Date('2026-09-30T10:00:00.000Z');
  const source = { provider: 'NSE', instrumentId: 'NIFTY 50', url: 'https://example.invalid/source' };
  const productOperation = buildProductOperations({
    fetchedAt: observedAt.toISOString(),
    products: [{ canonicalProductId: 'index:nifty50' }],
  })[0].updateOne;
  const fact = {
    kind: 'MARKET_HISTORY_CANDLE',
    availabilityStatus: AVAILABILITY.AVAILABLE,
    value: 25000,
    observedAt,
    fetchedAt: observedAt,
    source,
  };
  const observationOperation = buildObservationOperations({ facts: [fact] })[0].updateOne;
  const historyOperation = buildHistoryObservationOperations({
    status: AVAILABILITY.AVAILABLE,
    fetchedAt: observedAt,
    source,
    instrumentKey: 'index:nifty50',
    candles: [{ close: 25000, timestamp: observedAt }],
  })[0].updateOne;
  const contextOperation = buildMarketContextObservationOperation({
    storedAt: observedAt,
    marketContext: { marketSnapshot: { observedFacts: [{ ...fact, observedAt: observedAt.toISOString(), key: 'nifty50Current' }] } },
  }).updateOne;

  assert.deepEqual(productOperation.filter, { canonicalProductId: 'index:nifty50' });
  assert.deepEqual(Object.keys(PRODUCT_IDENTITY), Object.keys(uniqueSchemaIndexes(InvestmentProduct)[0]));
  for (const operation of [observationOperation, historyOperation, contextOperation]) {
    assert.deepEqual(Object.keys(operation.filter), Object.keys(OBSERVATION_IDENTITY));
    assert.deepEqual(Object.keys(OBSERVATION_IDENTITY), Object.keys(uniqueSchemaIndexes(MarketObservation)[0]));
    assert.equal(operation.upsert, true);
  }

  const quote = buildObservationOperations({ facts: [{
    ...fact,
    kind: 'MARKET_QUOTE',
    canonicalProductId: 'market:index:nifty-50',
    unit: 'INDEX_POINTS',
    dataClass: 'LIVE',
  }] }, {
    env: { MARKET_BENCHMARK_QUOTE_STORE_ENABLED: 'true',
      MARKET_BENCHMARK_QUOTE_RETENTION_SECONDS: '3600' },
    now: new Date(observedAt.getTime() + 1000),
    rightsCheck: () => true,
  })[0].updateOne;
  assert.deepEqual(Object.keys(quote.filter).slice(0, -1), Object.keys(OBSERVATION_IDENTITY));
  assert.equal(quote.filter.value, fact.value, 'quote correction conflicts with the unique identity');
  assert.ok(quote.update.$setOnInsert);
  assert.equal(quote.upsert, true);
});

test('the explicit migration script provisions market-data indexes and startup verifies before listen', () => {
  const migrationScript = fs.readFileSync(new URL('../scripts/migratePhase2Indexes.js', import.meta.url), 'utf8');
  const serverBootstrap = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const migrationCall = migrationScript.indexOf('await migrateMarketDataPersistenceIndexes();');
  const startupCheck = serverBootstrap.indexOf('await verifyMarketDataPersistenceIndexes({ force: true });');
  const listener = serverBootstrap.indexOf('server.listen(config.port)');

  assert.ok(migrationCall > migrationScript.indexOf('autoIndex: false'));
  assert.ok(startupCheck > serverBootstrap.indexOf('await connectDB('));
  assert.ok(listener > startupCheck, 'missing indexes fail startup before the API listens');
});
