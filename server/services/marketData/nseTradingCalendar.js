import {
  AVAILABILITY,
  FRESHNESS,
  MARKET_DATA_SCHEMA_VERSION,
  PROVIDERS,
  normalizeTimestamp,
} from './contracts.js';
import { getNseJson, safeNseHttpError } from './nseHttp.js';
import { indiaClockParts, isoDateInIndia } from './indiaMarketTime.js';
import { readThroughMarketCache } from './requestCache.js';
import { createMarketDataTestFixtureRightsCapability } from './marketDataTestFixtures.js';
import { buildMarketDataRightsUnavailableSnapshot, isMarketDataProductionUseAllowed } from './marketDataRights.js';
import { NSE_TRADING_HOLIDAY_URL } from './marketDataSourceUrls.js';

export { NSE_TRADING_HOLIDAY_URL };
export const NSE_TRADING_HOLIDAY_CACHE_TTL_SECONDS = 24 * 60 * 60;
export const NSE_QUOTE_MAX_AGE_SECONDS = 15 * 60;
export const NSE_DAILY_HISTORY_MAX_AGE_SECONDS = 4 * 24 * 60 * 60;

export const NSE_MARKET_SESSION = Object.freeze({
  OPEN: 'MARKET_OPEN',
  CLOSED: 'MARKET_CLOSED',
  HOLIDAY: 'MARKET_HOLIDAY',
  UNKNOWN: 'UNKNOWN',
});

const IST_OFFSET_MS = 330 * 60 * 1000;
const MONTHS = Object.freeze({
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
});

function pad(value) {
  return String(value).padStart(2, '0');
}

export function parseNseDate(value) {
  const match = String(value || '').trim().toUpperCase().match(/^(\d{2})-([A-Z]{3})-(\d{4})$/);
  if (!match || MONTHS[match[2]] === undefined) return null;
  const day = Number(match[1]);
  const month = MONTHS[match[2]];
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

export function parseNseMarketTimestamp(value) {
  const match = String(value || '').trim().toUpperCase().match(
    /^(\d{2})-([A-Z]{3})-(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!match || MONTHS[match[2]] === undefined) return null;
  const day = Number(match[1]);
  const month = MONTHS[match[2]];
  const year = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] || 0);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const utc = new Date(Date.UTC(year, month, day, hour, minute, second) - IST_OFFSET_MS);
  if (isoDateInIndia(utc) !== `${year}-${pad(month + 1)}-${pad(day)}`) return null;
  return utc.toISOString();
}

function shiftIsoDate(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function isNseTradingDay(isoDate, holidayDates = []) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate || ''))) return false;
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  const day = date.getUTCDay();
  return day !== 0 && day !== 6 && !new Set(holidayDates).has(isoDate);
}

export function previousNseTradingDate(isoDate, holidayDates = [], { includeDate = false } = {}) {
  let candidate = includeDate ? isoDate : shiftIsoDate(isoDate, -1);
  for (let attempts = 0; attempts < 20; attempts += 1) {
    if (isNseTradingDay(candidate, holidayDates)) return candidate;
    candidate = shiftIsoDate(candidate, -1);
  }
  return null;
}

function nextTradingSessionOpen(observedAt, holidayDates) {
  const observedDate = isoDateInIndia(observedAt);
  if (!observedDate) return null;
  let candidate = shiftIsoDate(observedDate, 1);
  for (let attempts = 0; attempts < 20; attempts += 1) {
    if (isNseTradingDay(candidate, holidayDates)) {
      return new Date(Date.parse(`${candidate}T03:45:00.000Z`));
    }
    candidate = shiftIsoDate(candidate, 1);
  }
  return null;
}

function sessionFor(nowParts, holidayDates) {
  if (!nowParts?.isoDate) {
    return { status: NSE_MARKET_SESSION.UNKNOWN, tradingDate: null };
  }
  if (new Set(holidayDates).has(nowParts.isoDate)) {
    return { status: NSE_MARKET_SESSION.HOLIDAY, tradingDate: nowParts.isoDate };
  }
  const minutes = nowParts.hour * 60 + nowParts.minute;
  const tradingDay = isNseTradingDay(nowParts.isoDate, holidayDates);
  return {
    status: tradingDay && minutes >= (9 * 60 + 15) && minutes <= (15 * 60 + 30)
      ? NSE_MARKET_SESSION.OPEN
      : NSE_MARKET_SESSION.CLOSED,
    tradingDate: nowParts.isoDate,
  };
}

export function evaluateNseQuoteFreshness({
  observedAt,
  fetchedAt,
  now = new Date(),
  holidayDates = [],
}) {
  const observed = normalizeTimestamp(observedAt);
  const fetched = normalizeTimestamp(fetchedAt);
  const reference = normalizeTimestamp(now);
  if (!observed || !fetched || !reference) {
    return {
      status: FRESHNESS.UNKNOWN,
      ageSeconds: null,
      maxAgeSeconds: NSE_QUOTE_MAX_AGE_SECONDS,
      marketSession: NSE_MARKET_SESSION.UNKNOWN,
      tradingDate: null,
    };
  }
  const nowParts = indiaClockParts(reference);
  const observedDate = isoDateInIndia(observed);
  const minutes = nowParts.hour * 60 + nowParts.minute;
  const tradingToday = isNseTradingDay(nowParts.isoDate, holidayDates);
  const marketOpen = tradingToday && minutes >= (9 * 60 + 15) && minutes <= (15 * 60 + 30);
  const session = sessionFor(nowParts, holidayDates);
  const expectedDate = tradingToday && minutes >= (9 * 60 + 15)
    ? nowParts.isoDate
    : previousNseTradingDate(nowParts.isoDate, holidayDates);
  const referenceMs = Date.parse(reference);
  const observedMs = Date.parse(observed);
  const fetchedMs = Date.parse(fetched);
  const hasFutureEvidence = observedMs > referenceMs || fetchedMs > referenceMs;
  const ageSeconds = Math.max(0, Math.floor((referenceMs - observedMs) / 1000));
  let maxAgeSeconds = NSE_QUOTE_MAX_AGE_SECONDS;
  if (!hasFutureEvidence && !marketOpen && observedDate === expectedDate) {
    const nextOpen = nextTradingSessionOpen(observed, holidayDates);
    if (nextOpen) {
      maxAgeSeconds = Math.max(
        NSE_QUOTE_MAX_AGE_SECONDS,
        Math.floor((nextOpen.getTime() - observedMs) / 1000) + NSE_QUOTE_MAX_AGE_SECONDS,
      );
    }
  }
  return {
    status: !hasFutureEvidence && observedDate === expectedDate && ageSeconds <= maxAgeSeconds
      ? FRESHNESS.FRESH
      : FRESHNESS.STALE,
    ageSeconds,
    maxAgeSeconds,
    marketSession: session.status,
    tradingDate: session.tradingDate,
  };
}

export function evaluateNseDailyHistoryFreshness({
  effectiveTradingDate,
  requestedToDate,
  observedAt,
  fetchedAt,
  now = new Date(),
  holidayDates = [],
}) {
  const observed = normalizeTimestamp(observedAt);
  const fetched = normalizeTimestamp(fetchedAt);
  const reference = normalizeTimestamp(now);
  const expectedDate = previousNseTradingDate(requestedToDate, holidayDates, { includeDate: true });
  if (!observed || !fetched || !reference || !expectedDate || !effectiveTradingDate) {
    return { status: FRESHNESS.UNKNOWN, ageSeconds: null, maxAgeSeconds: NSE_DAILY_HISTORY_MAX_AGE_SECONDS };
  }
  const referenceMs = Date.parse(reference);
  const observedMs = Date.parse(observed);
  const fetchedMs = Date.parse(fetched);
  const hasFutureEvidence = observedMs > referenceMs || fetchedMs > referenceMs;
  const ageSeconds = Math.max(0, Math.floor((referenceMs - observedMs) / 1000));
  return {
    status: !hasFutureEvidence && effectiveTradingDate === expectedDate ? FRESHNESS.FRESH : FRESHNESS.STALE,
    ageSeconds,
    maxAgeSeconds: !hasFutureEvidence && effectiveTradingDate === expectedDate
      ? Math.max(NSE_DAILY_HISTORY_MAX_AGE_SECONDS, ageSeconds)
      : NSE_DAILY_HISTORY_MAX_AGE_SECONDS,
  };
}

export function parseNseTradingHolidays(payload) {
  if (!payload || !Array.isArray(payload.CM)) {
    throw new Error('NSE_HOLIDAY_SCHEMA_MISMATCH:CM');
  }
  const dates = [];
  for (const [index, row] of payload.CM.entries()) {
    const date = parseNseDate(row?.tradingDate);
    if (!date) throw new Error(`NSE_HOLIDAY_SCHEMA_MISMATCH:CM[${index}].tradingDate`);
    dates.push(date);
  }
  return [...new Set(dates)].sort();
}

export function isUsableNseTradingCalendar(snapshot, now = new Date()) {
  const reference = normalizeTimestamp(now);
  const fetchedAt = normalizeTimestamp(snapshot?.fetchedAt);
  const nowParts = indiaClockParts(reference);
  const referenceMs = reference ? Date.parse(reference) : NaN;
  const fetchedMs = fetchedAt ? Date.parse(fetchedAt) : NaN;
  const dates = snapshot?.dates;
  if (snapshot?.schemaVersion !== MARKET_DATA_SCHEMA_VERSION
      || snapshot?.provider !== PROVIDERS.NSE
      || snapshot?.status !== AVAILABILITY.AVAILABLE
      || snapshot?.source?.provider !== PROVIDERS.NSE
      || snapshot?.source?.url !== NSE_TRADING_HOLIDAY_URL
      || !nowParts?.isoDate || !Number.isFinite(referenceMs) || !Number.isFinite(fetchedMs)
      || fetchedMs > referenceMs
      || referenceMs - fetchedMs > NSE_TRADING_HOLIDAY_CACHE_TTL_SECONDS * 1000
      || !Array.isArray(dates) || dates.length === 0) return false;

  const currentYear = nowParts.isoDate.slice(0, 4);
  return dates.every(date => {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const [yearText, monthText, dayText] = date.split('-');
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const parsed = new Date(0);
    parsed.setUTCHours(0, 0, 0, 0);
    parsed.setUTCFullYear(year, month - 1, day);
    return month >= 1 && month <= 12 && day >= 1
      && parsed.getUTCFullYear() === year
      && parsed.getUTCMonth() === month - 1
      && parsed.getUTCDate() === day;
  }) && dates.some(date => date.startsWith(`${currentYear}-`));
}

export async function fetchNseTradingHolidays({
  httpClient,
  clock = () => new Date(),
  forceRefresh = false,
  env = process.env,
  fixtureCapability = null,
} = {}) {
  if (!httpClient?.get) throw new TypeError('httpClient.get is required.');
  const testFixtureCapability = fixtureCapability
    || createMarketDataTestFixtureRightsCapability({ env, transport: httpClient });
  if (!isMarketDataProductionUseAllowed(PROVIDERS.NSE, NSE_TRADING_HOLIDAY_URL, env, testFixtureCapability)) {
    return {
      ...buildMarketDataRightsUnavailableSnapshot(PROVIDERS.NSE, NSE_TRADING_HOLIDAY_URL, { now: clock() }),
      dates: [],
    };
  }
  const year = indiaClockParts(clock())?.isoDate.slice(0, 4) || 'unknown';
  return readThroughMarketCache({
    cacheKey: `market:nse:trading-holidays:${MARKET_DATA_SCHEMA_VERSION}:${year}`,
    ttlSeconds: NSE_TRADING_HOLIDAY_CACHE_TTL_SECONDS,
    forceRefresh,
    loader: async () => {
      const fetchedAt = clock().toISOString();
      try {
        const response = await getNseJson(httpClient, NSE_TRADING_HOLIDAY_URL, {
          referer: 'https://www.nseindia.com/resources/exchange-communication-holidays',
        });
        return {
          schemaVersion: MARKET_DATA_SCHEMA_VERSION,
          provider: PROVIDERS.NSE,
          status: AVAILABILITY.AVAILABLE,
          fetchedAt,
          dates: parseNseTradingHolidays(response.data),
          source: { provider: PROVIDERS.NSE, url: NSE_TRADING_HOLIDAY_URL },
        };
      } catch (error) {
        return {
          schemaVersion: MARKET_DATA_SCHEMA_VERSION,
          provider: PROVIDERS.NSE,
          status: AVAILABILITY.SOURCE_ERROR,
          fetchedAt,
          dates: [],
          source: { provider: PROVIDERS.NSE, url: NSE_TRADING_HOLIDAY_URL },
          error: {
            code: 'NSE_HOLIDAY_FETCH_FAILED',
            message: safeNseHttpError(error, 'NSE trading-calendar request failed'),
          },
        };
      }
    },
  });
}
