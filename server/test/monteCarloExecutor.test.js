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
test('invalid worker timeout fails closed before starting simulation', async () => {
  await assert.rejects(executeMonteCarlo(params, { timeoutMs: Infinity }),
    error => error.code === 'INVALID_MONTE_CARLO_TIMEOUT' && error.status === 400);
});
