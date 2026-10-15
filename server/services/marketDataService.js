/**
 * Provider-neutral market-data facade.
 *
 * Phase 1 deliberately separates verified observations from simulation/model
 * assumptions. A failed or unconfigured provider never receives a numeric
 * fallback and is never reported as successful live data.
 */

import {
  INSTRUMENT_PARAMS,
  PROJECTION_ASSUMPTION_DATA_CLASS,
  PROJECTION_ASSUMPTION_SOURCE,
  PROJECTION_ASSUMPTION_VERSION,
} from './instrumentConstants.js';
import AmfiNavProvider, { AMFI_NAV_URL } from './marketData/AmfiNavProvider.js';
import AmfiNavHistoryProvider, {
  AMFI_NAV_HISTORY_URL,
  buildAmfiHistoryWindow,
} from './marketData/AmfiNavHistoryProvider.js';
import UpstoxMarketDataProvider, {
  DEFAULT_BENCHMARK_INSTRUMENT_KEYS,
  UPSTOX_QUOTE_FRESHNESS_SECONDS,
  UPSTOX_QUOTE_RIGHTS_URL,
  UPSTOX_QUOTE_URL,
} from './marketData/UpstoxMarketDataProvider.js';
import { buildUpstoxQuoteRequestUrl } from './marketData/marketDataSourceUrls.js';
import UpstoxHistoricalCandleProvider, {
  NIFTY_50_INSTRUMENT_KEY,
  UPSTOX_HISTORICAL_CANDLE_V3_RIGHTS_URL,
} from './marketData/UpstoxHistoricalCandleProvider.js';
import NseMarketDataProvider, { NSE_ALL_INDICES_URL } from './marketData/NseMarketDataProvider.js';
import NseHistoricalDataProvider, {
  NSE_HISTORICAL_INDEX_RIGHTS_URL,
  NSE_HISTORICAL_INDEX_URL,
} from './marketData/NseHistoricalDataProvider.js';
import TejHqHistoricalDataProvider, {
  normalizeTejHqIdentity,
  TEJHQ_API_BASE_URL,
} from './marketData/TejHqHistoricalDataProvider.js';
import GovernmentSmallSavingsProvider, {
  INDIA_POST_SAVINGS_URL,
  INDIA_POST_SCRIPT_CHUNK_RIGHTS_URL,
} from './marketData/GovernmentSmallSavingsProvider.js';
import SbiTermDepositProvider, { SBI_TERM_DEPOSIT_URL } from './marketData/SbiTermDepositProvider.js';
import RbiFloatingRateSavingsBondProvider, { RBI_FRSB_NOTIFICATION_URL } from './marketData/RbiFloatingRateSavingsBondProvider.js';
import { fetchQualifiedMarketPair } from './qualifiedMarketFailover.js';
import {
  DEFAULT_BENCHMARK_IDS,
  MARKET_BENCHMARKS,
} from './marketData/marketBenchmarks.js';
import {
  UPSTOX_INSTRUMENT_REGISTRY_REVISION,
  resolveUpstoxQuoteIdentities,
} from './marketData/upstoxInstrumentRegistry.js';
import {
  AVAILABILITY,
  MARKET_DATA_SCHEMA_VERSION,
  PROVIDERS,
} from './marketData/contracts.js';
import { isoDateInIndia } from './marketData/indiaMarketTime.js';
import { isUsableNseTradingCalendar, NSE_TRADING_HOLIDAY_URL } from './marketData/nseTradingCalendar.js';
import { persistVerifiedMarketSnapshot } from './marketData/MarketDataRepository.js';
import { isUpstoxPublicDistributionAllowed } from './marketData/upstoxDistributionPolicy.js';
import {
  buildMarketDataRightsUnavailableSnapshot,
  isMarketDataProductionUseAllowed,
} from './marketData/marketDataRights.js';

const amfiProvider = new AmfiNavProvider();
const amfiHistoryProvider = new AmfiNavHistoryProvider();
const upstoxProvider = new UpstoxMarketDataProvider();
const upstoxHistoryProvider = new UpstoxHistoricalCandleProvider();
const nseProvider = new NseMarketDataProvider();
const nseHistoryProvider = new NseHistoricalDataProvider();
const tejHqProvider = new TejHqHistoricalDataProvider();
const governmentSavingsProvider = new GovernmentSmallSavingsProvider();
const sbiTermDepositProvider = new SbiTermDepositProvider();
const rbiProvider = new RbiFloatingRateSavingsBondProvider({
  getGovernmentSnapshot: (opts) => governmentSavingsProvider.getSnapshot(opts),
});

export const SUPPORTED_PRIMARY_MARKET_PROVIDERS = Object.freeze(['NSE', 'UPSTOX']);

export function resolvePrimaryMarketProvider(env = process.env) {
  const configured = String(env.MARKET_DATA_PRIMARY_PROVIDER || 'NSE').trim().toUpperCase();
  if (!SUPPORTED_PRIMARY_MARKET_PROVIDERS.includes(configured)) {
    throw new Error(`MARKET_DATA_PRIMARY_PROVIDER must be one of: ${SUPPORTED_PRIMARY_MARKET_PROVIDERS.join(', ')}.`);
  }
  return configured;
}

export const PRIMARY_MARKET_PROVIDER = resolvePrimaryMarketProvider();

function productionRightsAllow(provider, urls, env = process.env) {
  return urls.every(url => isMarketDataProductionUseAllowed(provider, url, env));
}

function firstUnqualifiedRightsEndpoint(provider, urls, env = process.env) {
  return urls.find(url => !isMarketDataProductionUseAllowed(provider, url, env)) || null;
}

function unavailableMarketSnapshot(provider, url, { now = new Date(), includeCandles = false, includeProducts = false } = {}) {
  return buildMarketDataRightsUnavailableSnapshot(provider, url, { now, includeCandles, includeProducts });
}

function unavailableDistributionSnapshot(provider, code, now = new Date(), { includeCandles = false } = {}) {
  return {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    provider,
    status: AVAILABILITY.UNAVAILABLE,
    facts: [],
    ...(includeCandles ? { candles: [] } : {}),
    fetchedAt: now.toISOString(),
    cache: { hit: false, status: 'NOT_READ_DISTRIBUTION_BLOCKED' },
    error: { code },
    reasonCodes: [code],
  };
}

function upstoxMarketContextRightsAllowed(env = process.env) {
  return isUpstoxPublicDistributionAllowed(env)
    && productionRightsAllow(PROVIDERS.UPSTOX, [UPSTOX_QUOTE_RIGHTS_URL, UPSTOX_HISTORICAL_CANDLE_V3_RIGHTS_URL], env);
}

function tejHqSourceUrl(path, parameters = {}) {
  const url = new URL(path, TEJHQ_API_BASE_URL);
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

const MAX_TEJHQ_FALLBACK_SEGMENTS = 5;

function requireHistoryDate(value, field) {
  const text = String(value || '').trim();
  const date = new Date(`${text}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new TypeError(`${field} must use YYYY-MM-DD format.`);
  }
  return text;
}

function expectedNseSessions(fromDate, toDate, holidayDates) {
  const holidaySet = new Set(holidayDates);
  const dates = [];
  const current = new Date(`${fromDate}T00:00:00.000Z`);
  const endMs = Date.parse(`${toDate}T00:00:00.000Z`);
  while (current.getTime() <= endMs) {
    const day = current.getUTCDay();
    const date = current.toISOString().slice(0, 10);
    if (day !== 0 && day !== 6 && !holidaySet.has(date)) dates.push(date);
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function buildTejHqSymbolSegments(symbolSnapshot, expectedDates, { exchange, isin } = {}) {
  const segments = [];
  let active = null;
  for (const date of expectedDates) {
    const matches = (symbolSnapshot?.intervals || []).filter(interval => interval.exchange === exchange
      && interval.isin === isin && interval.validFrom <= date && interval.validTo >= date);
    if (matches.length !== 1) {
      return { segments: [], errorCode: matches.length > 1 ? 'TEJHQ_SYMBOL_INTERVAL_AMBIGUOUS' : 'TEJHQ_SYMBOL_HISTORY_GAP' };
    }
    const interval = matches[0];
    if (active && active.symbol === interval.symbol && active.isin === interval.isin) {
      active.dates.push(date);
    } else {
      active = { symbol: interval.symbol, isin: interval.isin, dates: [date] };
      segments.push(active);
      if (segments.length > MAX_TEJHQ_FALLBACK_SEGMENTS) {
        return { segments: [], errorCode: 'TEJHQ_SYMBOL_SEGMENT_LIMIT_EXCEEDED' };
      }
    }
  }
  return { segments, errorCode: null };
}

function providerFailureCode(snapshot, fallback = 'UPSTOX_HISTORY_UNAVAILABLE') {
  return safeTimingCode({ code: snapshot?.error?.code || snapshot?.reasonCodes?.[0] }) || fallback;
}

function isQualifiedUpstoxDailyHistory(snapshot, { instrumentKey, fromDate, toDate } = {}) {
  if (snapshot?.status !== AVAILABILITY.AVAILABLE
      || snapshot.provider !== PROVIDERS.UPSTOX
      || snapshot.instrumentKey !== instrumentKey
      || !Array.isArray(snapshot.candles)
      || snapshot.candles.length === 0
      || snapshot.candles.length > 366) return false;

  let previousDate = null;
  for (const candle of snapshot.candles) {
    const date = isoDateInIndia(candle?.timestamp);
    const open = Number(candle?.open);
    const high = Number(candle?.high);
    const low = Number(candle?.low);
    const close = Number(candle?.close);
    if (!date || date < fromDate || date > toDate || date > isoDateInIndia(new Date())
        || (previousDate && date <= previousDate)
        || ![open, high, low, close].every(value => Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER)
        || high < Math.max(open, close, low)
        || low > Math.min(open, close)) return false;
    if (candle.volume !== null && candle.volume !== undefined
        && (!Number.isSafeInteger(candle.volume) || candle.volume < 0)) return false;
    previousDate = date;
  }
  return true;
}

function qualifyUpstoxNseSessionCoverage(snapshot, calendarSnapshot, { fromDate, toDate, now = new Date() } = {}) {
  if (!isUsableNseTradingCalendar(calendarSnapshot, now)) {
    return { expectedDates: [], failureCode: 'NSE_TRADING_CALENDAR_UNAVAILABLE' };
  }

  const requestedYears = new Set([fromDate.slice(0, 4), toDate.slice(0, 4)]);
  if ([...requestedYears].some(year => !calendarSnapshot.dates.some(date => date.startsWith(`${year}-`)))) {
    return { expectedDates: [], failureCode: 'NSE_CALENDAR_RANGE_NOT_COVERED' };
  }

  const expectedDates = expectedNseSessions(fromDate, toDate, calendarSnapshot.dates);
  if (expectedDates.length === 0) {
    return { expectedDates, failureCode: 'NO_EXPECTED_NSE_TRADING_SESSIONS' };
  }
  if (expectedDates.includes(isoDateInIndia(now))) {
    return { expectedDates, failureCode: 'UPSTOX_CURRENT_SESSION_NOT_VERIFIED_FINAL' };
  }

  const observedDates = snapshot.candles.map(candle => isoDateInIndia(candle.timestamp));
  if (observedDates.length !== expectedDates.length
      || observedDates.some((date, index) => date !== expectedDates[index])) {
    return { expectedDates, failureCode: 'UPSTOX_HISTORY_SESSION_COVERAGE_INCOMPLETE' };
  }

  return { expectedDates, failureCode: null };
}

function unavailableEquityHistory({ request, reasonCode, primarySnapshot = null, providerStatus = null } = {}) {
  return {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    status: AVAILABILITY.UNAVAILABLE,
    canonicalProductId: `market:equity:${request.exchange.toLowerCase()}:${request.isin}`,
    instrumentIdentity: { exchange: request.exchange, tradingSymbol: request.symbol, isin: request.isin },
    interval: '1 day',
    dataClass: request.basis === 'ADJUSTED' ? 'HISTORICAL_EOD' : null,
    priceBasis: request.basis === 'ADJUSTED' ? 'BACK_ADJUSTED' : null,
    fetchedAt: new Date().toISOString(),
    observedAt: null,
    effectiveTradingDate: null,
    freshness: { status: 'UNKNOWN', ageSeconds: null, maxAgeSeconds: null },
    candleCount: 0,
    candles: [],
    provider: null,
    fallbackUsed: false,
    selection: {
      requestedBasis: request.basis,
      primaryProvider: request.basis === 'RAW' ? PROVIDERS.UPSTOX : PROVIDERS.TEJHQ,
      selectedProvider: null,
      primaryFailureCode: primarySnapshot ? providerFailureCode(primarySnapshot) : null,
      reasonCode,
    },
    providerPublicationStatus: providerStatus?.publication ?? null,
    reasonCodes: [reasonCode],
  };
}

/**
 * Read-only daily equity history path. Upstox remains the primary historical
 * source for raw daily candles. TejHQ may only supply an NSE EOD fallback after
 * exact ISIN symbol-interval and qualified NSE weekday/holiday-calendar checks.
 * Adjusted history is a separate TejHQ data basis and is never replaced with
 * raw Upstox candles.
 */
export async function fetchQualifiedEquityHistory({
  exchange,
  symbol,
  isin,
  fromDate,
  toDate,
  basis = 'RAW',
  forceRefresh = false,
} = {}, {
  upstoxProvider = upstoxHistoryProvider,
  tejHqHistoricalProvider = tejHqProvider,
  nseCalendarProvider = nseHistoryProvider,
  env = process.env,
  clock = () => new Date(),
} = {}) {
  const normalizedIdentity = normalizeTejHqIdentity({ exchange, symbol, isin });
  const from = requireHistoryDate(fromDate, 'fromDate');
  const to = requireHistoryDate(toDate, 'toDate');
  if (from > to) throw new RangeError('fromDate must not be after toDate.');
  const normalizedBasis = String(basis).trim().toUpperCase();
  if (!['RAW', 'ADJUSTED'].includes(normalizedBasis)) throw new TypeError('basis must be RAW or ADJUSTED.');
  const spanDays = (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000 + 1;
  if (spanDays > 366) throw new RangeError('Equity history is limited to 366 calendar days per request.');
  const request = { ...normalizedIdentity, fromDate: from, toDate: to, basis: normalizedBasis };
  const canonicalProductId = `market:equity:${request.exchange.toLowerCase()}:${request.isin}`;
  const upstoxInstrumentKey = `${request.exchange}_EQ|${request.isin}`;
  if (request.exchange === 'NSE'
      && !productionRightsAllow(PROVIDERS.NSE, [NSE_TRADING_HOLIDAY_URL], env)) {
    return unavailableEquityHistory({
      request,
      reasonCode: 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED',
    });
  }
  let nseCalendarPromise = null;
  const loadNseCalendar = () => {
    if (!nseCalendarPromise) {
      nseCalendarPromise = Promise.resolve()
        .then(() => nseCalendarProvider.holidayLoader({ forceRefresh: false }))
        .catch(() => null);
    }
    return nseCalendarPromise;
  };

  let primarySnapshot = null;
  if (normalizedBasis === 'RAW') {
    if (!productionRightsAllow(PROVIDERS.UPSTOX, [UPSTOX_HISTORICAL_CANDLE_V3_RIGHTS_URL], env)) {
      primarySnapshot = unavailableMarketSnapshot(PROVIDERS.UPSTOX, UPSTOX_HISTORICAL_CANDLE_V3_RIGHTS_URL, {
        now: clock(),
        includeCandles: true,
      });
    } else if (!isUpstoxPublicDistributionAllowed(env)) {
      primarySnapshot = {
        status: AVAILABILITY.UNAVAILABLE,
        provider: PROVIDERS.UPSTOX,
        instrumentKey: upstoxInstrumentKey,
        candles: [],
        error: { code: 'UPSTOX_PUBLIC_DISTRIBUTION_DISABLED' },
      };
    } else {
      primarySnapshot = await upstoxProvider.getDailyCandles(upstoxInstrumentKey, {
        fromDate: from,
        toDate: to,
        forceRefresh,
      });
    }
    if (isQualifiedUpstoxDailyHistory(primarySnapshot, {
      instrumentKey: upstoxInstrumentKey,
      fromDate: from,
      toDate: to,
    })) {
      if (request.exchange === 'NSE') {
        const calendarSnapshot = await loadNseCalendar();
        const coverage = qualifyUpstoxNseSessionCoverage(primarySnapshot, calendarSnapshot, {
          fromDate: from,
          toDate: to,
          now: clock(),
        });
        if (!coverage.failureCode) {
          return {
            ...primarySnapshot,
            canonicalProductId,
            instrumentIdentity: normalizedIdentity,
            provider: PROVIDERS.UPSTOX,
            dataClass: 'HISTORICAL_DAILY',
            priceBasis: 'UPSTOX_PROVIDER_NATIVE',
            fallbackUsed: false,
            coverage: {
              status: 'COMPLETE_FOR_NSE_WEEKDAY_HOLIDAY_CALENDAR',
              expectedSessionCount: coverage.expectedDates.length,
              observedSessionCount: primarySnapshot.candles.length,
              calendarProvider: PROVIDERS.NSE,
              calendarFetchedAt: calendarSnapshot.fetchedAt,
            },
            selection: {
              requestedBasis: normalizedBasis,
              primaryProvider: PROVIDERS.UPSTOX,
              selectedProvider: PROVIDERS.UPSTOX,
              primaryFailureCode: null,
            },
          };
        }
        primarySnapshot = {
          ...primarySnapshot,
          status: AVAILABILITY.SOURCE_ERROR,
          error: { code: coverage.failureCode },
        };
      } else {
        primarySnapshot = {
          ...primarySnapshot,
          status: AVAILABILITY.SOURCE_ERROR,
          error: { code: 'BSE_TRADING_CALENDAR_NOT_QUALIFIED' },
        };
      }
    }
    if (primarySnapshot?.status === AVAILABILITY.AVAILABLE) {
      primarySnapshot = {
        ...primarySnapshot,
        status: AVAILABILITY.SOURCE_ERROR,
        error: { code: 'UPSTOX_HISTORY_RESPONSE_UNQUALIFIED' },
      };
    }
  }

  if (normalizedBasis === 'ADJUSTED' && env.TEJHQ_ADJUSTED_HISTORY_ENABLED !== 'true') {
    return unavailableEquityHistory({ request, reasonCode: 'TEJHQ_ADJUSTED_HISTORY_DISABLED', primarySnapshot });
  }
  if (normalizedBasis === 'RAW' && env.TEJHQ_HISTORICAL_FALLBACK_ENABLED !== 'true') {
    return unavailableEquityHistory({ request, reasonCode: 'TEJHQ_HISTORICAL_FALLBACK_DISABLED', primarySnapshot });
  }
  const tejHqHistoryPath = normalizedBasis === 'ADJUSTED' ? 'adjusted' : 'ohlcv';
  const tejHqRightsEndpoints = [
    tejHqSourceUrl(`/v1/${tejHqHistoryPath}/${request.exchange.toLowerCase()}/${encodeURIComponent(request.symbol)}`, {
      from: request.fromDate,
      to: request.toDate,
    }),
    tejHqSourceUrl(`/v1/symbols/${request.exchange.toLowerCase()}`, { isin: request.isin }),
    tejHqSourceUrl('/v1/status'),
  ];
  if (!productionRightsAllow(PROVIDERS.TEJHQ, tejHqRightsEndpoints, env)) {
    return unavailableEquityHistory({ request, reasonCode: 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED', primarySnapshot });
  }
  if (request.exchange !== 'NSE') {
    return unavailableEquityHistory({ request, reasonCode: 'TEJHQ_EXCHANGE_CALENDAR_NOT_QUALIFIED_FOR_FALLBACK', primarySnapshot });
  }

  const calendarSnapshot = await loadNseCalendar();
  const now = new Date();
  if (!isUsableNseTradingCalendar(calendarSnapshot, now)) {
    return unavailableEquityHistory({ request, reasonCode: 'NSE_TRADING_CALENDAR_UNAVAILABLE', primarySnapshot });
  }

  const requestedYears = new Set([from.slice(0, 4), to.slice(0, 4)]);
  if ([...requestedYears].some(year => !calendarSnapshot.dates.some(date => date.startsWith(`${year}-`)))) {
    return unavailableEquityHistory({ request, reasonCode: 'NSE_CALENDAR_RANGE_NOT_COVERED', primarySnapshot });
  }
  const expectedDates = expectedNseSessions(from, to, calendarSnapshot.dates);
  if (expectedDates.length === 0) {
    return unavailableEquityHistory({ request, reasonCode: 'NO_EXPECTED_NSE_TRADING_SESSIONS', primarySnapshot });
  }

  const [symbolSnapshot, providerStatus] = await Promise.all([
    tejHqHistoricalProvider.getSymbolHistory({ exchange: request.exchange, isin: request.isin, forceRefresh }),
    tejHqHistoricalProvider.getStatus({ forceRefresh: false }),
  ]);
  if (symbolSnapshot?.status !== AVAILABILITY.AVAILABLE || symbolSnapshot.isin !== request.isin
      || symbolSnapshot.exchange !== request.exchange) {
    return unavailableEquityHistory({
      request,
      reasonCode: providerFailureCode(symbolSnapshot, 'TEJHQ_SYMBOL_IDENTITY_UNAVAILABLE'),
      primarySnapshot,
      providerStatus,
    });
  }
  if (providerStatus?.status !== AVAILABILITY.AVAILABLE || providerStatus.provider !== PROVIDERS.TEJHQ) {
    return unavailableEquityHistory({ request, reasonCode: 'TEJHQ_PUBLICATION_STATUS_UNAVAILABLE', primarySnapshot });
  }
  const lastExpectedSession = expectedDates.at(-1);
  if (providerStatus.publication?.datasetTradingDate < lastExpectedSession) {
    return unavailableEquityHistory({ request, reasonCode: 'TEJHQ_DATASET_NOT_PUBLISHED_THROUGH_REQUESTED_SESSION', primarySnapshot, providerStatus });
  }

  const segmented = buildTejHqSymbolSegments(symbolSnapshot, expectedDates, normalizedIdentity);
  if (segmented.errorCode || segmented.segments.length === 0) {
    return unavailableEquityHistory({ request, reasonCode: segmented.errorCode || 'TEJHQ_SYMBOL_HISTORY_INCOMPLETE', primarySnapshot, providerStatus });
  }

  const candles = [];
  for (const segment of segmented.segments) {
    const segmentOptions = {
      exchange: request.exchange,
      symbol: segment.symbol,
      isin: segment.isin,
      fromDate: segment.dates[0],
      toDate: segment.dates.at(-1),
      forceRefresh,
    };
    const snapshot = normalizedBasis === 'ADJUSTED'
      ? await tejHqHistoricalProvider.getAdjustedHistory(segmentOptions)
      : await tejHqHistoricalProvider.getRawHistory(segmentOptions);
    if (snapshot?.status !== AVAILABILITY.AVAILABLE
        || snapshot.instrumentIdentity?.exchange !== request.exchange
        || snapshot.instrumentIdentity?.tradingSymbol !== segment.symbol
        || (normalizedBasis === 'ADJUSTED' && snapshot.priceBasis !== 'BACK_ADJUSTED')
        || !Array.isArray(snapshot.candles)
        || snapshot.candles.length !== segment.dates.length
        || !snapshot.candles.every((candle, index) => candle.date === segment.dates[index])) {
      return unavailableEquityHistory({
        request,
        reasonCode: providerFailureCode(snapshot, 'TEJHQ_HISTORICAL_SESSION_COVERAGE_INCOMPLETE'),
        primarySnapshot,
        providerStatus,
      });
    }
    if (normalizedBasis === 'ADJUSTED' && snapshot.candles.some(candle => candle.isin !== request.isin)) {
      return unavailableEquityHistory({ request, reasonCode: 'TEJHQ_ADJUSTED_ISIN_CHAIN_UNQUALIFIED', primarySnapshot, providerStatus });
    }
    candles.push(...snapshot.candles);
  }

  if (candles.length !== expectedDates.length || candles.some((candle, index) => candle.date !== expectedDates[index])) {
    return unavailableEquityHistory({ request, reasonCode: 'TEJHQ_HISTORICAL_SESSION_COVERAGE_INCOMPLETE', primarySnapshot, providerStatus });
  }

  return {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    status: AVAILABILITY.AVAILABLE,
    provider: PROVIDERS.TEJHQ,
    canonicalProductId,
    instrumentIdentity: normalizedIdentity,
    instrumentKey: `${request.exchange}:${request.symbol}`,
    interval: '1 day',
    dataClass: 'HISTORICAL_EOD',
    priceBasis: normalizedBasis === 'ADJUSTED' ? 'BACK_ADJUSTED' : 'RAW_UNADJUSTED',
    ...(normalizedBasis === 'ADJUSTED' ? { adjustmentSemantics: 'SPLITS_BONUSES_AND_DIVIDENDS' } : {}),
    ...(normalizedBasis === 'ADJUSTED' ? {
      priceFieldSemantics: {
        openHighLowClose: 'RAW_UNADJUSTED',
        adjustedClose: 'BACK_ADJUSTED',
        adjustmentFactor: 'RAW_CLOSE_TO_BACK_ADJUSTED_CLOSE',
      },
    } : {}),
    sourceDatasetRevision: symbolSnapshot.sourceDatasetRevision,
    fetchedAt: new Date().toISOString(),
    observedAt: null,
    effectiveTradingDate: candles.at(-1)?.date ?? null,
    freshness: { status: 'UNKNOWN', ageSeconds: null, maxAgeSeconds: null, reasonCode: 'TEJHQ_DATE_ONLY_OBSERVATION' },
    candleCount: candles.length,
    candles,
    source: {
      provider: PROVIDERS.TEJHQ,
      instrumentId: `${request.exchange}:${request.isin}`,
      url: normalizedBasis === 'ADJUSTED'
        ? 'https://api.tejhq.dev/v1/adjusted'
        : 'https://api.tejhq.dev/v1/ohlcv',
    },
    sourceAttribution: {
      provider: PROVIDERS.TEJHQ,
      sourceUrl: 'https://tejhq.dev/docs',
      upstreamData: 'NSE exchange-published end-of-day equity Bhavcopy',
    },
    fallbackUsed: normalizedBasis === 'RAW' && primarySnapshot?.status !== AVAILABILITY.AVAILABLE,
    providerPublicationStatus: {
      ...providerStatus.publication,
      requestedLatestSession: lastExpectedSession,
      requestedRangePublicationStatus: 'PUBLISHED_THROUGH_REQUESTED_SESSION',
    },
    coverage: {
      status: 'COMPLETE_FOR_NSE_WEEKDAY_HOLIDAY_CALENDAR',
      expectedSessionCount: expectedDates.length,
      observedSessionCount: candles.length,
      calendarSource: calendarSnapshot.source,
      symbolHistoryStatus: symbolSnapshot.identityStatus,
    },
    selection: {
      requestedBasis: normalizedBasis,
      primaryProvider: normalizedBasis === 'RAW' ? PROVIDERS.UPSTOX : PROVIDERS.TEJHQ,
      selectedProvider: PROVIDERS.TEJHQ,
      primaryFailureCode: primarySnapshot && primarySnapshot.status !== AVAILABILITY.AVAILABLE
        ? providerFailureCode(primarySnapshot)
        : null,
    },
    reasonCodes: [],
  };
}

export async function fetchTejHqCorporateActionEvidence({ exchange, symbol, isin, forceRefresh = false } = {}, {
  tejHqHistoricalProvider = tejHqProvider,
  env = process.env,
} = {}) {
  const identity = normalizeTejHqIdentity({ exchange, symbol, isin });
  const rightsEndpoints = [
    tejHqSourceUrl(`/v1/actions/${encodeURIComponent(identity.symbol)}`),
    tejHqSourceUrl(`/v1/symbols/${identity.exchange.toLowerCase()}`, { isin: identity.isin }),
  ];
  if (!productionRightsAllow(PROVIDERS.TEJHQ, rightsEndpoints, env)) {
    return {
      ...unavailableMarketSnapshot(PROVIDERS.TEJHQ, rightsEndpoints[0]),
      canonicalProductId: `market:equity:${identity.exchange.toLowerCase()}:${identity.isin}`,
      requestedIdentity: identity,
      events: [],
      eventCount: null,
      completeness: 'NOT_AVAILABLE',
      identityStatus: 'UNVERIFIED',
    };
  }
  const [actionsSnapshot, symbolSnapshot] = await Promise.all([
    tejHqHistoricalProvider.getCorporateActions({ symbol: identity.symbol, forceRefresh }),
    tejHqHistoricalProvider.getSymbolHistory({ exchange: identity.exchange, isin: identity.isin, forceRefresh }),
  ]);
  if (actionsSnapshot?.status !== AVAILABILITY.AVAILABLE) return actionsSnapshot;
  const events = actionsSnapshot.events.map(event => {
    const interval = (symbolSnapshot?.intervals || []).find(item => item.exchange === identity.exchange
      && item.isin === identity.isin && item.symbol === event.symbol
      && item.validFrom <= event.exDate && item.validTo >= event.exDate);
    return {
      ...event,
      identityStatus: event.exchange === identity.exchange && event.isin === identity.isin && interval
        ? 'VERIFIED_FOR_EFFECTIVE_DATE'
        : 'UNVERIFIED',
    };
  }).filter(event => event.exchange === identity.exchange && event.isin === identity.isin);
  return {
    ...actionsSnapshot,
    canonicalProductId: `market:equity:${identity.exchange.toLowerCase()}:${identity.isin}`,
    requestedIdentity: identity,
    events,
    completeness: 'NOT_CONCLUSIVE',
    identityStatus: events.length > 0 && events.every(event => event.identityStatus === 'VERIFIED_FOR_EFFECTIVE_DATE')
      ? 'SOURCE_INTERVALS_VALIDATED'
      : 'PARTIALLY_OR_NOT_VERIFIED',
  };
}

export async function fetchTejHqProviderPublicationStatus(options = {}, {
  env = process.env,
  tejHqHistoricalProvider = tejHqProvider,
} = {}) {
  const statusUrl = tejHqSourceUrl('/v1/status');
  if (!productionRightsAllow(PROVIDERS.TEJHQ, [statusUrl], env)) {
    return { ...unavailableMarketSnapshot(PROVIDERS.TEJHQ, statusUrl), publication: null };
  }
  return tejHqHistoricalProvider.getStatus(options);
}

export const MARKET_PARAMETER_SCHEMA_VERSION = 'simulation-assumptions-3.0.0';
export const MARKET_PARAMETER_CACHE_KEY = `mc:instrument:params:${MARKET_PARAMETER_SCHEMA_VERSION}`;

const LEGACY_SYMBOL_TO_BENCHMARK_ID = Object.freeze({
  '^NSEI': MARKET_BENCHMARKS.NIFTY_50.canonicalProductId,
  '^INDIAVIX': MARKET_BENCHMARKS.INDIA_VIX.canonicalProductId,
});

function safeTimingCode(error) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code
    : null;
}

async function measuredAmfiStage(onStageTiming, stage, operation) {
  const startedAt = performance.now();
  let status = 'ERROR';
  let code = null;
  let provider = 'AMFI';
  try {
    const result = await operation();
    status = typeof result?.status === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(result.status)
      ? result.status
      : 'COMPLETED';
    code = safeTimingCode({ code: result?.code || result?.error?.code })
      || (result?.coalesced ? 'MARKET_PERSISTENCE_COALESCED' : null);
    if (result?.provider === 'AMFI') provider = 'AMFI';
    return result;
  } catch (error) {
    code = safeTimingCode(error);
    throw error;
  } finally {
    if (typeof onStageTiming === 'function') {
      try {
        onStageTiming({
          stage,
          elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
          provider,
          status,
          ...(code ? { code } : {}),
        });
      } catch { /* instrumentation must not alter market-data behavior */ }
    }
  }
}

async function persistFreshSnapshot(snapshot) {
  if (snapshot?.cache?.hit || ![AVAILABILITY.AVAILABLE, AVAILABILITY.PARTIAL].includes(snapshot?.status)) {
    return { status: 'NOT_PERSISTED', productWrites: 0, observationWrites: 0 };
  }
  try {
    return await persistVerifiedMarketSnapshot(snapshot);
  } catch (error) {
    return {
      status: 'PERSISTENCE_ERROR',
      productWrites: 0,
      observationWrites: 0,
      error: { code: 'MARKET_PERSISTENCE_FAILED', message: error?.message || 'Persistence failed.' },
    };
  }
}

export async function fetchAmfiProductSnapshot({
  forceRefresh = false,
  persist = true,
  onStageTiming,
  env = process.env,
  marketDataTestFixtureRightsCapability = null,
} = {}) {
  if (!isMarketDataProductionUseAllowed(PROVIDERS.AMFI, AMFI_NAV_URL, env, marketDataTestFixtureRightsCapability)) {
    return {
      ...unavailableMarketSnapshot(PROVIDERS.AMFI, AMFI_NAV_URL, { includeProducts: true }),
      persistence: { status: 'NOT_PERSISTED', code: 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED' },
    };
  }
  const snapshot = await measuredAmfiStage(onStageTiming, 'amfi_current_fetch',
    () => amfiProvider.getSnapshot({ forceRefresh }));
  const persistence = await measuredAmfiStage(onStageTiming, 'amfi_current_persistence', () => persist
    ? persistFreshSnapshot(snapshot)
    : { status: 'NOT_REQUESTED', code: 'PERSISTENCE_NOT_REQUESTED' });
  return { ...snapshot, persistence };
}

export async function fetchAmfiHistoricalNavSnapshot({
  targetDate,
  forceRefresh = false,
  persist = true,
  onStageTiming,
  env = process.env,
  marketDataTestFixtureRightsCapability = null,
} = {}) {
  const target = targetDate ? new Date(targetDate) : new Date();
  if (Number.isNaN(target.getTime())) throw new TypeError('targetDate must be a valid date.');
  if (!targetDate) target.setUTCFullYear(target.getUTCFullYear() - 1);
  const targetIsoDate = target.toISOString().slice(0, 10);
  const historyWindow = buildAmfiHistoryWindow(targetIsoDate);
  const historySourceUrl = `${AMFI_NAV_HISTORY_URL}?frmdt=${historyWindow.fromParam}&todt=${historyWindow.toParam}`;
  if (!isMarketDataProductionUseAllowed(PROVIDERS.AMFI, historySourceUrl, env, marketDataTestFixtureRightsCapability)) {
    return {
      ...unavailableMarketSnapshot(PROVIDERS.AMFI, historySourceUrl, { includeProducts: true }),
      persistence: { status: 'NOT_PERSISTED', code: 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED' },
    };
  }
  const snapshot = await measuredAmfiStage(onStageTiming, 'amfi_historical_fetch', () => amfiHistoryProvider.getSnapshot({
    targetDate: targetIsoDate,
    forceRefresh,
  }));
  const persistence = await measuredAmfiStage(onStageTiming, 'amfi_historical_persistence', () => persist
    ? persistFreshSnapshot(snapshot)
    : { status: 'NOT_REQUESTED', code: 'PERSISTENCE_NOT_REQUESTED' });
  return { ...snapshot, persistence };
}

export async function fetchGovernmentSavingsSnapshot({ forceRefresh = false, persist = true, env = process.env } = {}) {
  const deniedEndpoint = firstUnqualifiedRightsEndpoint(PROVIDERS.GOVERNMENT_OF_INDIA, [
    INDIA_POST_SAVINGS_URL,
    INDIA_POST_SCRIPT_CHUNK_RIGHTS_URL,
  ], env);
  if (deniedEndpoint) {
    return {
      ...unavailableMarketSnapshot(PROVIDERS.GOVERNMENT_OF_INDIA, deniedEndpoint, { includeProducts: true }),
      persistence: { status: 'NOT_PERSISTED', code: 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED' },
    };
  }
  const snapshot = await governmentSavingsProvider.getSnapshot({ forceRefresh });
  const persistence = persist ? await persistFreshSnapshot(snapshot) : { status: 'NOT_REQUESTED' };
  return { ...snapshot, persistence };
}

export async function fetchSbiTermDepositSnapshot({ forceRefresh = false, persist = true, env = process.env } = {}) {
  if (!productionRightsAllow(PROVIDERS.SBI, [SBI_TERM_DEPOSIT_URL], env)) {
    return {
      ...unavailableMarketSnapshot(PROVIDERS.SBI, SBI_TERM_DEPOSIT_URL, { includeProducts: true }),
      persistence: { status: 'NOT_PERSISTED', code: 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED' },
    };
  }
  const snapshot = await sbiTermDepositProvider.getSnapshot({ forceRefresh });
  const persistence = persist ? await persistFreshSnapshot(snapshot) : { status: 'NOT_REQUESTED' };
  return { ...snapshot, persistence };
}

export async function fetchRbiFloatingRateSavingsBondSnapshot({ forceRefresh = false, persist = true, env = process.env } = {}) {
  const rbiDeniedEndpoint = firstUnqualifiedRightsEndpoint(PROVIDERS.RBI, [RBI_FRSB_NOTIFICATION_URL], env);
  const indiaPostDeniedEndpoint = firstUnqualifiedRightsEndpoint(PROVIDERS.GOVERNMENT_OF_INDIA, [
    INDIA_POST_SAVINGS_URL,
    INDIA_POST_SCRIPT_CHUNK_RIGHTS_URL,
  ], env);
  if (rbiDeniedEndpoint || indiaPostDeniedEndpoint) {
    const deniedSource = rbiDeniedEndpoint
      ? unavailableMarketSnapshot(PROVIDERS.RBI, rbiDeniedEndpoint, { includeProducts: true })
      : unavailableMarketSnapshot(PROVIDERS.GOVERNMENT_OF_INDIA, indiaPostDeniedEndpoint, { includeProducts: true });
    return {
      ...deniedSource,
      provider: PROVIDERS.RBI,
      persistence: { status: 'NOT_PERSISTED', code: 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED' },
    };
  }
  const snapshot = await rbiProvider.getSnapshot({ forceRefresh });
  const persistence = persist ? await persistFreshSnapshot(snapshot) : { status: 'NOT_REQUESTED' };
  return { ...snapshot, persistence };
}

/**
 * Compatibility DTO for existing callers. NAV remains a NAV observation only;
 * it is not converted into an expected return, price, or post-tax value.
 */
export async function fetchMutualFundNAVs(options = {}) {
  const snapshot = await fetchAmfiProductSnapshot(options);
  const factsByProduct = new Map((snapshot.facts || []).map(fact => [fact.canonicalProductId, fact]));
  const navMap = {};
  for (const product of snapshot.products || []) {
    const fact = factsByProduct.get(product.canonicalProductId);
    const schemeCode = product.externalIds?.find(item => item.source === 'AMFI_SCHEME_CODE')?.value;
    if (!schemeCode) continue;
    navMap[schemeCode] = {
      scheme_code: schemeCode,
      isin: product.externalIds?.find(item => item.source === 'ISIN')?.value || null,
      scheme_name: product.name,
      plan: product.plan,
      option: product.option,
      nav: fact?.value ?? null,
      nav_date: fact?.observedDate ?? null,
      observed_at: fact?.observedAt ?? null,
      availability_status: fact?.availabilityStatus ?? AVAILABILITY.UNAVAILABLE,
      freshness: fact?.freshness ?? null,
      data_source: 'AMFI',
    };
  }
  return {
    schema_version: MARKET_DATA_SCHEMA_VERSION,
    provider: snapshot.provider,
    status: snapshot.status,
    navMap,
    count: snapshot.productCount ?? null,
    available_count: snapshot.availableFactCount ?? null,
    fetched_at: snapshot.fetchedAt,
    cached: snapshot.cache?.hit === true,
    cache: snapshot.cache,
    persistence: snapshot.persistence,
    error: snapshot.error,
  };
}

export async function fetchBenchmarkQuotes({ forceRefresh = false, persist = true, env = process.env, now = new Date() } = {}) {
  const provider = PRIMARY_MARKET_PROVIDER;
  let snapshot;
  if (provider === 'UPSTOX') {
    snapshot = !productionRightsAllow(PROVIDERS.UPSTOX, [UPSTOX_QUOTE_RIGHTS_URL], env)
      ? unavailableMarketSnapshot(PROVIDERS.UPSTOX, UPSTOX_QUOTE_URL, { now })
      : isUpstoxPublicDistributionAllowed(env)
        ? await upstoxProvider.getQuotes(DEFAULT_BENCHMARK_INSTRUMENT_KEYS, { forceRefresh })
        : unavailableDistributionSnapshot(PROVIDERS.UPSTOX, 'UPSTOX_PUBLIC_DISTRIBUTION_DISABLED', now);
  } else {
    const urls = [NSE_ALL_INDICES_URL, NSE_TRADING_HOLIDAY_URL];
    snapshot = productionRightsAllow(PROVIDERS.NSE, urls, env)
      ? await nseProvider.getQuotes(DEFAULT_BENCHMARK_IDS, { forceRefresh })
      : unavailableMarketSnapshot(PROVIDERS.NSE, NSE_ALL_INDICES_URL, { now });
  }
  const persistence = persist ? await persistFreshSnapshot(snapshot) : { status: 'NOT_REQUESTED' };
  return { ...snapshot, persistence };
}

/**
 * Read-only quotes for exact canonical IDs in the small verified Upstox
 * registry. A syntactically valid provider key is never accepted from a client.
 */
export async function fetchUpstoxCanonicalQuotes(canonicalProductIds, {
  forceRefresh = false,
  env = process.env,
  now = new Date(),
  upstoxMarketDataProvider = upstoxProvider,
} = {}) {
  const identities = resolveUpstoxQuoteIdentities(canonicalProductIds);
  const quoteRequestUrl = buildUpstoxQuoteRequestUrl(identities.map(identity => identity.upstoxInstrumentKey));
  const snapshot = productionRightsAllow(PROVIDERS.UPSTOX, [quoteRequestUrl], env)
    && isUpstoxPublicDistributionAllowed(env)
    ? await upstoxMarketDataProvider.getQuotes(
      identities.map(identity => identity.upstoxInstrumentKey),
      { forceRefresh },
    )
    : !productionRightsAllow(PROVIDERS.UPSTOX, [quoteRequestUrl], env)
      ? unavailableMarketSnapshot(PROVIDERS.UPSTOX, UPSTOX_QUOTE_URL, { now })
      : unavailableDistributionSnapshot(PROVIDERS.UPSTOX, 'UPSTOX_PUBLIC_DISTRIBUTION_DISABLED', now);
  const factsById = new Map((snapshot.facts || []).map(fact => [fact.canonicalProductId, fact]));
  const facts = identities.map(identity => {
    const sourceFact = factsById.get(identity.canonicalProductId) || null;
    return {
      canonicalProductId: identity.canonicalProductId,
      displayName: identity.displayName,
      assetClass: identity.assetClass,
      instrumentIdentity: {
        exchange: identity.exchange,
        instrumentType: identity.instrumentType,
        tradingSymbol: identity.tradingSymbol,
        listingStatus: identity.listingStatus,
        isin: identity.isin,
        issuer: identity.issuer,
        registryRevision: identity.registryRevision,
      },
      dataClass: identity.dataClass,
      sourceProvider: PROVIDERS.UPSTOX,
      sourceInstrumentId: identity.upstoxInstrumentKey,
      sourceUrl: sourceFact?.sourceUrl || quoteRequestUrl,
      value: sourceFact?.value ?? null,
      currency: identity.currency,
      unit: identity.unit,
      observedAt: sourceFact?.observedAt ?? null,
      fetchedAt: sourceFact?.fetchedAt ?? snapshot.fetchedAt ?? null,
      providerTimestamp: sourceFact?.providerTimestamp ?? null,
      effectiveTradingDate: sourceFact?.effectiveTradingDate ?? null,
      availabilityStatus: sourceFact?.availabilityStatus ?? AVAILABILITY.UNAVAILABLE,
      freshness: sourceFact?.freshness ?? { status: 'UNKNOWN', ageSeconds: null, maxAgeSeconds: UPSTOX_QUOTE_FRESHNESS_SECONDS },
      reasonCode: sourceFact?.reasonCode ?? snapshot.error?.code ?? 'NO_PROVIDER_OBSERVATION',
      sourceVerification: {
        status: 'DOCUMENTATION_AND_BACKEND_IDENTITY_ONLY',
        evidenceSource: identity.evidenceSource,
        evidenceReviewedAt: identity.evidenceReviewedAt,
        providerAccessStatus: identity.providerAccessStatus,
      },
      marketSessionStatus: 'UNKNOWN',
    };
  });
  return {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    provider: PROVIDERS.UPSTOX,
    status: snapshot.status,
    registryRevision: UPSTOX_INSTRUMENT_REGISTRY_REVISION,
    fetchedAt: snapshot.fetchedAt,
    requestedInstrumentCount: facts.length,
    availableFactCount: snapshot.error?.code === 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED'
      ? null
      : facts.filter(fact => fact.availabilityStatus === AVAILABILITY.AVAILABLE).length,
    facts,
    cache: snapshot.cache ?? { hit: false, backend: 'NONE' },
    ...(snapshot.error ? { error: snapshot.error } : {}),
  };
}

export function buildNiftyHistoryWindow(now = new Date()) {
  const reference = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (Number.isNaN(reference.getTime())) throw new TypeError('now must be a valid date.');
  const indiaDate = isoDateInIndia(reference);
  if (!indiaDate) throw new TypeError('now must be a valid date.');
  const to = new Date(`${indiaDate}T00:00:00.000Z`);
  to.setUTCDate(to.getUTCDate() - 1);
  const from = new Date(to.getTime());
  from.setUTCDate(from.getUTCDate() - 400);
  return {
    fromDate: from.toISOString().slice(0, 10),
    toDate: to.toISOString().slice(0, 10),
  };
}

/**
 * One bounded daily-history request supplies more than 200 expected trading
 * sessions without streaming or retrieving an entire market universe.
 */
export async function fetchNiftyHistoricalCandles({
  forceRefresh = false,
  now = new Date(),
  persist = true,
  env = process.env,
} = {}) {
  const window = buildNiftyHistoryWindow(now);
  const providerName = PRIMARY_MARKET_PROVIDER;
  const provider = providerName === 'UPSTOX' ? upstoxHistoryProvider : nseHistoryProvider;
  const instrumentId = providerName === 'UPSTOX'
    ? NIFTY_50_INSTRUMENT_KEY
    : MARKET_BENCHMARKS.NIFTY_50.canonicalProductId;
  const snapshot = providerName === 'UPSTOX'
    ? productionRightsAllow(PROVIDERS.UPSTOX, [UPSTOX_HISTORICAL_CANDLE_V3_RIGHTS_URL], env)
      && isUpstoxPublicDistributionAllowed(env)
      ? await provider.getDailyCandles(instrumentId, { ...window, forceRefresh })
      : !productionRightsAllow(PROVIDERS.UPSTOX, [UPSTOX_HISTORICAL_CANDLE_V3_RIGHTS_URL], env)
        ? unavailableMarketSnapshot(PROVIDERS.UPSTOX, UPSTOX_HISTORICAL_CANDLE_V3_RIGHTS_URL, { now, includeCandles: true })
        : unavailableDistributionSnapshot(PROVIDERS.UPSTOX, 'UPSTOX_PUBLIC_DISTRIBUTION_DISABLED', now, { includeCandles: true })
    : productionRightsAllow(PROVIDERS.NSE, [NSE_HISTORICAL_INDEX_RIGHTS_URL, NSE_TRADING_HOLIDAY_URL], env)
      ? await provider.getDailyCandles(instrumentId, { ...window, forceRefresh })
      : unavailableMarketSnapshot(PROVIDERS.NSE, NSE_HISTORICAL_INDEX_URL, { now, includeCandles: true });
  const persistence = persist ? await persistFreshSnapshot(snapshot) : { status: 'NOT_REQUESTED' };
  return { ...snapshot, persistence };
}

/**
 * Resolve market-context inputs as one provider-coherent pair. This is the
 * bounded NSE/Upstox failover boundary; standalone quote endpoints retain their
 * existing single-provider semantics and source labels.
 */
export async function fetchQualifiedMarketContextSnapshots({
  forceRefresh = false,
  forceQuoteRefresh = forceRefresh,
  forceHistoryRefresh = forceRefresh,
  now = new Date(),
  persist = true,
  env = process.env,
  upstoxQuoteProvider = upstoxProvider,
  upstoxHistoryProviderOverride = upstoxHistoryProvider,
  nseQuoteProvider = nseProvider,
  nseHistoryProviderOverride = nseHistoryProvider,
} = {}) {
  const window = buildNiftyHistoryWindow(now);
  const providerPairs = [
    ...(productionRightsAllow(PROVIDERS.NSE, [
      NSE_ALL_INDICES_URL,
      NSE_HISTORICAL_INDEX_RIGHTS_URL,
      NSE_TRADING_HOLIDAY_URL,
    ], env) ? [{
      name: 'NSE',
      fetchQuotes: () => nseQuoteProvider.getQuotes(DEFAULT_BENCHMARK_IDS, { forceRefresh: forceQuoteRefresh }),
      fetchHistory: () => nseHistoryProviderOverride.getDailyCandles(MARKET_BENCHMARKS.NIFTY_50.canonicalProductId, {
        ...window,
        forceRefresh: forceHistoryRefresh,
      }),
    }] : []),
  ];
  if (upstoxMarketContextRightsAllowed(env)) {
    providerPairs.push({
      name: 'UPSTOX',
      fetchQuotes: () => upstoxQuoteProvider.getQuotes(DEFAULT_BENCHMARK_INSTRUMENT_KEYS, { forceRefresh: forceQuoteRefresh }),
      fetchHistory: () => upstoxHistoryProviderOverride.getDailyCandles(NIFTY_50_INSTRUMENT_KEY, {
        ...window,
        forceRefresh: forceHistoryRefresh,
      }),
    });
  }
  if (providerPairs.length === 0) {
    const provider = PRIMARY_MARKET_PROVIDER === 'UPSTOX' ? PROVIDERS.UPSTOX : PROVIDERS.NSE;
    const url = PRIMARY_MARKET_PROVIDER === 'UPSTOX' ? UPSTOX_QUOTE_URL : NSE_ALL_INDICES_URL;
    const quoteSnapshot = unavailableMarketSnapshot(provider, url, { now });
    const historyUrl = provider === PROVIDERS.UPSTOX ? UPSTOX_HISTORICAL_CANDLE_V3_RIGHTS_URL : NSE_HISTORICAL_INDEX_URL;
    const historySnapshot = unavailableMarketSnapshot(provider, historyUrl, { now, includeCandles: true });
    const providerSelection = {
      attemptedProviders: [],
      selectedProvider: null,
      providerFailures: [{ provider, reasonCodes: ['MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED'] }],
      fallbackUsed: false,
    };
    return {
      quoteSnapshot: { ...quoteSnapshot, providerSelection },
      historicalSnapshot: { ...historySnapshot, providerSelection },
      providerSelection,
    };
  }
  const result = await fetchQualifiedMarketPair({
    providers: providerPairs,
    preferredProvider: PRIMARY_MARKET_PROVIDER,
  });
  const persistence = persist
    ? await Promise.all([
      persistFreshSnapshot(result.quoteSnapshot),
      persistFreshSnapshot(result.historicalSnapshot),
    ])
    : [{ status: 'NOT_REQUESTED' }, { status: 'NOT_REQUESTED' }];
  return {
    ...result,
    quoteSnapshot: { ...result.quoteSnapshot, persistence: persistence[0] },
    historicalSnapshot: { ...result.historicalSnapshot, persistence: persistence[1] },
  };
}

/**
 * Compatibility boundary for old index callers. Phase 1 exposes the verified
 * quote when available, but does not invent annualised return or volatility
 * from a single quote. Historical feature computation belongs to Phase 3.
 */
export async function fetchIndexStatistics(symbol = '^NSEI', options = {}) {
  const benchmarkId = LEGACY_SYMBOL_TO_BENCHMARK_ID[symbol];
  if (!benchmarkId) {
    return {
      symbol,
      status: AVAILABILITY.UNAVAILABLE,
      available: false,
      latest_price: null,
      annualised_return: null,
      annualised_volatility: null,
      data_points: 0,
      observed_at: null,
      data_source: null,
      error: { code: 'UNSUPPORTED_INDEX_SYMBOL', message: 'No qualified provider identity exists.' },
    };
  }
  const snapshot = await fetchBenchmarkQuotes(options);
  const fact = snapshot.facts?.find(item => item.canonicalProductId === benchmarkId) || null;
  return {
    symbol,
    instrument_key: fact?.source?.instrumentId ?? null,
    canonical_product_id: benchmarkId,
    status: snapshot.status,
    available: fact?.availabilityStatus === AVAILABILITY.AVAILABLE,
    latest_price: fact?.value ?? null,
    annualised_return: null,
    annualised_volatility: null,
    data_points: fact ? 1 : 0,
    observed_at: fact?.observedAt ?? null,
    fetched_at: snapshot.fetchedAt,
    freshness: fact?.freshness ?? null,
    data_source: fact ? snapshot.provider : null,
    source_url: fact?.source?.url ?? null,
    error: snapshot.error,
    cached: snapshot.cache?.hit === true,
  };
}

/**
 * Existing Monte Carlo callers still require explicit model assumptions until
 * Phase 5. These are now labelled as assumptions and are never described as
 * live/verified observations or altered by an external quote.
 */
export async function getInstrumentModelAssumptions() {
  const params = Object.fromEntries(Object.entries(INSTRUMENT_PARAMS).map(([key, value]) => [key, {
    mean: value.nominalRate / 100,
    stdDev: value.volatility,
    source: PROJECTION_ASSUMPTION_SOURCE,
    dataClass: PROJECTION_ASSUMPTION_DATA_CLASS,
    assumptionVersion: PROJECTION_ASSUMPTION_VERSION,
    observedMarketFact: false,
    providerForecast: false,
  }]));
  return {
    schema_version: MARKET_PARAMETER_SCHEMA_VERSION,
    status: 'MODEL_ASSUMPTIONS_ONLY',
    params,
    computed_at: null,
    live_index_used: false,
    live_index_reason: 'PHASE_1_DOES_NOT_ESTIMATE_EXPECTED_RETURNS_FROM_QUOTES',
    data_class: PROJECTION_ASSUMPTION_DATA_CLASS,
    assumption_version: PROJECTION_ASSUMPTION_VERSION,
    source: PROJECTION_ASSUMPTION_SOURCE,
    observed_market_fact: false,
    provider_forecast: false,
    cached: false,
  };
}

// Compatibility alias. The response itself is explicitly MODEL_ASSUMPTIONS_ONLY.
export const getLiveInstrumentParams = getInstrumentModelAssumptions;

export async function getMutualFundNavsBySchemeCodes(schemeCodes, options = {}) {
  const normalizedCodes = [...new Set((schemeCodes || []).map(value => String(value).trim()).filter(Boolean))];
  const snapshot = await fetchAmfiProductSnapshot(options);
  const wantedIds = new Set(normalizedCodes.map(code => `mf:amfi:${code}`));
  return {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    provider: snapshot.provider,
    status: snapshot.status,
    fetchedAt: snapshot.fetchedAt,
    products: (snapshot.products || []).filter(product => wantedIds.has(product.canonicalProductId)),
    facts: (snapshot.facts || []).filter(fact => wantedIds.has(fact.canonicalProductId)),
    cache: snapshot.cache,
    error: snapshot.error,
  };
}

export async function checkFDRateStaleness(Instrument) {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const staleCount = await Instrument.countDocuments({
      type: 'FD',
      $or: [
        { updatedAt: { $lt: thirtyDaysAgo } },
        { updatedAt: { $exists: false }, createdAt: { $lt: thirtyDaysAgo } },
        { updatedAt: { $exists: false }, createdAt: { $exists: false } },
      ],
    });
    return {
      stale_count: staleCount,
      needs_refresh: staleCount > 0,
      warning: staleCount > 0
        ? `${staleCount} FD rate records are older than 30 days. Update via admin panel.`
        : null,
    };
  } catch {
    return { stale_count: 0, needs_refresh: false, warning: null };
  }
}

function sourceSummary(snapshot) {
  const freshness = (snapshot.facts || []).reduce((counts, fact) => {
    const status = fact?.freshness?.status || 'UNKNOWN';
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, { FRESH: 0, STALE: 0, UNKNOWN: 0 });
  return {
    provider: snapshot.provider,
    status: snapshot.status,
    fetchedAt: snapshot.fetchedAt ?? null,
    availableFactCount: snapshot.availableFactCount ?? 0,
    productCount: snapshot.productCount ?? null,
    cache: snapshot.cache ?? null,
    freshness,
    error: snapshot.error ?? null,
  };
}

export async function getMarketDataSummary(options = {}) {
  const [amfi, market, government, sbi] = await Promise.all([
    fetchAmfiProductSnapshot(options),
    fetchBenchmarkQuotes(options),
    fetchGovernmentSavingsSnapshot(options),
    fetchSbiTermDepositSnapshot(options),
  ]);
  const statuses = [amfi.status, market.status, government.status, sbi.status];
  const availableSources = statuses.filter(status => [AVAILABILITY.AVAILABLE, AVAILABILITY.PARTIAL].includes(status)).length;
  const status = availableSources === statuses.length
    ? AVAILABILITY.AVAILABLE
    : availableSources > 0 ? AVAILABILITY.PARTIAL : AVAILABILITY.UNAVAILABLE;
  const timestamps = [amfi.fetchedAt, market.fetchedAt].filter(Boolean).sort();
  const marketSourceKey = String(market.provider || PRIMARY_MARKET_PROVIDER).toLowerCase();
  return {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    status,
    lastRefresh: timestamps.at(-1) ?? null,
    sources: {
      amfi: sourceSummary(amfi),
      [marketSourceKey]: sourceSummary(market),
      governmentSmallSavings: sourceSummary(government),
      sbiTermDeposits: sourceSummary(sbi),
    },
    primaryMarketProvider: PRIMARY_MARKET_PROVIDER,
    benchmarks: market.facts || [],
  };
}
