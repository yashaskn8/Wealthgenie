import { parentPort, workerData } from 'node:worker_threads';
import { runMonteCarloWithGoal } from '../services/monteCarloEngine.js';
import { runTaxAwareEquityLumpSumScenario } from '../services/taxAwareMonteCarlo.js';

if (!parentPort) throw new Error('Monte Carlo worker must run inside a worker thread');
try {
  const result = workerData?.scenarioMode === 'USER_DECLARED_EQUITY_LUMP_SUM'
    ? runTaxAwareEquityLumpSumScenario(workerData)
    : runMonteCarloWithGoal(workerData);
  parentPort.postMessage({ ok: true, result });
} catch {
  // No internal stack, profile detail or provider data crosses a worker boundary.
  parentPort.postMessage({ ok: false, code: 'MONTE_CARLO_SIMULATION_FAILED' });
}
