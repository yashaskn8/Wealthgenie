/**
 * idempotencyHttp.test.js — Integration test proving Idempotency-Key duplicate prevention
 * Verifies that mutating requests sent with the same Idempotency-Key return cached responses
 * with X-Cache-Lookup: HIT - Idempotent and do NOT duplicate database records.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';

import profileRoutes from '../routes/profile.js';
import goalsRoutes from '../routes/goals.js';
import recommendRoutes from '../routes/recommend.js';
import { errorHandler } from '../middleware/errorHandler.js';
import FinancialProfile from '../models/FinancialProfile.js';
import Goal from '../models/Goal.js';
import Recommendation from '../models/Recommendation.js';
import IdempotencyKey from '../models/IdempotencyKey.js';
import User from '../models/User.js';
import { setRedisAvailable, setRedisClient } from '../config/redis.js';
import { canonicalProfilePayload } from './helpers/canonicalProfile.js';
import { installFinancialStateTestHook } from '../services/financialStateTestHooks.js';
import { heartbeatMutationIdempotency, mutationOperationId, mutationRequestHash } from '../middleware/idempotency.js';
import { assertRuntimeResponseMatchesContract } from './helpers/openapiRuntimeContract.js';
import { PROFILE_BUILD_LIMIT } from '../services/profileRateLimit.js';

const JWT_SECRET = 'idempotency-test-secret-key';
process.env.JWT_SECRET = JWT_SECRET;
process.env.NODE_ENV = 'test';

let app;
let serverInstance;
let baseUrl;

function signToken(userId) {
  return jwt.sign(
    { userId, email: `user-${userId}@example.com`, jti: crypto.randomUUID() },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

async function createTestUser(userId = new mongoose.Types.ObjectId()) {
  const normalizedId = String(userId);
  await User.create({
    _id: normalizedId,
    name: 'Idempotency HTTP test user',
    email: `idempotency-${normalizedId}@example.test`,
    passwordHash: 'test-only-password-hash',
  });
  return normalizedId;
}

function createBarrier() {
  let markEntered;
  let open;
  const entered = new Promise(resolve => { markEntered = resolve; });
  const released = new Promise(resolve => { open = resolve; });
  return {
    entered,
    async pause() { markEntered(); await released; },
    release() { open(); },
  };
}

function createRendezvousBarrier(parties) {
  let arrivals = 0;
  let markAllArrived;
  let releaseAll;
  const allArrived = new Promise(resolve => { markAllArrived = resolve; });
  const released = new Promise(resolve => { releaseAll = resolve; });
  return {
    allArrived,
    get arrivals() { return arrivals; },
    async pause() {
      arrivals += 1;
      if (arrivals === parties) markAllArrived();
      await released;
    },
    release() { releaseAll(); },
  };
}

test.before(async () => {
  await setupTestDatabase({ requireReplicaSet: true });

  app = express();
  app.use(express.json());
  app.use('/api/profile', profileRoutes);
  app.use('/api/goals', goalsRoutes);
  app.use('/api/recommend', recommendRoutes);
  app.use(errorHandler);

  await new Promise((resolve) => {
    serverInstance = app.listen(0, '127.0.0.1', () => {
      const port = serverInstance.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (serverInstance) serverInstance.close();
  await teardownTestDatabase();
});

test('IDEMPOTENCY HTTP VERIFICATION: duplicate mutating request returns cached response without duplicate DB insert', async () => {
  const userId = await createTestUser();
  const token = signToken(userId);
  const idempotencyKey = crypto.randomUUID();

  const payload = canonicalProfilePayload({
    monthlyTakeHome: 150000,
    age: 30,
    monthlySavings: 50000,
    liquidSavings: 300000,
    financialDependents: 1,
  });

  // 1. Check DB record count before any requests
  const countBefore = await FinancialProfile.countDocuments({ userId });
  assert.equal(countBefore, 0, 'Database must have 0 records before first request');
  console.log(`[VERIFY] Database record count BEFORE request: ${countBefore}`);

  // 2. Send FIRST request with Idempotency-Key
  const res1 = await fetch(`${baseUrl}/api/profile/build`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(payload),
  });

  const body1Text = await res1.text();
  assert.ok(res1.status === 200 || res1.status === 201, `Expected 200/201, got ${res1.status}: ${body1Text}`);
  const data1 = JSON.parse(body1Text);
  assertRuntimeResponseMatchesContract({
    method: 'POST', path: '/api/profile/build', status: res1.status,
    contentType: res1.headers.get('content-type'), body: data1,
  });
  const countAfterFirst = await FinancialProfile.countDocuments({ userId });
  console.log(`[VERIFY] First request status: ${res1.status}`);
  console.log(`[VERIFY] Database record count AFTER first request: ${countAfterFirst}`);
  assert.equal(countAfterFirst, 1, 'Database must have exactly 1 record after first request');

  // 3. Send DUPLICATE request with the EXACT SAME Idempotency-Key
  const res2 = await fetch(`${baseUrl}/api/profile/build`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(payload),
  });

  const cacheHeader = res2.headers.get('x-cache-lookup');
  console.log(`[VERIFY] Duplicate request status: ${res2.status}, X-Cache-Lookup header: '${cacheHeader}'`);
  assert.ok(res2.status === 200 || res2.status === 201, `Expected 200/201 on cached response, got ${res2.status}`);
  assert.equal(cacheHeader, 'HIT - Idempotent', 'Second request must have X-Cache-Lookup: HIT - Idempotent header');

  const data2 = await res2.json();
  assertRuntimeResponseMatchesContract({
    method: 'POST', path: '/api/profile/build', status: res2.status,
    contentType: res2.headers.get('content-type'), body: data2,
  });
  assert.deepEqual(data2, data1, 'Cached duplicate response body must match original response');

  // 4. Confirm DB count AFTER duplicate request is STILL 1
  const countAfterDuplicate = await FinancialProfile.countDocuments({ userId });
  console.log(`[VERIFY] Database record count AFTER duplicate request: ${countAfterDuplicate}`);
  assert.equal(countAfterDuplicate, 1, 'Database record count must remain exactly 1 (increased by 1 total, NOT 2)');

  // /profile/build creates a draft only. Establish canonical current state via
  // the explicit completion boundary before recommendation-dependent requests.
  const completionResponse = await fetch(`${baseUrl}/api/profile/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify(payload),
  });
  const completionBody = await completionResponse.json();
  assert.equal(completionResponse.status, 200, JSON.stringify(completionBody));
  assert.notEqual(completionBody.profile.profileId, data1.profileId);
  assert.equal(await FinancialProfile.countDocuments({ userId }), 2);

  const changedPayload = { ...payload, age: payload.age + 1 };
  const conflict = await fetch(`${baseUrl}/api/profile/build`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(changedPayload),
  });
  const conflictBody = await conflict.json();
  assert.equal(conflict.status, 409);
  assert.equal(conflictBody.code, 'IDEMPOTENCY_PAYLOAD_CONFLICT');
  assertRuntimeResponseMatchesContract({
    method: 'POST', path: '/api/profile/build', status: conflict.status,
    contentType: conflict.headers.get('content-type'), body: conflictBody,
  });
  assert.equal(await FinancialProfile.countDocuments({ userId }), 2);

  const recommendationResponse = await fetch(`${baseUrl}/api/recommend`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({ profileId: completionBody.profile.profileId }),
  });
  const recommendationBody = await recommendationResponse.json();
  assert.ok([200, 201].includes(recommendationResponse.status), JSON.stringify(recommendationBody));
  assert.equal(await Recommendation.countDocuments({ userId }), 2);

  const otherOperation = await fetch(`${baseUrl}/api/goals/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      goal_name: 'Operation-scope check', target_amount: 100000, target_date: '2035-01-01',
      current_savings: 10000, profileId: completionBody.profile.profileId, priority: 'High',
    }),
  });
  const otherBody = await otherOperation.json();
  assert.equal(otherOperation.status, 201, JSON.stringify(otherBody));
  assertRuntimeResponseMatchesContract({
    method: 'POST', path: '/api/goals/create', status: otherOperation.status,
    contentType: otherOperation.headers.get('content-type'), body: otherBody,
  });
  assert.notEqual(otherOperation.headers.get('x-cache-lookup'), 'HIT - Idempotent');
  assert.ok(otherBody.goal?._id || otherBody.goal?.goalId, 'goal operation must create and return its own resource');
  assert.equal(await FinancialProfile.countDocuments({ userId }), 2);
  assert.equal(await Goal.countDocuments({ userId }), 1);
  assert.equal(await Recommendation.countDocuments({ userId }), 2);

  const profileOperation = await IdempotencyKey.findById(mutationOperationId({
    operation: 'profile.build', userId, key: idempotencyKey,
  })).lean();
  const goalOperation = await IdempotencyKey.findById(mutationOperationId({
    operation: 'goals.create', userId, key: idempotencyKey,
  })).lean();
  assert.ok(profileOperation);
  assert.ok(goalOperation);
  assert.notEqual(profileOperation._id, goalOperation._id);
  assert.notEqual(profileOperation.requestHash, goalOperation.requestHash);
  assert.equal(profileOperation.status, 'DONE');
  assert.equal(profileOperation.resourceType, 'FinancialProfile');
  assert.equal(String(profileOperation.resourceId), data1.profileId);
  assert.equal(goalOperation.status, 'DONE');
  assert.equal(goalOperation.resourceType, 'Goal');
  assert.equal(String(goalOperation.resourceId), String(otherBody.goal._id || otherBody.goal.goalId));
});

test('durable idempotency operation identity cannot be rewritten after claim creation', async () => {
  const userId = new mongoose.Types.ObjectId();
  const operationId = `identity-test:${crypto.randomUUID()}`;
  const requestHash = 'a'.repeat(64);
  await IdempotencyKey.create({
    _id: operationId,
    status: 'LOCK',
    operation: 'goal.create',
    method: 'POST',
    userId,
    requestHash,
  });

  await assert.rejects(
    IdempotencyKey.updateOne({ _id: operationId }, { $set: { operation: 'profile.build' } }),
    error => error.code === 'IDEMPOTENCY_IDENTITY_IMMUTABLE',
  );
  await assert.rejects(
    IdempotencyKey.updateOne({ _id: operationId }, { $set: { requestHash: 'b'.repeat(64) } }),
    error => error.code === 'IDEMPOTENCY_IDENTITY_IMMUTABLE',
  );
  await assert.rejects(
    IdempotencyKey.updateOne({ _id: operationId }, { $set: { method: 'PATCH' } }),
    error => error.code === 'IDEMPOTENCY_IDENTITY_IMMUTABLE',
  );
  await assert.rejects(
    IdempotencyKey.updateOne({ _id: operationId }, { $set: { userId: new mongoose.Types.ObjectId() } }),
    error => error.code === 'IDEMPOTENCY_IDENTITY_IMMUTABLE',
  );
  const stored = await IdempotencyKey.findById(operationId).lean();
  assert.equal(stored.operation, 'goal.create');
  assert.equal(stored.method, 'POST');
  assert.equal(String(stored.userId), String(userId));
  assert.equal(stored.requestHash, requestHash);

  // Lifecycle/recovery fields remain mutable; only identity fields are frozen.
  await IdempotencyKey.updateOne({ _id: operationId }, {
    $set: {
      status: 'DONE',
      lockOwnerId: null,
      resourceType: 'Goal',
      resourceId: new mongoose.Types.ObjectId(),
      committedAt: new Date(),
    },
  });
  assert.equal((await IdempotencyKey.findById(operationId).lean()).status, 'DONE');
  await IdempotencyKey.deleteOne({ _id: operationId });
});

test('operation identity and request hash bind operation, method, route, resource scope, query, and payload', () => {
  const identity = { operation: 'profile.build', userId: 'user-1', key: 'shared-key-2026' };
  assert.notEqual(
    mutationOperationId(identity),
    mutationOperationId({ ...identity, operation: 'goals.create' }),
  );
  assert.notEqual(
    mutationOperationId(identity),
    mutationOperationId({ ...identity, userId: 'user-2' }),
  );
  const request = { method: 'PATCH', path: '/api/goals/goal-a', params: { goalId: 'goal-a' }, query: {}, body: { version: 3 } };
  const baseHash = mutationRequestHash(request, 'goals.update', identity.userId);
  assert.notEqual(baseHash, mutationRequestHash(request, 'goals.update', 'user-2'));
  assert.notEqual(baseHash, mutationRequestHash({ ...request, params: { goalId: 'goal-b' }, path: '/api/goals/goal-b' }, 'goals.update', identity.userId));
  assert.notEqual(baseHash, mutationRequestHash({ ...request, method: 'PUT' }, 'goals.update', identity.userId));
  assert.notEqual(baseHash, mutationRequestHash({ ...request, body: { version: 4 } }, 'goals.update', identity.userId));
  assert.notEqual(baseHash, mutationRequestHash({ ...request, query: { mode: 'preview' } }, 'goals.update', identity.userId));
});

test('financial profile ownership cannot be rewritten through save, updateOne, or findOneAndUpdate', async () => {
  const userId = await createTestUser();
  const response = await fetch(`${baseUrl}/api/profile/build`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${signToken(userId)}`,
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify(canonicalProfilePayload({ age: 39, monthlyTakeHome: 175000, monthlySavings: 52000 })),
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  try {
    const otherOwner = new mongoose.Types.ObjectId();
    await assert.rejects(FinancialProfile.updateOne(
      { _id: body.profileId, userId }, { $set: { userId: otherOwner } },
    ), error => error.code === 'FINANCIAL_PROFILE_IDENTITY_IMMUTABLE');
    await assert.rejects(FinancialProfile.findOneAndUpdate(
      { _id: body.profileId, userId }, { $set: { userId: otherOwner } },
    ), error => error.code === 'FINANCIAL_PROFILE_IDENTITY_IMMUTABLE');
    const document = await FinancialProfile.findById(body.profileId);
    await assert.rejects((async () => {
      document.userId = otherOwner;
      await document.save();
    })(), /immutable/i);
    assert.equal(String((await FinancialProfile.findById(body.profileId).lean()).userId), userId);
  } finally {
    const profile = await FinancialProfile.findById(body.profileId).lean();
    await Promise.all([
      FinancialProfile.deleteOne({ _id: body.profileId, userId }),
      ...(profile?.idempotencyOperationId ? [IdempotencyKey.deleteOne({ _id: profile.idempotencyOperationId })] : []),
    ]);
  }
});

test('crash-equivalent response loss after profile commit replays the committed resource', async () => {
  const userId = await createTestUser();
  const token = signToken(userId);
  const key = crypto.randomUUID();
  const payload = canonicalProfilePayload({ age: 38, monthlyTakeHome: 190000, monthlySavings: 60000 });
  const uninstall = installFinancialStateTestHook(async boundary => {
    if (boundary === 'profile.build.afterCommitBeforeResponse') throw new Error('SIMULATED_PROCESS_CRASH_AFTER_COMMIT');
  });
  let first;
  try {
    first = await fetch(`${baseUrl}/api/profile/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': key },
      body: JSON.stringify(payload),
    });
  } finally {
    uninstall();
  }
  assert.equal(first.status, 500, 'the simulated lost response is not misreported as a pre-commit success');
  assert.equal(await FinancialProfile.countDocuments({ userId }), 1, 'business mutation committed exactly once');

  const replay = await fetch(`${baseUrl}/api/profile/build`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': key },
    body: JSON.stringify(payload),
  });
  const replayBody = await replay.json();
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get('x-cache-lookup'), 'HIT - Idempotent');
  assert.equal(await FinancialProfile.countDocuments({ userId }), 1);
  const committedProfile = await FinancialProfile.findOne({ userId }).lean();
  assert.equal(String(replayBody.profileId), String(committedProfile._id));
  const operationId = mutationOperationId({ operation: 'profile.build', userId, key });
  const operation = await IdempotencyKey.findById(operationId).lean();
  assert.equal(operation.status, 'DONE', 'same-key recovery durably completes the operation record');
  assert.equal(operation.resourceType, 'FinancialProfile');
  assert.equal(String(operation.resourceId), String(committedProfile._id));
  assert.equal(operation.requestHash, committedProfile.idempotencyRequestHash);
});

test('same idempotency key is isolated by authenticated user identity', async () => {
  const userA = await createTestUser();
  const userB = await createTestUser();
  const key = 'same-key-across-users-2026';
  const payload = canonicalProfilePayload({ age: 41, monthlyTakeHome: 210000, monthlySavings: 70000 });
  const build = (userId) => fetch(`${baseUrl}/api/profile/build`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${signToken(userId)}`,
      'Idempotency-Key': key,
    },
    body: JSON.stringify(payload),
  });

  const [responseA, responseB] = await Promise.all([build(userA), build(userB)]);
  const [bodyA, bodyB] = await Promise.all([responseA.json(), responseB.json()]);
  assert.equal(responseA.status, 201, JSON.stringify(bodyA));
  assert.equal(responseB.status, 201, JSON.stringify(bodyB));
  assert.notEqual(String(bodyA.profileId), String(bodyB.profileId));
  assert.equal(await FinancialProfile.countDocuments({ userId: userA }), 1);
  assert.equal(await FinancialProfile.countDocuments({ userId: userB }), 1);
});

test('missing, malformed, short, and oversized idempotency keys fail before profile mutation', async () => {
  const userId = await createTestUser();
  const token = signToken(userId);
  const payload = canonicalProfilePayload({ age: 36, monthlyTakeHome: 180000, monthlySavings: 55000 });
  const invalidKeys = [undefined, 'short', 'invalid/key-123', 'x'.repeat(129)];
  for (const key of invalidKeys) {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    if (key !== undefined) headers['Idempotency-Key'] = key;
    const response = await fetch(`${baseUrl}/api/profile/build`, {
      method: 'POST', headers, body: JSON.stringify(payload),
    });
    const body = await response.json();
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(body.code, 'INVALID_IDEMPOTENCY_KEY');
    assert.equal(typeof body.request_id, 'string');
  }
  assert.equal(await FinancialProfile.countDocuments({ userId }), 0);
});

test('same-key concurrent profile requests wait for the transactional durable completion', async () => {
  const userId = await createTestUser();
  const token = signToken(userId);
  const key = 'concurrent-profile-operation-2026';
  const payload = canonicalProfilePayload({ age: 44, monthlyTakeHome: 240000, monthlySavings: 80000 });
  const insertBarrier = createBarrier();
  let markLockObserved;
  const lockObserved = new Promise(resolve => { markLockObserved = resolve; });
  let inserted = false;
  let observed = false;
  const uninstall = installFinancialStateTestHook(async (boundary, context) => {
    if (boundary === 'profile.build.afterInsertBeforeCommit' && !inserted) {
      inserted = true;
      assert.equal(context.transactionActive, true);
      await insertBarrier.pause();
    }
    if (boundary === 'idempotency.mutation.lockObserved'
        && context.operation === 'profile.build'
        && !observed) {
      observed = true;
      markLockObserved();
    }
  });
  const send = () => fetch(`${baseUrl}/api/profile/build`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': key,
    },
    body: JSON.stringify(payload),
  });
  const firstPending = send();
  try {
    await insertBarrier.entered;
    const secondPending = send();
    await lockObserved;
    insertBarrier.release();
    const [first, second] = await Promise.all([firstPending, secondPending]);
    const [firstBody, secondBody] = await Promise.all([first.json(), second.json()]);
    assert.equal(first.status, 201, JSON.stringify(firstBody));
    assert.equal(second.status, 201, JSON.stringify(secondBody));
    assert.equal(await FinancialProfile.countDocuments({ userId }), 1);
    assert.equal(String(firstBody.profileId), String(secondBody.profileId));
    assert.equal(second.headers.get('x-cache-lookup'), 'HIT - Idempotent');
  } finally {
    insertBarrier.release();
    uninstall();
  }
});

test('expired idempotency lease takeover fences the paused old worker and keeps one committed profile', async () => {
  const userId = await createTestUser();
  const token = signToken(userId);
  const key = 'expired-lease-takeover-profile-2026';
  const payload = canonicalProfilePayload({ age: 41, monthlyTakeHome: 210000, monthlySavings: 70000 });
  const oldWorkerBarrier = createBarrier();
  const takeoverBarrier = createRendezvousBarrier(2);
  let paused = false;
  let takeoverInsertCount = 0;
  const observedLeaseStates = [];
  const uninstall = installFinancialStateTestHook(async (boundary, context) => {
    if (boundary === 'profile.build.afterIdempotencyClaimBeforeTransaction' && !paused) {
      paused = true;
      await oldWorkerBarrier.pause();
    }
    if (boundary === 'idempotency.mutation.lockObserved' && context.operation === 'profile.build') {
      observedLeaseStates.push({ status: context.status, leaseExpiresAt: new Date(context.leaseExpiresAt).getTime() });
      await takeoverBarrier.pause();
    }
    if (boundary === 'profile.build.afterInsertBeforeCommit') takeoverInsertCount += 1;
  });
  const send = () => fetch(`${baseUrl}/api/profile/build`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': key,
    },
    body: JSON.stringify(payload),
  });

  const staleWorker = send();
  try {
    await oldWorkerBarrier.entered;
    const operation = await IdempotencyKey.findOne({ userId, operation: 'profile.build' });
    assert.ok(operation);
    assert.equal(operation.status, 'LOCK');
    await IdempotencyKey.updateOne({ _id: operation._id, status: 'LOCK' }, {
      $set: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });

    const takeoverPromises = [send(), send()];
    await takeoverBarrier.allArrived;
    assert.equal(takeoverBarrier.arrivals, 2, 'both contenders reached the stale-lock decision boundary');
    assert.equal(observedLeaseStates.length, 2);
    assert.ok(observedLeaseStates.every(({ status, leaseExpiresAt }) => status === 'LOCK' && leaseExpiresAt <= Date.now()),
      'both reclaimers must observe the same expired lease before CAS');
    takeoverBarrier.release();
    const [takeoverA, takeoverB] = await Promise.all(takeoverPromises);
    const [takeoverABody, takeoverBBody] = await Promise.all([takeoverA.json(), takeoverB.json()]);
    assert.equal(takeoverA.status, 201, JSON.stringify(takeoverABody));
    assert.equal(takeoverB.status, 201, JSON.stringify(takeoverBBody));
    assert.equal(String(takeoverABody.profileId), String(takeoverBBody.profileId));

    oldWorkerBarrier.release();
    const staleResponse = await staleWorker;
    const staleBody = await staleResponse.json();
    assert.equal(staleResponse.status, 201, JSON.stringify(staleBody));
    assert.equal(String(staleBody.profileId), String(takeoverABody.profileId));
    assert.equal(staleResponse.headers.get('x-cache-lookup'), 'HIT - Idempotent');
    assert.equal(takeoverInsertCount, 1, 'only the CAS lease winner may enter the profile-create transaction');

    const [profiles, completedOperation] = await Promise.all([
      FinancialProfile.find({ userId }).lean(),
      IdempotencyKey.findById(operation._id).lean(),
    ]);
    assert.equal(profiles.length, 1);
    assert.equal(completedOperation.status, 'DONE');
    assert.equal(String(completedOperation.resourceId), String(profiles[0]._id));
  } finally {
    oldWorkerBarrier.release();
    uninstall();
  }
});

test('heartbeat storage failure marks the real claim lost and aborts profile creation before commit', async () => {
  const previousUpdateOne = IdempotencyKey.updateOne;
  const userId = await createTestUser();
  const key = 'heartbeat-storage-failure-profile-2026';
  let markReleased;
  const releaseObserved = new Promise(resolve => { markReleased = resolve; });
  let claimLostAtInsertBoundary = false;
  const uninstall = installFinancialStateTestHook(async (boundary, context) => {
    if (boundary === 'profile.build.afterInsertBeforeCommit') {
      assert.equal(context.transactionActive, true, 'the injected failure occurs inside the live Mongo transaction');
      assert.equal(await heartbeatMutationIdempotency(context.idempotencyClaim), false);
      claimLostAtInsertBoundary = context.idempotencyClaim.lost === true;
    }
    if (boundary === 'idempotency.mutation.released' && context.operation === 'profile.build') {
      markReleased();
    }
  });
  IdempotencyKey.updateOne = function failLeaseRefresh(filter, update, options) {
    if (update?.$set?.leaseExpiresAt instanceof Date && !options?.session) {
      throw new Error('simulated idempotency heartbeat database failure');
    }
    return previousUpdateOne.call(this, filter, update, options);
  };

  const send = () => fetch(`${baseUrl}/api/profile/build`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${signToken(userId)}`,
      'Idempotency-Key': key,
    },
    body: JSON.stringify(canonicalProfilePayload({ age: 37, monthlyTakeHome: 185000, monthlySavings: 57000 })),
  });
  try {
    const failed = await send();
    const failedBody = await failed.json();
    assert.equal(failed.status, 503, JSON.stringify(failedBody));
    assertRuntimeResponseMatchesContract({
      method: 'POST', path: '/api/profile/build', status: failed.status,
      contentType: failed.headers.get('content-type'), body: failedBody,
    });
    assert.equal(failedBody.code, 'IDEMPOTENCY_UNAVAILABLE');
    assert.equal(claimLostAtInsertBoundary, true);
    assert.equal(await FinancialProfile.countDocuments({ userId }), 0, 'transaction rollback removes the inserted profile');
    await releaseObserved;
    assert.equal(await IdempotencyKey.countDocuments({ userId, operation: 'profile.build', status: 'DONE' }), 0);

    IdempotencyKey.updateOne = previousUpdateOne;
    uninstall();
    const recovered = await send();
    const recoveredBody = await recovered.json();
    assert.equal(recovered.status, 201, JSON.stringify(recoveredBody));
    assert.equal(await FinancialProfile.countDocuments({ userId }), 1, 'same-key retry can safely recover after aborted transaction');
  } finally {
    IdempotencyKey.updateOne = previousUpdateOne;
    uninstall();
  }
});

test('profile build fails closed before mutation when Redis quota execution fails', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const userId = await createTestUser();
  const token = signToken(userId);
  process.env.NODE_ENV = 'production';
  setRedisAvailable(true);
  setRedisClient({
    async get() { return null; }, // JWT revocation lookup succeeds and finds no blacklist entry.
    async eval() { throw new Error('simulated Redis command failure'); },
  });
  try {
    const response = await fetch(`${baseUrl}/api/profile/build`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify(canonicalProfilePayload({ age: 38, monthlyTakeHome: 190000, monthlySavings: 60000 })),
    });
    const body = await response.json();
    assert.equal(response.status, 503, JSON.stringify(body));
    assertRuntimeResponseMatchesContract({
      method: 'POST', path: '/api/profile/build', status: response.status,
      contentType: response.headers.get('content-type'), body,
    });
    assert.equal(body.code, 'PROFILE_RATE_LIMIT_UNAVAILABLE');
    assert.equal(typeof body.request_id, 'string');
    assert.equal(await FinancialProfile.countDocuments({ userId }), 0);
  } finally {
    setRedisAvailable(false);
    setRedisClient(null);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('profile build returns an OpenAPI-valid 429 and releases its uncommitted idempotency claim', async () => {
  const previousDisableRateLimit = process.env.DISABLE_RATE_LIMIT;
  const userId = await createTestUser();
  const token = signToken(userId);
  const key = 'profile-rate-limit-exceeded-2026';
  let markReleased;
  const claimReleased = new Promise(resolve => { markReleased = resolve; });
  const uninstall = installFinancialStateTestHook(async (boundary, context) => {
    if (boundary === 'idempotency.mutation.released'
        && context.operation === 'profile.build'
        && context.deletedCount === 1) {
      markReleased();
    }
  });
  // Keep NODE_ENV=test so deterministic financial-state hooks remain active,
  // while explicitly enabling this route's production quota behavior.
  process.env.DISABLE_RATE_LIMIT = 'false';
  setRedisAvailable(true);
  setRedisClient({
    async get() { return null; }, // JWT revocation lookup succeeds and finds no blacklist entry.
    async eval() { return PROFILE_BUILD_LIMIT + 1; },
  });

  try {
    const response = await fetch(`${baseUrl}/api/profile/build`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': key,
      },
      body: JSON.stringify(canonicalProfilePayload({ age: 38, monthlyTakeHome: 190000, monthlySavings: 60000 })),
    });
    const body = await response.json();
    assert.equal(response.status, 429, JSON.stringify(body));
    assertRuntimeResponseMatchesContract({
      method: 'POST', path: '/api/profile/build', status: response.status,
      contentType: response.headers.get('content-type'), body,
    });
    assert.equal(body.code, 'PROFILE_RATE_LIMIT_EXCEEDED');
    assert.equal(typeof body.request_id, 'string');
    await claimReleased;
    assert.equal(await FinancialProfile.countDocuments({ userId }), 0, 'rate-limited profile is never persisted');
    assert.equal(await IdempotencyKey.countDocuments({ userId, operation: 'profile.build' }), 0,
      'the uncommitted operation claim is released rather than left as a replayable mutation');
  } finally {
    uninstall();
    setRedisAvailable(false);
    setRedisClient(null);
    if (previousDisableRateLimit === undefined) delete process.env.DISABLE_RATE_LIMIT;
    else process.env.DISABLE_RATE_LIMIT = previousDisableRateLimit;
  }
});
