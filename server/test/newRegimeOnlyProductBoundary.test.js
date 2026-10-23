import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import taxRoutes from '../routes/tax.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { jsonRequest, withServer } from '../test-utils/httpTestUtils.js';
import { taxComputeSchema, postTaxReturnSchema, postTaxReturnBatchSchema } from '../validation/schemas.js';
import { calculateCanonicalPostTaxOutcome } from '../services/taxEventProjectionEngine.js';
import { FinancialToolRegistry } from '../services/financialToolRegistry.js';

function appForTax() {
  const app = express();
  app.use(express.json({ strict: true }));
  app.use('/api/tax', taxRoutes);
  app.use(errorHandler);
  return app;
}

test('retired tax compare/compute APIs never calculate or recommend an old regime', async () => {
  await withServer(appForTax(), async origin => {
    for (const endpoint of ['/compute', '/compare']) {
      for (const regime of ['old', 'new']) {
        const { response, body } = await jsonRequest(origin + '/api/tax' + endpoint, {
          method: 'POST',
          body: JSON.stringify({
            income: 1200000, fiscalYear: 'FY2026-27',
            incomeSource: 'salary', age: 35, regime,
          }),
        });
        assert.equal(response.status, 410, endpoint + ': ' + JSON.stringify(body));
        assert.equal(body.code, 'TAX_LEGACY_ENDPOINT_RETIRED');
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(Object.hasOwn(body, 'old_regime'), false);
        assert.equal(Object.hasOwn(body, 'recommended_regime'), false);
      }
    }
  });
});

test('active tax calculation request contracts reject explicitly old regime', () => {
  const compute = { income: 1200000, incomeSource: 'salary', fiscalYear: 'FY2026-27', regime: 'old' };
  const returnBase = {
    annualIncome: 1200000, incomeSource: 'salary', fiscalYear: 'FY2026-27',
    userAge: 35, regime: 'old', holdingYears: 10, monthlySIP: 1000,
    nominalRate: 0.07, instrumentType: 'FD',
  };
  const batch = {
    annualIncome: 1200000, incomeSource: 'salary', fiscalYear: 'FY2026-27',
    userAge: 35, regime: 'old', inflationRate: 0.05,
    instruments: [{ holdingYears: 10, monthlySIP: 1000, nominalRate: 0.07, instrumentType: 'FD' }],
  };
  for (const [schema, payload] of [
    [taxComputeSchema, compute], [postTaxReturnSchema, returnBase], [postTaxReturnBatchSchema, batch],
  ]) {
    const result = schema.validate(payload, { abortEarly: false });
    assert.ok(result.error);
    assert.ok(result.error.details.some(entry => entry.path.includes('regime')),
      JSON.stringify(result.error.details));
  }
});

test('post-tax financial engine fails closed for legacy tax contexts, without relabeling', () => {
  const result = calculateCanonicalPostTaxOutcome({
    instrumentType: 'FD', nominalRate: 0.07, annualIncome: 1200000,
    holdingYears: 10, regime: 'old', monthlySIP: 1000, userAge: 35,
    incomeSource: 'salary', fiscalYear: 'FY2026-27',
  });
  assert.notEqual(result.status, 'CALCULATED');
  assert.equal(result.postTaxReturn, null);
  assert.ok(result.unavailableReasons?.includes('UNSUPPORTED_TAX_REGIME_NEW_ONLY')
    || result.requiredTaxInputs?.includes('UNSUPPORTED_TAX_REGIME_NEW_ONLY')
    || result.reasons?.includes('UNSUPPORTED_TAX_REGIME_NEW_ONLY'),
    JSON.stringify(result));
});

test('financial tool registry blocks old regime before calling the tax engine', async () => {
  const result = await FinancialToolRegistry.executeTool('tax_calculator', {
    income: 1200000, incomeSource: 'salary', fiscalYear: 'FY2026-27', age: 35, regime: 'old',
    section80C: 0, nps80CCD1B: 0, section80D_self: 0, section80D_parents: 0,
    parentsSenior: false, hra: 0,
  });
  assert.equal(result.success, false);
  assert.equal(result.result, null);
  assert.match(result.error, /regime/i);
});
