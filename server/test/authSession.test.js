import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureCsrfCookie } from '../services/authSession.js';

test('session restore reuses an existing CSRF cookie without issuing a late Set-Cookie', () => {
  const issuedCookies = [];
  const req = { headers: { cookie: 'wg_csrf=existing-csrf-token' } };
  const res = { cookie: (...args) => issuedCookies.push(args) };

  assert.equal(ensureCsrfCookie(req, res), 'existing-csrf-token');
  assert.deepEqual(issuedCookies, []);
});

test('session restore creates a CSRF cookie only when the browser has none', () => {
  const issuedCookies = [];
  const req = { headers: {} };
  const res = { cookie: (...args) => issuedCookies.push(args) };

  const token = ensureCsrfCookie(req, res);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issuedCookies.length, 1);
  assert.equal(issuedCookies[0][0], 'wg_csrf');
  assert.equal(issuedCookies[0][1], token);
});
