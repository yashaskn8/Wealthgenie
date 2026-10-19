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

test('private diagnostics request only exact-scope qualified endpoints and skip unverified sources', async () => {
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
    assert.fail('Unverified provider endpoints must not reach the network.');
  };
  const report = await runPrivateMarketAccessProbe({
    env, acknowledgeProviderTerms: true, fetchImpl, now: new Date('2026-10-19T06:00:00.000Z'),
  });
  assert.equal(report.scope, 'PRIVATE_LOCAL_READ_ONLY_DIAGNOSTIC');
  assert.equal(report.productionAuthorization, 'NOT_ESTABLISHED');
  assert.equal(report.persistentWrites, 0);
  assert.equal(report.results.length, 5);
  assert.equal(report.results.filter(item => item.verdict === 'HTTP_200_SCHEMA_OK').length, 1);
  assert.equal(report.results.filter(item => item.verdict === 'SOURCE_RIGHTS_UNVERIFIED').length, 4);
  assert.ok(report.results.filter(item => item.provider === 'TEJHQ')
    .every(item => item.verdict === 'SOURCE_RIGHTS_UNVERIFIED' && item.rightsStatus === 'LICENSE_UNVERIFIED'));
  assert.equal(calls.length, 1);
  assert.equal(calls.filter(x => x.options.headers.Authorization).length, 1);
  assert.ok(calls.every(x => !x.url.includes('private-fixture-')));
  assert.ok(!JSON.stringify(report).includes('private-fixture-'));
});

test('probe skips uncredentialed qualified endpoints and all unverified endpoints without network calls', async () => {
  const missing = { ...env, UPSTOX_ANALYTICS_TOKEN: '', TEJHQ_API_KEY: '' };
  let calls = 0;
  const report = await runPrivateMarketAccessProbe({
    env: missing, acknowledgeProviderTerms: true,
    fetchImpl: async () => { calls++; throw new Error('sensitive-token-should-not-leak'); },
  });
  assert.equal(calls, 0);
  assert.equal(report.results.filter(item => item.verdict === 'CREDENTIAL_NOT_CONFIGURED').length, 1);
  assert.equal(report.results.filter(item => item.verdict === 'SOURCE_RIGHTS_UNVERIFIED').length, 4);
  assert.ok(!JSON.stringify(report).includes('sensitive-token-should-not-leak'));
});

test('HTTP entitlement denial is classified separately from schema mismatches', async () => {
  assert.equal(privateMarketProbeRequests(env).length, 5);
  const report = await runPrivateMarketAccessProbe({
    env, acknowledgeProviderTerms: true,
    fetchImpl: async () => ({ status: 402, json: async () => { throw new Error('should not parse'); } }),
  });
  assert.equal(report.results.filter(x => x.verdict === 'ACCESS_OR_ENTITLEMENT_DENIED' && x.httpStatus === 402).length, 1);
  assert.equal(report.results.filter(x => x.verdict === 'SOURCE_RIGHTS_UNVERIFIED').length, 4);
});
