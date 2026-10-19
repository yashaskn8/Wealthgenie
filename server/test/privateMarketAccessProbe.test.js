import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPrivateMarketProbeAllowed,
  privateMarketProbeRequests,
  runPrivateMarketAccessProbe,
} from '../services/marketData/privateMarketAccessProbe.js';

const env = Object.freeze({
  NODE_ENV: 'development', PRIVATE_MARKET_READ_ONLY_PROBE_ENABLED: 'true',
  UPSTOX_ANALYTICS_TOKEN: 'private-fixture-token', TEJHQ_API_KEY: 'private-fixture-key',
});

test('private probe fails closed for production, CI, and missing acknowledgement', () => {
  for (const override of [{ NODE_ENV: 'production' }, { CI: 'true' },
    { GITHUB_ACTIONS: 'true' }, { PRIVATE_MARKET_READ_ONLY_PROBE_ENABLED: 'false' }]) {
    assert.throws(() => assertPrivateMarketProbeAllowed({ ...env, ...override }, true),
      { code: 'PRIVATE_MARKET_PROBE_DISABLED' });
  }
  assert.throws(() => assertPrivateMarketProbeAllowed(env, false),
    { code: 'PRIVATE_MARKET_PROBE_DISABLED' });
  assert.doesNotThrow(() => assertPrivateMarketProbeAllowed(env, true));
});

test('private diagnostics use only fixed GET provider endpoints and keep credentials in headers', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const u = new URL(url);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.equal(u.protocol, 'https:');
    assert.ok(['api.upstox.com', 'api.tejhq.dev'].includes(u.hostname));
    assert.ok(!url.includes('private-fixture-token') && !url.includes('private-fixture-key'));
    assert.ok(!options.body);
    if (url.includes('/v3/market-quote/quotes')) return {
      status: 200, json: async () => ({ status: 'success', data: {
        a: { instrument_token: 'NSE_INDEX|Nifty 50' },
        b: { instrument_token: 'NSE_INDEX|India VIX' },
      } }),
    };
    if (url.includes('/v2/market/status/NSE')) return {
      status: 200, json: async () => ({ status: 'success', data: { exchange: 'NSE' } }),
    };
    if (url.includes('/v1/ohlcv/')) return {
      status: 200, json: async () => ({ data: [], meta: { exchange: 'NSE' } }),
    };
    return { status: 200, json: async () => ({ ok: true }) };
  };
  const report = await runPrivateMarketAccessProbe({
    env, acknowledgeProviderTerms: true, fetchImpl, now: new Date('2026-10-19T06:00:00.000Z'),
  });
  assert.equal(report.scope, 'PRIVATE_LOCAL_READ_ONLY_DIAGNOSTIC');
  assert.equal(report.productionAuthorization, 'NOT_ESTABLISHED');
  assert.equal(report.persistentWrites, 0);
  assert.equal(report.results.length, 5);
  assert.ok(report.results.every(item => item.verdict === 'HTTP_200_SCHEMA_OK'));
  assert.equal(calls.length, 5);
  assert.equal(calls.filter(x => x.options.headers.Authorization).length, 3);
  assert.ok(calls.every(x => !x.url.includes('private-fixture-')));
  assert.ok(!JSON.stringify(report).includes('private-fixture-'));
});

test('probe skips authenticated endpoints if keys are absent and never leaks errors', async () => {
  const missing = { ...env, UPSTOX_ANALYTICS_TOKEN: '', TEJHQ_API_KEY: '' };
  let calls = 0;
  const report = await runPrivateMarketAccessProbe({
    env: missing, acknowledgeProviderTerms: true,
    fetchImpl: async () => { calls++; throw new Error('sensitive-token-should-not-leak'); },
  });
  assert.equal(calls, 2);
  assert.equal(report.results.filter(item => item.verdict === 'CREDENTIAL_NOT_CONFIGURED').length, 3);
  assert.equal(report.results.filter(item => item.verdict === 'NETWORK_OR_TIMEOUT').length, 2);
  assert.ok(!JSON.stringify(report).includes('sensitive-token-should-not-leak'));
});

test('HTTP entitlement denial is classified separately from schema mismatches', async () => {
  assert.equal(privateMarketProbeRequests(env).length, 5);
  const report = await runPrivateMarketAccessProbe({
    env, acknowledgeProviderTerms: true,
    fetchImpl: async () => ({ status: 402, json: async () => { throw new Error('should not parse'); } }),
  });
  assert.ok(report.results.every(x => x.verdict === 'ACCESS_OR_ENTITLEMENT_DENIED' && x.httpStatus === 402));
});
