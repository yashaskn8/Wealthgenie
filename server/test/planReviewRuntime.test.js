import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPlanReviewTransition,
  buildApprovalAction,
  buildPlanReviewSnapshotBinding,
  CAPACITY_CONSUMING_PLAN_REVIEW_STATES,
  canTransitionPlanReviewState,
  hashPlanReviewSnapshot,
  planReviewGraphThreadId,
  PLAN_REVIEW_AGENT_VERSION,
} from '../agents/planReview/planReviewRuntime.js';
import { enqueuePlanReviewRun, getPlanReviewRun } from '../agents/planReview/planReviewService.js';
import { assertPlanReviewGates, gradePlanReviewTrajectory } from '../agents/evals/planReviewEvals.js';
import { emptyCheckpoint } from '@langchain/langgraph';
import { MongoPlanReviewCheckpointer } from '../agents/planReview/mongoPlanReviewCheckpointer.js';
import { buildRecommendationSummary, loadPlanReviewContext } from '../agents/planReview/planReviewTools.js';
import { completePlanReviewMandateAction, persistPlanReviewAction, reconcileTerminalPlanReviewMandates } from '../agents/planReview/planReviewApproval.js';
import { createPlanReviewGraph } from '../agents/planReview/planReviewGraph.js';
import { terminalizePlanReviewRun } from '../agents/planReview/planReviewTerminal.js';

const userId = '64b000000000000000000010';
const profileId = '64b000000000000000000001';
const snapshotBinding = buildPlanReviewSnapshotBinding({ userId, profileId, currentState: { profileVersion: 1, provenance: { status: 'MISSING' } }, freshness: { fresh: false, reasonCodes: ['RECOMMENDATION_MISSING'] } });
const snapshotHash = hashPlanReviewSnapshot(snapshotBinding);
const snapshotResolver = async () => ({ sourceBinding: snapshotBinding, planReviewSnapshotHash: snapshotHash });
const checkpointRetentionModels = {
  checkpointModel: { updateMany: async () => ({ modifiedCount: 0 }) },
  graphCheckpointModel: { updateMany: async () => ({ modifiedCount: 0 }) },
};

function queueTransactionDependencies() {
  const session = { withTransaction: async callback => callback(), endSession: async () => undefined };
  return { admissionModel: { updateOne: async () => ({ modifiedCount: 1 }) }, mongo: { startSession: async () => session } };
}

test('plan review state machine permits only explicit durable transitions', () => {
  assert.equal(canTransitionPlanReviewState('QUEUED', 'RUNNING'), true);
  assert.equal(canTransitionPlanReviewState('RUNNING', 'QUEUED'), true, 'a fenced pre-execution lease release can safely return work to the queue');
  assert.equal(canTransitionPlanReviewState('COMPLETED', 'RUNNING'), false);
  assert.doesNotThrow(() => assertPlanReviewTransition('WAITING_FOR_APPROVAL', 'CANCELLED'));
  assert.throws(() => assertPlanReviewTransition('COMPLETED', 'RUNNING'), { code: 'INVALID_AGENT_STATE_TRANSITION' });
});

test('direct cancellation and supersession commit terminal event and checkpoint retention atomically', async () => {
  for (const status of ['CANCELLED', 'SUPERSEDED']) {
    const now = new Date('2026-09-26T00:00:00.000Z');
    const run = { userId, runId: `run-${status}`, status: 'RUNNING', executionGeneration: 2, eventSequence: 4 };
    let insideTransaction = false;
    const session = {
      async withTransaction(callback) { insideTransaction = true; try { await callback(); } finally { insideTransaction = false; } },
      async endSession() {},
    };
    const model = {
      db: { async startSession() { return session; } },
      async findOneAndUpdate(filter, update, options) {
        assert.equal(insideTransaction, true);
        assert.equal(options.session, session);
        assert.deepEqual(filter.status.$in, ['RUNNING']);
        run.status = update.$set.status;
        run.eventSequence += update.$inc.eventSequence;
        Object.assign(run, update.$set);
        return run;
      },
    };
    const events = [];
    const eventModel = { async create(rows, options) {
      assert.equal(insideTransaction, true);
      assert.equal(options.session, session);
      events.push(...rows);
    } };
    const expiries = [];
    const checkpointModel = label => ({ async updateMany(_filter, update, options) {
      assert.equal(insideTransaction, true);
      assert.equal(options.session, session);
      expiries.push([label, update.$set.expiresAt]);
    } });
    const transitioned = await terminalizePlanReviewRun({
      model, eventModel, checkpointModel: checkpointModel('checkpoint'),
      graphCheckpointModel: checkpointModel('graph'), userId, runId: run.runId,
      expectedStatuses: ['RUNNING'], status,
      reasonCode: status === 'CANCELLED' ? 'USER_REQUESTED_CANCELLATION' : 'PLAN_REVIEW_SOURCE_SUPERSEDED',
      now,
    });
    assert.equal(transitioned.status, status);
    assert.equal(run.eventSequence, 5);
    assert.equal(events.length, 1);
    assert.equal(events[0].sequence, 5);
    assert.equal(events[0].executionGeneration, 2);
    assert.equal(events[0].eventType, status === 'CANCELLED' ? 'RUN_CANCELLED' : 'RUN_SUPERSEDED');
    assert.deepEqual(expiries.map(([label]) => label).sort(), ['checkpoint', 'graph']);
    assert.ok(expiries.every(([, expiresAt]) => expiresAt > now));
  }
});

test('PlanReview poll supersedes a run when its bound goal snapshot has changed', async () => {
  const originalBinding = buildPlanReviewSnapshotBinding({
    userId,
    profileId,
    currentState: { profileVersion: 1, provenance: { status: 'MISSING' } },
    freshness: { fresh: false, reasonCodes: ['RECOMMENDATION_MISSING'] },
    goalSnapshot: { count: 1, hash: 'a'.repeat(64) },
  });
  const originalHash = hashPlanReviewSnapshot(originalBinding);
  let run = {
    userId,
    runId: 'run-goal-superseded',
    profileId,
    status: 'QUEUED',
    planReviewSnapshotHash: originalHash,
    sourceBinding: originalBinding,
    executionGeneration: 1,
    eventSequence: 3,
  };
  const model = {
    findOne: () => ({ lean: async () => ({ ...run }) }),
    findOneAndUpdate: (_filter, update) => ({
      lean: async () => {
        run = { ...run, ...update.$set };
        return { ...run };
      },
    }),
  };
  const events = [];
  const eventModel = { create: async rows => { events.push(...rows); } };
  const checkpointModel = { updateMany: async () => ({ modifiedCount: 1 }) };
  const graphCheckpointModel = { updateMany: async () => ({ modifiedCount: 1 }) };
  const changedBinding = {
    ...originalBinding,
    goalSnapshotHash: 'b'.repeat(64),
  };
  const result = await getPlanReviewRun({
    userId,
    runId: run.runId,
    model,
    snapshotResolver: async () => ({ planReviewSnapshotHash: hashPlanReviewSnapshot(changedBinding) }),
    eventModel,
    checkpointModel,
    graphCheckpointModel,
  });

  assert.equal(result.status, 'SUPERSEDED');
  assert.equal(result.currentStateMatch, false);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'RUN_SUPERSEDED');
});

test('approval action is a descriptor and never a financial mutation', () => {
  const descriptor = buildApprovalAction('APPROVE_RECOMPUTE', { runId: 'run-1', profileId, recommendationId: null });
  assert.equal(descriptor.requiresAuthoritativeWorkflow, true);
  assert.equal(descriptor.mutationPerformed, false);
  assert.throws(() => buildApprovalAction('EXECUTE_TRADE', { runId: 'run-1' }), { code: 'UNSUPPORTED_AGENT_ACTION' });
});

test('rejecting a current review closes its active lifecycle with snapshot CAS', async () => {
  let document = { userId, runId: 'run-approval', planReviewSnapshotHash: snapshotHash, status: 'WAITING_FOR_APPROVAL', activeDedupeKey: 'active-key' };
  let captured;
  const model = {
    async findOneAndUpdate(filter, update) {
      captured = { filter, update };
      if (filter.userId !== document.userId || filter.runId !== document.runId
        || filter.status !== document.status || filter.planReviewSnapshotHash !== document.planReviewSnapshotHash) return null;
      document = { ...document, ...update.$set };
      if (update.$unset) for (const key of Object.keys(update.$unset)) delete document[key];
      return document;
    },
  };
  const saved = await persistPlanReviewAction({ model, userId, runId: 'run-approval', planReviewSnapshotHash: snapshotHash, action: 'REJECT_RECOMPUTE', ...checkpointRetentionModels });
  assert.equal(saved.status, 'COMPLETED');
  assert.equal(saved.approval.status, 'USER_REJECTED');
  assert.equal('activeDedupeKey' in saved, false);
  assert.equal(captured.filter.planReviewSnapshotHash, snapshotHash);
  assert.equal(captured.update.$unset.activeDedupeKey, 1);
});

test('mandate action keeps a review pending and terminalization is bound to its mandate identity', async () => {
  const document = { userId, runId: 'run-approval', planReviewSnapshotHash: snapshotHash, status: 'WAITING_FOR_APPROVAL', activeDedupeKey: 'active-key', approval: { status: 'MANDATE_CREATED', mandateId: 'mandate-1' } };
  const model = {
    async findOneAndUpdate(filter, update) {
      const pathValue = path => path.split('.').reduce((value, key) => value?.[key], document);
      if (Object.entries(filter).some(([key, value]) => pathValue(key) !== value)) return null;
      for (const [path, value] of Object.entries(update.$set || {})) {
        const keys = path.split('.');
        const finalKey = keys.pop();
        const target = keys.reduce((current, key) => (current[key] ||= {}), document);
        target[finalKey] = value;
      }
      if (update.$unset) for (const key of Object.keys(update.$unset)) delete document[key];
      return document;
    },
  };
  const pending = await persistPlanReviewAction({
    model,
    userId,
    runId: 'run-approval',
    planReviewSnapshotHash: snapshotHash,
    action: 'APPROVE_RECOMPUTE',
    mandate: { mandateId: 'mandate-1' },
    ...checkpointRetentionModels,
  });
  assert.equal(pending.status, 'WAITING_FOR_APPROVAL');
  assert.equal(pending.activeDedupeKey, 'active-key');
  assert.equal(pending.approval.status, 'MANDATE_CREATED');

  assert.equal(await completePlanReviewMandateAction({ model, userId, runId: 'run-approval', mandateId: 'another-mandate', outcome: 'REVOKED', ...checkpointRetentionModels }), null);
  const completed = await completePlanReviewMandateAction({ model, userId, runId: 'run-approval', mandateId: 'mandate-1', outcome: 'EXECUTED', ...checkpointRetentionModels });
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.approval.status, 'MANDATE_EXECUTED');
  assert.equal('activeDedupeKey' in completed, false);
});

test('approval terminal transitions schedule both checkpoint stores for retention in the same transaction', async () => {
  const now = new Date('2026-09-26T00:00:00.000Z');
  const expectedExpiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  async function exercise({ action, mandate = null, outcome = null, initialStatus }) {
    let inTransaction = false;
    const session = {
      async withTransaction(callback) { inTransaction = true; try { await callback(); } finally { inTransaction = false; } },
      async endSession() {},
    };
    const record = { userId, runId: `run-${action}-${outcome || 'direct'}`, status: initialStatus, approval: { mandateId: mandate?.mandateId || 'mandate-1' } };
    const model = {
      db: { async startSession() { return session; } },
      async findOneAndUpdate(_filter, update, options) {
        assert.equal(inTransaction, true);
        assert.equal(options.session, session);
        Object.assign(record, update.$set);
        return record;
      },
    };
    const seen = [];
    const retention = store => ({
      async updateMany(filter, update, options) {
        assert.equal(inTransaction, true);
        assert.equal(filter.runId, record.runId);
        assert.equal(filter.userId, userId);
        assert.ok(options.session);
        assert.deepEqual(update.$set.expiresAt, expectedExpiry);
        seen.push(store);
        return { modifiedCount: 1 };
      },
    });
    const args = {
      model,
      userId,
      runId: record.runId,
      now,
      checkpointModel: retention('checkpoint'),
      graphCheckpointModel: retention('graph'),
    };
    if (outcome) await completePlanReviewMandateAction({ ...args, mandateId: mandate.mandateId, outcome });
    else await persistPlanReviewAction({ ...args, planReviewSnapshotHash: snapshotHash, action, mandate });
    assert.deepEqual(seen.sort(), ['checkpoint', 'graph']);
  }

  await exercise({ action: 'REJECT_RECOMPUTE', initialStatus: 'WAITING_FOR_APPROVAL' });
  await exercise({ action: 'APPROVE_RECOMPUTE', mandate: { mandateId: 'mandate-1' }, outcome: 'REVOKED', initialStatus: 'WAITING_FOR_APPROVAL' });
});

test('expired mandates reconcile a waiting run durably and restart sweeps do not repeat work', async () => {
  const now = new Date('2026-09-26T00:00:00.000Z');
  const mandate = {
    mandateId: 'mandate-expired', userId, runId: 'run-expired', agentType: 'PLAN_REVIEW',
    status: 'AUTHORIZED', expiresAt: new Date(now.getTime() - 1000),
    sourceRunReconciliationStatus: null,
  };
  const run = {
    userId, runId: mandate.runId, status: 'WAITING_FOR_APPROVAL', activeDedupeKey: 'dedupe-expired',
    approval: { mandateId: mandate.mandateId, status: 'MANDATE_CREATED' },
  };
  const mandateModel = {
    async updateMany(filter, update) {
      assert.deepEqual(filter.status.$in, ['DRAFT', 'PENDING_USER_VERIFICATION', 'AUTHORIZED']);
      if (['DRAFT', 'PENDING_USER_VERIFICATION', 'AUTHORIZED'].includes(mandate.status) && mandate.expiresAt <= now) {
        Object.assign(mandate, update.$set);
        return { modifiedCount: 1 };
      }
      return { modifiedCount: 0 };
    },
    find(filter) {
      const query = {
        sort() { return query; },
        limit() { return query; },
        lean: async () => filter.status.$in.includes(mandate.status)
          && !filter.sourceRunReconciliationStatus.$nin.includes(mandate.sourceRunReconciliationStatus)
          ? [mandate]
          : [],
      };
      return query;
    },
    async updateOne(filter, update) {
      if (filter.mandateId !== mandate.mandateId || filter.status !== mandate.status || filter.sourceRunReconciliationStatus !== null) return { modifiedCount: 0 };
      Object.assign(mandate, update.$set);
      return { modifiedCount: 1 };
    },
  };
  const runModel = {
    async findOneAndUpdate(filter, update) {
      if (filter.userId !== run.userId || filter.runId !== run.runId || filter.status !== run.status
          || filter['approval.mandateId'] !== run.approval.mandateId) return null;
      for (const [path, value] of Object.entries(update.$set || {})) {
        const parts = path.split('.');
        const key = parts.pop();
        const target = parts.reduce((current, part) => (current[part] ||= {}), run);
        target[key] = value;
      }
      for (const key of Object.keys(update.$unset || {})) delete run[key];
      return run;
    },
    findOne: filter => ({
      select() { return this; },
      lean: async () => filter.userId === run.userId && filter.runId === run.runId ? run : null,
    }),
  };

  const first = await reconcileTerminalPlanReviewMandates({ mandateModel, runModel, now, ...checkpointRetentionModels });
  assert.deepEqual(first, { scanned: 1, reconciled: 1, processed: 1 });
  assert.equal(mandate.status, 'EXPIRED');
  assert.equal(mandate.sourceRunReconciliationStatus, 'RECONCILED');
  assert.equal(run.status, 'FAILED');
  assert.equal(run.failure.code, 'MANDATE_EXPIRED');
  assert.equal('activeDedupeKey' in run, false);
  assert.equal(await completePlanReviewMandateAction({
    model: runModel, userId, runId: mandate.runId, mandateId: mandate.mandateId, outcome: 'EXECUTED', now,
    ...checkpointRetentionModels,
  }), null, 'a stale approval completion cannot reopen an expired source run');

  // A fresh worker/process instance can safely resume the sweep from shared state.
  const restarted = await reconcileTerminalPlanReviewMandates({ mandateModel, runModel, now, ...checkpointRetentionModels });
  assert.deepEqual(restarted, { scanned: 0, reconciled: 0, processed: 0 });

  let freshRun;
  const freshModel = {
    async updateMany() { return { modifiedCount: 0 }; },
    findOne() { return { lean: async () => null }; },
    async countDocuments() { return 0; },
    async create(documents) { [freshRun] = documents; return documents; },
  };
  const fresh = await enqueuePlanReviewRun({ userId, profileId, model: freshModel, snapshotResolver, ...queueTransactionDependencies() });
  assert.equal(fresh.created, true, 'reconciliation releases active capacity for the same canonical financial snapshot');
  assert.equal(freshRun.status, 'QUEUED');
});

test('enqueue is idempotent for an active owned profile run bound to the same source snapshot', async () => {
  const active = { runId: 'run-existing', status: 'RUNNING', profileId, planReviewSnapshotHash: snapshotHash, agentVersion: PLAN_REVIEW_AGENT_VERSION };
  const model = {
    findOne() { return { lean: async () => active }; },
    create: async () => { throw new Error('should not create a duplicate'); },
    updateMany: async () => ({ modifiedCount: 0 }),
  };
  const result = await enqueuePlanReviewRun({ userId, profileId, model, snapshotResolver, ...queueTransactionDependencies() });
  assert.equal(result.created, false);
  assert.equal(result.run.runId, active.runId);
});

test('enqueue applies per-user and global queue backpressure before creating a run', async () => {
  let createCalled = false;
  const model = {
    findOne() { return { lean: async () => null }; },
    async countDocuments(filter) {
      if (filter.status === 'QUEUED') return filter.userId ? 1 : 1;
      return 0;
    },
    async create() { createCalled = true; return null; },
    async updateMany() { return { modifiedCount: 0 }; },
  };
  await assert.rejects(
    enqueuePlanReviewRun({
      userId,
      profileId,
      model,
      snapshotResolver,
      ...queueTransactionDependencies(),
      runtimeConfig: { agentPlanReview: { maxQueuedRunsPerUser: 1, maxActiveRunsPerUser: 1, maxGlobalQueuedRuns: 1 } },
    }),
    error => error.status === 429 && error.code === 'AGENT_QUEUE_SATURATED' && error.retryAfterMs === 5000,
  );
  assert.equal(createCalled, false);
});

test('enqueue retries an unlabelled Mongo write conflict and observes the winning admission', async () => {
  for (const winningAdmissionConsumesCapacity of [false, true]) {
    let transactionAttempts = 0;
    let endedSessions = 0;
    let created = 0;
    const mongo = {
      async startSession() {
        return {
          async withTransaction(callback) {
            transactionAttempts += 1;
            if (transactionAttempts === 1) {
              throw Object.assign(new Error('Write conflict during admission fence update'), { code: 112 });
            }
            return callback();
          },
          async endSession() { endedSessions += 1; },
        };
      },
    };
    const model = {
      findOne() { return { lean: async () => null }; },
      async countDocuments(filter) {
        if (filter.status === 'QUEUED') return 0;
        if (Array.isArray(filter.status?.$in)) return winningAdmissionConsumesCapacity ? 1 : 0;
        return 0;
      },
      async create(documents) {
        created += 1;
        return documents;
      },
      async updateMany() { return { modifiedCount: 0 }; },
    };
    const request = enqueuePlanReviewRun({
      userId,
      profileId,
      model,
      mongo,
      snapshotResolver,
      admissionModel: { updateOne: async () => ({ modifiedCount: 1 }) },
      runtimeConfig: { agentPlanReview: { maxQueuedRunsPerUser: 5, maxActiveRunsPerUser: 1, maxGlobalQueuedRuns: 20 } },
    });

    if (winningAdmissionConsumesCapacity) {
      await assert.rejects(request, error => error.status === 429 && error.code === 'AGENT_QUEUE_SATURATED');
      assert.equal(created, 0);
    } else {
      const result = await request;
      assert.equal(result.created, true);
      assert.equal(created, 1);
    }
    assert.equal(transactionAttempts, 2);
    assert.equal(endedSessions, 2);
  }
});

test('enqueue reports admission unavailable after bounded write-conflict retries when capacity is not full', async () => {
  let transactionAttempts = 0;
  let endedSessions = 0;
  const mongo = {
    async startSession() {
      return {
        async withTransaction() {
          transactionAttempts += 1;
          throw Object.assign(new Error('Write conflict during admission fence update'), { code: 112 });
        },
        async endSession() { endedSessions += 1; },
      };
    },
  };
  const model = {
    async countDocuments() { return 0; },
    async create() { assert.fail('A failed transaction must not create a run.'); },
  };

  await assert.rejects(enqueuePlanReviewRun({
    userId,
    profileId,
    model,
    mongo,
    snapshotResolver,
    admissionModel: { updateOne: async () => ({ modifiedCount: 1 }) },
    runtimeConfig: { agentPlanReview: { maxQueuedRunsPerUser: 5, maxActiveRunsPerUser: 1, maxGlobalQueuedRuns: 20 } },
  }), error => error.status === 503 && error.code === 'AGENT_QUEUE_ADMISSION_UNAVAILABLE');
  assert.equal(transactionAttempts, 13);
  assert.equal(endedSessions, 13);
});

test('WAITING_FOR_APPROVAL consumes active-user capacity in the canonical state set', async () => {
  assert.deepEqual(CAPACITY_CONSUMING_PLAN_REVIEW_STATES, ['QUEUED', 'RUNNING', 'WAITING_FOR_APPROVAL']);
  let activeFilter;
  const model = {
    findOne() { return { lean: async () => null }; },
    async updateMany() { return { modifiedCount: 0 }; },
    async countDocuments(filter) {
      if (Array.isArray(filter.status?.$in)) {
        activeFilter = filter.status.$in;
        return filter.status.$in.includes('WAITING_FOR_APPROVAL') ? 1 : 0;
      }
      return 0;
    },
    async create() { assert.fail('Capacity must reject before creating another run.'); },
  };
  await assert.rejects(enqueuePlanReviewRun({
    userId,
    profileId,
    model,
    snapshotResolver,
    ...queueTransactionDependencies(),
    runtimeConfig: { agentPlanReview: { maxQueuedRunsPerUser: 5, maxActiveRunsPerUser: 1, maxGlobalQueuedRuns: 20 } },
  }), error => error.status === 429 && error.code === 'AGENT_QUEUE_SATURATED');
  assert.deepEqual(activeFilter, ['QUEUED', 'RUNNING', 'WAITING_FOR_APPROVAL']);
});

test('deterministic evaluation gates enforce every reported quality and hard gate', () => {
  const caseDefinition = {
    id: 'fresh',
    forbiddenTools: ['execute_trade'],
    expectedTools: ['get_current_profile_context'],
    expectedAction: 'NONE',
    maxSteps: 6,
    maxToolCalls: 8,
    groundingRequired: true,
    requiredReasonCodes: [],
  };
  const valid = gradePlanReviewTrajectory({
    caseDefinition,
    result: { stepCount: 1, toolCallCount: 1, review: { recommendedAction: 'NONE', evidence: { status: 'AVAILABLE' }, freshness: { reasonCodes: [] } } },
    trajectory: [{ type: 'TOOL_SUCCEEDED', tool: 'get_current_profile_context' }],
  });
  assert.equal(valid.passed, true);

  const failed = gradePlanReviewTrajectory({
    caseDefinition,
    result: { stepCount: 1, toolCallCount: 1, review: { recommendedAction: 'NONE', evidence: { status: 'AVAILABLE' }, freshness: { reasonCodes: [] } } },
    trajectory: [{ type: 'TOOL_SUCCEEDED', tool: 'execute_trade' }],
  });
  assert.equal(failed.passed, false);
  assert.equal(failed.policy, false);
  assert.throws(() => assertPlanReviewGates([failed]), { code: 'AGENT_EVAL_GATE_FAILED' });

  const mutations = [
    { result: { stepCount: 99, toolCallCount: 1, review: { recommendedAction: 'NONE', evidence: { status: 'AVAILABLE' }, freshness: { reasonCodes: [] } } }, trajectory: [{ type: 'TOOL_SUCCEEDED', tool: 'get_current_profile_context' }], gate: 'trajectory' },
    { result: { stepCount: 1, toolCallCount: 1, review: { recommendedAction: 'NONE', evidence: { status: 'UNAVAILABLE' }, freshness: { reasonCodes: [] } } }, trajectory: [{ type: 'TOOL_SUCCEEDED', tool: 'get_current_profile_context' }], gate: 'grounding' },
    { result: { stepCount: 1, toolCallCount: 1, review: { recommendedAction: 'NONE', policy: { allowed: false }, evidence: { status: 'AVAILABLE' }, freshness: { reasonCodes: [] } } }, trajectory: [{ type: 'TOOL_SUCCEEDED', tool: 'get_current_profile_context' }], gate: 'policy' },
    { result: { stepCount: 1, toolCallCount: 1, review: { recommendedAction: 'NONE', evidence: { status: 'AVAILABLE' }, freshness: { reasonCodes: null } } }, trajectory: [{ type: 'TOOL_SUCCEEDED', tool: 'get_current_profile_context' }], gate: 'robustness' },
    { result: { stepCount: 1, toolCallCount: 1, review: { recommendedAction: 'RECOMPUTE_PLAN', evidence: { status: 'AVAILABLE' }, freshness: { reasonCodes: [] } } }, trajectory: [{ type: 'TOOL_SUCCEEDED', tool: 'get_current_profile_context' }], gate: 'action' },
    { result: { stepCount: 1, toolCallCount: 1, review: { recommendedAction: 'NONE', evidence: { status: 'AVAILABLE' }, freshness: { reasonCodes: [] } } }, trajectory: [], gate: 'toolSelection' },
  ];
  for (const mutation of mutations) {
    const graded = gradePlanReviewTrajectory({ caseDefinition, ...mutation });
    assert.equal(graded[mutation.gate], false, `${mutation.gate} must fail the evaluation`);
    assert.equal(graded.passed, false, `${mutation.gate} failure must fail the complete evaluation`);
  }
});

test('Mongo LangGraph checkpointer persists and reloads a run-scoped checkpoint', async () => {
  const documents = [];
  const model = {
    async findOneAndUpdate(filter, update) {
      let document = documents.find(item => Object.entries(filter).every(([key, value]) => String(item[key]) === String(value)));
      if (!document) { document = { ...update.$setOnInsert }; documents.push(document); }
      Object.assign(document, update.$set);
      return document;
    },
    findOne(filter) {
      const query = {
        sort() { return query; },
        lean: async () => documents.find(item => Object.entries(filter).every(([key, value]) => String(item[key]) === String(value))),
      };
      return query;
    },
    async updateOne() {},
    async deleteMany() {},
  };
  const saver = new MongoPlanReviewCheckpointer({ model, runId: 'run-1', userId, executionGeneration: 1 });
  const checkpoint = { ...emptyCheckpoint(), id: 'checkpoint-1', channel_values: { status: 'RUNNING' } };
  const config = await saver.put({ configurable: { thread_id: 'run-1:1' } }, checkpoint, { runId: 'run-1' }, checkpoint.channel_versions);
  const tuple = await saver.getTuple(config);
  assert.equal(config.configurable.thread_id, 'run-1:1');
  assert.equal(tuple.checkpoint.channel_values.status, 'RUNNING');
  assert.equal(tuple.metadata.runId, 'run-1');
  assert.throws(() => saver.scope('run-1:2'), { code: 'CHECKPOINT_SCOPE_MISMATCH' });
});

test('Mongo LangGraph checkpointer orders pending writes after an in-flight checkpoint save', async () => {
  let signalCheckpointSaveStarted;
  let releaseCheckpointSave;
  const checkpointSaveStarted = new Promise(resolve => { signalCheckpointSaveStarted = resolve; });
  const checkpointSaveGate = new Promise(resolve => { releaseCheckpointSave = resolve; });
  const documents = [];
  let pendingWriteReads = 0;
  const model = {
    async findOneAndUpdate(filter, update) {
      signalCheckpointSaveStarted();
      await checkpointSaveGate;
      let document = documents.find(item => Object.entries(filter).every(([key, value]) => String(item[key]) === String(value)));
      if (!document) {
        document = { ...update.$setOnInsert, pendingWrites: [] };
        documents.push(document);
      }
      Object.assign(document, update.$set);
      return document;
    },
    findOne(filter) {
      pendingWriteReads += 1;
      const query = {
        select() { return query; },
        lean: async () => documents.find(item => Object.entries(filter).every(([key, value]) => String(item[key]) === String(value))),
      };
      return query;
    },
    async updateOne(filter, update) {
      const document = documents.find(item => Object.entries(filter).every(([key, value]) => (
        key === 'pendingWrites' ? JSON.stringify(item[key] || []) === JSON.stringify(value) : String(item[key]) === String(value)
      )));
      if (!document) return { matchedCount: 0 };
      document.pendingWrites.push(...update.$push.pendingWrites.$each);
      return { matchedCount: 1 };
    },
  };
  const saver = new MongoPlanReviewCheckpointer({ model, runId: 'run-ordered-writes', userId, executionGeneration: 1 });
  const checkpoint = { ...emptyCheckpoint(), id: 'checkpoint-ordered', channel_values: { status: 'RUNNING' } };
  const savePromise = saver.put(
    { configurable: { thread_id: 'run-ordered-writes:1' } },
    checkpoint,
    { runId: 'run-ordered-writes' },
    checkpoint.channel_versions,
  );
  await checkpointSaveStarted;

  const writesResult = saver.putWrites(
    { configurable: { thread_id: 'run-ordered-writes:1', checkpoint_id: 'checkpoint-ordered' } },
    [['status', 'RUNNING']],
    'task-ordered',
  ).then(() => null, error => error);
  await new Promise(resolve => setImmediate(resolve));
  const readsBeforeCheckpointCommit = pendingWriteReads;
  releaseCheckpointSave();

  const savedConfig = await savePromise;
  const writeError = await writesResult;
  assert.equal(readsBeforeCheckpointCommit, 0, 'pending writes must wait until the checkpoint record is durable');
  assert.equal(writeError, null);
  await Promise.all([
    saver.putWrites(savedConfig, [['step', 1]], 'task-concurrent-a'),
    saver.putWrites(savedConfig, [['toolCallCount', 1]], 'task-concurrent-b'),
  ]);
  const tuple = await saver.getTuple(savedConfig);
  assert.deepEqual(tuple.pendingWrites, [
    ['task-ordered', 'status', 'RUNNING'],
    ['task-concurrent-a', 'step', 1],
    ['task-concurrent-b', 'toolCallCount', 1],
  ]);
});

test('Mongo LangGraph checkpointer rejects a pending-write batch above its recovery count bound', async () => {
  let reads = 0;
  const model = {
    findOne() {
      reads += 1;
      const query = { lean: async () => ({ pendingWrites: [] }) };
      return query;
    },
    async updateOne() { throw new Error('an over-budget batch must never persist'); },
  };
  const saver = new MongoPlanReviewCheckpointer({ model, runId: 'run-bounded-count', userId, executionGeneration: 1 });
  await assert.rejects(
    saver.putWrites({ configurable: { thread_id: 'run-bounded-count:1', checkpoint_id: 'checkpoint-1' } },
      Array.from({ length: 101 }, (_, index) => [`channel-${index}`, index]), 'task-1'),
    error => error.code === 'AGENT_GRAPH_CHECKPOINT_BUDGET_EXCEEDED',
  );
  assert.equal(reads, 0, 'reject the oversized batch before reading or mutating persisted state');
});

test('Mongo LangGraph checkpointer enforces cumulative pending-write byte bounds', async () => {
  let writes = 0;
  const prior = ['task-1', 'channel-1', 'json', 'x'.repeat(250 * 1024)];
  const model = {
    findOne() {
      const query = { lean: async () => ({ pendingWrites: [prior] }) };
      return query;
    },
    async updateOne() { writes += 1; return { matchedCount: 1 }; },
  };
  const saver = new MongoPlanReviewCheckpointer({ model, runId: 'run-bounded-bytes', userId, executionGeneration: 1 });
  await assert.rejects(
    saver.putWrites({ configurable: { thread_id: 'run-bounded-bytes:1', checkpoint_id: 'checkpoint-1' } }, [['channel-2', 'y'.repeat(6 * 1024)]], 'task-2'),
    error => error.code === 'AGENT_GRAPH_CHECKPOINT_BUDGET_EXCEEDED',
  );
  assert.equal(writes, 0, 'cumulative over-budget writes must not reach persistence');
});

test('production PlanReview graph context excludes bulky persisted snapshots before checkpoint writes', async () => {
  const largeHistoricalSnapshot = 'historical-generation-payload-'.repeat(16_000);
  const recommendation = {
    _id: 'recommendation-1',
    profileId,
    generatedAt: new Date('2026-09-01T00:00:00.000Z'),
    modelVersion: 'deterministic-v1',
    profileInputHash: 'profile-hash',
    recommendationPolicyVersion: 'policy-v1',
    regulatoryRuleVersion: 'regulatory-v1',
    responseSnapshot: { body: largeHistoricalSnapshot },
    instruments: [{
      id: 'instrument-1', name: 'Instrument', type: 'FIXED_INCOME', assetClass: 'FIXED_INCOME',
      allocation_pct: 100, nominalReturn: 7, riskLevel: 'LOW',
      returnDataClass: 'MODEL_ASSUMPTION', returnAssumptionVersion: 'assumption-v1',
      internalCatalogPayload: largeHistoricalSnapshot,
    }],
    internalRegistryPayload: largeHistoricalSnapshot,
  };
  const currentState = {
    profile: { version: 3, internalProfilePayload: largeHistoricalSnapshot },
    profileVersion: 3,
    currentRecommendationView: recommendation,
    recommendation,
    allocationRevision: {
      _id: 'allocation-1', revision: 4, returnAssumptionVersion: 'assumption-v1',
      returnAssumptionHash: 'assumption-hash', returnAssumptionSource: 'WEALTHGENIE_MODEL_POLICY',
      instruments: recommendation.instruments,
    },
    currentAllocation: { instruments: recommendation.instruments },
    financialProfileState: { revision: 5, currentProfileId: profileId, internalStatePayload: largeHistoricalSnapshot },
    recommendationFingerprint: 'recommendation-fingerprint',
    portfolioFingerprint: 'portfolio-fingerprint',
    generationSnapshot: { response: { body: largeHistoricalSnapshot } },
    provenance: { status: 'PERSISTED_REVISION', internalPayload: largeHistoricalSnapshot },
    freshness: { fresh: true, reasonCodes: [] },
  };
  const profile = {
    _id: profileId,
    age: 35,
    riskTolerance: 'MODERATE',
    monthlySavings: 27_000,
    investmentHorizonYears: 12,
    investmentGoals: ['Wealth Growth'],
    finalSuitabilityRisk: 'LOW',
    suitabilityReasonCodes: ['CAPACITY_PULL_DOWN'],
    email: 'private@example.invalid',
    internalProfilePayload: largeHistoricalSnapshot,
  };
  const snapshot = {
    profile,
    canonicalProfile: {
      age: profile.age,
      riskTolerance: profile.riskTolerance,
      monthlySavings: profile.monthlySavings,
      investmentHorizonYears: profile.investmentHorizonYears,
      investmentGoals: profile.investmentGoals,
    },
    currentState,
    sourceBinding: { recommendationId: 'recommendation-1', allocationRevisionId: 'allocation-1' },
    planReviewSnapshotHash: 'bound-snapshot-hash',
  };
  const context = await loadPlanReviewContext({
    userId,
    profileId,
    dependencies: { resolvePlanReviewSnapshot: async () => snapshot },
  });

  assert.equal(context.planReviewSnapshotHash, snapshot.planReviewSnapshotHash);
  assert.equal(context.sourceBinding, snapshot.sourceBinding);
  assert.equal(context.recommendation._id, recommendation._id);
  assert.equal(context.recommendation.responseSnapshotAvailable, true);
  assert.equal(context.recommendation.instruments[0].assetClass, 'FIXED_INCOME');
  assert.equal('responseSnapshot' in context.recommendation, false);
  assert.equal('internalRegistryPayload' in context.recommendation, false);
  assert.equal('internalProfilePayload' in context.profile, false);
  assert.equal('generationSnapshot' in context.currentState, false);
  assert.equal(context.currentState.allocationRevision.revision, 4);

  let persistedWrites;
  const checkpointModel = {
    findOne() { return { lean: async () => ({ pendingWrites: [] }) }; },
    async updateOne(_filter, update) {
      persistedWrites = update.$push.pendingWrites.$each;
      return { matchedCount: 1 };
    },
  };
  const saver = new MongoPlanReviewCheckpointer({ model: checkpointModel, runId: 'run-compact-context', userId, executionGeneration: 1 });
  await saver.putWrites({
    configurable: { thread_id: 'run-compact-context:1', checkpoint_id: 'checkpoint-1' },
  }, Object.entries(context), 'load-context-task');
  assert.ok(persistedWrites);
  assert.ok(persistedWrites.reduce((total, row) => total + row.reduce((sum, value) => sum + Buffer.byteLength(value), 0), 0) < 256 * 1024);
});

test('PlanReview summary preserves an explicit unavailable generation snapshot state', () => {
  const summary = buildRecommendationSummary({
    _id: 'recommendation-1',
    responseSnapshotAvailable: false,
    responseSnapshot: { historical: true },
    instruments: [],
  }, { fresh: true });

  assert.equal(summary.responseSnapshotAvailable, false);
});

test('PlanReview identity includes financial source binding and execution generation', async () => {
  const nextBinding = { ...snapshotBinding, allocationRevision: 2 };
  assert.notEqual(hashPlanReviewSnapshot(nextBinding), snapshotHash);
  assert.equal(planReviewGraphThreadId('run-1', 2), 'run-1:2');
  assert.throws(() => planReviewGraphThreadId('run-1', 0), /positive execution generation/);
});

test('a present but invalid replay checkpoint fails closed instead of resetting budgets', async () => {
  const graph = createPlanReviewGraph({
    loadPlanReviewContext: async () => ({ planReviewSnapshotHash: snapshotHash }),
  });
  await assert.rejects(
    graph.invoke({
      runId: 'run-invalid-checkpoint',
      userId,
      profileId,
      executionGeneration: 2,
      expectedPlanReviewSnapshotHash: snapshotHash,
      resumeCheckpoint: {
        schemaVersion: 'plan-review-replay-checkpoint-1.0.0',
        runId: 'run-invalid-checkpoint',
        planReviewSnapshotHash: snapshotHash,
        sourceBinding: snapshotBinding,
        counters: { modelCallCount: 1, tokenUsage: 100 },
        checkpointHash: 'tampered',
      },
    }),
    error => error.code === 'CHECKPOINT_FAILURE',
  );
});
