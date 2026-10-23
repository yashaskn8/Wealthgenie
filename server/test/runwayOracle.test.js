import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateRunway, RunwayInputError } from '../services/runwayEngine.js';

// Independent arithmetic oracle: Date.UTC + day-bucket sums, with NO use of
// the engine's civil-date, recurrence expansion or track implementation.
const seedDate = '2026-06-01';
const day = n => new Date(Date.UTC(2026, 5, 1 + n)).toISOString().slice(0, 10);
function oracle(entries, opening, includeExpected, omittedIncome = new Set(), extra = null) {
  const rows = new Map();
  for (const e of entries) {
    if (e.kind === 'EXPECTED_INCOME' && omittedIncome.has(e.id)) continue;
    const existing = rows.get(e.date) || { payments: [], income: 0n };
    if (e.kind === 'OBLIGATION') existing.payments.push(e);
    else if (includeExpected) existing.income += BigInt(e.amountPaise);
    rows.set(e.date, existing);
  }
  if (extra) {
    const existing = rows.get(extra.date) || { payments: [], income: 0n };
    existing.payments.push(extra);
    rows.set(extra.date, existing);
  }
  let balance = BigInt(opening);
  let low = balance, firstPossible = null, firstCertain = null;
  for (const [date, bucket] of [...rows.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const paid = bucket.payments.reduce((sum, e) => sum + BigInt(e.amountPaise), 0n);
    const debitFirst = balance - paid;
    const incomeFirst = balance + bucket.income - paid;
    if (paid > 0n && debitFirst < 0n && !firstPossible) firstPossible = { date, deficitPaise: String(-debitFirst) };
    if (paid > 0n && incomeFirst < 0n && !firstCertain) firstCertain = { date, deficitPaise: String(-incomeFirst) };
    if (debitFirst < low) low = debitFirst;
    balance = debitFirst + bucket.income;
  }
  return { endBalancePaise: String(balance), lowestDebitFirstBalancePaise: String(low),
    firstPossibleShortfall: firstPossible, firstCertainShortfall: firstCertain,
    status: firstCertain ? 'LISTED_SHORTFALL' : firstPossible ? 'SAME_DAY_TIMING_UNKNOWN' : 'NO_LISTED_SHORTFALL' };
}
let state = 0x9e3779b9;
function random(max) { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state % max; }
const ledger = entries => ({ asOfDate: seedDate, confirmationDate: seedDate, openingCashPaise: '150000', entries });
function compare(actual, expected) {
  for (const key of ['endBalancePaise', 'lowestDebitFirstBalancePaise', 'status']) assert.equal(actual[key], expected[key], key);
  for (const field of ['firstPossibleShortfall', 'firstCertainShortfall']) {
    assert.equal(actual[field]?.date || null, expected[field]?.date || null, field + ' date');
    assert.equal(actual[field]?.deficitPaise || null, expected[field]?.deficitPaise || null, field + ' deficit');
  }
}
test('independent oracle: 250 seeded schedules, receipt and shock variants, same-day collisions', () => {
  for (let iteration = 0; iteration < 250; iteration++) {
    const entries = Array.from({ length: 4 + random(21) }, (_, i) => ({
      id: 'item_' + i, label: 'Event ' + i,
      kind: random(3) ? 'OBLIGATION' : 'EXPECTED_INCOME',
      amountPaise: String(1 + random(80000)), date: day(random(28)), recurrence: 'NONE',
    }));
    const income = entries.find(e => e.kind === 'EXPECTED_INCOME');
    const omitted = income ? new Set([income.id]) : new Set();
    const extra = { id: 'extra_oracle', label: 'One extra expense', kind: 'OBLIGATION', amountPaise: '39999', date: day(random(28)), recurrence: 'NONE' };
    const scenarios = [
      { id: 'expense', type: 'EXTRA_EXPENSE', label: extra.label, amountPaise: extra.amountPaise, date: extra.date },
      ...(income ? [{ id: 'missing_receipt', type: 'SKIP_RECEIPTS', receiptIds: [income.id], fromDate: seedDate, throughDate: day(29) }] : []),
    ];
    const simulated = simulateRunway(ledger(entries), { ledgerRevision: 1, horizonDays: 30, scenarios });
    compare(simulated.scenarios[0].cashAlreadyAvailable, oracle(entries, '150000', false));
    compare(simulated.scenarios[0].ifExpectedIncomeArrives, oracle(entries, '150000', true));
    compare(simulated.scenarios[1].cashAlreadyAvailable, oracle(entries, '150000', false, new Set(), extra));
    compare(simulated.scenarios[1].ifExpectedIncomeArrives, oracle(entries, '150000', true, new Set(), extra));
    if (income) {
      compare(simulated.scenarios[2].ifExpectedIncomeArrives, oracle(entries, '150000', true, omitted));
      compare(simulated.scenarios[2].cashAlreadyAvailable, oracle(entries, '150000', false, omitted));
    }
  }
});
test('grouped same-day shortfall does not blame arbitrary payment ordering', () => {
  const l = ledger([
    { id: 'a', label: 'First alphabetically', kind: 'OBLIGATION', amountPaise: '95000', date: day(1), recurrence: 'NONE' },
    { id: 'z', label: 'Last alphabetically', kind: 'OBLIGATION', amountPaise: '90000', date: day(1), recurrence: 'NONE' },
  ]);
  const track = simulateRunway(l, { ledgerRevision: 1, horizonDays: 3, scenarios: [] }).scenarios[0].cashAlreadyAvailable;
  assert.equal(track.firstCertainShortfall.deficitPaise, '35000');
  assert.equal(track.firstCertainShortfall.entryId, null);
  assert.deepEqual(track.firstCertainShortfall.obligationIds, ['a', 'z']);
  assert.equal(track.firstCertainShortfall.label, 'Multiple payments due');
});
test('512 event limit remains valid for baseline but a shock cannot expand it to 513', () => {
  const entries = Array.from({ length: 256 }, (_, i) => ({
    id: 'bill_' + i, label: 'Bill ' + i, kind: 'OBLIGATION', amountPaise: '1',
    date: '2026-01-01', recurrence: 'MONTHLY', untilDate: '2026-02-01', monthEndRule: 'CLAMP',
  }));
  const l = { asOfDate: '2026-01-01', confirmationDate: '2026-01-01', openingCashPaise: '1000', entries };
  const base = { ledgerRevision: 1, horizonDays: 33, scenarios: [] };
  assert.equal(simulateRunway(l, base).scenarios[0].eventCount, 512);
  assert.throws(() => simulateRunway(l, { ...base, scenarios: [
    { id: 'surge', type: 'EXTRA_EXPENSE', date: '2026-01-15', amountPaise: '1', label: 'Shock' },
  ] }), RunwayInputError);
});

// An independent UTC calendar oracle catches date-window and recurrence
// boundary regressions without using the engine's own civilDate helper.
test('UTC oracle: a 1-day window excludes tomorrow on all month boundaries', () => {
  for (const anchor of ['2026-01-31', '2026-02-28', '2028-02-29', '2026-12-31']) {
    const d = new Date(anchor + 'T00:00:00Z');
    const next = new Date(d.getTime() + 86400000).toISOString().slice(0, 10);
    const l = { asOfDate: anchor, confirmationDate: anchor, openingCashPaise: '1000', entries: [
      { id: 'today', label: 'Day one bill', kind: 'OBLIGATION',
        amountPaise: '100', date: anchor, recurrence: 'NONE' },
      { id: 'tomorrow', label: 'Day two bill', kind: 'OBLIGATION',
        amountPaise: '200', date: next, recurrence: 'NONE' },
    ] };
    for (const [days, expectedBalance, expectedEvents] of [[1, '900', 1], [2, '700', 2]]) {
      const result = simulateRunway(l, { ledgerRevision: 1, horizonDays: days, scenarios: [] }).scenarios[0];
      assert.equal(result.eventCount, expectedEvents, anchor + '/' + days);
      assert.equal(result.cashAlreadyAvailable.endBalancePaise, expectedBalance, anchor + '/' + days);
    }
  }
});
