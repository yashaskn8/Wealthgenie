import { describe, expect, it } from 'vitest';
import { formatCompactINR, formatINR, formatPercent } from './indianNumberFormat.js';

describe('Indian number formatting', () => {
  it('fails closed for absent and invalid financial values', () => {
    expect(formatINR(null)).toBe('—');
    expect(formatCompactINR(undefined)).toBe('—');
    expect(formatPercent(Number.NaN)).toBe('—');
    expect(formatINR(Number.POSITIVE_INFINITY)).toBe('—');
    for (const value of [' ', '0x10', false, []]) {
      expect(formatINR(value)).toBe('—');
      expect(formatCompactINR(value)).toBe('—');
      expect(formatPercent(value)).toBe('—');
    }
  });

  it('formats negative compact values without duplicate or misplaced signs', () => {
    expect(formatINR(-100000)).toBe('-₹1.00 L');
    expect(formatCompactINR(-25000000)).toBe('-₹2.5 Cr');
    expect(formatCompactINR(-1000000000000)).toBe('-₹1.0 L Cr');
  });

  it('preserves valid zero values instead of treating them as unavailable', () => {
    expect(formatINR(0)).toBe('₹0');
    expect(formatCompactINR(0)).toBe('₹0');
    expect(formatPercent(0)).toBe('0%');
  });
});
