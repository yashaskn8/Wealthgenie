import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import authRoutes from '../routes/auth.js';
import { verifyJWT } from '../middleware/authMiddleware.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { setForceFailClosedInTest, setRedisAvailable, setRedisClient } from '../config/redis.js';
import { withServer, jsonRequest as jsonFetch } from '../test-utils/httpTestUtils.js';
import { assertRuntimeResponseMatchesContract } from './helpers/openapiRuntimeContract.js';

process.env.JWT_SECRET = 'logout-integration-test-secret';
process.env.NODE_ENV = 'test';

test.afterEach(() => {
  process.env.NODE_ENV = 'test';
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

test('logout returns canonical 503 and clears cookies when Redis revocation write fails', async () => {
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
      headers: { authorization: `Bearer ${token}` },
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
    const cookies = response.headers.get('set-cookie') || [];
    assert.ok((Array.isArray(cookies) ? cookies : [cookies]).some((cookie) => /^wg_session=;/.test(cookie)));

    const persisted = new Set();
    setRedisClient({
      get: async (key) => persisted.has(key) ? 'revoked' : null,
      setEx: async (key, _ttl, value) => { persisted.add(key); assert.equal(value, 'revoked'); return 'OK'; },
    });
    const recovered = await jsonFetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(recovered.response.status, 200, 'recovery may succeed only after a confirmed write');
    assert.match(recovered.body.message, /Logout successful/i);
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
      method: 'POST', headers: { cookie: `wg_session=${encodeURIComponent(token)}` },
    });
    assert.equal(unavailable.response.status, 503, 'revocation lookup outage must fail closed as unavailable');
    assert.equal(unavailable.body.code, 'TOKEN_REVOCATION_UNAVAILABLE');
    assert.notEqual(unavailable.body.message, 'Logout successful.');
    const clearedCookies = unavailable.response.headers.get('set-cookie') || [];
    assert.ok((Array.isArray(clearedCookies) ? clearedCookies : [clearedCookies]).some((cookie) => /^wg_session=;/.test(cookie)));

    const revoked = new Set();
    setRedisAvailable(true);
    setRedisClient({
      get: async (key) => revoked.has(key) ? 'revoked' : null,
      setEx: async (key, _ttl, value) => { revoked.add(key); assert.equal(value, 'revoked'); return 'OK'; },
    });
    const { response, body } = await jsonFetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.match(body.message, /Logout successful/i);

    const replay = await jsonFetch(`${baseUrl}/api/protected`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(replay.response.status, 401);
    assert.equal(replay.body.code, 'AUTH_TOKEN_REVOKED');
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
