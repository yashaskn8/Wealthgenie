/**
 * Private educational market-data display. No public rights changes, Mongo
 * writes, Redis writes, derived financial recommendations, or raw payload logs.
 * Only fixed benchmark identities and one bounded EOD instrument are allowed.
 */
import crypto from 'node:crypto';
import { MARKET_BENCHMARKS } from './marketBenchmarks.js';
import { buildUpstoxQuoteRequestUrl } from './marketDataSourceUrls.js';
import { resolveUpstoxAccessToken } from './upstoxCredentials.js';

export const PRIVATE_MARKET_DEMO_FLAG = 'PRIVATE_MARKET_DEMO_ENABLED';
const QUOTE_TTL_MS = 60_000;
const EOD_TTL_MS = 15 * 60_000;
const QUOTE_KEYS = Object.freeze([
  MARKET_BENCHMARKS.NIFTY_50.upstoxInstrumentKey,
  MARKET_BENCHMARKS.INDIA_VIX.upstoxInstrumentKey,
]);
const memoryCache = new Map();

export function isPrivateMarketDemoConfigured(env = process.env) {
  return env?.NODE_ENV === 'development'
    && env?.CI !== 'true'
    && env?.GITHUB_ACTIONS !== 'true'
    && env?.[PRIVATE_MARKET_DEMO_FLAG] === 'true'
    && env?.PRIVATE_MARKET_DEMO_TERMS_ACKNOWLEDGED === 'true';
}

export function isPrivateMarketDemoLoopback(req) {
  const remote = String(req?.socket?.remoteAddress || '').toLowerCase();
  const remoteAllowed = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
  if (!remoteAllowed) return false;
  try {
    const host = new URL('http://' + String(req.headers.host || '')).hostname;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return false;
    const origin = req.headers.origin;
    if (origin) {
      const u = new URL(origin);
      if (u.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return false;
    }
    return true;
  } catch { return false; }
}

function validObject(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function validPositive(value) { return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER; }
function isoFromEpochMs(value) {
  if (!/^\d{13}$/.test(String(value ?? ''))) return null;
  const date = new Date(Number(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function isoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))) return null;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}
function fail(code) { return { status: 'UNAVAILABLE', code }; }
function shortKey(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function recentWindow(now) {
  const to = new Date(now);
  to.setUTCDate(to.getUTCDate() - 2);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 40);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

async function getJson(fetchImpl, url, token) {
  try {
    const response = await fetchImpl(url, {
      method: 'GET', redirect: 'error', cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      signal: AbortSignal.timeout(8000),
    });
    if (response.status !== 200) return { error: response.status === 401 || response.status === 403
      ? 'AUTH_OR_ENTITLEMENT_DENIED' : response.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_HTTP_ERROR' };
    return { data: await response.json() };
  } catch { return { error: 'PROVIDER_NETWORK_OR_RESPONSE_ERROR' }; }
}

export function normalizePrivateBenchmarkQuotes(body, receivedAt) {
  if (!validObject(body) || body.status !== 'success' || !validObject(body.data)) return fail('INVALID_UPSTOX_RESPONSE');
  const facts = [
    { key: QUOTE_KEYS[0], id: 'market:index:nifty-50', name: 'NIFTY 50' },
    { key: QUOTE_KEYS[1], id: 'market:index:india-vix', name: 'India VIX' },
  ].map(item => {
    const matches = Object.values(body.data).filter(row => row?.instrument_token === item.key);
    const row = matches.length === 1 ? matches[0] : null;
    const observedAt = isoFromEpochMs(row?.last_trade_time);
    const valid = validPositive(row?.last_price) && observedAt && Date.parse(observedAt) <= Date.parse(receivedAt);
    return {
      canonicalProductId: item.id, name: item.name,
      instrumentKey: item.key, provider: 'UPSTOX',
      status: valid ? 'AVAILABLE' : 'UNAVAILABLE',
      price: valid ? row.last_price : null,
      observedAt: valid ? observedAt : null,
      receivedAt,
      dataClass: 'LIVE_QUOTE_SNAPSHOT',
      reasonCode: valid ? null : matches.length > 1 ? 'DUPLICATE_OBSERVATION' : 'QUOTE_NOT_QUALIFIED',
    };
  });
  return { status: facts.every(x => x.status === 'AVAILABLE') ? 'AVAILABLE'
    : facts.some(x => x.status === 'AVAILABLE') ? 'PARTIAL' : 'UNAVAILABLE',
  provider: 'UPSTOX', facts, receivedAt };
}

export function normalizePrivateTejHqEod(body, { from, to, receivedAt }) {
  if (!validObject(body) || !Array.isArray(body.data) || !validObject(body.meta)) return fail('INVALID_TEJHQ_RESPONSE');
  if (String(body.meta.exchange || '').toUpperCase() !== 'NSE'
      || String(body.meta.symbol || '').toUpperCase() !== 'RELIANCE'
      || body.meta.from !== from || body.meta.to !== to
      || (body.meta.count !== undefined && body.meta.count !== body.data.length)
      || body.data.length > 42) return fail('TEJHQ_IDENTITY_OR_RANGE_MISMATCH');
  let previous = '';
  const candles = [];
  for (const row of body.data) {
    const date = isoDate(row?.date);
    if (!date || date < from || date > to || (previous && date <= previous)
        || !['open', 'high', 'low', 'close'].every(key => validPositive(row?.[key]))
        || row.high < Math.max(row.open, row.close, row.low)
        || row.low > Math.min(row.open, row.close)
        || !Number.isSafeInteger(row.volume) || row.volume < 0) return fail('TEJHQ_INVALID_EOD_CANDLE');
    candles.push({ tradingDate: date, open: row.open, high: row.high,
      low: row.low, close: row.close, volume: row.volume });
    previous = date;
  }
  return { status: candles.length ? 'AVAILABLE' : 'UNAVAILABLE',
    provider: 'TEJHQ', instrument: 'NSE:RELIANCE', dataClass: 'HISTORICAL_EOD',
    priceBasis: 'RAW_UNADJUSTED', receivedAt,
    lastTradingDate: candles.at(-1)?.tradingDate ?? null,
    candles, reasonCode: candles.length ? null : 'NO_EOD_OBSERVATIONS' };
}

/** Fetch at most two GETs per cold private view, with isolated process-memory TTLs. */
export async function readPrivateMarketDemo({
  env = process.env, fetchImpl = globalThis.fetch, now = () => new Date(), cache = memoryCache,
} = {}) {
  if (!isPrivateMarketDemoConfigured(env)) return { status: 'DISABLED', code: 'PRIVATE_DEMO_NOT_CONFIGURED' };
  if (typeof fetchImpl !== 'function') throw new TypeError('Fetch implementation required.');
  const token = resolveUpstoxAccessToken(env);
  const clock = now();
  const stamp = clock.toISOString();
  const key = 'private-market-demo:' + shortKey(token);
  const existing = cache.get(key) || {};
  // Credentials are never stored in the cache; only normalized facts.
  const quoteFresh = existing.quotes && existing.quotesExpiresAt > clock.getTime();
  let quotes = quoteFresh ? existing.quotes : fail('UPSTOX_TOKEN_NOT_CONFIGURED');
  if (!quoteFresh && token) {
    const response = await getJson(fetchImpl, buildUpstoxQuoteRequestUrl(QUOTE_KEYS), token);
    quotes = response.error ? fail(response.error) : normalizePrivateBenchmarkQuotes(response.data, stamp);
  }
  const window = recentWindow(clock);
  const eodFresh = existing.eod && existing.eodExpiresAt > clock.getTime()
    && existing.windowTo === window.to;
  let eod = eodFresh ? existing.eod : fail('TEJHQ_DEMO_NOT_ENABLED');
  if (!eodFresh && env.PRIVATE_MARKET_DEMO_TEJHQ_ENABLED === 'true') {
    const url = 'https://api.tejhq.dev/v1/ohlcv/nse/RELIANCE?from='
      + window.from + '&to=' + window.to;
    const response = await getJson(fetchImpl, url, null);
    eod = response.error ? fail(response.error) : normalizePrivateTejHqEod(response.data, {
      ...window, receivedAt: stamp,
    });
  }
  // Failed reads are negatively cached for 30 seconds to protect rate limits.
  cache.set(key, {
    quotes, eod, windowTo: window.to,
    quotesExpiresAt: clock.getTime() + (quotes.status === 'AVAILABLE' ? QUOTE_TTL_MS : 30_000),
    eodExpiresAt: clock.getTime() + (eod.status === 'AVAILABLE' ? EOD_TTL_MS : 30_000),
  });
  // Prevent credential-rotation remnants and excessive local memory growth.
  if (cache.size > 3) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
  return {
    status: 'PRIVATE_DEVELOPMENT_ONLY',
    productionDataPublicationAuthorized: false,
    sourceRightsScope: 'READ_ONLY_PRIVATE_EDUCATIONAL_VIEW',
    storedIn: 'PROCESS_MEMORY_ONLY',
    persistentWrites: 0,
    checkedAt: stamp,
    cache: { quoteHit: Boolean(quoteFresh), eodHit: Boolean(eodFresh) },
    quotes, eod,
  };
}
