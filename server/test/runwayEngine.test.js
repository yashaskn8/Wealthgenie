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

test('recurrences never inspect months beyond a valid declared end date at the 2100 boundary', () => {
  const ledger = {
    asOfDate: '2100-11-30', confirmationDate: '2100-11-30',
    openingCashPaise: '1000', entries: [{
      id: 'bill', label: 'Final-year monthly obligation', kind: 'OBLIGATION',
      amountPaise: '100', date: '2100-11-30', recurrence: 'MONTHLY',
      untilDate: '2100-12-31', monthEndRule: 'CLAMP',
    }],
  };
  const result = simulateRunway(ledger, {
    ledgerRevision: 1, horizonDays: 90, scenarios: [],
  });
  assert.equal(result.engineVersion, 'runway-cashflow-1.2.1');
  assert.equal(result.scenarios[0].eventCount, 2);
  assert.equal(result.scenarios[0].cashAlreadyAvailable.endBalancePaise, '800');
});

test('monthly recurrence does not add an event beyond its end month', () => {
  const ledger = {
    asOfDate: '2028-01-31', confirmationDate: '2028-01-31',
    openingCashPaise: '1000', entries: [{
      id: 'bill', label: 'January-only bill', kind: 'OBLIGATION',
      amountPaise: '100', date: '2028-01-31', recurrence: 'MONTHLY',
      untilDate: '2028-01-31', monthEndRule: 'CLAMP',
    }],
  };
  const r = simulateRunway(ledger, { ledgerRevision: 1, horizonDays: 90, scenarios: [] });
  assert.equal(r.scenarios[0].eventCount, 1);
  assert.equal(r.scenarios[0].cashAlreadyAvailable.endBalancePaise, '900');
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


test('rejects invalid revision numbers, protecting snapshot provenance', () => {
  for (const revision of [undefined, 0, -1, '1', 1.5, 2049, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => simulateRunway(base(), { ledgerRevision: revision, horizonDays: 30, scenarios: [] }));
  }
});


test('never issues a reassuring READY result when all payments fall beyond the chosen horizon', () => {
  const ledger = base();
  ledger.entries = [
    { id: 'late_bill', label: 'Later bill', kind: 'OBLIGATION', amountPaise: '19000',
      date: '2026-03-15', recurrence: 'NONE' },
    { id: 'salary', label: 'Income', kind: 'EXPECTED_INCOME', amountPaise: '30000',
      date: '2026-02-01', recurrence: 'NONE' },
  ];
  const tooShort = run(ledger, [], 20);
  assert.equal(tooShort.status, 'INSUFFICIENT_INPUT');
  assert.deepEqual(tooShort.scenarios, []);
  assert.ok(tooShort.unknowns.includes('NO_LISTED_OBLIGATIONS_IN_HORIZON'));
  const coveringTheBill = run(ledger, [], 45);
  assert.equal(coveringTheBill.status, 'READY');
  assert.equal(coveringTheBill.scenarios[0].cashAlreadyAvailable.status, 'LISTED_SHORTFALL');
});


test('income loss must actually remove a scheduled receipt within the selected horizon', () => {
  const l = base();
  const noEffect = {
    id: 'lost_salary', type: 'SKIP_RECEIPTS', receiptIds: ['salary'],
    fromDate: '2026-01-31', throughDate: '2026-02-02',
  };
  assert.throws(() => run(l, [noEffect]), /no matching receipt/);
  const effective = { ...noEffect, throughDate: '2026-03-01' };
  const compared = run(l, [effective]).scenarios;
  assert.equal(compared.length, 2);
  assert.equal(compared[1].ifExpectedIncomeArrives.endBalancePaise, '-1000');
});

test('red-team: horizon days are inclusive calendar day counts, never date offsets', () => {
  const l = {
    asOfDate: '2026-01-31', confirmationDate: '2026-01-31', openingCashPaise: '1000',
    entries: [
      { id: 'today_bill', label: 'Today', kind: 'OBLIGATION', amountPaise: '100',
        date: '2026-01-31', recurrence: 'NONE' },
      { id: 'tomorrow_bill', label: 'Tomorrow', kind: 'OBLIGATION', amountPaise: '200',
        date: '2026-02-01', recurrence: 'NONE' },
    ],
  };
  const one = simulateRunway(l, { ledgerRevision: 1, horizonDays: 1, scenarios: [] });
  assert.equal(one.scenarios[0].eventCount, 1);
  assert.equal(one.scenarios[0].cashAlreadyAvailable.endBalancePaise, '900');
  const two = simulateRunway(l, { ledgerRevision: 1, horizonDays: 2, scenarios: [] });
  assert.equal(two.scenarios[0].eventCount, 2);
  assert.equal(two.scenarios[0].cashAlreadyAvailable.endBalancePaise, '700');
  assert.throws(() => simulateRunway(l, { ledgerRevision: 1, horizonDays: 1,
    scenarios: [{ id: 'tomorrow', type: 'EXTRA_EXPENSE',
      date: '2026-02-01', amountPaise: '20', label: 'Tomorrow' }],
  }), /outside the horizon/);
  const oldEnd = { ...l, entries: [{ ...l.entries[0], date: '2027-03-02' }] };
  assert.throws(() => validateLedger(oldEnd), /outside the confirmed horizon/);
});
