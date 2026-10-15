import assert from 'node:assert/strict';
import test from 'node:test';
import { taxCompareSchema, taxComputeSchema } from '../validation/schemas.js';

const MAX_ANNUAL_INCOME = 1_000_000_000;

test('tax request schemas accept the backend annual-income ceiling and reject values above it', () => {
  const sharedInputs = {
    income: MAX_ANNUAL_INCOME,
    incomeSource: 'salary',
    fiscalYear: 'FY2026-27',
    age: 35,
  };

  assert.equal(taxComputeSchema.validate({ ...sharedInputs, regime: 'new' }).error, undefined);
  assert.equal(taxCompareSchema.validate(sharedInputs).error, undefined);

  const invalidCompute = taxComputeSchema.validate({ ...sharedInputs, income: MAX_ANNUAL_INCOME + 1, regime: 'new' });
  const invalidCompare = taxCompareSchema.validate({ ...sharedInputs, income: MAX_ANNUAL_INCOME + 1 });
  assert.ok(invalidCompute.error?.details.some(detail => detail.path.join('.') === 'income'));
  assert.ok(invalidCompare.error?.details.some(detail => detail.path.join('.') === 'income'));
});
