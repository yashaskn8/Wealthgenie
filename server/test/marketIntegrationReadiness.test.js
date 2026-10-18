import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { getMarketIntegrationReadiness } from '../services/marketIntegrationReadiness.js';
import { createMarketDataAdminRouter } from '../routes/marketDataAdmin.js';
import { withServer, jsonRequest } from '../test-utils/httpTestUtils.js';

const fixtureSecrets = {
  MARKET_DATA_MODE: 'UPSTOX_TEJHQ',
  UPSTOX_ANALYTICS_TOKEN: 'DO-NOT-RETURN-UPSTOX-TOKEN',
  UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED: 'true',
  TEJHQ_ENABLED: 'true',
  TEJHQ_API_KEY: 'DO-NOT-RETURN-TEJHQ-KEY',
  TEJHQ_LICENSE_CONFIRMED: 'true',
  TEJHQ_HISTORICAL_FALLBACK_ENABLED: 'true',
};

test('market readiness identifies blocked rights despite operator flags and populated credentials', () => {
  const result = getMarketIntegrationReadiness(fixtureSecrets);
  assert.equal(result.mode, 'UPSTOX_TEJHQ');
  assert.equal(result.primaryProvider, 'UPSTOX');
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.liveProviderAccess, 'NOT_VERIFIED');
  assert.equal(result.marketContext.tokenConfigured, true);
  assert.equal(result.marketContext.publicDistributionFlagEnabled, true);
  assert.deepEqual(result.marketContext.blockers, ['MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED']);
  assert.equal(result.equityHistoryFallback.prerequisitesSatisfied, false);
  assert.equal(result.marketContext.exactSourceRights.quotes.sourceId, 'UPSTOX_QUOTES_V3');
  assert.equal(result.marketContext.exactSourceRights.quotes.productionUseAllowed, false);
  assert.equal(result.marketContext.exactSourceRights.sessionTimings.productionUseAllowed, false);
  assert.equal(result.equityHistoryFallback.exactSourceRights.symbolHistory.productionUseAllowed, false);
  assert.doesNotMatch(JSON.stringify(result), /DO-NOT-RETURN|Bearer|Authorization/);
});

test('default market mode is not silently treated as an enabled Upstox integration', () => {
  const result = getMarketIntegrationReadiness({});
  assert.equal(result.mode, 'LEGACY');
  assert.equal(result.primaryProvider, 'NSE');
  assert.equal(result.marketContext.prerequisitesSatisfied, false);
  assert(result.marketContext.blockers.includes('UPSTOX_TEJHQ_MODE_NOT_SELECTED'));
  assert(result.marketContext.blockers.includes('UPSTOX_TOKEN_NOT_CONFIGURED'));
  assert(result.marketContext.blockers.includes('UPSTOX_PUBLIC_DISTRIBUTION_DISABLED'));
});

test('local market doctor never treats a development exception as production market rights', () => {
  for (const nodeEnv of ['development', 'test', 'production']) {
    const result = getMarketIntegrationReadiness({
      NODE_ENV: nodeEnv,
      MARKET_DATA_MODE: 'UPSTOX_TEJHQ',
      UPSTOX_ANALYTICS_TOKEN: 'fixture-never-printed',
      TEJHQ_ENABLED: 'true',
      TEJHQ_LICENSE_CONFIRMED: 'true',
      TEJHQ_HISTORICAL_FALLBACK_ENABLED: 'true',
      TEJHQ_API_KEY: 'fixture-never-printed',
    });
    assert.equal(result.marketContext.publicDistributionFlagEnabled, false);
    assert.ok(result.marketContext.blockers.includes('UPSTOX_PUBLIC_DISTRIBUTION_DISABLED'));
    assert.equal(result.status, 'BLOCKED');
    assert.doesNotMatch(JSON.stringify(result), /fixture-never-printed/);
  }
});

test('admin diagnostics are authenticated, unauthorized requests never evaluate readiness', async () => {
  let reads = 0;
  const app = express();
  app.use('/api/market-data', createMarketDataAdminRouter({
    authenticate: (req, res, next) => {
      const role = req.headers.authorization === 'Bearer admin' ? 'admin'
        : req.headers.authorization === 'Bearer user' ? 'user' : null;
      if (!role) return res.status(401).json({ code: 'UNAUTHORIZED' });
      req.user = { userId: 'test-user', role };
      return next();
    },
    authorizeAdmin: (req, res, next) => req.user.role === 'admin'
      ? next() : res.status(403).json({ code: 'FORBIDDEN' }),
    limiter: (_req, _res, next) => next(),
    env: fixtureSecrets,
    getReadiness: env => {
      reads += 1;
      return getMarketIntegrationReadiness(env);
    },
  }));
  await withServer(app, async url => {
    const endpoint = `${url}/api/market-data/admin/diagnostics`;
    for (const [headers, expectedStatus] of [
      [{}, 401],
      [{ authorization: 'Bearer user' }, 403],
    ]) {
      const { response } = await jsonRequest(endpoint, { headers });
      assert.equal(response.status, expectedStatus);
    }
    assert.equal(reads, 0);
    const { response, body } = await jsonRequest(endpoint, {
      headers: { authorization: 'Bearer admin' },
    });
    assert.equal(response.status, 200);
    assert.equal(reads, 1);
    assert.equal(body.status, 'BLOCKED');
    assert.doesNotMatch(JSON.stringify(body), /DO-NOT-RETURN|Bearer admin/);
  });
});
