import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateCoverage, validateCoverageLedger, previewVoluntaryExclusions,
  dayAt, CoverageInputError,
} from '../services/coverageEngine.js';

const base = (overrides = {}) => ({
  asOfDate: '2028-01-30',
  openingCashPaise: 5000,
  cashSource: 'USER_DECLARED_BANK_CASH',
  completenessConfirmed: true,
  entries: [],
  ...overrides,
});
const entry = (type, amountPaise, startDate, recurrence = 'ONCE', id = 'b1') => ({
  id, type, label: 'User entered payment', amountPaise, startDate, recurrence,
});

test('outflows precede same-day expected inflows and reveal intraday deficit', () => {
  const r = calculateCoverage(base({ entries: [
    entry('ESSENTIAL_PAYMENT', 6000, '2028-01-30'),
    entry('EXPECTED_INCOME', 10000, '2028-01-30', 'ONCE', 'i1'),
  ] }));
  assert.equal(r.status, 'SHORTFALL_IN_ENTERED_PLAN');
  assert.equal(r.baseline.earliestShortfall.date, '2028-01-30');
  assert.equal(r.baseline.minWithinDayPaise, -1000);
  assert.equal(r.baseline.daily[0].closingBalancePaise, 9000);
  assert.equal(r.noExpectedIncome.daily[0].closingBalancePaise, -1000);
});
test('monthly 31st anchor clamps independently, including leap-year February', () => {
  const r = calculateCoverage(base({
    openingCashPaise: 300000,
    entries: [entry('CONTRACTUAL_PAYMENT', 100, '2028-01-31', 'MONTHLY')],
  }));
  const debits = r.baseline.daily.filter((d, i, days) =>
    i > 0 && d.closingBalancePaise !== days[i - 1].closingBalancePaise);
  assert.deepEqual(debits.map(d => d.date), ['2028-01-31', '2028-02-29', '2028-03-31']);
});
test('weekly cycles and exact money boundary', () => {
  const r = calculateCoverage(base({
    openingCashPaise: 100,
    entries: [entry('OTHER_PAYMENT', 100, '2028-01-30', 'WEEKLY')],
  }));
  assert.equal(r.baseline.daily[0].closingBalancePaise, 0);
  assert.equal(r.baseline.earliestShortfall.date, '2028-02-06');
});
test('missing opening cash is not silently treated as zero', () => {
  const r = calculateCoverage(base({ openingCashPaise: null }));
  assert.equal(r.status, 'CANNOT_CALCULATE');
  assert.deepEqual(r.missingInputCodes, ['OPENING_CASH_UNKNOWN']);
});
test('unconfirmed completeness is not an affordability assurance', () => {
  assert.equal(calculateCoverage(base({ completenessConfirmed: false })).status, 'CANNOT_CALCULATE');
});
test('expected income has an independent absent-income stress case', () => {
  const r = calculateCoverage(base({
    openingCashPaise: 100,
    entries: [
      entry('EXPECTED_INCOME', 2000, '2028-01-30', 'ONCE', 'salary'),
      entry('CONTRACTUAL_PAYMENT', 1500, '2028-01-31', 'ONCE', 'emi'),
    ],
  }));
  assert.equal(r.baseline.status, 'NO_SHORTFALL_IN_ENTERED_PLAN');
  assert.equal(r.noExpectedIncome.status, 'SHORTFALL_IN_ENTERED_PLAN');
});
test('only user-confirmed voluntary payments may be hypothetically excluded', () => {
  const b = base({ entries: [
    entry('VOLUNTARY_CONTRIBUTION', 5000, '2028-01-30'),
    entry('CONTRACTUAL_PAYMENT', 5000, '2028-01-30', 'ONCE', 'emi'),
  ] });
  assert.equal(previewVoluntaryExclusions(b, ['b1']).status, 'NO_SHORTFALL_IN_ENTERED_PLAN');
  assert.throws(() => previewVoluntaryExclusions(b, ['emi']), CoverageInputError);
});
test('validation rejects malformed dates, extra keys, duplicate IDs, fractions and overflow', () => {
  for (const obj of [
    base({ asOfDate: '2027-02-29' }), base({ openingCashPaise: 1.2 }),
    base({ openingCashPaise: Number.MAX_SAFE_INTEGER }), base({ injected: true }),
    base({ entries: [entry('OTHER_PAYMENT', 1, '2028-01-30'), entry('OTHER_PAYMENT', 1, '2028-01-31')] }),
    base({ entries: [entry('OTHER_PAYMENT', 1, '2028-01-30', 'DAILY')] }),
  ]) assert.throws(() => validateCoverageLedger(obj), CoverageInputError);
});
test('date iteration never depends on local timezone', () => {
  assert.equal(dayAt(30, '2028-01-30'), '2028-02-29');
  assert.equal(dayAt(60, '2028-01-30'), '2028-03-30');
});
test('scenarios are 90 days and cannot invent savings inflows', () => {
  const r = calculateCoverage(base());
  assert.equal(r.baseline.daily.length, 90);
  assert.equal(r.baseline.closingBalancePaise, 5000);
  assert.equal(r.cashProvenance, 'USER_DECLARED_NOT_BANK_VERIFIED');
});

test('recurrence conservation oracle: deterministic entries never invent cash', () => {
  for (let seed = 1; seed <= 250; seed += 1) {
    let state = seed;
    const random = n => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % n;
    };
    const anchor = new Date(Date.UTC(2027, 0, 1 + random(180))).toISOString().slice(0, 10);
    const opening = random(100000);
    const entries = Array.from({ length: random(12) }, (_, i) => ({
      id: 'payment_' + i, label: 'Cash entry',
      type: ['EXPECTED_INCOME', 'ESSENTIAL_PAYMENT', 'CONTRACTUAL_PAYMENT',
        'VOLUNTARY_CONTRIBUTION', 'OTHER_PAYMENT'][random(5)],
      amountPaise: 1 + random(20000),
      startDate: new Date(Date.UTC(2027, 0, 1 + random(270))).toISOString().slice(0, 10),
      recurrence: ['ONCE', 'WEEKLY', 'MONTHLY'][random(3)],
    }));
    const result = calculateCoverage(base({ asOfDate: anchor, openingCashPaise: opening, entries }));
    let prior = opening;
    for (const day of result.baseline.daily) {
      const ordinal = Date.parse(day.date + 'T00:00:00Z');
      const matching = entries.filter(item => {
        const start = Date.parse(item.startDate + 'T00:00:00Z');
        if (ordinal < start) return false;
        if (item.recurrence === 'ONCE') return ordinal === start;
        if (item.recurrence === 'WEEKLY') return (ordinal - start) % (7 * 86400000) === 0;
        const d = new Date(ordinal);
        const year = d.getUTCFullYear();
        const month = d.getUTCMonth();
        const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
        const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        return d.getUTCDate() === Math.min(Number(item.startDate.slice(8, 10)), lengths[month]);
      });
      const outgoing = matching.filter(x => x.type !== 'EXPECTED_INCOME')
        .reduce((sum, x) => sum + x.amountPaise, 0);
      const incoming = matching.filter(x => x.type === 'EXPECTED_INCOME')
        .reduce((sum, x) => sum + x.amountPaise, 0);
      assert.equal(day.lowestBalancePaise, prior - outgoing);
      assert.equal(day.closingBalancePaise, prior - outgoing + incoming);
      prior = day.closingBalancePaise;
    }
    assert.equal(result.baseline.closingBalancePaise, prior);
    assert.ok(result.noExpectedIncome.closingBalancePaise <= prior);
  }
});
