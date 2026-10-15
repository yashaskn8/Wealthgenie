import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPlanReviewWorker,
  recoverExpiredPlanReviewRuns,
  startPlanReviewWorker,
  stopPlanReviewWorker,
} from '../agents/planReview/planReviewWorker.js';

const nowValue = new Date('2026-10-15T00:00:00.000Z');

test('expired PlanReview recovery scans a bounded, deterministic candidate batch', async () => {
  let receivedFilter;
  let receivedProjection;
  let receivedSort;
  let receivedLimit;
  const query = {
    select(value) {
      receivedProjection = value;
      return query;
    },
    sort(value) {
      receivedSort = value;
      return query;
    },
    limit(value) {
      receivedLimit = value;
      return query;
    },
    lean: async () => [],
  };

  const recovered = await recoverExpiredPlanReviewRuns({
    model: {
      find(filter) {
        receivedFilter = filter;
        return query;
      },
    },
    batchSize: 10_000,
    nowValue,
  });

  assert.equal(recovered, 0);
  assert.equal(receivedFilter.agentType, 'PLAN_REVIEW');
  assert.equal(receivedFilter.status, 'RUNNING');
  assert.deepEqual(receivedFilter.leaseUntil, { $lt: nowValue });
  assert.equal(receivedProjection, '_id runId userId workerId executionGeneration attempt eventSequence currentNode traceId correlationId');
  assert.deepEqual(receivedSort, { leaseUntil: 1, _id: 1 });
  assert.equal(receivedLimit, 100, 'caller input cannot raise the hard maximum recovery batch');
});

test('periodic expired-run recovery does not overlap an in-flight sweep', async () => {
  const timers = [];
  let recoveryCalls = 0;
  let releaseFirstRecovery;
  const firstRecovery = new Promise(resolve => { releaseFirstRecovery = resolve; });
  const model = {
    findOne() {
      const query = { sort() { return query; }, lean: async () => null };
      return query;
    },
    async findOneAndUpdate() { return null; },
  };
  const worker = createPlanReviewWorker({
    model,
    worker: 'worker-single-flight-recovery',
    setIntervalImpl(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalImpl() {},
    recoverExpiredRunsImpl: async () => {
      recoveryCalls += 1;
      return recoveryCalls === 1 ? firstRecovery : 0;
    },
    reconcileMandatesImpl: async () => ({ scanned: 0 }),
  });

  worker.start();
  const recoveryTimer = worker.expiredRunRecoveryTimer;
  assert.ok(recoveryTimer);
  assert.equal(recoveryCalls, 1, 'startup begins the first recovery sweep');

  recoveryTimer.callback();
  await Promise.resolve();
  assert.equal(recoveryCalls, 1, 'a timer tick while recovery is active does not start another sweep');

  releaseFirstRecovery(0);
  await new Promise(resolve => setImmediate(resolve));
  recoveryTimer.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(recoveryCalls, 2, 'a later timer tick starts a fresh sweep after the prior one settles');

  await worker.stop({ graceMs: 0 });
  assert.equal(timers.length, 3, 'the worker owns only its poll, mandate, and recovery timers');
});

test('worker shutdown waits for an in-flight expired-run transaction before closing Mongo', async () => {
  const timers = [];
  let releaseRecovery;
  const recovery = new Promise(resolve => { releaseRecovery = resolve; });
  const worker = createPlanReviewWorker({
    model: {
      findOne() {
        const query = { sort() { return query; }, lean: async () => null };
        return query;
      },
      async findOneAndUpdate() { return null; },
    },
    worker: 'worker-drains-expired-recovery',
    setIntervalImpl(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalImpl() {},
    recoverExpiredRunsImpl: () => recovery,
    reconcileMandatesImpl: async () => ({ scanned: 0 }),
  });

  worker.start();
  assert.ok(worker.expiredRunRecoveryPromise);
  let stopped = false;
  const stopping = worker.stop({ graceMs: 1000 }).then(result => {
    stopped = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(stopped, false, 'shutdown remains pending while Mongo recovery is in flight');

  releaseRecovery(0);
  assert.deepEqual(await stopping, { drained: true });
  assert.equal(timers.length, 3);
});

test('a recovery timer callback queued before stop cannot start a new sweep', async () => {
  const timers = [];
  let recoveries = 0;
  let releaseRecovery;
  const recovery = new Promise(resolve => { releaseRecovery = resolve; });
  startPlanReviewWorker({
    model: {
      findOne() {
        const query = { sort() { return query; }, lean: async () => null };
        return query;
      },
      async findOneAndUpdate() { return null; },
    },
    worker: 'worker-ignores-stale-recovery-callback',
    setIntervalImpl(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalImpl() {},
    recoverExpiredRunsImpl: () => {
      recoveries += 1;
      return recovery;
    },
    reconcileMandatesImpl: async () => ({ scanned: 0 }),
  });

  const recoveryTimer = timers[2];
  assert.ok(recoveryTimer);
  assert.equal(recoveries, 1, 'startup begins the first recovery sweep');
  await assert.rejects(stopPlanReviewWorker({ graceMs: 0 }), error => error.code === 'AGENT_WORKER_DRAIN_TIMEOUT');
  startPlanReviewWorker({ intervalMs: 1 });
  assert.equal(timers.length, 3, 'an undrained worker cannot restart while shutdown is pending');

  recoveryTimer.callback();
  assert.equal(recoveries, 1, 'a stale timer callback does not start recovery after draining begins');

  releaseRecovery(0);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await stopPlanReviewWorker({ graceMs: 1000 }), { drained: true });
});

test('worker shutdown waits for in-flight mandate reconciliation and ignores stale timer callbacks', async () => {
  const timers = [];
  let reconciliations = 0;
  let releaseReconciliation;
  const reconciliation = new Promise(resolve => { releaseReconciliation = resolve; });
  const worker = createPlanReviewWorker({
    model: {
      findOne() {
        const query = { sort() { return query; }, lean: async () => null };
        return query;
      },
      async findOneAndUpdate() { return null; },
    },
    worker: 'worker-drains-mandate-reconciliation',
    setIntervalImpl(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalImpl() {},
    recoverExpiredRunsImpl: async () => 0,
    reconcileMandatesImpl: () => {
      reconciliations += 1;
      return reconciliation;
    },
  });

  worker.start();
  const mandateTimer = worker.mandateReconciliationTimer;
  assert.ok(mandateTimer);
  assert.equal(reconciliations, 1, 'startup begins the first mandate reconciliation');
  let stopped = false;
  const stopping = worker.stop({ graceMs: 1000 }).then(result => {
    stopped = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(stopped, false, 'shutdown waits while reconciliation may still write to Mongo');

  mandateTimer.callback();
  assert.equal(reconciliations, 1, 'a stale mandate timer callback does not start a sweep during shutdown');
  releaseReconciliation({ scanned: 0 });
  assert.deepEqual(await stopping, { drained: true });
});

test('worker shutdown tracks the poll before queue claim and skips claiming after drain starts', async () => {
  let releaseQueueMetrics;
  const queueMetrics = new Promise(resolve => { releaseQueueMetrics = resolve; });
  let queueMetricReads = 0;
  let claims = 0;
  const model = {
    findOne() {
      queueMetricReads += 1;
      const query = {
        sort() { return query; },
        lean: () => queueMetrics,
      };
      return query;
    },
    async findOneAndUpdate() {
      claims += 1;
      return null;
    },
  };
  const worker = createPlanReviewWorker({
    model,
    worker: 'worker-drains-before-queue-claim',
    setIntervalImpl(callback, delay) {
      return { callback, delay, unref() {} };
    },
    clearIntervalImpl() {},
    recoverExpiredRunsImpl: async () => 0,
    reconcileMandatesImpl: async () => ({ scanned: 0 }),
  });

  worker.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queueMetricReads, 1, 'the worker began its queue-metrics read');
  assert.equal(await worker.processNext(), false, 'a second poll cannot overlap the pending first poll');
  assert.equal(queueMetricReads, 1, 'single-flight polling prevents a duplicate queue-metrics read');
  assert.deepEqual(await worker.stop({ graceMs: 0 }), { drained: false }, 'shutdown reports pending Mongo polling as undrained');

  releaseQueueMetrics(null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(claims, 0, 'no queue claim is attempted after draining begins');
  assert.deepEqual(await worker.stop({ graceMs: 1000 }), { drained: true });
});

test('a late queue claim during shutdown is fenced back to queued without starting PlanReview', async () => {
  let beginClaim;
  let releaseClaim;
  const claimStarted = new Promise(resolve => { beginClaim = resolve; });
  const claimResult = new Promise(resolve => { releaseClaim = resolve; });
  let providerCalls = 0;
  let releaseUpdate;
  const workerId = 'worker-late-claim-drain';
  const claimedRun = {
    runId: 'run-late-claim-drain',
    userId: '64b000000000000000000010',
    profileId: '64b000000000000000000011',
    status: 'RUNNING',
    workerId,
    attempt: 1,
    executionGeneration: 1,
  };
  const model = {
    findOne() {
      const query = { sort() { return query; }, lean: async () => null };
      return query;
    },
    findOneAndUpdate() {
      beginClaim();
      return claimResult;
    },
    async updateOne(filter, update) {
      releaseUpdate = { filter, update };
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
  const worker = createPlanReviewWorker({
    model,
    worker: workerId,
    setIntervalImpl(callback, delay) {
      return { callback, delay, unref() {} };
    },
    clearIntervalImpl() {},
    recoverExpiredRunsImpl: async () => 0,
    reconcileMandatesImpl: async () => ({ scanned: 0 }),
    runPlanReviewImpl: async () => {
      providerCalls += 1;
      return {};
    },
  });

  worker.start();
  await claimStarted;
  assert.deepEqual(await worker.stop({ graceMs: 0 }), { drained: false }, 'shutdown cannot claim the poll drained before Mongo settles');

  releaseClaim(claimedRun);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(providerCalls, 0, 'a claim returned during shutdown does not start PlanReview execution');
  assert.ok(releaseUpdate, 'the unstarted queue lease is compare-and-set back to queued');
  assert.deepEqual(releaseUpdate.filter, {
    runId: claimedRun.runId,
    workerId,
    executionGeneration: claimedRun.executionGeneration,
    status: 'RUNNING',
    attempt: claimedRun.attempt,
  });
  assert.equal(releaseUpdate.update.$set.status, 'QUEUED');
  assert.deepEqual(releaseUpdate.update.$inc, { attempt: -1 }, 'release restores only the unspent attempt and keeps executionGeneration monotonic');
  assert.equal(releaseUpdate.update.$set.executionGeneration, undefined);
  assert.deepEqual(await worker.stop({ graceMs: 1000 }), { drained: true });
});
