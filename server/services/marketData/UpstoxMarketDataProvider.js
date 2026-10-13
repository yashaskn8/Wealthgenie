import crypto from 'node:crypto';
import MarketDataProvider from './MarketDataProvider.js';
import {
  AVAILABILITY,
  FACT_KINDS,
  MARKET_DATA_SCHEMA_VERSION,
  PROVIDERS,
  createMarketFact,
  normalizeTimestamp,
} from './contracts.js';
import { buildUpstoxInstrumentIdentity } from './productIdentity.js';
import { readThroughMarketCache } from './requestCache.js';
import { isoDateInIndia } from './indiaMarketTime.js';
import { classifyUpstoxError, safeUpstoxError } from './upstoxErrors.js';

export const UPSTOX_QUOTE_URL = 'https://api.upstox.com/v3/market-quote/quotes';
export const UPSTOX_QUOTE_CACHE_TTL_SECONDS = 60;
export const UPSTOX_QUOTE_FRESHNESS_SECONDS = 15 * 60;
// The provider documents up to 500 keys per request. WealthGenie intentionally
// keeps a much smaller 50-key internal ceiling until a measured refresh budget
// justifies widening it.
export const MAX_UPSTOX_INSTRUMENTS_PER_REQUEST = 50;
export const DEFAULT_BENCHMARK_INSTRUMENT_KEYS = Object.freeze([
  'NSE_INDEX|Nifty 50',
  'NSE_INDEX|India VIX',
]);

function normalizeInstrumentKeys(instrumentKeys) {
  if (!Array.isArray(instrumentKeys)) throw new TypeError('instrumentKeys must be an array.');
  const unique = [...new Set(instrumentKeys.map(value => String(value || '').trim()).filter(Boolean))];
  if (unique.length === 0 || unique.length > MAX_UPSTOX_INSTRUMENTS_PER_REQUEST) {
    throw new RangeError(`instrumentKeys must contain 1-${MAX_UPSTOX_INSTRUMENTS_PER_REQUEST} unique values.`);
  }
  unique.forEach(buildUpstoxInstrumentIdentity);
  return unique;
}

function cacheKeyFor(instrumentKeys) {
  const digest = crypto.createHash('sha256').update([...instrumentKeys].sort().join('\n')).digest('hex');
  return `market:upstox:quotes:${MARKET_DATA_SCHEMA_VERSION}:${digest}`;
}

function findQuote(data, instrumentKey) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { quote: null, reasonCode: 'INVALID_PROVIDER_RESPONSE' };
  }
  const exchangeSymbolKey = instrumentKey.replace('|', ':');
  const candidates = new Set(
    Object.entries(data)
      .filter(([key, value]) => key === exchangeSymbolKey || value?.instrument_token === instrumentKey)
      .map(([, value]) => value),
  );
  if (candidates.size > 1) return { quote: null, reasonCode: 'DUPLICATE_PROVIDER_OBSERVATION' };
  if (candidates.size === 0) return { quote: null, reasonCode: 'MISSING_PROVIDER_OBSERVATION' };
  const [quote] = candidates;
  if (quote?.instrument_token !== instrumentKey) {
    return { quote: null, reasonCode: 'INSTRUMENT_IDENTITY_MISMATCH' };
  }
  return { quote, reasonCode: null };
}

function quoteObservedAt(quote) {
  // Upstox `timestamp` is when its quote response was generated. Only
  // `last_trade_time` describes when the observation traded at the exchange.
  return normalizeTimestamp(quote?.last_trade_time ?? quote?.lastTradeTime);
}

function invalidOhlc(quote) {
  const ohlc = quote?.ohlc;
  if (!ohlc || typeof ohlc !== 'object') return false;
  const values = ['open', 'high', 'low', 'close'].map(key => nullableMarketValue(ohlc[key]));
  if (values.every(value => value === null)) return false;
  if (values.some(value => value === null)) return true;
  const [open, high, low, close] = values;
  return high < low || high < open || high < close || low > open || low > close;
}

function nullableMarketValue(value) {
  const parsed = Number(value);
  return value === null || value === undefined || value === '' || !Number.isFinite(parsed)
    || parsed <= 0 || parsed > Number.MAX_SAFE_INTEGER
    ? null
    : parsed;
}

function quoteIssue(quoteResult, quote, now) {
  if (quoteResult.reasonCode) return quoteResult.reasonCode;
  if (!quote) return 'MISSING_PROVIDER_OBSERVATION';
  if (nullableMarketValue(quote.last_price) === null) return 'INVALID_MARKET_VALUE';
  if (invalidOhlc(quote)) return 'INVALID_OHLC';
  const observedAt = quoteObservedAt(quote);
  if (!observedAt) return 'OBSERVATION_TIMESTAMP_UNAVAILABLE';
  if (Date.parse(observedAt) > now.getTime()) return 'FUTURE_OBSERVATION_TIMESTAMP';
  return null;
}

export default class UpstoxMarketDataProvider extends MarketDataProvider {
  constructor({
    accessToken = process.env.UPSTOX_ANALYTICS_TOKEN || process.env.UPSTOX_ACCESS_TOKEN || '',
    ...options
  } = {}) {
    super({ providerName: PROVIDERS.UPSTOX, ...options });
    this.accessToken = String(accessToken || '').trim();
  }

  isConfigured() {
    return this.accessToken.length > 0;
  }

  async getQuotes(instrumentKeys, { forceRefresh = false } = {}) {
    const normalizedKeys = normalizeInstrumentKeys(instrumentKeys);
    const fetchedAt = this.nowIso();
    if (!this.isConfigured()) {
      return {
        schemaVersion: MARKET_DATA_SCHEMA_VERSION,
        provider: PROVIDERS.UPSTOX,
        status: AVAILABILITY.PROVIDER_NOT_CONFIGURED,
        fetchedAt,
        requestedInstrumentCount: normalizedKeys.length,
        availableFactCount: 0,
        facts: [],
        error: {
          code: 'PROVIDER_NOT_CONFIGURED',
          message: 'Set UPSTOX_ANALYTICS_TOKEN or UPSTOX_ACCESS_TOKEN on the server to enable Upstox data.',
        },
        cache: { hit: false, backend: 'NONE' },
      };
    }

    return readThroughMarketCache({
      cacheKey: cacheKeyFor(normalizedKeys),
      ttlSeconds: UPSTOX_QUOTE_CACHE_TTL_SECONDS,
      forceRefresh,
      loader: async () => {
        const requestFetchedAt = this.nowIso();
        try {
          const response = await this.httpClient.get(UPSTOX_QUOTE_URL, {
            timeout: 10_000,
            params: { instrument_key: normalizedKeys.join(',') },
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${this.accessToken}`,
            },
          });
          if (!response?.data || typeof response.data !== 'object' || Array.isArray(response.data)
              || (response.data.status !== undefined && response.data.status !== 'success')
              || !response.data.data || typeof response.data.data !== 'object' || Array.isArray(response.data.data)) {
            throw Object.assign(new Error('UPSTOX_RESPONSE_SCHEMA_INVALID'), { code: 'UPSTOX_RESPONSE_SCHEMA_INVALID' });
          }
          const responseData = response.data.data;
          const now = this.clock();
          const facts = normalizedKeys.map(instrumentKey => {
            const quoteResult = findQuote(responseData, instrumentKey);
            const quote = quoteResult.quote;
            const identity = buildUpstoxInstrumentIdentity(instrumentKey);
            const observedAt = quoteObservedAt(quote);
            const reasonCode = quoteIssue(quoteResult, quote, now);
            return createMarketFact({
              kind: FACT_KINDS.MARKET_QUOTE,
              canonicalProductId: identity.canonicalProductId,
              sourceProvider: PROVIDERS.UPSTOX,
              sourceInstrumentId: instrumentKey,
              sourceUrl: UPSTOX_QUOTE_URL,
              value: reasonCode ? null : quote?.last_price,
              currency: /^(?:NSE|BSE|MCX)_INDEX\|/.test(instrumentKey) ? null : 'INR',
              unit: /^(?:NSE|BSE|MCX)_INDEX\|/.test(instrumentKey) ? 'INDEX_POINTS' : 'PRICE',
              observedAt,
              providerTimestamp: observedAt,
              effectiveTradingDate: isoDateInIndia(observedAt),
              fetchedAt: requestFetchedAt,
              dataClass: 'LIVE',
              maxAgeSeconds: UPSTOX_QUOTE_FRESHNESS_SECONDS,
              metrics: reasonCode ? {} : {
                open: quote?.ohlc?.open,
                high: quote?.ohlc?.high,
                low: quote?.ohlc?.low,
                close: quote?.ohlc?.close,
                previousClose: quote?.prev_close_price,
                volume: quote?.volume,
                openInterest: quote?.oi,
              },
              now,
            });
          }).map((fact, index) => {
            const quoteResult = findQuote(responseData, normalizedKeys[index]);
            const reasonCode = quoteIssue(quoteResult, quoteResult.quote, now);
            return reasonCode ? { ...fact, reasonCode } : fact;
          });
          const availableFactCount = facts.filter(
            fact => fact.availabilityStatus === AVAILABILITY.AVAILABLE,
          ).length;
          return {
            schemaVersion: MARKET_DATA_SCHEMA_VERSION,
            provider: PROVIDERS.UPSTOX,
            status: availableFactCount === facts.length
              ? AVAILABILITY.AVAILABLE
              : availableFactCount > 0 ? AVAILABILITY.PARTIAL : AVAILABILITY.UNAVAILABLE,
            fetchedAt: requestFetchedAt,
            requestedInstrumentCount: normalizedKeys.length,
            availableFactCount,
            facts,
          };
        } catch (error) {
          return {
            schemaVersion: MARKET_DATA_SCHEMA_VERSION,
            provider: PROVIDERS.UPSTOX,
            status: AVAILABILITY.SOURCE_ERROR,
            fetchedAt: requestFetchedAt,
            requestedInstrumentCount: normalizedKeys.length,
            availableFactCount: 0,
            facts: [],
            error: safeUpstoxError(classifyUpstoxError(error)),
          };
        }
      },
    });
  }
}
