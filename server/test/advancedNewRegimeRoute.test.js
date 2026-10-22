import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import taxRoutes from '../routes/tax.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { jsonRequest, withServer } from '../test-utils/httpTestUtils.js';

const input = Object.freeze({
  taxYear: '2026-27',
  incomeType: 'salary',
  primaryIncome: '1500000',
  otherOrdinaryIncome: '0',
  residency: 'resident',
  employerNpsContribution: '200000',
  npsEligibleSalary: '1000000',
  lotteryWinnings: '0',
  housePropertyLoss: '200000',
  confirmedNpsIncludedInSalary: true,
  confirmedNoOtherTaxAdjustments: true,
});
const endpoint = '/api/tax/new-regime-advanced';
const post = (baseUrl, payload) => jsonRequest(baseUrl + endpoint, { method: 'POST', body: JSON.stringify(payload) });
function app() {
  const server = express();
  server.use(express.json({ strict: true }));
  server.use('/api/tax', taxRoutes);
  server.use(errorHandler);
  return server;
}

test('HTTP qualified NPS and house-loss result has exact bound ledger and no-store', async () => {
  await withServer(app(), async baseUrl => {
    const { response, body } = await post(baseUrl, input);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(body.status, 'CALCULATED');
    assert.deepEqual(body.inputsUsed, input);
    assert.equal(body.employerNpsDeduction, '140000.0000');
    assert.equal(body.excessNpsNotDeducted, '60000.0000');
    assert.equal(body.housePropertyLossNotSetOff, '200000.0000');
    assert.equal(body.finalTax, '75660');
  });
});

test('HTTP lottery special-rate calculation never inherits ordinary-rate rebate', async () => {
  await withServer(app(), async baseUrl => {
    const { response, body } = await post(baseUrl, {
      ...input, incomeType: 'already_taxable', primaryIncome: '0',
      employerNpsContribution: '0', npsEligibleSalary: '0',
      confirmedNpsIncludedInSalary: false, housePropertyLoss: '0',
      lotteryWinnings: '100000',
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(body.status, 'CALCULATED');
    assert.equal(body.rebate, '0.0000');
    assert.equal(body.specialIncomeTax, '30000.0000');
    assert.equal(body.finalTax, '31200');
  });
});

test('HTTP unqualified mixed surcharge returns unavailable, not speculative tax', async () => {
  await withServer(app(), async baseUrl => {
    const { response, body } = await post(baseUrl, {
      ...input, primaryIncome: '6000000',
      employerNpsContribution: '0', npsEligibleSalary: '0',
      confirmedNpsIncludedInSalary: false, lotteryWinnings: '10000',
    });
    assert.equal(response.status, 200);
    assert.equal(body.status, 'UNAVAILABLE');
    assert.equal(body.finalTax, null);
    assert.ok(body.unavailableReasons.includes('MIXED_SPECIAL_RATE_SURCHARGE_NEEDS_FULL_RETURN'));
  });
});

test('HTTP rejects false NPS confirmation, invalid decimals, unknown tax years, or extra claims', async () => {
  await withServer(app(), async baseUrl => {
    for (const patch of [
      { confirmedNpsIncludedInSalary: false },
      { employerNpsContribution: '100.000' },
      { incomeType: 'pension' },
      { specialRateIncome: 'capital_gains' },
      { primaryIncome: 1500000 },
    ]) {
      const { response, body } = await post(baseUrl, { ...input, ...patch });
      assert.equal(response.status, 400, JSON.stringify({ patch, body }));
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.ok(['INVALID_TAX_REQUEST', 'INVALID_MONEY'].includes(body.code));
    }
    const { response, body } = await post(baseUrl, { ...input, taxYear: '2027-28' });
    assert.equal(response.status, 422);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(body.code, 'UNSUPPORTED_TAX_YEAR');
  });
});
