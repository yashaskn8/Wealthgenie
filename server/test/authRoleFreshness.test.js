import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { verifyJWT } from '../middleware/authMiddleware.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'auth-role-freshness-test-secret';

function requestFor(role = 'admin') {
  const token = jwt.sign({ userId: '64b000000000000000000001', role }, process.env.JWT_SECRET);
  return { headers: { authorization: `Bearer ${token}` } };
}

function response() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('a demoted administrator token is downgraded to the current database role', async () => {
  const req = requestFor();
  const res = response();
  let passed = false;

  await verifyJWT(req, res, () => { passed = true; }, {
    isDatabaseReady: () => true,
    getCurrentUser: async () => ({ role: 'user' }),
  });

  assert.equal(passed, true);
  assert.equal(req.user.role, 'user');
});

test('admin-claim authentication fails closed when current role state cannot be read', async () => {
  const req = requestFor();
  const res = response();

  await verifyJWT(req, res, () => assert.fail('must not authenticate'), {
    isDatabaseReady: () => true,
    getCurrentUser: async () => { throw new Error('database unavailable'); },
  });

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'AUTH_ROLE_STATE_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(res.body), /database unavailable/);
});

test('a normal user token does not require an elevated-role database lookup', async () => {
  const req = requestFor('user');
  const res = response();
  let passed = false;

  await verifyJWT(req, res, () => { passed = true; }, {
    isDatabaseReady: () => false,
    getCurrentUser: async () => assert.fail('normal-user role should not trigger an elevated-role lookup'),
  });

  assert.equal(passed, true);
  assert.equal(req.user.role, 'user');
});
