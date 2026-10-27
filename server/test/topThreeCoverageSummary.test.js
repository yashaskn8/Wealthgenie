import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeTopThreeCoverage } from '../scripts/topThreeCoverageSummary.js';

test('two qualified candidates satisfy the minimum while Top 3 remains a maximum', () => {
  const summary = summarizeTopThreeCoverage([
    { id: 'empty', name: 'Empty', category: 'Debt', potentially_qualified: '0' },
    { id: 'one', name: 'One', category: 'Debt', potentially_qualified: '1' },
    { id: 'two', name: 'Two', category: 'Debt', potentially_qualified: '2' },
    { id: 'three', name: 'Three', category: 'Debt', potentially_qualified: '3' },
    { id: 'many', name: 'Many', category: 'Debt', potentially_qualified: '5' },
  ], '2026-10-27T00:00:00.000Z');
  assert.equal(summary.families, 5);
  assert.equal(summary.minimumUsefulProducts, 2);
  assert.equal(summary.maximumDisplayedProducts, 3);
  assert.equal(summary.familiesWithTwoOrMorePotentialProducts, 3);
  assert.equal(summary.familiesWithThreePotentialProducts, 2);
  assert.equal(summary.familiesWithFewerThanTwo, 2);
  assert.equal(summary.remainingMinimumSlots, 3);
  assert.equal(summary.remainingTopThreeSlots, 6);
  assert.deepEqual(summary.missingOrUnderfilledFamilies.map(item => item.familyId), ['empty', 'one']);
  assert.equal(summary.qualifiedForAnySpecificInvestor, 'NOT_ASSESSED');
});

test('missing or malformed qualification counts cannot be treated as coverage', () => {
  for (const value of [undefined, null, '', -1, 1.5, 'NaN', 'Infinity']) {
    assert.throws(() => summarizeTopThreeCoverage([
      { id: 'bad', name: 'Bad', category: 'Debt', potentially_qualified: value },
    ]), /nonnegative integer/);
  }
});

test('an empty 250-family product catalog reports 500 minimum slots without fictional coverage', () => {
  const rows = Array.from({ length: 250 }, (_, index) => ({
    id: `family-${index + 1}`,
    name: `Family ${index + 1}`,
    category: 'Discovery',
    potentially_qualified: '0',
  }));
  const summary = summarizeTopThreeCoverage(rows);
  assert.equal(summary.familiesWithTwoOrMorePotentialProducts, 0);
  assert.equal(summary.familiesWithThreePotentialProducts, 0);
  assert.equal(summary.remainingMinimumSlots, 500);
  assert.equal(summary.remainingTopThreeSlots, 750);
  assert.equal(summary.missingOrUnderfilledFamilies.length, 250);
});
