import assert from 'node:assert/strict';
import test from 'node:test';
import { CHAT_RATE_LIMIT, checkChatRateLimit } from '../services/chatRateLimit.js';

const unavailableQuota = error => error.status === 503 && error.code === 'CHAT_RATE_LIMIT_UNAVAILABLE';

test('production chat quota fails closed when Redis is absent', async () => {
  await assert.rejects(
    checkChatRateLimit('user-1', {
      env: { NODE_ENV: 'production' },
      redisState: { available: false, client: null },
    }),
    unavailableQuota,
  );
});

test('production chat quota fails closed when a Redis write fails', async () => {
  await assert.rejects(
    checkChatRateLimit('user-1', {
      env: { NODE_ENV: 'production' },
      redisState: {
        available: true,
        client: { async eval() { throw new Error('connection reset'); } },
      },
    }),
    unavailableQuota,
  );
});

test('REQUIRE_REDIS fails closed outside production when shared quota storage is absent', async () => {
  await assert.rejects(
    checkChatRateLimit('user-1', {
      env: { NODE_ENV: 'test', REQUIRE_REDIS: 'true' },
      redisState: { available: false, client: null },
    }),
    unavailableQuota,
  );
});

test('non-production chat quota uses a bounded per-user fallback', async () => {
  const localHits = new Map();
  const options = {
    env: { NODE_ENV: 'test' },
    redisState: { available: false, client: null },
    localHits,
    now: () => 1_000,
  };

  for (let count = 1; count < CHAT_RATE_LIMIT; count += 1) {
    assert.deepEqual(await checkChatRateLimit('user-1', options), { allowed: true, count, resetAt: 3_601_000 });
  }
  assert.deepEqual(await checkChatRateLimit('user-1', options), { allowed: true, count: CHAT_RATE_LIMIT, resetAt: 3_601_000 });
  assert.deepEqual(await checkChatRateLimit('user-1', options), { allowed: false, count: CHAT_RATE_LIMIT, ttl: 3600, resetAt: 3_601_000 });
  assert.deepEqual(await checkChatRateLimit('user-1', { ...options, now: () => 3_601_000 }), { allowed: true, count: 1, resetAt: 7_201_000 });
});

test('chat quota uses the shared Redis counter when available', async () => {
  const evaluations = [];
  const options = {
    env: { NODE_ENV: 'production' },
    redisState: {
      available: true,
      client: {
        async eval(script, command) {
          evaluations.push({ script, command });
          return [CHAT_RATE_LIMIT, 2718];
        },
      },
    },
    now: () => 12_345,
  };

  assert.deepEqual(await checkChatRateLimit('user-1', options), { allowed: true, count: CHAT_RATE_LIMIT, resetAt: 2_730_345 });
  assert.match(evaluations[0].script, /INCR[\s\S]*EXPIRE[\s\S]*TTL/);
  assert.deepEqual(evaluations[0].command, {
    keys: ['chat:ratelimit:user-1'],
    arguments: ['3600'],
  });
});

test('a retry repairs a missing Redis TTL after an ambiguous quota response', async () => {
  let calls = 0;
  const redisCounter = { count: 0, ttl: null };
  const client = {
    async eval(script, command) {
      calls += 1;
      if (calls === 1) {
        // Model a delivered counter mutation whose reply was lost before an
        // expiry was installed, leaving state the next eval must repair.
        redisCounter.count += 1;
        redisCounter.ttl = -1;
        throw new Error('response lost after command delivery');
      }

      assert.match(script, /if count == 1 or ttl < 0 then[\s\S]*EXPIRE/);
      const count = ++redisCounter.count;
      if (count === 1 || redisCounter.ttl < 0) {
        redisCounter.ttl = Number(command.arguments[0]);
      }
      return [count, redisCounter.ttl];
    },
  };
  const options = {
    env: { NODE_ENV: 'production' },
    redisState: { available: true, client },
    now: () => 12_345,
  };

  await assert.rejects(checkChatRateLimit('user-1', options), unavailableQuota);
  assert.deepEqual(redisCounter, { count: 1, ttl: -1 });
  assert.deepEqual(await checkChatRateLimit('user-1', options), { allowed: true, count: 2, resetAt: 3_612_345 });
  assert.equal(calls, 2);
  assert.equal(redisCounter.ttl, 3600);
});
