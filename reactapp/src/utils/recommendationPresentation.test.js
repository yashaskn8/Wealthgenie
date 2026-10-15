import { describe, expect, it } from 'vitest';
import { assertBackendMonthlyAllocation, assertBackendRecommendationInstrument, formatINR } from './recommendationPresentation';
import { assertKnownBackendInstrumentTypes, backendToLocalInstrument } from './instrumentTypeMap';

const valid = {
  id: 'index_mf', name: 'Index Mutual Fund', type: 'Index_MF', allocationWeight: 1,
  allocation_pct: 100, nominalReturn: 10, effectiveYield: 10, riskScore: 3, riskLevel: 'Medium',
  lockIn: 0, expenseRatio: 0.003, tags: ['Wealth Growth'],
  returnBasis: 'PRE_TAX_NOMINAL', postTaxReturn: null, assetClass: 'Equity',
  score: 82, scoreFactors: { goalFit: 100 },
};

describe('recommendation presentation authority boundary', () => {
  it('formats genuine zero and Indian currency but never coerces absent financial facts', () => {
    expect(formatINR(0)).toBe('₹0');
    expect(formatINR(125000.4)).toBe('₹1,25,000');
    for (const value of [null, undefined, '', ' ', false, [], NaN, Infinity]) expect(formatINR(value)).toBe('—');
  });
  it('accepts a complete authoritative recommendation instrument', () => {
    expect(assertBackendRecommendationInstrument(valid)).toBe(valid);
    expect(backendToLocalInstrument('Index_MF')).toBe('index_mf');
    expect(backendToLocalInstrument('Arbitrage_MF')).toBe('arbitrage_mf');
    expect(assertKnownBackendInstrumentTypes(['Index_MF', 'Arbitrage_MF'])).toEqual([]);
  });

  it('preserves an explicit zero monthly allocation and rejects missing or malformed allocations', () => {
    expect(assertBackendMonthlyAllocation(0, 'debt')).toBe(0);
    expect(assertBackendMonthlyAllocation(1250, 'debt')).toBe(1250);
    for (const value of [null, undefined, '', ' ', '0', -1, NaN, Infinity]) {
      expect(() => assertBackendMonthlyAllocation(value, 'debt')).toThrow(/monthly allocation is invalid/);
    }
  });

  it.each([
    ['missing id', { id: undefined }],
    ['missing allocation', { allocationWeight: undefined }],
    ['inconsistent allocation', { allocation_pct: 99 }],
    ['out-of-range risk', { riskScore: 6 }],
    ['post-tax recommendation', { postTaxReturn: 8 }],
    ['wrong return basis', { returnBasis: 'POST_TAX' }],
    ['null numeric field', { expenseRatio: null }],
    ['mismatched effective yield', { effectiveYield: 9 }],
    ['missing tags', { tags: undefined }],
  ])('rejects %s', (_label, patch) => {
    expect(() => assertBackendRecommendationInstrument({ ...valid, ...patch })).toThrow();
  });

  it('fails closed for unknown backend mappings', () => {
    expect(backendToLocalInstrument('Invented_Product')).toBeNull();
    expect(() => assertKnownBackendInstrumentTypes(['Invented_Product'], 'test')).toThrow(/unknown/);
  });
});
