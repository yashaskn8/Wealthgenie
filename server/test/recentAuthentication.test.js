import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import test from 'node:test';
import { hasRecentSessionAuthentication, PASSKEY_ENROLLMENT_MAX_AUTH_AGE_SECONDS } from '../agents/authorization/recentAuthentication.js';
import agentRoutes from '../routes/agentRoutes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { withMockAuthAccountState } from './helpers/mockAuthAccountState.js';
import { withServer, rawRequest } from '../test-utils/httpTestUtils.js';

test('passkey enrollment requires a signed session issued within five minutes', () => {
  const now = Date.parse('2026-10-06T12:00:00.000Z');
  const nowSeconds = Math.floor(now / 1000);
  assert.equal(hasRecentSessionAuthentication({ iat: nowSeconds }, now), true);
  assert.equal(hasRecentSessionAuthentication({ iat: nowSeconds - PASSKEY_ENROLLMENT_MAX_AUTH_AGE_SECONDS }, now), true);
  assert.equal(hasRecentSessionAuthentication({ iat: nowSeconds - PASSKEY_ENROLLMENT_MAX_AUTH_AGE_SECONDS - 1 }, now), false);
  assert.equal(hasRecentSessionAuthentication({ iat: nowSeconds + 31 }, now), false);
  assert.equal(hasRecentSessionAuthentication({}, now), false);
  assert.equal(hasRecentSessionAuthentication({ iat: 'recent' }, now), false);
});

test('passkey registration routes reject stale or missing signed iat before invoking enrollment services', async () => {
  const previousSecret = process.env.JWT_SECRET;
  const secret = 'recent-auth-route-test-secret-at-least-32-characters';
  process.env.JWT_SECRET = secret;
  const app = express();
  app.use(express.json());
  app.locals.runtimeConfig = { authorization: { verifiableActionsEnabled: true } };
  app.use('/api/agent', agentRoutes);
  app.use(errorHandler);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const stale = jwt.sign({ userId: '64b000000000000000000010', iat: nowSeconds - 301 }, secret, { algorithm: 'HS256' });
  const missingIat = jwt.sign({ userId: '64b000000000000000000010' }, secret, { algorithm: 'HS256', noTimestamp: true });
  const validResponse = JSON.stringify({
    id: 'response-id', rawId: 'response-id', type: 'public-key', response: {}, clientExtensionResults: {},
  });
  try {
    await withMockAuthAccountState(() => withServer(app, async baseUrl => {
      for (const token of [stale, missingIat]) {
        for (const [route, body] of [
          ['/passkeys/registration/options', null],
          ['/passkeys/registration/verify', validResponse],
        ]) {
          const response = await rawRequest(`${baseUrl}/api/agent${route}`, {
            method: 'POST',
            body,
            headers: {
              authorization: `Bearer ${token}`,
              ...(body ? { 'content-type': 'application/json' } : {}),
            },
          });
          const payload = await response.json();
          assert.equal(response.status, 403);
          assert.equal(payload.code, 'AUTH_REAUTH_REQUIRED');
        }
      }
    }));
  } finally {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});
