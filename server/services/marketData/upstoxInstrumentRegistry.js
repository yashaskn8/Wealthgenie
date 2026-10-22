import { MARKET_BENCHMARKS } from './marketBenchmarks.js';
import { QUALIFIED_NIFTY_ETF_IDENTITY, isQualifiedNiftyEtfIdentity } from '../niftyEtfProductRanking.js';

export const UPSTOX_INSTRUMENT_REGISTRY_REVISION = 'qualified-index-etf-1.1.0';
export const UPSTOX_REGISTRY_EVIDENCE_REVIEWED_AT = '2026-10-13T00:00:00.000Z';
export const UPSTOX_MARKET_QUOTE_DOCUMENTATION_URL = 'https://upstox.com/developer/api-documentation/get-full-market-quote-v3/';
export const MAX_CANONICAL_UPSTOX_QUOTE_IDS = 10;

const registryRows = [
  {
    ...MARKET_BENCHMARKS.NIFTY_50,
    assetClass: 'INDEX',
    exchange: 'NSE',
    isin: null,
    issuer: 'National Stock Exchange of India Limited',
    tradingSymbol: 'Nifty 50',
    listingStatus: 'PUBLISHED_INDEX',
    currency: null,
    unit: 'INDEX_POINTS',
    instrumentType: 'INDEX',
    dataClass: 'LIVE_INDEX_OBSERVATION',
  },
  {
    ...MARKET_BENCHMARKS.INDIA_VIX,
    assetClass: 'VOLATILITY_INDEX',
    exchange: 'NSE',
    isin: null,
    issuer: 'National Stock Exchange of India Limited',
    tradingSymbol: 'India VIX',
    listingStatus: 'PUBLISHED_INDEX',
    currency: null,
    unit: 'INDEX_POINTS',
    instrumentType: 'INDEX',
    dataClass: 'LIVE_INDEX_OBSERVATION',
  },
  ...(isQualifiedNiftyEtfIdentity(QUALIFIED_NIFTY_ETF_IDENTITY) ? [{
    canonicalProductId: QUALIFIED_NIFTY_ETF_IDENTITY.canonicalProductId,
    displayName: 'Nippon India ETF Nifty 50 BeES',
    assetClass: 'ETF', exchange: QUALIFIED_NIFTY_ETF_IDENTITY.exchange,
    upstoxInstrumentKey: `NSE_EQ|${QUALIFIED_NIFTY_ETF_IDENTITY.isin}`,
    isin: QUALIFIED_NIFTY_ETF_IDENTITY.isin,
    issuer: 'Nippon India Mutual Fund',
    tradingSymbol: QUALIFIED_NIFTY_ETF_IDENTITY.ticker,
    listingStatus: 'SOURCE_QUALIFIED_ETF_IDENTITY',
    currency: 'INR', unit: 'PRICE', instrumentType: 'ETF',
    dataClass: 'LIVE_EXCHANGE_QUOTE_OBSERVATION',
    evidenceSource: QUALIFIED_NIFTY_ETF_IDENTITY.identityEvidence.url,
  }] : []),
];

export const UPSTOX_INSTRUMENT_REGISTRY = Object.freeze(
  Object.fromEntries(registryRows.map(row => [row.canonicalProductId, Object.freeze({
    canonicalProductId: row.canonicalProductId,
    displayName: row.displayName,
    assetClass: row.assetClass,
    exchange: row.exchange,
    upstoxInstrumentKey: row.upstoxInstrumentKey,
    isin: row.isin,
    issuer: row.issuer,
    tradingSymbol: row.tradingSymbol,
    listingStatus: row.listingStatus,
    currency: row.currency,
    unit: row.unit,
    instrumentType: row.instrumentType,
    dataClass: row.dataClass,
    registryRevision: UPSTOX_INSTRUMENT_REGISTRY_REVISION,
    evidenceSource: row.evidenceSource || UPSTOX_MARKET_QUOTE_DOCUMENTATION_URL,
    evidenceReviewedAt: UPSTOX_REGISTRY_EVIDENCE_REVIEWED_AT,
    providerAccessStatus: 'NOT_LIVE_VERIFIED',
  })])),
);

export class UnsupportedUpstoxInstrumentError extends Error {
  constructor(canonicalProductId) {
    super('One or more canonical instrument IDs are not in the qualified Upstox registry.');
    this.name = 'UnsupportedUpstoxInstrumentError';
    this.code = 'UNSUPPORTED_MARKET_INSTRUMENT';
    this.canonicalProductId = canonicalProductId;
  }
}

export function resolveUpstoxQuoteIdentities(canonicalProductIds) {
  if (!Array.isArray(canonicalProductIds)) {
    throw new TypeError('canonicalProductIds must be an array.');
  }
  const uniqueIds = [...new Set(canonicalProductIds.map(value => (
    typeof value === 'string' ? value.trim() : ''
  )).filter(Boolean))];
  if (uniqueIds.length < 1 || uniqueIds.length > MAX_CANONICAL_UPSTOX_QUOTE_IDS) {
    throw new RangeError(`canonicalProductIds must contain 1-${MAX_CANONICAL_UPSTOX_QUOTE_IDS} unique values.`);
  }
  const identities = uniqueIds.map(id => {
    const identity = UPSTOX_INSTRUMENT_REGISTRY[id];
    if (!identity) throw new UnsupportedUpstoxInstrumentError(id);
    return identity;
  });
  return identities;
}

/**
 * Product comparison must request an exact listed product identity. Index
 * observations belong to the market-context flow and must never be presented
 * as quotes for every investment category.
 */
export function resolveUpstoxProductQuoteIdentities(canonicalProductIds) {
  const identities = resolveUpstoxQuoteIdentities(canonicalProductIds);
  const unsupported = identities.find(identity => (
    identity.instrumentType !== 'ETF'
    || identity.dataClass !== 'LIVE_EXCHANGE_QUOTE_OBSERVATION'
  ));
  if (unsupported) throw new UnsupportedUpstoxInstrumentError(unsupported.canonicalProductId);
  return identities;
}
