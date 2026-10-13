/**
 * Tier 6 — Security Regression Tests
 *
 * Tests:
 *   1. Mass Assignment Prevention (unexpected fields stripped)
 *   2. IDOR Protection (cannot update other user's profile)
 *   3. Token Revocation / Expired Token Rejection
 *   5. WG-005: POST /api/instruments/rank-wti requires auth + schema validation
 *   6. WG-018: GET /api/metrics requires auth
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import profileRoutes from '../routes/profile.js';
import instrumentRoutes from '../routes/instruments.js';
import metricsRoutes from '../routes/metricsRoutes.js';
import chatRoutes from '../routes/chatRoutes.js';
import { enforceJsonContentType } from '../middleware/contentType.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { blacklistToken } from '../config/redis.js';
import FinancialProfile from '../models/FinancialProfile.js';
import FinancialProfileState from '../models/FinancialProfileState.js';
import RecommendationState from '../models/RecommendationState.js';
import Recommendation from '../models/Recommendation.js';
import RecommendationAllocationRevision from '../models/RecommendationAllocationRevision.js';
import AuditRecord from '../models/AuditRecord.js';
import AuditChainHead from '../models/AuditChainHead.js';
import IdempotencyKey from '../models/IdempotencyKey.js';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';
import User from '../models/User.js';
import { withServer, jsonRequest as jsonFetch, rawRequest } from '../test-utils/httpTestUtils.js';
import { canonicalProfile, canonicalProfilePayload } from './helpers/canonicalProfile.js';
import { assertRuntimeResponseMatchesContract } from './helpers/openapiRuntimeContract.js';
import { requireFreshRecommendationState } from '../services/recommendationState.js';

process.env.JWT_SECRET = 'security-test-secret';
process.env.NODE_ENV = 'test';

const USER_A_ID = new mongoose.Types.ObjectId().toString();
const USER_B_ID = new mongoose.Types.ObjectId().toString();

function signToken(userId, jti = crypto.randomUUID(), expiresIn = '1h', role = 'user') {
  return jwt.sign(
    { userId, email: `${userId}@test.com`, jti, role },
    process.env.JWT_SECRET,
    { expiresIn }
  );
}

function buildApp() {
  const app = express();
  app.use(enforceJsonContentType);
  app.use(express.json());
  app.use('/api/profile', profileRoutes);
  app.use(errorHandler);
  return app;
}


const VALID_PROFILE_BODY = canonicalProfilePayload({
  monthlyTakeHome: 80000, monthlySavings: 20000, age: 30,
  liquidSavings: 100000, investmentHorizonYears: 15,
});

async function ensureDb() {
  await setupTestDatabase();
}

async function clearUserFinancialState(userId) {
  await Promise.all([
    FinancialProfile.deleteMany({ userId }),
    FinancialProfileState.deleteMany({ userId }),
    RecommendationState.deleteMany({ userId }),
    Recommendation.deleteMany({ userId }),
    // Test teardown may bypass the append-only Mongoose guard; production
    // paths must continue using the guarded model API.
    RecommendationAllocationRevision.collection.deleteMany({ userId }),
    AuditRecord.collection.deleteMany({ userId: new mongoose.Types.ObjectId(userId) }),
    AuditChainHead.deleteMany({ _id: userId }),
    IdempotencyKey.deleteMany({ userId }),
  ]);
}

async function completeCurrentProfile(baseUrl, token) {
  const { response, body } = await jsonFetch(`${baseUrl}/api/profile/complete`, {
    method: 'POST',
    body: JSON.stringify(VALID_PROFILE_BODY),
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': crypto.randomUUID() },
  });
  assert.equal(response.status, 200, `Profile completion failed: ${JSON.stringify(body)}`);
  assert.ok(body.profile?.profileId);
  return body;
}

test.after(async () => {
  try {
    await FinancialProfile.deleteMany({ userId: { $in: [USER_A_ID, USER_B_ID] } });
  } catch (_) {}
  await teardownTestDatabase();
});

// ── 1. Mass Assignment Prevention ────────────────────────────────────
test('Security: mass assignment fields are rejected by strict schema validation', async () => {
  await ensureDb();
  const token = signToken(USER_A_ID);

  await withServer(buildApp(), async (baseUrl) => {
    // Send a payload with unexpected fields (e.g. role, admin, userDetails)
    const { response, body } = await jsonFetch(`${baseUrl}/api/profile/build`, {
      method: 'POST',
      body: JSON.stringify({
        ...VALID_PROFILE_BODY,
        role: 'admin',
        is_admin: true,
        isAdmin: true,
        someUnusedField: 'malicious-data',
      }),
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(response.status, 400);
    assert.equal(body.code, 'VALIDATION_ERROR');
    assert.equal(await FinancialProfile.countDocuments({ userId: USER_A_ID }), 0);
  });
});

// ── 2. IDOR Protection ───────────────────────────────────────────────
test('Security: user B cannot modify user A profile via IDOR', async () => {
  await ensureDb();
  await clearUserFinancialState(USER_A_ID);

  // Create profile A directly in DB
  const profileA = await FinancialProfile.create({
    userId: USER_A_ID,
    ...canonicalProfile({ monthlyTakeHome: 80000, monthlySavings: 20000, age: 30 }),
    recommendationProfileVersion: 'financial-profile-1.0.0',
  });

  const tokenB = signToken(USER_B_ID);

  try {
    await withServer(buildApp(), async (baseUrl) => {
      // Attempt to update Profile A using User B's token
      const { response } = await jsonFetch(`${baseUrl}/api/profile/${profileA._id}`, {
        method: 'PUT',
        body: JSON.stringify({
          ...VALID_PROFILE_BODY,
          monthly_take_home: 120000,
          version: profileA.version || 1,
        }),
        headers: { authorization: `Bearer ${tokenB}`, 'idempotency-key': crypto.randomUUID() },
      });

      assert.ok(response.status === 403 || response.status === 404, `Expected 403 or 404, got ${response.status}`);
      const doc = await FinancialProfile.findById(profileA._id).lean();
      assert.equal(doc.monthlyTakeHome, 80000, 'Profile A monthly take-home must not be updated by User B');
    });
  } finally {
    await clearUserFinancialState(USER_A_ID);
  }
});

// ── 3. Token Revocation Rejection ────────────────────────────────────
test('Security: blocklisted / revoked token is rejected with 401 Unauthorized', async () => {
  await ensureDb();

  const jti = crypto.randomUUID();
  const token = signToken(USER_A_ID, jti);

  // Blacklist the token using standard blacklisting helper
  await blacklistToken(jti, 3600);

  await withServer(buildApp(), async (baseUrl) => {
    const { response, body } = await jsonFetch(`${baseUrl}/api/profile/build`, {
      method: 'POST',
      body: JSON.stringify(VALID_PROFILE_BODY),
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(response.status, 401);
    assert.match(body.error, /revoked/i);
  });
});

// ── 4. Expired Token Rejection ───────────────────────────────────────
test('Security: expired token is rejected with 401 Unauthorized', async () => {
  await ensureDb();

  // Create an already expired token (expiresIn: '0s')
  const expiredToken = signToken(USER_A_ID, crypto.randomUUID(), '0s');

  await withServer(buildApp(), async (baseUrl) => {
    const { response, body } = await jsonFetch(`${baseUrl}/api/profile/build`, {
      method: 'POST',
      body: JSON.stringify(VALID_PROFILE_BODY),
      headers: { authorization: `Bearer ${expiredToken}` },
    });

    assert.equal(response.status, 401);
    assert.match(body.error, /expired/i);
  });
});

// ── 5. WG-005: POST /api/instruments/rank-wti auth + validation ───────
function buildInstrumentApp() {
  const app = express();
  app.use(enforceJsonContentType);
  app.use(express.json());
  app.use('/api/profile', profileRoutes);
  app.use('/api/instruments', instrumentRoutes);
  app.use(errorHandler);
  return app;
}

test('WG-005: POST /api/instruments/rank-wti returns 401 without auth', async () => {
  await withServer(buildInstrumentApp(), async (baseUrl) => {
    const { response } = await jsonFetch(`${baseUrl}/api/instruments/rank-wti`, {
      method: 'POST',
      body: JSON.stringify({ candidates: [], userProfile: {}, options: {} }),
    });
    assert.equal(response.status, 401, 'rank-wti must reject unauthenticated requests');
  });
});

test('WG-005: POST /api/instruments/rank-wti rejects a client-supplied product universe', async () => {
  const token = signToken(USER_A_ID);
  await withServer(buildInstrumentApp(), async (baseUrl) => {
    const { response, body } = await jsonFetch(`${baseUrl}/api/instruments/rank-wti`, {
      method: 'POST',
      body: JSON.stringify({
        profileId: new mongoose.Types.ObjectId().toString(),
        parentInstrumentId: 'index_mf',
        candidates: [{ name: 'Client-controlled product' }],
      }),
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 400, 'rank-wti must reject client-controlled candidates');
    assert.ok(body.details || body.error, 'Should return validation error details');
  });
});

test('WG-005: POST /api/instruments/rank-wti rejects legacy inline user profiles', async () => {
  const token = signToken(USER_A_ID);
  await withServer(buildInstrumentApp(), async (baseUrl) => {
    // age outside valid range (18-80)
    const { response, body } = await jsonFetch(`${baseUrl}/api/instruments/rank-wti`, {
      method: 'POST',
      body: JSON.stringify({
        profileId: new mongoose.Types.ObjectId().toString(),
        parentInstrumentId: 'ppf',
        userProfile: { age: 150, riskCategory: 'InvalidTier', investment_horizon: 999 },
      }),
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 400, 'rank-wti must reject inline userProfile fields');
    assert.ok(body.details || body.error, 'Should return validation error details');
  });
});

test('WG-005: POST /api/instruments/rank-wti returns 200 for valid authenticated request', async () => {
  await ensureDb();
  await clearUserFinancialState(USER_A_ID);
  const token = signToken(USER_A_ID);
  try {
    await withServer(buildInstrumentApp(), async (baseUrl) => {
      const completion = await completeCurrentProfile(baseUrl, token);
      const profileId = completion.profile.profileId;
      const state = await requireFreshRecommendationState({ userId: USER_A_ID, profileId });
      const binding = {
        profileId,
        profileVersion: state.profileVersion,
        recommendationId: String(state.recommendation._id),
        expectedAllocationRevision: state.allocationRevision.revision,
        expectedAllocationRevisionId: String(state.allocationRevision._id),
        expectedPortfolioFingerprint: state.portfolioFingerprint,
        expectedRecommendationFingerprint: state.recommendationFingerprint,
      };
      const parentInstrumentId = state.currentAllocation.instruments[0]?.id;
      assert.ok(parentInstrumentId, 'fixture must have a canonical current recommendation instrument');

      const { response, body } = await jsonFetch(`${baseUrl}/api/instruments/rank-wti`, {
        method: 'POST',
        body: JSON.stringify({ ...binding, parentInstrumentId }),
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 200, 'rank-wti must succeed only with a complete current-state binding');
      assertRuntimeResponseMatchesContract({
        method: 'POST', path: '/api/instruments/rank-wti', status: response.status,
        contentType: response.headers.get('content-type'), body,
      });
      assert.deepEqual(body.financialStateBinding, {
        profileId,
        profileVersion: state.profileVersion,
        recommendationId: String(state.recommendation._id),
        allocationRevision: state.allocationRevision.revision,
        allocationRevisionId: String(state.allocationRevision._id),
        portfolioFingerprint: state.portfolioFingerprint,
        recommendationFingerprint: state.recommendationFingerprint,
      });
      assert.ok(Array.isArray(body.products), 'Response should include products array');

      const stale = await jsonFetch(`${baseUrl}/api/instruments/rank-wti`, {
        method: 'POST',
        body: JSON.stringify({ ...binding, profileVersion: binding.profileVersion + 1, parentInstrumentId }),
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(stale.response.status, 409);
      assert.equal(stale.body.code, 'FINANCIAL_STATE_CHANGED');

      const forgedParent = await jsonFetch(`${baseUrl}/api/instruments/rank-wti`, {
        method: 'POST',
        body: JSON.stringify({ ...binding, parentInstrumentId: 'ppf' }),
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(forgedParent.response.status, 409);
      assert.equal(forgedParent.body.code, 'RECOMMENDATION_PARENT_MISMATCH');
    });
  } finally {
    await clearUserFinancialState(USER_A_ID);
  }
});

// ── 6. WG-018: GET /api/metrics auth + old path dead ────────────────
function buildMetricsApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/metrics', metricsRoutes);
  app.use('/api/chat', chatRoutes);
  app.use(errorHandler);
  return app;
}

test('WG-018: GET /api/metrics returns 401 without auth', async () => {
  await withServer(buildMetricsApp(), async (baseUrl) => {
    const { response } = await jsonFetch(`${baseUrl}/api/metrics`, {
      method: 'GET',
    });
    assert.equal(response.status, 401, 'metrics endpoint must reject unauthenticated requests');
  });
});

test('WG-018: GET /api/metrics rejects a normal authenticated user', async () => {
  const token = signToken(USER_A_ID);
  await withServer(buildMetricsApp(), async (baseUrl) => {
    const { response } = await jsonFetch(`${baseUrl}/api/metrics`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    assert.equal(response.status, 403, 'metrics endpoint must reject non-admin users');
  });
});

test('WG-018: GET /api/metrics returns 200 for an administrator', async () => {
  await ensureDb();
  await User.updateOne(
    { _id: USER_A_ID },
    { $setOnInsert: { name: 'Metrics Admin', email: `metrics-admin-${USER_A_ID}@test.local`, passwordHash: 'test-only-hash', role: 'admin' } },
    { upsert: true },
  );
  const token = signToken(USER_A_ID, crypto.randomUUID(), '1h', 'admin');
  try {
    await withServer(buildMetricsApp(), async (baseUrl) => {
      const { response } = await jsonFetch(`${baseUrl}/api/metrics`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
      assert.equal(response.status, 200, 'metrics endpoint must succeed with admin auth');
    });
  } finally {
    await User.deleteOne({ _id: USER_A_ID });
  }
});

test('WG-018: GET /api/chat/metrics (old path) returns 404 after relocation', async () => {
  await withServer(buildMetricsApp(), async (baseUrl) => {
    const response = await rawRequest(`${baseUrl}/api/chat/metrics`, {
      method: 'GET',
    });
    assert.equal(response.status, 404, 'old /api/chat/metrics path must be dead after relocation');
  });
});

// ── 7. WG-003, WG-007, WG-025: In-Place Mutation, Canonical Response, and OCC ──
test('WG-003: PUT /api/profile/:profileId updates existing profile in-place', async () => {
  await ensureDb();
  try {
    await clearUserFinancialState(USER_A_ID);
    const token = signToken(USER_A_ID);
    await withServer(buildApp(), async (baseUrl) => {
      const completion = await completeCurrentProfile(baseUrl, token);
      const profileId = completion.profile.profileId;

      const { response: putRes, body: putBody } = await jsonFetch(`${baseUrl}/api/profile/${profileId}`, {
        method: 'PUT',
        body: JSON.stringify({ ...VALID_PROFILE_BODY, monthly_take_home: 95000, version: completion.profile.version }),
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': crypto.randomUUID() },
      });
      assert.equal(putRes.status, 200, 'PUT /api/profile/:profileId should succeed with valid version');
      assert.equal(putBody.profile.profileId, profileId, 'profileId must remain unchanged');
      assert.equal(putBody.profile.version, completion.profile.version + 1, 'version must increment by 1');
      assert.equal(putBody.recommendation.profile_version, putBody.profile.version);
      assert.equal(putBody.recommendation.response_state, 'CURRENT');

      const count = await FinancialProfile.countDocuments({ userId: USER_A_ID });
      assert.equal(count, 1, 'Should update existing profile in-place without creating a new document');
    });
  } finally {
    await clearUserFinancialState(USER_A_ID);
  }
});

test('WG-007: PUT wraps the unchanged profile DTO with current recommendation state', async () => {
  await ensureDb();
  try {
    await clearUserFinancialState(USER_A_ID);
    const token = signToken(USER_A_ID);
    await withServer(buildApp(), async (baseUrl) => {
      const postBody = await completeCurrentProfile(baseUrl, token);

      const { response: putRes, body: putBody } = await jsonFetch(`${baseUrl}/api/profile/${postBody.profile.profileId}`, {
        method: 'PUT',
        body: JSON.stringify({ ...VALID_PROFILE_BODY, version: postBody.profile.version }),
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': crypto.randomUUID() },
      });

      assert.equal(putRes.status, 200);
      assert.deepEqual(Object.keys(putBody).sort(), [
        'current_profile_id',
        'financial_profile_state_revision',
        'profile',
        'recommendation',
      ]);
      const postKeys = Object.keys(postBody.profile).sort();
      const putKeys = Object.keys(putBody.profile).sort();
      assert.deepEqual(postKeys, putKeys, 'Profile DTO fields remain stable inside the atomic PUT response');
      assert.equal(putBody.recommendation.response_state, 'CURRENT');
      assert.equal(postBody.profile.final_suitability_risk, 'Moderate');
      assert.ok(postBody.profile.final_suitability_level <= 3, 'final suitability must not exceed Moderate preference');
    });
  } finally {
    await clearUserFinancialState(USER_A_ID);
  }
});

test('WG-025: PUT /api/profile/:profileId requires version and returns 409 Conflict on version mismatch', async () => {
  await ensureDb();
  try {
    await clearUserFinancialState(USER_A_ID);
    const token = signToken(USER_A_ID);
    await withServer(buildApp(), async (baseUrl) => {
      const postBody = await completeCurrentProfile(baseUrl, token);
      const profileId = postBody.profile.profileId;

      // Omitting version should fail validation (400)
      const { response: noVersionRes } = await jsonFetch(`${baseUrl}/api/profile/${postBody.profileId}`, {
        method: 'PUT',
        body: JSON.stringify(VALID_PROFILE_BODY),
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(noVersionRes.status, 400, 'Omitting version on PUT must be rejected with 400');

      // Stale version should return 409 Conflict
      const { response: mismatchRes } = await jsonFetch(`${baseUrl}/api/profile/${profileId}`, {
        method: 'PUT',
        body: JSON.stringify({ ...VALID_PROFILE_BODY, version: 999 }),
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': crypto.randomUUID() },
      });
      assert.equal(mismatchRes.status, 409, 'Version mismatch must return 409 Conflict');
    });
  } finally {
    await clearUserFinancialState(USER_A_ID);
  }
});
