import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateAdvancedNewRegime as compute } from '../services/advancedNewRegimeCalculator.js';

const base = Object.freeze({
  taxYear: '2026-27',
  incomeType: 'already_taxable',
  primaryIncome: '1200000',
  otherOrdinaryIncome: '0',
  residency: 'resident',
  employerNpsContribution: '0',
  npsEligibleSalary: '0',
  lotteryWinnings: '0',
  housePropertyLoss: '0',
  confirmedNpsIncludedInSalary: false,
  confirmedNoOtherTaxAdjustments: true,
});
const run = patch => compute({ ...base, ...patch });

test('legacy ordinary-only calculation remains identical when advanced additions are zero', () => {
  const cases = [['1200000', '0'], ['1210000', '10400'], ['1250000', '52000'],
    ['5000000', '1123200'], ['5000010', '1123210'],
    ['10000000', '2951520'], ['20000000', '6673680']];
  for (const [amount, result] of cases) {
    const r = run({ primaryIncome: amount });
    assert.equal(r.status, 'CALCULATED');
    assert.equal(r.finalTax, result, amount);
  }
});

test('Section 124 employer NPS caps at 14% of declared basic/DA salary', () => {
  const r = run({
    incomeType: 'salary', primaryIncome: '1500000', npsEligibleSalary: '1000000',
    employerNpsContribution: '200000', confirmedNpsIncludedInSalary: true,
  });
  assert.equal(r.employerNpsDeduction, '140000.0000');
  assert.equal(r.excessNpsNotDeducted, '60000.0000');
  assert.equal(r.standardDeduction, '75000.0000');
  assert.equal(r.ordinaryTaxableIncome, '1285000');
  assert.equal(r.finalTax, '75660');
  assert.equal(r.inputsUsed.primaryIncome, '1500000');
});

test('Section 124 NPS employer contribution cannot be double deducted or applied to own pension', () => {
  for (const patch of [
    { employerNpsContribution: '50000', npsEligibleSalary: '500000' },
    { employerNpsContribution: '50000', npsEligibleSalary: '500000', confirmedNpsIncludedInSalary: true },
    { incomeType: 'salary', primaryIncome: '100000', employerNpsContribution: '1000', npsEligibleSalary: '150000', confirmedNpsIncludedInSalary: true },
    { incomeType: 'salary', employerNpsContribution: '1000', npsEligibleSalary: '50000', confirmedNpsIncludedInSalary: false },
    { npsEligibleSalary: '100000' },
    { confirmedNpsIncludedInSalary: true },
  ]) assert.throws(() => run(patch), e => e.code === 'INVALID_TAX_REQUEST');
});

test('Section 122: employer NPS never creates an artificial negative ordinary tax base', () => {
  for (const patch of [
    { incomeType: 'salary', primaryIncome: '10000', npsEligibleSalary: '10000',
      employerNpsContribution: '1000', confirmedNpsIncludedInSalary: true },
    { incomeType: 'salary', primaryIncome: '80000', npsEligibleSalary: '80000',
      employerNpsContribution: '10000', confirmedNpsIncludedInSalary: true,
      lotteryWinnings: '100000' },
  ]) {
    const result = run(patch);
    assert.equal(result.status, 'UNAVAILABLE', JSON.stringify(patch));
    assert.equal(result.finalTax, null);
    assert.ok(result.unavailableReasons.includes('NPS_DEDUCTION_EXCEEDS_QUALIFIED_ORDINARY_INCOME'));
    assert.ok(result.sourceReferences.includes('https://www.incometaxindia.gov.in/w/section-122-96'));
  }
  // The same NPS deduction is allowed when separately qualified ordinary
  // income gives it a sufficient base after the standard deduction.
  const supported = run({ incomeType: 'salary', primaryIncome: '80000',
    otherOrdinaryIncome: '10000', npsEligibleSalary: '80000',
    employerNpsContribution: '10000', confirmedNpsIncludedInSalary: true });
  assert.equal(supported.status, 'CALCULATED');
  assert.equal(supported.employerNpsDeduction, '10000.0000');
  assert.equal(supported.ordinaryTaxableIncome, '5000');
});

test('Section 202: net house-property loss is explicitly NOT offset against other income', () => {
  const r = run({ primaryIncome: '1200000', housePropertyLoss: '200000', residency: 'non_resident' });
  assert.equal(r.finalTax, '62400'); // 12L nonresident income, not 10L
  assert.equal(r.housePropertyLossNotSetOff, '200000.0000');
  assert.ok(r.notes.some(note => /carry-forward eligibility/i.test(note)));
});

test('Section 194: lottery winnings alone taxed 30%, never rebated even when resident income <12L', () => {
  const r = run({ primaryIncome: '0', lotteryWinnings: '100000' });
  assert.equal(r.ordinaryTaxBeforeRebate, '0.0000');
  assert.equal(r.specialIncomeTax, '30000.0000');
  assert.equal(r.rebate, '0.0000');
  assert.equal(r.cess, '1200.0000');
  assert.equal(r.finalTax, '31200');
});

test('low-income mixed case: no rebate is consumed by special-rate tax', () => {
  const r = run({ primaryIncome: '1100000', lotteryWinnings: '100000' });
  assert.equal(r.ordinaryTaxBeforeRebate, '50000.0000');
  assert.equal(r.specialIncomeTax, '30000.0000');
  assert.equal(r.rebate, '50000.0000');
  assert.equal(r.finalTax, '31200');
});

test('above 12L, Section 156 marginal rebate is capped at ordinary-income tax', () => {
  const resident = run({ primaryIncome: '1200000', lotteryWinnings: '10000' });
  assert.equal(resident.ordinaryTaxBeforeRebate, '60000.0000');
  assert.equal(resident.specialIncomeTax, '3000.0000');
  assert.equal(resident.rebate, '53000.0000');
  assert.equal(resident.finalTax, '10400');
  const nonresident = run({ primaryIncome: '1200000', lotteryWinnings: '10000', residency: 'non_resident' });
  assert.equal(nonresident.rebate, '0.0000');
  assert.equal(nonresident.finalTax, '65520');
});

test('mixed income refuses high-income surcharge and ambiguous component rounding', () => {
  for (const patch of [
    { primaryIncome: '4990000', lotteryWinnings: '20000' },
    { primaryIncome: '100000', lotteryWinnings: '100.01' },
    { primaryIncome: '100000.10', lotteryWinnings: '100' },
    { primaryIncome: '100000', lotteryWinnings: '100', confirmedNoOtherTaxAdjustments: false },
  ]) {
    const r = run(patch);
    assert.equal(r.status, 'UNAVAILABLE', JSON.stringify(patch));
    assert.equal(r.finalTax, null);
    assert.ok(r.unavailableReasons.length > 0);
  }
});

test('never assume an unknown residential status or an undisclosed return context', () => {
  for (const patch of [{ residency: 'unknown' }, { confirmedNoOtherTaxAdjustments: false }]) {
    const r = run(patch);
    assert.equal(r.status, 'UNAVAILABLE');
    assert.equal(r.finalTax, null);
  }
});

test('strict money and field shape, refuse old years and disallowed deductions', () => {
  for (const patch of [
    { primaryIncome: 1200000 }, { employerNpsContribution: '-1' },
    { lotteryWinnings: '1e5' }, { housePropertyLoss: '10.001' },
    { section80C: '150000' }, { legacyRegime: 'old' },
    { confirmedNoOtherTaxAdjustments: 'true' },
  ]) assert.throws(() => run(patch));
  assert.throws(() => run({ taxYear: '2027-28' }), e => e.code === 'UNSUPPORTED_TAX_YEAR');
  assert.throws(() => run({ primaryIncome: '1000000000', lotteryWinnings: '0.01' }), e => e.code === 'INVALID_MONEY');
});

test('accounting identities and ₹10 rounding hold across 4200 seeded supported cases', () => {
  let seed = 1729n;
  const next = () => { seed = seed * 48271n % 2147483647n; return seed; };
  for (let i = 0; i < 4200; i += 1) {
    const baseIncome = (next() % 95000000n) * 10n;
    const special = i % 2 === 0 && baseIncome < 4800000n
      ? (next() % 10000n) * 10n : 0n;
    const r = run({
      primaryIncome: baseIncome.toString(),
      lotteryWinnings: special.toString(),
      residency: i % 3 === 0 ? 'non_resident' : 'resident',
      housePropertyLoss: i % 5 === 0 ? '200000' : '0',
    });
    assert.equal(r.status, 'CALCULATED', 'case ' + i);
    assert.equal(BigInt(r.finalTax) % 10n, 0n);
    const four = k => BigInt(r[k].replace('.', ''));
    const beforeCess = four('ordinaryTaxBeforeRebate') + four('specialIncomeTax')
      - four('rebate') + four('surcharge') - four('surchargeMarginalRelief');
    assert.equal(beforeCess * 4n / 100n, four('cess'));
    assert.equal(beforeCess + four('cess'), four('taxBeforeStatutoryRounding'));
    assert.equal(((four('taxBeforeStatutoryRounding') / 10000n + 5n) / 10n) * 10n, BigInt(r.finalTax));
    assert.equal(
      four('grossOrdinaryIncome') - four('standardDeduction') - four('employerNpsDeduction'),
      BigInt(r.ordinaryTaxableIncome) * 10000n,
      'ordinary income identity ' + i,
    );
  }
});


test('red team: employer NPS 14% ceiling must not silently truncate fractions of one paisa', () => {
  // ₹100.01 * 14% = ₹14.0014, which cannot be represented by integer paise.
  // A binding statutory cap is declined instead of silently converting it to ₹14.00.
  const unsupported = run({
    incomeType: 'salary', primaryIncome: '1500000',
    npsEligibleSalary: '100.01', employerNpsContribution: '14.01',
    confirmedNpsIncludedInSalary: true,
  });
  assert.equal(unsupported.status, 'UNAVAILABLE');
  assert.equal(unsupported.finalTax, null);
  assert.ok(unsupported.unavailableReasons.includes('NPS_14_PERCENT_CAP_REQUIRES_SUB_PAISE_PRECISION'));
  // Contribution below a fractional ceiling is exact because the actual
  // contribution, not the 14% ceiling, binds the allowable deduction.
  const exactContribution = run({
    incomeType: 'salary', primaryIncome: '1500000',
    npsEligibleSalary: '100.01', employerNpsContribution: '14.00',
    confirmedNpsIncludedInSalary: true,
  });
  assert.equal(exactContribution.status, 'CALCULATED');
  assert.equal(exactContribution.employerNpsDeduction, '14.0000');
  // An exact whole-paise percentage ceiling can be applied normally.
  const exactCeiling = run({
    incomeType: 'salary', primaryIncome: '1500000',
    npsEligibleSalary: '100.00', employerNpsContribution: '14.01',
    confirmedNpsIncludedInSalary: true,
  });
  assert.equal(exactCeiling.status, 'CALCULATED');
  assert.equal(exactCeiling.employerNpsDeduction, '14.0000');
});
