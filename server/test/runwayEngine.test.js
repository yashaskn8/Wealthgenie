import test from 'node:test';
import assert from 'node:assert/strict';
import { civilDate, paise, simulateRunway, validateLedger } from '../services/runwayEngine.js';

const base = () => ({
  asOfDate: '2026-01-31', confirmationDate: '2026-01-31', openingCashPaise: '10000',
  entries: [
    { id: 'emi', label: 'EMI', kind: 'OBLIGATION', amountPaise: '11000', date: '2026-02-28', recurrence: 'NONE' },
    { id: 'salary', label: 'Salary', kind: 'EXPECTED_INCOME', amountPaise: '20000', date: '2026-02-28', recurrence: 'NONE' },
  ],
});
const run = (l = base(), scenarios = [], horizonDays = 60) =>
  simulateRunway(l, { ledgerRevision: 1, horizonDays, scenarios });

test('same-day income cannot be claimed as settled; results give conservative bounds', () => {
  const r = run().scenarios[0];
  assert.equal(r.cashAlreadyAvailable.status, 'LISTED_SHORTFALL');
  assert.equal(r.cashAlreadyAvailable.firstCertainShortfall.date, '2026-02-28');
  assert.equal(r.ifExpectedIncomeArrives.status, 'SAME_DAY_TIMING_UNKNOWN');
  assert.equal(r.ifExpectedIncomeArrives.timingAmbiguities[0].code, 'SAME_DAY_TIMING_UNKNOWN');
  assert.equal(r.ifExpectedIncomeArrives.endBalancePaise, '19000');
});

test('skipping expected salary does not remove confirmed opening cash', () => {
  const shock = { id: 'no_salary', type: 'SKIP_RECEIPTS', receiptIds: ['salary'], fromDate: '2026-02-01', throughDate: '2026-03-15' };
  const r = run(base(), [shock]).scenarios[1];
  assert.equal(r.ifExpectedIncomeArrives.endBalancePaise, '-1000');
  assert.equal(r.cashAlreadyAvailable.endBalancePaise, '-1000');
});

test('extra expense is applied only in its scenario and cannot alter baseline', () => {
  const shock = { id: 'medical', type: 'EXTRA_EXPENSE', amountPaise: '4000', date: '2026-02-05', label: 'Medical' };
  const result = run(base(), [shock]).scenarios;
  assert.equal(result[0].ifExpectedIncomeArrives.endBalancePaise, '19000');
  assert.equal(result[1].ifExpectedIncomeArrives.endBalancePaise, '15000');
});

test('monthly 31st recurrence requires explicit clamp/skip and respects leap years', () => {
  const l = base();
  l.entries = [{
    id: 'rent', label: 'Rent', kind: 'OBLIGATION', amountPaise: '100', date: '2026-01-31',
    recurrence: 'MONTHLY', monthEndRule: 'CLAMP', untilDate: '2026-03-31',
  }];
  assert.equal(run(l, [], 90).scenarios[0].eventCount, 3);
  l.entries[0].monthEndRule = 'SKIP';
  assert.equal(run(l, [], 90).scenarios[0].eventCount, 2);
  assert.throws(() => civilDate('2026-02-29'));
  assert.doesNotThrow(() => civilDate('2028-02-29'));
});

test('rejects unsafe money, omitted facts, duplicates, or invented fields', () => {
  for (const bad of [0, null, '', '01', '1.0', '1e3', '-1', '1000000000000001', 'NaN']) {
    assert.throws(() => paise(bad));
  }
  const l = base();
  l.openingCashPaise = null;
  assert.throws(() => run(l));
  l.openingCashPaise = '10000';
  l.entries[0].amountPaise = '';
  assert.throws(() => run(l));
  l.entries[0].amountPaise = '11000';
  l.entries.push({ ...l.entries[0] });
  assert.throws(() => validateLedger(l));
  l.entries.pop();
  l.entries[0].unknownExtra = 'do not trust';
  assert.throws(() => validateLedger(l));
});

test('rejects scenario input with silent income assumptions', () => {
  assert.throws(() => run(base(), [{ id: 'x', type: 'EXTRA_EXPENSE', date: '2026-02-01', label: 'Hospital' }]));
  assert.throws(() => run(base(), [{ id: 'x', type: 'SKIP_RECEIPTS', receiptIds: ['emi'], fromDate: '2026-02-01', throughDate: '2026-02-02' }]));
  assert.throws(() => run(base(), [], 396));
});

test('timezone independence of civil arithmetic at 2026 and 2028 year boundaries', () => {
  assert.equal(civilDate('2026-03-01').ordinal - civilDate('2026-02-28').ordinal, 1);
  assert.equal(civilDate('2028-03-01').ordinal - civilDate('2028-02-29').ordinal, 1);
  assert.equal(civilDate('2027-01-01').ordinal - civilDate('2026-12-31').ordinal, 1);
});

test('no declared receipts means both tracks are identical', () => {
  const l = base();
  l.entries = l.entries.filter(e => e.kind === 'OBLIGATION');
  const r = run(l).scenarios[0];
  assert.deepEqual(r.cashAlreadyAvailable, r.ifExpectedIncomeArrives);
});
