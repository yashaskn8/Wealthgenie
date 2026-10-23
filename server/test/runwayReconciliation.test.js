import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunwayMatchCandidates, prepareRunwaySettlement } from '../services/runwayReconciliation.js';

const today = '2026-10-23', id = n => n.repeat(64);
const ledger = {
  asOfDate: today, confirmationDate: today, openingCashPaise: '5000000',
  entries: [
    { id: 'rent', label: 'Rent', kind: 'OBLIGATION', amountPaise: '1500000',
      date: today, recurrence: 'NONE' },
    { id: 'salary', label: 'Salary', kind: 'EXPECTED_INCOME', amountPaise: '3000000',
      date: today, recurrence: 'NONE' },
    { id: 'future', label: 'Tomorrow', kind: 'OBLIGATION', amountPaise: '20000',
      date: '2026-10-24', recurrence: 'NONE' },
  ],
};
const row = (amount, direction='debit') => ({
  date: today, debitPaise: direction === 'debit' ? amount : '0',
  creditPaise: direction === 'credit' ? amount : '0',
  balancePaise: '3500000', description: 'User-imported',
  referenceHash: 'f'.repeat(64),
});
const sources = [{ statementId: id('a'), statement: { records: [
  row('1500000'), row('3000000', 'credit'), row('999999'),
] } }];
const request = {
  ledgerRevision: 1, entryId: 'rent', statementId: id('a'), rowIndex: 0,
  openingCashPaise: '3500000',
  confirmation: 'I_RECONFIRM_HOUSEHOLD_CASH_AFTER_TRANSACTION',
};
test('unique same-day matches are only proposals and do not alter ledger money', () => {
  const suggestions = buildRunwayMatchCandidates(ledger, sources, today);
  assert.equal(suggestions.length, 2);
  assert.deepEqual(suggestions.map(x => x.status), ['UNIQUE_POSSIBLE_MATCH', 'UNIQUE_POSSIBLE_MATCH']);
  assert.equal(ledger.entries.length, 3);
  assert.equal(ledger.openingCashPaise, '5000000');
  assert.equal(suggestions[0].verification, 'USER_IMPORTED_UNVERIFIED');
});
test('confirmation reanchors separately confirmed household cash and excludes exactly one settled item', () => {
  const { nextLedger, match } = prepareRunwaySettlement(ledger, sources, request, today);
  assert.equal(match.entryId, 'rent');
  assert.equal(nextLedger.openingCashPaise, '3500000');
  assert.deepEqual(nextLedger.entries.map(x => x.id), ['salary', 'future']);
  assert.equal(ledger.entries.length, 3);
  assert.equal(ledger.openingCashPaise, '5000000');
});
test('one posted credit settles expected income only with explicit cash reconfirmation', () => {
  const { nextLedger } = prepareRunwaySettlement(ledger, sources, {
    ...request, entryId: 'salary', rowIndex: 1, openingCashPaise: '8000000',
  }, today);
  assert.deepEqual(nextLedger.entries.map(x => x.id), ['rent', 'future']);
});
test('refuses ambiguous duplicate imported transactions and duplicate planned bills', () => {
  const duplicate = [{ ...sources[0], statement: {
    records: [sources[0].statement.records[0], sources[0].statement.records[0]],
  } }];
  assert.equal(buildRunwayMatchCandidates(ledger, duplicate, today)[0].status,
    'AMBIGUOUS_REQUIRES_MANUAL_EDIT');
  assert.throws(() => prepareRunwaySettlement(ledger, duplicate, request, today),
    e => e.code === 'RUNWAY_RECONCILIATION_AMBIGUOUS');
  const twoBills = { ...ledger, entries: [...ledger.entries,
    { ...ledger.entries[0], id: 'rent2' }] };
  assert.throws(() => prepareRunwaySettlement(twoBills, sources, request, today),
    e => e.code === 'RUNWAY_RECONCILIATION_AMBIGUOUS');
  const twoImports = [{ ...sources[0] }, {
    statementId: id('b'), statement: { records: [sources[0].statement.records[0]] },
  }];
  assert.throws(() => prepareRunwaySettlement(ledger, twoImports, request, today),
    e => e.code === 'RUNWAY_RECONCILIATION_AMBIGUOUS');
});
test('rejects future entries, old cash, nonmatching amounts, monthly entries and wrong directions', () => {
  for (const changes of [
    { ...request, entryId: 'future' },
    { ...request, rowIndex: 2 },
    { ...request, entryId: 'salary', rowIndex: 0 },
    { ...request, openingCashPaise: '-1' },
    { ...request, confirmation: 'YES' },
    { ...request, ledgerRevision: 0 },
    { ...request, rowIndex: 500 },
    { ...request, arbitraryField: true },
  ]) assert.throws(() => prepareRunwaySettlement(ledger, sources, changes, today));
  assert.throws(() => prepareRunwaySettlement(ledger, sources, request, '2026-10-24'));
  const monthly = { ...ledger, entries: [{
    ...ledger.entries[0], recurrence: 'MONTHLY', untilDate: today, monthEndRule: 'CLAMP',
  }] };
  assert.equal(buildRunwayMatchCandidates(monthly, sources, today).length, 0);
});
