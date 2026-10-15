import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Role, TaskState } from '@a2a-js/sdk';
import ResearchTask from '../models/ResearchTask.js';
import ResearchTaskCapacity from '../models/ResearchTaskCapacity.js';
import { MongoResearchTaskStore } from '../services/researchTaskStore.js';
import { migrateResearchTaskIndexes } from '../services/researchTaskPersistence.js';
import { createResearchBrief, encodeResearchBriefUuid } from '../agents/research/researchSchemas.js';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';

const noMongoPartition = process.env.MONGO_TEST_PARTITION === 'NO_MONGO';

// Full mode may provision an isolated MongoMemoryReplSet; only the explicit
// Windows no-Mongo partition should skip these replica-set integration cases.

function caller() {
  return { user: { identity: { provider: 'development', authenticated: true, subject: 'phase7-lease-integration', agentType: 'PLAN_REVIEW' } } };
}

function privacySafeBriefId() {
  // Fixture IDs share production's bijective encoding, including UUID hex letters.
  return 'brief-' + encodeResearchBriefUuid(crypto.randomUUID());
}

function submittedTask(id, question = 'Verify the current official public financial rule') {
  const contextId = `context-${id}`;
  const brief = createResearchBrief({
    researchBriefId: privacySafeBriefId(),
    topic: 'Official financial rule',
    question,
    requestedFactTypes: ['statutory_rule'],
  });
  return {
    id,
    contextId,
    status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString() },
    artifacts: [],
    history: [{
      messageId: `message-${id}`,
      contextId,
      taskId: id,
      role: Role.ROLE_USER,
      parts: [{ content: { $case: 'data', value: brief }, mediaType: 'application/json', filename: '' }],
    }],
    metadata: { agentType: 'FINANCIAL_RESEARCH' },
  };
}

test('ResearchTask brief fixtures remain valid for UUIDs with private-identifier-like numeric tails', () => {
  const taskId = 'phase7-dedupe-00000000-0000-4000-8000-612345678901';
  const task = submittedTask(taskId);
  const brief = task.history[0].parts[0].content.value;
  assert.equal(task.id, taskId, 'transport identity remains unchanged');
  assert.doesNotMatch(brief.researchBriefId, /\d/, 'brief fixture IDs cannot randomly resemble private numbers');
  assert.throws(
    () => createResearchBrief({ ...brief, researchBriefId: `brief-${taskId}` }),
    error => error.code === 'INVALID_RESEARCH_BRIEF'
      && error.details.some(detail => detail.type === 'RESEARCH_BRIEF_PRIVACY_VIOLATION'),
    'production privacy validation must still reject the unsafe identifier',
  );
});

test('Mongo task execution claims fence stale workers and persist recovery idempotently', { skip: noMongoPartition, timeout: 30_000 }, async () => {
  await setupTestDatabase({ requireReplicaSet: true });
  const taskId = `phase7-lease-${crypto.randomUUID()}`;
  const context = caller();
  const storeA = new MongoResearchTaskStore({ env: { NODE_ENV: 'test' }, leaseMs: 3_000 });
  const storeB = new MongoResearchTaskStore({ env: { NODE_ENV: 'test' }, leaseMs: 3_000 });
  const storeC = new MongoResearchTaskStore({ env: { NODE_ENV: 'test' }, leaseMs: 3_000 });
  try {
    await migrateResearchTaskIndexes();
    const first = await storeA.prepareAndClaim(submittedTask(taskId), context, { messageId: `message-${taskId}` });
    assert.ok(first);
    assert.equal(await storeB.claimExecution(taskId, context, { messageId: `message-${taskId}` }), null, 'a live claim excludes another replica');

    await ResearchTask.collection.updateOne({ taskId }, { $set: { executionLeaseExpiresAt: new Date(0) } });
    await ResearchTaskCapacity.collection.updateOne(
      { _id: 'research-agent-global' },
      { $set: { 'activeLeases.$[lease].expiresAt': new Date(0) } },
      { arrayFilters: [{ 'lease.taskId': taskId, 'lease.token': first.lease.token }] },
    );
    assert.equal(await storeA.renewExecutionLease(taskId, context, first.lease), false, 'an expired worker cannot renew after its lease has elapsed');

    const second = await storeB.claimExecution(taskId, context, { messageId: `message-${taskId}` });
    assert.ok(second);
    assert.equal(second.lease.fence, first.lease.fence + 1, 'lease takeover advances the monotonic fencing token');
    await assert.rejects(
      storeA.saveClaimed({ ...first.task, status: { state: TaskState.TASK_STATE_COMPLETED, timestamp: new Date().toISOString() } }, first.lease),
      error => error.code === 'A2A_TASK_EXECUTION_LEASE_LOST',
    );

    const artifact = { artifactId: `artifact-${taskId}`, parts: [{ content: { $case: 'data', value: { contentHash: 'first' } } }] };
    const checkpoint = structuredClone(second.task);
    checkpoint.status = { state: TaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString() };
    checkpoint.artifacts = [artifact];
    await storeB.saveClaimed(checkpoint, second.lease);

    await ResearchTask.collection.updateOne({ taskId }, { $set: { executionLeaseExpiresAt: new Date(0) } });
    await ResearchTaskCapacity.collection.updateOne(
      { _id: 'research-agent-global' },
      { $set: { 'activeLeases.$[lease].expiresAt': new Date(0) } },
      { arrayFilters: [{ 'lease.taskId': taskId, 'lease.token': second.lease.token }] },
    );
    const recovered = await storeC.claimNextRecoverable();
    assert.ok(recovered);
    assert.equal(recovered.taskId, taskId);
    assert.equal(recovered.lease.messageId, `message-${taskId}`);
    const replayed = structuredClone(recovered.task);
    replayed.artifacts.push({ ...artifact, parts: [{ content: { $case: 'data', value: { contentHash: 'recovered' } } }] });
    replayed.status = { state: TaskState.TASK_STATE_COMPLETED, timestamp: new Date().toISOString() };
    await storeC.saveClaimed(replayed, recovered.lease);

    const reloaded = await new MongoResearchTaskStore({ env: { NODE_ENV: 'test' } }).load(taskId, context);
    assert.equal(reloaded.status.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal(reloaded.artifacts.length, 1, 'stable artifact identity makes recovery persistence idempotent');
    assert.equal(reloaded.artifacts[0].parts[0].content.value.contentHash, 'recovered');
    assert.equal(await storeC.renewClaimedExecutionLease(taskId, recovered.lease), false, 'terminal task state clears the active lease');
  } finally {
    await ResearchTask.collection.deleteOne({ taskId });
    await ResearchTaskCapacity.collection.deleteOne({ _id: 'research-agent-global' });
    await teardownTestDatabase();
  }
});

test('Mongo global ResearchAgent capacity admits only its configured cross-replica limit and releases on completion', { skip: noMongoPartition, timeout: 30_000 }, async () => {
  await setupTestDatabase({ requireReplicaSet: true });
  const context = caller();
  const firstId = `phase7-capacity-a-${crypto.randomUUID()}`;
  const secondId = `phase7-capacity-b-${crypto.randomUUID()}`;
  const stores = [
    new MongoResearchTaskStore({ env: { NODE_ENV: 'test' }, leaseMs: 3_000, maxActiveTasks: 1 }),
    new MongoResearchTaskStore({ env: { NODE_ENV: 'test' }, leaseMs: 3_000, maxActiveTasks: 1 }),
  ];
  try {
    await migrateResearchTaskIndexes({ maxActiveTasks: 1 });
    const [first, second] = await Promise.all([
      stores[0].prepareAndClaim(submittedTask(firstId, 'Verify the current official savings rate'), context),
      stores[1].prepareAndClaim(submittedTask(secondId, 'Verify the current official deposit rate'), context),
    ]);
    const claims = [first, second].filter(item => item?.lease);
    const queued = [first, second].find(item => item?.capacityUnavailable);
    assert.equal(claims.length, 1, 'one Mongo-backed capacity lease is admitted across stores');
    assert.ok(queued, 'the other valid task remains durably queued');

    const winner = claims[0];
    const winnerStore = stores[winner.task.id === firstId ? 0 : 1];
    const finished = structuredClone(winner.task);
    finished.status = { state: TaskState.TASK_STATE_COMPLETED, timestamp: new Date().toISOString() };
    finished.artifacts = [{ artifactId: `artifact-${winner.task.id}`, parts: [] }];
    await winnerStore.saveClaimed(finished, winner.lease);

    const queuedId = winner.task.id === firstId ? secondId : firstId;
    const queuedStore = stores[queuedId === firstId ? 0 : 1];
    const promoted = await queuedStore.claimExecution(queuedId, context, { messageId: `message-${queuedId}` });
    assert.ok(promoted?.lease, 'capacity is available after the first task commits terminal state');
    const completedQueued = structuredClone(promoted.task);
    completedQueued.status = { state: TaskState.TASK_STATE_COMPLETED, timestamp: new Date().toISOString() };
    await queuedStore.saveClaimed(completedQueued, promoted.lease);

    const capacity = await ResearchTaskCapacity.collection.findOne({ _id: 'research-agent-global' });
    assert.equal(capacity.maxActiveTasks, 1);
    assert.equal(capacity.activeLeases.length, 0, 'terminal completion releases both global capacity reservations');
  } finally {
    await ResearchTask.collection.deleteMany({ taskId: { $in: [firstId, secondId] } });
    await ResearchTaskCapacity.collection.deleteOne({ _id: 'research-agent-global' });
    await teardownTestDatabase();
  }
});

test('Mongo semantic ResearchBrief deduplication is owner-scoped and ignores transport IDs/timestamps', { skip: noMongoPartition, timeout: 30_000 }, async () => {
  await setupTestDatabase({ requireReplicaSet: true });
  const taskId = `phase7-dedupe-${crypto.randomUUID()}`;
  const sameOwner = caller();
  const otherOwner = { user: { identity: { provider: 'development', authenticated: true, subject: 'different-plan-review', agentType: 'PLAN_REVIEW' } } };
  const store = new MongoResearchTaskStore({ env: { NODE_ENV: 'test' }, maxActiveTasks: 4 });
  const storeOther = new MongoResearchTaskStore({ env: { NODE_ENV: 'test' }, maxActiveTasks: 4 });
  try {
    await migrateResearchTaskIndexes({ maxActiveTasks: 4 });
    const source = await store.prepareAndClaim(submittedTask(taskId), sameOwner);
    const completed = structuredClone(source.task);
    completed.artifacts = [{ artifactId: `artifact-${taskId}`, parts: [{ content: { $case: 'data', value: { financialAuthorityDelta: 0 } } }] }];
    completed.status = { state: TaskState.TASK_STATE_COMPLETED, timestamp: new Date().toISOString() };
    await store.saveClaimed(completed, source.lease);

    const duplicate = submittedTask(`phase7-dedupe-retry-${crypto.randomUUID()}`);
    const originalBrief = duplicate.history[0].parts[0].content.value;
    duplicate.history[0].messageId = `different-message-${crypto.randomUUID()}`;
    duplicate.history[0].taskId = duplicate.id;
    duplicate.history[0].parts[0].content.value = {
      ...originalBrief,
      researchBriefId: privacySafeBriefId(),
    };
    const replay = await store.prepareAndClaim(duplicate, sameOwner);
    assert.equal(replay.semanticDuplicateTaskId, taskId);

    const isolated = await storeOther.prepareAndClaim(submittedTask(`phase7-dedupe-owner-${crypto.randomUUID()}`), otherOwner);
    assert.ok(isolated.lease, 'identical semantic input from another owner executes independently');
    await storeOther.releaseExecutionLease(isolated.task.id, otherOwner, isolated.lease);

    const changed = await store.prepareAndClaim(submittedTask(`phase7-dedupe-changed-${crypto.randomUUID()}`, 'Verify a materially different current official tax rule'), sameOwner);
    assert.ok(changed.lease, 'a materially different question is not semantically deduplicated');
    await store.releaseExecutionLease(changed.task.id, sameOwner, changed.lease);
  } finally {
    await ResearchTask.collection.deleteMany({ taskId: { $regex: /^phase7-dedupe/ } });
    await ResearchTaskCapacity.collection.deleteOne({ _id: 'research-agent-global' });
    await teardownTestDatabase();
  }
});
