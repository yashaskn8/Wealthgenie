import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import profileRoutes from '../routes/profile.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { withServer, jsonRequest } from '../test-utils/httpTestUtils.js';
import { withMockAuthAccountState } from './helpers/mockAuthAccountState.js';

const JWT_SECRET = 'profile-precompute-rate-limit-test-secret';
process.env.JWT_SECRET = JWT_SECRET;
process.env.NODE_ENV = 'test';

test('profile precompute has a dedicated per-user workload limit', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/profile', profileRoutes);
  app.use(errorHandler);
  const userId = crypto.randomBytes(12).toString('hex');
  const token = jwt.sign({ userId, jti: crypto.randomUUID() }, JWT_SECRET, { expiresIn: '1h' });

  await withMockAuthAccountState(async () => {
    await withServer(app, async baseUrl => {
      const headers = { Authorization: `Bearer ${token}` };
      const statuses = [];
      for (let index = 0; index < 30; index += 1) {
        const result = await jsonRequest(`${baseUrl}/api/profile/precompute`, {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
        });
        statuses.push(result.response.status);
      }
      assert.deepEqual(new Set(statuses), new Set([400]));

      const limited = await jsonRequest(`${baseUrl}/api/profile/precompute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      assert.equal(limited.response.status, 429);
      assert.equal(limited.body.code, 'ENDPOINT_RATE_LIMIT_EXCEEDED');
    });
  });
});
