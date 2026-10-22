import { describe, expect, it } from 'vitest';
import {
  findPrivateQuoteForProduct,
  getPrivateMarketObservationRows,
  getPrivateMarketQuoteRequestIds,
} from './privateMarketQuote';

const id = 'etf:isin:INF204KB14I2';
const valid = Object.freeze({
  canonicalProductId: id, availabilityStatus: 'AVAILABLE',
  value: 294.4, observedAt: '2026-10-20T10:00:00.000Z',
  source: { provider: 'UPSTOX', instrumentId: 'NSE_EQ|INF204KB14I2' },
  freshness: { status: 'STALE' },
});

describe('WTI private Upstox ETF quote admission', () => {
  it('accepts a typed response only when provider and registered instrument identity match', () => {
    expect(findPrivateQuoteForProduct({ upstox: { status: 'AVAILABLE', facts: [valid] } }, id)).toEqual(valid);
  });
  it('fails closed on malformed facts, forged identity and invalid numbers', () => {
    for (const facts of [undefined, null, { invalid: valid }, [], [null],
      [{ ...valid, canonicalProductId: 'etf:isin:OTHER' }],
      [{ ...valid, value: '294.4' }], [{ ...valid, value: Infinity }],
      [{ ...valid, value: 0 }], [{ ...valid, observedAt: null }],
      [{ ...valid, source: { provider: 'NSE', instrumentId: 'NSE_EQ|INF204KB14I2' } }],
      [{ ...valid, source: { provider: 'UPSTOX', instrumentId: 'NSE_EQ|OTHER' } }],
      [{ ...valid, availabilityStatus: 'UNAVAILABLE' }]]) {
      expect(findPrivateQuoteForProduct({ upstox: { status: 'AVAILABLE', facts } }, id)).toBeNull();
    }
    expect(findPrivateQuoteForProduct({ upstox: { status: 'UNAVAILABLE', facts: [valid] } }, id)).toBeNull();
    expect(findPrivateQuoteForProduct({ upstox: { status: 'AVAILABLE', facts: [valid] } }, 'FD')).toBeNull();
  });
});

describe('category-scoped Upstox product quotes', () => {
  const etf = {
    ...valid,
    availabilityStatus: 'AVAILABLE',
    value: 259.57,
    currency: 'INR',
    unit: 'PRICE',
    source: { provider: 'UPSTOX', instrumentId: 'NSE_EQ|INF204KB14I2' },
    quoteLastTradeAt: '2026-10-21T10:30:00.000Z',
    quoteResponseGeneratedAt: '2026-10-21T10:31:00.000Z',
    providerResponseReceivedAt: '2026-10-21T10:31:01.000Z',
    freshness: { status: 'STALE' },
  };

  it('requests only exact product identities present in the selected category', () => {
    expect(getPrivateMarketQuoteRequestIds([
      { id, canonicalProductId: id, productType: 'ETF' },
      { id: 'market:index:nifty-50', canonicalProductId: 'market:index:nifty-50', productType: 'INDEX' },
      { id: 'etf:isin:OTHER', canonicalProductId: 'etf:isin:OTHER', productType: 'ETF' },
      { id, canonicalProductId: 'etf:isin:OTHER', productType: 'ETF' },
    ])).toEqual([id]);
    expect(getPrivateMarketQuoteRequestIds([{ id: 'ppf', canonicalProductId: 'ppf' }])).toEqual([]);
  });

  it('shows only the requested ETF and does not expose index or unrelated product observations', () => {
    const nifty = {
      ...etf,
      canonicalProductId: 'market:index:nifty-50',
      source: { provider: 'UPSTOX', instrumentId: 'NSE_INDEX|Nifty 50' },
    };
    expect(getPrivateMarketObservationRows({
      upstox: { status: 'AVAILABLE', facts: [etf, nifty] },
    }, [id])).toMatchObject([{
      canonicalProductId: id,
      name: 'Nippon India ETF Nifty 50 BeES',
      formattedValue: '259.57 INR',
      lastTradeAt: '2026-10-21T10:30:00.000Z',
      responseGeneratedAt: '2026-10-21T10:31:00.000Z',
      fetchedAt: '2026-10-21T10:31:01.000Z',
      freshness: 'STALE',
    }]);
    expect(getPrivateMarketObservationRows({
      upstox: { status: 'AVAILABLE', facts: [etf] },
    }, [])).toEqual([]);
  });

  it('withholds malformed, forged, wrong-provider, and unavailable observations', () => {
    const invalidFacts = [
      { ...etf, canonicalProductId: 'etf:isin:unknown' },
      { ...etf, source: { provider: 'NSE', instrumentId: 'NSE_EQ|INF204KB14I2' } },
      { ...etf, source: { provider: 'UPSTOX', instrumentId: 'NSE_EQ|OTHER' } },
      { ...etf, value: 0 },
      { ...etf, quoteLastTradeAt: 'unknown' },
      { ...etf, availabilityStatus: 'UNAVAILABLE' },
      null,
    ];
    expect(getPrivateMarketObservationRows({
      upstox: { status: 'AVAILABLE', facts: invalidFacts },
    }, [id])).toEqual([]);
    expect(getPrivateMarketObservationRows({
      upstox: { status: 'UNAVAILABLE', facts: [etf] },
    }, [id])).toEqual([]);
  });
});
