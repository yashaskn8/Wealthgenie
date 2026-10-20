import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInstrumentSeedOperations, mapCatalogInstrument } from '../config/instrumentSeedPlan.js';

test('catalog seed is idempotent non-destructive upserts, never collection-wide delete', () => {
  const { operations, typeCounts } = buildInstrumentSeedOperations([
    { id: 'seed-1', name: 'Example FD', category: 'Fixed Deposit', rate: 0, expectedReturn: 0, expenseRatio: 0 },
    { id: 'seed-2', name: 'Example Fund', category: 'Mutual Fund', expectedReturn: 6 },
  ]);
  assert.equal(operations.length, 2);
  assert.deepEqual(typeCounts, { FD: 1, Mutual_Fund: 1 });
  assert.deepEqual(operations[0].updateOne.filter, { id: 'seed-1' });
  assert.equal(operations[0].updateOne.upsert, true);
  assert.equal(operations[0].updateOne.update.$setOnInsert.expectedReturn, 0);
  assert.equal(operations[0].updateOne.update.$setOnInsert.interestRate, 0);
  assert.equal(operations[0].updateOne.update.$setOnInsert.rate, 0);
  assert.equal(Object.hasOwn(operations[0].updateOne.update.$set, 'rate'), false);
  assert.equal(Object.hasOwn(operations[0].updateOne.update.$set, 'expectedReturn'), false);
  assert.equal(Object.hasOwn(operations[0].updateOne.update.$set, 'expenseRatio'), false);
  assert.equal(Object.hasOwn(operations[0].updateOne.update.$set, 'taxType'), false);
  for (const operation of operations) {
    assert.deepEqual(Object.keys(operation), ['updateOne']);
    const update = operation.updateOne.update;
    assert.ok(Object.keys(update).every(key => ['$set', '$setOnInsert'].includes(key)));
    assert.equal(Object.hasOwn(update.$set, 'nav'), false);
    assert.equal(Object.hasOwn(update.$set, 'createdAt'), false);
    assert.equal(Object.hasOwn(update.$set, 'returns1yr'), false);
  }
});

test('invalid/duplicate catalog is rejected before any database mutation is constructed', () => {
  for (const input of [null, [], [{ id: '', name: 'A' }], [{ id: 'a', name: '' }],
    [{ id: 'same', name: 'A' }, { id: 'same', name: 'B' }],
    [{ id: 'x', name: 'A', expectedReturn: Number.NaN }],
    [{ id: 'x', name: 'A', rate: Infinity }],
    [{ id: 'x', name: 'A', expenseRatio: 'unknown' }],
  ]) assert.throws(() => buildInstrumentSeedOperations(input));
});

test('legitimate zero and absent fields are not rewritten as nonzero fallbacks', () => {
  assert.equal(mapCatalogInstrument({ id: 'a', name: 'A', rate: 7, expectedReturn: 0 }).expectedReturn, 0);
  assert.equal(mapCatalogInstrument({ id: 'a', name: 'A', interestRate: 0, rate: 9 }).interestRate, 0);
  assert.equal(mapCatalogInstrument({ id: 'a', name: 'A', minMonthlyInvestment: 0, minInvestment: 500 }).minInvestment, 0);
  const unmapped = buildInstrumentSeedOperations([{ id: 'a', name: 'A' }]).operations[0].updateOne.update;
  assert.equal(Object.hasOwn(unmapped.$set, 'expectedReturn'), false);
  assert.equal(Object.hasOwn(unmapped.$set, 'rate'), false);
  assert.equal(Object.hasOwn(unmapped.$setOnInsert ?? {}, 'expectedReturn'), false);
});

test('a catalog refresh may rename an instrument but cannot rewrite a stored rate or tax classification', () => {
  const [{ updateOne }] = buildInstrumentSeedOperations([{
    id: 'test-fd', name: 'Renamed Deposit', category: 'Fixed Deposit',
    expectedReturn: 7.1, interestRate: 7.1, rate: 7.1,
    expenseRatio: 0.1, taxType: 'slab',
  }]).operations;
  assert.equal(updateOne.update.$set.name, 'Renamed Deposit');
  for (const field of ['expectedReturn', 'rate', 'interestRate', 'expenseRatio', 'taxType']) {
    assert.equal(Object.hasOwn(updateOne.update.$set, field), false);
    assert.equal(Object.hasOwn(updateOne.update.$setOnInsert, field), true);
  }
});
