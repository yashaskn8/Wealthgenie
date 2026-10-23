import { parentPort, workerData } from 'node:worker_threads';
import { runMonteCarloWithGoal } from '../services/monteCarloEngine.js';
import { runTaxAwareEquityLumpSumScenario } from '../services/taxAwareMonteCarlo.js';

if (!parentPort) throw new Error('Monte Carlo worker must run inside a worker thread');
try {
  const result = workerData?.scenarioMode === 'USER_DECLARED_EQUITY_LUMP_SUM'
    ? runTaxAwareEquityLumpSumScenario(workerData)
    : runMonteCarloWithGoal(workerData);
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  // Allow only a pre-approved, privacy-safe numeric abstention code to cross
  // the worker boundary. Never forward stack traces or investor inputs.
  const code=error instanceof RangeError
    && String(error.message).includes('SIMULATION_WEALTH_PRECISION_EXCEEDED')
    ? 'SIMULATION_WEALTH_PRECISION_EXCEEDED'
    : 'MONTE_CARLO_SIMULATION_FAILED';
  parentPort.postMessage({ ok: false, code });
}
