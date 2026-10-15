import test from 'node:test';
import assert from 'node:assert/strict';
import { _validateMonteCarlo } from '../routes/goals.js';

function validResult() {
  return {
    goal_probability: 0.75,
    simulations_run: 1000,
    years_array: [1, 2, 3],
    p10: [90, 190, 290],
    p25: [95, 195, 295],
    p50: [100, 200, 300],
    p75: [105, 205, 305],
    p90: [110, 210, 310],
  };
}

test('goal Monte Carlo validation accepts aligned ordered percentile bands', () => {
  assert.equal(_validateMonteCarlo(validResult()), 2);
});

test('goal Monte Carlo validation rejects missing probability, bands, or horizon', () => {
  const missingProbability = validResult();
  delete missingProbability.goal_probability;
  assert.throws(() => _validateMonteCarlo(missingProbability), /invalid goal probability/);
  for (const invalidProbability of [-0.01, 1.01, Number.POSITIVE_INFINITY]) {
    const invalid = validResult();
    invalid.goal_probability = invalidProbability;
    assert.throws(() => _validateMonteCarlo(invalid), /invalid goal probability/);
  }

  for (const key of ['p10', 'p25', 'p50', 'p75', 'p90', 'years_array']) {
    const missing = validResult();
    delete missing[key];
    assert.throws(() => _validateMonteCarlo(missing), /invalid percentile bands/);
  }

  const empty = validResult();
  empty.years_array = [];
  for (const key of ['p10', 'p25', 'p50', 'p75', 'p90']) empty[key] = [];
  assert.throws(() => _validateMonteCarlo(empty), /invalid percentile bands/);
});

test('goal Monte Carlo validation rejects unequal lengths, non-finite and negative values', () => {
  const unequal = validResult();
  unequal.p90.pop();
  assert.throws(() => _validateMonteCarlo(unequal), /invalid percentile bands/);
  const mismatchedHorizon = validResult();
  mismatchedHorizon.years_array.push(4);
  assert.throws(() => _validateMonteCarlo(mismatchedHorizon), /invalid percentile bands/);

  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const malformed = validResult();
    malformed.p50[1] = value;
    assert.throws(() => _validateMonteCarlo(malformed), /invalid percentile bands/);
  }

  const invalidYear = validResult();
  invalidYear.years_array[1] = Number.NaN;
  assert.throws(() => _validateMonteCarlo(invalidYear), /invalid projection horizon/);
  for (const invalidYearValue of [0, 31]) {
    const outOfRangeYear = validResult();
    outOfRangeYear.years_array[1] = invalidYearValue;
    assert.throws(() => _validateMonteCarlo(outOfRangeYear), /invalid projection horizon/);
  }
});

test('goal Monte Carlo validation rejects percentile crossings and invalid simulation counts', () => {
  const crossingAtTerminalYear = validResult();
  crossingAtTerminalYear.p25[2] = crossingAtTerminalYear.p50[2] + 1;
  assert.throws(() => _validateMonteCarlo(crossingAtTerminalYear), /invalid percentile bands/);

  const crossingBeforeTerminalYear = validResult();
  crossingBeforeTerminalYear.p10[0] = crossingBeforeTerminalYear.p25[0] + 1;
  assert.throws(() => _validateMonteCarlo(crossingBeforeTerminalYear), /invalid percentile bands/);

  for (const simulationsRun of [0, -1, 1.5, Number.NaN]) {
    const malformed = validResult();
    malformed.simulations_run = simulationsRun;
    assert.throws(() => _validateMonteCarlo(malformed), /invalid percentile bands/);
  }

  const duplicateYear = validResult();
  duplicateYear.years_array[1] = duplicateYear.years_array[0];
  assert.throws(() => _validateMonteCarlo(duplicateYear), /invalid projection horizon/);
});
