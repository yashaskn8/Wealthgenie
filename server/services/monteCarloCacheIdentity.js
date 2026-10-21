/** Preserve exact accepted Monte Carlo inputs in cache identity. */
export function monetaryTargetCacheKey(value) {
  if (value === undefined) return 'none';
  if (!Number.isFinite(value) || value < 0) throw new RangeError('Target must be finite and non-negative');
  return String(value);
}

export function allocationCacheKey(allocations) {
  if (!allocations || typeof allocations !== 'object' || Array.isArray(allocations)) {
    throw new TypeError('Portfolio allocations must be an object');
  }
  const pairs = Object.entries(allocations);
  if (!pairs.length || pairs.some(([key, weight]) => (
    !key || !Number.isFinite(weight) || weight < 0 || weight > 1
  ))) throw new RangeError('Portfolio allocations must have finite unit weights');
  return JSON.stringify(pairs.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
