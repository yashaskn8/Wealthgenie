import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthLimiter, HybridStore, shouldSkipRateLimit } from '../middleware/rateLimiter.js';
import { validateEnvironmentConfig } from '../config/validateEnv.js';

test('rate-limit bypass is limited to non-production environments', () => {
  assert.equal(shouldSkipRateLimit({ NODE_ENV: 'development', DISABLE_RATE_LIMIT: 'true' }), true);
  assert.equal(shouldSkipRateLimit({ NODE_ENV: 'test', DISABLE_RATE_LIMIT: 'true' }), true);
  assert.equal(shouldSkipRateLimit({ NODE_ENV: 'production', DISABLE_RATE_LIMIT: 'true' }), false);
});

test('production configuration rejects DISABLE_RATE_LIMIT=true', () => {
  const result = validateEnvironmentConfig({ NODE_ENV: 'production', DISABLE_RATE_LIMIT: 'true' });
  assert.ok(result.errors.includes('DISABLE_RATE_LIMIT must not be enabled in production'));
});

test('authentication limiter does not fall back to process memory if Redis drops between readiness and increment', async () => {
  const store = new HybridStore({ requireSharedStore: true });
  store.getStore = () => null;
  await assert.rejects(store.increment('auth-fixture'), /Shared rate-limit store is unavailable/);
  assert.equal(store.hits.size, 0);
});

test('authentication fails with a safe 503 when shared Redis rate-limit capacity is unavailable in production', async () => {
  const limiter = createAuthLimiter({
    env: { NODE_ENV: 'production', DISABLE_RATE_LIMIT: 'true' },
    getRedisState: () => ({ available: false, client: null }),
  });
  const req = { headers: {}, correlationId: 'rate-limit-fixture' };
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let passedToNext = false;

  await limiter(req, res, () => { passedToNext = true; });

  assert.equal(passedToNext, false);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'AUTH_RATE_LIMIT_UNAVAILABLE');
});
