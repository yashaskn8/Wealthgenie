import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPrivateMarketProbeAllowed,
  assessPrivateMarketProbeReadiness,
  privateMarketProbeRequests,
  runPrivateMarketAccessProbe,
} from '../services/marketData/privateMarketAccessProbe.js';

const env = Object.freeze({
  NODE_ENV: 'development', PRIVATE_MARKET_READ_ONLY_PROBE_ENABLED: 'true',
  UPSTOX_ANALYTICS_TOKEN: 'private-fixture-token',
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

test('HTTP entitlement denial is classified separately from schema mismatches', async () => {
  assert.equal(privateMarketProbeRequests(env).length, 2);
  const report = await runPrivateMarketAccessProbe({
    env, acknowledgeProviderTerms: true,
    fetchImpl: async () => ({ status: 402, json: async () => { throw new Error('should not parse'); } }),
  });
  assert.equal(report.results.filter(x => x.verdict === 'ACCESS_OR_ENTITLEMENT_DENIED' && x.httpStatus === 402).length, 1);
  assert.equal(report.results.filter(x => x.verdict === 'SOURCE_RIGHTS_UNVERIFIED').length, 1);
});

test('private Upstox quote connectivity passes despite a separately blocked rights-unqualified endpoint', () => {
  const readiness = assessPrivateMarketProbeReadiness({ results: [
    { provider: 'UPSTOX', operation: 'BENCHMARK_QUOTES', verdict: 'HTTP_200_SCHEMA_OK' },
    { provider: 'UPSTOX', operation: 'NSE_MARKET_STATUS', verdict: 'SOURCE_RIGHTS_UNVERIFIED' },
  ] });
  assert.equal(readiness.passed, true);
  assert.equal(readiness.status, 'PRIVATE_QUOTE_CONNECTIVITY_VERIFIED');
  assert.equal(readiness.unqualifiedOperations, 1);
});

test('private quote connectivity never passes without actual qualified quote success', () => {
  for (const verdict of ['CREDENTIAL_NOT_CONFIGURED', 'ACCESS_OR_ENTITLEMENT_DENIED',
    'NETWORK_OR_TIMEOUT', 'HTTP_200_SCHEMA_UNVERIFIED', 'SOURCE_RIGHTS_UNVERIFIED']) {
    const readiness = assessPrivateMarketProbeReadiness({ results: [
      { provider: 'UPSTOX', operation: 'BENCHMARK_QUOTES', verdict },
      { provider: 'UPSTOX', operation: 'NSE_MARKET_STATUS', verdict: 'SOURCE_RIGHTS_UNVERIFIED' },
    ] });
    assert.equal(readiness.passed, false, `unverified quote verdict: ${verdict}`);
  }
  assert.equal(assessPrivateMarketProbeReadiness({ results: [] }).passed, false);
  assert.equal(assessPrivateMarketProbeReadiness(null).passed, false);
});

test('a failure at an additionally qualified endpoint still prevents an overall pass', () => {
  assert.equal(assessPrivateMarketProbeReadiness({ results: [
    { provider: 'UPSTOX', operation: 'BENCHMARK_QUOTES', verdict: 'HTTP_200_SCHEMA_OK' },
    { provider: 'UPSTOX', operation: 'EXTRA_APPROVED_ENDPOINT', verdict: 'ACCESS_OR_ENTITLEMENT_DENIED' },
  ] }).passed, false);
});
