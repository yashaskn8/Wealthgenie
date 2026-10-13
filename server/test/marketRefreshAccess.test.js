import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import marketRouter, { respondToManualMarketRefresh } from '../routes/market.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { setRedisAvailable, setRedisClient } from '../config/redis.js';
import User from '../models/User.js';
import { withServer, rawRequest } from '../test-utils/httpTestUtils.js';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'market-refresh-access-test-secret';
process.env.DISABLE_RATE_LIMIT = 'true';

const userToken = jwt.sign({ userId: '60d5ecb8b3b3a72d9c8e4a11', role: 'user', jti: 'market-user-session' }, process.env.JWT_SECRET);
const adminToken = jwt.sign({ userId: '60d5ecb8b3b3a72d9c8e4a12', role: 'admin', jti: 'market-admin-session' }, process.env.JWT_SECRET);

test.before(async () => {
  await setupTestDatabase();
  await User.updateOne(
    { _id: '60d5ecb8b3b3a72d9c8e4a12' },
    { $setOnInsert: { name: 'Market Refresh Admin', email: 'market-refresh-admin@wealthgenie.test', passwordHash: 'test-only-hash', role: 'admin' } },
    { upsert: true },
  );
});

test.after(async () => {
  await User.deleteOne({ _id: '60d5ecb8b3b3a72d9c8e4a12' });
  await teardownTestDatabase();
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/market', marketRouter);
  app.use(errorHandler);
  return app;
}

test('market refresh verifies current admin role and fails safely when production lease coordination is unavailable', async t => {
  const previousEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.mock.method(User, 'findById', userId => ({
    select() { return this; },
    lean: async () => ({ role: userId === '60d5ecb8b3b3a72d9c8e4a12' ? 'admin' : 'user' }),
  }));
  setRedisAvailable(true);
  setRedisClient({
    get: async () => null,
    sendCommand: async command => {
      if (String(command[0]).toUpperCase() === 'SCRIPT') return 'test-script-sha';
      if (String(command[0]).toUpperCase() === 'EVALSHA') return [1, 300000];
      return 'OK';
    },
    set: async () => null,
  });

  try {
    await withServer(buildApp(), async baseUrl => {
      const unauthenticated = await rawRequest(`${baseUrl}/api/market/refresh`, { method: 'POST' });
      assert.equal(unauthenticated.status, 401);

      const user = await rawRequest(`${baseUrl}/api/market/refresh`, {
        method: 'POST',
        headers: { authorization: `Bearer ${userToken}` },
      });
      assert.equal(user.status, 403);

      const admin = await rawRequest(`${baseUrl}/api/market/refresh`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      assert.equal(admin.status, 503);
      const body = await admin.json();
      assert.equal(body.code, 'MARKET_REFRESH_LEASE_UNAVAILABLE');
    });
  } finally {
    setRedisAvailable(false);
    setRedisClient(null);
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
  }
});

test('manual market refresh returns canonical 503 when usable AMFI data was not persisted', () => {
  const response = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  const request = { correlationId: 'safe-request-id' };
  const result = respondToManualMarketRefresh(request, response, [
    { status: 'fulfilled', value: {
      status: 'AVAILABLE',
      persistence: {
        status: 'PERSISTENCE_ERROR',
        error: { code: 'MARKET_PERSISTENCE_FAILED', message: 'must not leak' },
      },
    } },
    { status: 'fulfilled', value: { status: 'SOURCE_ERROR', persistence: { status: 'NOT_PERSISTED' } } },
  ]);

  assert.equal(result, response);
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, 'MARKET_PERSISTENCE_FAILED');
  assert.equal(response.body.request_id, request.correlationId);
  assert.deepEqual(response.body.details.persistenceFailures, [{
    snapshotKind: 'current',
    persistenceStatus: 'PERSISTENCE_ERROR',
    code: 'MARKET_PERSISTENCE_FAILED',
  }]);
  assert.equal(JSON.stringify(response.body).includes('must not leak'), false);
});
