import MarketDataProvider from './MarketDataProvider.js';
import { AVAILABILITY, MARKET_DATA_SCHEMA_VERSION, PROVIDERS } from './contracts.js';
import { isoDateInIndia } from './indiaMarketTime.js';
import { readThroughMarketCache } from './requestCache.js';
import { classifyUpstoxError, safeUpstoxError } from './upstoxErrors.js';
import { resolveUpstoxAccessToken } from './upstoxCredentials.js';
import { getUpstoxWithRetry } from './upstoxRequestPolicy.js';
import { isMarketDataProductionUseAllowed } from './marketDataRights.js';
import {
  UPSTOX_TRADING_HOLIDAYS_URL,
  UPSTOX_NSE_MARKET_STATUS_URL,
  UPSTOX_MARKET_TIMINGS_RIGHTS_URL,
} from './marketDataSourceUrls.js';

export { UPSTOX_TRADING_HOLIDAYS_URL };
export const UPSTOX_TRADING_CALENDAR_TTL_SECONDS = 60 * 60;
export const UPSTOX_MARKET_SESSION_TTL_SECONDS = 30;
// Provider last_updated is source evidence, not a cache or fetch timestamp. Upstox
// does not document a heartbeat cadence, so an older phase cannot establish the
// current session even when its trading date is today.
export const UPSTOX_MARKET_SESSION_MAX_STATUS_AGE_MS = 5 * 60 * 1000;

const UPSTOX_CAS_PHASES = new Set([
  'NORMAL_OPEN', 'NORMAL_CLOSE', 'PRE_OPEN_START', 'PRE_OPEN_END',
  'CLOSING_START', 'CLOSING_END', 'CTS_CLOSE', 'CAS_LM_START',
  'CAS_M_STOP', 'CAS_STOP',
]);

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** The annual endpoint is documented for the current year only. */
export function parseUpstoxTradingCalendar(payload, { year, fetchedAt } = {}) {
  if (payload?.status !== 'success' || !Array.isArray(payload.data) || payload.data.length === 0) {
    throw new Error('UPSTOX_CALENDAR_SCHEMA_INVALID');
  }
  const holidayDates = [];
  const specialTradingDates = [];
  const specialSessionTimes = [];
  const seen = new Set();
  for (const row of payload.data) {
    if (!validDate(row?.date) || !row.date.startsWith(`${year}-`) || seen.has(row.date)
        || !['SETTLEMENT_HOLIDAY', 'TRADING_HOLIDAY', 'SPECIAL_TIMING'].includes(row.holiday_type)
        || !Array.isArray(row.closed_exchanges) || !Array.isArray(row.open_exchanges)
        || row.closed_exchanges.some(exchange => typeof exchange !== 'string')
        || row.open_exchanges.some(exchange => typeof exchange?.exchange !== 'string'
          || !Number.isSafeInteger(exchange.start_time)
          || !Number.isSafeInteger(exchange.end_time)
          || exchange.start_time >= exchange.end_time
          || isoDateInIndia(new Date(exchange.start_time)) !== row.date
          || isoDateInIndia(new Date(exchange.end_time)) !== row.date)) {
      throw new Error('UPSTOX_CALENDAR_SCHEMA_INVALID');
    }
    seen.add(row.date);
    const nseOpen = row.open_exchanges.some(exchange => exchange.exchange === 'NSE');
    const nseClosed = row.closed_exchanges.includes('NSE');
    if (nseOpen && nseClosed) throw new Error('UPSTOX_CALENDAR_CONFLICTING_NSE_SESSION');
    if (nseClosed) holidayDates.push(row.date);
    if (nseOpen) {
      const nseWindow = row.open_exchanges.find(exchange => exchange.exchange === 'NSE');
      if (row.open_exchanges.filter(exchange => exchange.exchange === 'NSE').length !== 1) {
        throw new Error('UPSTOX_CALENDAR_CONFLICTING_NSE_SESSION');
      }
      specialTradingDates.push(row.date);
      specialSessionTimes.push({ date: row.date, startTime: nseWindow.start_time,
        endTime: nseWindow.end_time });
    }
  }
  if (holidayDates.length === 0 && specialTradingDates.length === 0) {
    throw new Error('UPSTOX_CALENDAR_NSE_COVERAGE_UNVERIFIED');
  }
  return {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    provider: PROVIDERS.UPSTOX,
    status: AVAILABILITY.AVAILABLE,
    year: String(year),
    fetchedAt,
    holidayDates: holidayDates.sort(),
    specialTradingDates: specialTradingDates.sort(),
    specialSessionTimes: specialSessionTimes.sort((a, b) => a.date.localeCompare(b.date)),
    source: { provider: PROVIDERS.UPSTOX, url: UPSTOX_TRADING_HOLIDAYS_URL },
  };
}

export function expectedUpstoxNseSessions(fromDate, toDate, calendar, now = new Date()) {
  const fetchedMs = Date.parse(calendar?.fetchedAt);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (calendar?.status !== AVAILABILITY.AVAILABLE || calendar.provider !== PROVIDERS.UPSTOX
      || !validDate(fromDate) || !validDate(toDate) || fromDate > toDate
      || fromDate.slice(0, 4) !== calendar.year || toDate.slice(0, 4) !== calendar.year
      || calendar.year !== isoDateInIndia(now)?.slice(0, 4)
      || calendar.source?.provider !== PROVIDERS.UPSTOX
      || calendar.source?.url !== UPSTOX_TRADING_HOLIDAYS_URL
      || !Number.isFinite(fetchedMs) || !Number.isFinite(nowMs)
      || fetchedMs > nowMs || nowMs - fetchedMs > UPSTOX_TRADING_CALENDAR_TTL_SECONDS * 1000
      || !Array.isArray(calendar.holidayDates) || !Array.isArray(calendar.specialTradingDates)
      || !Array.isArray(calendar.specialSessionTimes)
      || calendar.holidayDates.length + calendar.specialTradingDates.length === 0
      || [...calendar.holidayDates, ...calendar.specialTradingDates].some(date => !validDate(date) || !date.startsWith(`${calendar.year}-`))
      || calendar.specialSessionTimes.length !== calendar.specialTradingDates.length
      || calendar.specialSessionTimes.some(window => !calendar.specialTradingDates.includes(window.date)
        || !Number.isSafeInteger(window.startTime) || !Number.isSafeInteger(window.endTime)
        || window.startTime >= window.endTime
        || isoDateInIndia(new Date(window.startTime)) !== window.date
        || isoDateInIndia(new Date(window.endTime)) !== window.date)) return null;
  const closed = new Set(calendar.holidayDates);
  const open = new Set(calendar.specialTradingDates);
  if ([...closed].some(date => open.has(date))) return null;
  const dates = [];
  const cursor = new Date(`${fromDate}T00:00:00.000Z`);
  const end = Date.parse(`${toDate}T00:00:00.000Z`);
  while (cursor.getTime() <= end) {
    const date = cursor.toISOString().slice(0, 10);
    const weekday = cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6;
    if (open.has(date) || (weekday && !closed.has(date))) dates.push(date);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function classifyCurrentSession(statusPayload, timingPayload, tradingDate, now, calendar) {
  const status = statusPayload?.data;
  const timingRows = timingPayload?.data;
  const nseTimings = Array.isArray(timingRows)
    ? timingRows.filter(row => row?.exchange === 'NSE') : [];
  const updatedAt = status?.last_updated;
  const cas = status?.cas_eligible_status;
  const timing = nseTimings[0];
  if (statusPayload?.status !== 'success' || timingPayload?.status !== 'success'
      || status?.exchange !== 'NSE'
      || !['NORMAL_OPEN', 'NORMAL_CLOSE', 'PRE_OPEN_START', 'PRE_OPEN_END',
        'CLOSING_START', 'CLOSING_END'].includes(status?.status)
      || !Number.isSafeInteger(updatedAt) || updatedAt > now.getTime()
      || isoDateInIndia(new Date(updatedAt)) !== tradingDate
      || (cas !== undefined && (!cas || !UPSTOX_CAS_PHASES.has(cas.status)
        || !Number.isSafeInteger(cas.last_updated)
        || cas.last_updated > now.getTime()
        || isoDateInIndia(new Date(cas.last_updated)) !== tradingDate))
      || nseTimings.length !== 1
      || !Number.isSafeInteger(timing.start_time) || !Number.isSafeInteger(timing.end_time)
      || timing.start_time >= timing.end_time
      || isoDateInIndia(new Date(timing.start_time)) !== tradingDate
      || isoDateInIndia(new Date(timing.end_time)) !== tradingDate) {
    throw new Error('UPSTOX_SESSION_SCHEMA_INVALID');
  }
  const specialWindow = calendar.specialSessionTimes.find(window => window.date === tradingDate);
  if (specialWindow && (specialWindow.startTime !== timing.start_time
      || specialWindow.endTime !== timing.end_time)) {
    throw new Error('UPSTOX_SESSION_SPECIAL_TIMING_CONFLICT');
  }
  const within = now.getTime() >= timing.start_time && now.getTime() <= timing.end_time;
  const sessionStatus = status.status === 'NORMAL_OPEN' && within
    && (!cas || cas.status === 'NORMAL_OPEN')
    ? 'MARKET_OPEN'
    : ['NORMAL_CLOSE', 'CLOSING_END'].includes(status.status) && now.getTime() > timing.end_time
      && (!cas || ['NORMAL_CLOSE', 'CLOSING_END'].includes(cas.status))
      ? 'MARKET_CLOSED' : 'UNKNOWN';
  return {
    status: sessionStatus,
    phase: status.status,
    casPhase: cas?.status ?? null,
    casObservedAt: cas ? new Date(cas.last_updated).toISOString() : null,
    tradingDate,
    observedAt: new Date(updatedAt).toISOString(),
    sessionWindow: {
      startAt: new Date(timing.start_time).toISOString(),
      endAt: new Date(timing.end_time).toISOString(),
    },
    source: {
      provider: PROVIDERS.UPSTOX,
      url: UPSTOX_NSE_MARKET_STATUS_URL,
      requestUrls: [UPSTOX_NSE_MARKET_STATUS_URL,
        UPSTOX_MARKET_TIMINGS_RIGHTS_URL.replace('{date}', tradingDate)],
    },
  };
}

function requalifyCurrentSession(session, now, tradingDate) {
  if (session?.status === 'UNKNOWN') return session;
  const observedAt = Date.parse(session?.observedAt);
  const casObservedAt = session?.casPhase == null ? null : Date.parse(session.casObservedAt);
  const startAt = Date.parse(session?.sessionWindow?.startAt);
  const endAt = Date.parse(session?.sessionWindow?.endAt);
  const nowMs = now.getTime();
  const validEvidence = ['MARKET_OPEN', 'MARKET_CLOSED'].includes(session?.status)
    && session?.source?.provider === PROVIDERS.UPSTOX
    && session?.source?.url === UPSTOX_NSE_MARKET_STATUS_URL
    && session?.tradingDate === tradingDate
    && Number.isFinite(observedAt) && observedAt <= nowMs
    && isoDateInIndia(new Date(observedAt)) === tradingDate
    && nowMs - observedAt <= UPSTOX_MARKET_SESSION_MAX_STATUS_AGE_MS
    && (session.casPhase == null || (Number.isFinite(casObservedAt)
      && casObservedAt <= nowMs
      && isoDateInIndia(new Date(casObservedAt)) === tradingDate
      && nowMs - casObservedAt <= UPSTOX_MARKET_SESSION_MAX_STATUS_AGE_MS))
    && Number.isFinite(startAt) && Number.isFinite(endAt) && startAt < endAt
    && isoDateInIndia(new Date(startAt)) === tradingDate
    && isoDateInIndia(new Date(endAt)) === tradingDate;
  if (!validEvidence) return {
    ...session, status: 'UNKNOWN', error: { code: 'UPSTOX_SESSION_STATUS_STALE_OR_INVALID' },
  };
  if (session.status === 'MARKET_OPEN'
      && (session.phase !== 'NORMAL_OPEN'
        || (session.casPhase != null && session.casPhase !== 'NORMAL_OPEN')
        || nowMs < startAt || nowMs > endAt)) return {
    ...session, status: 'UNKNOWN', error: { code: 'UPSTOX_SESSION_TIMING_CONFLICT' },
  };
  if (session.status === 'MARKET_CLOSED'
      && (!['NORMAL_CLOSE', 'CLOSING_END'].includes(session.phase)
        || (session.casPhase != null && !['NORMAL_CLOSE', 'CLOSING_END'].includes(session.casPhase))
        || nowMs <= endAt)) return {
    ...session, status: 'UNKNOWN', error: { code: 'UPSTOX_SESSION_TIMING_CONFLICT' },
  };
  return session;
}

export default class UpstoxTradingCalendarProvider extends MarketDataProvider {
  constructor({ accessToken = undefined, env = process.env,
    requestCache = readThroughMarketCache, ...options } = {}) {
    super({ providerName: PROVIDERS.UPSTOX, env, ...options });
    this.accessToken = String(accessToken ?? resolveUpstoxAccessToken(env)).trim();
    this.env = env;
    this.requestCache = requestCache;
  }

  async getCalendar({ fromDate, toDate, forceRefresh = false } = {}) {
    if (!validDate(fromDate) || !validDate(toDate) || fromDate > toDate) {
      throw new TypeError('A valid ascending calendar date range is required.');
    }
    const now = this.clock();
    const year = isoDateInIndia(now)?.slice(0, 4);
    const unavailable = code => ({
      schemaVersion: MARKET_DATA_SCHEMA_VERSION,
      provider: PROVIDERS.UPSTOX,
      status: AVAILABILITY.UNAVAILABLE,
      year: year || null,
      fetchedAt: this.nowIso(),
      holidayDates: [],
      specialTradingDates: [],
      error: { code },
    });
    if (fromDate.slice(0, 4) !== year || toDate.slice(0, 4) !== year) {
      return unavailable('UPSTOX_CALENDAR_RANGE_NOT_COVERED');
    }
    if (!isMarketDataProductionUseAllowed(PROVIDERS.UPSTOX, UPSTOX_TRADING_HOLIDAYS_URL,
      this.env, this.marketDataTestFixtureRightsCapability)) {
      return unavailable('MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
    }
    if (!this.accessToken) return unavailable('PROVIDER_NOT_CONFIGURED');
    return this.requestCache({
      cacheKey: `market:upstox:trading-calendar:${MARKET_DATA_SCHEMA_VERSION}:${year}`,
      ttlSeconds: UPSTOX_TRADING_CALENDAR_TTL_SECONDS,
      forceRefresh,
      loader: async () => {
        const fetchedAt = this.nowIso();
        try {
          const response = await getUpstoxWithRetry(this.httpClient, UPSTOX_TRADING_HOLIDAYS_URL, {
            timeout: 10_000,
            headers: { Accept: 'application/json', Authorization: `Bearer ${this.accessToken}` },
          });
          return parseUpstoxTradingCalendar(response.data, { year, fetchedAt });
        } catch (error) {
          return {
            ...unavailable(classifyUpstoxError(error)),
            status: AVAILABILITY.SOURCE_ERROR,
            fetchedAt,
            error: safeUpstoxError(classifyUpstoxError(error)),
          };
        }
      },
    });
  }

  async getCurrentSession({ forceRefresh = false } = {}) {
    const now = this.clock();
    const tradingDate = isoDateInIndia(now);
    const timingUrl = UPSTOX_MARKET_TIMINGS_RIGHTS_URL.replace('{date}', tradingDate || 'invalid');
    const unknown = code => ({
      status: 'UNKNOWN', tradingDate, phase: null, observedAt: null,
      source: null, calendar: null, error: { code },
    });
    if (!tradingDate || ![
      UPSTOX_TRADING_HOLIDAYS_URL,
      UPSTOX_NSE_MARKET_STATUS_URL,
      timingUrl,
    ].every(url => isMarketDataProductionUseAllowed(PROVIDERS.UPSTOX, url,
      this.env, this.marketDataTestFixtureRightsCapability))) {
      return unknown('MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
    }
    if (!this.accessToken) return unknown('PROVIDER_NOT_CONFIGURED');
    const calendar = await this.getCalendar({ fromDate: tradingDate, toDate: tradingDate, forceRefresh });
    const sessions = expectedUpstoxNseSessions(tradingDate, tradingDate, calendar, now);
    if (!sessions) return unknown(calendar?.error?.code || 'UPSTOX_TRADING_CALENDAR_UNAVAILABLE');
    if (sessions.length === 0) {
      return {
        status: calendar.holidayDates.includes(tradingDate) ? 'MARKET_HOLIDAY' : 'MARKET_CLOSED',
        tradingDate,
        phase: null,
        observedAt: calendar.fetchedAt,
        source: calendar.source,
        calendar,
      };
    }
    const session = await this.requestCache({
      cacheKey: `market:upstox:nse-session:${MARKET_DATA_SCHEMA_VERSION}:${tradingDate}`,
      ttlSeconds: UPSTOX_MARKET_SESSION_TTL_SECONDS,
      forceRefresh,
      shouldCache: session => session?.status !== 'UNKNOWN',
      loader: async () => {
        try {
          const headers = { Accept: 'application/json', Authorization: `Bearer ${this.accessToken}` };
          const [statusResponse, timingResponse] = await Promise.all([
            getUpstoxWithRetry(this.httpClient, UPSTOX_NSE_MARKET_STATUS_URL, { timeout: 10_000, headers }),
            getUpstoxWithRetry(this.httpClient, timingUrl, { timeout: 10_000, headers }),
          ]);
          return requalifyCurrentSession({
            ...classifyCurrentSession(statusResponse.data, timingResponse.data, tradingDate, this.clock(), calendar),
            calendar,
          }, this.clock(), tradingDate);
        } catch (error) {
          return {
            ...unknown(classifyUpstoxError(error)),
            error: safeUpstoxError(classifyUpstoxError(error)),
          };
        }
      },
    });
    // Cache TTL and cachedAt never refresh the provider's last_updated evidence.
    return requalifyCurrentSession(session, this.clock(), tradingDate);
  }
}
