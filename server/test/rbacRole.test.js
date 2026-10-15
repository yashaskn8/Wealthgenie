import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import User from '../models/User.js';
import authRoutes from '../routes/auth.js';
import { verifyJWT, requireRole } from '../middleware/authMiddleware.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { withServer, jsonRequest } from '../test-utils/httpTestUtils.js';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';
import { getMLPrediction } from '../services/mlClient.js';
import { queryRAG } from '../services/ragClient.js';
import { buildMlProfileInput } from '../services/recommendationProfile.js';
import { assessSuitabilityRisk } from '../services/riskProfiler.js';
import { canonicalProfile } from './helpers/canonicalProfile.js';

process.env.JWT_SECRET = 'rbac-integration-test-secret';
process.env.NODE_ENV = 'test';

function buildAuthApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);

  // Admin-only test route
  app.get('/api/admin/dashboard', verifyJWT, requireRole('admin'), (req, res) => {
    res.json({ message: 'Admin dashboard access granted', role: req.user.role });
  });

  // User-only test route
  app.get('/api/user/profile', verifyJWT, requireRole('user'), (req, res) => {
    res.json({ message: 'User profile access granted', role: req.user.role });
  });

  app.use(errorHandler);
  return app;
}

function mockResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test.before(async () => {
  await setupTestDatabase({ requireReplicaSet: true });
});

test.after(async () => {
  try {
    await User.deleteOne({ _id: '64b000000000000000000001' });
  } catch (_) {}
  await teardownTestDatabase();
});

// ==============================================================================
// PROOF 1: Pre-existing token without role claim decodes with req.user.role === 'user'
// ==============================================================================
test('PROOF 1: verifyJWT defaults legacy/missing role claim to "user"', async () => {
  const legacyUserId = '64b000000000000000000001';
  await User.updateOne(
    { _id: legacyUserId },
    { $set: { name: 'Legacy Token User', email: 'legacy@wealthgenie.test', passwordHash: 'test-only-hash', role: 'user' } },
    { upsert: true },
  );

  const legacyToken = jwt.sign(
    { userId: legacyUserId, email: 'legacy@wealthgenie.test', jti: 'legacy-role-token' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  const req = { headers: { authorization: `Bearer ${legacyToken}` } };
  const res = mockResponse();
  let nextCalled = false;

  await verifyJWT(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(req.user.userId, legacyUserId);
  assert.equal(req.user.role, 'user');
});

// ==============================================================================
// PROOF 2: requireRole('admin') rejects user-role tokens with 403 and allows admin-role tokens
// ==============================================================================
test('PROOF 2: requireRole checks current account roles and fails closed on lookup errors', async () => {
  const roles = new Map([['456', 'admin']]);
  const adminGuard = requireRole('admin', { findCurrentRole: async userId => roles.get(userId) || null });

  // Case A: User role trying to access admin endpoint -> 403 Forbidden
  const userReq = { user: { userId: '123', role: 'user' } };
  const userRes = mockResponse();
  let userNext = false;
  adminGuard(userReq, userRes, () => { userNext = true; });

  assert.equal(userNext, false);
  assert.equal(userRes.statusCode, 403);
  assert.equal(userRes.body.error, 'Access denied. Requires admin role.');

  // Case B: Admin role accessing admin endpoint -> 200 / next()
  const adminReq = { user: { userId: '456', role: 'admin' } };
  const adminRes = mockResponse();
  let adminNext = false;
  await adminGuard(adminReq, adminRes, () => { adminNext = true; });

  assert.equal(adminNext, true);
  assert.equal(adminRes.statusCode, 200);

  roles.set('456', 'user');
  const revokedRes = mockResponse();
  let revokedNext = false;
  await adminGuard(adminReq, revokedRes, () => { revokedNext = true; });
  assert.equal(revokedNext, false);
  assert.equal(revokedRes.statusCode, 403);
  assert.equal(revokedRes.body.code, 'AUTH_ROLE_REQUIRED');

  const unavailableGuard = requireRole('admin', { findCurrentRole: async () => { throw new Error('database unavailable'); } });
  const unavailableRes = mockResponse();
  let unavailableNext = false;
  await unavailableGuard(adminReq, unavailableRes, () => { unavailableNext = true; });
  assert.equal(unavailableNext, false);
  assert.equal(unavailableRes.statusCode, 503);
  assert.equal(unavailableRes.body.code, 'AUTH_ROLE_STATE_UNAVAILABLE');

  // Case C: Unauthenticated / missing req.user -> 403 Forbidden
  const unauthReq = {};
  const unauthRes = mockResponse();
  let unauthNext = false;
  adminGuard(unauthReq, unauthRes, () => { unauthNext = true; });

  assert.equal(unauthNext, false);
  assert.equal(unauthRes.statusCode, 403);
  assert.equal(unauthRes.body.error, 'Access denied. Requires admin role.');
});

// ==============================================================================
// PROOF 3: POST /api/auth/register creates user with role: 'user' even if attacker sends role: 'admin'
// ==============================================================================
test('PROOF 3: POST /api/auth/register rejects a forged role parameter', async () => {
  await withServer(buildAuthApp(), async (baseUrl) => {
    const uniqueEmail = `adversary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wealthgenie.com`;
    const registerPayload = {
      name: 'Adversary User',
      email: uniqueEmail,
      mobile: '9876543210',
      password: 'SecurePassword123!',
      role: 'admin', // Malicious attempt to self-elevate
    };

    const { response, body } = await jsonRequest(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      body: JSON.stringify(registerPayload),
    });

    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(body.code, 'VALIDATION_ERROR');
    const dbUser = await User.findOne({ email: uniqueEmail }).lean();
    assert.equal(dbUser, null);
  });
});

// ==============================================================================
// PROOF 4: POST /api/auth/login dynamically reads updated role: 'admin' directly from MongoDB
// ==============================================================================
test('PROOF 4: POST /api/auth/login reads direct DB promotion to "admin" and issues admin JWT', async () => {
  await withServer(buildAuthApp(), async (baseUrl) => {
    const email = `promoted.admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wealthgenie.com`;
    const password = 'AdminPassword123!';

    // 1. Register as normal user
    const { response: regRes, body: regBody } = await jsonRequest(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Future Admin', email, password }),
    });
    assert.equal(regRes.status, 201, `Register failed with ${regRes.status}: ${JSON.stringify(regBody)}`);
    assert.equal(regBody.user.role, 'user');

    // 2. Direct database out-of-band promotion (the ONLY allowed way to become admin)
    await User.updateOne({ email }, { $set: { role: 'admin' } });

    // 3. Login
    const { response: loginRes, body: loginBody } = await jsonRequest(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });

    assert.equal(loginRes.status, 200);
    assert.equal(loginBody.user.role, 'admin');

    // 4. Verify issued JWT contains role: 'admin'
    const decoded = jwt.verify(loginBody.token, process.env.JWT_SECRET);
    assert.equal(decoded.role, 'admin');

    // 5. Verify the issued token can successfully access the admin-only route
    const { response: adminRouteRes, body: adminRouteBody } = await jsonRequest(`${baseUrl}/api/admin/dashboard`, {
      method: 'GET',
      headers: { authorization: `Bearer ${loginBody.token}` },
    });
    assert.equal(adminRouteRes.status, 200);
    assert.equal(adminRouteBody.role, 'admin');

    await User.updateOne({ email }, { $set: { role: 'user' } });
    const revokedAdmin = await jsonRequest(`${baseUrl}/api/admin/dashboard`, {
      method: 'GET', headers: { authorization: `Bearer ${loginBody.token}` },
    });
    assert.equal(revokedAdmin.response.status, 403);
    assert.equal(revokedAdmin.body.code, 'AUTH_ROLE_REQUIRED');

    await User.deleteOne({ email });
  });
});

// ==============================================================================
// PROOF 5: mlClient & ragClient downstream propagation includes X-Verified-User-Role
// ==============================================================================
test('PROOF 5: mlClient and ragClient propagate X-Verified-User-Role downstream to ml-service', async (t) => {
  const originalPost = axios.post;
  const capturedCalls = [];

  axios.post = async (url, payload, config) => {
    capturedCalls.push({ url, payload, headers: config?.headers || {} });
    if (url.includes('/rag/query')) {
      return { status: 200, data: { answer: 'RAG Answer', citations: [] } };
    }
    return { status: 200, data: {
      primary: 'ETF', secondary: 'Debt_MF', tertiary: 'ELSS',
      confidence_scores: { Equity_MF: 0.05, ELSS: 0.05, ETF: 0.7, Debt_MF: 0.1, FD: 0.05, RBI_Bond: 0.05 }, decision_path: ['risk=Moderate'],
      model_version: '4.0.0', dataset_version: '4.0.0', feature_schema_version: 'recommendation-features-4.0.0',
    } };
  };

  t.after(() => {
    axios.post = originalPost;
  });

  const profile = canonicalProfile({ age: 35, monthlySavings: 30000, liquidSavings: 50000 });
  const profileData = buildMlProfileInput(profile, assessSuitabilityRisk(profile));

  // A. ML prediction with user role
  await getMLPrediction(profileData, 'corr-test-1', 'user-123', 'admin');
  const mlCall = capturedCalls.find(c => c.url.includes('/predict/enriched'));
  assert.ok(mlCall);
  assert.equal(mlCall.headers['X-Verified-User-Id'], 'user-123');
  assert.equal(mlCall.headers['X-Verified-User-Role'], 'admin');

  // B. RAG query with user role
  await queryRAG({ query: 'What is 80C limit?', userId: 'user-456', userRole: 'admin' }, 'corr-test-2');
  const ragCall = capturedCalls.find(c => c.url.includes('/rag/query'));
  assert.ok(ragCall);
  assert.equal(ragCall.headers['X-Verified-User-Id'], 'user-456');
  assert.equal(ragCall.headers['X-Verified-User-Role'], 'admin');

  // C. Calling without userRole does NOT include X-Verified-User-Role header
  capturedCalls.length = 0;
  await getMLPrediction(profileData, 'corr-test-3', 'user-789');
  const unrolledMLCall = capturedCalls.find(c => c.url.includes('/predict/enriched'));
  assert.ok(unrolledMLCall);
  assert.equal(unrolledMLCall.headers['X-Verified-User-Id'], 'user-789');
  assert.equal(unrolledMLCall.headers['X-Verified-User-Role'], undefined);
});
