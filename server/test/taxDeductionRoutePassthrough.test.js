import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import taxRoutes from '../routes/tax.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { jsonRequest, withServer } from '../test-utils/httpTestUtils.js';

function buildTaxApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tax', taxRoutes);
  app.use(errorHandler);
  return app;
}

test('tax compute and compare preserve validated 80CCD, 80EEA, savings-interest, 80TTA, and 80TTB inputs', async () => {
  await withServer(buildTaxApp(), async baseUrl => {
    const computeBase = {
      income: 2_000_000,
      regime: 'old',
      incomeSource: 'salary',
      age: 45,
      fiscalYear: 'FY2026-27',
    };
    const baselineCompute = await jsonRequest(`${baseUrl}/api/tax/compute`, {
      method: 'POST',
      body: JSON.stringify(computeBase),
    });
    for (const field of ['savingsInterest', 'section80TTA', 'section80TTB']) {
      const missingAge = await jsonRequest(`${baseUrl}/api/tax/compute`, {
        method: 'POST',
        body: JSON.stringify({ ...computeBase, regime: 'new', age: undefined, [field]: 1 }),
      });
      assert.equal(missingAge.response.status, 400, `${field} without age must fail validation before compute`);
      assert.equal(missingAge.body.code, 'VALIDATION_ERROR');
    }
    const compute = await jsonRequest(`${baseUrl}/api/tax/compute`, {
      method: 'POST',
      body: JSON.stringify({
        ...computeBase,
        section80CCD: 50_000,
        section80EEA: 150_000,
        savingsInterest: 15_000,
        section80TTA: 10_000,
        section80TTB: 40_000,
        other: 0,
      }),
    });
    const conflictingCompute = await jsonRequest(`${baseUrl}/api/tax/compute`, {
      method: 'POST',
      body: JSON.stringify({
        ...computeBase,
        nps80CCD1B: 0,
        section80CCD: 50_000,
      }),
    });
    const equalAliasesCompute = await jsonRequest(`${baseUrl}/api/tax/compute`, {
      method: 'POST',
      body: JSON.stringify({
        ...computeBase,
        nps80CCD1B: 50_000,
        section80CCD: 50_000,
      }),
    });

    assert.equal(baselineCompute.response.status, 200);
    assert.equal(compute.response.status, 200, JSON.stringify(compute.body));
    assert.equal(conflictingCompute.response.status, 400);
    assert.equal(conflictingCompute.body.code, 'VALIDATION_ERROR');
    assert.ok(conflictingCompute.body.details.some(detail => detail.includes('NPS_80CCD1B_CONFLICTING_INPUTS')));
    assert.equal(equalAliasesCompute.response.status, 200, JSON.stringify(equalAliasesCompute.body));
    assert.equal(equalAliasesCompute.body.inputsUsed.deductions.nps80CCD1B, 50_000);
    assert.equal(equalAliasesCompute.body.inputsUsed.deductions.section80CCD, 50_000);
    assert.equal(equalAliasesCompute.body.taxableIncome, baselineCompute.body.taxableIncome - 50_000);
    assert.deepEqual({
      section80CCD: compute.body.inputsUsed.deductions.section80CCD,
      section80EEA: compute.body.inputsUsed.deductions.section80EEA,
      savingsInterest: compute.body.inputsUsed.deductions.savingsInterest,
      section80TTA: compute.body.inputsUsed.deductions.section80TTA,
      section80TTB: compute.body.inputsUsed.deductions.section80TTB,
      other: compute.body.inputsUsed.deductions.other,
    }, {
      section80CCD: 50_000,
      section80EEA: 150_000,
      savingsInterest: 15_000,
      section80TTA: 10_000,
      section80TTB: 40_000,
      other: 0,
    });
    assert.equal(compute.body.taxableIncome, baselineCompute.body.taxableIncome - 210_000);
    const granular80D = await jsonRequest(baseUrl + '/api/tax/compute', {
      method: 'POST',
      body: JSON.stringify({ ...computeBase, section80D_self: 0, section80D_parents: 0 }),
    });
    const conflicting80D = await jsonRequest(baseUrl + '/api/tax/compute', {
      method: 'POST',
      body: JSON.stringify({ ...computeBase, section80D: 0, section80D_self: 0 }),
    });
    assert.equal(granular80D.response.status, 200, JSON.stringify(granular80D.body));
    assert.equal(Object.hasOwn(granular80D.body.inputsUsed.deductions, 'section80D'), false);
    assert.equal(granular80D.body.inputsUsed.deductions.section80D_self, 0);
    assert.equal(granular80D.body.inputsUsed.deductions.section80D_parents, 0);
    assert.equal(conflicting80D.response.status, 400);

    const compareBase = {
      income: 2_000_000,
      incomeSource: 'salary',
      age: 65,
      fiscalYear: 'FY2026-27',
    };
    const baselineCompare = await jsonRequest(`${baseUrl}/api/tax/compare`, {
      method: 'POST',
      body: JSON.stringify(compareBase),
    });
    const compare = await jsonRequest(`${baseUrl}/api/tax/compare`, {
      method: 'POST',
      body: JSON.stringify({
        ...compareBase,
        savingsInterest: 60_000,
        section80TTA: 10_000,
        section80TTB: 10_000,
      }),
    });

    assert.equal(baselineCompare.response.status, 200);
    assert.equal(compare.response.status, 200, JSON.stringify(compare.body));
    assert.equal(compare.body.inputsUsed.deductions.savingsInterest, 60_000);
    assert.equal(compare.body.inputsUsed.deductions.section80TTA, 10_000);
    assert.equal(compare.body.inputsUsed.deductions.section80TTB, 10_000);
    assert.equal(compare.body.old_regime.taxable_income, baselineCompare.body.old_regime.taxable_income - 50_000);
    const conflictingCompare = await jsonRequest(baseUrl + '/api/tax/compare', {
      method: 'POST',
      body: JSON.stringify({ ...compareBase, section80CCD: 50_000, nps80CCD1B: 0 }),
    });
    assert.equal(conflictingCompare.response.status, 400);
    assert.equal(conflictingCompare.body.code, 'VALIDATION_ERROR');
    assert.ok(conflictingCompare.body.details.some(detail => detail.includes('NPS_80CCD1B_CONFLICTING_INPUTS')));
  });
});
