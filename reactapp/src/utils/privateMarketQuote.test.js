import { describe, expect, it } from 'vitest';
import { findPrivateQuoteForProduct } from './privateMarketQuote';

const id = 'etf:isin:INF204KB14I2';
const valid = Object.freeze({
  canonicalProductId: id, availabilityStatus: 'AVAILABLE',
  value: 294.4, observedAt: '2026-10-20T10:00:00.000Z',
  freshness: { status: 'STALE' },
});

describe('WTI private Upstox ETF quote admission', () => {
  it('accepts a typed, exact-identity last-traded observation', () => {
    expect(findPrivateQuoteForProduct({ upstox: { status: 'AVAILABLE', facts: [valid] } }, id)).toEqual(valid);
  });
  it('fails closed on malformed facts, forged identity and invalid numbers', () => {
    for (const facts of [undefined, null, { invalid: valid }, [], [null],
      [{ ...valid, canonicalProductId: 'etf:isin:OTHER' }],
      [{ ...valid, value: '294.4' }], [{ ...valid, value: Infinity }],
      [{ ...valid, value: 0 }], [{ ...valid, observedAt: null }],
      [{ ...valid, availabilityStatus: 'UNAVAILABLE' }]]) {
      expect(findPrivateQuoteForProduct({ upstox: { status: 'AVAILABLE', facts } }, id)).toBeNull();
    }
    expect(findPrivateQuoteForProduct({ upstox: { status: 'UNAVAILABLE', facts: [valid] } }, id)).toBeNull();
    expect(findPrivateQuoteForProduct({ upstox: { status: 'AVAILABLE', facts: [valid] } }, 'FD')).toBeNull();
  });
});
