import assert from 'node:assert/strict';
import test from 'node:test';
import { createTejHqRequestBudget } from '../services/marketData/tejHqRequestBudget.js';

test('TejHQ keyed-request budget uses the conservative default and resets by UTC day', async () => {
  let now = new Date('2026-10-13T23:59:00.000Z');
  const budget = createTejHqRequestBudget({
    env: { NODE_ENV: 'test' },
    clock: () => now,
    redisIsAvailable: () => false,
    localUsage: new Map(),
  });

  let result;
  for (let index = 0; index < 200; index += 1) result = await budget();
  assert.deepEqual(result, { allowed: true, code: null, used: 200, limit: 200 });
  assert.equal((await budget()).code, 'TEJHQ_INTERNAL_DAILY_BUDGET_EXHAUSTED');

  now = new Date('2026-10-14T00:00:00.000Z');
  assert.deepEqual(await budget(), { allowed: true, code: null, used: 1, limit: 200 });
});

test('TejHQ budget reserves a shared Redis counter atomically and bounds the configured cap', async () => {
  const calls = [];
  let sharedUsed = 99;
  const budget = createTejHqRequestBudget({
    env: { NODE_ENV: 'production', TEJHQ_INTERNAL_DAILY_REQUEST_BUDGET: '100' },
    clock: () => new Date('2026-10-13T06:00:00.000Z'),
    redisIsAvailable: () => true,
    redis: { eval: async (script, options) => {
      calls.push({ script, options });
      if (sharedUsed >= Number(options.arguments[0])) return -sharedUsed;
      sharedUsed += 1;
      return sharedUsed;
    } },
  });
  assert.deepEqual(await budget(), { allowed: true, code: null, used: 100, limit: 100 });
  assert.deepEqual(await budget(), { allowed: false, code: 'TEJHQ_INTERNAL_DAILY_BUDGET_EXHAUSTED', used: 100, limit: 100 });
  assert.match(calls[0].script, /INCR/);
  assert.deepEqual(calls[0].options.keys, ['market:tejhq:keyed-budget:2026-10-13']);
  assert.deepEqual(calls[0].options.arguments, ['100']);

  const invalid = createTejHqRequestBudget({
    env: { NODE_ENV: 'test', TEJHQ_INTERNAL_DAILY_REQUEST_BUDGET: '1001' },
    redisIsAvailable: () => false,
  });
  assert.equal((await invalid()).code, 'TEJHQ_BUDGET_CONFIG_INVALID');
});

test('production TejHQ keyed requests fail closed when shared budget state is unavailable or invalid', async () => {
  const unavailable = createTejHqRequestBudget({
    env: { NODE_ENV: 'production' },
    redisIsAvailable: () => false,
    redis: () => null,
  });
  assert.equal((await unavailable()).code, 'TEJHQ_BUDGET_STORE_UNAVAILABLE');

  const brokenStore = createTejHqRequestBudget({
    env: { NODE_ENV: 'production' },
    redisIsAvailable: () => true,
    redis: { eval: async () => { throw new Error('store failure'); } },
  });
  assert.equal((await brokenStore()).code, 'TEJHQ_BUDGET_STORE_UNAVAILABLE');

  const invalidCounter = createTejHqRequestBudget({
    env: { NODE_ENV: 'production' },
    redisIsAvailable: () => true,
    redis: { eval: async () => Number.NaN },
  });
  assert.equal((await invalidCounter()).code, 'TEJHQ_BUDGET_STORE_INVALID');
});
