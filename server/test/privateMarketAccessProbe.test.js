import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPrivateMarketProbeAllowed,
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
