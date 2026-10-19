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
import { resolveUpstoxAccessToken, upstoxCredentialCacheFingerprint } from './upstoxCredentials.js';
import { getUpstoxWithRetry } from './upstoxRequestPolicy.js';
import {
  evaluateMarketDataProductionRights,
  isMarketDataPrivateDemoUseAllowed,
  isMarketDataProductionUseAllowed,
} from './marketDataRights.js';
import {
  buildUpstoxQuoteRequestUrl,
  UPSTOX_QUOTE_RIGHTS_URL,
  UPSTOX_QUOTE_URL,
} from './marketDataSourceUrls.js';

export { UPSTOX_QUOTE_URL, UPSTOX_QUOTE_RIGHTS_URL };
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

function cacheKeyFor(instrumentKeys, credentialFingerprint) {
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify([credentialFingerprint, [...instrumentKeys].sort()]))
    .digest('hex');
  return `market:upstox:quotes:${MARKET_DATA_SCHEMA_VERSION}:${digest}`;
}

function findQuote(data, instrumentKey) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { quote: null, reasonCode: 'INVALID_PROVIDER_RESPONSE' };
  }
  const exchangeSymbolKey = instrumentKey.replace('|', ':');
  const candidates = Object.entries(data)
    .filter(([key, value]) => key === exchangeSymbolKey || value?.instrument_token === instrumentKey);
  if (candidates.length > 1) return { quote: null, reasonCode: 'DUPLICATE_PROVIDER_OBSERVATION' };
  if (candidates.length === 0) return { quote: null, reasonCode: 'MISSING_PROVIDER_OBSERVATION' };
  const [[, quote]] = candidates;
  if (quote?.instrument_token !== instrumentKey) {
    return { quote: null, reasonCode: 'INSTRUMENT_IDENTITY_MISMATCH' };
  }
  return { quote, reasonCode: null };
}

function quoteObservedAt(quote) {
  // Upstox `timestamp` is when its quote response was generated. Only
  // `last_trade_time` describes when the observation traded at the exchange.
  const raw = quote?.last_trade_time;
  return /^(?:\d{13})$/.test(String(raw ?? '')) ? normalizeTimestamp(raw) : null;
}

function quoteResponseGeneratedAt(quote) {
  const raw = quote?.timestamp;
  return typeof raw === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(raw)
    ? normalizeTimestamp(raw) : null;
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
  if (quote?.timestamp !== undefined && !quoteResponseGeneratedAt(quote)) {
    return 'INVALID_PROVIDER_RESPONSE_TIMESTAMP';
  }
  const responseGeneratedAt = quoteResponseGeneratedAt(quote);
  if (responseGeneratedAt && (Date.parse(responseGeneratedAt) > now.getTime()
    || Date.parse(responseGeneratedAt) < Date.parse(observedAt))) {
    return 'CONFLICTING_PROVIDER_TIMESTAMPS';
  }
  return null;
}

export default class UpstoxMarketDataProvider extends MarketDataProvider {
  constructor({
    accessToken = resolveUpstoxAccessToken(),
    env = process.env,
    requestCache = readThroughMarketCache,
    ...options
  } = {}) {
    super({ providerName: PROVIDERS.UPSTOX, env, ...options });
    this.accessToken = String(accessToken || '').trim();
    this.env = env;
    this.requestCache = requestCache;
  }

  isConfigured() {
    return this.accessToken.length > 0;
  }

  async getQuotes(instrumentKeys, { forceRefresh = false, privateDemoCapability = null } = {}) {
    const normalizedKeys = normalizeInstrumentKeys(instrumentKeys);
    const requestUrl = buildUpstoxQuoteRequestUrl(normalizedKeys);
    const fetchedAt = this.nowIso();
    const productionAllowed = isMarketDataProductionUseAllowed(
      PROVIDERS.UPSTOX, requestUrl, this.env, this.marketDataTestFixtureRightsCapability,
    );
    const privateDemoAllowed = isMarketDataPrivateDemoUseAllowed(
      PROVIDERS.UPSTOX, requestUrl, this.env, privateDemoCapability,
    );
    if (!productionAllowed && !privateDemoAllowed) {
      const rights = evaluateMarketDataProductionRights(PROVIDERS.UPSTOX, requestUrl);
      return {
        schemaVersion: MARKET_DATA_SCHEMA_VERSION,
        provider: PROVIDERS.UPSTOX,
        status: AVAILABILITY.UNAVAILABLE,
        fetchedAt,
        requestedInstrumentCount: normalizedKeys.length,
        availableFactCount: null,
        facts: [],
        error: { code: 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED' },
        reasonCodes: ['MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED'],
        sourceRights: { status: rights.status, sourceId: rights.sourceId, productionUseAllowed: false },
        cache: { hit: false, backend: 'NONE', status: 'NOT_READ_SOURCE_RIGHTS_BLOCKED' },
      };
    }
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

    const accessToken = this.accessToken;
    const requestOptions = {
      cacheKey: cacheKeyFor(normalizedKeys, upstoxCredentialCacheFingerprint(accessToken)),
      ttlSeconds: UPSTOX_QUOTE_CACHE_TTL_SECONDS,
      forceRefresh: forceRefresh || privateDemoAllowed,
      loader: async () => {
        try {
          const response = await getUpstoxWithRetry(this.httpClient, requestUrl, {
            timeout: 10_000,
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${accessToken}`,
            },
          });
          const requestFetchedAt = this.nowIso();
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
            const responseGeneratedAt = quoteResponseGeneratedAt(quote);
            const reasonCode = quoteIssue(quoteResult, quote, now);
            return {
              ...createMarketFact({
                kind: FACT_KINDS.MARKET_QUOTE,
                canonicalProductId: identity.canonicalProductId,
                sourceProvider: PROVIDERS.UPSTOX,
                sourceInstrumentId: instrumentKey,
                sourceUrl: requestUrl,
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
                  previousClose: nullableMarketValue(quote?.prev_close_price),
                  volume: quote?.volume,
                  openInterest: quote?.oi,
                },
                now,
              }),
              quoteLastTradeAt: observedAt,
              quoteResponseGeneratedAt: responseGeneratedAt,
              providerResponseReceivedAt: requestFetchedAt,
            };
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
            fetchedAt: this.nowIso(),
            requestedInstrumentCount: normalizedKeys.length,
            availableFactCount: 0,
            facts: [],
            error: safeUpstoxError(classifyUpstoxError(error)),
          };
        }
      },
    };
    return privateDemoAllowed
      ? requestOptions.loader()
      : this.requestCache(requestOptions);
  }
}
