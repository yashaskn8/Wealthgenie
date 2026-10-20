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
import { UPSTOX_NSE_MARKET_STATUS_URL, UPSTOX_MARKET_TIMINGS_RIGHTS_URL } from './marketData/marketDataSourceUrls.js';
import UpstoxHistoricalCandleProvider, {
  NIFTY_50_INSTRUMENT_KEY,
  UPSTOX_HISTORICAL_CANDLE_V3_RIGHTS_URL,
} from './marketData/UpstoxHistoricalCandleProvider.js';
import NseMarketDataProvider, { NSE_ALL_INDICES_URL } from './marketData/NseMarketDataProvider.js';
import NseHistoricalDataProvider, {
  NSE_HISTORICAL_INDEX_RIGHTS_URL,
  NSE_HISTORICAL_INDEX_URL,
} from './marketData/NseHistoricalDataProvider.js';
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
import UpstoxTradingCalendarProvider, {
  expectedUpstoxNseSessions,
  UPSTOX_TRADING_HOLIDAYS_URL,
} from './marketData/UpstoxTradingCalendarProvider.js';
import { persistVerifiedMarketSnapshot } from './marketData/MarketDataRepository.js';
import { isUpstoxPublicDistributionAllowed } from './marketData/upstoxDistributionPolicy.js';
import {
  buildMarketDataRightsUnavailableSnapshot,
  isMarketDataPrivateDemoUseAllowed,
  isMarketDataProductionUseAllowed,
} from './marketData/marketDataRights.js';

const amfiProvider = new AmfiNavProvider();
const amfiHistoryProvider = new AmfiNavHistoryProvider();
const upstoxProvider = new UpstoxMarketDataProvider();
const upstoxHistoryProvider = new UpstoxHistoricalCandleProvider();
const upstoxCalendarProvider = new UpstoxTradingCalendarProvider();
const nseProvider = new NseMarketDataProvider();
const nseHistoryProvider = new NseHistoricalDataProvider();
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

export const UPSTOX_ONLY_MARKET_DATA_MODE = 'UPSTOX_ONLY';

export function isUpstoxOnlyMarketDataMode(env = process.env) {
  const mode = String(env.MARKET_DATA_MODE || 'LEGACY').trim().toUpperCase();
  if (!['LEGACY', UPSTOX_ONLY_MARKET_DATA_MODE].includes(mode)) {
    throw new Error('MARKET_DATA_MODE must be LEGACY or UPSTOX_ONLY.');
  }
  return mode === UPSTOX_ONLY_MARKET_DATA_MODE;
}

function productionRightsAllow(provider, urls, env = process.env, fixtureCapability = null) {
  return urls.every(url => isMarketDataProductionUseAllowed(provider, url, env, fixtureCapability));
}

// Preserve every source used to qualify a durable history snapshot. A missing
// URL remains explicit so storage can fail closed instead of forgetting a
// calendar, identity, or publication dependency.
function qualificationSourceEntries(source, provider) {
  const urls = [source?.url, ...(Array.isArray(source?.requestUrls) ? source.requestUrls : [])];
  return [...new Set(urls.length ? urls : [null])].map(url => ({
    provider: source?.provider || provider,
    url: url || null,
  }));
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

function upstoxMarketContextRightsAllowed(env = process.env, fixtureCapability = null) {
  const endpoints = [UPSTOX_QUOTE_RIGHTS_URL, UPSTOX_HISTORICAL_CANDLE_V3_RIGHTS_URL];
  if (isUpstoxOnlyMarketDataMode(env)) {
    endpoints.push(UPSTOX_TRADING_HOLIDAYS_URL, UPSTOX_NSE_MARKET_STATUS_URL,
      UPSTOX_MARKET_TIMINGS_RIGHTS_URL);
  }
  return isUpstoxPublicDistributionAllowed(env)
    && productionRightsAllow(PROVIDERS.UPSTOX, endpoints, env, fixtureCapability);
}

function normalizeEquityIdentity({ exchange, symbol, isin } = {}) {
  const normalizedExchange = String(exchange || '').trim().toUpperCase();
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const normalizedIsin = String(isin || '').trim().toUpperCase();
  if (!['NSE', 'BSE'].includes(normalizedExchange)) throw new TypeError('exchange must be NSE or BSE.');
  if (!/^[A-Z0-9][A-Z0-9&-]{0,29}$/.test(normalizedSymbol)) throw new TypeError('symbol is invalid.');
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(normalizedIsin)) throw new TypeError('isin must be a 12-character ISIN.');
  return { exchange: normalizedExchange, symbol: normalizedSymbol, isin: normalizedIsin };
}

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

function qualifyUpstoxCalendarCoverage(snapshot, calendarSnapshot, { fromDate, toDate, now = new Date() } = {}) {
  const expectedDates = expectedUpstoxNseSessions(fromDate, toDate, calendarSnapshot, now);
  if (!expectedDates) {
    return { expectedDates: [], failureCode: calendarSnapshot?.error?.code || 'UPSTOX_TRADING_CALENDAR_UNAVAILABLE' };
  }
  if (expectedDates.length === 0) return { expectedDates, failureCode: 'NO_EXPECTED_NSE_TRADING_SESSIONS' };
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

export function qualifyUpstoxBenchmarkHistory(snapshot, calendarSnapshot, { now = new Date(), toDate } = {}) {
  const currentYear = isoDateInIndia(now)?.slice(0, 4);
  const fromDate = currentYear ? `${currentYear}-01-01` : null;
  const expectedDates = fromDate
    ? expectedUpstoxNseSessions(fromDate, toDate, calendarSnapshot, now) : null;
  const candles = Array.isArray(snapshot?.candles)
    ? snapshot.candles.filter(candle => {
      const date = isoDateInIndia(candle?.timestamp);
      return date && date >= fromDate && date <= toDate;
    }) : [];
  const candidate = { ...snapshot, candles };
  const observedDates = candles.map(candle => isoDateInIndia(candle.timestamp));
  const failureCode = !expectedDates
    ? calendarSnapshot?.error?.code || 'UPSTOX_BENCHMARK_CALENDAR_UNAVAILABLE'
    : expectedDates.length < 50
      ? 'UPSTOX_BENCHMARK_SESSION_COVERAGE_INSUFFICIENT'
      : !isQualifiedUpstoxDailyHistory(candidate, {
        instrumentKey: NIFTY_50_INSTRUMENT_KEY, fromDate, toDate,
      }) || observedDates.length !== expectedDates.length
        || observedDates.some((date, index) => date !== expectedDates[index])
        ? 'UPSTOX_BENCHMARK_SESSION_COVERAGE_INCOMPLETE' : null;
  if (failureCode) {
    return {
      ...snapshot, status: AVAILABILITY.SOURCE_ERROR, candles: [], candleCount: 0,
      calendar: calendarSnapshot,
      error: { code: failureCode }, reasonCodes: [failureCode],
    };
  }
  return {
    ...snapshot, candles, candleCount: candles.length,
    calendar: calendarSnapshot,
    coverage: {
      status: 'COMPLETE_FOR_UPSTOX_CURRENT_YEAR_NSE_CALENDAR',
      fromDate, toDate,
      expectedSessionCount: expectedDates.length,
      observedSessionCount: candles.length,
      calendarProvider: PROVIDERS.UPSTOX,
      calendarFetchedAt: calendarSnapshot.fetchedAt,
    },
  };
}

function unavailableEquityHistory({ request, reasonCode, primarySnapshot = null, providerStatus = null } = {}) {
  return {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    status: AVAILABILITY.UNAVAILABLE,
    canonicalProductId: `market:equity:${request.exchange.toLowerCase()}:${request.isin}`,
    instrumentIdentity: { exchange: request.exchange, tradingSymbol: request.symbol, isin: request.isin },
    interval: '1 day',
    dataClass: null,
    priceBasis: null,
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
      primaryProvider: PROVIDERS.UPSTOX,
      selectedProvider: null,
      primaryFailureCode: primarySnapshot ? providerFailureCode(primarySnapshot) : null,
      reasonCode,
    },
    providerPublicationStatus: providerStatus?.publication ?? null,
    reasonCodes: [reasonCode],
  };
}

/** Read-only Upstox daily equity history; no cross-provider fallback. */
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
  nseCalendarProvider = nseHistoryProvider,
  upstoxCalendarProviderOverride = upstoxCalendarProvider,
  env = process.env,
  clock = () => new Date(),
  marketDataTestFixtureRightsCapability = null,
} = {}) {
  const normalizedIdentity = normalizeEquityIdentity({ exchange, symbol, isin });
  const from = requireHistoryDate(fromDate, 'fromDate');
  const to = requireHistoryDate(toDate, 'toDate');
  if (from > to) throw new RangeError('fromDate must not be after toDate.');
  const normalizedBasis = String(basis).trim().toUpperCase();
  if (normalizedBasis !== 'RAW') throw new TypeError('basis must be RAW.');
  const spanDays = (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000 + 1;
  if (spanDays > 366) throw new RangeError('Equity history is limited to 366 calendar days per request.');
  const request = { ...normalizedIdentity, fromDate: from, toDate: to, basis: normalizedBasis };
  const canonicalProductId = `market:equity:${request.exchange.toLowerCase()}:${request.isin}`;
  const upstoxInstrumentKey = `${request.exchange}_EQ|${request.isin}`;
  const upstoxOnlyMode = isUpstoxOnlyMarketDataMode(env);
  if (request.exchange === 'NSE'
      && !(upstoxOnlyMode
        ? productionRightsAllow(PROVIDERS.UPSTOX, [UPSTOX_TRADING_HOLIDAYS_URL], env, marketDataTestFixtureRightsCapability)
        : productionRightsAllow(PROVIDERS.NSE, [NSE_TRADING_HOLIDAY_URL], env, marketDataTestFixtureRightsCapability))) {
    return unavailableEquityHistory({
      request,
      reasonCode: 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED',
    });
  }
  let calendarPromise = null;
  const loadCalendar = () => {
    if (!calendarPromise) {
      calendarPromise = Promise.resolve()
        .then(() => upstoxOnlyMode
          ? upstoxCalendarProviderOverride.getCalendar({ fromDate: from, toDate: to, forceRefresh: false })
          : nseCalendarProvider.holidayLoader({ forceRefresh: false }))
        .catch(() => null);
    }
    return calendarPromise;
  };

  let primarySnapshot = null;
  if (normalizedBasis === 'RAW') {
    if (!productionRightsAllow(PROVIDERS.UPSTOX, [UPSTOX_HISTORICAL_CANDLE_V3_RIGHTS_URL], env, marketDataTestFixtureRightsCapability)) {
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
        const calendarSnapshot = await loadCalendar();
        const coverage = upstoxOnlyMode
          ? qualifyUpstoxCalendarCoverage(primarySnapshot, calendarSnapshot, { fromDate: from, toDate: to, now: clock() })
          : qualifyUpstoxNseSessionCoverage(primarySnapshot, calendarSnapshot, { fromDate: from, toDate: to, now: clock() });
        if (!coverage.failureCode) {
          return {
            ...primarySnapshot,
            canonicalProductId,
            // The Upstox candle key identifies the ISIN, but does not verify
            // the caller's trading symbol. Keep the requested label separate.
            instrumentIdentity: {
              exchange: request.exchange,
              symbol: null,
              isin: request.isin,
              requestedSymbol: request.symbol,
              symbolBindingStatus: 'UNVERIFIED',
            },
            provider: PROVIDERS.UPSTOX,
            dataClass: 'HISTORICAL_DAILY',
            priceBasis: 'UPSTOX_PROVIDER_NATIVE',
            qualificationSourceUrls: [
              ...qualificationSourceEntries(primarySnapshot.source, PROVIDERS.UPSTOX),
              ...qualificationSourceEntries(calendarSnapshot.source,
                upstoxOnlyMode ? PROVIDERS.UPSTOX : PROVIDERS.NSE),
            ],
            fallbackUsed: false,
            coverage: {
              status: upstoxOnlyMode ? 'COMPLETE_FOR_UPSTOX_NSE_CALENDAR' : 'COMPLETE_FOR_NSE_WEEKDAY_HOLIDAY_CALENDAR',
              expectedSessionCount: coverage.expectedDates.length,
              observedSessionCount: primarySnapshot.candles.length,
              calendarProvider: upstoxOnlyMode ? PROVIDERS.UPSTOX : PROVIDERS.NSE,
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

  return unavailableEquityHistory({
    request,
    reasonCode: providerFailureCode(primarySnapshot),
    primarySnapshot,
  });
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
  const provider = isUpstoxOnlyMarketDataMode(env) ? 'UPSTOX' : PRIMARY_MARKET_PROVIDER;
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
  if (provider === 'UPSTOX' && isUpstoxOnlyMarketDataMode(env)
      && snapshot.status === AVAILABILITY.AVAILABLE) {
    const session = await upstoxCalendarProvider.getCurrentSession({ forceRefresh });
    snapshot = { ...snapshot, marketSession: session, calendar: session.calendar ?? null };
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
  marketDataTestFixtureRightsCapability = null,
} = {}) {
  const identities = resolveUpstoxQuoteIdentities(canonicalProductIds);
  const quoteRequestUrl = buildUpstoxQuoteRequestUrl(identities.map(identity => identity.upstoxInstrumentKey));
  const rightsAllowed = productionRightsAllow(
    PROVIDERS.UPSTOX, [quoteRequestUrl], env, marketDataTestFixtureRightsCapability,
  );
  const snapshot = rightsAllowed
    && isUpstoxPublicDistributionAllowed(env)
    ? await upstoxMarketDataProvider.getQuotes(
      identities.map(identity => identity.upstoxInstrumentKey),
      { forceRefresh },
    )
    : !rightsAllowed
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
      quoteLastTradeAt: sourceFact?.quoteLastTradeAt ?? null,
      quoteResponseGeneratedAt: sourceFact?.quoteResponseGeneratedAt ?? null,
      providerResponseReceivedAt: sourceFact?.providerResponseReceivedAt ?? null,
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

/**
 * Ephemeral, authenticated loopback demonstration only. The per-request
 * capability is minted by the guarded demo route; provider request caches and
 * durable snapshot persistence are bypassed, and no recommendation consumes
 * this response.
 */
export async function fetchPrivateMarketDemoData({
  privateDemoCapability,
  env = process.env,
  now = new Date(),
  quoteProviderFactory = options => new UpstoxMarketDataProvider(options),
} = {}) {
  const identities = resolveUpstoxQuoteIdentities([
    ...DEFAULT_BENCHMARK_IDS,
    'etf:isin:INF204KB14I2',
  ]);
  const instrumentKeys = identities.map(identity => identity.upstoxInstrumentKey);
  const quoteUrl = buildUpstoxQuoteRequestUrl(instrumentKeys);
  if (!isMarketDataPrivateDemoUseAllowed(PROVIDERS.UPSTOX, quoteUrl, env, privateDemoCapability)) {
    const error = new Error('Private market-data demo is not enabled for this authenticated loopback request.');
    error.code = 'PRIVATE_MARKET_DEMO_DISABLED';
    throw error;
  }

  const noStoreRequest = async ({ loader }) => loader();
  const quoteProvider = quoteProviderFactory({ env, requestCache: noStoreRequest });
  const providerSnapshot = await quoteProvider.getQuotes(instrumentKeys, {
    forceRefresh: true,
    privateDemoCapability,
  });
  const identitiesByKey = new Map(identities.map(identity => [identity.upstoxInstrumentKey, identity]));
  const upstox = {
    ...providerSnapshot,
    facts: (providerSnapshot.facts || []).map(fact => {
      const identity = identitiesByKey.get(fact.source?.instrumentId);
      return identity ? {
        ...fact,
        canonicalProductId: identity.canonicalProductId,
        displayName: identity.displayName,
        instrumentIdentity: {
          exchange: identity.exchange,
          isin: identity.isin,
          tradingSymbol: identity.tradingSymbol,
          registryRevision: UPSTOX_INSTRUMENT_REGISTRY_REVISION,
        },
      } : fact;
    }),
  };

  return {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    status: [AVAILABILITY.AVAILABLE, AVAILABILITY.PARTIAL].includes(upstox.status)
      ? upstox.status : AVAILABILITY.UNAVAILABLE,
    mode: 'AUTHENTICATED_LOOPBACK_PRIVATE_DEMO',
    fetchedAt: now.toISOString(),
    persistence: 'NOT_PERSISTED',
    upstox: {
      ...upstox,
      cache: { hit: false, backend: 'NONE', status: 'PRIVATE_DEMO_NO_STORE' },
    },
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
  const providerName = isUpstoxOnlyMarketDataMode(env) ? 'UPSTOX' : PRIMARY_MARKET_PROVIDER;
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
  upstoxCalendarProviderOverride = upstoxCalendarProvider,
  nseQuoteProvider = nseProvider,
  nseHistoryProviderOverride = nseHistoryProvider,
  marketDataTestFixtureRightsCapability = null,
} = {}) {
  const window = buildNiftyHistoryWindow(now);
  const upstoxOnlyMode = isUpstoxOnlyMarketDataMode(env);
  const providerPairs = [
    ...(!upstoxOnlyMode && productionRightsAllow(PROVIDERS.NSE, [
      NSE_ALL_INDICES_URL,
      NSE_HISTORICAL_INDEX_RIGHTS_URL,
      NSE_TRADING_HOLIDAY_URL,
    ], env, marketDataTestFixtureRightsCapability) ? [{
      name: 'NSE',
      fetchQuotes: () => nseQuoteProvider.getQuotes(DEFAULT_BENCHMARK_IDS, { forceRefresh: forceQuoteRefresh }),
      fetchHistory: () => nseHistoryProviderOverride.getDailyCandles(MARKET_BENCHMARKS.NIFTY_50.canonicalProductId, {
        ...window,
        forceRefresh: forceHistoryRefresh,
      }),
    }] : []),
  ];
  if (upstoxMarketContextRightsAllowed(env, marketDataTestFixtureRightsCapability)) {
    providerPairs.push({
      name: 'UPSTOX',
      fetchQuotes: async () => {
        const quoteSnapshot = await upstoxQuoteProvider.getQuotes(DEFAULT_BENCHMARK_INSTRUMENT_KEYS, {
          forceRefresh: forceQuoteRefresh,
        });
        if (!upstoxOnlyMode) return quoteSnapshot;
        if (quoteSnapshot?.status !== AVAILABILITY.AVAILABLE) {
          return { ...quoteSnapshot, marketSession: { status: 'UNKNOWN', tradingDate: null } };
        }
        const session = await upstoxCalendarProviderOverride.getCurrentSession({ forceRefresh: forceQuoteRefresh });
        return { ...quoteSnapshot, marketSession: session, calendar: session.calendar ?? null };
      },
      fetchHistory: async () => {
        const history = await upstoxHistoryProviderOverride.getDailyCandles(NIFTY_50_INSTRUMENT_KEY, {
          ...window,
          forceRefresh: forceHistoryRefresh,
        });
        if (!upstoxOnlyMode || history?.status !== AVAILABILITY.AVAILABLE) return history;
        const currentYear = isoDateInIndia(now)?.slice(0, 4);
        const fromDate = `${currentYear}-01-01`;
        if (window.toDate < fromDate) {
          return qualifyUpstoxBenchmarkHistory(history, {
            status: AVAILABILITY.UNAVAILABLE,
            error: { code: 'UPSTOX_CALENDAR_RANGE_NOT_COVERED' },
          }, { now, toDate: window.toDate });
        }
        const calendar = await upstoxCalendarProviderOverride.getCalendar({
          fromDate,
          toDate: window.toDate,
          forceRefresh: forceHistoryRefresh,
        });
        return qualifyUpstoxBenchmarkHistory(history, calendar, { now, toDate: window.toDate });
      },
    });
  }
  if (providerPairs.length === 0) {
    const provider = upstoxOnlyMode || PRIMARY_MARKET_PROVIDER === 'UPSTOX' ? PROVIDERS.UPSTOX : PROVIDERS.NSE;
    const url = provider === PROVIDERS.UPSTOX ? UPSTOX_QUOTE_URL : NSE_ALL_INDICES_URL;
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
    preferredProvider: upstoxOnlyMode ? 'UPSTOX' : PRIMARY_MARKET_PROVIDER,
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
    availableFactCount: snapshot.availableFactCount ?? null,
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
    primaryMarketProvider: isUpstoxOnlyMarketDataMode(options.env || process.env) ? 'UPSTOX' : PRIMARY_MARKET_PROVIDER,
    benchmarks: market.facts || [],
  };
}
