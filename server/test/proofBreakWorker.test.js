import test from 'node:test';
import assert from 'node:assert/strict';
import { claimNextProofBreakJob, failedCheckEventType, ProofBreakWorker, scheduleDueProofBreakJobs } from '../agents/genieProof/proofBreakWorker.js';

const nowAt = new Date('2026-10-11T12:00:00.000Z');
const ownerId = '65b000000000000000000001';
const caseId = '00000000-0000-4000-8000-000000000001';
const watchId = '00000000-0000-4000-8000-000000000002';

function query(value) {
  return { sort() { return this; }, limit() { return this; }, select() { return this; }, lean: async () => value };
}

test('worker readiness heartbeat records successful polls and clears a previous poll failure', async () => {
  const heartbeatWrites = [];
  const worker = new ProofBreakWorker({
    signer: {},
    workerId: 'worker-health',
    now: () => nowAt,
    heartbeatModel: { async updateOne(filter, update) { heartbeatWrites.push(structuredClone(update)); } },
  });
  worker.running = true;
  worker.processOne = async () => ({ processed: false, reason: 'NO_DUE_WORK' });

  await worker.processNext();
  assert.equal(heartbeatWrites.at(-1).$set.status, 'RUNNING');
  assert.equal(heartbeatWrites.at(-1).$set.lastSuccessfulPollAt.getTime(), nowAt.getTime());
  assert.equal(heartbeatWrites.at(-1).$set.lastPollErrorCode, null);

  worker.processOne = async () => { throw Object.assign(new Error('private database detail'), { code: 'INTERNAL_DB_FAILURE' }); };
  await assert.rejects(worker.processNext(), /private database detail/);
  assert.equal(heartbeatWrites.at(-1).$set.status, 'DEGRADED');
  assert.equal(heartbeatWrites.at(-1).$set.lastSuccessfulPollAt.getTime(), nowAt.getTime());
  assert.equal(heartbeatWrites.at(-1).$set.lastPollErrorCode, 'PROOFBREAK_WORKER_POLL_FAILED');

  worker.processOne = async () => ({ processed: false, reason: 'NO_DUE_WORK' });
  await worker.processNext();
  assert.equal(heartbeatWrites.at(-1).$set.status, 'RUNNING');
  assert.equal(heartbeatWrites.at(-1).$set.lastPollErrorCode, null);
});

test('worker poll failure remains degraded when its health record cannot be persisted', async () => {
  const worker = new ProofBreakWorker({
    signer: {},
    workerId: 'worker-health-write-failure',
    now: () => nowAt,
    heartbeatModel: { async updateOne() { throw new Error('health store unavailable'); } },
  });
  worker.running = true;
  worker.processOne = async () => { throw new Error('poll query failed'); };

  await assert.rejects(worker.processNext(), /poll query failed/);
  assert.equal(worker.workerStatus, 'DEGRADED');
  assert.equal(worker.lastPollErrorCode, 'PROOFBREAK_WORKER_POLL_FAILED');
});

test('due scheduler creates one durable job bound to the due watch generation and schedule', async () => {
  const watch = {
    _id: 'watch-db-id', watchId, userId: ownerId, caseId, generation: 3,
    status: 'ACTIVE', nextCheckAt: new Date(nowAt.getTime() - 1000), expiresAt: new Date(nowAt.getTime() + 86400000),
  };
  const created = [];
  let advanced = null;
  const watchModel = {
    find() { return { sort() { return this; }, limit() { return this; }, lean: async () => [watch] }; },
    async updateOne(filter, update) { advanced = update.$set.nextCheckAt; return { modifiedCount: 1 }; },
  };
  const jobModel = {
    async exists() { return false; },
    async create(rows) { created.push(...rows); return rows; },
  };
  const result = await scheduleDueProofBreakJobs({ watchModel, jobModel, now: () => nowAt });
  assert.deepEqual(result, { scanned: 1, scheduled: 1 });
  assert.equal(created.length, 1);
  assert.equal(created[0].watchGeneration, 3);
  assert.equal(created[0].scheduleKey, `scheduled:3:${watch.nextCheckAt.toISOString()}`);
  assert.ok(advanced instanceof Date && advanced > nowAt);
});

test('worker timeline distinguishes provider failures from internal processing failures', () => {
  assert.equal(failedCheckEventType(Object.assign(new Error('Source fetch failed.'), { code: 'GENIEPROOF_SOURCE_BUNDLE_UNAVAILABLE' })), 'SOURCE_UNAVAILABLE');
  assert.equal(failedCheckEventType(Object.assign(new Error('Research fetch timed out.'), { code: 'RESEARCH_FETCH_TIMEOUT' })), 'SOURCE_UNAVAILABLE');
  assert.equal(failedCheckEventType(Object.assign(new Error('Review permission missing.'), { code: 'GENIEPROOF_SOURCE_REUSE_NOT_APPROVED', status: 403 })), 'POLICY_REVIEW_REQUIRED');
  assert.equal(failedCheckEventType(Object.assign(new Error('The assessment head changed.'), { code: 'GENIEPROOF_CASE_HEAD_MISMATCH', status: 503 })), 'PROCESSING_FAILED');
  assert.equal(failedCheckEventType(Object.assign(new Error('Retry budget exhausted.'), { code: 'PROOFBREAK_RETRY_EXHAUSTED' })), 'PROCESSING_FAILED');
});

test('job claim takes an atomic lease and increments both attempt and fencing generation', async () => {
  let observed = null;
  const job = { jobId: 'job-1', attempt: 2, executionGeneration: 7 };
  const jobModel = {
    findOneAndUpdate(filter, update, options) {
      observed = { filter, update, options };
      return query({ ...job, attempt: 3, executionGeneration: 8 });
    },
  };
  const claimed = await claimNextProofBreakJob({ jobModel, owner: 'worker-a', leaseMs: 10_000, now: () => nowAt });
  assert.equal(claimed.owner, 'worker-a');
  assert.equal(claimed.executionGeneration, 8);
  assert.equal(claimed.job.attempt, 3);
  assert.equal(observed.update.$inc.attempt, 1);
  assert.equal(observed.update.$inc.executionGeneration, 1);
  assert.deepEqual(observed.options.sort, { scheduledAt: 1, _id: 1 });
});

test('worker recovery finalization consumes no provider request after the bounded attempt budget', async () => {
  let refreshCount = 0;
  const watch = {
    watchId, userId: ownerId, caseId, generation: 1, status: 'ACTIVE', consentWithdrawnAt: null,
    expiresAt: new Date(nowAt.getTime() + 86400000),
  };
  const worker = new ProofBreakWorker({
    signer: {},
    now: () => nowAt,
    watchModel: { findOne: () => query(watch) },
    caseModel: { findOne: () => query({ userId: ownerId, caseId, latestRevision: 1, latestManifestHash: 'a'.repeat(64) }) },
    refreshEvidence: async () => { refreshCount += 1; },
  });
  await assert.rejects(worker.processClaimedJob({
    job: { jobId: 'job-5', watchId, userId: ownerId, caseId, watchGeneration: 1, attempt: 5, maxAttempts: 4 },
    owner: 'worker-a', executionGeneration: 5,
  }), error => error.code === 'PROOFBREAK_RETRY_EXHAUSTED');
  assert.equal(refreshCount, 0);
});

test('a late heartbeat from an old job cannot abort a newer job controller', async () => {
  const claims = [
    { job: { jobId: 'job-a', watchId, userId: ownerId, caseId, watchGeneration: 1, scheduleKey: 'a', attempt: 1, maxAttempts: 4, executionGeneration: 1 }, owner: 'worker', executionGeneration: 1 },
    { job: { jobId: 'job-b', watchId, userId: ownerId, caseId, watchGeneration: 1, scheduleKey: 'b', attempt: 1, maxAttempts: 4, executionGeneration: 1 }, owner: 'worker', executionGeneration: 1 },
  ];
  const heartbeatCallbacks = [];
  let secondRefreshStarted;
  const secondRefresh = new Promise(resolve => { secondRefreshStarted = resolve; });
  let finishSecondRefresh;
  const secondRefreshGate = new Promise(resolve => { finishSecondRefresh = resolve; });
  const refreshSignals = [];
  const watch = {
    watchId, userId: ownerId, caseId, generation: 1, status: 'ACTIVE', consentWithdrawnAt: null,
    expiresAt: new Date(nowAt.getTime() + 86400000),
  };
  const jobModel = {
    findOneAndUpdate() { return query(claims.shift() || null); },
    async exists() { return true; },
    async updateOne(filter) { return { modifiedCount: filter.jobId === 'job-b' ? 1 : 0 }; },
  };
  const worker = new ProofBreakWorker({
    signer: {},
    workerId: 'worker',
    now: () => nowAt,
    jobModel,
    watchModel: {
      find() { return { sort() { return this; }, limit() { return this; }, lean: async () => [] }; },
      findOne: () => query(watch),
    },
    caseModel: { findOne: () => query({ userId: ownerId, caseId, latestRevision: 1, latestManifestHash: 'a'.repeat(64) }) },
    revisionModel: { findOne: () => query({ revision: 1, manifestHash: 'a'.repeat(64) }) },
    refreshEvidence: async ({ signal }) => {
      refreshSignals.push(signal);
      if (refreshSignals.length === 1) return undefined;
      secondRefreshStarted();
      return secondRefreshGate;
    },
    reassess: async () => ({ created: true, revision: 2 }),
    setIntervalImpl(callback) { heartbeatCallbacks.push(callback); return callback; },
    clearIntervalImpl() {},
  });

  const first = await worker.processOne();
  assert.equal(first.status, 'COMPLETED');
  const secondPromise = worker.processOne();
  await secondRefresh;
  assert.equal(refreshSignals[1].aborted, false);
  await heartbeatCallbacks[0]();
  assert.equal(refreshSignals[1].aborted, false);
  finishSecondRefresh();
  const second = await secondPromise;
  assert.equal(second.status, 'COMPLETED');
});

test('worker checks the lease before source retrieval and aborts an in-flight fetch after cancellation', async () => {
  const watch = {
    watchId, userId: ownerId, caseId, generation: 1, status: 'ACTIVE', consentWithdrawnAt: null,
    expiresAt: new Date(nowAt.getTime() + 86400000),
  };
  let refreshStarted;
  const started = new Promise(resolve => { refreshStarted = resolve; });
  let finishRefresh;
  const refreshGate = new Promise(resolve => { finishRefresh = resolve; });
  let refreshCount = 0;
  let leaseAvailable = true;
  const callbacks = [];
  const jobModel = {
    find() { return { sort() { return this; }, limit() { return this; }, lean: async () => [] }; },
    findOneAndUpdate() { return query({ jobId: 'job-cancel', watchId, userId: ownerId, caseId, watchGeneration: 1, scheduleKey: 'cancel', attempt: 1, maxAttempts: 4, executionGeneration: 1 }); },
    async exists() { return leaseAvailable; },
    async updateOne() { return { modifiedCount: leaseAvailable ? 1 : 0 }; },
  };
  const worker = new ProofBreakWorker({
    signer: {}, workerId: 'worker-cancel', now: () => nowAt, jobModel,
    watchModel: {
      find() { return { sort() { return this; }, limit() { return this; }, lean: async () => [] }; },
      findOne: () => query(watch),
    },
    caseModel: { findOne: () => query({ userId: ownerId, caseId, latestRevision: 1, latestManifestHash: 'a'.repeat(64) }) },
    revisionModel: { findOne: () => query({ revision: 1, manifestHash: 'a'.repeat(64) }) },
    refreshEvidence: async ({ signal }) => {
      refreshCount += 1;
      refreshStarted(signal);
      return refreshGate;
    },
    reassess: async () => ({ created: true, revision: 2 }),
    setIntervalImpl(callback) { callbacks.push(callback); return callback; },
    clearIntervalImpl() {},
  });

  const processing = worker.processOne();
  const signal = await started;
  assert.equal(signal.aborted, false);
  leaseAvailable = false; // pause, disable, or consent withdrawal fenced the leased job
  await callbacks[0]();
  assert.equal(signal.aborted, true);
  finishRefresh();
  const result = await processing;
  assert.equal(result.status, 'FENCED');
  assert.equal(refreshCount, 1);
});

test('worker does not start source retrieval when cancellation is already committed', async () => {
  const watch = {
    watchId, userId: ownerId, caseId, generation: 1, status: 'ACTIVE', consentWithdrawnAt: null,
    expiresAt: new Date(nowAt.getTime() + 86400000),
  };
  let refreshCount = 0;
  const worker = new ProofBreakWorker({
    signer: {}, now: () => nowAt,
    jobModel: { async exists() { return false; } },
    watchModel: { findOne: () => query(watch) },
    caseModel: { findOne: () => query({ userId: ownerId, caseId, latestRevision: 1, latestManifestHash: 'a'.repeat(64) }) },
    refreshEvidence: async () => { refreshCount += 1; },
  });
  await assert.rejects(worker.processClaimedJob({ job: { jobId: 'job-fenced', watchId, userId: ownerId, caseId, watchGeneration: 1, attempt: 1, maxAttempts: 4 }, owner: 'worker', executionGeneration: 1 }), error => error.code === 'PROOFBREAK_LEASE_LOST');
  assert.equal(refreshCount, 0);
});
