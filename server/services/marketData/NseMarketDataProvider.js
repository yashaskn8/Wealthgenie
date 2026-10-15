import crypto from 'node:crypto';
import MarketDataProvider from './MarketDataProvider.js';
import {
  AVAILABILITY,
  FACT_KINDS,
  MARKET_DATA_SCHEMA_VERSION,
  PROVIDERS,
  createMarketFact,
  nullableFiniteNumber,
  normalizeTimestamp,
} from './contracts.js';
import {
  DEFAULT_BENCHMARK_IDS,
  benchmarkByCanonicalId,
} from './marketBenchmarks.js';
import { buildNseIndexIdentity } from './productIdentity.js';
import { isoDateInIndia } from './indiaMarketTime.js';
import { getNseJson, safeNseHttpError } from './nseHttp.js';
import {
  isUsableNseTradingCalendar,
  evaluateNseQuoteFreshness,
  fetchNseTradingHolidays,
  NSE_MARKET_SESSION,
  NSE_TRADING_HOLIDAY_URL,
  parseNseMarketTimestamp,
} from './nseTradingCalendar.js';
import { readThroughMarketCache } from './requestCache.js';
import { buildMarketDataRightsUnavailableSnapshot, isMarketDataProductionUseAllowed } from './marketDataRights.js';

export const NSE_ALL_INDICES_URL = 'https://www.nseindia.com/api/allIndices';
export const NSE_QUOTE_CACHE_TTL_SECONDS = 60;
export const NSE_QUOTE_DATA_CLASS = 'LIVE';
export const NSE_ENDPOINT_QUALIFICATION = 'OFFICIAL_NSE_WEBSITE_ENDPOINT_UNDOCUMENTED_SCHEMA_VALIDATED';

function normalizeBenchmarkIds(benchmarkIds) {
  if (!Array.isArray(benchmarkIds)) throw new TypeError('benchmarkIds must be an array.');
  const unique = [...new Set(benchmarkIds.map(value => String(value || '').trim()).filter(Boolean))];
  if (unique.length === 0 || unique.length > DEFAULT_BENCHMARK_IDS.length) {
    throw new RangeError(`benchmarkIds must contain 1-${DEFAULT_BENCHMARK_IDS.length} unique values.`);
  }
  unique.forEach(id => {
    if (!benchmarkByCanonicalId(id)) throw new TypeError(`Unsupported benchmark identity: ${id}`);
  });
  return unique;
}

function positiveNumber(value) {
  const number = nullableFiniteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function cacheKeyFor(benchmarkIds) {
  const digest = crypto.createHash('sha256').update([...benchmarkIds].sort().join('\n')).digest('hex');
  return `market:nse:quotes:${MARKET_DATA_SCHEMA_VERSION}:${digest}`;
}

function validateQuoteMetrics(row) {
  const open = positiveNumber(row?.open);
  const high = positiveNumber(row?.high);
  const low = positiveNumber(row?.low);
  if ([open, high, low].some(value => value === null)) return;
  if (high < low || high < open || low > open) {
    throw new Error(`NSE_QUOTE_SCHEMA_MISMATCH:${row?.index || 'unknown'}:OHLC`);
  }
}

export function parseNseIndexQuotes(payload, {
  benchmarkIds = DEFAULT_BENCHMARK_IDS,
  fetchedAt,
  now = new Date(),
  holidayDates = [],
  sourceUrl = NSE_ALL_INDICES_URL,
} = {}) {
  const normalizedIds = normalizeBenchmarkIds(benchmarkIds);
  if (!payload || !Array.isArray(payload.data)) throw new Error('NSE_QUOTE_SCHEMA_MISMATCH:data');
  const providerTimestamp = parseNseMarketTimestamp(payload.timestamp);
  if (!providerTimestamp) throw new Error('NSE_QUOTE_SCHEMA_MISMATCH:timestamp');
  const requestedNames = new Set(normalizedIds.map(id => benchmarkByCanonicalId(id).nseIndexName));
  const rowsByName = new Map();
  for (const row of payload.data) {
    if (typeof row?.index !== 'string' || !requestedNames.has(row.index)) continue;
    if (rowsByName.has(row.index)) throw new Error(`NSE_QUOTE_SCHEMA_MISMATCH:duplicate:${row.index}`);
    rowsByName.set(row.index, row);
  }

  const facts = normalizedIds.map(canonicalProductId => {
    const benchmark = benchmarkByCanonicalId(canonicalProductId);
    const row = rowsByName.get(benchmark.nseIndexName);
    if (row) validateQuoteMetrics(row);
    const identity = buildNseIndexIdentity(benchmark.nseIndexName);
    const previousClose = positiveNumber(row?.previousClose);
    const fact = createMarketFact({
      kind: FACT_KINDS.MARKET_QUOTE,
      canonicalProductId: identity.canonicalProductId,
      sourceProvider: PROVIDERS.NSE,
      sourceInstrumentId: benchmark.nseIndexName,
      sourceUrl,
      value: positiveNumber(row?.last),
      currency: 'INR',
      unit: 'INDEX_POINTS',
      observedAt: providerTimestamp,
      providerTimestamp,
      effectiveTradingDate: isoDateInIndia(providerTimestamp),
      fetchedAt,
      dataClass: NSE_QUOTE_DATA_CLASS,
      maxAgeSeconds: 0,
      metrics: {
        open: positiveNumber(row?.open),
        high: positiveNumber(row?.high),
        low: positiveNumber(row?.low),
        close: positiveNumber(row?.last),
        previousClose,
        volume: null,
        openInterest: null,
      },
      now,
    });
    fact.freshness = evaluateNseQuoteFreshness({
      observedAt: providerTimestamp,
      fetchedAt,
      now,
      holidayDates,
    });
    if (benchmark.canonicalProductId === DEFAULT_BENCHMARK_IDS[0] && previousClose === null) {
      fact.availabilityStatus = AVAILABILITY.UNAVAILABLE;
    }
    return fact;
  });
  const availableFactCount = facts.filter(
    fact => fact.availabilityStatus === AVAILABILITY.AVAILABLE,
  ).length;
  const sessionStatuses = [...new Set(facts.map(fact => fact.freshness?.marketSession).filter(Boolean))];
  const marketSession = sessionStatuses.length === 1
    ? sessionStatuses[0]
    : NSE_MARKET_SESSION.UNKNOWN;
  return {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    provider: PROVIDERS.NSE,
    status: availableFactCount === facts.length
      ? AVAILABILITY.AVAILABLE
      : availableFactCount > 0 ? AVAILABILITY.PARTIAL : AVAILABILITY.UNAVAILABLE,
    qualification: NSE_ENDPOINT_QUALIFICATION,
    dataClass: NSE_QUOTE_DATA_CLASS,
    providerTimestamp,
    effectiveTradingDate: isoDateInIndia(providerTimestamp),
    fetchedAt,
    marketSession: {
      status: marketSession,
      tradingDate: facts[0]?.freshness?.tradingDate ?? null,
      checkedAt: normalizeTimestamp(now),
    },
    requestedInstrumentCount: normalizedIds.length,
    availableFactCount,
    facts,
  };
}

export default class NseMarketDataProvider extends MarketDataProvider {
  constructor({
    holidayLoader,
    ...options
  } = {}) {
    super({ providerName: PROVIDERS.NSE, ...options });
    this.holidayLoader = holidayLoader || ((loaderOptions = {}) => fetchNseTradingHolidays({
      httpClient: this.httpClient,
      clock: this.clock,
      env: this.env,
      fixtureCapability: this.marketDataTestFixtureRightsCapability,
      ...loaderOptions,
    }));
  }

  async getQuotes(benchmarkIds = DEFAULT_BENCHMARK_IDS, { forceRefresh = false } = {}) {
    const normalizedIds = normalizeBenchmarkIds(benchmarkIds);
    const deniedUrl = [NSE_ALL_INDICES_URL, NSE_TRADING_HOLIDAY_URL]
      .find(url => !isMarketDataProductionUseAllowed(
        PROVIDERS.NSE,
        url,
        this.env,
        this.marketDataTestFixtureRightsCapability,
      ));
    if (deniedUrl) {
      return {
        ...buildMarketDataRightsUnavailableSnapshot(PROVIDERS.NSE, deniedUrl, { now: this.clock() }),
        qualification: NSE_ENDPOINT_QUALIFICATION,
        requestedInstrumentCount: normalizedIds.length,
        availableFactCount: null,
      };
    }
    const snapshot = await readThroughMarketCache({
      cacheKey: cacheKeyFor(normalizedIds),
      ttlSeconds: NSE_QUOTE_CACHE_TTL_SECONDS,
      forceRefresh,
      loader: async () => {
        const fetchedAt = this.nowIso();
        try {
          const [responseResult, calendarResult] = await Promise.allSettled([
            getNseJson(this.httpClient, NSE_ALL_INDICES_URL, {
              referer: 'https://www.nseindia.com/market-data/live-equity-market-indices',
            }),
            this.holidayLoader({ forceRefresh: false }),
          ]);
          if (responseResult.status !== 'fulfilled') throw responseResult.reason;
          const holidaySnapshot = calendarResult.status === 'fulfilled' ? calendarResult.value : null;
          const calendarAvailable = isUsableNseTradingCalendar(holidaySnapshot, this.clock());
          if (!calendarAvailable) {
            const snapshot = parseNseIndexQuotes(responseResult.value.data, {
              benchmarkIds: normalizedIds,
              fetchedAt,
              now: this.clock(),
              holidayDates: [],
            });
            snapshot.marketSession = {
              status: NSE_MARKET_SESSION.UNKNOWN,
              tradingDate: null,
              checkedAt: normalizeTimestamp(this.clock()),
            };
            snapshot.facts = snapshot.facts.map(fact => ({
              ...fact,
              freshness: {
                status: 'UNKNOWN',
                ageSeconds: null,
                maxAgeSeconds: fact.freshness?.maxAgeSeconds ?? 900,
                marketSession: NSE_MARKET_SESSION.UNKNOWN,
                tradingDate: null,
              },
            }));
            return {
              ...snapshot,
              calendar: {
                status: 'UNAVAILABLE',
                source: holidaySnapshot?.source ?? null,
                fetchedAt: holidaySnapshot?.fetchedAt ?? null,
                error: calendarResult.status === 'rejected'
                  ? { code: 'NSE_HOLIDAY_FETCH_FAILED', message: 'NSE trading calendar request failed.' }
                  : holidaySnapshot?.status === AVAILABILITY.AVAILABLE
                    ? { code: 'NSE_HOLIDAY_CALENDAR_UNQUALIFIED', message: 'NSE trading calendar provenance, freshness, or current-year coverage is not verified.' }
                    : holidaySnapshot?.error ?? { code: 'NSE_HOLIDAY_FETCH_FAILED', message: 'NSE trading calendar was unavailable.' },
              },
              reasonCodes: ['NSE_TRADING_CALENDAR_UNAVAILABLE'],
            };
          }
          const snapshot = parseNseIndexQuotes(responseResult.value.data, {
            benchmarkIds: normalizedIds,
            fetchedAt,
            now: this.clock(),
            holidayDates: holidaySnapshot.dates,
          });
          return {
            ...snapshot,
            calendar: {
              schemaVersion: MARKET_DATA_SCHEMA_VERSION,
              provider: PROVIDERS.NSE,
              status: 'AVAILABLE',
              dates: holidaySnapshot.dates,
              source: holidaySnapshot.source,
              fetchedAt: holidaySnapshot.fetchedAt,
            },
          };
        } catch (error) {
          return {
            schemaVersion: MARKET_DATA_SCHEMA_VERSION,
            provider: PROVIDERS.NSE,
            status: AVAILABILITY.SOURCE_ERROR,
            qualification: NSE_ENDPOINT_QUALIFICATION,
            dataClass: NSE_QUOTE_DATA_CLASS,
            providerTimestamp: null,
            effectiveTradingDate: null,
            fetchedAt,
            requestedInstrumentCount: normalizedIds.length,
            availableFactCount: 0,
            facts: [],
            error: {
              code: 'NSE_QUOTE_FETCH_FAILED',
              message: safeNseHttpError(error, 'NSE index quote request failed'),
            },
          };
        }
      },
    });
    if (snapshot?.status !== AVAILABILITY.AVAILABLE
        || isUsableNseTradingCalendar(snapshot.calendar, this.clock())) return snapshot;
    return {
      ...snapshot,
      marketSession: {
        status: NSE_MARKET_SESSION.UNKNOWN,
        tradingDate: null,
        checkedAt: normalizeTimestamp(this.clock()),
      },
      facts: (snapshot.facts || []).map(fact => ({
        ...fact,
        freshness: {
          status: 'UNKNOWN',
          ageSeconds: null,
          maxAgeSeconds: fact.freshness?.maxAgeSeconds ?? 900,
          marketSession: NSE_MARKET_SESSION.UNKNOWN,
          tradingDate: null,
        },
      })),
      calendar: {
        status: 'UNAVAILABLE',
        source: snapshot.calendar?.source ?? null,
        fetchedAt: snapshot.calendar?.fetchedAt ?? null,
        error: snapshot.calendar?.error
          ?? { code: 'NSE_HOLIDAY_CALENDAR_EXPIRED', message: 'NSE trading calendar qualification expired.' },
      },
      reasonCodes: [...new Set([...(snapshot.reasonCodes || []), 'NSE_TRADING_CALENDAR_UNAVAILABLE'])],
    };
  }
}
