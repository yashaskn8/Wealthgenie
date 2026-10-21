/**
 * Tier 1 — Concurrency Control Integration Tests
 *
 * Tests:
 *   1. Optimistic Concurrency Control (OCC) on FinancialProfile updates (API route)
 *   2. OCC via Mongoose VersionError on concurrent .save()
 *   3. Idempotency-Key deduplication on POST /api/profile/build
 *
 * Requires: a transaction-capable MongoDB instance supplied by the test environment.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import profileRoutes from '../routes/profile.js';
import goalsRoutes from '../routes/goals.js';
import { errorHandler } from '../middleware/errorHandler.js';
import FinancialProfile from '../models/FinancialProfile.js';
import RecommendationState from '../models/RecommendationState.js';
import User from '../models/User.js';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';
import { canonicalProfile, canonicalProfilePayload } from './helpers/canonicalProfile.js';
import { assertRuntimeResponseMatchesContract } from './helpers/openapiRuntimeContract.js';

process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.NODE_ENV = 'test';

const TEST_USER_ID = new mongoose.Types.ObjectId().toString();
const TEST_USER_ID_2 = new mongoose.Types.ObjectId().toString();

function signToken(userId) {
  return jwt.sign(
    { userId, email: `${userId}@test.com`, jti: crypto.randomUUID() },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/profile', profileRoutes);
  app.use('/api/goals', goalsRoutes);
  app.use(errorHandler);
  return app;
}

async function withServer(fn) {
  const server = buildApp().listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

const VALID_PROFILE_BODY = canonicalProfilePayload({
  monthlyTakeHome: 80000, monthlySavings: 20000, age: 30,
  liquidSavings: 100000, investmentHorizonYears: 15,
});

// ── Setup ─────────────────────────────────────────────────────────────
async function ensureDb() {
  await setupTestDatabase({ requireReplicaSet: true });
  await User.updateOne(
    { _id: TEST_USER_ID },
    { $setOnInsert: { name: 'Concurrency Test User 1', email: `concurrency-${TEST_USER_ID}@test.local`, passwordHash: 'test-only-hash' } },
    { upsert: true },
  );
  await User.updateOne(
    { _id: TEST_USER_ID_2 },
    { $setOnInsert: { name: 'Concurrency Test User 2', email: `concurrency-${TEST_USER_ID_2}@test.local`, passwordHash: 'test-only-hash' } },
    { upsert: true },
  );
}

test.after(async () => {
  try {
    await User.deleteMany({ _id: { $in: [TEST_USER_ID, TEST_USER_ID_2] } });
  } finally {
    await teardownTestDatabase();
  }
});


// ── Test 1: OCC rejects stale-version profile updates with 409 ────────
test('OCC: PUT /api/profile/:id with stale version returns 409 Conflict', async (t) => {
  await ensureDb();
  const token = signToken(TEST_USER_ID);

  t.after(async () => {
    await FinancialProfile.deleteMany({ userId: TEST_USER_ID });
  });

  await withServer(async (baseUrl) => {
    // /profile/build creates a draft. Promote it through the explicit
    // completion boundary before testing current-profile OCC behavior.
    const { response: createRes, body: createBody } = await jsonFetch(
      `${baseUrl}/api/profile/complete`,
      {
        method: 'POST',
        body: JSON.stringify(VALID_PROFILE_BODY),
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': crypto.randomUUID() },
      }
    );

    assert.equal(createRes.status, 200, `Profile completion failed: ${JSON.stringify(createBody)}`);
    assertRuntimeResponseMatchesContract({
      method: 'POST', path: '/api/profile/complete', status: createRes.status,
      contentType: createRes.headers.get('content-type'), body: createBody,
    });
    const profileId = createBody.profile.profileId;
    const initialVersion = createBody.profile.version;
    assert.ok(profileId, 'profileId must be returned');

    const currentProfile = await jsonFetch(`${baseUrl}/api/profile/current`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(currentProfile.response.status, 200);
    assertRuntimeResponseMatchesContract({
      method: 'GET', path: '/api/profile/current', status: currentProfile.response.status,
      contentType: currentProfile.response.headers.get('content-type'), body: currentProfile.body,
    });

    const recommendationState = await RecommendationState.findOne({ userId: TEST_USER_ID, profileId }).lean();
    assert.ok(recommendationState, 'completed profile fixture must have a recommendation state');
    await RecommendationState.deleteOne({ _id: recommendationState._id });
    try {
      const profileWithoutRecommendationState = await jsonFetch(`${baseUrl}/api/profile/current`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(profileWithoutRecommendationState.response.status, 200, JSON.stringify(profileWithoutRecommendationState.body));
      assert.equal(profileWithoutRecommendationState.body.profileId, profileId);
    } finally {
      await RecommendationState.create(recommendationState);
    }

    // The retired indicator endpoint must not expose profile information.
    const retiredHealth = await jsonFetch(`${baseUrl}/api/profile/${profileId}/health-score`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(retiredHealth.response.status, 404);

    // 2. First update — should succeed (version 1 → 2)
    const { response: update1Res, body: update1Body } = await jsonFetch(
      `${baseUrl}/api/profile/${profileId}`,
      {
        method: 'PUT',
        body: JSON.stringify({ ...VALID_PROFILE_BODY, monthly_take_home: 90000, monthly_savings: 25000, version: initialVersion }),
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': crypto.randomUUID() },
      }
    );

    assert.equal(update1Res.status, 200, `First update failed: ${JSON.stringify(update1Body)}`);
    assertRuntimeResponseMatchesContract({
      method: 'PUT', path: '/api/profile/{profileId}', status: update1Res.status,
      contentType: update1Res.headers.get('content-type'), body: update1Body,
    });
    const updatedProfile = await FinancialProfile.findById(profileId).lean();
    assert.equal(updatedProfile.version, initialVersion + 1);
    assert.equal(updatedProfile.financialStateFence, 1, 'profile update must advance its fence in the recommendation transaction');
    assert.equal(update1Body.profile.version, initialVersion + 1);
    assert.equal(update1Body.recommendation.profile_version, update1Body.profile.version);
    assert.equal(update1Body.recommendation.response_state, 'CURRENT');

    // 3. Second update with STALE version (version 1) — should get 409
    const { response: update2Res, body: update2Body } = await jsonFetch(
      `${baseUrl}/api/profile/${profileId}`,
      {
        method: 'PUT',
        body: JSON.stringify({ ...VALID_PROFILE_BODY, monthly_take_home: 100000, monthly_savings: 30000, version: initialVersion }),
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': crypto.randomUUID() },
      }
    );

    assert.equal(update2Res.status, 409, `Expected 409 Conflict but got ${update2Res.status}: ${JSON.stringify(update2Body)}`);
    assertRuntimeResponseMatchesContract({
      method: 'PUT', path: '/api/profile/{profileId}', status: update2Res.status,
      contentType: update2Res.headers.get('content-type'), body: update2Body,
    });
    assert.match(update2Body.message, /version conflict/i);

    // 4. Verify the DB still has the value from update 1 (90000), not update 2 (100000)
    const profile = await FinancialProfile.findById(profileId).lean();
    assert.equal(profile.monthlyTakeHome, 90000, 'DB should reflect first update, not stale second update');
  });
});

// ── Test 2: OCC via Mongoose VersionError on concurrent .save() ───────
test('OCC: concurrent .save() on same profile triggers VersionError', async (t) => {
  await ensureDb();

  // Create a profile directly in DB
  const profile = await FinancialProfile.create({
    userId: TEST_USER_ID,
    ...canonicalProfile({ monthlyTakeHome: 60000, monthlySavings: 15000, age: 28 }),
    recommendationProfileVersion: 'financial-profile-1.0.0',
  });

  t.after(async () => {
    await FinancialProfile.deleteOne({ _id: profile._id });
  });

  // Load TWO copies of the same document (simulating two browser tabs)
  const copy1 = await FinancialProfile.findById(profile._id);
  const copy2 = await FinancialProfile.findById(profile._id);

  // Modify and save copy1 — should succeed, bumps __v to 1
  copy1.monthlyTakeHome = 70000;
  await copy1.save();

  // Modify and save copy2 (stale __v=0) — should throw VersionError
  copy2.monthlyTakeHome = 80000;
  await assert.rejects(
    async () => { await copy2.save(); },
    (err) => {
      assert.equal(err.name, 'VersionError', `Expected VersionError, got ${err.name}: ${err.message}`);
      return true;
    }
  );

  // Verify DB has copy1's value (70000), not copy2's (80000)
  const saved1 = await FinancialProfile.findById(profile._id).lean();
  assert.equal(saved1.monthlyTakeHome, 70000, 'DB should reflect copy1 save, not copy2');
});

// ── Test 3: Idempotency-Key prevents duplicate profile creation ───────
test('Idempotency: same key on POST /profile/build returns cached response, no duplicate', async (t) => {
  await ensureDb();
  const token = signToken(TEST_USER_ID_2);
  const idempotencyKey = `test-idemp-${Date.now()}`;

  t.after(async () => {
    await FinancialProfile.deleteMany({ userId: TEST_USER_ID_2 });
  });

  await withServer(async (baseUrl) => {
    const body = JSON.stringify({ ...VALID_PROFILE_BODY, age: 25 });
    const headers = {
      authorization: `Bearer ${token}`,
      'idempotency-key': idempotencyKey,
    };

    // 1. First request — creates the profile
    const { response: r1, body: b1 } = await jsonFetch(`${baseUrl}/api/profile/build`, {
      method: 'POST', body, headers,
    });
    assert.equal(r1.status, 201, `First request failed: ${JSON.stringify(b1)}`);
    const firstProfileId = b1.profileId;

    // 2. Second request with SAME key — should return cached response
    const { response: r2, body: b2 } = await jsonFetch(`${baseUrl}/api/profile/build`, {
      method: 'POST', body, headers,
    });
    assert.equal(b2.profileId, firstProfileId, 'Second response should return the same profileId (cached)');

    // 3. Verify only ONE profile was created for this user with age=25
    const profiles = await FinancialProfile.find({ userId: TEST_USER_ID_2, age: 25 }).lean();
    assert.equal(profiles.length, 1, `Expected exactly 1 profile, found ${profiles.length}`);
  });
});
