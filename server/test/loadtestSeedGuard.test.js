import assert from 'node:assert/strict';
import test from 'node:test';
import { assertIsolatedLoadtestSeedTarget } from '../scripts/loadtestSeedGuard.js';
import { buildInstrumentSeedOperations } from '../config/instrumentSeedPlan.js';

const safe = {
  uri: 'mongodb://127.0.0.1:27017/wealthgenie-loadtest',
  nodeEnv: 'development',
  confirmation: 'I_UNDERSTAND_THIS_WRITES_TEST_DATA',
};

test('load-test fixture must require explicit authorization and a named isolated database', () => {
  assert.deepEqual(assertIsolatedLoadtestSeedTarget(safe), { databaseName: 'wealthgenie-loadtest' });
  assert.deepEqual(assertIsolatedLoadtestSeedTarget({
    ...safe, uri: 'mongodb+srv://account:secret@cluster.example.com/loadtest_ci?retryWrites=true',
    nodeEnv: 'test', connectedDatabaseName: 'loadtest_ci',
  }), { databaseName: 'loadtest_ci' });
  for (const bad of [
    { ...safe, nodeEnv: 'production' },
    { ...safe, nodeEnv: undefined },
    { ...safe, confirmation: 'true' },
    { ...safe, confirmation: '' },
    { ...safe, uri: 'mongodb://127.0.0.1:27017/wealthgenie' },
    { ...safe, uri: 'mongodb://127.0.0.1:27017/production-loadtest' },
    { ...safe, uri: 'mongodb://127.0.0.1:27017/' },
    { ...safe, uri: 'mongodb://127.0.0.1:27017/admin?authSource=admin' },
    { ...safe, uri: 'not a Mongo URI' },
    { ...safe, connectedDatabaseName: 'wealthgenie' },
    { ...safe, connectedDatabaseName: undefined, nodeEnv: 'production' },
  ]) assert.throws(() => assertIsolatedLoadtestSeedTarget(bad));
});

test('loadtest fixture instrument synchronization uses non-destructive upserts', () => {
  const { operations } = buildInstrumentSeedOperations([{
    id: 'loadtest-fixture', name: 'Test instrument', category: 'Fixed Deposit', rate: 0, expectedReturn: 0,
  }]);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].updateOne.upsert, true);
  assert.deepEqual(operations[0].updateOne.filter, { id: 'loadtest-fixture' });
  assert.equal(operations[0].updateOne.update.$setOnInsert.rate, 0);
  assert.equal(Object.hasOwn(operations[0].updateOne.update.$set, 'rate'), false);
});
