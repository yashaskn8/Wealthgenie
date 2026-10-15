import AgentRun from '../../models/AgentRun.js';
import AgentRunEvent from '../../models/AgentRunEvent.js';
import ProductionAgentEvaluation from '../../models/ProductionAgentEvaluation.js';
import { PrometheusMetrics } from '../../services/metricsCollector.js';
import logger from '../../utils/logger.js';
import { evaluateProductionAgentRun, persistProductionAgentEvaluation } from './productionEvaluator.js';
import { TERMINAL_PLAN_REVIEW_STATES } from '../planReview/planReviewRuntime.js';

const MAX_EVALUATIONS_PER_RECONCILIATION = 25;
const PRODUCTION_EVALUATION_RECONCILIATION_INTERVAL_MS = 30_000;
let reconciliationInFlight = null;
let periodicReconciliation = null;

/**
 * Rebuilds missing diagnostic evaluations from committed terminal run/event data.
 * Evaluation records are deliberately outside the core run transaction: missing
 * records remain fail-closed for promotion and are retried on the next sweep.
 */
export async function reconcileMissingTerminalEvaluations({
  runModel = AgentRun,
  eventModel = AgentRunEvent,
  evaluationModel = ProductionAgentEvaluation,
  evaluatedAt = new Date(),
  maxEvaluations = MAX_EVALUATIONS_PER_RECONCILIATION,
} = {}) {
  const evaluationCollection = evaluationModel?.collection?.name;
  if (!runModel?.aggregate || !evaluationCollection || !eventModel?.find
      || !evaluationModel?.create || !Number.isSafeInteger(maxEvaluations) || maxEvaluations < 1) {
    return { scanned: 0, persisted: 0, failed: 0 };
  }

  let pendingRuns;
  try {
    pendingRuns = await runModel.aggregate([
      { $match: {
        agentType: 'PLAN_REVIEW',
        status: { $in: TERMINAL_PLAN_REVIEW_STATES },
        completedAt: { $ne: null },
      } },
      { $lookup: {
        from: evaluationCollection,
        let: { runId: '$runId', generation: '$executionGeneration' },
        pipeline: [
          { $match: { $expr: { $and: [
            { $eq: ['$runId', '$$runId'] },
            { $eq: ['$executionGeneration', '$$generation'] },
          ] } } },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
        as: 'evaluationRecords',
      } },
      { $match: { evaluationRecords: { $size: 0 } } },
      { $sort: { completedAt: 1, _id: 1 } },
      { $limit: maxEvaluations },
      { $project: { evaluationRecords: 0 } },
    ]);
  } catch (error) {
    PrometheusMetrics.inc('agent_evaluation_reconciliation_failures_total');
    logger.warn('Production agent evaluation reconciliation scan failed', {
      code: error?.code || 'EVALUATION_RECONCILIATION_SCAN_FAILED',
    });
    return { scanned: 0, persisted: 0, failed: 1 };
  }

  let persisted = 0;
  let failed = 0;
  for (const run of pendingRuns || []) {
    try {
      const eventQuery = eventModel.find({ runId: run.runId, userId: run.userId });
      eventQuery.sort?.({ sequence: 1 });
      const durableEvents = await (eventQuery.lean ? eventQuery.lean() : eventQuery);
      const evaluation = evaluateProductionAgentRun({
        run,
        durableEvents: durableEvents || [],
        // The terminal record preserves only the before-state binding. Never
        // reconstruct an after-state proof from it; absent transaction-bound
        // terminal evidence must remain insufficient for a PASS classification.
        baselineVersion: process.env.WG_PRODUCTION_EVALUATION_BASELINE_VERSION || null,
        evaluatedAt,
      });
      await persistProductionAgentEvaluation(evaluation, { model: evaluationModel });
      persisted += 1;
    } catch (error) {
      failed += 1;
      PrometheusMetrics.inc('agent_evaluation_reconciliation_failures_total');
      logger.warn('Production agent evaluation remains unavailable; terminal run is unaffected', {
        code: error?.code || 'EVALUATION_RECONCILIATION_FAILED',
      });
    }
  }
  return { scanned: (pendingRuns || []).length, persisted, failed };
}

/** Queue a non-blocking reconciliation pass after a terminal core transaction. */
export function scheduleTerminalEvaluationReconciliation(options = {}) {
  if (reconciliationInFlight) return reconciliationInFlight;
  reconciliationInFlight = Promise.resolve()
    .then(() => reconcileMissingTerminalEvaluations(options))
    .catch(error => {
      PrometheusMetrics.inc('agent_evaluation_reconciliation_failures_total');
      logger.warn('Production agent evaluation reconciliation failed', {
        code: error?.code || 'EVALUATION_RECONCILIATION_FAILED',
      });
      return { scanned: 0, persisted: 0, failed: 1 };
    })
    .finally(() => { reconciliationInFlight = null; });
  return reconciliationInFlight;
}

/**
 * Start a bounded recovery sweep for terminal runs whose diagnostic
 * evaluation was not persisted. The sweep is diagnostic only: it cannot
 * change a terminal run or the authoritative financial state.
 */
export function startProductionEvaluationReconciliation({
  timerApi = { setInterval, clearInterval },
  ...options
} = {}) {
  if (typeof timerApi?.setInterval !== 'function' || typeof timerApi?.clearInterval !== 'function') {
    throw new TypeError('Production evaluation reconciliation requires interval timer functions.');
  }
  if (periodicReconciliation) {
    return {
      started: false,
      firstRun: periodicReconciliation.firstRun,
      stop: stopProductionEvaluationReconciliation,
    };
  }

  const active = { timer: null, timerApi, firstRun: null, stopped: false };
  const runSweep = () => {
    if (active.stopped) return undefined;
    return scheduleTerminalEvaluationReconciliation(options);
  };
  const firstRun = runSweep();
  const timer = timerApi.setInterval(runSweep, PRODUCTION_EVALUATION_RECONCILIATION_INTERVAL_MS);
  timer?.unref?.();
  Object.assign(active, { timer, firstRun });
  periodicReconciliation = active;
  return { started: true, firstRun, stop: stopProductionEvaluationReconciliation };
}

export async function stopProductionEvaluationReconciliation() {
  const active = periodicReconciliation;
  if (active) {
    active.stopped = true;
    periodicReconciliation = null;
    active.timerApi.clearInterval(active.timer);
  }
  const inFlight = reconciliationInFlight;
  if (inFlight) await inFlight;
}
