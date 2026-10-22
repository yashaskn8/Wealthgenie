import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import taxRoutes from '../routes/tax.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { jsonRequest, withServer } from '../test-utils/httpTestUtils.js';

function appForTax() {
  const app = express();
  app.use(express.json({ strict: true }));
  app.use('/api/tax', taxRoutes);
  app.use(errorHandler);
  return app;
}
const input = Object.freeze({
  taxYear: '2026-27',
  incomeType: 'salary',
  primaryIncome: '1275000.00',
  otherOrdinaryIncome: '0',
  residency: 'resident',
  specialRateIncome: 'no',
  confirmedOrdinaryOnly: true,
});
const endpoint = '/api/tax/new-regime-verified';
const post = (baseUrl, payload) => jsonRequest(baseUrl + endpoint, {
  method: 'POST', body: JSON.stringify(payload),
});

test('HTTP endpoint returns correct rebate, canonical decimals and no-cache', async () => {
  await withServer(appForTax(), async baseUrl => {
    const { response, body } = await post(baseUrl, input);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(body.status, 'CALCULATED');
    assert.equal(body.standardDeduction, '75000.0000');
    assert.equal(body.taxableIncome, '1200000');
    assert.equal(body.taxBeforeRebate, '60000.0000');
    assert.equal(body.rebate, '60000.0000');
    assert.equal(body.finalTax, '0');
    assert.deepEqual(body.inputsUsed, input);
    assert.equal(body.slabBreakdown.reduce((sum, row) => sum + Number(row.tax), 0), 60000);
  });
});

test('HTTP endpoint fails closed for unknown residency and special-rate income', async () => {
  await withServer(appForTax(), async baseUrl => {
    for (const patch of [{ residency: 'unknown' }, { specialRateIncome: 'yes' }, { confirmedOrdinaryOnly: false }]) {
      const { response, body } = await post(baseUrl, { ...input, ...patch });
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.status, 'UNAVAILABLE');
      assert.equal(body.finalTax, null);
      assert.ok(body.unavailableReasons.length > 0);
    }
  });
});

test('HTTP endpoint rejects malformed money, additional fields, wrong types and unsupported tax year', async () => {
  await withServer(appForTax(), async baseUrl => {
    for (const payload of [
      { ...input, primaryIncome: 1275000 },
      { ...input, primaryIncome: '1275000.001' },
      { ...input, primaryIncome: '1e6' },
      { ...input, regime: 'old' },
      { ...input, confirmedOrdinaryOnly: 'true' },
      { ...input, primaryIncome: '1000000000', otherOrdinaryIncome: '0.01' },
    ]) {
      const { response, body } = await post(baseUrl, payload);
      assert.equal(response.status, 400, JSON.stringify({ payload, body }));
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.ok(['INVALID_MONEY', 'INVALID_TAX_REQUEST'].includes(body.code), JSON.stringify(body));
    }
    const { response, body } = await post(baseUrl, { ...input, taxYear: '2027-28' });
    assert.equal(response.status, 422);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(body.code, 'UNSUPPORTED_TAX_YEAR');
  });
});
