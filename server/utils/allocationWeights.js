export const ALLOCATION_WEIGHT_TOTAL_TOLERANCE = 0.0001;
export const REBALANCE_TARGET_TOTAL_TOLERANCE_PERCENT = ALLOCATION_WEIGHT_TOTAL_TOLERANCE * 100;

/** Accept tiny representation drift around a unit total, then normalize it. */
export function normalizeAllocationWeights(weights) {
  if (!Array.isArray(weights) || weights.length === 0) {
    throw new TypeError('allocation weights must be a non-empty array');
  }
  if (weights.some(weight => !Number.isFinite(weight) || weight < 0 || weight > 1)) {
    throw new RangeError('allocation weights must be finite numbers from 0 to 1');
  }
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0) || Math.abs(total - 1) > ALLOCATION_WEIGHT_TOTAL_TOLERANCE) {
    throw new RangeError(`allocation weights must total 1 within ${ALLOCATION_WEIGHT_TOTAL_TOLERANCE}; received ${total}`);
  }
  return weights.map(weight => weight / total);
}
