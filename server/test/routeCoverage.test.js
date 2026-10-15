import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import authRoutes from '../routes/auth.js';
import profileRoutes from '../routes/profile.js';
import recommendRoutes from '../routes/recommend.js';
import instrumentsRoutes from '../routes/instruments.js';
import projectionRoutes from '../routes/projection.js';
import montecarloRoutes from '../routes/montecarlo.js';
import goalsRoutes from '../routes/goals.js';
import marketRoutes from '../routes/market.js';
import taxRoutes from '../routes/tax.js';
import chatRoutes from '../routes/chatRoutes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { rawRequest, withServer, jsonRequest as jsonFetch } from '../test-utils/httpTestUtils.js';
import { canonicalProfilePayload } from './helpers/canonicalProfile.js';

process.env.JWT_SECRET = 'route-coverage-test-secret';
process.env.NODE_ENV = 'test';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api/profile', profileRoutes);
  app.use('/api/recommend', recommendRoutes);
  app.use('/api/instruments', instrumentsRoutes);
  app.use('/api/projection', projectionRoutes);
  app.use('/api/montecarlo', montecarloRoutes);
  app.use('/api/goals', goalsRoutes);
  app.use('/api/market', marketRoutes);
  app.use('/api/tax', taxRoutes);
  app.use('/api/chat', chatRoutes);
  app.use(errorHandler);
  return app;
}


test('auth route rejects invalid register payload before database access', async () => {
  await withServer(buildApp(), async (baseUrl) => {
    const { response, body } = await jsonFetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      body: JSON.stringify({ email: 'not-an-email' }),
    });

    assert.equal(response.status, 400);
    assert.equal(body.error, 'Validation failed');
    assert.ok(body.details.length > 0);
  });
});

test('protected route files enforce JWT before service/database work', async () => {
  await withServer(buildApp(), async (baseUrl) => {
    const checks = [
      ['profile', 'POST', '/api/profile/build', canonicalProfilePayload()],
      ['profile precompute', 'POST', '/api/profile/precompute', canonicalProfilePayload()],
      ['profile complete', 'POST', '/api/profile/complete', canonicalProfilePayload()],
      ['recommendation restore', 'GET', '/api/recommend/current?profileId=65b000000000000000000001', null],
      ['recommend', 'POST', '/api/recommend', { profileId: '65b000000000000000000001' }],
      ['projection', 'POST', '/api/projection', { profileId: '65b000000000000000000001', monthly_investment: 10000 }],
      ['stress test', 'POST', '/api/projection/stress-test', { profileId: '65b000000000000000000001', instrumentId: 'ETF', principal: 100000 }],
      ['allocation split', 'POST', '/api/projection/allocation-split', { monthlyInvestment: 10000, equityPct: 60 }],
      ['montecarlo', 'POST', '/api/montecarlo/montecarlo', { instrument: 'ETF', monthly_investment: 10000, years: 5 }],
      ['goals', 'GET', '/api/goals', null],
      ['market refresh', 'POST', '/api/market/refresh', {}],
      ['chat', 'POST', '/api/chat/message', { message: 'hello' }],
    ];

    for (const [label, method, path, payload] of checks) {
      const { response, body } = await jsonFetch(`${baseUrl}${path}`, {
        method,
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
      assert.equal(response.status, 401, `${label}: ${JSON.stringify(body)}`);
      assert.match(body.error, /token|access denied/i, label);
    }
  });
});

test('instruments route validates public query inputs', async () => {
  await withServer(buildApp(), async (baseUrl) => {
    const { response, body } = await jsonFetch(`${baseUrl}/api/instruments?type=BadType`);

    assert.equal(response.status, 400);
    assert.equal(body.code, 'VALIDATION_ERROR');
    assert.ok(body.request_id);
    assert.ok(body.details.some(issue => /type.*one of/i.test(issue)));
  });
});

test('tax route computes and compares regimes without authentication', async () => {
  await withServer(buildApp(), async (baseUrl) => {
    const compute = await jsonFetch(`${baseUrl}/api/tax/compute`, {
      method: 'POST',
      body: JSON.stringify({ income: 1200000, regime: 'new', incomeSource: 'salary', age: 35, fiscalYear: 'FY2026-27' }),
    });
    const compare = await jsonFetch(`${baseUrl}/api/tax/compare`, {
      method: 'POST',
      body: JSON.stringify({ income: 1200000, incomeSource: 'salary', age: 35, fiscalYear: 'FY2026-27' }),
    });
    const maximumIncome = await jsonFetch(`${baseUrl}/api/tax/compute`, {
      method: 'POST',
      body: JSON.stringify({ income: 1000000000, regime: 'new', incomeSource: 'salary', age: 35, fiscalYear: 'FY2026-27' }),
    });
    const aboveMaximumIncome = await jsonFetch(`${baseUrl}/api/tax/compute`, {
      method: 'POST',
      body: JSON.stringify({ income: 1000000001, regime: 'new', incomeSource: 'salary', age: 35, fiscalYear: 'FY2026-27' }),
    });
    const legacyQuery = await rawRequest(`${baseUrl}/api/tax/compare`);

    assert.equal(compute.response.status, 200);
    assert.ok(Number.isFinite(compute.body.taxAmount));
    assert.equal(maximumIncome.response.status, 200);
    assert.equal(aboveMaximumIncome.response.status, 400);
    assert.equal(compare.response.status, 200);
    assert.ok(['new', 'old'].includes(compare.body.recommended_regime));
    assert.equal(compare.body.calculation_classification, 'SEPARATE_TAX_WHAT_IF');
    assert.ok(Array.isArray(compare.body.new_regime.slab_breakdown));
    assert.ok(Array.isArray(compare.body.old_regime.slab_breakdown));
    assert.equal(compare.body.deduction_limits.section80C, 150000);
    assert.ok(Number.isFinite(compare.body.optimized_old_regime_tax));
    assert.equal(legacyQuery.status, 404);
  });
});
