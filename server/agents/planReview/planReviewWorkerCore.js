import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { trace } from '../../config/tracing.js';
import AgentRun from '../../models/AgentRun.js';
import UserIntentMandate from '../../models/UserIntentMandate.js';
import AgentCheckpoint from '../../models/AgentCheckpoint.js';
import AgentGraphCheckpoint from '../../models/AgentGraphCheckpoint.js';
import AgentRunEvent from '../../models/AgentRunEvent.js';
import { scheduleTerminalEvaluationReconciliation } from '../evals/productionEvaluationQueue.js';
import FinancialProfile from '../../models/FinancialProfile.js';
import FinancialProfileState from '../../models/FinancialProfileState.js';
import RecommendationState from '../../models/RecommendationState.js';
import { PrometheusMetrics } from '../../services/metricsCollector.js';
import { runPlanReview } from './planReviewService.js';
import { MongoPlanReviewCheckpointer } from './mongoPlanReviewCheckpointer.js';
import { PLAN_REVIEW_BUDGETS, PLAN_REVIEW_CHECKPOINT_RETENTION_MS, hashPlanReviewSnapshot } from './planReviewRuntime.js';
import { canonicalSha256 } from '../../utils/canonicalJson.js';
import { resolvePlanReviewSnapshot } from './planReviewSnapshot.js';
import { SAFE_PLAN_REVIEW_TOOLS } from './planReviewSchemas.js';
import { reconcileTerminalPlanReviewMandates } from './planReviewApproval.js';
import logger from '../../utils/logger.js';

const NODE_LABELS = Object.freeze({
  load_context: 'Loading your saved plan',
  check_recommendation_freshness: 'Checking recommendation freshness',
  determine_required_checks: 'Selecting safe read-only checks',
  execute_safe_tools: 'Collecting plan evidence',
  validate_evidence: 'Validating evidence',
  synthesize_review: 'Preparing a grounded review',
  validate_agent_output: 'Checking review safety',
  policy_guard: 'Applying safety policy',
  persist_agent_run: 'Saving review result',
});

const tracer = trace.getTracer('wealthgenie-agent-runtime');
let defaultWorker = null;
const MAX_EXPIRED_PLAN_REVIEW_RECOVERY_BATCH_SIZE = 100;

function now() { return new Date(); }

function checkpointState(state) {
  const boundedCounter = (name, value, max) => {
    const count = value === undefined || value === null ? 0 : Number(value);
    if (!Number.isInteger(count) || count < 0 || count > max) {
      const error = new Error(`PlanReview checkpoint ${name} is outside its hard budget.`);
      error.code = 'AGENT_BUDGET_EXCEEDED';
      error.reason = name.toUpperCase();
      throw error;
    }
    return count;
  };
  const tokenUsage = boundedCounter('tokenUsage', state.tokenUsage, PLAN_REVIEW_BUDGETS.maxTotalTokens);
  const payload = {
    schemaVersion: 'plan-review-replay-checkpoint-1.0.0',
    runId: state.runId,
    planReviewSnapshotHash: state.planReviewSnapshotHash,
    sourceBinding: state.sourceBinding,
    counters: {
      stepCount: boundedCounter('stepCount', state.stepCount, PLAN_REVIEW_BUDGETS.maxSteps),
      toolCallCount: boundedCounter('toolCallCount', state.toolCallCount, PLAN_REVIEW_BUDGETS.maxToolCalls),
      modelCallCount: boundedCounter('modelCallCount', state.modelCallCount, PLAN_REVIEW_BUDGETS.maxModelCalls),
      tokenUsage,
      toolCallCounts: Object.fromEntries(Object.entries(state.toolCallCounts || {})
        .filter(([name, count]) => SAFE_PLAN_REVIEW_TOOLS.includes(name) && Number.isInteger(Number(count)) && Number(count) >= 0)
        .slice(0, SAFE_PLAN_REVIEW_TOOLS.length)
        .map(([name, count]) => {
          const bounded = boundedCounter(`toolCallCounts.${name}`, count, PLAN_REVIEW_BUDGETS.maxToolCallsPerTool);
          return [name, bounded];
        })),
    },
  };
  return { ...payload, checkpointHash: canonicalSha256(payload) };
}

export function reconcilePlanReviewReplayCheckpoint(run) {
  const checkpoint = run?.checkpoint?.state || run?.checkpoint || null;
  if (!checkpoint) return null;
  const payload = {
    schemaVersion: checkpoint.schemaVersion,
    runId: checkpoint.runId,
    planReviewSnapshotHash: checkpoint.planReviewSnapshotHash,
    sourceBinding: checkpoint.sourceBinding,
    counters: checkpoint.counters,
  };
  const valid = checkpoint.schemaVersion === 'plan-review-replay-checkpoint-1.0.0'
    && checkpoint.runId === run.runId
    && checkpoint.planReviewSnapshotHash === run.planReviewSnapshotHash
    && hashPlanReviewSnapshot(checkpoint.sourceBinding) === checkpoint.planReviewSnapshotHash
    && canonicalSha256(payload) === checkpoint.checkpointHash;
  if (!valid) {
    return {
      schemaVersion: 'plan-review-replay-checkpoint-1.0.0',
      runId: run.runId,
      planReviewSnapshotHash: run.planReviewSnapshotHash,
      sourceBinding: run.sourceBinding,
      counters: checkpoint.counters || {},
      checkpointHash: 'INVALID_CHECKPOINT_HASH',
    };
  }
  const counters = {
    ...checkpoint.counters,
    modelCallCount: Math.max(Number(checkpoint.counters?.modelCallCount) || 0, Number(run.modelCallCount) || 0),
    tokenUsage: Math.max(Number(checkpoint.counters?.tokenUsage) || 0, Number(run.tokenUsage) || 0),
  };
  const reconciled = { ...payload, counters };
  return { ...reconciled, checkpointHash: canonicalSha256(reconciled) };
}

function progressFor(node, completedNodes = []) {
  const order = Object.keys(NODE_LABELS);
  const completed = [...new Set(completedNodes)];
  return {
    completedNodes: completed,
    percent: Math.min(100, Math.round((completed.length / order.length) * 100)),
    label: NODE_LABELS[node] || 'Working on your plan review',
  };
}

function addTrajectory(existing, event, node) {
  if (!event?.type) return existing || [];
  return [...(existing || []), {
    type: event.type,
    node,
    tool: event.tool || null,
    toolCallId: /^[0-9a-f-]{36}$/i.test(event.toolCallId || '') ? event.toolCallId : null,
    capabilityId: typeof event.capabilityId === 'string' ? event.capabilityId.slice(0, 120) : null,
    capabilityVersion: typeof event.capabilityVersion === 'string' ? event.capabilityVersion.slice(0, 40) : null,
    capabilityEffect: typeof event.effect === 'string' ? event.effect.slice(0, 20) : null,
    resourceScope: typeof event.resourceScope === 'string' ? event.resourceScope.slice(0, 60) : null,
    ownerScoped: typeof event.ownerScoped === 'boolean' ? event.ownerScoped : null,
    writesFinancialAuthority: typeof event.writesFinancialAuthority === 'boolean' ? event.writesFinancialAuthority : null,
    networkAccess: typeof event.networkAccess === 'string' ? event.networkAccess.slice(0, 20) : null,
    shadowAllowed: typeof event.shadowAllowed === 'boolean' ? event.shadowAllowed : null,
    requested: ['TOOL_SELECTED', 'TOOL_AUTHORIZED', 'TOOL_SUCCEEDED', 'TOOL_FAILED'].includes(event.type),
    attempted: event.type === 'TOOL_SUCCEEDED' || (event.type === 'TOOL_FAILED' && event.executionStarted === true),
    authorized: ['TOOL_AUTHORIZED', 'TOOL_SUCCEEDED'].includes(event.type)
      || (event.type === 'TOOL_FAILED' && event.executionStarted === true),
    executed: event.type === 'TOOL_SUCCEEDED' || (event.type === 'TOOL_FAILED' && event.executionStarted === true),
    executionGeneration: Number.isInteger(Number(event.executionGeneration)) ? Number(event.executionGeneration) : null,
    code: event.code || null,
    inputHash: /^[a-f0-9]{64}$/.test(event.inputHash || '') ? event.inputHash : null,
    outputHash: /^[a-f0-9]{64}$/.test(event.outputHash || '') ? event.outputHash : null,
    startedAt: event.startedAt || null,
    rejectedToolRequestCount: Number.isInteger(event.rejectedToolRequestCount)
      ? Math.min(8, Math.max(0, event.rejectedToolRequestCount))
      : null,
    at: event.at || now().toISOString(),
  }].slice(-100);
}

function leaseFilter(run) {
  return { runId: run.runId, workerId: run.workerId, executionGeneration: run.executionGeneration };
}

function staleLeaseError() {
  const error = new Error('The worker lease is no longer valid.');
  error.code = 'AGENT_LEASE_LOST';
  return error;
}

function isModified(result) {
  return Number(result?.modifiedCount ?? result?.nModified ?? 0) > 0;
}

function isMatched(result) {
  return Number(result?.matchedCount ?? result?.n ?? result?.nMatched ?? result?.modifiedCount ?? result?.nModified ?? 0) > 0;
}

function classifyFailure(error) {
  if (error?.code === 'AGENT_RUN_CANCELLED') return 'CANCELLED';
  if (error?.code === 'PLAN_REVIEW_SOURCE_SUPERSEDED') return 'PLAN_REVIEW_SOURCE_SUPERSEDED';
  if (error?.code === 'AGENT_BUDGET_EXCEEDED') return 'BUDGET_EXCEEDED';
  if (error?.code === 'AGENT_BUDGET_PERSISTENCE_UNAVAILABLE') return 'BUDGET_RESERVATION_UNAVAILABLE';
  if (error?.code === 'PLAN_REVIEW_TIMEOUT' || error?.code === 'TOOL_TIMEOUT') return 'PLAN_REVIEW_TIMEOUT';
  if (error?.code === 'AGENT_LEASE_LOST') return 'STALE_FINALIZATION_REJECTED';
  if (error?.code === 'CHECKPOINT_FAILURE') return 'CHECKPOINT_FAILURE';
  if (error?.code === 'UNKNOWN_TOOL' || error?.code?.startsWith?.('TOOL_')) return 'TOOL_FAILURE';
  if (error?.retryable || error?.code === 'PROVIDER_UNAVAILABLE' || error?.code === 'MODEL_TIMEOUT') return 'PROVIDER_UNAVAILABLE';
  return 'INTERNAL_RUNTIME_FAILURE';
}

function isRetryableFailure(error) {
  return error?.retryable === true
    || ['PROVIDER_UNAVAILABLE', 'MODEL_TIMEOUT', 'PLAN_REVIEW_TIMEOUT', 'TOOL_TIMEOUT', 'MONGO_TRANSIENT_TRANSACTION_ERROR']
      .includes(error?.code);
}

export async function claimNextPlanReviewRun({ model = AgentRun, leaseMs = 60000, worker = crypto.randomUUID(), nowValue = now() } = {}) {
  const span = tracer.startSpan('agent.queue.claim', { attributes: { 'agent.type': 'PLAN_REVIEW', 'worker.operation': 'claim' } });
  try {
    const claimed = await model.findOneAndUpdate({
      agentType: 'PLAN_REVIEW',
      $or: [
        { status: 'QUEUED', $or: [{ retryAt: null }, { retryAt: { $lte: nowValue } }] },
        { status: 'RUNNING', leaseUntil: { $lt: nowValue }, attempt: { $lt: PLAN_REVIEW_BUDGETS.maxAttempts } },
      ],
    }, {
      $set: {
        status: 'RUNNING',
        workerId: worker,
        leaseUntil: new Date(nowValue.getTime() + leaseMs),
        lastHeartbeatAt: nowValue,
        startedAt: nowValue,
        currentNode: 'load_context',
        retryAt: null,
      },
      $inc: { attempt: 1, executionGeneration: 1 },
    }, { sort: { priorityRank: 1, queuedAt: 1 }, new: true });
    if (claimed) PrometheusMetrics.setGauge('agent_worker_jobs_active', 1);
    if (claimed?.attempt > 1) PrometheusMetrics.inc('agent_worker_recovered_runs_total');
    span.setAttribute('run.state', claimed ? 'RUNNING' : 'EMPTY');
    return claimed?.lean ? claimed.lean() : claimed;
  } finally {
    span.end();
  }
}

export async function recoverExpiredPlanReviewRuns({
  model = AgentRun,
  eventModel = AgentRunEvent,
  checkpointModel = AgentCheckpoint,
  graphCheckpointModel = AgentGraphCheckpoint,
  productionEvaluationModel = null,
  mongo = mongoose,
  nowValue = now(),
  batchSize = MAX_EXPIRED_PLAN_REVIEW_RECOVERY_BATCH_SIZE,
} = {}) {
  const safeBatchSize = Math.max(1, Math.min(
    MAX_EXPIRED_PLAN_REVIEW_RECOVERY_BATCH_SIZE,
    Math.floor(Number(batchSize) || MAX_EXPIRED_PLAN_REVIEW_RECOVERY_BATCH_SIZE),
  ));
  let candidatesQuery = model.find({
    agentType: 'PLAN_REVIEW',
    status: 'RUNNING',
    leaseUntil: { $lt: nowValue },
    attempt: { $gte: PLAN_REVIEW_BUDGETS.maxAttempts },
  });
  if (typeof candidatesQuery.select === 'function') {
    candidatesQuery = candidatesQuery.select('_id runId userId workerId executionGeneration attempt eventSequence currentNode traceId correlationId');
  }
  if (typeof candidatesQuery.sort === 'function') {
    candidatesQuery = candidatesQuery.sort({ leaseUntil: 1, _id: 1 });
  }
  if (typeof candidatesQuery.limit === 'function') {
    candidatesQuery = candidatesQuery.limit(safeBatchSize);
  }
  const candidates = await (candidatesQuery.lean ? candidatesQuery.lean() : candidatesQuery);
  let recovered = 0;
  for (const candidate of candidates || []) {
    const session = await mongo.startSession();
    let candidateRecovered = false;
    try {
      if (typeof session?.withTransaction !== 'function') {
        const error = new Error('Expired PlanReview recovery requires transaction-capable MongoDB.');
        error.code = 'TRANSACTION_REQUIRED';
        throw error;
      }
      await session.withTransaction(async () => {
        // Mongo may retry this callback after a transient transaction error.
        // Keep the return count tied to the final committed attempt, not to
        // provisional writes from an aborted callback invocation.
        candidateRecovered = false;
        const eventSequence = Number(candidate.eventSequence || 0) + 1;
        const update = {
          $set: {
            status: 'FAILED',
            failure: { code: 'INTERNAL_RUNTIME_FAILURE', message: 'Worker lease expired after the maximum retry attempts.' },
            deadLetter: {
              code: 'INTERNAL_RUNTIME_FAILURE',
              attempt: Number(candidate.attempt || 0),
              executionGeneration: Number(candidate.executionGeneration || 0),
              lastNode: candidate.currentNode || null,
              traceId: candidate.traceId || null,
              correlationId: candidate.correlationId || null,
              at: nowValue,
            },
            completedAt: nowValue,
            leaseUntil: null,
            currentNode: null,
          },
          $unset: { activeDedupeKey: 1 },
          ...(eventModel?.create ? { $inc: { eventSequence: 1 } } : {}),
        };
        const fence = Number(candidate.eventSequence || 0) === 0
          ? { $or: [{ eventSequence: { $exists: false } }, { eventSequence: 0 }] }
          : { eventSequence: Number(candidate.eventSequence) };
        const write = await model.updateOne({
          _id: candidate._id,
          runId: candidate.runId,
          workerId: candidate.workerId,
          executionGeneration: candidate.executionGeneration,
          agentType: 'PLAN_REVIEW',
          status: 'RUNNING',
          leaseUntil: { $lt: nowValue },
          attempt: { $gte: PLAN_REVIEW_BUDGETS.maxAttempts },
          ...fence,
        }, update, { session });
        if (!isModified(write)) return;
        const expiresAt = new Date(nowValue.getTime() + PLAN_REVIEW_CHECKPOINT_RETENTION_MS);
        await checkpointModel.updateMany({ runId: candidate.runId, userId: candidate.userId }, { $set: { expiresAt } }, { session });
        await graphCheckpointModel.updateMany({ runId: candidate.runId, userId: candidate.userId }, { $set: { expiresAt } }, { session });
        if (eventModel?.create) {
          await eventModel.create([{
            runId: candidate.runId,
            userId: candidate.userId,
            executionGeneration: candidate.executionGeneration,
            sequence: eventSequence,
            eventType: 'RUN_FAILED',
            node: candidate.currentNode || null,
            data: { type: 'RUN_FAILED', code: 'INTERNAL_RUNTIME_FAILURE', at: nowValue.toISOString() },
          }], { session });
        }
        candidateRecovered = true;
      });
      if (candidateRecovered) {
        recovered += 1;
        if (productionEvaluationModel) {
          scheduleTerminalEvaluationReconciliation({ runModel: model, eventModel, evaluationModel: productionEvaluationModel });
        }
      }
    } finally {
      await session.endSession();
    }
  }
  for (let index = 0; index < recovered; index += 1) PrometheusMetrics.recordAgentDeadLetter('INTERNAL_RUNTIME_FAILURE');
  return recovered;
}

async function updateQueueMetrics(model) {
  if (typeof model.findOne !== 'function') return;
  const oldest = await model.findOne({ agentType: 'PLAN_REVIEW', status: 'QUEUED' }).sort({ queuedAt: 1 }).lean();
  PrometheusMetrics.setGauge('agent_queue_oldest_age_seconds', oldest?.queuedAt
    ? Math.max(0, (Date.now() - new Date(oldest.queuedAt).getTime()) / 1000)
    : 0);
}

class PlanReviewWorker {
  constructor({
    model = AgentRun,
    checkpointModel = AgentCheckpoint,
    graphCheckpointModel = AgentGraphCheckpoint,
    eventModel = null,
    productionEvaluationModel = null,
    mandateModel = UserIntentMandate,
    profileModel = FinancialProfile,
    profileStateModel = FinancialProfileState,
    stateModel = RecommendationState,
    snapshotResolver = resolvePlanReviewSnapshot,
    mongo = mongoose,
    runtimeConfig = null,
    worker = null,
    runPlanReviewImpl = runPlanReview,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    recoverExpiredRunsImpl = recoverExpiredPlanReviewRuns,
    reconcileMandatesImpl = reconcileTerminalPlanReviewMandates,
  } = {}) {
    this.model = model;
    this.checkpointModel = checkpointModel;
    this.graphCheckpointModel = graphCheckpointModel;
    this.eventModel = eventModel;
    this.productionEvaluationModel = productionEvaluationModel;
    this.mandateModel = mandateModel;
    this.profileModel = profileModel;
    this.profileStateModel = profileStateModel;
    this.stateModel = stateModel;
    this.snapshotResolver = snapshotResolver;
    this.mongo = mongo;
    this.runtimeConfig = runtimeConfig;
    this.runPlanReviewImpl = runPlanReviewImpl;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.recoverExpiredRunsImpl = recoverExpiredRunsImpl;
    this.reconcileMandatesImpl = reconcileMandatesImpl;
    this.workerId = worker || `plan-review-worker-${crypto.randomUUID()}`;
    this.leaseMs = runtimeConfig?.agentPlanReview?.leaseMs || 60000;
    this.heartbeatMs = runtimeConfig?.agentPlanReview?.heartbeatMs || Math.floor(this.leaseMs / 4);
    this.timer = null;
    this.heartbeatTimer = null;
    this.mandateReconciliationTimer = null;
    this.mandateReconciliationPromise = null;
    this.expiredRunRecoveryTimer = null;
    this.expiredRunRecoveryPromise = null;
    this.productionEvaluationReconciliationTimer = null;
    this.pollPromise = null;
    this.activePromise = null;
    this.activeRun = null;
    this.activeAbortController = null;
    this.draining = false;
    this.leaseLost = false;
  }

  state() {
    return {
      running: Boolean(this.timer),
      draining: this.draining,
      ready: Boolean(this.timer) && !this.draining,
      activeJobs: this.activePromise ? 1 : 0,
    };
  }

  async assertLease(run = this.activeRun) {
    if (!run || this.leaseLost) throw staleLeaseError();
    const current = await this.model.findOne({ ...leaseFilter(run), status: 'RUNNING', leaseUntil: { $gt: now() } }).lean();
    if (!current) {
      this.leaseLost = true;
      PrometheusMetrics.inc('agent_worker_stale_write_rejections_total');
      throw staleLeaseError();
    }
    return current;
  }

  async heartbeat() {
    if (!this.activeRun || this.leaseLost) return false;
    const span = tracer.startSpan('agent.queue.heartbeat', { attributes: { 'agent.type': 'PLAN_REVIEW', 'worker.operation': 'heartbeat' } });
    try {
      const heartbeatAt = new Date(Date.now());
      const result = await this.model.updateOne({
        ...leaseFilter(this.activeRun),
        status: 'RUNNING',
        cancellationRequested: { $ne: true },
        leaseUntil: { $gt: heartbeatAt },
      }, {
        $max: {
          lastHeartbeatAt: heartbeatAt,
          leaseUntil: new Date(heartbeatAt.getTime() + this.leaseMs),
        },
      });
      if (!isMatched(result)) {
        this.leaseLost = true;
        this.activeAbortController?.abort(staleLeaseError());
        PrometheusMetrics.inc('agent_worker_lease_conflicts_total');
        PrometheusMetrics.inc('agent_worker_stale_write_rejections_total');
        span.setAttribute('run.state', 'LEASE_LOST');
        return false;
      }
      span.setAttribute('run.state', 'RUNNING');
      return true;
    } finally {
      span.end();
    }
  }

  startHeartbeat() {
    this.heartbeatTimer = this.setIntervalImpl(() => {
      void this.heartbeat().catch(error => {
        if (this.leaseLost) return;
        this.leaseLost = true;
        this.activeAbortController?.abort(staleLeaseError());
        PrometheusMetrics.inc('agent_worker_heartbeat_failures_total');
        PrometheusMetrics.inc('agent_worker_stale_write_rejections_total');
        logger.error('PlanReview worker heartbeat failed; active work was fenced', {
          code: error?.code || 'WORKER_HEARTBEAT_FAILED',
          runId: this.activeRun?.runId || null,
          executionGeneration: Number(this.activeRun?.executionGeneration) || null,
        });
      });
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) this.clearIntervalImpl(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async updateProgress(run, payload) {
    await this.assertLease(run);
    const safeState = checkpointState(payload.state || {});
    const session = await this.mongo.startSession();
    let sequence = null;
    try {
      if (typeof session?.withTransaction !== 'function') {
        const error = new Error('PlanReview checkpoint publication requires transaction-capable MongoDB.');
        error.code = 'TRANSACTION_REQUIRED';
        throw error;
      }
      await session.withTransaction(async () => {
        const currentQuery = this.model.findOne({
          ...leaseFilter(run),
          status: 'RUNNING',
          leaseUntil: { $gt: now() },
        });
        currentQuery.session?.(session);
        const current = await (currentQuery.lean ? currentQuery.lean() : currentQuery);
        if (!current) throw staleLeaseError();
        if (current.cancellationRequested) {
          const error = new Error('AGENT_RUN_CANCELLED');
          error.code = 'AGENT_RUN_CANCELLED';
          throw error;
        }
        const previousSequence = Number(current.checkpointSequence || 0);
        sequence = previousSequence + 1;
        const completedNodes = [...new Set([
          ...(current.progress?.completedNodes || []),
          ...(payload.node && payload.event?.type !== 'TOOL_FAILED' ? [payload.node] : []),
        ])];
        const options = { upsert: true, new: true, session };
        await this.checkpointModel.findOneAndUpdate(
          { runId: run.runId, userId: run.userId, executionGeneration: run.executionGeneration, sequence },
          {
            $setOnInsert: { runId: run.runId, userId: run.userId, executionGeneration: run.executionGeneration, sequence, createdAt: now() },
            $set: { workerId: run.workerId, node: payload.node || 'unknown', state: safeState },
          },
          options,
        );
        const heartbeatAt = new Date(Date.now());
        const set = {
          currentNode: payload.node || null,
          checkpoint: { state: safeState },
          checkpointSequence: sequence,
          progress: progressFor(payload.node, completedNodes),
        };
        if (payload.event) set.trajectory = addTrajectory(current.trajectory, {
          ...payload.event,
          executionGeneration: run.executionGeneration,
        }, payload.node);
        if (['TOOL_SELECTED', 'TOOL_AUTHORIZED', 'TOOL_SUCCEEDED', 'TOOL_FAILED'].includes(payload.event?.type)) {
          const has = key => Object.prototype.hasOwnProperty.call(payload.event, key);
          const stage = ({ TOOL_SELECTED: 'SELECTED', TOOL_AUTHORIZED: 'AUTHORIZED', TOOL_SUCCEEDED: 'SUCCEEDED', TOOL_FAILED: 'FAILED' })[payload.event.type];
          const ledger = {
            sequence,
            tool: payload.event.tool || null,
            toolCallId: /^[0-9a-f-]{36}$/i.test(payload.event.toolCallId || '') ? payload.event.toolCallId : null,
            capabilityId: typeof payload.event.capabilityId === 'string' ? payload.event.capabilityId.slice(0, 120) : null,
            capabilityVersion: typeof payload.event.capabilityVersion === 'string' ? payload.event.capabilityVersion.slice(0, 40) : null,
            capabilityEffect: typeof payload.event.effect === 'string' ? payload.event.effect.slice(0, 20) : null,
            resourceScope: typeof payload.event.resourceScope === 'string' ? payload.event.resourceScope.slice(0, 60) : null,
            ownerScoped: typeof payload.event.ownerScoped === 'boolean' ? payload.event.ownerScoped : null,
            writesFinancialAuthority: typeof payload.event.writesFinancialAuthority === 'boolean' ? payload.event.writesFinancialAuthority : null,
            networkAccess: typeof payload.event.networkAccess === 'string' ? payload.event.networkAccess.slice(0, 20) : null,
            shadowAllowed: typeof payload.event.shadowAllowed === 'boolean' ? payload.event.shadowAllowed : null,
            requested: true,
            attempted: stage === 'SUCCEEDED' || (stage === 'FAILED' && payload.event.executionStarted === true),
            authorized: ['TOOL_AUTHORIZED', 'TOOL_SUCCEEDED'].includes(payload.event.type)
              || (payload.event.type === 'TOOL_FAILED' && payload.event.executionStarted === true),
            executed: payload.event.type === 'TOOL_SUCCEEDED'
              || (payload.event.type === 'TOOL_FAILED' && payload.event.executionStarted === true),
            executionGeneration: run.executionGeneration,
            stage,
            success: ['SELECTED', 'AUTHORIZED'].includes(stage) ? null : payload.event.type === 'TOOL_SUCCEEDED',
            code: payload.event.code || null,
            inputHash: /^[a-f0-9]{64}$/.test(payload.event.inputHash || '')
              ? payload.event.inputHash
              : (has('input') ? canonicalSha256(payload.event.input) : null),
            outputHash: /^[a-f0-9]{64}$/.test(payload.event.outputHash || '')
              ? payload.event.outputHash
              : (has('output') ? canonicalSha256(payload.event.output) : null),
            startedAt: payload.event.startedAt || payload.event.at || now().toISOString(),
            completedAt: ['SELECTED', 'AUTHORIZED'].includes(stage) ? null : now().toISOString(),
          };
          set.toolExecutionLedger = [...(current.toolExecutionLedger || []), ledger].slice(-50);
        }
        const sequenceFilter = previousSequence === 0
          ? { $or: [{ checkpointSequence: 0 }, { checkpointSequence: { $exists: false } }] }
          : { checkpointSequence: previousSequence };
        const result = await this.model.updateOne({
          ...leaseFilter(run),
          status: 'RUNNING',
          cancellationRequested: { $ne: true },
          leaseUntil: { $gt: heartbeatAt },
          ...sequenceFilter,
        }, {
          $set: set,
          $max: {
            lastHeartbeatAt: heartbeatAt,
            leaseUntil: new Date(heartbeatAt.getTime() + this.leaseMs),
          },
        }, { session });
        if (!isMatched(result)) {
          PrometheusMetrics.inc('agent_worker_stale_write_rejections_total');
          throw staleLeaseError();
        }
      });
    } finally {
      await session.endSession();
    }
    PrometheusMetrics.inc('agent_checkpoint_writes_total');
    await this.appendEvent(run, sequence, payload.event, payload.node);
  }

  async persistModelBudgetReservation(run, usage) {
    if (!Number.isInteger(usage?.modelCallCount)
        || usage.modelCallCount < 0
        || usage.modelCallCount > PLAN_REVIEW_BUDGETS.maxModelCalls
        || !Number.isInteger(usage?.tokenUsage)
        || usage.tokenUsage < 0
        || usage.tokenUsage > PLAN_REVIEW_BUDGETS.maxTotalTokens) {
      const error = new Error('PlanReview model budget reservation is invalid.');
      error.code = 'AGENT_BUDGET_EXCEEDED';
      throw error;
    }
    let result;
    try {
      const heartbeatAt = new Date(Date.now());
      result = await this.model.updateOne({
        ...leaseFilter(run),
        status: 'RUNNING',
        leaseUntil: { $gt: heartbeatAt },
      }, {
        $max: {
          modelCallCount: usage.modelCallCount,
          tokenUsage: usage.tokenUsage,
          lastHeartbeatAt: heartbeatAt,
          leaseUntil: new Date(heartbeatAt.getTime() + this.leaseMs),
        },
      });
    } catch (cause) {
      const error = new Error('Unable to durably reserve the PlanReview provider budget.');
      error.code = 'AGENT_BUDGET_PERSISTENCE_UNAVAILABLE';
      error.cause = cause;
      throw error;
    }
    if (!isMatched(result)) throw staleLeaseError();
  }

  async appendEvent(run, sequence, event, node = null) {
    if (!event?.type) return;
    const isToolEvent = ['TOOL_SELECTED', 'TOOL_AUTHORIZED', 'TOOL_SUCCEEDED', 'TOOL_FAILED'].includes(event.type);
    if (!this.eventModel?.create) {
      if (isToolEvent) {
        const error = new Error('PlanReview tool execution evidence storage is unavailable.');
        error.code = 'TOOL_EVIDENCE_PERSISTENCE_UNAVAILABLE';
        throw error;
      }
      return;
    }
    let session;
    try {
      session = await this.mongo.startSession();
      if (typeof session?.withTransaction !== 'function') {
        const error = new Error('PlanReview progress event publication requires transaction-capable MongoDB.');
        error.code = 'TRANSACTION_REQUIRED';
        throw error;
      }
      await session.withTransaction(async () => {
        const leaseAt = now();
        const currentQuery = this.model.findOne({
          ...leaseFilter(run),
          status: 'RUNNING',
          cancellationRequested: { $ne: true },
          leaseUntil: { $gt: leaseAt },
        });
        currentQuery.session?.(session);
        const current = await (currentQuery.lean ? currentQuery.lean() : currentQuery);
        if (!current) throw staleLeaseError();

        let latestSequence = 0;
        if (this.eventModel.findOne) {
          let latestQuery = this.eventModel.findOne({ runId: run.runId, userId: run.userId });
          if (latestQuery?.sort) latestQuery = latestQuery.sort({ sequence: -1 });
          latestQuery.session?.(session);
          const latest = await (latestQuery.lean ? latestQuery.lean() : latestQuery);
          latestSequence = Number(latest?.sequence) || 0;
        }
        const previousSequence = Number(current.eventSequence) || 0;
        const eventSequence = Math.max(previousSequence, latestSequence) + 1;
        const sequenceFence = previousSequence === 0
          ? { $or: [{ eventSequence: 0 }, { eventSequence: { $exists: false } }] }
          : { eventSequence: previousSequence };
        const write = await this.model.updateOne({
          ...leaseFilter(run),
          status: 'RUNNING',
          cancellationRequested: { $ne: true },
          leaseUntil: { $gt: now() },
          ...sequenceFence,
        }, { $set: { eventSequence } }, { session });
        if (!isModified(write)) throw staleLeaseError();

        await this.eventModel.create([{
          runId: run.runId,
          userId: run.userId,
          executionGeneration: run.executionGeneration,
          sequence: eventSequence,
          eventType: event.type,
          node: node || null,
          data: {
            type: event.type,
            node: node || null,
            tool: event.tool || null,
            toolCallId: /^[0-9a-f-]{36}$/i.test(event.toolCallId || '') ? event.toolCallId : null,
            requested: ['TOOL_SELECTED', 'TOOL_AUTHORIZED', 'TOOL_SUCCEEDED', 'TOOL_FAILED'].includes(event.type),
            attempted: event.type === 'TOOL_SUCCEEDED' || (event.type === 'TOOL_FAILED' && event.executionStarted === true),
            authorized: ['TOOL_AUTHORIZED', 'TOOL_SUCCEEDED'].includes(event.type)
              || (event.type === 'TOOL_FAILED' && event.executionStarted === true),
            executed: event.type === 'TOOL_SUCCEEDED' || (event.type === 'TOOL_FAILED' && event.executionStarted === true),
            executionGeneration: run.executionGeneration,
            capabilityId: typeof event.capabilityId === 'string' ? event.capabilityId.slice(0, 120) : null,
            capabilityVersion: typeof event.capabilityVersion === 'string' ? event.capabilityVersion.slice(0, 40) : null,
            capabilityEffect: typeof event.effect === 'string' ? event.effect.slice(0, 20) : null,
            resourceScope: typeof event.resourceScope === 'string' ? event.resourceScope.slice(0, 60) : null,
            ownerScoped: typeof event.ownerScoped === 'boolean' ? event.ownerScoped : null,
            writesFinancialAuthority: typeof event.writesFinancialAuthority === 'boolean' ? event.writesFinancialAuthority : null,
            networkAccess: typeof event.networkAccess === 'string' ? event.networkAccess.slice(0, 20) : null,
            shadowAllowed: typeof event.shadowAllowed === 'boolean' ? event.shadowAllowed : null,
            code: event.code || null,
            inputHash: /^[a-f0-9]{64}$/.test(event.inputHash || '') ? event.inputHash : null,
            outputHash: /^[a-f0-9]{64}$/.test(event.outputHash || '') ? event.outputHash : null,
            startedAt: event.startedAt || null,
            rejectedToolRequestCount: Number.isInteger(event.rejectedToolRequestCount)
              ? Math.min(8, Math.max(0, event.rejectedToolRequestCount))
              : null,
            at: event.at || now().toISOString(),
          },
        }], { session });
      });
    } catch (error) {
      // Tool events are part of the execution authorization/evidence boundary:
      // never execute a tool if its durable event could not be published.
      if (isToolEvent) {
        if (error?.code !== 11000) PrometheusMetrics.inc('agent_event_persistence_failures_total');
        throw error;
      }
      // Other event streaming is a progress surface. A transient event write
      // must not change the authoritative AgentRun result or financial outcome.
      if (error?.code !== 11000) PrometheusMetrics.inc('agent_event_persistence_failures_total');
    } finally {
      try {
        await session?.endSession();
      } catch {
        // Session cleanup is also best-effort for progress events. In
        // particular, cleanup after a committed event must not turn the
        // checkpoint/result path into a reported worker failure.
        PrometheusMetrics.inc('agent_event_persistence_failures_total');
      }
    }
  }

  async finishRun(run, review) {
    const current = await this.assertLease(run);
    if (!run.sourceBinding || hashPlanReviewSnapshot(run.sourceBinding) !== run.planReviewSnapshotHash) {
      const error = new Error('The queued PlanReview source binding failed integrity verification.');
      error.code = 'PLAN_REVIEW_SOURCE_BINDING_INVALID';
      throw error;
    }
    const result = review || null;
    const status = result?.recommendedAction === 'RECOMPUTE_PLAN' ? 'WAITING_FOR_APPROVAL' : 'COMPLETED';
    const exactCounter = (name, value, max) => {
      const count = value === undefined || value === null ? 0 : Number(value);
      if (!Number.isInteger(count) || count < 0 || count > max) {
        const error = new Error(`PlanReview ${name} exceeded its hard execution budget.`);
        error.code = 'AGENT_BUDGET_EXCEEDED';
        error.reason = name.toUpperCase();
        throw error;
      }
      return count;
    };
    const terminalEvent = status === 'COMPLETED' ? 'RUN_COMPLETED' : 'RUN_WAITING_FOR_APPROVAL';
    const update = {
      $set: {
        status,
        result,
        recommendedAction: result?.recommendedAction || 'INSUFFICIENT_EVIDENCE',
        findingCodes: (result?.findings || []).map(item => item.code),
        evidenceIds: (result?.evidence?.entries || []).map(item => item.id).filter(Boolean),
        provider: result?.provider?.name || 'DETERMINISTIC_FALLBACK',
        model: result?.provider?.model || null,
        stepCount: exactCounter('stepCount', result?.execution?.stepCount, PLAN_REVIEW_BUDGETS.maxSteps),
        toolCallCount: exactCounter('toolCallCount', result?.execution?.toolCallCount, PLAN_REVIEW_BUDGETS.maxToolCalls),
        modelCallCount: exactCounter('modelCallCount', result?.execution?.modelCallCount, PLAN_REVIEW_BUDGETS.maxModelCalls),
        tokenUsage: exactCounter('tokenUsage', result?.execution?.tokenUsage, PLAN_REVIEW_BUDGETS.maxTotalTokens),
        completedAt: now(),
        leaseUntil: null,
        currentNode: null,
        progress: { completedNodes: Object.keys(NODE_LABELS), percent: 100, label: 'Review ready' },
      },
      $push: { trajectory: { $each: [{ type: terminalEvent, at: now().toISOString() }], $slice: -100 } },
    };
    if (status === 'COMPLETED') update.$unset = { activeDedupeKey: 1 };
    const terminalSequence = Number(current?.eventSequence || 0) + 1;
    const eventSequenceFence = current?.eventSequence === undefined
      ? { $or: [{ eventSequence: { $exists: false } }, { eventSequence: 0 }] }
      : { eventSequence: current.eventSequence };
    if (this.eventModel?.create) update.$inc = { eventSequence: 1 };
    let committed = false;
    const session = await this.mongo.startSession();
    try {
      if (typeof session.withTransaction !== 'function') {
        const error = new Error('PlanReview publication requires transaction-capable MongoDB.');
        error.code = 'TRANSACTION_REQUIRED';
        throw error;
      }
      await session.withTransaction(async () => {
        const snapshot = await this.snapshotResolver({
          userId: run.userId,
          profileId: run.profileId,
          profileModel: this.profileModel,
          session,
          dependencies: { stateModel: this.stateModel },
          profileStateModel: this.profileStateModel,
        });
        if (snapshot.planReviewSnapshotHash !== run.planReviewSnapshotHash) {
          const error = new Error('Financial source state changed while the PlanReview was running.');
          error.code = 'PLAN_REVIEW_SOURCE_SUPERSEDED';
          throw error;
        }

        const profileWrite = await this.profileModel.updateOne({
          _id: run.profileId,
          userId: run.userId,
          version: snapshot.sourceBinding.profileVersion,
        }, { $inc: { planReviewPublicationFence: 1 } }, { session });
        if (!isModified(profileWrite)) {
          const error = new Error('Profile changed before PlanReview publication.');
          error.code = 'PLAN_REVIEW_SOURCE_SUPERSEDED';
          throw error;
        }

        const profileStateRevision = snapshot.sourceBinding.financialProfileStateRevision;
        if (!Number.isSafeInteger(profileStateRevision)) {
          const error = new Error('PlanReview source is missing canonical profile-state provenance.');
          error.code = 'PLAN_REVIEW_SOURCE_SUPERSEDED';
          throw error;
        }
        const profileStateWrite = await this.profileStateModel.updateOne({
          userId: run.userId,
          currentProfileId: run.profileId,
          revision: profileStateRevision,
          resolutionStatus: 'CURRENT',
        }, { $inc: { promotionFence: 1 } }, { session });
        if (!isModified(profileStateWrite)) {
          const error = new Error('Canonical user profile changed before PlanReview publication.');
          error.code = 'PLAN_REVIEW_SOURCE_SUPERSEDED';
          throw error;
        }

        const pointer = snapshot.currentState?.statePointer;
        if (pointer) {
          const stateWrite = await this.stateModel.updateOne({
            _id: pointer._id,
            userId: run.userId,
            profileId: run.profileId,
            currentRecommendationId: pointer.currentRecommendationId,
            currentAllocationRevision: pointer.currentAllocationRevision,
            currentAllocationRevisionId: pointer.currentAllocationRevisionId,
            generationRevision: pointer.generationRevision,
            profileInputHash: pointer.profileInputHash,
            profileVersion: pointer.profileVersion,
            portfolioFingerprint: pointer.portfolioFingerprint,
            returnAssumptionVersion: pointer.returnAssumptionVersion,
            returnAssumptionHash: pointer.returnAssumptionHash,
            returnAssumptionSource: pointer.returnAssumptionSource,
          }, { $inc: { planReviewPublicationFence: 1 } }, { session });
          if (!isModified(stateWrite)) {
            const error = new Error('Canonical recommendation state changed before PlanReview publication.');
            error.code = 'PLAN_REVIEW_SOURCE_SUPERSEDED';
            throw error;
          }
        }

        const written = await this.model.updateOne({
          ...leaseFilter(run),
          status: 'RUNNING',
          cancellationRequested: { $ne: true },
          ...eventSequenceFence,
          planReviewSnapshotHash: run.planReviewSnapshotHash,
          leaseUntil: { $gt: now() },
        }, update, { session });
        if (!isModified(written)) {
          PrometheusMetrics.inc('agent_worker_stale_write_rejections_total');
          throw staleLeaseError();
        }
        if (this.eventModel?.create) {
          await this.eventModel.create([{
            runId: run.runId,
            userId: run.userId,
            executionGeneration: run.executionGeneration,
            sequence: terminalSequence,
            eventType: terminalEvent,
            node: 'persist_agent_run',
            data: { type: terminalEvent, node: 'persist_agent_run', at: now().toISOString() },
          }], { session });
        }
        if (status === 'COMPLETED') {
          const expiresAt = new Date(Date.now() + PLAN_REVIEW_CHECKPOINT_RETENTION_MS);
          await this.checkpointModel.updateMany({ runId: run.runId, userId: run.userId }, { $set: { expiresAt } }, { session });
          await this.graphCheckpointModel.updateMany({ runId: run.runId, userId: run.userId }, { $set: { expiresAt } }, { session });
        }
      });
      committed = true;
    } finally {
      await session.endSession();
    }
    if (!committed) return { committed: false, status: null };
    if (this.productionEvaluationModel) {
      scheduleTerminalEvaluationReconciliation({
        runModel: this.model, eventModel: this.eventModel, evaluationModel: this.productionEvaluationModel,
      });
    }
    if (status === 'COMPLETED') PrometheusMetrics.recordAgentRun('completed');
    return { committed: true, status, runId: run.runId };
  }

  async failRun(run, error) {
    if (error?.code === 'AGENT_LEASE_LOST') return;
    const retryable = isRetryableFailure(error);
    const terminal = !retryable || Number(run.attempt || 0) >= Number(run.maxAttempts || PLAN_REVIEW_BUDGETS.maxAttempts);
    const cancelled = error?.code === 'AGENT_RUN_CANCELLED';
    const budgetExceeded = error?.code === 'AGENT_BUDGET_EXCEEDED';
    const superseded = error?.code === 'PLAN_REVIEW_SOURCE_SUPERSEDED';
    const classification = classifyFailure(error);
    const update = {
      $set: {
        status: superseded ? 'SUPERSEDED' : (cancelled ? 'CANCELLED' : (budgetExceeded ? 'BUDGET_EXCEEDED' : (terminal ? 'FAILED' : 'QUEUED'))),
        retryAt: terminal || cancelled || budgetExceeded || superseded ? null : new Date(Date.now() + Math.min(30000, 1000 * (2 ** Math.max(0, Number(run.attempt || 1) - 1)))),
        failure: { code: classification, message: classification },
        deadLetter: terminal && !cancelled && !budgetExceeded && !superseded
          ? {
            code: classification,
            attempt: Number(run.attempt || 0),
            executionGeneration: Number(run.executionGeneration || 0),
            lastNode: run.currentNode || null,
            traceId: run.traceId || null,
            correlationId: run.correlationId || null,
            at: now(),
          }
          : null,
        leaseUntil: null,
        completedAt: terminal || cancelled || budgetExceeded || superseded ? now() : null,
        currentNode: terminal || cancelled || budgetExceeded || superseded ? null : run.currentNode,
      },
    };
    const measuredUsage = error?.planReviewUsage;
    if (Number.isInteger(measuredUsage?.modelCallCount)
        && measuredUsage.modelCallCount >= 0
        && measuredUsage.modelCallCount <= PLAN_REVIEW_BUDGETS.maxModelCalls) {
      update.$max = { ...(update.$max || {}), modelCallCount: measuredUsage.modelCallCount };
    }
    if (Number.isInteger(measuredUsage?.tokenUsage)
        && measuredUsage.tokenUsage >= 0
        && measuredUsage.tokenUsage <= PLAN_REVIEW_BUDGETS.maxTotalTokens) {
      update.$max = { ...(update.$max || {}), tokenUsage: measuredUsage.tokenUsage };
    }
    if (terminal || cancelled || budgetExceeded || superseded) update.$unset = { activeDedupeKey: 1 };
    let current;
    let session;
    let persistedEventSequence = null;
    try {
      session = await this.mongo.startSession();
      if (typeof session?.withTransaction !== 'function') {
        const transactionError = new Error('PlanReview failure publication requires transaction-capable MongoDB.');
        transactionError.code = 'TRANSACTION_REQUIRED';
        throw transactionError;
      }
      await session.withTransaction(async () => {
        const currentQuery = this.model.findOne({
          ...leaseFilter(run),
          status: 'RUNNING',
          leaseUntil: { $gt: now() },
        });
        currentQuery.session?.(session);
        current = await (currentQuery.lean ? currentQuery.lean() : currentQuery);
        if (!current) throw staleLeaseError();
        if (update.$set.deadLetter) {
          Object.assign(update.$set.deadLetter, {
            attempt: Number(current.attempt || run.attempt || 0),
            executionGeneration: Number(current.executionGeneration || run.executionGeneration || 0),
            lastNode: current.currentNode || run.currentNode || null,
            traceId: current.traceId || run.traceId || null,
            correlationId: current.correlationId || run.correlationId || null,
          });
        }
        const previousEventSequence = Number(current.eventSequence || 0);
        persistedEventSequence = previousEventSequence + 1;
        const expectedEventSequence = previousEventSequence === 0
          ? { $or: [{ eventSequence: { $exists: false } }, { eventSequence: 0 }] }
          : { eventSequence: previousEventSequence };
        const written = await this.model.updateOne({
          ...leaseFilter(run),
          status: 'RUNNING',
          leaseUntil: { $gt: now() },
          ...expectedEventSequence,
        }, {
          ...update,
          ...(this.eventModel?.create ? { $inc: { ...(update.$inc || {}), eventSequence: 1 } } : {}),
        }, { session });
        if (!isModified(written)) {
          PrometheusMetrics.inc('agent_worker_stale_write_rejections_total');
          throw staleLeaseError();
        }
        if (this.eventModel?.create) {
          const eventType = superseded ? 'RUN_SUPERSEDED'
            : (cancelled ? 'RUN_CANCELLED'
              : (budgetExceeded ? 'RUN_BUDGET_EXCEEDED'
                : (terminal ? 'RUN_FAILED' : 'RUN_RETRY_SCHEDULED')));
          await this.eventModel.create([{
            runId: run.runId,
            userId: run.userId,
            executionGeneration: run.executionGeneration,
            sequence: persistedEventSequence,
            eventType,
            node: current.currentNode || run.currentNode || null,
            data: { type: eventType, code: classification, at: now().toISOString() },
          }], { session });
        }
        if (terminal || cancelled || budgetExceeded || superseded) {
          const expiresAt = new Date(Date.now() + PLAN_REVIEW_CHECKPOINT_RETENTION_MS);
          await this.checkpointModel.updateMany({ runId: run.runId, userId: run.userId }, { $set: { expiresAt } }, { session });
          await this.graphCheckpointModel.updateMany({ runId: run.runId, userId: run.userId }, { $set: { expiresAt } }, { session });

        }
      });
    } finally {
      await session?.endSession();
    }
    if ((terminal || cancelled || budgetExceeded || superseded) && this.productionEvaluationModel) {
      scheduleTerminalEvaluationReconciliation({
        runModel: this.model, eventModel: this.eventModel, evaluationModel: this.productionEvaluationModel,
      });
    }
    if (cancelled) PrometheusMetrics.inc('agent_cancellation_total');
    if (budgetExceeded) PrometheusMetrics.inc('agent_budget_exceeded_total');
    if (terminal && !cancelled && !budgetExceeded && !superseded) PrometheusMetrics.recordAgentDeadLetter(classification);
    return {
      persisted: true,
      status: update.$set.status,
      terminal: terminal || cancelled || budgetExceeded || superseded,
    };
  }

  async processNext() {
    if (this.draining || this.pollPromise || this.activePromise || this.runtimeConfig?.agenticPlanReviewEnabled === false) return false;
    const pollPromise = Promise.resolve().then(() => this.processNextInternal());
    this.pollPromise = pollPromise;
    try {
      return await pollPromise;
    } finally {
      if (this.pollPromise === pollPromise) this.pollPromise = null;
    }
  }

  async processNextInternal() {
    if (this.draining || this.activePromise || this.runtimeConfig?.agenticPlanReviewEnabled === false) return false;
    await updateQueueMetrics(this.model);
    if (this.draining) return false;
    const run = await claimNextPlanReviewRun({ model: this.model, worker: this.workerId, leaseMs: this.leaseMs });
    if (!run) return false;
    if (this.draining) {
      await this.releaseUnstartedRun(run);
      return false;
    }
    this.activeRun = run;
    this.leaseLost = false;
    this.activeAbortController = new AbortController();
    this.startHeartbeat();
    const span = tracer.startSpan('agent.worker.execute', { attributes: { 'agent.type': 'PLAN_REVIEW', attempt: run.attempt || 0, 'queue.priority': run.priority || 'INTERACTIVE_PLAN_REVIEW' } });
    this.activePromise = (async () => {
      try {
        const review = await this.runPlanReviewImpl({
          userId: run.userId,
          profileId: run.profileId,
          runId: run.runId,
          executionGeneration: run.executionGeneration,
          expectedPlanReviewSnapshotHash: run.planReviewSnapshotHash,
          resumeCheckpoint: reconcilePlanReviewReplayCheckpoint(run),
          correlationId: run.correlationId,
          returnInternalResult: true,
          runtimeConfig: this.runtimeConfig,
          dependencies: {
            signal: this.activeAbortController.signal,
            checkpointer: new MongoPlanReviewCheckpointer({ runId: run.runId, userId: run.userId, workerId: run.workerId, executionGeneration: run.executionGeneration, assertLease: () => this.assertLease(run) }),
            onNodeProgress: payload => this.updateProgress(run, payload),
            onModelBudgetReservation: usage => this.persistModelBudgetReservation(run, usage),
            // The queue owns AgentRun finalization. Keeping this graph callback
            // side-effect free lets the final LangGraph checkpoint be written
            // while the lease is still RUNNING; finishRun then applies the
            // fenced terminal transition exactly once.
            persistAgentRun: async () => undefined,
          },
        });
        const latest = await this.model.findOne({ ...leaseFilter(run) }).lean();
        if (latest?.status !== 'RUNNING') {
          PrometheusMetrics.inc('agent_worker_stale_write_rejections_total');
          span.setAttribute('run.state', latest?.status || 'STALE_FINALIZATION_REJECTED');
        } else {
          const finalization = await this.finishRun(run, review);
          if (finalization?.committed && finalization.status === 'COMPLETED') {
            PrometheusMetrics.inc('agent_worker_jobs_completed_total');
            PrometheusMetrics.inc('agent_queue_runs_completed_total');
            span.setAttribute('run.state', 'COMPLETED');
          } else if (finalization?.committed && finalization.status === 'WAITING_FOR_APPROVAL') {
            PrometheusMetrics.inc('agent_worker_jobs_waiting_for_approval_total');
            span.setAttribute('run.state', 'WAITING_FOR_APPROVAL');
          } else {
            PrometheusMetrics.inc('agent_worker_stale_write_rejections_total');
            span.setAttribute('run.state', 'STALE_FINALIZATION_REJECTED');
          }
        }
      } catch (error) {
        const failureResult = await this.failRun(run, error).catch(failureError => {
          if (failureError?.code !== 'AGENT_LEASE_LOST') throw failureError;
          return null;
        });
        if (failureResult?.persisted) {
          if (error?.code === 'PLAN_REVIEW_TIMEOUT' || error?.code === 'TOOL_TIMEOUT') {
            PrometheusMetrics.inc('agent_worker_jobs_timed_out_total');
          }
          if (failureResult.status === 'FAILED') {
            PrometheusMetrics.inc('agent_worker_jobs_failed_total');
            PrometheusMetrics.inc('agent_queue_runs_failed_total');
            PrometheusMetrics.recordAgentRun('failed');
          } else if (failureResult.status === 'CANCELLED') {
            PrometheusMetrics.inc('agent_worker_jobs_cancelled_total');
          } else if (failureResult.status === 'SUPERSEDED') {
            PrometheusMetrics.inc('agent_worker_jobs_superseded_total');
          } else if (failureResult.status === 'BUDGET_EXCEEDED') {
            PrometheusMetrics.inc('agent_worker_jobs_budget_exceeded_total');
          }
        }
        span.setAttribute('run.state', failureResult?.status || classifyFailure(error));
      } finally {
        PrometheusMetrics.setGauge('agent_worker_jobs_active', 0);
        this.stopHeartbeat();
        this.activeRun = null;
        this.activeAbortController = null;
        this.leaseLost = false;
        this.activePromise = null;
        span.end();
      }
    })();
    await this.activePromise;
    return true;
  }

  async releaseUnstartedRun(run) {
    const released = await this.model.updateOne({
      ...leaseFilter(run),
      status: 'RUNNING',
      attempt: run.attempt,
    }, {
      $set: {
        status: 'QUEUED',
        workerId: null,
        leaseUntil: null,
        lastHeartbeatAt: null,
        startedAt: null,
        currentNode: null,
        retryAt: null,
      },
      // The queue claim incremented the attempt, but this worker never began
      // execution. Restore the budget while keeping executionGeneration
      // monotonic so any stale lease remains fenced.
      $inc: { attempt: -1 },
    });
    PrometheusMetrics.setGauge('agent_worker_jobs_active', 0);
    if (!isModified(released)) {
      PrometheusMetrics.inc('agent_worker_stale_write_rejections_total');
      logger.warn('PlanReview queue claim changed before shutdown could release it', {
        code: 'WORKER_SHUTDOWN_CLAIM_RELEASE_REJECTED',
      });
      return false;
    }
    return true;
  }

  start({ intervalMs = 500 } = {}) {
    if (this.timer || this.draining) return this;
    this.timer = this.setIntervalImpl(() => {
      void this.processNext().catch(error => {
        PrometheusMetrics.inc('agent_worker_poll_failures_total');
        logger.error('PlanReview worker poll failed', { code: error?.code || 'WORKER_POLL_FAILED' });
      });
    }, intervalMs);
    this.timer.unref?.();
    const reconcileMandates = () => {
      if (this.draining) return Promise.resolve();
      if (this.mandateReconciliationPromise) return this.mandateReconciliationPromise;
      let reconciliation;
      try {
        reconciliation = this.reconcileMandatesImpl({ runModel: this.model, mandateModel: this.mandateModel });
      } catch (error) {
        reconciliation = Promise.reject(error);
      }
      const trackedReconciliation = Promise.resolve(reconciliation)
        .catch(error => {
          PrometheusMetrics.inc('agent_mandate_reconciliation_failures_total');
          logger.warn('PlanReview mandate reconciliation sweep failed', { code: error?.code || 'MANDATE_RECONCILIATION_FAILED' });
        })
        .finally(() => {
          if (this.mandateReconciliationPromise === trackedReconciliation) this.mandateReconciliationPromise = null;
        });
      this.mandateReconciliationPromise = trackedReconciliation;
      return trackedReconciliation;
    };
    void reconcileMandates();
    this.mandateReconciliationTimer = this.setIntervalImpl(() => { void reconcileMandates(); }, 30000);
    this.mandateReconciliationTimer.unref?.();
    if (this.productionEvaluationModel) {
      const reconcileEvaluations = () => {
        if (this.draining) return;
        scheduleTerminalEvaluationReconciliation({
          runModel: this.model, eventModel: this.eventModel, evaluationModel: this.productionEvaluationModel,
        });
      };
      reconcileEvaluations();
      this.productionEvaluationReconciliationTimer = this.setIntervalImpl(reconcileEvaluations, 30000);
      this.productionEvaluationReconciliationTimer.unref?.();
    }
    const recover = () => {
      // Interval callbacks can already be queued when stop() clears the timer.
      // Do not let one start a new transaction after shutdown has begun.
      if (this.draining) return Promise.resolve();
      if (this.expiredRunRecoveryPromise) return this.expiredRunRecoveryPromise;
      let recovery;
      try {
        recovery = this.recoverExpiredRunsImpl({ model: this.model, eventModel: this.eventModel, checkpointModel: this.checkpointModel, graphCheckpointModel: this.graphCheckpointModel, productionEvaluationModel: this.productionEvaluationModel, mongo: this.mongo });
      } catch (error) {
        recovery = Promise.reject(error);
      }
      const trackedRecovery = Promise.resolve(recovery)
        .catch(error => {
          PrometheusMetrics.inc('agent_worker_recovery_failures_total');
          logger.error('PlanReview expired-run recovery failed', { code: error?.code || 'EXPIRED_RUN_RECOVERY_FAILED' });
        })
        .finally(() => {
          if (this.expiredRunRecoveryPromise === trackedRecovery) this.expiredRunRecoveryPromise = null;
        });
      this.expiredRunRecoveryPromise = trackedRecovery;
      return trackedRecovery;
    };
    void recover();
    this.expiredRunRecoveryTimer = this.setIntervalImpl(() => { void recover(); }, Math.max(5000, Math.min(this.leaseMs, 30000)));
    this.expiredRunRecoveryTimer.unref?.();
    void this.processNext().catch(error => {
      PrometheusMetrics.inc('agent_worker_poll_failures_total');
      logger.error('Initial PlanReview worker poll failed', { code: error?.code || 'WORKER_POLL_FAILED' });
    });
    return this;
  }

  async stop({ graceMs = this.runtimeConfig?.agentPlanReview?.shutdownGraceMs || 10000 } = {}) {
    this.draining = true;
    if (this.timer) this.clearIntervalImpl(this.timer);
    this.timer = null;
    if (this.mandateReconciliationTimer) this.clearIntervalImpl(this.mandateReconciliationTimer);
    this.mandateReconciliationTimer = null;
    if (this.productionEvaluationReconciliationTimer) this.clearIntervalImpl(this.productionEvaluationReconciliationTimer);
    this.productionEvaluationReconciliationTimer = null;
    if (this.expiredRunRecoveryTimer) this.clearIntervalImpl(this.expiredRunRecoveryTimer);
    this.expiredRunRecoveryTimer = null;
    const activeWorkPromise = this.pollPromise || this.activePromise;
    if (activeWorkPromise) {
      let timeout;
      const drained = await Promise.race([
        activeWorkPromise.then(() => true),
        new Promise(resolve => { timeout = this.setTimeoutImpl(() => resolve(false), graceMs); timeout?.unref?.(); }),
      ]);
      this.clearTimeoutImpl(timeout);
      if (!drained) {
        const error = new Error('Agent worker shutdown deadline exceeded.');
        error.code = 'AGENT_WORKER_SHUTDOWN';
        this.activeAbortController?.abort(error);
        let abortTimer;
        const abortedDrain = await Promise.race([
          activeWorkPromise.then(() => true),
          new Promise(resolve => { abortTimer = this.setTimeoutImpl(() => resolve(false), Math.min(1000, Math.max(100, graceMs))); abortTimer?.unref?.(); }),
        ]);
        this.clearTimeoutImpl(abortTimer);
        if (!abortedDrain) return { drained: false };
      }
    }
    if (this.expiredRunRecoveryPromise) {
      let timeout;
      const recoveryDrained = await Promise.race([
        this.expiredRunRecoveryPromise.then(() => true),
        new Promise(resolve => { timeout = this.setTimeoutImpl(() => resolve(false), graceMs); timeout?.unref?.(); }),
      ]);
      this.clearTimeoutImpl(timeout);
      if (!recoveryDrained) return { drained: false };
    }
    if (this.mandateReconciliationPromise) {
      let timeout;
      const mandatesDrained = await Promise.race([
        this.mandateReconciliationPromise.then(() => true),
        new Promise(resolve => { timeout = this.setTimeoutImpl(() => resolve(false), graceMs); timeout?.unref?.(); }),
      ]);
      this.clearTimeoutImpl(timeout);
      if (!mandatesDrained) return { drained: false };
    }
    if (!this.activePromise) this.stopHeartbeat();
    return { drained: !this.pollPromise && !this.activePromise && !this.expiredRunRecoveryPromise && !this.mandateReconciliationPromise };
  }
}

export function createPlanReviewWorker(options = {}) { return new PlanReviewWorker(options); }

export async function processNextPlanReviewRun(options = {}) {
  const worker = createPlanReviewWorker(options);
  return worker.processNext();
}

export function startPlanReviewWorker({ intervalMs = 500, runtimeConfig, ...options } = {}) {
  if (!defaultWorker) defaultWorker = createPlanReviewWorker({ runtimeConfig, ...options });
  defaultWorker.start({ intervalMs });
  return defaultWorker;
}

export async function stopPlanReviewWorker(options = {}) {
  if (!defaultWorker) return;
  const result = await defaultWorker.stop(options);
  if (result?.drained === false) {
    const error = new Error('PlanReview worker did not drain before shutdown deadline.');
    error.code = 'AGENT_WORKER_DRAIN_TIMEOUT';
    throw error;
  }
  defaultWorker = null;
  return result;
}

export function getPlanReviewWorkerState() {
  return defaultWorker?.state() || { running: false, draining: false, ready: false, activeJobs: 0 };
}
