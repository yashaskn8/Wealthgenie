import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import authRoutes from '../routes/auth.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { createCsrfProtection } from '../middleware/csrf.js';
import { withServer, jsonRequest } from '../test-utils/httpTestUtils.js';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';
import { assertRuntimeResponseMatchesContract } from './helpers/openapiRuntimeContract.js';
import User from '../models/User.js';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'cookie-session-test-secret-at-least-32-characters';
process.env.EXPOSE_AUTH_TOKEN = 'false';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createCsrfProtection({ allowedOrigins: [], isProduction: false }));
  app.use('/api/auth', authRoutes);
  app.use(errorHandler);
  return app;
}

test('HttpOnly cookie session authenticates restore and logout without exposing JWT', async () => {
  await setupTestDatabase({ requireReplicaSet: true });
  try {
    await withServer(buildApp(), async (baseUrl) => {
      const registration = await jsonRequest(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Cookie User',
          email: 'cookie-session@example.com',
          password: 'StrongPass1!',
        }),
      });
      assert.equal(registration.response.status, 201);
      assert.equal(registration.body.token, undefined);
      assertRuntimeResponseMatchesContract({
        method: 'POST', path: '/api/auth/register', status: registration.response.status,
        contentType: registration.response.headers.get('content-type'), body: registration.body,
      });

      const login = await jsonRequest(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        body: JSON.stringify({ email: 'cookie-session@example.com', password: 'StrongPass1!' }),
      });
      assert.equal(login.response.status, 200);
      assertRuntimeResponseMatchesContract({
        method: 'POST', path: '/api/auth/login', status: login.response.status,
        contentType: login.response.headers.get('content-type'), body: login.body,
      });

      const rawSetCookie = registration.response.headers.get('set-cookie');
      const setCookie = Array.isArray(rawSetCookie) ? rawSetCookie[0] : rawSetCookie;
      assert.match(setCookie, /^wg_session=/);
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Strict/i);
      const cookie = setCookie.split(';')[0];
      const csrfToken = registration.body.csrfToken;
      assert.match(csrfToken, /^[A-Za-z0-9_-]{43}$/);
      const cookieHeader = `${cookie}; wg_csrf=${encodeURIComponent(csrfToken)}`;

      const restored = await jsonRequest(`${baseUrl}/api/auth/session`, {
        headers: { cookie: cookieHeader },
      });
      assert.equal(restored.response.status, 200);
      assert.equal(restored.body.user.email, 'cookie-session@example.com');
      assert.equal(restored.response.headers.get('set-cookie'), null, 'session restore must not reissue an existing CSRF cookie after a concurrent login could rotate it');
      assertRuntimeResponseMatchesContract({
        method: 'GET', path: '/api/auth/session', status: restored.response.status,
        contentType: restored.response.headers.get('content-type'), body: restored.body,
      });

      const rejectedLogout = await jsonRequest(`${baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { cookie: cookieHeader },
        body: JSON.stringify({}),
      });
      assert.equal(rejectedLogout.response.status, 403);
      assert.equal(rejectedLogout.body.code, 'CSRF_TOKEN_INVALID');
      assertRuntimeResponseMatchesContract({
        method: 'POST', path: '/api/auth/logout', status: rejectedLogout.response.status,
        contentType: rejectedLogout.response.headers.get('content-type'), body: rejectedLogout.body,
      });

      const logout = await jsonRequest(`${baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
        body: JSON.stringify({}),
      });
      assert.equal(logout.response.status, 200);
      assertRuntimeResponseMatchesContract({
        method: 'POST', path: '/api/auth/logout', status: logout.response.status,
        contentType: logout.response.headers.get('content-type'), body: logout.body,
      });
      const rawClearedCookie = logout.response.headers.get('set-cookie');
      const clearedCookie = Array.isArray(rawClearedCookie) ? rawClearedCookie[0] : rawClearedCookie;
      assert.match(clearedCookie, /wg_session=;/);
    });
  } finally {
    await User.deleteMany({ email: 'cookie-session@example.com' });
    await teardownTestDatabase();
  }
});
