/**
 * Token Budget Middleware - Integration Test
 * -------------------------------------------
 * Proves that a user can be throttled by cumulative *token volume*
 * even while staying under the request-count rate limit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  checkTokenBudget,
  createTokenBudgetService,
  recordTokenUsage,
  TokenBudgetStore,
  _testStore,
} from '../middleware/tokenBudget.js';
import { withServer, rawRequest } from '../test-utils/httpTestUtils.js';

// helpers
function fakeAuth(userId = 'user-1') {
  return (req, _res, next) => {
    req.user = { userId };
    next();
  };
}

function buildApp(budgetOpts = {}) {
  const app = express();
  app.use(express.json());
  app.post(
    '/chat',
    fakeAuth(),
    checkTokenBudget(budgetOpts),
    async (req, res) => {
      const tokens = req.body?.tokens ?? 100;
      await recordTokenUsage(req, tokens);
      res.json({ ok: true, tokensRecorded: tokens });
    }
  );
  return app;
}

function postChat(base, tokens) {
  const body = JSON.stringify({ tokens });
  return rawRequest(base + '/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

// tests

test('token budget: allows requests within the budget', async () => {
  _testStore.resetAll();
  const app = buildApp({ maxTokens: 1000, windowMs: 60000 });

  await withServer(app, async (base) => {
    const r1 = await postChat(base, 400);
    assert.equal(r1.status, 200, 'first request within budget should pass');

    const r2 = await postChat(base, 400);
    assert.equal(r2.status, 200, 'second request still within budget should pass');
  });
});

test('token budget: blocks when cumulative tokens exceed the limit', async () => {
  _testStore.resetAll();
  const app = buildApp({ maxTokens: 500, windowMs: 60000 });

  await withServer(app, async (base) => {
    // Use 300 tokens - under budget
    const r1 = await postChat(base, 300);
    assert.equal(r1.status, 200);

    // Use 250 more - total 550, over 500 budget
    const r2 = await postChat(base, 250);
    assert.equal(r2.status, 200, 'second request passes (budget checked before recording)');

    // Third request should be blocked - cumulative 550 > 500
    const r3 = await postChat(base, 10);
    assert.equal(r3.status, 429, 'third request blocked after budget exceeded');

    const body = await r3.json();
    assert.equal(body.code, 'TOKEN_BUDGET_EXCEEDED');
    assert.equal(body.error, body.message, 'compatibility error alias matches canonical message');
    assert.ok(body.details.retryAfterSeconds > 0, 'structured details include retry-after');
    assert.equal(Number(r3.headers.get('retry-after')), body.details.retryAfterSeconds);
  });
});

test('token budget: different users have independent budgets', async () => {
  _testStore.resetAll();

  const app = express();
  app.use(express.json());

  app.post('/chat/a', fakeAuth('user-A'), checkTokenBudget({ maxTokens: 500 }), (req, res) => {
    recordTokenUsage(req, req.body?.tokens ?? 100);
    res.json({ ok: true });
  });
  app.post('/chat/b', fakeAuth('user-B'), checkTokenBudget({ maxTokens: 500 }), (req, res) => {
    recordTokenUsage(req, req.body?.tokens ?? 100);
    res.json({ ok: true });
  });

  await withServer(app, async (base) => {
    // User A burns 600 tokens (over budget)
    await rawRequest(base + '/chat/a', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tokens: 600 }),
    });

    // User A should be blocked
    const rA = await rawRequest(base + '/chat/a', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tokens: 1 }),
    });
    assert.equal(rA.status, 429, 'user A blocked');

    // User B should still be allowed
    const rB = await rawRequest(base + '/chat/b', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tokens: 100 }),
    });
    assert.equal(rB.status, 200, 'user B unaffected by user A exhausting budget');
  });
});

test('token budget: window resets after expiry', async () => {
  _testStore.resetAll();
  // Very short window: 200ms
  const app = buildApp({ maxTokens: 100, windowMs: 200 });

  await withServer(app, async (base) => {
    // Exhaust budget
    await postChat(base, 150);
    const blocked = await postChat(base, 1);
    assert.equal(blocked.status, 429, 'blocked immediately after exhausting budget');

    // Wait for window to reset
    await new Promise(r => setTimeout(r, 300));

    const afterReset = await postChat(base, 50);
    assert.equal(afterReset.status, 200, 'allowed again after window reset');
  });
});

test('token budget: many small requests stay under budget', async () => {
  _testStore.resetAll();
  const app = buildApp({ maxTokens: 10000, windowMs: 60000 });

  await withServer(app, async (base) => {
    for (let i = 0; i < 20; i++) {
      const r = await postChat(base, 10);
      assert.equal(r.status, 200, 'request ' + (i + 1) + ' should pass (low token usage)');
    }
  });
});

test('token reservations atomically admit concurrent provider attempts and settle known usage', async () => {
  const localStore = new TokenBudgetStore();
  const service = createTokenBudgetService({
    getRedisState: () => ({ available: false, client: null }),
    env: { NODE_ENV: 'test' },
    localStore,
  });
  const admissions = await Promise.all([
    service.reserve('parallel-user', 60, { maxTokens: 100, reservationId: 'parallel-a' }),
    service.reserve('parallel-user', 50, { maxTokens: 100, reservationId: 'parallel-b' }),
  ]);

  assert.equal(admissions.filter(item => item.allowed).length, 1);
  assert.equal(admissions.filter(item => !item.allowed).length, 1);
  const accepted = admissions.find(item => item.allowed);
  assert.equal((await service.settle(accepted, 40)).settled, true);
  assert.equal((await service.settle(accepted, 40)).settled, false, 'settlement is idempotent');
  const next = await service.reserve('parallel-user', 60, { maxTokens: 100, reservationId: 'parallel-c' });
  assert.equal(next.allowed, true, 'known lower usage releases the unused reservation');
});

test('unknown provider usage charges the whole token reservation', async () => {
  const localStore = new TokenBudgetStore();
  const service = createTokenBudgetService({
    getRedisState: () => ({ available: false, client: null }),
    env: { NODE_ENV: 'test' },
    localStore,
  });
  const reserved = await service.reserve('unknown-usage-user', 75, { maxTokens: 100, reservationId: 'unknown-usage' });
  await service.settle(reserved, null);
  assert.equal(localStore.peek('unknown-usage-user').totalTokens, 75);
});

test('an in-flight local reservation survives window rollover and settles into the new window', async () => {
  let now = 10_000;
  const localStore = new TokenBudgetStore({ now: () => now });
  const service = createTokenBudgetService({
    getRedisState: () => ({ available: false, client: null }),
    env: { NODE_ENV: 'test' },
    localStore,
  });
  const reservation = await service.reserve('late-provider-user', 80, {
    maxTokens: 100,
    windowMs: 100,
    reservationId: 'late-provider-attempt',
  });
  now += 101;
  assert.equal((await service.inspect('late-provider-user', { maxTokens: 100, windowMs: 100 })).totalTokens, 80);
  assert.equal((await service.settle(reservation, 25)).settled, true);
  assert.equal(localStore.peek('late-provider-user', 100).totalTokens, 25);
});

test('Redis eval contract atomically reserves, decodes settlement and carries late attempts across rollover', async () => {
  let now = 20_000;
  const buckets = new Map();
  const fakeRedis = {
    async eval(script, { keys, arguments: args }) {
      const key = keys[0];
      const [windowValue, maxValue, amountValue, reservationId, graceValue] = args;
      const windowMs = Number(windowValue || 0);
      const graceMs = Number(graceValue || 0);
      let bucket = buckets.get(key);
      const rotate = requestedWindow => {
        if (!bucket || now >= bucket.resetAt) {
          const active = bucket ? [...bucket.reservations.values()].reduce((sum, value) => sum + value, 0) : 0;
          bucket = { tokens: 0, reserved: active, resetAt: now + requestedWindow, reservations: bucket?.reservations || new Map() };
          buckets.set(key, bucket);
        }
      };

      if (script.includes("local reservationId = ARGV[4]")) {
        rotate(windowMs);
        const existing = bucket.reservations.get(reservationId);
        if (existing !== undefined) return [existing === Number(amountValue) ? 1 : -1, bucket.tokens, bucket.reserved, bucket.resetAt - now];
        if (bucket.tokens + bucket.reserved + Number(amountValue) > Number(maxValue)) {
          return [0, bucket.tokens, bucket.reserved, bucket.resetAt - now];
        }
        bucket.reservations.set(reservationId, Number(amountValue));
        bucket.reserved += Number(amountValue);
        return [1, bucket.tokens, bucket.reserved, bucket.resetAt - now];
      }
      if (script.includes("local field = 'r:' .. ARGV[1]")) {
        const [id, actualValue, settleWindowValue, settleGraceValue] = args;
        rotate(Number(settleWindowValue));
        const amount = bucket.reservations.get(id);
        if (amount === undefined) return [0, bucket.tokens, bucket.reserved];
        const charge = Number(actualValue) < 0 ? amount : Number(actualValue);
        bucket.reservations.delete(id);
        bucket.reserved = Math.max(0, bucket.reserved - amount);
        bucket.tokens += charge;
        return [1, bucket.tokens, bucket.reserved, Number(settleGraceValue) || graceMs];
      }
      if (script.includes("return {\n  tonumber(redis.call('HGET', KEYS[1], 'tokens')")) {
        rotate(windowMs);
        return [bucket.tokens, bucket.reserved, bucket.resetAt - now];
      }
      throw new Error('Unexpected Redis script in eval contract test.');
    },
  };
  const service = createTokenBudgetService({
    getRedisState: () => ({ available: true, client: fakeRedis }),
    env: { NODE_ENV: 'production' },
    localStore: new TokenBudgetStore(),
  });
  const [first, second] = await Promise.all([
    service.reserve('redis-contract-user', 65, { maxTokens: 100, windowMs: 100, reservationId: 'redis-a' }),
    service.reserve('redis-contract-user', 45, { maxTokens: 100, windowMs: 100, reservationId: 'redis-b' }),
  ]);
  assert.equal([first, second].filter(item => item.allowed).length, 1);
  const accepted = first.allowed ? first : second;
  now += 101;
  const inspected = await service.inspect('redis-contract-user', { maxTokens: 100, windowMs: 100 });
  assert.equal(inspected.totalTokens, accepted.tokens, 'pending provider usage remains reserved after window rollover');
  assert.equal((await service.settle(accepted, 30)).settled, true);
  assert.equal((await service.settle(accepted, 30)).settled, false, 'replay does not charge the settled Redis reservation twice');
  assert.equal((await service.inspect('redis-contract-user', { maxTokens: 100, windowMs: 100 })).totalTokens, 30);
  const next = await service.reserve('redis-contract-user', 65, { maxTokens: 100, windowMs: 100, reservationId: 'redis-c' });
  assert.equal(next.allowed, true, 'settlement releases the unused reservation in the new window');
});

test('production token reservations fail closed when Redis capacity is unavailable', async () => {
  const service = createTokenBudgetService({
    getRedisState: () => ({ available: false, client: null }),
    env: { NODE_ENV: 'production' },
    localStore: new TokenBudgetStore(),
  });
  await assert.rejects(
    service.reserve('production-user', 10, { maxTokens: 100 }),
    error => error.code === 'TOKEN_BUDGET_STORE_UNAVAILABLE' && error.status === 503,
  );
});
