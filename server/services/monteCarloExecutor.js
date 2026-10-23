import { Worker } from 'node:worker_threads';

export const MAX_MONTE_CARLO_ACTIVE_JOBS = 2;
export const MONTE_CARLO_WORKER_TIMEOUT_MS = 30000;
let activeWorkers = 0;

function executionError(code, message, status = 503) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

/**
 * Bounded, nonqueued CPU isolation. Jobs hold a slot until the worker really
 * exits (not merely until a timeout fires), preventing slot exhaustion races.
 * Per-process capacity only; multi-replica deployments need ingress limits too.
 */
export function executeMonteCarlo(params, { signal, timeoutMs = MONTE_CARLO_WORKER_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) {
    return Promise.reject(executionError('INVALID_MONTE_CARLO_TIMEOUT',
      'Simulation timeout is outside the permitted range', 400));
  }
  if (signal?.aborted) {
    return Promise.reject(executionError('MONTE_CARLO_ABORTED', 'Simulation request was cancelled'));
  }
  if (activeWorkers >= MAX_MONTE_CARLO_ACTIVE_JOBS) {
    return Promise.reject(executionError('MONTE_CARLO_CAPACITY_EXCEEDED',
      'Simulation capacity is temporarily unavailable; retry later'));
  }
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('../workers/monteCarloSimulationWorker.js', import.meta.url), {
        workerData: params,
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64 },
      });
    } catch {
      reject(executionError('MONTE_CARLO_WORKER_UNAVAILABLE', 'Simulation worker unavailable'));
      return;
    }
    activeWorkers += 1;
    let settled = false;
    let timeout = null;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => {
      void worker.terminate();
      settle(executionError('MONTE_CARLO_ABORTED', 'Simulation request was cancelled'));
    };
    worker.once('message', message => {
      if (message?.ok === true && message.result && typeof message.result === 'object') {
        settle(null, message.result);
      } else {
        if (message?.code === 'SIMULATION_WEALTH_PRECISION_EXCEEDED') {
          settle(executionError('SIMULATION_WEALTH_PRECISION_EXCEEDED',
            'Simulated wealth exceeded safe monetary precision', 422));
        } else {
          settle(executionError('MONTE_CARLO_SIMULATION_FAILED', 'Simulation failed safely'));
        }
      }
      // Workers should exit naturally; termination guarantees prompt slot
      // reclamation if future dependencies keep an event loop handle open.
      void worker.terminate();
    });
    worker.once('error', () => {
      void worker.terminate();
      settle(executionError('MONTE_CARLO_WORKER_FAILED', 'Simulation worker failed safely'));
    });
    worker.once('exit', () => {
      activeWorkers -= 1;
      if (activeWorkers < 0) activeWorkers = 0;
      if (!settled) settle(executionError('MONTE_CARLO_WORKER_EXIT',
        'Simulation worker exited before completing', 503));
    });
    timeout = setTimeout(() => {
      void worker.terminate();
      settle(executionError('MONTE_CARLO_TIMEOUT', 'Simulation exceeded the server computation deadline'));
    }, timeoutMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

export function getMonteCarloExecutorStatus() {
  return { activeWorkers, maxActiveWorkers: MAX_MONTE_CARLO_ACTIVE_JOBS };
}
