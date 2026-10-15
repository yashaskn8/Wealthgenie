import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import User from '../models/User.js';
import authRoutes from '../routes/auth.js';
import { verifyJWT } from '../middleware/authMiddleware.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { setForceFailClosedInTest, setRedisAvailable, setRedisClient } from '../config/redis.js';
import { withServer, jsonRequest as jsonFetch } from '../test-utils/httpTestUtils.js';
import { assertRuntimeResponseMatchesContract } from './helpers/openapiRuntimeContract.js';

process.env.JWT_SECRET = 'logout-integration-test-secret';
process.env.NODE_ENV = 'test';
const originalFindById = User.findById;
const originalConnectionReadyState = mongoose.connection.readyState;

test.beforeEach(() => {
  mongoose.connection.readyState = 1;
  User.findById = () => ({
    select() { return this; },
    lean: async () => ({ role: 'user', name: 'Test User', email: 'test@example.com' }),
  });
});

test.afterEach(() => {
  process.env.NODE_ENV = 'test';
  User.findById = originalFindById;
  mongoose.connection.readyState = originalConnectionReadyState;
  setRedisAvailable(false);
  setRedisClient(null);
  setForceFailClosedInTest(false);
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  
  // A simple protected test endpoint
  app.get('/api/protected', verifyJWT, (req, res) => {
    res.json({ message: 'Success', user: req.user });
  });

  app.use(errorHandler);
  return app;
}


test('JWT logout revokes token and blocks subsequent access', async () => {
  await withServer(buildApp(), async (baseUrl) => {
    const jti = 'test-uuid-jti-12345';
    // 1. Directly sign a valid token
    const token = jwt.sign(
      { userId: '64b000000000000000000001', email: 'test@example.com', jti },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    // 2. Access protected route - should succeed
    const { response: accRes, body: accBody } = await jsonFetch(`${baseUrl}/api/protected`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(accRes.status, 200);
    assert.equal(accBody.message, 'Success');
    assert.equal(accBody.user.jti, jti);

    // 3. Log out - should succeed and add to blacklist
    const { response: logoRes, body: logoBody } = await jsonFetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(logoRes.status, 200);
    assert.match(logoBody.message, /Logout successful/i);

    // 4. Access protected route again - should fail with 401
    const { response: failRes, body: failBody } = await jsonFetch(`${baseUrl}/api/protected`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(failRes.status, 401);
    assert.match(failBody.error, /revoked/i);
  });
});

test('protected routes fail closed during revocation outages without clearing a valid session cookie', async () => {
  process.env.NODE_ENV = 'production';
  setForceFailClosedInTest(true);
  setRedisAvailable(false);
  setRedisClient(null);

  await withServer(buildApp(), async (baseUrl) => {
    const token = jwt.sign(
      { userId: '64b000000000000000000006', email: 'test@example.com', jti: 'protected-outage-jti' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' },
    );
    const unavailable = await jsonFetch(`${baseUrl}/api/protected`, {
      headers: { cookie: `wg_session=${encodeURIComponent(token)}` },
    });

    assert.equal(unavailable.response.status, 503);
    assert.equal(unavailable.body.code, 'TOKEN_REVOCATION_UNAVAILABLE');
    assert.doesNotMatch(unavailable.response.headers.get('set-cookie') || '', /wg_session=;/);

    setRedisAvailable(true);
    setRedisClient({ get: async () => null });
    const recovered = await jsonFetch(`${baseUrl}/api/protected`, {
      headers: { cookie: `wg_session=${encodeURIComponent(token)}` },
    });
    assert.equal(recovered.response.status, 200);
    assert.equal(recovered.body.user.jti, 'protected-outage-jti');
  });
});

test('invalid, revoked, and expired cookie sessions do not mutate browser cookies', async () => {
  process.env.NODE_ENV = 'production';
  setForceFailClosedInTest(true);
  setRedisAvailable(true);
  setRedisClient({ get: async () => 'revoked' });

  await withServer(buildApp(), async (baseUrl) => {
    const tokens = [
      jwt.sign(
        { userId: '64b000000000000000000007', jti: 'bad-signature-jti' },
        'not-the-session-secret',
        { expiresIn: '1h' },
      ),
      jwt.sign(
        { userId: '64b000000000000000000008', jti: 'revoked-cookie-jti' },
        process.env.JWT_SECRET,
        { expiresIn: '1h' },
      ),
      jwt.sign(
        { userId: '64b000000000000000000009', jti: 'expired-cookie-jti' },
        process.env.JWT_SECRET,
        { expiresIn: -1 },
      ),
    ];

    for (const token of tokens) {
      const result = await jsonFetch(`${baseUrl}/api/protected`, {
        headers: { cookie: `wg_session=${encodeURIComponent(token)}` },
      });
      assert.equal(result.response.status, 401);
      assert.equal(result.response.headers.get('set-cookie'), null);
    }
  });
});

test('session restoration for a missing user does not mutate cookies on its 401 response', async () => {
  const originalFindById = User.findById;
  User.findById = () => ({ select() { return this; }, lean: async () => null });

  try {
    await withServer(buildApp(), async (baseUrl) => {
      const token = jwt.sign(
        { userId: '64b000000000000000000015', jti: 'missing-session-user-jti' },
        process.env.JWT_SECRET,
        { expiresIn: '1h' },
      );
      const result = await jsonFetch(`${baseUrl}/api/auth/session`, {
        headers: { cookie: `wg_session=${encodeURIComponent(token)}` },
      });

      assert.equal(result.response.status, 401);
      assert.equal(result.response.headers.get('set-cookie'), null);
    });
  } finally {
    User.findById = originalFindById;
  }
});

test('logout returns canonical 503 without clearing cookies when Redis revocation write fails', async () => {
  process.env.NODE_ENV = 'production';
  setForceFailClosedInTest(true);
  setRedisAvailable(true);
  setRedisClient({
    get: async () => null,
    setEx: async () => { throw new Error('simulated Redis outage after token verification'); },
  });

  await withServer(buildApp(), async (baseUrl) => {
    const token = jwt.sign(
      { userId: '64b000000000000000000002', email: 'test@example.com', jti: 'write-failure-jti' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' },
    );
    const { response, body } = await jsonFetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: `wg_session=${encodeURIComponent(token)}` },
    });

    assert.equal(response.status, 503);
    assert.equal(body.code, 'TOKEN_REVOCATION_UNAVAILABLE');
    assert.equal(typeof body.request_id, 'string');
    assert.ok(body.request_id.length > 0);
    assert.doesNotMatch(body.message, /Redis|simulated/i);
    assert.doesNotMatch(body.message, /Logout successful/i);
    assertRuntimeResponseMatchesContract({
      method: 'POST', path: '/api/auth/logout', status: response.status,
      contentType: response.headers.get('content-type'), body,
    });
    assert.equal(response.headers.get('set-cookie'), null);

    const persisted = new Set();
    setRedisClient({
      get: async (key) => persisted.has(key) ? 'revoked' : null,
      setEx: async (key, _ttl, value) => { persisted.add(key); assert.equal(value, 'revoked'); return 'OK'; },
    });
    const recovered = await jsonFetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST', headers: { cookie: `wg_session=${encodeURIComponent(token)}` },
    });
    assert.equal(recovered.response.status, 200, 'recovery may succeed only after a confirmed write');
    assert.match(recovered.body.message, /Logout successful/i);
    assert.equal(recovered.response.headers.get('set-cookie'), null, 'a confirmed production revocation leaves no response cookie mutation that could race a newer login');
    const copiedToken = await jsonFetch(`${baseUrl}/api/protected`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(copiedToken.response.status, 401);
  });
});

test('logout succeeds only after revocation is confirmed and retries cannot reuse the token', async () => {
  process.env.NODE_ENV = 'production';
  setForceFailClosedInTest(true);
  setRedisAvailable(false);
  setRedisClient(null);

  await withServer(buildApp(), async (baseUrl) => {
    const token = jwt.sign(
      { userId: '64b000000000000000000003', email: 'test@example.com', jti: 'recovery-jti' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' },
    );
    const unavailable = await jsonFetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST', headers: { cookie: 'wg_session=' + encodeURIComponent(token) },
    });
    assert.equal(unavailable.response.status, 503, 'revocation lookup outage must fail closed as unavailable');
    assert.equal(unavailable.body.code, 'TOKEN_REVOCATION_UNAVAILABLE');
    assert.notEqual(unavailable.body.message, 'Logout successful.');
    assert.equal(unavailable.response.headers.get('set-cookie'), null);

    const revoked = new Set();
    setRedisAvailable(true);
    setRedisClient({
      get: async (key) => revoked.has(key) ? 'revoked' : null,
      setEx: async (key, _ttl, value) => { revoked.add(key); assert.equal(value, 'revoked'); return 'OK'; },
    });
    const { response, body } = await jsonFetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST', headers: { cookie: `wg_session=${encodeURIComponent(token)}` },
    });
    assert.equal(response.status, 200);
    assert.match(body.message, /Logout successful/i);
    assert.equal(response.headers.get('set-cookie'), null, 'a confirmed production revocation does not clear a newer session cookie');

    const replay = await jsonFetch(`${baseUrl}/api/protected`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(replay.response.status, 401);
    assert.equal(replay.body.code, 'AUTH_TOKEN_REVOKED');

    const retainedCookieReplay = await jsonFetch(`${baseUrl}/api/protected`, {
      headers: { cookie: `wg_session=${encodeURIComponent(token)}` },
    });
    assert.equal(retainedCookieReplay.response.status, 401);
    assert.equal(retainedCookieReplay.body.code, 'AUTH_TOKEN_REVOKED');
    assert.equal(retainedCookieReplay.response.headers.get('set-cookie'), null);
  });
});

test('required revocation rejects missing JTI and expired JWT without claiming logout success', async () => {
  process.env.NODE_ENV = 'production';
  setForceFailClosedInTest(true);
  setRedisAvailable(true);
  setRedisClient({ get: async () => null, setEx: async () => 'OK' });

  await withServer(buildApp(), async (baseUrl) => {
    const withoutJti = jwt.sign(
      { userId: '64b000000000000000000004', email: 'test@example.com' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' },
    );
    const missing = await jsonFetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST', headers: { authorization: `Bearer ${withoutJti}` },
    });
    assert.equal(missing.response.status, 401);
    assert.equal(missing.body.code, 'AUTH_TOKEN_INVALID');

    const expired = jwt.sign(
      { userId: '64b000000000000000000005', email: 'test@example.com', jti: 'expired-jti' },
      process.env.JWT_SECRET,
      { expiresIn: -1 },
    );
    const expiredResult = await jsonFetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST', headers: { authorization: `Bearer ${expired}` },
    });
    assert.equal(expiredResult.response.status, 401);
    assert.notEqual(expiredResult.body.message, 'Logout successful.');
  });
});
