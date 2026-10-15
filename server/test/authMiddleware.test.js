import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { verifyJWT, verifyJWTWithRevocationAvailability } from '../middleware/authMiddleware.js';
import { setForceFailClosedInTest, setRedisAvailable, setRedisClient } from '../config/redis.js';

process.env.JWT_SECRET = 'unit-test-secret';

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
    clearCookie(name) {
      this.clearedCookies.push(name);
      return this;
    },
    clearedCookies: [],
  };
}

test.afterEach(() => {
  process.env.NODE_ENV = 'test';
  setRedisAvailable(false);
  setRedisClient(null);
  setForceFailClosedInTest(false);
});

test('verifyJWT accepts a valid bearer token and attaches req.user', async () => {
  const token = jwt.sign({ userId: '64b000000000000000000001', jti: 'valid-test-jti' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = mockResponse();
  let called = false;

  await verifyJWT(req, res, () => { called = true; }, {
    getCurrentUser: async () => ({ role: 'user' }),
    isDatabaseReady: () => true,
  });

  assert.equal(called, true);
  assert.equal(req.user.userId, '64b000000000000000000001');
});

test('verifyJWT rejects missing bearer tokens', () => {
  const req = { headers: {} };
  const res = mockResponse();
  let called = false;

  verifyJWT(req, res, () => { called = true; });

  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /No token/);
});

test('verifyJWT rejects missing production JTI and malformed JTI claims', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    for (const claims of [
      { userId: '64b000000000000000000001' },
      { userId: '64b000000000000000000001', jti: {} },
      { userId: '64b000000000000000000001', jti: 'x'.repeat(129) },
    ]) {
      const token = jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: '1h' });
      const req = { headers: { authorization: `Bearer ${token}` } };
      const res = mockResponse();
      let called = false;
      await verifyJWT(req, res, () => { called = true; });
      assert.equal(called, false);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.code, 'AUTH_TOKEN_INVALID');
    }
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('verifyJWT rejects an MCP-purpose token even if it is signed with the session key', () => {
  const token = jwt.sign({
    userId: '64b000000000000000000001',
    token_use: 'mcp',
    aud: 'wealthgenie-mcp',
    scope: 'mcp:tools',
  }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = mockResponse();
  let called = false;
  verifyJWT(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'AUTH_TOKEN_INVALID');
});

test('verifyJWT fails closed with an unavailable response and retains a cookie when revocation is unavailable', async () => {
  process.env.NODE_ENV = 'production';
  setForceFailClosedInTest(true);
  setRedisAvailable(false);
  setRedisClient(null);
  const token = jwt.sign({ userId: '64b000000000000000000010', jti: 'redis-outage-jti' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const req = { headers: { cookie: `wg_session=${encodeURIComponent(token)}` } };
  const res = mockResponse();
  let called = false;

  await verifyJWT(req, res, () => { called = true; });

  assert.equal(called, false);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'TOKEN_REVOCATION_UNAVAILABLE');
  assert.deepEqual(res.clearedCookies, []);
});

test('logout verification does not clear cookies when revocation is unavailable', async () => {
  process.env.NODE_ENV = 'production';
  setForceFailClosedInTest(true);
  setRedisAvailable(false);
  setRedisClient(null);
  const token = jwt.sign({ userId: '64b000000000000000000014', jti: 'logout-redis-outage-jti' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const req = { headers: { authorization: 'Bearer ' + token, cookie: 'wg_session=' + encodeURIComponent(token) } };
  const res = mockResponse();

  await verifyJWTWithRevocationAvailability(req, res, () => assert.fail('unverifiable token status must not authenticate'));

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'TOKEN_REVOCATION_UNAVAILABLE');
  assert.deepEqual(res.clearedCookies, []);
});

test('verifyJWT rejects invalid, revoked, and expired cookie sessions without mutating cookies', async () => {
  process.env.NODE_ENV = 'production';
  setForceFailClosedInTest(true);
  setRedisAvailable(true);
  setRedisClient({ get: async () => 'revoked' });
  const cases = [
    {
      token: jwt.sign({ userId: '64b000000000000000000011', jti: 'bad-signature-jti' }, 'wrong-secret', { expiresIn: '1h' }),
      code: 'AUTH_TOKEN_INVALID',
    },
    {
      token: jwt.sign({ jti: 'invalid-payload-jti' }, process.env.JWT_SECRET, { expiresIn: '1h' }),
      code: 'AUTH_TOKEN_INVALID',
    },
    {
      token: jwt.sign({ userId: '64b000000000000000000012', jti: 'revoked-cookie-jti' }, process.env.JWT_SECRET, { expiresIn: '1h' }),
      code: 'AUTH_TOKEN_REVOKED',
    },
    {
      token: jwt.sign({ userId: '64b000000000000000000013', jti: 'expired-cookie-jti' }, process.env.JWT_SECRET, { expiresIn: -1 }),
      code: 'AUTH_TOKEN_EXPIRED',
    },
  ];

  for (const { token, code } of cases) {
    const req = { headers: { cookie: `wg_session=${encodeURIComponent(token)}` } };
    const res = mockResponse();
    await verifyJWT(req, res, () => assert.fail('invalid session must not authenticate'));
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, code);
    assert.deepEqual(res.clearedCookies, []);
  }
});

test('verifyJWT rejects a cookie session when its account no longer exists without mutating cookies', async () => {
  const token = jwt.sign({ userId: '64b000000000000000000015', jti: 'deleted-account-jti' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const req = { headers: { cookie: `wg_session=${encodeURIComponent(token)}` } };
  const res = mockResponse();

  await verifyJWT(req, res, () => assert.fail('deleted account must not authenticate'), {
    isDatabaseReady: () => true,
    getCurrentUser: async () => null,
  });

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'AUTH_TOKEN_INVALID');
  assert.deepEqual(res.clearedCookies, []);
});

test('verifyJWT does not clear cookie sessions when bearer authentication fails', async () => {
  const invalidBearer = jwt.sign({ userId: '64b000000000000000000016', jti: 'bad-bearer-signature' }, 'wrong-secret', { expiresIn: '1h' });
  const cookieToken = jwt.sign({ userId: '64b000000000000000000017', jti: 'unselected-cookie-session' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const req = {
    headers: {
      authorization: `Bearer ${invalidBearer}`,
      cookie: `wg_session=${encodeURIComponent(cookieToken)}; wg_csrf=csrf-value`,
    },
  };
  const res = mockResponse();

  await verifyJWT(req, res, () => assert.fail('invalid bearer token must not authenticate'));

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'AUTH_TOKEN_INVALID');
  assert.deepEqual(res.clearedCookies, []);
});

test('verifyJWT retains cookie sessions when current account state is unavailable', async () => {
  const token = jwt.sign({ userId: '64b000000000000000000018', jti: 'account-state-outage-jti' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const req = { headers: { cookie: `wg_session=${encodeURIComponent(token)}` } };
  const res = mockResponse();

  await verifyJWT(req, res, () => assert.fail('unverified account state must not authenticate'), {
    isDatabaseReady: () => false,
    getCurrentUser: async () => assert.fail('database is not ready'),
  });

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'AUTH_ACCOUNT_STATE_UNAVAILABLE');
  assert.deepEqual(res.clearedCookies, []);
});
