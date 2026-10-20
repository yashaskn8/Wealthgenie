/**
 * WealthGenie Market Data Cron Jobs
 * Refreshes live market data on a schedule.
 *
 * - AMFI NAVs: current universe plus one bounded seven-day historical window daily
 * - Primary market context: batched benchmark quotes plus cached daily history
 */

import {
  fetchAmfiHistoricalNavSnapshot,
  fetchAmfiProductSnapshot,
  fetchQualifiedEquityHistory,
} from '../services/marketDataService.js';
import { persistQualifiedHistory, qualifiedHistoryStorageConfig } from '../services/marketData/QualifiedEquityHistoryStore.js';
import { isoDateInIndia } from '../services/marketData/indiaMarketTime.js';
import { marketEquityIdentityQuerySchema } from '../validation/schemas.js';
import { getLiveMarketContext } from '../services/marketContextService.js';
import { redisAvailable, redisClient, releaseCacheNX, setCacheNX } from '../config/redis.js';
import logger from '../utils/logger.js';
import crypto from 'node:crypto';

let activeJobStopper = null;

export const MARKET_CONTEXT_OPEN_REFRESH_MS = 8 * 60 * 1000;
export const MARKET_CONTEXT_CLOSED_REFRESH_MS = 30 * 60 * 1000;
export const MARKET_CONTEXT_HOLIDAY_REFRESH_MS = 2 * 60 * 60 * 1000;
export const AMFI_REFRESH_LOCK_TTL_SECONDS = 15 * 60;
export const MARKET_CONTEXT_REFRESH_LOCK_TTL_SECONDS = 5 * 60;
export const EQUITY_HISTORY_REFRESH_LOCK_TTL_SECONDS = 15 * 60;

const MARKET_REFRESH_LOCK_PREFIX = 'wealthgenie:market-refresh:';

export function marketDataRefreshJobsEnabled(value = process.env.MARKET_DATA_REFRESH_ENABLED) {
  return value !== 'false';
}

/** Explicit, bounded operator allowlist. A credential alone never activates ingestion. */
export function qualifiedEquityRefreshTargets(env = process.env) {
  if (!qualifiedHistoryStorageConfig(env).enabled) return [];
  if (!env.MARKET_EQUITY_HISTORY_TARGETS) return [];
  let parsed;
  try { parsed = JSON.parse(env.MARKET_EQUITY_HISTORY_TARGETS); } catch {
    throw new TypeError('MARKET_EQUITY_HISTORY_TARGETS must be valid JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length > 10) {
    throw new TypeError('MARKET_EQUITY_HISTORY_TARGETS must be an array of at most 10 instruments.');
  }
  const seen = new Set();
  return parsed.map(target => {
    if (!target || typeof target !== 'object' || Array.isArray(target)
        || Object.keys(target).some(key => !['exchange', 'symbol', 'isin', 'basis'].includes(key))) {
      throw new TypeError('MARKET_EQUITY_HISTORY_TARGETS contains an invalid instrument.');
    }
    const { value, error } = marketEquityIdentityQuerySchema.validate({
      exchange: target.exchange, symbol: target.symbol, isin: target.isin,
    });
    const basis = String(target.basis || 'RAW').trim().toUpperCase();
    if (error || basis !== 'RAW') {
      throw new TypeError('MARKET_EQUITY_HISTORY_TARGETS contains an invalid instrument.');
    }
    const identity = { ...value, basis };
    const key = `${identity.exchange}:${identity.isin}:${basis}`;
    if (seen.has(key)) throw new TypeError('MARKET_EQUITY_HISTORY_TARGETS contains a duplicate instrument.');
    seen.add(key);
    return identity;
  });
}

function safeIngestCode(value, fallback) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value)
    ? value : fallback;
}

/** One serial, rights-gated daily ingest window; failures cannot replace retained observations. */
export async function refreshQualifiedEquityHistoryTargets({
  env = process.env,
  now = new Date(),
  fetchHistory = fetchQualifiedEquityHistory,
  persistHistory = persistQualifiedHistory,
  log = logger,
} = {}) {
  const targets = qualifiedEquityRefreshTargets(env);
  if (!targets.length) return { status: 'DISABLED', attempted: 0, persisted: 0, failures: [] };
  const toDate = isoDateInIndia(now);
  if (!toDate) throw new TypeError('A valid refresh clock is required.');
  const from = new Date(`${toDate}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - 6);
  const fromDate = from.toISOString().slice(0, 10);
  let persisted = 0;
  const failures = [];
  for (const target of targets) {
    const request = { ...target, fromDate, toDate, forceRefresh: true };
    try {
      const snapshot = await fetchHistory(request, { env });
      if (snapshot?.status !== 'AVAILABLE') {
        failures.push({ provider: snapshot?.provider || null,
          code: safeIngestCode(snapshot?.selection?.reasonCode || snapshot?.error?.code,
            'MARKET_HISTORY_UNAVAILABLE') });
        continue;
      }
      const result = await persistHistory(snapshot, request, { env, now });
      if (result?.status === 'PERSISTED') persisted += 1;
      else failures.push({ provider: snapshot.provider,
        code: safeIngestCode(result?.code, 'MARKET_HISTORY_NOT_PERSISTED') });
    } catch {
      failures.push({ provider: null, code: 'MARKET_HISTORY_INGEST_FAILED' });
    }
  }
  const summary = { status: failures.length ? 'PARTIAL' : 'PERSISTED',
    attempted: targets.length, persisted, failures };
  if (failures.length) log.warn('Qualified equity history refresh incomplete', summary);
  else log.info('Qualified equity history refresh completed', summary);
  return summary;
}

/**
 * Run one scheduled refresh under a Redis lease. Redis is required by the
 * production server, so losing it after startup must skip the external
 * refresh rather than let every replica call AMFI/NSE independently. Local
 * development and tests retain the existing single-process behavior.
 */
export async function withMarketRefreshLease(
  jobName,
  fn,
  { ttlSeconds = AMFI_REFRESH_LOCK_TTL_SECONDS, token = `${process.pid}:${crypto.randomUUID()}` } = {},
) {
  if (typeof fn !== 'function') throw new TypeError('A refresh function is required');

  if (!redisAvailable || !redisClient) {
    if (process.env.NODE_ENV !== 'production') return fn();
    logger.warn(`${jobName}: distributed refresh lease unavailable; skipping refresh`);
    return null;
  }

  const key = `${MARKET_REFRESH_LOCK_PREFIX}${jobName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const acquired = await setCacheNX(key, token, ttlSeconds);
  if (!acquired) {
    logger.info(`${jobName}: refresh lease is held by another replica; skipping refresh`);
    return null;
  }

  try {
    return await fn();
  } finally {
    const released = await releaseCacheNX(key, token);
    if (!released) {
      logger.warn(`${jobName}: refresh lease was not released because ownership changed or Redis became unavailable`);
    }
  }
}

/**
 * Start all scheduled market data refresh jobs.
 * Call this once in server.js after DB and Redis are connected.
 */
export function startMarketDataRefreshJobs() {
  stopMarketDataRefreshJobs();
  if (!marketDataRefreshJobsEnabled()) {
    logger.info('Market data refresh jobs disabled by configuration');
    return () => undefined;
  }
  // Validate configuration before creating any timer, so a typo cannot leave
  // a partially scheduled refresh set running after startup rejects it.
  const equityTargets = qualifiedEquityRefreshTargets(process.env);
  const cancellations = [];
  // Daily AMFI NAV refresh at 23:30 IST (18:00 UTC)
  // AMFI publishes updated NAVs around 23:00 IST
  cancellations.push(scheduleJob('0 18 * * *', 'AMFI NAV Refresh', async () => {
    await withMarketRefreshLease('AMFI NAV Refresh', refreshAmfiSnapshots, {
      ttlSeconds: AMFI_REFRESH_LOCK_TTL_SECONDS,
    });
  }));

  // During an NSE session, refresh the batched quote set frequently enough to
  // keep a recommendation-age snapshot inside the 15-minute open-session
  // contract. Outside a session, the scheduler backs off; the provider's
  // calendar remains the authority for holidays and session status.
  cancellations.push(scheduleAdaptiveJob('Primary Market Context', async () => {
    return withMarketRefreshLease('Primary Market Context', async () => {
      const result = await getLiveMarketContext({ forceQuoteRefresh: true });
      logger.info('Primary market context refresh completed', {
        context: result.context || null,
        status: result.status,
        marketSession: result.marketSnapshot?.marketSession?.status || 'UNKNOWN',
        recommendationUsability: result.recommendationUsability?.status || 'NOT_USABLE',
      });
      return result;
    }, { ttlSeconds: MARKET_CONTEXT_REFRESH_LOCK_TTL_SECONDS });
  }));

  // Runs after the Indian market day. Source rights, complete session coverage,
  // and Mongo indexes are checked again by the fetch and persistence layers.
  if (equityTargets.length > 0) {
    cancellations.push(scheduleJob('30 17 * * *', 'Qualified Equity History', async () => {
      await withMarketRefreshLease('Qualified Equity History', refreshQualifiedEquityHistoryTargets, {
        ttlSeconds: EQUITY_HISTORY_REFRESH_LOCK_TTL_SECONDS,
      });
    }, { warmup: false }));
  }

  logger.info('Market data refresh jobs scheduled');
  activeJobStopper = () => cancellations.forEach(cancel => cancel());
  return activeJobStopper;
}

/**
 * Durable owner for complete AMFI current and historical snapshots. WTI reads
 * remain read-only; persistence failures here are explicitly observable.
 */
export async function refreshAmfiSnapshots({
  fetchCurrent = fetchAmfiProductSnapshot,
  fetchHistorical = fetchAmfiHistoricalNavSnapshot,
  log = logger,
} = {}) {
  const [current, historical] = await Promise.all([
    fetchCurrent({ forceRefresh: true }),
    fetchHistorical({ forceRefresh: true }),
  ]);
  const persistenceStatus = snapshot => snapshot?.persistence?.status || 'UNKNOWN';
  const details = {
    persistenceOwner: 'SCHEDULED_REFRESH',
    currentProductCount: current?.productCount ?? 0,
    currentStatus: current?.status || 'UNKNOWN',
    currentPersistenceStatus: persistenceStatus(current),
    historicalProductCount: historical?.productCount ?? 0,
    historicalStatus: historical?.status || 'UNKNOWN',
    historicalPersistenceStatus: persistenceStatus(historical),
  };
  const persistenceFailures = collectAmfiPersistenceFailures(current, historical);
  if (persistenceFailures.length > 0) {
    log.error('AMFI refresh completed without durable persistence', {
      ...details,
      persistenceFailures,
    });
  } else {
    log.info('AMFI refresh completed', details);
  }
  return { current, historical };
}

/** Return bounded, secret-free failures for AMFI snapshots that were usable but not durable. */
export function collectAmfiPersistenceFailures(current, historical) {
  return [['current', current], ['historical', historical]]
    .filter(([, snapshot]) => ['AVAILABLE', 'PARTIAL'].includes(snapshot?.status)
      && snapshot?.persistence?.status !== 'PERSISTED')
    .map(([snapshotKind, snapshot]) => ({
      snapshotKind,
      persistenceStatus: ['NOT_PERSISTED', 'NOT_REQUESTED', 'PERSISTENCE_ERROR', 'PERSISTENCE_UNAVAILABLE']
        .includes(snapshot?.persistence?.status)
        ? snapshot.persistence.status
        : 'UNKNOWN',
      ...(snapshot?.persistence?.error?.code === 'MARKET_PERSISTENCE_FAILED'
        ? { code: 'MARKET_PERSISTENCE_FAILED' }
        : {}),
    }));
}

export function stopMarketDataRefreshJobs() {
  activeJobStopper?.();
  activeJobStopper = null;
}

/**
 * Simple cron scheduler using setTimeout/setInterval.
 * Supports the cron shapes used by this app: "minute hour * * *" and "minute * / 2 * * *".
 */
function scheduleJob(cronExpr, name, fn, { warmup = true } = {}) {
  const { initialDelayMs, intervalMs } = getScheduleTiming(cronExpr);
  let interval = null;
  let running = false;

  // Preserve the startup warmup so caches populate shortly after boot.
  const warmupTimer = warmup ? setTimeout(async () => {
    if (running) return;
    running = true;
    try {
      await fn();
      logger.info(`${name}: initial run complete`);
    } catch (err) {
      logger.error(`${name}: initial run failed`, { error: err.message });
    } finally {
      running = false;
    }
  }, 5000) : null;
  warmupTimer?.unref?.();

  const runScheduled = async () => {
    if (running) {
      logger.warn(`${name}: overlapping refresh skipped`);
      return;
    }
    running = true;
    try {
      await fn();
    } catch (err) {
      logger.error(`${name} failed`, { error: err.message });
    } finally {
      running = false;
    }
  };

  const scheduledStart = setTimeout(() => {
    runScheduled();
    interval = setInterval(runScheduled, intervalMs);
    interval.unref?.();
  }, initialDelayMs);
  scheduledStart.unref?.();

  return () => {
    if (warmupTimer) clearTimeout(warmupTimer);
    clearTimeout(scheduledStart);
    if (interval) clearInterval(interval);
  };
}

export function getMarketContextRefreshDelay(result) {
  const session = result?.marketSnapshot?.marketSession?.status;
  if (session === 'MARKET_OPEN') return MARKET_CONTEXT_OPEN_REFRESH_MS;
  if (session === 'MARKET_HOLIDAY') return MARKET_CONTEXT_HOLIDAY_REFRESH_MS;
  return MARKET_CONTEXT_CLOSED_REFRESH_MS;
}

function scheduleAdaptiveJob(name, fn) {
  let timer = null;
  let stopped = false;
  let running = false;

  const run = async () => {
    if (stopped || running) return;
    running = true;
    let result = null;
    try {
      result = await fn();
    } catch (error) {
      logger.error(`${name} failed`, { error: error.message });
    } finally {
      running = false;
      if (!stopped) {
        timer = setTimeout(run, getMarketContextRefreshDelay(result));
        timer.unref?.();
      }
    }
  };

  timer = setTimeout(run, 5000);
  timer.unref?.();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

function getScheduleTiming(cronExpr, now = new Date()) {
  const [minutePart, hourPart] = cronExpr.split(' ');
  const fallback = {
    initialDelayMs: 6 * 60 * 60 * 1000,
    intervalMs: 6 * 60 * 60 * 1000,
  };
  const minute = Number(minutePart);

  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    return fallback;
  }

  if (hourPart === '*/2') {
    const next = new Date(now);
    next.setUTCSeconds(0, 0);
    next.setUTCMinutes(minute);

    const currentHour = now.getUTCHours();
    const nextEvenHour = currentHour % 2 === 0 ? currentHour : currentHour + 1;
    next.setUTCHours(nextEvenHour);
    if (next <= now) {
      next.setUTCHours(next.getUTCHours() + 2);
    }

    return {
      initialDelayMs: next.getTime() - now.getTime(),
      intervalMs: 2 * 60 * 60 * 1000,
    };
  }

  const hour = Number(hourPart);
  if (Number.isInteger(hour) && hour >= 0 && hour <= 23) {
    const next = new Date(now);
    next.setUTCSeconds(0, 0);
    next.setUTCHours(hour, minute);
    if (next <= now) {
      next.setUTCDate(next.getUTCDate() + 1);
    }

    return {
      initialDelayMs: next.getTime() - now.getTime(),
      intervalMs: 24 * 60 * 60 * 1000,
    };
  }

  return fallback;
}
