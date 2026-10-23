import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunwayObservedAccounts } from '../services/runwayAccountObservations.js';

const row = (id, label, date, amount, at) => ({
  _id: id.repeat(64), importedAt: new Date(at),
  statement: { accountLabel: label, periodEnd: date, closingBalancePaise: amount },
});
test('never sums balances or claims verified bank account identity', () => {
  const x = buildRunwayObservedAccounts([
    row('a', 'Salary', '2026-10-23', '5000000', '2026-10-23T01:00:00Z'),
    row('b', 'Savings', '2026-10-22', '7000000', '2026-10-23T02:00:00Z'),
  ], '2026-10-23');
  assert.equal(x.householdTotalPaise, null);
  assert.equal(x.independentlyVerified, false);
  assert.equal(x.items[0].closingBalancePaise, '5000000');
  assert.equal(x.items[0].freshness, 'OBSERVED_TODAY_UNVERIFIED');
  assert.equal(x.items[1].freshness, 'HISTORICAL_OBSERVATION');
  assert.equal(x.items.length, 2);
});
test('same user nickname is flagged as ambiguous account provenance, not merged', () => {
  const x = buildRunwayObservedAccounts([
    row('a', 'SALARY', '2026-10-20', '100', '2026-10-22T01:00:00Z'),
    row('b', 'salary', '2026-10-21', '200', '2026-10-22T02:00:00Z'),
  ], '2026-10-23');
  assert.deepEqual(x.potentiallyOverlappingNicknames, ['salary']);
  assert.equal(x.items.length, 2);
  assert.equal(x.householdTotalPaise, null);
  assert.equal(x.items[0].closingBalancePaise, '200');
});
test('limits evidence to defensible per-user source count', () => {
  assert.throws(() => buildRunwayObservedAccounts(Array(31).fill(null), '2026-10-23'));
});
