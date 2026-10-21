import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runMonteCarlo,
  runMonteCarloWithGoal,
  reverseSIP,
  sampleLogNormalMonthly,
  computeGoalProbability,
  computeWilsonCI,
  getInstrumentVolatility,
  halton,
  boxMuller,
  percentile,
  buildProjectionHorizon,
  annuityDueFV,
  createMulberry32,
} from '../services/monteCarloEngine.js';

const VALID_MC = Object.freeze({
  monthlyInvestment: 10_000,
  annualExpectedReturn: 0.08,
  annualVolatility: 0.12,
  years: 5,
  simulations: 500,
  inflationRate: 0.05,
  currentSavings: 100_000,
});

test('Monte Carlo produces ordered bands and a bounded goal probability from explicit assumptions', () => {
  const result = runMonteCarloWithGoal({ ...VALID_MC, targetAmount: 800_000 });
  assert.deepEqual(result.years_array, [1, 2, 3, 4, 5]);
  assert.equal(result.simulations_run, 500);
  assert.ok(result.goal_probability >= 0 && result.goal_probability <= 1);
  assert.ok(result.goal_probability_ci.lower >= 0);
  assert.ok(result.goal_probability_ci.upper <= 1);
  for (let i = 0; i < result.p50.length; i += 1) {
    assert.ok(result.p10[i] <= result.p25[i]);
    assert.ok(result.p25[i] <= result.p50[i]);
    assert.ok(result.p50[i] <= result.p75[i]);
    assert.ok(result.p75[i] <= result.p90[i]);
  }
});

test('Monte Carlo rejects every missing assumption and refuses silent clamping', () => {
  for (const key of Object.keys(VALID_MC)) {
    const invalid = { ...VALID_MC };
    delete invalid[key];
    assert.throws(() => runMonteCarlo(invalid));
  }
  assert.throws(() => runMonteCarlo({ ...VALID_MC, annualVolatility: 0.61 }), /annualVolatility/);
  assert.throws(() => runMonteCarlo({ ...VALID_MC, years: 31 }), /years/);
  assert.throws(() => runMonteCarlo({ ...VALID_MC, monthlyInvestment: 0, currentSavings: 0 }), /greater than zero/);
});

test('deterministic low-volatility simulation remains numerically consistent', () => {
  const result = runMonteCarlo({ ...VALID_MC, years: 1, annualVolatility: 0, simulations: 200 });
  const terminal = result.p50.at(-1);
  assert.ok(Math.abs(terminal - result.deterministic_fv) / result.deterministic_fv < 0.01);
  assert.equal(result.variance_reduction, 'halton_qmc+antithetic');
  assert.equal(result.control_variate_method, 'none');
  assert.equal(result.inflationRateUsed, 0.05);
});

test('goal probability and Wilson interval fail closed on invalid inputs', () => {
  assert.equal(computeGoalProbability([500, 1200, 1500], 1000), 0.6667);
  assert.throws(() => computeGoalProbability([], 1000), /terminalValues/);
  assert.throws(() => computeGoalProbability([500], 0), /targetAmount/);
  const ci = computeWilsonCI(0.5, 100);
  assert.ok(ci.lower < 0.5 && ci.upper > 0.5);
  assert.throws(() => computeWilsonCI(null, 100), /probability/);
  assert.throws(() => computeWilsonCI(0.5, 0), /positive integer/);
});

test('reverse SIP requires explicit target, rate, horizon, and current savings', () => {
  const sip = reverseSIP(1_000_000, 0.10, 10, 100_000);
  assert.ok(Number.isFinite(sip) && sip > 0);
  assert.equal(Math.round(reverseSIP(120_000, 0, 1, 0)), 10_000);
  assert.equal(reverseSIP(100_000, 0.10, 5, 200_000), 0);
  assert.throws(() => reverseSIP(-500, 0.10, 5, 0), /targetAmount/);
  assert.throws(() => reverseSIP(100_000, 0.10, 0, 0), /years/);
  assert.throws(() => reverseSIP(100_000, 0.10, 5), /currentSavings/);
});

test('instrument volatility returns null for unknown instruments and never invents parameters', () => {
  const known = getInstrumentVolatility('Equity_MF');
  assert.ok(known.mean > 0 && known.stdDev > 0);
  assert.equal(getInstrumentVolatility('Unknown_Instrument_XYZ'), null);
  assert.equal(getInstrumentVolatility('Unknown_Instrument_XYZ', 0.12), null);
  assert.throws(() => getInstrumentVolatility('FD', NaN), /overrideMean/);
});

test('percentile and horizon helpers reject empty or invalid data', () => {
  assert.equal(percentile([10, 20], 50), 15);
  assert.throws(() => percentile([], 50), /non-empty/);
  assert.throws(() => percentile([1, NaN], 50), /finite/);
  assert.throws(() => percentile([1, 2], 101), /percentile/);
  assert.deepEqual(buildProjectionHorizon(2.5), {
    years: 2.5,
    totalMonths: 30,
    checkpointMonths: [12, 24, 30],
    yearsArray: [1, 2, 2.5],
  });
  assert.throws(() => buildProjectionHorizon(-1), /years/);
  assert.throws(() => buildProjectionHorizon(31), /years/);
});

test('annuity due and stochastic primitives retain exact formulas', () => {
  assert.equal(annuityDueFV(10_000, 0, 12), 120_000);
  assert.throws(() => annuityDueFV(-100, 0.01, 12), /monthlyInvestment/);
  assert.throws(() => annuityDueFV(1000, 0.01, 0), /totalMonths/);
  const dt = 1 / 12;
  assert.equal(sampleLogNormalMonthly(0.12, 0.15, 0), Math.exp((0.12 - 0.5 * 0.15 ** 2) * dt));
  assert.equal(halton(1, 2), 0.5);
  assert.equal(boxMuller(0.5, 0.5), Math.sqrt(-2 * Math.log(0.5)) * Math.cos(Math.PI));
});

test('Mulberry32 PRNG produces deterministic sequence for a fixed seed', () => {
  const rng1 = createMulberry32(42);
  const rng2 = createMulberry32(42);
  const seq1 = Array.from({ length: 10 }, () => rng1());
  const seq2 = Array.from({ length: 10 }, () => rng2());
  assert.deepEqual(seq1, seq2);
  assert.ok(seq1.every(v => v >= 0 && v < 1));
});

test('Monte Carlo simulation is 100% deterministic when seeded', () => {
  const run1 = runMonteCarlo({ ...VALID_MC, seed: 98765 });
  const run2 = runMonteCarlo({ ...VALID_MC, seed: 98765 });
  assert.deepEqual(run1.p10, run2.p10);
  assert.deepEqual(run1.p50, run2.p50);
  assert.deepEqual(run1.p90, run2.p90);
  assert.deepEqual(run1.p50_real, run2.p50_real);
  assert.equal(run1.is_reproducible, true);
  assert.equal(run1.seed_used, 98765);
});

test('Monte Carlo real purchasing power is deflated along the exact same simulated paths', () => {
  const result = runMonteCarlo({ ...VALID_MC, inflationRate: 0.06, seed: 12345 });
  assert.equal(result.nominal_real_path_aligned, true);
  assert.equal(result.real.nominal_path_aligned, true);
  // Real wealth must be strictly less than nominal wealth at all horizons when inflation > 0
  for (let i = 0; i < result.p50.length; i++) {
    assert.ok(result.p50_real[i] < result.p50[i], `Year ${i+1}: p50_real (${result.p50_real[i]}) should be < p50 (${result.p50[i]})`);
  }
});

