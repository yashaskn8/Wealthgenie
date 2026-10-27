import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInstrumentSeedOperations, mapCatalogInstrument } from '../config/instrumentSeedPlan.js';
import { investmentDatabase } from '../data/investmentDatabase.js';

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

test('missing market rates do not become projection assumptions', () => {
  const mapped = mapCatalogInstrument({
    id: 'missing', name: 'Missing rate', expectedReturn: 10, rate: null,
  });
  assert.equal(mapped.expectedReturn, 10);
  assert.equal(mapped.rate, null);
  assert.equal(mapped.interestRate, null);
  const op = buildInstrumentSeedOperations([{ id: 'missing', name: 'Missing rate', expectedReturn: 10, rate: null }]).operations[0];
  assert.equal(op.updateOne.update.$setOnInsert.rate, null);
  assert.equal(op.updateOne.update.$setOnInsert.interestRate, null);
});

test('a new composite-strategy Mongo row does not receive zero cost, zero lock-in, or medium risk defaults', () => {
  const strategy = investmentDatabase.find(item => item.id === 'term_mf_combo');
  assert.equal(strategy.type, 'Planning_Strategy');
  const mapped = mapCatalogInstrument(strategy);
  assert.equal(mapped.type, 'Planning_Strategy');
  for (const field of ['expectedReturn', 'rate', 'interestRate', 'risk', 'lockIn', 'lockInYears', 'expenseRatio']) {
    assert.equal(mapped[field], null, field);
  }
});

test('a new ULIP discovery row does not receive fabricated rate, tax, cost, or risk values', () => {
  const entry = investmentDatabase.find(item => item.id === 'ulip');
  const mapped = mapCatalogInstrument(entry);
  assert.equal(mapped.type, 'Insurance_Archetype');
  for (const field of ['expectedReturn', 'rate', 'interestRate', 'risk', 'lockIn', 'lockInYears',
    'expenseRatio', 'taxType']) assert.equal(mapped[field], null, field);
});

test('a new endowment discovery row does not receive fabricated return, exemption or cost', () => {
  const source = investmentDatabase.find(item => item.id === 'endowment_plan');
  const mapped = mapCatalogInstrument(source);
  assert.equal(mapped.type, 'Insurance_Archetype');
  assert.equal(mapped.expectedReturn, null);
  assert.equal(mapped.rate, null);
  assert.equal(mapped.taxType, null);
  assert.equal(mapped.risk, null);
  assert.equal(mapped.lockIn, null);
  assert.equal(mapped.expenseRatio, null);
});

test('a new blue-chip stock discovery row is not seeded as an ETF or with a fund return', () => {
  const source = investmentDatabase.find(item => item.id === 'bluechip_stocks');
  const mapped = mapCatalogInstrument(source);
  assert.equal(mapped.type, 'Equity_Archetype');
  for (const field of ['expectedReturn', 'rate', 'risk', 'lockIn', 'expenseRatio', 'taxType']) {
    assert.equal(mapped[field], null, field);
  }
});

test('a new AA bond discovery row is not seeded as government debt or with invented bond terms', () => {
  const source = investmentDatabase.find(item => item.id === 'aa_corporate_bond');
  const mapped = mapCatalogInstrument(source);
  assert.equal(mapped.type, 'Bond_Archetype');
  for (const field of ['expectedReturn', 'rate', 'interestRate', 'risk', 'lockIn', 'lockInYears',
    'expenseRatio', 'taxType']) assert.equal(mapped[field], null, field);
});

test('master catalog structured tax disclosure matches the legacy string schema', () => {
  const item = { id: 'x', name: 'Example', taxation: {
    status: 'TAX_CLASSIFICATION_UNAVAILABLE',
    desc: 'Tax treatment requires current server calculation',
    label: 'Unavailable',
  } };
  const op = buildInstrumentSeedOperations([item]).operations[0];
  assert.equal(op.updateOne.update.$setOnInsert.taxation, 'Tax treatment requires current server calculation');
  assert.equal(typeof op.updateOne.update.$setOnInsert.taxation, 'string');
});

test('all authoritative catalog product types survive persistence without reclassification', () => {
  assert.ok(investmentDatabase.length >= 100);
  const { operations } = buildInstrumentSeedOperations(investmentDatabase);
  assert.equal(operations.length, investmentDatabase.length);
  for (let i = 0; i < investmentDatabase.length; i += 1) {
    const source = investmentDatabase[i];
    const saved = operations[i].updateOne.update.$set;
    assert.equal(saved.type, source.type, `incorrect instrument classification for ${source.id}`);
  }
  const byId = new Map(operations.map(op => [op.updateOne.filter.id, op.updateOne.update.$set.type]));
  assert.equal(byId.get('ppf'), 'PPF');
  assert.equal(byId.get('scss'), 'SCSS');
  assert.equal(byId.get('sbi_fd'), 'FD');
  assert.equal(byId.get('nifty_etf'), 'ETF');
  assert.equal(byId.get('rbi_bonds'), 'RBI_Bond');
});
