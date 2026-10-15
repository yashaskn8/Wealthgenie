import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimNextPlanReviewRun,
  createPlanReviewWorker,
  reconcilePlanReviewReplayCheckpoint,
  recoverExpiredPlanReviewRuns,
} from '../agents/planReview/planReviewWorker.js';
import { claimPlanHealthSchedulerLease, runPlanHealthScan } from '../services/planHealthScheduler.js';
import { createPlanHealthScheduler } from '../services/planHealthScheduler.js';
import { inspectPlanHealth, planHealthEventFingerprint } from '../services/planHealthMonitor.js';
import { buildPlanReviewSnapshotBinding, hashPlanReviewSnapshot, PLAN_REVIEW_PRIORITY_RANK } from '../agents/planReview/planReviewRuntime.js';
import { canonicalSha256 } from '../utils/canonicalJson.js';
import { PrometheusMetrics } from '../services/metricsCollector.js';
import { executeSafeToolsNode } from '../agents/planReview/planReviewGraph.js';

const userId = '64b000000000000000000010';
const noCheckpointRetention = { updateMany: async () => ({ modifiedCount: 0 }) };

function lean(value) {
  return { lean: async () => value };
}

function leaseModelFixture() {
  let row = null;
  const matches = filter => Boolean(row)
    && (!filter._id || filter._id === row._id)
    && (!filter.owner || filter.owner === row.owner)
    && (!Number.isInteger(filter.executionGeneration) || filter.executionGeneration === row.executionGeneration)
    && (!filter.status || filter.status === row.status)
    && (!filter.leaseUntil?.$gt || row.leaseUntil > filter.leaseUntil.$gt);
  return {
    get row() { return row; },
    async findOneAndUpdate(filter, update) {
      if (row) {
        if (['COMPLETED', 'COMPLETED_WITH_ERRORS'].includes(row.status)) return null;
        const before = filter.$or?.find(item => item.leaseUntil)?.leaseUntil;
        if (row.leaseUntil && before?.$lte && row.leaseUntil > before.$lte) return null;
      } else {
        row = { ...update.$setOnInsert };
      }
      Object.assign(row, update.$set);
      for (const [key, amount] of Object.entries(update.$inc || {})) row[key] = Number(row[key] || 0) + amount;
      return { ...row };
    },
    findOne(filter) { return lean(matches(filter) ? { ...row } : null); },
    async updateOne(filter, update) {
      if (!matches(filter)) return { modifiedCount: 0 };
      Object.assign(row, update.$set || {});
      for (const [key, amount] of Object.entries(update.$inc || {})) row[key] = Number(row[key] || 0) + amount;
      return { modifiedCount: 1 };
    },
  };
}

function profileStateModelFixture({ userId: stateUserId = userId, profileId, revision = 1, onWrite = () => {} } = {}) {
  return {
    findOne: () => lean({
      userId: stateUserId,
      currentProfileId: profileId,
      revision,
      promotionFence: 0,
      resolutionStatus: 'CURRENT',
    }),
    async updateOne(filter, update, options) {
      onWrite(filter, update, options);
      return filter.currentProfileId === profileId && filter.revision === revision
        ? { modifiedCount: 1 }
        : { modifiedCount: 0 };
    },
  };
}

function noOpTransactionMongo() {
  return {
    async startSession() {
      return { withTransaction: async callback => callback(), endSession: async () => {} };
    },
  };
}

function publicationFenceModelFixture() {
  const rows = new Map();
  return {
    rows,
    async create(document) {
      rows.set(document._id, { ...document });
      return rows.get(document._id);
    },
    async updateOne(filter, update) {
      const row = rows.get(filter._id);
      if (!row || (filter.status && row.status !== filter.status)) return { modifiedCount: 0 };
      if (filter.deadlineAt?.$gt && !(row.deadlineAt > filter.deadlineAt.$gt)) return { modifiedCount: 0 };
      Object.assign(row, update.$set || {});
      return { modifiedCount: 1 };
    },
    findOne(filter) { return lean(rows.get(filter._id) || null); },
  };
}

test('two worker instances race atomically and exactly one claims a queued run', async () => {
  let run = {
    runId: 'run-race',
    agentType: 'PLAN_REVIEW',
    userId,
    status: 'QUEUED',
    attempt: 0,
    executionGeneration: 0,
    maxAttempts: 2,
    queuedAt: new Date(0),
    priority: 'INTERACTIVE_PLAN_REVIEW',
  };
  const model = {
    async findOneAndUpdate() {
      if (run.status !== 'QUEUED') return null;
      run = { ...run, status: 'RUNNING', workerId: 'winner', attempt: 1, executionGeneration: 1 };
      return { ...run };
    },
  };
  const [first, second] = await Promise.all([
    claimNextPlanReviewRun({ model, worker: 'worker-a' }),
    claimNextPlanReviewRun({ model, worker: 'worker-b' }),
  ]);
  assert.equal(Boolean(first) + Boolean(second), 1);
});

test('best-effort progress event cleanup failure cannot escape after its transaction', async () => {
  const run = {
    runId: 'run-event-cleanup-failure',
    userId,
    workerId: 'worker-a',
    executionGeneration: 3,
    status: 'RUNNING',
    cancellationRequested: false,
    leaseUntil: new Date(Date.now() + 60000),
    eventSequence: 0,
  };
  const session = {
    withTransaction: async callback => callback(),
    endSession: async () => { throw new Error('injected session cleanup failure'); },
  };
  const events = [];
  const worker = createPlanReviewWorker({
    model: {
      findOne() {
        const query = { session() { return query; }, lean: async () => run };
        return query;
      },
      async updateOne() {
        run.eventSequence += 1;
        return { modifiedCount: 1 };
      },
    },
    mongo: { startSession: async () => session },
    eventModel: { async create(rows) { events.push(...rows); } },
    worker: run.workerId,
  });

  await assert.doesNotReject(worker.appendEvent(run, 0, { type: 'NODE_COMPLETED' }));
  assert.equal(run.eventSequence, 1, 'the transactional event append completed before cleanup failed');
  assert.equal(events.length, 1);
  assert.equal(events[0].sequence, 1);
});

test('tool evidence insertion failure aborts graph execution before the read-only tool runs', async () => {
  const run = {
    runId: 'run-tool-event-failure', userId, workerId: 'worker-tool-event-failure',
    executionGeneration: 1, status: 'RUNNING', cancellationRequested: false,
    leaseUntil: new Date(Date.now() + 60000), checkpointSequence: 0, eventSequence: 0,
    toolExecutionLedger: [], trajectory: [], progress: { completedNodes: [] },
  };
  const session = { withTransaction: async callback => callback(), endSession: async () => {} };
  const worker = createPlanReviewWorker({
    worker: run.workerId,
    model: {
      findOne() { const query = { session() { return query; }, lean: async () => run }; return query; },
      async updateOne(_filter, update) { Object.assign(run, update.$set); return { modifiedCount: 1 }; },
    },
    checkpointModel: { async findOneAndUpdate() { return {}; } },
    mongo: { startSession: async () => session },
    eventModel: { async create() { throw Object.assign(new Error('injected tool event failure'), { code: 'EVENT_STORE_UNAVAILABLE' }); } },
  });
  let toolInvoked = false;
  await assert.rejects(executeSafeToolsNode({
    userId, profileId: '64b000000000000000000011', requestedChecks: ['get_current_profile_context'],
    toolCallCount: 0, toolCallCounts: {}, toolResults: {},
  }, {
    onNodeProgress: payload => worker.updateProgress(run, payload),
    toolOverrides: { get_current_profile_context: async () => { toolInvoked = true; return { status: 'AVAILABLE' }; } },
  }), { code: 'EVENT_STORE_UNAVAILABLE' });
  assert.equal(toolInvoked, false);
  assert.equal(run.toolExecutionLedger.length, 1, 'checkpointed ledger remains an incomplete fail-closed record');
});

test('50 workers use explicit numeric queue priority and exactly one claims one queued run', async () => {
  let claimed = false;
  let observedSort;
  const model = {
    async findOneAndUpdate(_filter, _update, options) {
      observedSort = options.sort;
      if (claimed) return null;
      claimed = true;
      return { runId: 'run-fifty-way-claim', attempt: 1, executionGeneration: 1 };
    },
  };
  const claims = await Promise.all(Array.from({ length: 50 }, (_, index) => claimNextPlanReviewRun({ model, worker: `worker-${index}` })));
  assert.equal(claims.filter(Boolean).length, 1);
  assert.deepEqual(observedSort, { priorityRank: 1, queuedAt: 1 });
  assert.equal(PLAN_REVIEW_PRIORITY_RANK.INTERACTIVE_PLAN_REVIEW, 0);
});

test('concurrent checkpoint writers serialize sequence allocation and store only tool payload hashes', async () => {
  const toolCallId = 'a3950c0b-0ed9-44ed-b20b-89998027de40';
  const capability = {
    capabilityId: 'plan-review.get_current_profile_context.read.v1',
    capabilityVersion: '1.0.0',
    effect: 'READ',
    resourceScope: 'CURRENT_USER_PROFILE',
    ownerScoped: true,
    writesFinancialAuthority: false,
    networkAccess: 'NONE',
    shadowAllowed: true,
  };
  const toolInputHash = 'a'.repeat(64);
  const run = {
    runId: 'run-checkpoint-sequence',
    userId,
    profileId: '64b000000000000000000051',
    workerId: 'worker-sequence',
    executionGeneration: 4,
    status: 'RUNNING',
    leaseUntil: new Date(Date.now() + 60000),
    checkpointSequence: 0,
    progress: { completedNodes: [] },
    toolExecutionLedger: [],
  };
  let transactionQueue = Promise.resolve();
  const checkpoints = new Map();
  const model = {
    findOne(filter) {
      const matches = run.runId === filter.runId && run.workerId === filter.workerId
        && run.executionGeneration === filter.executionGeneration && run.status === filter.status
        && run.leaseUntil > (filter.leaseUntil?.$gt || new Date(0));
      return lean(matches ? { ...run, progress: { ...run.progress }, toolExecutionLedger: [...run.toolExecutionLedger] } : null);
    },
    async updateOne(filter, update) {
      const checkpointFence = filter.checkpointSequence ?? (filter.$or?.some(item => Object.hasOwn(item, 'checkpointSequence')) ? 0 : null);
      const eventFence = filter.eventSequence ?? (filter.$or?.some(item => Object.hasOwn(item, 'eventSequence')) ? 0 : null);
      if (checkpointFence !== null && Number(run.checkpointSequence || 0) !== checkpointFence) return { modifiedCount: 0 };
      if (eventFence !== null && Number(run.eventSequence || 0) !== eventFence) return { modifiedCount: 0 };
      if (filter.leaseUntil?.$gt && !(run.leaseUntil > filter.leaseUntil.$gt)) return { modifiedCount: 0 };
      Object.assign(run, update.$set);
      return { modifiedCount: 1 };
    },
  };
  const checkpointModel = {
    async findOneAndUpdate(filter, update) {
      checkpoints.set(filter.sequence, { ...update.$setOnInsert, ...update.$set });
      return checkpoints.get(filter.sequence);
    },
  };
  const durableEvents = [];
  const eventModel = {
    findOne() {
      const query = {
        sort() { return query; },
        lean: async () => [...durableEvents].sort((left, right) => right.sequence - left.sequence)[0] || null,
      };
      return query;
    },
    async create(rows) { durableEvents.push(...rows); },
  };
  const mongo = {
    async startSession() {
      return {
        async withTransaction(callback) {
          const previous = transactionQueue;
          let release;
          transactionQueue = new Promise(resolve => { release = resolve; });
          await previous;
          try { return await callback(); } finally { release(); }
        },
        async endSession() {},
      };
    },
  };
  const worker = createPlanReviewWorker({ model, checkpointModel, eventModel, mongo, worker: run.workerId, runtimeConfig: { agentPlanReview: { leaseMs: 60000 } } });

  await Promise.all([
    worker.updateProgress(run, { node: 'load_context', state: {}, event: { type: 'NODE_ENTERED' } }),
    worker.updateProgress(run, {
      node: 'execute_safe_tools',
      state: {},
      event: { type: 'TOOL_SELECTED', tool: 'get_current_profile_context', toolCallId, ...capability, inputHash: toolInputHash, startedAt: new Date().toISOString() },
    }),
    worker.updateProgress(run, {
      node: 'execute_safe_tools',
      state: {},
      event: { type: 'TOOL_SUCCEEDED', tool: 'get_current_profile_context', toolCallId, ...capability, inputHash: toolInputHash, input: { limit: 1 }, output: { status: 'AVAILABLE' } },
    }),
  ]);

  assert.equal(run.checkpointSequence, 3);
  assert.deepEqual([...checkpoints.keys()].sort(), [1, 2, 3]);
  const ledger = run.toolExecutionLedger.find(item => item.tool === 'get_current_profile_context' && item.stage === 'SUCCEEDED');
  assert.match(ledger.inputHash, /^[a-f0-9]{64}$/);
  assert.match(ledger.outputHash, /^[a-f0-9]{64}$/);
  const selection = run.toolExecutionLedger.find(item => item.tool === 'get_current_profile_context' && item.stage === 'SELECTED');
  assert.match(selection.inputHash, /^[a-f0-9]{64}$/);
  assert.equal(selection.outputHash, null);
  assert.equal(selection.completedAt, null);
  assert.equal(selection.toolCallId, toolCallId);
  assert.equal(ledger.toolCallId, toolCallId);
  assert.equal(durableEvents.length, 3);
  assert.equal(selection.capabilityId, capability.capabilityId);
  assert.equal(ledger.capabilityId, capability.capabilityId);
  assert.equal(selection.capabilityEffect, 'READ');
  assert.equal(ledger.capabilityEffect, 'READ');
  assert.equal(selection.ownerScoped, true);
  assert.equal(ledger.writesFinancialAuthority, false);
  const trajectorySelection = run.trajectory.find(item => item.type === 'TOOL_SELECTED');
  const trajectoryResult = run.trajectory.find(item => item.type === 'TOOL_SUCCEEDED');
  assert.equal(trajectorySelection.toolCallId, toolCallId);
  assert.equal(trajectoryResult.toolCallId, toolCallId);
  assert.equal(trajectorySelection.capabilityId, capability.capabilityId);
  assert.equal(trajectoryResult.capabilityId, capability.capabilityId);
  assert.equal(trajectorySelection.attempted, false);
  assert.equal(trajectoryResult.attempted, true);
  assert.equal('input' in ledger, false);
  assert.equal('output' in ledger, false);
});

test('fencing rejects a stale worker terminal write', async () => {
  const model = {
    // The owner/generation-qualified lease lookup must not return another
    // worker's row; a stale worker fails before attempting publication.
    findOne: () => lean(null),
    updateOne: async () => ({ modifiedCount: 0 }),
  };
  const worker = createPlanReviewWorker({ model, worker: 'worker-a', runtimeConfig: { agentPlanReview: { leaseMs: 60000, heartbeatMs: 15000 } } });
  await assert.rejects(
    worker.finishRun({ runId: 'run-fenced', workerId: 'worker-a', executionGeneration: 1 }, { recommendedAction: 'NONE' }),
    error => error.code === 'AGENT_LEASE_LOST',
  );
});

test('durable provider-budget reservations survive process-equivalent recovery before the next checkpoint', async () => {
  const profileId = '64b000000000000000000041';
  const binding = buildPlanReviewSnapshotBinding({ userId, profileId, currentState: { profileVersion: 1 }, freshness: { fresh: false, reasonCodes: ['RECOMMENDATION_MISSING'] } });
  const snapshotHash = hashPlanReviewSnapshot(binding);
  const run = {
    runId: 'run-budget-reservation', userId, profileId, status: 'QUEUED', attempt: 0, executionGeneration: 0,
    maxAttempts: 2, queuedAt: new Date(0), priority: 'INTERACTIVE_PLAN_REVIEW', modelCallCount: 0, tokenUsage: 0,
  };
  const model = {
    findOne(filter) {
      if (filter.status === 'QUEUED') return { sort() { return this; }, lean: async () => null };
      return { lean: async () => (filter.runId === run.runId && filter.workerId === run.workerId ? run : null) };
    },
    async findOneAndUpdate(_filter, update) {
      Object.assign(run, update.$set);
      for (const [key, amount] of Object.entries(update.$inc || {})) run[key] = Number(run[key] || 0) + amount;
      return run;
    },
    async updateOne(filter, update) {
      if (filter.runId !== run.runId || filter.workerId !== run.workerId || filter.executionGeneration !== run.executionGeneration || filter.status !== run.status) return { modifiedCount: 0 };
      for (const [key, amount] of Object.entries(update.$max || {})) run[key] = Math.max(Number(run[key] || 0), amount);
      Object.assign(run, update.$set || {});
      for (const key of Object.keys(update.$unset || {})) delete run[key];
      return { modifiedCount: 1 };
    },
  };
  const worker = createPlanReviewWorker({
    model,
    checkpointModel: noCheckpointRetention,
    graphCheckpointModel: noCheckpointRetention,
    mongo: { startSession: async () => ({ withTransaction: async callback => callback(), endSession: async () => {} }) },
    worker: 'worker-budget-test',
    runtimeConfig: { agentPlanReview: { leaseMs: 60000, heartbeatMs: 60000 } },
    runPlanReviewImpl: async ({ dependencies }) => {
      await dependencies.onModelBudgetReservation({ modelCallCount: 1, tokenUsage: 240 });
      const error = new Error('deterministic budget stop after reservation');
      error.code = 'AGENT_BUDGET_EXCEEDED';
      throw error;
    },
  });
  await worker.processNext();
  assert.equal(run.status, 'BUDGET_EXCEEDED');
  assert.equal(run.modelCallCount, 1);
  assert.equal(run.tokenUsage, 240);

  const checkpointPayload = {
    schemaVersion: 'plan-review-replay-checkpoint-1.0.0',
    runId: run.runId,
    planReviewSnapshotHash: snapshotHash,
    sourceBinding: binding,
    counters: { stepCount: 2, toolCallCount: 1, modelCallCount: 0, tokenUsage: 0, toolCallCounts: {} },
  };
  const checkpoint = { ...checkpointPayload, checkpointHash: canonicalSha256(checkpointPayload) };
  const reconciled = reconcilePlanReviewReplayCheckpoint({
    ...run,
    status: 'RUNNING',
    leaseUntil: new Date(Date.now() + 60000),
    planReviewSnapshotHash: snapshotHash,
    sourceBinding: binding,
    checkpoint: { state: checkpoint },
  });
  assert.equal(reconciled.counters.modelCallCount, 1);
  assert.equal(reconciled.counters.tokenUsage, 240);
  assert.equal(canonicalSha256({
    schemaVersion: reconciled.schemaVersion,
    runId: reconciled.runId,
    planReviewSnapshotHash: reconciled.planReviewSnapshotHash,
    sourceBinding: reconciled.sourceBinding,
    counters: reconciled.counters,
  }), reconciled.checkpointHash);
});

test('failed-run usage reconciliation cannot reduce already durable provider-budget reservations', async () => {
  const run = {
    runId: 'run-budget-monotonic',
    workerId: 'worker-budget-test',
    executionGeneration: 3,
    status: 'RUNNING',
    leaseUntil: new Date(Date.now() + 60000),
    attempt: 1,
    maxAttempts: 2,
    modelCallCount: 2,
    tokenUsage: 640,
  };
  const model = {
    findOne: () => lean(run),
    async updateOne(filter, update) {
      assert.equal(filter.runId, run.runId);
      assert.equal(filter.workerId, run.workerId);
      assert.equal(filter.executionGeneration, run.executionGeneration);
      assert.equal(filter.status, 'RUNNING');
      assert.ok(filter.leaseUntil.$gt instanceof Date);
      for (const [key, amount] of Object.entries(update.$max || {})) {
        run[key] = Math.max(Number(run[key] || 0), amount);
      }
      Object.assign(run, update.$set || {});
      return { modifiedCount: 1 };
    },
  };
  const worker = createPlanReviewWorker({
    model,
    mongo: { startSession: async () => ({ withTransaction: async callback => callback(), endSession: async () => {} }) },
    worker: run.workerId,
    runtimeConfig: { agentPlanReview: { leaseMs: 60000, heartbeatMs: 60000 } },
  });
  const error = new Error('provider returned partial usage after reservation');
  error.retryable = true;
  error.planReviewUsage = { modelCallCount: 1, tokenUsage: 240 };

  await worker.failRun(run, error);

  assert.equal(run.modelCallCount, 2);
  assert.equal(run.tokenUsage, 640);
  assert.equal(run.status, 'QUEUED');
});

test('retryable failure on the final permitted attempt terminalizes and dead-letters exactly once', async () => {
  const run = {
    runId: 'run-final-retryable-attempt', userId, workerId: 'worker-final-retry', executionGeneration: 5,
    status: 'RUNNING', leaseUntil: new Date(Date.now() + 60000), attempt: 2, maxAttempts: 2,
    activeDedupeKey: 'owned-active-run', eventSequence: 0,
  };
  const events = [];
  const session = { withTransaction: async callback => callback(), endSession: async () => {} };
  const model = {
    findOne() {
      const query = { session() { return query; }, lean: async () => ({ ...run }) };
      return query;
    },
    async updateOne(_filter, update, options) {
      assert.equal(options.session, session);
      Object.assign(run, update.$set || {});
      for (const key of Object.keys(update.$unset || {})) delete run[key];
      for (const [key, amount] of Object.entries(update.$inc || {})) run[key] = Number(run[key] || 0) + amount;
      return { modifiedCount: 1 };
    },
  };
  const worker = createPlanReviewWorker({
    model,
    checkpointModel: noCheckpointRetention,
    graphCheckpointModel: noCheckpointRetention,
    eventModel: { async create(rows) { events.push(...rows); } },
    mongo: { startSession: async () => session },
    worker: run.workerId,
  });
  const retryableError = Object.assign(new Error('provider unavailable on final attempt'), { retryable: true });

  await worker.failRun(run, retryableError);

  assert.equal(run.status, 'FAILED');
  assert.equal(run.retryAt, null);
  assert.equal(run.leaseUntil, null);
  assert.ok(run.completedAt instanceof Date);
  assert.equal(run.activeDedupeKey, undefined);
  assert.equal(run.deadLetter.attempt, 2);
  assert.equal(run.deadLetter.executionGeneration, 5);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'RUN_FAILED');
  assert.equal(events[0].sequence, 1);
});

test('non-retryable runtime corruption dead-letters on attempt one with bounded operational lineage', async () => {
  const run = {
    runId: 'run-terminal-config-error', userId, workerId: 'worker-terminal', executionGeneration: 7,
    status: 'RUNNING', leaseUntil: new Date(Date.now() + 60000), attempt: 1, maxAttempts: 2,
    eventSequence: 2, currentNode: 'validate_evidence', traceId: 'trace-id', correlationId: 'correlation-id',
  };
  let inTransaction = false;
  const session = {
    async withTransaction(callback) { inTransaction = true; try { await callback(); } finally { inTransaction = false; } },
    async endSession() {},
  };
  const events = [];
  const model = {
    findOne() {
      const query = { session() { return query; }, lean: async () => ({ ...run }) };
      return query;
    },
    async updateOne(_filter, update, options) {
      assert.equal(inTransaction, true);
      assert.equal(options.session, session);
      Object.assign(run, update.$set || {});
      for (const [key, amount] of Object.entries(update.$inc || {})) run[key] = Number(run[key] || 0) + amount;
      for (const key of Object.keys(update.$unset || {})) delete run[key];
      return { modifiedCount: 1 };
    },
  };
  const worker = createPlanReviewWorker({
    model,
    checkpointModel: noCheckpointRetention,
    graphCheckpointModel: noCheckpointRetention,
    worker: run.workerId,
    mongo: { startSession: async () => session },
    eventModel: { async create(rows, options) { assert.equal(inTransaction, true); assert.equal(options.session, session); events.push(...rows); } },
  });
  const before = PrometheusMetrics.getSnapshotJSON().agent_dead_letter.INTERNAL_RUNTIME_FAILURE;
  const error = Object.assign(new Error('unsafe raw detail must not be persisted'), { code: 'PLAN_REVIEW_SOURCE_BINDING_INVALID' });
  const result = await worker.failRun(run, error);
  assert.equal(result.status, 'FAILED');
  assert.deepEqual(run.deadLetter, {
    code: 'INTERNAL_RUNTIME_FAILURE', attempt: 1, executionGeneration: 7,
    lastNode: 'validate_evidence', traceId: 'trace-id', correlationId: 'correlation-id',
    at: run.deadLetter.at,
  });
  assert.ok(run.deadLetter.at instanceof Date);
  assert.equal(events[0].eventType, 'RUN_FAILED');
  assert.equal(events[0].sequence, 3);
  assert.equal(JSON.stringify(run.deadLetter).includes('unsafe raw detail'), false);
  assert.equal(PrometheusMetrics.getSnapshotJSON().agent_dead_letter.INTERNAL_RUNTIME_FAILURE, before + 1);
});

test('terminal failure event insertion failure aborts the run transition', async () => {
  let durable = {
    runId: 'run-event-rollback', userId, workerId: 'worker-rollback', executionGeneration: 2,
    status: 'RUNNING', leaseUntil: new Date(Date.now() + 60000), attempt: 1, maxAttempts: 2, eventSequence: 0,
  };
  const session = {
    async withTransaction(callback) {
      const before = structuredClone(durable);
      try { await callback(); } catch (error) { durable = before; throw error; }
    },
    async endSession() {},
  };
  const model = {
    findOne() { const query = { session() { return query; }, lean: async () => structuredClone(durable) }; return query; },
    async updateOne(_filter, update) {
      Object.assign(durable, update.$set || {});
      for (const [key, amount] of Object.entries(update.$inc || {})) durable[key] = Number(durable[key] || 0) + amount;
      for (const key of Object.keys(update.$unset || {})) delete durable[key];
      return { modifiedCount: 1 };
    },
  };
  const worker = createPlanReviewWorker({
    model,
    checkpointModel: noCheckpointRetention,
    graphCheckpointModel: noCheckpointRetention,
    worker: durable.workerId,
    mongo: { startSession: async () => session },
    eventModel: { async create() { throw Object.assign(new Error('event store failed'), { code: 'EVENT_STORE_UNAVAILABLE' }); } },
  });
  await assert.rejects(worker.failRun(durable, Object.assign(new Error('invalid deterministic state'), { code: 'PLAN_REVIEW_SOURCE_BINDING_INVALID' })), { code: 'EVENT_STORE_UNAVAILABLE' });
  assert.equal(durable.status, 'RUNNING');
  assert.equal(durable.eventSequence, 0);
  assert.equal(durable.deadLetter, undefined);
});

test('heartbeat persistence failure fences and aborts active provider execution', async () => {
  const timers = [];
  const controller = new AbortController();
  const before = PrometheusMetrics.counters.agent_worker_heartbeat_failures_total;
  const worker = createPlanReviewWorker({
    model: { async updateOne() { throw Object.assign(new Error('db unavailable'), { code: 'MONGO_UNAVAILABLE' }); } },
    worker: 'worker-heartbeat-failure',
    runtimeConfig: { agentPlanReview: { leaseMs: 60000, heartbeatMs: 1000 } },
    setIntervalImpl(callback) { const timer = { callback }; timers.push(timer); return timer; },
    clearIntervalImpl() {},
  });
  worker.activeRun = { runId: 'run-heartbeat-failure', executionGeneration: 9 };
  worker.activeAbortController = controller;
  worker.startHeartbeat();
  timers[0].callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.leaseLost, true);
  assert.equal(controller.signal.aborted, true);
  assert.equal(PrometheusMetrics.counters.agent_worker_heartbeat_failures_total, before + 1);
  worker.stopHeartbeat();
});

test('an older delayed worker heartbeat cannot shorten a newer lease renewal', async () => {
  const originalDateNow = Date.now;
  let clock = originalDateNow();
  const run = {
    runId: 'run-monotonic-heartbeat',
    workerId: 'worker-heartbeat-order',
    executionGeneration: 4,
    status: 'RUNNING',
    cancellationRequested: false,
    leaseUntil: new Date(clock + 30000),
  };
  const pending = [];
  const model = {
    updateOne(_filter, update) {
      return new Promise(resolve => pending.push({ update, resolve }));
    },
  };
  const worker = createPlanReviewWorker({
    model,
    worker: run.workerId,
    runtimeConfig: { agentPlanReview: { leaseMs: 60000, heartbeatMs: 1000 } },
  });
  worker.activeRun = run;

  const apply = write => {
    const { update, resolve } = write;
    let modified = false;
    Object.assign(run, update.$set || {});
    for (const [key, value] of Object.entries(update.$max || {})) {
      if (run[key] === undefined || run[key] === null || value > run[key]) {
        run[key] = value;
        modified = true;
      }
    }
    write.modified = modified;
    resolve({ matchedCount: 1, modifiedCount: modified ? 1 : 0 });
  };

  Date.now = () => clock;
  try {
    const earlierHeartbeat = worker.heartbeat();
    clock += 1000;
    const laterHeartbeat = worker.heartbeat();
    assert.equal(pending.length, 2);

    apply(pending[1]);
    assert.equal(await laterHeartbeat, true);
    const laterLeaseUntil = run.leaseUntil;

    apply(pending[0]);
    assert.equal(await earlierHeartbeat, true);
    assert.equal(run.leaseUntil.getTime(), laterLeaseUntil.getTime());
    assert.equal(pending[0].modified, false, 'Mongo may match the current lease while the monotonic $max is a no-op');
    assert.equal(pending[0].update.$max.leaseUntil.getTime() < laterLeaseUntil.getTime(), true);
  } finally {
    Date.now = originalDateNow;
  }
});

test('worker shutdown aborts a provider that ignores cancellation and returns at its deadline', async () => {
  const timers = [];
  const worker = createPlanReviewWorker({
    model: {},
    worker: 'worker-stuck-provider',
    setTimeoutImpl(callback) { timers.push(callback); return {}; },
    clearTimeoutImpl() {},
  });
  worker.activeAbortController = new AbortController();
  const signal = worker.activeAbortController.signal;
  worker.activePromise = new Promise(() => {});
  const stopping = worker.stop({ graceMs: 20000 });
  assert.equal(timers.length, 1);
  timers[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signal.aborted, true);
  assert.equal(timers.length, 2, 'abort drain is bounded independently by the same configured grace cap');
  timers[1]();
  assert.deepEqual(await stopping, { drained: false });
});

test('worker publication fences the exact profile and recommendation pointer in one transaction', async () => {
  const profileId = '64b000000000000000000011';
  const pointer = {
    _id: '64b000000000000000000012',
    userId,
    profileId,
    currentRecommendationId: '64b000000000000000000013',
    currentAllocationRevision: 2,
    currentAllocationRevisionId: '64b000000000000000000014',
    generationRevision: 3,
    profileInputHash: 'a'.repeat(64),
    profileVersion: 5,
    portfolioFingerprint: 'b'.repeat(64),
    returnAssumptionVersion: 'assumption-1',
    returnAssumptionHash: 'c'.repeat(64),
    returnAssumptionSource: 'WEALTHGENIE_MODEL_POLICY',
  };
  const sourceBinding = buildPlanReviewSnapshotBinding({
    userId,
    profileId,
    financialProfileStateRevision: 1,
    currentState: {
      financialProfileStateRevision: 1,
      profileVersion: 5,
      recommendation: { _id: pointer.currentRecommendationId, recommendationGeneration: 3, profileInputHash: pointer.profileInputHash },
      allocationRevision: { _id: pointer.currentAllocationRevisionId, revision: 2 },
      statePointer: pointer,
      portfolioFingerprint: pointer.portfolioFingerprint,
      provenance: { status: 'PERSISTED_REVISION' },
    },
    freshness: { fresh: true, reasonCodes: [] },
  });
  const sourceHash = hashPlanReviewSnapshot(sourceBinding);
  const run = {
    runId: 'run-publication-fence', userId, profileId, workerId: 'worker-a', executionGeneration: 1,
    status: 'RUNNING', leaseUntil: new Date(Date.now() + 60000), sourceBinding, planReviewSnapshotHash: sourceHash,
    checkpointSequence: 0,
  };
  const writes = [];
  const session = { withTransaction: async callback => callback(), endSession: async () => {} };
  const model = {
    findOne: () => lean(run),
    async updateOne(filter, update, options) { writes.push({ model: 'run', filter, update, options }); return { modifiedCount: 1 }; },
  };
  const profileModel = {
    async updateOne(filter, update, options) { writes.push({ model: 'profile', filter, update, options }); return { modifiedCount: 1 }; },
  };
  const stateModel = {
    async updateOne(filter, update, options) { writes.push({ model: 'state', filter, update, options }); return { modifiedCount: 1 }; },
  };
  const worker = createPlanReviewWorker({
    model,
    checkpointModel: noCheckpointRetention,
    graphCheckpointModel: noCheckpointRetention,
    profileModel,
    profileStateModel: profileStateModelFixture({
      profileId,
      revision: 1,
      onWrite: (filter, update, options) => writes.push({ model: 'profileState', filter, update, options }),
    }),
    stateModel,
    mongo: { startSession: async () => session },
    snapshotResolver: async () => ({ sourceBinding, planReviewSnapshotHash: sourceHash, currentState: { statePointer: pointer } }),
    worker: 'worker-a',
  });
  await worker.finishRun(run, { recommendedAction: 'NONE', findings: [], evidence: { entries: [] }, execution: { stepCount: 2, toolCallCount: 1, modelCallCount: 0 } });
  assert.deepEqual(writes.map(item => item.model), ['profile', 'profileState', 'state', 'run']);
  assert.ok(writes.every(item => item.options?.session === session));
  assert.equal(writes[0].update.$inc.planReviewPublicationFence, 1);
  assert.equal(writes[1].filter.currentProfileId, profileId);
  assert.equal(writes[1].filter.revision, 1);
  assert.equal(writes[2].filter.currentAllocationRevisionId, pointer.currentAllocationRevisionId);
  assert.equal(writes[3].filter.planReviewSnapshotHash, sourceHash);
});

test('RUN_COMPLETED and success metrics are written only with the durable terminal CAS', async () => {
  const profileId = '64b000000000000000000031';
  const binding = buildPlanReviewSnapshotBinding({ userId, profileId, financialProfileStateRevision: 1, currentState: { profileVersion: 1 }, freshness: { fresh: false, reasonCodes: ['RECOMMENDATION_MISSING'] } });
  const hash = hashPlanReviewSnapshot(binding);
  const run = {
    runId: 'run-terminal-event', userId, profileId, workerId: 'worker-a', executionGeneration: 1,
    status: 'RUNNING', leaseUntil: new Date(Date.now() + 60000), sourceBinding: binding, planReviewSnapshotHash: hash,
    eventSequence: 0, trajectory: [],
  };
  const events = [];
  let insideTransaction = false;
  const session = {
    async withTransaction(callback) {
      insideTransaction = true;
      await callback();
      insideTransaction = false;
    },
    async endSession() {},
  };
  const model = {
    findOne(filter) { return lean(!filter.status || run.status === filter.status ? run : null); },
    async updateOne(filter, update, options) {
      if (run.status !== filter.status || options.session !== session) return { modifiedCount: 0 };
      Object.assign(run, update.$set || {});
      for (const [key, amount] of Object.entries(update.$inc || {})) run[key] = Number(run[key] || 0) + amount;
      if (update.$push?.trajectory?.$each) run.trajectory.push(...update.$push.trajectory.$each);
      return { modifiedCount: 1 };
    },
  };
  const worker = createPlanReviewWorker({
    model,
    checkpointModel: noCheckpointRetention,
    graphCheckpointModel: noCheckpointRetention,
    profileModel: { updateOne: async () => ({ modifiedCount: 1 }) },
    profileStateModel: profileStateModelFixture({ profileId, revision: 1 }),
    stateModel: { updateOne: async () => ({ modifiedCount: 1 }) },
    eventModel: { async create(rows, options) { assert.equal(insideTransaction, true); assert.equal(options.session, session); events.push(...rows); } },
    mongo: { startSession: async () => session },
    snapshotResolver: async () => ({ sourceBinding: binding, planReviewSnapshotHash: hash, currentState: {} }),
    worker: 'worker-a',
  });
  const beforeCompleted = PrometheusMetrics.counters.agent_runs_completed_total;
  const result = await worker.finishRun(run, {
    recommendedAction: 'NONE', findings: [], evidence: { entries: [] },
    execution: { stepCount: 5, toolCallCount: 0, modelCallCount: 0, tokenUsage: 0 },
  });

  assert.deepEqual(result, { committed: true, status: 'COMPLETED', runId: run.runId });
  assert.equal(run.status, 'COMPLETED');
  assert.equal(run.eventSequence, 1);
  assert.equal(run.trajectory.at(-1).type, 'RUN_COMPLETED');
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'RUN_COMPLETED');
  assert.equal(events[0].sequence, 1);
  assert.equal(PrometheusMetrics.counters.agent_runs_completed_total, beforeCompleted + 1);
  await assert.rejects(worker.finishRun(run, { recommendedAction: 'NONE' }), error => error.code === 'AGENT_LEASE_LOST');
  assert.equal(events.length, 1, 'replay after terminalization cannot emit another completion event');
});

test('cancellation winning immediately before worker terminal CAS suppresses success metrics and event', async () => {
  const profileId = '64b000000000000000000032';
  const binding = buildPlanReviewSnapshotBinding({ userId, profileId, currentState: { profileVersion: 1 }, freshness: { fresh: false, reasonCodes: ['RECOMMENDATION_MISSING'] } });
  const hash = hashPlanReviewSnapshot(binding);
  const run = {
    runId: 'run-cancel-wins-finalization', userId, profileId, status: 'QUEUED', queuedAt: new Date(0),
    priority: 'INTERACTIVE_PLAN_REVIEW', attempt: 0, executionGeneration: 0, maxAttempts: 2,
    sourceBinding: binding, planReviewSnapshotHash: hash,
  };
  const events = [];
  const session = { withTransaction: async callback => callback(), endSession: async () => {} };
  const model = {
    findOne(filter) {
      const matches = (!filter.status || filter.status === run.status)
        && (!filter.runId || filter.runId === run.runId)
        && (!filter.workerId || filter.workerId === run.workerId)
        && (!filter.executionGeneration || filter.executionGeneration === run.executionGeneration);
      return { sort() { return this; }, lean: async () => matches ? run : null };
    },
    async findOneAndUpdate(_filter, update) {
      Object.assign(run, update.$set || {});
      for (const [key, amount] of Object.entries(update.$inc || {})) run[key] = Number(run[key] || 0) + amount;
      return run;
    },
    async updateOne(filter, update) {
      if (filter.status !== run.status) return { modifiedCount: 0 };
      if (filter.status === 'RUNNING' && run.status === 'CANCELLED') return { modifiedCount: 0 };
      Object.assign(run, update.$set || {});
      return { modifiedCount: 1 };
    },
  };
  const beforeJobs = PrometheusMetrics.counters.agent_worker_jobs_completed_total;
  const beforeQueue = PrometheusMetrics.counters.agent_queue_runs_completed_total;
  const worker = createPlanReviewWorker({
    model,
    checkpointModel: noCheckpointRetention,
    graphCheckpointModel: noCheckpointRetention,
    worker: 'worker-cancel-test',
    runtimeConfig: { agentPlanReview: { leaseMs: 60000, heartbeatMs: 60000 } },
    profileModel: {
      async updateOne() {
        run.status = 'CANCELLED';
        return { modifiedCount: 1 };
      },
    },
    stateModel: { updateOne: async () => ({ modifiedCount: 1 }) },
    eventModel: { async create(rows) { events.push(...rows); } },
    mongo: { startSession: async () => session },
    snapshotResolver: async () => ({ sourceBinding: binding, planReviewSnapshotHash: hash, currentState: {} }),
    runPlanReviewImpl: async ({ dependencies }) => {
      assert.ok(dependencies.signal instanceof AbortSignal);
      return { recommendedAction: 'NONE', findings: [], evidence: { entries: [] }, execution: { stepCount: 5, toolCallCount: 0, modelCallCount: 0, tokenUsage: 0 } };
    },
  });

  await worker.processNext();
  assert.equal(run.status, 'CANCELLED');
  assert.equal(PrometheusMetrics.counters.agent_worker_jobs_completed_total, beforeJobs);
  assert.equal(PrometheusMetrics.counters.agent_queue_runs_completed_total, beforeQueue);
  assert.equal(events.filter(event => event.eventType === 'RUN_COMPLETED').length, 0);
});

test('source supersession winning before terminal publication is counted as superseded, never successful or failed', async () => {
  const profileId = '64b000000000000000000034';
  const binding = buildPlanReviewSnapshotBinding({ userId, profileId, currentState: { profileVersion: 1 }, freshness: { fresh: false, reasonCodes: ['RECOMMENDATION_MISSING'] } });
  const hash = hashPlanReviewSnapshot(binding);
  const supersedingBinding = { ...binding, profileVersion: 2 };
  const run = {
    runId: 'run-supersede-wins-finalization', userId, profileId, status: 'QUEUED', queuedAt: new Date(0),
    priority: 'INTERACTIVE_PLAN_REVIEW', attempt: 0, executionGeneration: 0, maxAttempts: 2,
    activeDedupeKey: 'active-snapshot-key', sourceBinding: binding, planReviewSnapshotHash: hash,
  };
  const events = [];
  const session = { withTransaction: async callback => callback(), endSession: async () => {} };
  const model = {
    findOne(filter) {
      const matches = (!filter.status || filter.status === run.status)
        && (!filter.runId || filter.runId === run.runId)
        && (!filter.workerId || filter.workerId === run.workerId)
        && (!filter.executionGeneration || filter.executionGeneration === run.executionGeneration);
      return { sort() { return this; }, lean: async () => matches ? run : null };
    },
    findOneAndUpdate(_filter, update) {
      Object.assign(run, update.$set || {});
      for (const [key, amount] of Object.entries(update.$inc || {})) run[key] = Number(run[key] || 0) + amount;
      return { lean: async () => ({ ...run }) };
    },
    async updateOne(filter, update) {
      if (filter.status !== run.status || filter.runId !== run.runId) return { modifiedCount: 0 };
      Object.assign(run, update.$set || {});
      for (const key of Object.keys(update.$unset || {})) delete run[key];
      return { modifiedCount: 1 };
    },
  };
  const beforeCompleted = PrometheusMetrics.counters.agent_worker_jobs_completed_total;
  const beforeFailed = PrometheusMetrics.counters.agent_worker_jobs_failed_total;
  const beforeSuperseded = PrometheusMetrics.counters.agent_worker_jobs_superseded_total;
  const worker = createPlanReviewWorker({
    model,
    worker: 'worker-supersede-test',
    checkpointModel: noCheckpointRetention,
    graphCheckpointModel: noCheckpointRetention,
    runtimeConfig: { agentPlanReview: { leaseMs: 60000, heartbeatMs: 60000 } },
    profileModel: { updateOne: async () => ({ modifiedCount: 1 }) },
    stateModel: { updateOne: async () => ({ modifiedCount: 1 }) },
    eventModel: { async create(rows) { events.push(...(Array.isArray(rows) ? rows : [rows])); } },
    mongo: { startSession: async () => session },
    snapshotResolver: async () => ({
      sourceBinding: supersedingBinding,
      planReviewSnapshotHash: hashPlanReviewSnapshot(supersedingBinding),
      currentState: {},
    }),
    runPlanReviewImpl: async () => ({
      recommendedAction: 'NONE', findings: [], evidence: { entries: [] },
      execution: { stepCount: 4, toolCallCount: 0, modelCallCount: 0, tokenUsage: 0 },
    }),
  });

  await worker.processNext();

  assert.equal(run.status, 'SUPERSEDED');
  assert.equal(run.activeDedupeKey, undefined);
  assert.equal(run.deadLetter, null, 'supersession is not a failed/dead-letter job');
  assert.equal(PrometheusMetrics.counters.agent_worker_jobs_completed_total, beforeCompleted);
  assert.equal(PrometheusMetrics.counters.agent_worker_jobs_failed_total, beforeFailed);
  assert.equal(PrometheusMetrics.counters.agent_worker_jobs_superseded_total, beforeSuperseded + 1);
  assert.equal(events.filter(event => event.eventType === 'RUN_COMPLETED').length, 0);
  assert.ok(events.some(event => event.eventType === 'RUN_SUPERSEDED'));
});

test('worker refuses to publish a review after its bound source snapshot is superseded', async () => {
  const profileId = '64b000000000000000000021';
  const binding = buildPlanReviewSnapshotBinding({ userId, profileId, currentState: { profileVersion: 1 }, freshness: { fresh: false, reasonCodes: ['RECOMMENDATION_MISSING'] } });
  const hash = hashPlanReviewSnapshot(binding);
  const run = { runId: 'run-superseded', userId, profileId, workerId: 'worker-a', executionGeneration: 1, status: 'RUNNING', leaseUntil: new Date(Date.now() + 60000), sourceBinding: binding, planReviewSnapshotHash: hash };
  let runUpdate = false;
  const session = { withTransaction: async callback => callback(), endSession: async () => {} };
  const worker = createPlanReviewWorker({
    model: { findOne: () => lean(run), updateOne: async () => { runUpdate = true; return { modifiedCount: 1 }; } },
    profileModel: { updateOne: async () => ({ modifiedCount: 1 }) },
    stateModel: { updateOne: async () => ({ modifiedCount: 1 }) },
    mongo: { startSession: async () => session },
    snapshotResolver: async () => ({ sourceBinding: { ...binding, profileVersion: 2 }, planReviewSnapshotHash: 'd'.repeat(64), currentState: {} }),
    worker: 'worker-a',
  });
  await assert.rejects(worker.finishRun(run, { recommendedAction: 'NONE' }), error => error.code === 'PLAN_REVIEW_SOURCE_SUPERSEDED');
  assert.equal(runUpdate, false);
});

test('expired runs at the retry ceiling are terminally recovered and not reclaimed', async () => {
  let update = null;
  const candidate = {
    _id: '64b000000000000000000099',
    runId: 'run-expired-max-attempts',
    userId,
    workerId: 'old-worker',
    executionGeneration: 2,
    attempt: 2,
    eventSequence: 4,
    currentNode: 'synthesize_review',
    traceId: 'trace-safe-id',
    correlationId: 'corr-safe-id',
  };
  const writes = [];
  const priorEvents = Array.from({ length: 4 }, (_, index) => ({
      runId: candidate.runId,
      userId,
      executionGeneration: index < 2 ? 1 : 2,
      sequence: index + 1,
      eventType: 'NODE_COMPLETED',
      node: 'previous_node',
      data: { type: 'NODE_COMPLETED' },
  }));
  const events = [];
  const evaluations = [];
  const session = { withTransaction: async callback => callback(), endSession: async () => {} };
  const model = {
    find: () => lean([candidate]),
    async updateOne(filter, mutation, options) {
      update = { filter, mutation, options };
      return { modifiedCount: 1 };
    },
  };
  const count = await recoverExpiredPlanReviewRuns({
    model,
    eventModel: {
      async create(rows, options) { events.push({ rows, options }); return rows; },
      find() {
        const query = {
          session() { return query; },
          sort() { return query; },
          lean: async () => [...priorEvents, ...events.flatMap(event => event.rows)],
        };
        return query;
      },
    },
    checkpointModel: { async updateMany(...args) { writes.push(['checkpoint', ...args]); } },
    graphCheckpointModel: { async updateMany(...args) { writes.push(['graph', ...args]); } },
    productionEvaluationModel: { async create(rows, options) { evaluations.push({ rows, options }); return rows; } },
    mongo: { startSession: async () => session },
    nowValue: new Date('2026-01-01T00:00:00.000Z'),
  });
  assert.equal(count, 1);
  assert.equal(update.mutation.$set.status, 'FAILED');
  assert.equal(update.mutation.$set.failure.code, 'INTERNAL_RUNTIME_FAILURE');
  assert.equal(update.mutation.$unset.activeDedupeKey, 1);
  assert.equal(update.options.session, session);
  assert.deepEqual(update.mutation.$set.deadLetter, {
    code: 'INTERNAL_RUNTIME_FAILURE', attempt: 2, executionGeneration: 2,
    lastNode: 'synthesize_review', traceId: 'trace-safe-id', correlationId: 'corr-safe-id',
    at: new Date('2026-01-01T00:00:00.000Z'),
  });
  assert.equal(events[0].rows[0].sequence, 5);
  assert.equal(events[0].rows[0].eventType, 'RUN_FAILED');
  assert.equal(evaluations.length, 0, 'diagnostic evaluation is not written inside terminal recovery transaction');
  assert.equal(writes.length, 2, 'terminal recovery schedules transient checkpoint expiry in the same transaction');
});

test('expired-run recovery commits terminal state independently of evaluator persistence', async () => {
  const candidate = {
    _id: '64b000000000000000000099', runId: 'run-expired-evaluation-failure', userId,
    workerId: 'old-worker', executionGeneration: 2, attempt: 2, eventSequence: 4,
  };
  let transactionCommitted = false;
  const session = {
    async withTransaction(callback) {
      await callback();
      transactionCommitted = true;
    },
    async endSession() {},
  };
  const recovered = await recoverExpiredPlanReviewRuns({
    model: { find: () => lean([candidate]), updateOne: async () => ({ modifiedCount: 1 }) },
    eventModel: { create: async rows => rows, find: () => ({ lean: async () => [] }) },
    checkpointModel: { updateMany: async () => ({ modifiedCount: 0 }) },
    graphCheckpointModel: { updateMany: async () => ({ modifiedCount: 0 }) },
    productionEvaluationModel: { create: async () => { throw new Error('evaluation persistence unavailable'); } },
    mongo: { startSession: async () => session },
    nowValue: new Date('2026-01-01T00:00:00.000Z'),
  });
  assert.equal(recovered, 1);
  assert.equal(transactionCommitted, true);
});

test('expired-run recovery is repeated by its durable worker timer while the process remains alive', async () => {
  const timers = [];
  let recoveries = 0;
  let firstRecovery;
  let secondRecovery;
  const firstDone = new Promise(resolve => { firstRecovery = resolve; });
  const secondDone = new Promise(resolve => { secondRecovery = resolve; });
  const model = {
    findOne() {
      const query = { sort() { return query; }, lean: async () => null };
      return query;
    },
    async findOneAndUpdate() { return null; },
  };
  const worker = createPlanReviewWorker({
    model,
    worker: 'worker-periodic-recovery',
    setIntervalImpl(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalImpl() {},
    recoverExpiredRunsImpl: async () => {
      recoveries += 1;
      if (recoveries === 1) firstRecovery();
      if (recoveries === 2) secondRecovery();
      return { recovered: 0 };
    },
    reconcileMandatesImpl: async () => ({ scanned: 0 }),
  });
  worker.start();
  await firstDone;
  await new Promise(resolve => setImmediate(resolve));
  const recoveryTimer = worker.expiredRunRecoveryTimer;
  assert.ok(recoveryTimer);
  assert.notEqual(recoveryTimer, worker.timer);
  assert.notEqual(recoveryTimer, worker.mandateReconciliationTimer);
  recoveryTimer.callback();
  await secondDone;
  assert.equal(recoveries, 2, 'a terminal-attempt crash is reconciled again without requiring a process restart');
  await worker.stop({ graceMs: 0 });
  assert.equal(timers.length, 3);
});

test('scheduler lease race allows one owner for a period', async () => {
  const model = leaseModelFixture();
  const [a, b] = await Promise.all([
    claimPlanHealthSchedulerLease({ model, periodKey: '2026-01-01', owner: 'a' }),
    claimPlanHealthSchedulerLease({ model, periodKey: '2026-01-01', owner: 'b' }),
  ]);
  assert.equal(Boolean(a) + Boolean(b), 1);
});

test('scheduled health scan uses bounded profile batches and remains read-only when empty', async () => {
  const profiles = [];
  const lease = leaseModelFixture();
  const profileStateModel = {
    find() {
      const query = {
        sort() { return query; },
        limit() { return query; },
        lean: async () => profiles,
      };
      return query;
    },
  };
  const result = await runPlanHealthScan({ profileStateModel, leaseModel: lease, owner: 'scheduler', batchSize: 2 });
  assert.deepEqual(result, { claimed: true, scanned: 0, events: 0, failures: 0, periodKey: result.periodKey });
  assert.equal(lease.row.status, 'COMPLETED');
  assert.equal(lease.row.profileStateCursor ?? null, null);
});

test('Plan Health scheduler recurs after a run and after an error without swallowing its lifecycle state', async () => {
  const scheduled = [];
  let runCount = 0;
  let releaseFirst;
  let announceFirst;
  const firstStarted = new Promise(resolve => { announceFirst = resolve; });
  const firstRun = new Promise(resolve => { releaseFirst = resolve; });
  const scheduler = createPlanHealthScheduler({
    config: { enabled: true, intervalMs: 100, jitterMs: 0, initialDelayMs: 0 },
    random: () => 0,
    schedule(callback, delay) {
      const handle = { callback, delay, unref() {} };
      scheduled.push(handle);
      return handle;
    },
    cancel(handle) { const index = scheduled.indexOf(handle); if (index >= 0) scheduled.splice(index, 1); },
    loggerImpl: { error() {} },
    runScan() {
      runCount += 1;
      if (runCount === 1) { announceFirst(); return firstRun; }
      return Promise.reject(Object.assign(new Error('temporary fixture failure'), { code: 'FIXTURE_SCAN_FAILURE' }));
    },
  });

  scheduler.start();
  assert.equal(scheduled.length, 1);
  scheduled.shift().callback();
  await firstStarted;
  assert.equal(scheduler.state().active, true);
  releaseFirst();
  await scheduler.waitForIdle();
  assert.equal(scheduled.length, 1, 'a completed scan schedules the next recurrence');

  scheduled.shift().callback();
  await scheduler.waitForIdle();
  assert.equal(runCount, 2);
  assert.equal(scheduled.length, 1, 'a failed scan does not disable future scheduled scans');
  assert.equal(scheduler.state().lastRunStatus, 'FAILED');
  assert.equal(scheduler.state().schedulerHealthy, true, 'one transient scan failure does not mark the subsystem dead');
  scheduled.shift().callback();
  await scheduler.waitForIdle();
  scheduled.shift().callback();
  await scheduler.waitForIdle();
  assert.equal(scheduler.state().consecutiveFailures, 3);
  assert.equal(scheduler.state().ready, false, 'repeated unrecoverable scan failures remove scheduler readiness');
  const stopped = await scheduler.stop({ graceMs: 0 });
  assert.deepEqual(stopped, { drained: true });
  assert.equal(scheduled.length, 0);
  assert.equal(scheduler.state().ready, false);
});

test('one timed-out Plan Health profile is recorded while later profiles still complete', async () => {
  const lease = leaseModelFixture();
  const ids = ['64b000000000000000000091', '64b000000000000000000092'];
  const stateUsers = ['64b000000000000000000191', '64b000000000000000000192'];
  const profiles = ids.map((_id, index) => ({ _id, userId: stateUsers[index] }));
  const profileStateModel = {
    find(filter) {
      const remaining = profiles.map((profile, index) => ({
        userId: stateUsers[index],
        currentProfileId: profile._id,
        revision: 1,
        resolutionStatus: 'CURRENT',
      })).filter(state => !filter.userId || state.userId > filter.userId.$gt);
      const query = { sort() { return query; }, limit() { return query; }, lean: async () => remaining };
      return query;
    },
  };
  const profileModel = {
    find({ _id: { $in: requestedIds } }) {
      const query = { lean: async () => profiles.filter(profile => requestedIds.includes(profile._id)).map(profile => ({ ...profile })) };
      return query;
    },
  };
  const inspected = [];
  const timeoutCallbacks = [];
  const publicationFenceModel = publicationFenceModelFixture();
  const result = await runPlanHealthScan({
    profileModel,
    profileStateModel,
    leaseModel: lease,
    owner: 'scheduler-timeout-test',
    batchSize: 2,
    concurrency: 2,
    profileTimeoutMs: 60000,
    publicationFenceModel,
    setTimeoutImpl(callback) {
      const timer = { callback, unref() {} };
      timeoutCallbacks.push(timer);
      return timer;
    },
    clearTimeoutImpl() {},
    inspect: async ({ profileId }) => {
      inspected.push(String(profileId));
      if (String(profileId) === ids[0]) {
        timeoutCallbacks[0].callback();
        return new Promise(() => {});
      }
      return { status: 'HEALTHY' };
    },
  });
  assert.deepEqual(inspected.sort(), ids);
  assert.equal(result.scanned, 2);
  assert.equal(result.failures, 1);
  assert.equal(lease.row.status, 'COMPLETED_WITH_ERRORS');
  assert.equal(lease.row.profileStateCursor, stateUsers[1]);
  assert.equal(lease.row.failureCount, 1);
  assert.deepEqual([...publicationFenceModel.rows.values()].map(row => row.status).sort(), ['PUBLISHED', 'TIMED_OUT']);
});

test('a poison Plan Health profile is counted and does not prevent later profiles from completing', async () => {
  const lease = leaseModelFixture();
  const profiles = ['64b0000000000000000000a1', '64b0000000000000000000a2', '64b0000000000000000000a3', '64b0000000000000000000a4']
    .map((_id, index) => ({ _id, userId: `64b0000000000000000000${101 + index}` }));
  const inspected = [];
  const profileStateModel = {
    find(filter = {}) {
      const remaining = profiles.map((profile, index) => ({
        userId: `64b0000000000000000000${101 + index}`,
        currentProfileId: profile._id,
        revision: 1,
        resolutionStatus: 'CURRENT',
      })).filter(state => !filter.userId || state.userId > filter.userId.$gt);
      const query = { sort() { return query; }, limit() { return query; }, lean: async () => remaining };
      return query;
    },
  };
  const result = await runPlanHealthScan({
    profileModel: {
      find({ _id: { $in: requestedIds } }) {
        return { lean: async () => profiles.filter(profile => requestedIds.includes(profile._id)) };
      },
    },
    profileStateModel,
    leaseModel: lease,
    publicationFenceModel: publicationFenceModelFixture(),
    periodKey: 'poison-profile-isolation',
    owner: 'poison-profile-test',
    batchSize: 4,
    concurrency: 2,
    profileTimeoutMs: 60000,
    inspect: async ({ profileId }) => {
      inspected.push(profileId);
      if (profileId === profiles[1]._id) {
        throw Object.assign(new Error('synthetic provider failure'), { code: 'INJECTED_PROFILE_FAILURE' });
      }
      return { status: 'HEALTHY' };
    },
  });
  assert.deepEqual(inspected.sort(), profiles.map(profile => profile._id).sort());
  assert.equal(result.scanned, 4);
  assert.equal(result.failures, 1);
  assert.equal(lease.row.status, 'COMPLETED_WITH_ERRORS');
  assert.equal(lease.row.failureCount, 1);
  assert.equal(lease.row.profileStateCursor, '64b0000000000000000000104');
});

test('malformed or foreign canonical profile pointers are isolated while valid users still scan', async () => {
  const lease = leaseModelFixture();
  const states = [
    { userId: 'user-a', currentProfileId: 'profile-a', revision: 1, resolutionStatus: 'CURRENT' },
    { userId: 'user-b', currentProfileId: 'profile-b', revision: 1, resolutionStatus: 'CURRENT' },
    { userId: 'user-c', currentProfileId: 'profile-missing', revision: 1, resolutionStatus: 'CURRENT' },
    { userId: 'user-d', currentProfileId: 'profile-invalid-revision', revision: 0, resolutionStatus: 'CURRENT' },
    { userId: 'user-e', currentProfileId: null, revision: 1, resolutionStatus: 'NO_CURRENT' },
  ];
  const profileStateModel = {
    find(filter = {}) {
      const remaining = states.filter(state => !filter.userId || state.userId > filter.userId.$gt);
      const query = { sort() { return query; }, limit() { return query; }, lean: async () => remaining };
      return query;
    },
  };
  const profileModel = {
    find({ _id: { $in: requestedIds } }) {
      const rows = [
        { _id: 'profile-a', userId: 'user-a' },
        { _id: 'profile-b', userId: 'some-other-user' },
        { _id: 'profile-invalid-revision', userId: 'user-d' },
      ].filter(profile => requestedIds.includes(profile._id));
      return { lean: async () => rows };
    },
  };
  const inspected = [];
  const result = await runPlanHealthScan({
    profileModel,
    profileStateModel,
    leaseModel: lease,
    publicationFenceModel: publicationFenceModelFixture(),
    periodKey: 'malformed-profile-pointer-isolation',
    owner: 'malformed-profile-pointer-test',
    batchSize: 5,
    concurrency: 2,
    inspect: async ({ profileId, userId: inspectedUserId }) => {
      inspected.push([String(profileId), String(inspectedUserId)]);
      return { status: 'HEALTHY' };
    },
  });

  assert.deepEqual(inspected, [['profile-a', 'user-a']]);
  assert.equal(result.scanned, 5);
  assert.equal(result.failures, 3, 'foreign, missing, and malformed-current pointer rows fail closed');
  assert.equal(lease.row.status, 'COMPLETED_WITH_ERRORS');
  assert.equal(lease.row.failureCount, 3);
});

test('Plan Health shutdown aborts a hung scan and returns without awaiting the provider forever', async () => {
  const scheduled = [];
  const deadlineCallbacks = [];
  let scanSignal;
  const scheduler = createPlanHealthScheduler({
    config: { enabled: true, intervalMs: 100, jitterMs: 0, initialDelayMs: 0 },
    schedule(callback) { const timer = { callback, unref() {} }; scheduled.push(timer); return timer; },
    cancel() {},
    setDeadlineTimer(callback) { deadlineCallbacks.push(callback); return {}; },
    clearDeadlineTimer() {},
    runScan({ signal }) { scanSignal = signal; return new Promise(() => {}); },
    loggerImpl: { error() {} },
  }).start();
  scheduled[0].callback();
  await Promise.resolve();
  const stopping = scheduler.stop({ graceMs: 20000 });
  assert.equal(deadlineCallbacks.length, 1);
  deadlineCallbacks[0]();
  assert.deepEqual(await stopping, { drained: false });
  assert.equal(scanSignal.aborted, true);
  assert.equal(scheduler.state().lifecycle, 'DRAINING');
});

test('plan health supersedes older active events and reopens resolved fingerprints', async () => {
  const profile = {
    _id: '64b000000000000000000011',
    userId,
    monthlyTakeHome: 100000,
    monthlySavings: 20000,
    age: 35,
    riskTolerance: 'Moderate',
    hasLumpSum: false,
    lumpSumAmount: 0,
    investmentGoals: ['Wealth Growth'],
    investmentHorizonYears: 10,
  };
  const stored = new Map();
  const eventModel = {
    async updateMany(filter, mutation) {
      for (const [key, value] of stored) {
        if (value.profileId === filter.profileId && filter.fingerprint.$ne !== value.fingerprint && filter.status.$in.includes(value.status)) {
          stored.set(key, { ...value, ...mutation.$set });
        }
      }
    },
    async create(input) {
      const batch = Array.isArray(input);
      const event = batch ? input[0] : input;
      if (stored.has(event.fingerprint)) {
        const error = new Error('duplicate');
        error.code = 11000;
        throw error;
      }
      const document = { ...event, _id: event.fingerprint, status: 'UNREAD' };
      stored.set(event.fingerprint, document);
      return batch ? [document] : document;
    },
    findOne(filter) {
      return { lean: async () => {
        const existing = stored.get(filter.fingerprint) || null;
        return existing && (!filter.status?.$in || filter.status.$in.includes(existing.status)) ? existing : null;
      } };
    },
    findOneAndUpdate(_filter, mutation) {
      return {
        lean: async () => {
          const current = stored.get(_filter.fingerprint);
          const updated = { ...current, ...mutation.$set };
          delete updated.acknowledgedAt;
          delete updated.resolvedAt;
          delete updated.supersededAt;
          stored.set(_filter.fingerprint, updated);
          return updated;
        },
      };
    },
  };
  let recommendationId = '64b000000000000000000012';
  const dependencies = {
    profileModel: { findOne: () => lean(profile) },
    profileStateModel: profileStateModelFixture({ profileId: profile._id, revision: 1 }),
    mongo: noOpTransactionMongo(),
    recommendationModel: {
      findOne: () => ({
        sort() { return this; },
        lean: async () => ({
          _id: recommendationId,
          profileId: profile._id,
          userId,
          generatedAt: new Date(),
          modelVersion: 'model-1',
          regulatoryRuleVersion: 'regulatory-1',
        }),
      }),
    },
  };
  const first = await inspectPlanHealth({ userId, profileId: profile._id, profileModel: dependencies.profileModel, profileStateModel: dependencies.profileStateModel, eventModel, dependencies, mongo: dependencies.mongo });
  assert.equal(first.status, 'ATTENTION');
  const firstEvent = [...stored.values()][0];
  stored.set(firstEvent.fingerprint, { ...firstEvent, status: 'RESOLVED' });
  const reopened = await inspectPlanHealth({ userId, profileId: profile._id, profileModel: dependencies.profileModel, profileStateModel: dependencies.profileStateModel, eventModel, dependencies, mongo: dependencies.mongo });
  assert.equal(reopened.event.status, 'UNREAD');
  recommendationId = '64b000000000000000000013';
  const superseded = await inspectPlanHealth({ userId, profileId: profile._id, profileModel: dependencies.profileModel, profileStateModel: dependencies.profileStateModel, eventModel, dependencies, mongo: dependencies.mongo });
  assert.equal(superseded.event.status, 'UNREAD');
  assert.equal(stored.get(firstEvent.fingerprint).status, 'SUPERSEDED');
});

test('Plan Health idempotency fingerprint is scoped to profile identity', () => {
  const common = { userId, recommendationId: null, reason: 'RECOMMENDATION_MISSING' };
  assert.notEqual(
    planHealthEventFingerprint({ ...common, profileId: '64b000000000000000000071' }),
    planHealthEventFingerprint({ ...common, profileId: '64b000000000000000000072' }),
  );
});
