import test from 'node:test';
import assert from 'node:assert/strict';
import { executeMonteCarlo, getMonteCarloExecutorStatus, MAX_MONTE_CARLO_ACTIVE_JOBS } from '../services/monteCarloExecutor.js';
import { runMonteCarloWithGoal } from '../services/monteCarloEngine.js';

const params = {
  monthlyInvestment: 2400, currentSavings: 10000,
  annualExpectedReturn: 0.09, annualVolatility: 0.20, years: 2,
  simulations: 100, inflationRate: 0.05, targetAmount: 100000, seed: 12,
};
test('worker and direct model agree for deterministic inputs and result metadata', async () => {
  const expected = runMonteCarloWithGoal(params);
  const actual = await executeMonteCarlo(params);
  assert.deepEqual(actual.p50, expected.p50);
  assert.deepEqual(actual.p10_real, expected.p10_real);
  assert.equal(actual.goal_probability, expected.goal_probability);
  assert.equal(actual.seed_used, 12);
});
test('pre-aborted requests never start a worker', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    executeMonteCarlo(params, { signal: controller.signal }),
    error => error.code === 'MONTE_CARLO_ABORTED' && error.status === 503,
  );
  assert.equal(getMonteCarloExecutorStatus().maxActiveWorkers, MAX_MONTE_CARLO_ACTIVE_JOBS);
});
test('unsafe stochastic corpus preserves typed precision abstention across worker boundary', async () => {
  await assert.rejects(executeMonteCarlo({
    ...params,
    monthlyInvestment: 10_000_000,
    currentSavings: 10_000_000_000,
    annualExpectedReturn: 1,
    annualVolatility: 0,
    years: 30,
    simulations: 100,
  }), error => error.code === 'SIMULATION_WEALTH_PRECISION_EXCEEDED'
    && error.status === 422
    && !/principal|profile|user|token/i.test(error.message),
  );
  // The bounded worker pool must reclaim its capacity even for abstentions.
  const ok = await executeMonteCarlo(params);
  assert.ok(Number.isFinite(ok.p50.at(-1)));
});

test('invalid worker timeout fails closed before starting simulation', async () => {
  await assert.rejects(executeMonteCarlo(params, { timeoutMs: Infinity }),
    error => error.code === 'INVALID_MONTE_CARLO_TIMEOUT' && error.status === 400);
});
