import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { verifyJWT } from '../middleware/authMiddleware.js';

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
  };
}

test('verifyJWT accepts a valid bearer token and attaches req.user', async () => {
  const token = jwt.sign({ userId: '64b000000000000000000001', jti: 'valid-test-jti' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = mockResponse();
  let called = false;

  await verifyJWT(req, res, () => { called = true; });

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
