/**
 * Ephemeral private developer connectivity diagnostics. This module does NOT
 * approve data licensing, expose public API routes, or alter production rights.
 * It never persists or returns raw provider data.
 */
import { MARKET_BENCHMARKS } from './marketBenchmarks.js';
import { buildUpstoxQuoteRequestUrl, UPSTOX_NSE_MARKET_STATUS_URL } from './marketDataSourceUrls.js';
import { resolveUpstoxAccessToken } from './upstoxCredentials.js';

export const PRIVATE_MARKET_PROBE_ENV = 'PRIVATE_MARKET_READ_ONLY_PROBE_ENABLED';
const TIMEOUT_MS = 8000;

export function assertPrivateMarketProbeAllowed(env, acknowledged) {
  if (env?.NODE_ENV !== 'development' || env?.CI === 'true' || env?.GITHUB_ACTIONS === 'true'
      || env?.[PRIVATE_MARKET_PROBE_ENV] !== 'true' || acknowledged !== true) {
    const error = new Error('Private market probe requires development, explicit opt-in, and provider-terms acknowledgement.');
    error.code = 'PRIVATE_MARKET_PROBE_DISABLED';
    throw error;
  }
}

function offsetDate(days, reference) {
  const value = new Date(reference);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function privateMarketProbeRequests(env, now = new Date()) {
  const from = offsetDate(-9, now);
  const to = offsetDate(-2, now);
  const keys = [
    MARKET_BENCHMARKS.NIFTY_50.upstoxInstrumentKey,
    MARKET_BENCHMARKS.INDIA_VIX.upstoxInstrumentKey,
  ];
  const token = resolveUpstoxAccessToken(env);
  const tejKey = String(env?.TEJHQ_API_KEY || '').trim();
  return [
    {
      provider: 'UPSTOX', operation: 'BENCHMARK_QUOTES',
      url: buildUpstoxQuoteRequestUrl(keys), credential: token,
      validate: data => object(data) && data.status === 'success' && object(data.data)
        && keys.every(key => Object.values(data.data).some(item => item?.instrument_token === key)),
    },
    {
      provider: 'UPSTOX', operation: 'NSE_MARKET_STATUS',
      url: UPSTOX_NSE_MARKET_STATUS_URL, credential: token,
      validate: data => object(data) && data.status === 'success' && object(data.data),
    },
    {
      provider: 'TEJHQ', operation: 'PUBLICATION_STATUS',
      url: 'https://api.tejhq.dev/v1/status', credential: null,
      validate: data => object(data),
    },
    {
      provider: 'TEJHQ', operation: 'RAW_EOD',
      url: 'https://api.tejhq.dev/v1/ohlcv/nse/RELIANCE?from=' + from + '&to=' + to,
      credential: null,
      validate: data => object(data) && Array.isArray(data.data) && object(data.meta),
    },
    {
      provider: 'TEJHQ', operation: 'KEY_ENTITLEMENT',
      url: 'https://api.tejhq.dev/v1/me', credential: tejKey,
      validate: data => object(data),
    },
  ];
}

/** At most five fixed read-only GETs; returns sanitized status only. */
export async function runPrivateMarketAccessProbe({
  env = process.env,
  acknowledgeProviderTerms = false,
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  assertPrivateMarketProbeAllowed(env, acknowledgeProviderTerms);
  if (typeof fetchImpl !== 'function') throw new TypeError('A GET-capable fetch implementation is required.');
  const results = [];
  for (const probe of privateMarketProbeRequests(env, now)) {
    const credentialRequired = probe.provider === 'UPSTOX' || probe.operation === 'KEY_ENTITLEMENT';
    if (credentialRequired && !probe.credential) {
      results.push({ provider: probe.provider, operation: probe.operation, verdict: 'CREDENTIAL_NOT_CONFIGURED' });
      continue;
    }
    try {
      const response = await fetchImpl(probe.url, {
        method: 'GET', redirect: 'error', cache: 'no-store',
        headers: {
          Accept: 'application/json',
          ...(probe.credential ? { Authorization: 'Bearer ' + probe.credential } : {}),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const status = Number(response?.status);
      if (status !== 200) {
        results.push({
          provider: probe.provider, operation: probe.operation,
          verdict: status === 401 || status === 403 || status === 402
            ? 'ACCESS_OR_ENTITLEMENT_DENIED' : 'HTTP_ERROR',
          httpStatus: Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null,
        });
        continue;
      }
      let valid = false;
      try { valid = probe.validate(await response.json()); } catch { valid = false; }
      results.push({
        provider: probe.provider, operation: probe.operation,
        verdict: valid ? 'HTTP_200_SCHEMA_OK' : 'HTTP_200_SCHEMA_UNVERIFIED',
        httpStatus: 200,
      });
    } catch {
      // Never return thrown network messages: they may disclose credentials.
      results.push({ provider: probe.provider, operation: probe.operation, verdict: 'NETWORK_OR_TIMEOUT' });
    }
  }
  return {
    scope: 'PRIVATE_LOCAL_READ_ONLY_DIAGNOSTIC',
    productionAuthorization: 'NOT_ESTABLISHED',
    persistentWrites: 0,
    results,
  };
}
