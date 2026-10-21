import test from 'node:test';
import assert from 'node:assert/strict';
import { monetaryTargetCacheKey, allocationCacheKey } from '../services/monteCarloCacheIdentity.js';

test('cash target key does not collide when two accepted targets round to the same integer', () => {
  assert.equal(monetaryTargetCacheKey(undefined), 'none');
  assert.notEqual(monetaryTargetCacheKey(1000000.1), monetaryTargetCacheKey(1000000.4));
  assert.throws(() => monetaryTargetCacheKey(NaN), /finite/);
});
test('portfolio cache key distinguishes sub-millionth changes and ignores property order', () => {
  const first = allocationCacheKey({ ETF: 0.5, Equity_MF: 0.5 });
  assert.notEqual(first, allocationCacheKey({ ETF: 0.5000002, Equity_MF: 0.4999998 }));
  assert.equal(first, allocationCacheKey({ Equity_MF: 0.5, ETF: 0.5 }));
  assert.throws(() => allocationCacheKey({ ETF: Infinity }), /finite/);
});
