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


test('independently anchored legal boundary vectors protect all surcharge cliffs and paise rounding', () => {
  // Statutory slabs: Income-tax Act, 2025 section 202; rebate: section 156;
  // rounding: section 516; surcharge/marginal relief: Finance Act, 2026.
  // Fixed expected outputs are NOT generated by the function under test.
  const golden = [
    ['0', '0'],
    ['400000', '0'],
    ['800000', '0'],
    ['1200000', '0'],
    ['1200004.99', '0'],
    ['1200005.00', '10'],
    ['1200014.99', '10'],
    ['1200015.00', '20'],
    ['1210000', '10400'],
    ['1250000', '52000'],
    ['1270000', '72800'],
    ['1271000', '73480'],
    ['1300000', '78000'],
    ['2400000', '312000'],
    ['3000000', '499200'],
    ['5000000', '1123200'],
    ['5000004.99', '1123200'],
    ['5000005.00', '1123210'],
    ['10000000', '2951520'],
    ['10000010', '2951530'],
    ['20000000', '6673680'],
    ['20000010', '6673690'],
    ['50000000', '18954000'],
  ];
  for (const [primaryIncome, expectedTax] of golden) {
    const result = run({ primaryIncome });
    assert.equal(result.finalTax, expectedTax, 'income=' + primaryIncome);
    assert.equal(BigInt(result.finalTax) % 10n, 0n);
  }
});

test('already-taxable income never silently gets a second salary deduction', () => {
  const taxable = run({ incomeType: 'already_taxable', primaryIncome: '1300000' });
  assert.equal(taxable.standardDeduction, '0.0000');
  assert.equal(taxable.taxableIncome, '1300000');
  assert.equal(taxable.finalTax, '78000');

  const salaryBeforeDeduction = run({ incomeType: 'salary', primaryIncome: '1300000' });
  assert.equal(salaryBeforeDeduction.standardDeduction, '75000.0000');
  assert.equal(salaryBeforeDeduction.taxableIncome, '1225000');
  assert.equal(salaryBeforeDeduction.finalTax, '26000');

  const pension = run({ incomeType: 'pension', primaryIncome: '1275005.00' });
  assert.equal(pension.taxableIncome, '1200010');
  assert.equal(pension.finalTax, '10');
  const nonresident = run({ incomeType: 'salary', primaryIncome: '1275000', residency: 'non_resident' });
  assert.equal(nonresident.rebate, '0.0000');
  assert.equal(nonresident.finalTax, '62400');
});


test('official Finance Ministry examples remain accurate before and after 4% cess', () => {
  // Budget 2026 FAQ Q.7-9 publishes the pre-cess liabilities of ₹10,000,
  // ₹25,000 and ₹50,000 for taxable income ₹12.10L, ₹12.25L and ₹12.50L.
  // Finance Act 2026 adds 4% Health & Education Cess after rebate.
  const independentlyPublished = [
    { income: '1210000', beforeCess: '10000.0000', cess: '400.0000', payable: '10400' },
    { income: '1225000', beforeCess: '25000.0000', cess: '1000.0000', payable: '26000' },
    { income: '1250000', beforeCess: '50000.0000', cess: '2000.0000', payable: '52000' },
  ];
  for (const { income, beforeCess, cess, payable } of independentlyPublished) {
    const answer = run({ primaryIncome: income });
    assert.equal(answer.status, 'CALCULATED');
    assert.equal(answer.taxAfterRebate, beforeCess, income);
    assert.equal(answer.cess, cess, income);
    assert.equal(answer.finalTax, payable, income);
  }
});

test('salary and ordinary interest cannot change liability solely by splitting the same qualifying taxable income', () => {
  for (const taxableIncome of ['0', '400000', '800000', '1200000', '1210000', '1250000', '1300000', '5000000', '10000000', '20000000']) {
    const income = BigInt(taxableIncome);
    const baseTax = run({ primaryIncome: taxableIncome });
    const salary = run({ incomeType: 'salary', primaryIncome: (income + 75000n).toString() });
    const pension = run({ incomeType: 'pension', primaryIncome: (income + 75000n).toString() });
    assert.equal(salary.taxableIncome, taxableIncome, 'salary ' + taxableIncome);
    assert.equal(pension.taxableIncome, taxableIncome, 'pension ' + taxableIncome);
    assert.equal(salary.finalTax, baseTax.finalTax, 'salary ' + taxableIncome);
    assert.equal(pension.finalTax, baseTax.finalTax, 'pension ' + taxableIncome);
    if (income >= 100000n) {
      const salaryInterest = run({
        incomeType: 'salary', primaryIncome: (income - 25000n).toString(),
        otherOrdinaryIncome: '100000',
      });
      assert.equal(salaryInterest.finalTax, baseTax.finalTax, 'salary + interest ' + taxableIncome);
    }
  }
});
