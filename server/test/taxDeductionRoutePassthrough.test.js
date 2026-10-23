import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import taxRoutes from '../routes/tax.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { jsonRequest, withServer } from '../test-utils/httpTestUtils.js';

function buildTaxApp() {
  const app = express();
  app.use(express.json({ strict: true }));
  app.use('/api/tax', taxRoutes);
  app.use(errorHandler);
  return app;
}

test('retired tax endpoints never process historical deductions or recommend old regime', async () => {
  await withServer(buildTaxApp(), async baseUrl => {
    const values = [
      { regime: 'old', section80C: 150000, section80D: 25000 },
      { regime: 'new', section80CCD: 50000, nps80CCD1B: 50000 },
      { regime: 'old', savingsInterest: 60000, section80TTA: 10000, section80TTB: 10000 },
      { regime: 'new', section80D: 10000, section80D_self: 0 },
      { regime: 'old', hra: 100000, homeLoanInterest: 200000 },
    ];
    for (const endpoint of ['/api/tax/compute', '/api/tax/compare']) {
      for (const extra of values) {
        const { response, body } = await jsonRequest(baseUrl + endpoint, {
          method: 'POST',
          body: JSON.stringify({
            income: 2000000, incomeSource: 'salary', age: 65,
            fiscalYear: 'FY2026-27', ...extra,
          }),
        });
        assert.equal(response.status, 410, JSON.stringify({ endpoint, extra, body }));
        assert.equal(body.code, 'TAX_LEGACY_ENDPOINT_RETIRED');
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(Object.hasOwn(body, 'inputsUsed'), false);
        assert.equal(Object.hasOwn(body, 'old_regime'), false);
        assert.equal(Object.hasOwn(body, 'optimized_old_regime_tax'), false);
        assert.equal(Object.hasOwn(body, 'recommended_regime'), false);
      }
    }
  });
});
