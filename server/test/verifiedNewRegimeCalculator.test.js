import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateVerifiedNewRegime } from '../services/verifiedNewRegimeCalculator.js';

const base = Object.freeze({
  taxYear: '2026-27',
  incomeType: 'already_taxable',
  primaryIncome: '1200000',
  otherOrdinaryIncome: '0',
  residency: 'resident',
  specialRateIncome: 'no',
  confirmedOrdinaryOnly: true,
});
const run = overrides => calculateVerifiedNewRegime({ ...base, ...overrides });

test('resident individual: ₹12 lakh ordinary taxable income produces ₹0 after ₹60,000 rebate', () => {
  const result = run({});
  assert.equal(result.status, 'CALCULATED');
  assert.equal(result.taxableIncome, '1200000');
  assert.equal(result.taxBeforeRebate, '60000.0000');
  assert.equal(result.rebate, '60000.0000');
  assert.equal(result.finalTax, '0');
  assert.equal(result.cess, '0.0000');
});

test('eligible gross salary ₹12.75 lakh benefits from ₹75,000 deduction', () => {
  const result = run({ incomeType: 'salary', primaryIncome: '1275000' });
  assert.equal(result.standardDeduction, '75000.0000');
  assert.equal(result.taxableIncome, '1200000');
  assert.equal(result.finalTax, '0');
});

test('standard deduction cannot exceed the actual salary or eligible own pension', () => {
  for (const incomeType of ['salary', 'pension']) {
    const result = run({ incomeType, primaryIncome: '50000' });
    assert.equal(result.standardDeduction, '50000.0000');
    assert.equal(result.finalTax, '0');
  }
  assert.equal(run({ incomeType: 'already_taxable', primaryIncome: '50000' }).standardDeduction, '0.0000');
});

test('₹12 lakh boundary: truncated paise, ₹10 income rounding, ₹10 final payable rounding', () => {
  const belowRounding = run({ primaryIncome: '1200004.99' });
  assert.equal(belowRounding.taxableIncome, '1200000');
  assert.equal(belowRounding.finalTax, '0');
  const aboveRounding = run({ primaryIncome: '1200005.00' });
  assert.equal(aboveRounding.taxableIncome, '1200010');
  assert.equal(aboveRounding.taxBeforeRebate, '60001.5000');
  assert.equal(aboveRounding.rebate, '59991.5000');
  assert.equal(aboveRounding.cess, '0.4000');
  assert.equal(aboveRounding.taxBeforeStatutoryRounding, '10.4000');
  assert.equal(aboveRounding.finalTax, '10');
});

test('Section 156 marginal rebate applies above ₹12 lakh only when eligible', () => {
  const r = run({ primaryIncome: '1250000' });
  assert.equal(r.taxBeforeRebate, '67500.0000');
  assert.equal(r.rebate, '17500.0000');
  assert.equal(r.cess, '2000.0000');
  assert.equal(r.finalTax, '52000');
  const noRelief = run({ primaryIncome: '1300000' });
  assert.equal(noRelief.rebate, '0.0000');
  assert.equal(noRelief.finalTax, '78000');
});

test('non-resident individual does not receive the resident-only rebate', () => {
  const r = run({ residency: 'non_resident' });
  assert.equal(r.rebate, '0.0000');
  assert.equal(r.taxBeforeRebate, '60000.0000');
  assert.equal(r.cess, '2400.0000');
  assert.equal(r.finalTax, '62400');
});

test('salary and additional ordinary-rate taxable interest are aggregated before rebate', () => {
  const r = run({ incomeType: 'salary', primaryIncome: '1275000', otherOrdinaryIncome: '50000' });
  assert.equal(r.taxableIncome, '1250000');
  assert.equal(r.finalTax, '52000');
});

test('slab rates include the 25% and 30% brackets', () => {
  const r = run({ primaryIncome: '3000000' });
  assert.equal(r.taxBeforeRebate, '480000.0000');
  assert.equal(r.finalTax, '499200');
  assert.equal(r.slabBreakdown.at(-1).percent, 30);
  assert.ok(r.slabBreakdown.some(row => row.percent === 25));
});

test('surcharge marginal relief prevents a cliff when crossing ₹50 lakh', () => {
  const at = run({ primaryIncome: '5000000' });
  const above = run({ primaryIncome: '5000010' });
  assert.equal(at.finalTax, '1123200');
  assert.equal(above.surcharge, '108000.3000');
  assert.equal(above.surchargeMarginalRelief, '107993.3000');
  assert.equal(above.finalTax, '1123210');
  assert.equal(BigInt(above.finalTax) - BigInt(at.finalTax), 10n);
});

test('additional surcharge thresholds are handled with capped 25% new-regime surcharge', () => {
  for (const income of ['10000000', '10000010', '20000000', '20000010', '50000000']) {
    const r = run({ primaryIncome: income });
    assert.equal(r.status, 'CALCULATED');
    assert.match(r.finalTax, /^\d+0$/);
    assert.ok(BigInt(r.finalTax) > 0n);
  }
  const over2cr = run({ primaryIncome: '20000010' });
  assert.ok(BigInt(over2cr.surcharge.split('.')[0]) > 0n);
});

test('unknown residency, special income or unconfirmed context never returns a false number', () => {
  for (const overrides of [
    { residency: 'unknown' },
    { specialRateIncome: 'yes' },
    { specialRateIncome: 'unknown' },
    { confirmedOrdinaryOnly: false },
  ]) {
    const r = run(overrides);
    assert.equal(r.status, 'UNAVAILABLE');
    assert.equal(r.finalTax, null);
    assert.ok(r.unavailableReasons.length > 0);
  }
});

test('reject unsupported tax years instead of reusing stale slabs', () => {
  assert.throws(() => run({ taxYear: '2027-28' }), e => e.code === 'UNSUPPORTED_TAX_YEAR');
  assert.throws(() => run({ taxYear: '2025-26' }), e => e.code === 'UNSUPPORTED_TAX_YEAR');
});

test('reject malformed, ambiguous, negative, exponential and excessive rupee amounts', () => {
  for (const amount of ['-1', '1.001', '1e6', ' 100', '01', '1,00,000', 'Infinity', 'NaN', '', '1000000001']) {
    assert.throws(() => run({ primaryIncome: amount }), e => e.code === 'INVALID_MONEY', amount);
  }
  assert.throws(() => run({ primaryIncome: 1200000 }), e => e.code === 'INVALID_MONEY');
  assert.throws(() => run({ primaryIncome: '1000000000', otherOrdinaryIncome: '0.01' }), e => e.code === 'INVALID_MONEY');
});

test('reject arbitrary extra deductions or mutable tax policy fields', () => {
  assert.throws(() => run({ section80C: '150000' }), e => e.code === 'INVALID_TAX_REQUEST');
  assert.throws(() => run({ regime: 'old' }), e => e.code === 'INVALID_TAX_REQUEST');
  assert.throws(() => run({ confirmedOrdinaryOnly: 'true' }), e => e.code === 'INVALID_TAX_REQUEST');
});

test('properties: monotonic rounded tax for supported resident and non-resident ordinary income', () => {
  for (const residency of ['resident', 'non_resident']) {
    let previous = -1n;
    for (let rupees = 1199500; rupees <= 1280500; rupees += 10) {
      const r = run({ primaryIncome: String(rupees), residency });
      const tax = BigInt(r.finalTax);
      assert.ok(tax >= previous, residency + ' ' + rupees);
      assert.equal(tax % 10n, 0n, residency + ' ' + rupees);
      previous = tax;
    }
  }
});
