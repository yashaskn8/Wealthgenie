/**
 * Private educational market-data display. No public rights changes, Mongo
 * writes, Redis writes, derived financial recommendations, or raw payload logs.
 * Only fixed benchmark identities and one bounded EOD instrument are allowed.
 */
import { MARKET_BENCHMARKS } from './marketBenchmarks.js';
import { buildUpstoxQuoteRequestUrl } from './marketDataSourceUrls.js';
import { resolveUpstoxAccessToken } from './upstoxCredentials.js';
import { isMarketDataPrivateDemoUseAllowed } from './marketDataRights.js';

export const PRIVATE_MARKET_DEMO_FLAG = 'PRIVATE_MARKET_DEMO_ENABLED';
const QUOTE_KEYS = Object.freeze([
  MARKET_BENCHMARKS.NIFTY_50.upstoxInstrumentKey,
  MARKET_BENCHMARKS.INDIA_VIX.upstoxInstrumentKey,
]);

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
    const valid = Boolean(validPositive(row?.last_price) && observedAt && Date.parse(observedAt) <= Date.parse(receivedAt));
    const ageSeconds = valid ? Math.max(0, Math.floor((Date.parse(receivedAt) - Date.parse(observedAt)) / 1000)) : null;
    return {
      canonicalProductId: item.id, name: item.name,
      instrumentKey: item.key, provider: 'UPSTOX',
      status: valid ? 'AVAILABLE' : 'UNAVAILABLE',
      price: valid ? row.last_price : null,
      observedAt: valid ? observedAt : null,
      receivedAt,
      freshness: { status: !valid ? 'UNKNOWN' : ageSeconds <= 900 ? 'FRESH' : 'STALE',
        ageSeconds, maxAgeSeconds: 900 },
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

/** Fetch only exact private-demo-qualified endpoints and retain no response data. */
export async function readPrivateMarketDemo({
  env = process.env, fetchImpl = globalThis.fetch, now = () => new Date(), privateDemoCapability = null,
} = {}) {
  if (!isPrivateMarketDemoConfigured(env)) return { status: 'DISABLED', code: 'PRIVATE_DEMO_NOT_CONFIGURED' };
  if (typeof fetchImpl !== 'function') throw new TypeError('Fetch implementation required.');
  const token = resolveUpstoxAccessToken(env);
  const clock = now();
  const quoteUrl = buildUpstoxQuoteRequestUrl(QUOTE_KEYS);
  const quoteAllowed = isMarketDataPrivateDemoUseAllowed('UPSTOX', quoteUrl, env, privateDemoCapability);
  let quotes = fail(quoteAllowed ? 'UPSTOX_TOKEN_NOT_CONFIGURED' : 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
  if (quoteAllowed && token) {
    const response = await getJson(fetchImpl, quoteUrl, token);
    quotes = response.error ? fail(response.error) : normalizePrivateBenchmarkQuotes(response.data, now().toISOString());
  }
  const window = recentWindow(clock);
  const eodUrl = 'https://api.tejhq.dev/v1/ohlcv/nse/RELIANCE?from='
    + window.from + '&to=' + window.to;
  const eodAllowed = isMarketDataPrivateDemoUseAllowed('TEJHQ', eodUrl, env, privateDemoCapability);
  let eod = fail('TEJHQ_DEMO_NOT_ENABLED');
  if (env.PRIVATE_MARKET_DEMO_TEJHQ_ENABLED === 'true') {
    if (!eodAllowed) eod = fail('MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
    else {
      const response = await getJson(fetchImpl, eodUrl, null);
      eod = response.error ? fail(response.error) : normalizePrivateTejHqEod(response.data, {
        ...window, receivedAt: now().toISOString(),
      });
    }
  }
  return {
    status: 'PRIVATE_DEVELOPMENT_ONLY',
    productionDataPublicationAuthorized: false,
    storedIn: 'NONE',
    persistentWrites: 0,
    checkedAt: now().toISOString(),
    cache: { quoteHit: false, eodHit: false },
    quotes, eod,
  };
}
