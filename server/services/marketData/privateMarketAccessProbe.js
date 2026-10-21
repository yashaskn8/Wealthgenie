/**
 * Ephemeral private developer connectivity diagnostics. This module does NOT
 * approve data licensing, expose public API routes, or alter production rights.
 * It never persists or returns raw provider data.
 */
import { MARKET_BENCHMARKS } from './marketBenchmarks.js';
import { buildUpstoxQuoteRequestUrl, UPSTOX_NSE_MARKET_STATUS_URL } from './marketDataSourceUrls.js';
import { resolveUpstoxAccessToken } from './upstoxCredentials.js';
import { POST_TAX_SOURCE_RIGHTS_STATES, resolveSourceRights } from '../postTaxSourceRights.js';

export const PRIVATE_MARKET_PROBE_ENV = 'PRIVATE_MARKET_READ_ONLY_PROBE_ENABLED';
const TIMEOUT_MS = 8000;

export function assertPrivateMarketProbeAllowed(env, acknowledged) {
  if (env?.NODE_ENV !== 'development' || env?.CI === 'true' || env?.GITHUB_ACTIONS === 'true'
      || env?.[PRIVATE_MARKET_PROBE_ENV] !== 'true' || acknowledged !== true) {
    const error = new Error('Private market probe requires development and explicit opt-in; each endpoint must also have an exact qualified private-use scope.');
    error.code = 'PRIVATE_MARKET_PROBE_DISABLED';
    throw error;
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasQualifiedPrivateProbeRights(probe, env, acknowledged) {
  if (env?.NODE_ENV !== 'development' || env?.[PRIVATE_MARKET_PROBE_ENV] !== 'true' || acknowledged !== true) {
    return false;
  }
  const rights = resolveSourceRights({ provider: probe.provider, url: probe.url });
  return probe.provider === 'UPSTOX' && rights.sourceId === 'UPSTOX_QUOTES_V3'
    && rights.status === POST_TAX_SOURCE_RIGHTS_STATES.DEVELOPMENT_RESEARCH_ONLY
    && rights.approvedScopes.includes('PRIVATE_LOCAL_EDUCATIONAL_DEMO');
}

export function privateMarketProbeRequests(env) {
  const keys = [
    MARKET_BENCHMARKS.NIFTY_50.upstoxInstrumentKey,
    MARKET_BENCHMARKS.INDIA_VIX.upstoxInstrumentKey,
  ];
  const token = resolveUpstoxAccessToken(env);
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
  ];
}

/** Reports all fixed endpoints, requesting only exact private-scope-qualified sources. */
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
    if (!hasQualifiedPrivateProbeRights(probe, env, acknowledgeProviderTerms)) {
      const rights = resolveSourceRights({ provider: probe.provider, url: probe.url });
      results.push({
        provider: probe.provider,
        operation: probe.operation,
        verdict: 'SOURCE_RIGHTS_UNVERIFIED',
        sourceId: rights.sourceId,
        rightsStatus: rights.status,
      });
      continue;
    }
    if (!probe.credential) {
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

/**
 * Interpret a connectivity probe without treating an unqualified endpoint as
 * a failed live HTTP operation. Rights blocks are reported but never contacted.
 * The NIFTY/VIX quote operation is the only currently qualified probe.
 */
export function assessPrivateMarketProbeReadiness(report) {
  const results = Array.isArray(report?.results) ? report.results : [];
  const quote = results.find(item => item?.provider === 'UPSTOX' && item.operation === 'BENCHMARK_QUOTES');
  const otherAttemptedFailure = results.some(item => item
    && item.operation !== 'BENCHMARK_QUOTES'
    && !['SOURCE_RIGHTS_UNVERIFIED', 'HTTP_200_SCHEMA_OK'].includes(item.verdict));
  const passed = quote?.verdict === 'HTTP_200_SCHEMA_OK' && !otherAttemptedFailure;
  return {
    status: passed ? 'PRIVATE_QUOTE_CONNECTIVITY_VERIFIED' : 'PRIVATE_QUOTE_CONNECTIVITY_UNAVAILABLE',
    unqualifiedOperations: results.filter(item => item?.verdict === 'SOURCE_RIGHTS_UNVERIFIED').length,
    passed,
  };
}
