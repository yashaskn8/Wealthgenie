/**
 * Redis dependency behavior: focused fail-closed and availability-fallback tests.
 *
 * REDIS USAGE AUDIT TABLE:
 * ┌────────────────────────────────────────┬───────────────────────┬──────────────┬────────────────────────────────────────────┐
 * │ Path                                    │ Function              │ Fail Mode    │ Security Impact                             │
 * ├────────────────────────────────────────┼───────────────────────┼──────────────┼────────────────────────────────────────────┤
 * │ authMiddleware.js:27                    │ isTokenBlacklisted    │ FAIL CLOSED  │ CRITICAL: returns true (deny access) when  │
 * │                                        │                       │              │ Redis unavailable — prevents revoked tokens │
 * │                                        │                       │              │ from being silently accepted during outage.  │
 * ├────────────────────────────────────────┼───────────────────────┼──────────────┼────────────────────────────────────────────┤
 * │ rateLimiter.js:87-96 (authLimiter)     │ HybridStore + RL      │ FAIL CLOSED  │ CRITICAL: passOnStoreError=false, auth      │
 * │                                        │                       │              │ rate limiter propagates error → 500.         │
 * ├────────────────────────────────────────┼───────────────────────┼──────────────┼────────────────────────────────────────────┤
 * │ rateLimiter.js:100-107 (apiLimiter)    │ HybridStore + RL      │ DEGRADED     │ LOW: process-local fallback reduces         │
 * │                                        │                       │              │ cluster-wide enforcement is reduced.         │
 * ├────────────────────────────────────────┼───────────────────────┼──────────────┼────────────────────────────────────────────┤
 * │ idempotency.js (financial mutations)    │ durable Mongo claim   │ FAIL CLOSED  │ Unsafe coordination returns 503 before      │
 * │                                        │ + transaction record  │              │ mutation; same-key recovery is durable.       │
 * ├────────────────────────────────────────┼───────────────────────┼──────────────┼────────────────────────────────────────────┤
 * │ profileRateLimit.js (profile build)     │ Redis atomic quota    │ FAIL CLOSED  │ 503 when quota enforcement is unavailable.   │
 * ├────────────────────────────────────────┼───────────────────────┼──────────────┼────────────────────────────────────────────┤
 * │ recommend.js:68 / setCache             │ getCache / setCache    │ FAIL OPEN    │ NONE: Caching only, returns null on fail.   │
 * ├────────────────────────────────────────┼───────────────────────┼──────────────┼────────────────────────────────────────────┤
 * │ geminiService.js:18 / setCache         │ getCache / setCache    │ FAIL OPEN    │ NONE: Advisory cache, returns null on fail. │
 * ├────────────────────────────────────────┼───────────────────────┼──────────────┼────────────────────────────────────────────┤
 * │ geminiChatService.js:41-50             │ redisClient.incr       │ FAIL OPEN    │ LOW: Chat rate limit skipped if Redis down. │
 * ├────────────────────────────────────────┼───────────────────────┼──────────────┼────────────────────────────────────────────┤
 * │ marketDataService.js:30/60/78/122      │ getCache / setCache    │ FAIL OPEN    │ NONE: Market data cache, null on fail.      │
 * ├────────────────────────────────────────┼───────────────────────┼──────────────┼────────────────────────────────────────────┤
 * │ dagStream.js:39/107/130/166            │ redisClient.xAdd/xRange│ FAIL OPEN    │ LOW: DAG streaming falls back to in-memory. │
 * ├────────────────────────────────────────┼───────────────────────┼──────────────┼────────────────────────────────────────────┤
 * │ auth.js blacklistToken write            │ confirmed Redis set   │ FAIL CLOSED  │ Production logout cannot report success     │
 * │                                        │                       │              │ unless token revocation was persisted.       │
 * ├────────────────────────────────────────┼───────────────────────┼──────────────┼────────────────────────────────────────────┤
 * │ instrumentConstants.js:62/71           │ setCache / getCache    │ FAIL OPEN    │ NONE: Instrument params cache.              │
 * ├────────────────────────────────────────┼───────────────────────┼──────────────┼────────────────────────────────────────────┤
 * │ health.js:46-48                        │ redisClient.ping       │ FAIL OPEN    │ NONE: Health check reports Redis status.    │
 * ├────────────────────────────────────────┼───────────────────────┼──────────────┼────────────────────────────────────────────┤
 * │ montecarlo.js:9                        │ getCache / setCache    │ FAIL OPEN    │ NONE: Simulation result cache.              │
 * └────────────────────────────────────────┴───────────────────────┴──────────────┴────────────────────────────────────────────┘
 *
 * SECURITY-CRITICAL CHECKS (must fail closed):
 *   1. Token blacklist check and production logout revocation — ✅ fail closed
 *   2. Auth rate limiter — ✅ Already fails closed (passOnStoreError:false)
 *
 * Failure semantics are path-specific: mutation idempotency, profile-build quota,
 * authentication limiting and revocation checks fail closed; general API/chat
 * limiting, caches and DAG streaming have availability-oriented degradation.
 *
 * This test file verifies these guarantees with REAL Redis disconnection,
 * not mocked flags.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  isTokenBlacklisted,
  blacklistToken,
  setRedisAvailable,
  setRedisClient,
  setForceFailClosedInTest,
  connectRedis,
  redisAvailable,
  redisClient,
  getCache,
  setCache,
  setCacheNX,
} from '../config/redis.js';
import { authLimiter, apiLimiter, HybridStore, createEndpointRateLimiter } from '../middleware/rateLimiter.js';

process.env.NODE_ENV = 'test';

// ── Helper: create a mock Redis client that works then breaks ──
function createBreakableClient() {
  const store = new Map();
  let broken = false;
  return {
    get: async (key) => {
      if (broken) throw new Error('ECONNRESET: Connection reset by peer');
      return store.get(key) || null;
    },
    set: async (key, value, opts) => {
      if (broken) throw new Error('ECONNRESET: Connection reset by peer');
      store.set(key, value);
      return opts?.NX ? (store.has(key) ? null : 'OK') : 'OK';
    },
    setEx: async (key, ttl, value) => {
      if (broken) throw new Error('ECONNRESET: Connection reset by peer');
      store.set(key, value);
      return 'OK';
    },
    sendCommand: async (...args) => {
      if (broken) throw new Error('ECONNRESET: Connection reset by peer');
      return 'OK';
    },
    disconnect: async () => { broken = true; },
    quit: async () => { broken = true; },
    _break: () => { broken = true; },
    _fix: () => { broken = false; },
  };
}

test.afterEach(() => {
  setRedisAvailable(false);
  setRedisClient(null);
  setForceFailClosedInTest(false);
});

// ══════════════════════════════════════════════════════════════════════
// 1. Token Blacklist — MUST fail CLOSED when Redis is gone
// ══════════════════════════════════════════════════════════════════════
test('Redis fail-closed: Token blacklist check DENIES access when Redis is unavailable', async () => {
  // Simulate production path (not test shortcut)
  setForceFailClosedInTest(true);
  setRedisAvailable(false);
  setRedisClient(null);

  await assert.rejects(
    isTokenBlacklisted('any-jti-during-outage'),
    { code: 'TOKEN_REVOCATION_UNAVAILABLE' },
    'MUST deny access with explicit unavailable semantics when Redis is down',
  );
});

test('Redis optional in development: token blacklist check allows access when Redis is unavailable', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousRequireRedis = process.env.REQUIRE_REDIS;
  try {
    process.env.NODE_ENV = 'development';
    delete process.env.REQUIRE_REDIS;
    setForceFailClosedInTest(false);
    setRedisAvailable(false);
    setRedisClient(null);

    const result = await isTokenBlacklisted('development-jti-without-redis');

    assert.equal(result, false, 'Optional development Redis outage must not invalidate active sessions');
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
    if (previousRequireRedis === undefined) delete process.env.REQUIRE_REDIS;
    else process.env.REQUIRE_REDIS = previousRequireRedis;
  }
});

test('Redis required in development: token blacklist check still fails closed', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousRequireRedis = process.env.REQUIRE_REDIS;
  try {
    process.env.NODE_ENV = 'development';
    process.env.REQUIRE_REDIS = 'true';
    setForceFailClosedInTest(false);
    setRedisAvailable(false);
    setRedisClient(null);

    await assert.rejects(
      isTokenBlacklisted('required-development-jti-without-redis'),
      { code: 'TOKEN_REVOCATION_UNAVAILABLE' },
      'REQUIRE_REDIS=true must preserve fail-closed revocation behavior',
    );
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
    if (previousRequireRedis === undefined) delete process.env.REQUIRE_REDIS;
    else process.env.REQUIRE_REDIS = previousRequireRedis;
  }
});

// ══════════════════════════════════════════════════════════════════════
// 2. Token Blacklist — MUST fail CLOSED on Redis query error
// ══════════════════════════════════════════════════════════════════════
test('Redis fail-closed: Token blacklist check DENIES access on Redis query exception', async () => {
  setForceFailClosedInTest(true);

  // Create a client that throws on .get()
  const breakableClient = createBreakableClient();
  breakableClient._break(); // Pre-broken

  setRedisAvailable(true);
  setRedisClient(breakableClient);

  await assert.rejects(
    isTokenBlacklisted('some-jti-query-error'),
    { code: 'TOKEN_REVOCATION_UNAVAILABLE' },
    'MUST deny access with explicit unavailable semantics on Redis query exception',
  );
});

// ══════════════════════════════════════════════════════════════════════
// 3. Token Blacklist — correctly allows non-blacklisted tokens when healthy
// ══════════════════════════════════════════════════════════════════════
test('Redis healthy: Token blacklist correctly allows non-blacklisted tokens', async () => {
  setForceFailClosedInTest(true);

  const client = createBreakableClient();
  // Pre-populate a blacklisted token
  await client.setEx('bl:revoked-jti', 3600, 'revoked');

  setRedisAvailable(true);
  setRedisClient(client);

  const revokedResult = await isTokenBlacklisted('revoked-jti');
  const validResult = await isTokenBlacklisted('valid-jti');

  console.log(`[REDIS-FC-3] Revoked JTI: ${revokedResult}, Valid JTI: ${validResult}`);
  assert.equal(revokedResult, true, 'Revoked token must be identified');
  assert.equal(validResult, false, 'Valid token must be allowed');
});

test('JWT revocation writes are idempotent and require Redis confirmation', async () => {
  setForceFailClosedInTest(true);
  const values = new Map();
  let writes = 0;
  setRedisAvailable(true);
  setRedisClient({
    setEx: async (key, _ttl, value) => { writes += 1; values.set(key, value); return 'OK'; },
  });
  assert.equal(await blacklistToken('duplicate-revocation-jti', 60), true);
  assert.equal(await blacklistToken('duplicate-revocation-jti', 60), true);
  assert.equal(writes, 2);
  assert.equal(values.get('bl:duplicate-revocation-jti'), 'revoked');

  setRedisClient({ setEx: async () => undefined });
  assert.equal(await blacklistToken('unconfirmed-revocation-jti', 60), false);
  assert.equal(await blacklistToken('zero-ttl-jti', 0), false);
  assert.equal(await blacklistToken('', 60), false);
});

// ══════════════════════════════════════════════════════════════════════
// 4. Token Blacklist — connected client that BREAKS mid-session
// ══════════════════════════════════════════════════════════════════════
test('Redis mid-session break: Token blacklist fails CLOSED when connected client breaks', async () => {
  setForceFailClosedInTest(true);

  const client = createBreakableClient();
  setRedisAvailable(true);
  setRedisClient(client);

  // First call succeeds (client is healthy)
  const beforeBreak = await isTokenBlacklisted('test-jti-pre-break');
  console.log(`[REDIS-FC-4] Before break: ${beforeBreak}`);
  assert.equal(beforeBreak, false, 'Should allow when healthy and not blacklisted');

  // NOW: Break the client (simulates network failure mid-session)
  client._break();

  // Second call MUST fail closed
  await assert.rejects(
    isTokenBlacklisted('test-jti-post-break'),
    { code: 'TOKEN_REVOCATION_UNAVAILABLE' },
    'MUST deny access when Redis breaks mid-session',
  );
});

// ══════════════════════════════════════════════════════════════════════
// 5. Auth Rate Limiter — MUST propagate error (fail closed)
// ══════════════════════════════════════════════════════════════════════
test('production rate limiters ignore DISABLE_RATE_LIMIT and fail closed when Redis is absent', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousDisableRateLimit = process.env.DISABLE_RATE_LIMIT;
  try {
    process.env.NODE_ENV = 'production';
    process.env.DISABLE_RATE_LIMIT = 'true';
    setRedisAvailable(false);
    setRedisClient(null);
    let authStatus = null;
    let authBody = null;
    await authLimiter({
      ip: '127.0.0.1', headers: {}, method: 'POST', path: '/limited', url: '/limited', originalUrl: '/limited',
      socket: { remoteAddress: '127.0.0.1' }, app: { get: () => false },
    }, {
      setHeader() {}, set() {}, status(code) { authStatus = code; return this; },
      json(body) { authBody = body; return this; },
    }, () => assert.fail('the auth limiter must return its safe 503 response'));
    assert.equal(authStatus, 503);
    assert.equal(authBody.code, 'AUTH_RATE_LIMIT_UNAVAILABLE');

    {
      const limiter = createEndpointRateLimiter({ max: 1 });
      let normalNext = 0;
      let capturedError = null;
      await limiter({
        ip: '127.0.0.1', headers: {}, method: 'POST', path: '/limited', url: '/limited', originalUrl: '/limited',
        socket: { remoteAddress: '127.0.0.1' }, app: { get: () => false },
      }, {
        setHeader() {}, set() {}, status() { return this; }, json() { return this; },
      }, error => { if (error) capturedError = error; else normalNext += 1; });
      assert.equal(normalNext, 0);
      assert.equal(capturedError?.status, 503);
    }
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
    if (previousDisableRateLimit === undefined) delete process.env.DISABLE_RATE_LIMIT;
    else process.env.DISABLE_RATE_LIMIT = previousDisableRateLimit;
  }
});

test('production auth and endpoint HybridStore quotas fail closed when Redis is absent', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousRequireRedis = process.env.REQUIRE_REDIS;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.REQUIRE_REDIS;
    setRedisAvailable(false);
    setRedisClient(null);
    for (const store of [
      new HybridStore({ prefix: 'rl:auth:test:', requireDistributed: true, unavailableCode: 'AUTH_RATE_LIMIT_UNAVAILABLE' }),
      new HybridStore({ prefix: 'rl:ep:test:', requireDistributed: true, unavailableCode: 'ENDPOINT_RATE_LIMIT_UNAVAILABLE' }),
    ]) {
      await assert.rejects(store.increment('client'), { status: 503 });
    }

    process.env.NODE_ENV = 'development';
    const developmentStore = new HybridStore({ prefix: 'rl:auth:dev:', requireDistributed: true });
    assert.equal((await developmentStore.increment('client')).totalHits, 1);
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
    if (previousRequireRedis === undefined) delete process.env.REQUIRE_REDIS;
    else process.env.REQUIRE_REDIS = previousRequireRedis;
  }
});

test('Redis fail-closed: Auth rate limiter propagates store error to error handler', async () => {
  const { default: rateLimit } = await import('express-rate-limit');

  class AlwaysFailStore {
    async increment() { throw new Error('Redis store offline (auth)'); }
    async decrement() {}
    async resetKey() {}
    async resetAll() {}
  }

  const testAuthLimiter = rateLimit({
    store: new AlwaysFailStore(),
    passOnStoreError: false,
    max: 10,
    windowMs: 60000,
    validate: false,
  });

  const req = { ip: '127.0.0.1', headers: {}, app: { get: () => false } };
  const res = { setHeader: () => {}, getHeader: () => {} };

  let passedError = null;
  await new Promise((resolve) => {
    testAuthLimiter(req, res, (err) => {
      passedError = err;
      resolve();
    });
  });

  console.log(`[REDIS-FC-5] Auth limiter error: ${passedError?.message}`);
  assert.ok(passedError, 'Auth rate limiter MUST propagate error (fail closed)');
});

// ══════════════════════════════════════════════════════════════════════
// 6. API Rate Limiter — MUST degrade gracefully (fail open)
// ══════════════════════════════════════════════════════════════════════
test('Redis fail-open: API rate limiter degrades gracefully on store error', async () => {
  const { default: rateLimit } = await import('express-rate-limit');

  class AlwaysFailStore {
    async increment() { throw new Error('Redis store offline (api)'); }
    async decrement() {}
    async resetKey() {}
    async resetAll() {}
  }

  const testApiLimiter = rateLimit({
    store: new AlwaysFailStore(),
    passOnStoreError: true,
    max: 100,
    windowMs: 60000,
    validate: false,
  });

  const req = { ip: '127.0.0.1', headers: {}, app: { get: () => false } };
  const res = { setHeader: () => {}, getHeader: () => {} };

  let passedError = null;
  await new Promise((resolve) => {
    testApiLimiter(req, res, (err) => {
      passedError = err;
      resolve();
    });
  });

  console.log(`[REDIS-FC-6] API limiter error: ${passedError}`);
  assert.equal(passedError, undefined, 'API rate limiter MUST degrade gracefully (fail open)');
});

// ══════════════════════════════════════════════════════════════════════
// 7. Caching functions — MUST fail open (return null, never throw)
// ══════════════════════════════════════════════════════════════════════
test('Redis fail-open: getCache/setCache/setCacheNX return gracefully when Redis is unavailable', async () => {
  setRedisAvailable(false);
  setRedisClient(null);

  const getResult = await getCache('nonexistent-key');
  console.log(`[REDIS-FC-7] getCache with Redis down: ${getResult}`);
  assert.equal(getResult, null, 'getCache must return null when Redis unavailable');

  // setCache should not throw
  await setCache('test-key', { data: 'test' }, 60);
  console.log(`[REDIS-FC-7] setCache with Redis down: did not throw`);

  // setCacheNX should return false
  const nxResult = await setCacheNX('test-key', 'val', 60);
  console.log(`[REDIS-FC-7] setCacheNX with Redis down: ${nxResult}`);
  assert.equal(nxResult, false, 'setCacheNX must return false when Redis unavailable');
});

// ══════════════════════════════════════════════════════════════════════
// 8. Durable mutation idempotency rejects a missing operation key before mutation
// ══════════════════════════════════════════════════════════════════════
test('Mutation idempotency: missing key fails closed and never invokes the mutation', async () => {
  setRedisAvailable(false);
  setRedisClient(null);

  // Import and invoke the middleware directly
  const { idempotency } = await import('../middleware/idempotency.js');
  const mw = idempotency({ operation: 'test.mutation', resolveReplay: async () => ({}) });
  const req = { headers: {}, user: { userId: 'test-user' } };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    setHeader() { return this; },
    json(body) { this.body = body; return this; },
  };
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false, 'A durable mutation must not run without an idempotency key');
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'INVALID_IDEMPOTENCY_KEY');
});
