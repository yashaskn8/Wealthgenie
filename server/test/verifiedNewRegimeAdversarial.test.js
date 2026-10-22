import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateVerifiedNewRegime } from '../services/verifiedNewRegimeCalculator.js';

const U = 10000n;
const min = (a, b) => a < b ? a : b;
const max = (a, b) => a > b ? a : b;
const slabs = [[400000n, 0n], [800000n, 5n], [1200000n, 10n], [1600000n, 15n], [2000000n, 20n], [2400000n, 25n], [1000000001n, 30n]];
const base = Object.freeze({ taxYear: '2026-27', incomeType: 'already_taxable', primaryIncome: '1200000', otherOrdinaryIncome: '0', residency: 'resident', specialRateIncome: 'no', confirmedOrdinaryOnly: true });
function amount(s) { const [a, b = ''] = s.split('.'); return BigInt(a) * 100n + BigInt(b.padEnd(2, '0') || '0'); }
function money(v) { return (v / 100n).toString() + '.' + (v % 100n).toString().padStart(2, '0'); }
function slabTax(income) {
  let start = 0n, tax = 0n;
  for (const [end, rate] of slabs) {
    tax += max(0n, min(income, end) - start) * rate * U / 100n;
    start = end;
  }
  return tax;
}
function surchargePct(income) { return income > 20000000n ? 25n : income > 10000000n ? 15n : income > 5000000n ? 10n : 0n; }
function oracle(input) {
  const primary = amount(input.primaryIncome), additional = amount(input.otherOrdinaryIncome);
  const deduction = input.incomeType === 'already_taxable' ? 0n : min(primary, 7500000n);
  const taxable = (((primary + additional - deduction) / 100n + 5n) / 10n) * 10n;
  const full = slabTax(taxable);
  const rebate = input.residency !== 'resident' ? 0n : taxable <= 1200000n
    ? min(full, 60000n * U)
    : max(0n, full - (taxable - 1200000n) * U);
  const remainder = full - rebate;
  const surcharge = remainder * surchargePct(taxable) / 100n;
  const threshold = taxable > 20000000n ? 20000000n : taxable > 10000000n ? 10000000n : 5000000n;
  const maxAtThreshold = slabTax(threshold) * (100n + surchargePct(threshold)) / 100n + max(0n, taxable - threshold) * U;
  const relief = taxable > 5000000n ? max(0n, remainder + surcharge - maxAtThreshold) : 0n;
  const cess = (remainder + surcharge - relief) * 4n / 100n;
  const total = remainder + surcharge - relief + cess;
  return { taxable, deduction, rebate, total: ((total / U + 5n) / 10n) * 10n };
}

test('red team: statute-grounded golden vectors', () => {
  const cases = [
    [{ primaryIncome: '1200000' }, '0'],
    [{ primaryIncome: '1210000' }, '10400'],
    [{ primaryIncome: '1250000' }, '52000'],
    [{ primaryIncome: '1200000', residency: 'non_resident' }, '62400'],
    [{ primaryIncome: '1275000', incomeType: 'salary' }, '0'],
    [{ primaryIncome: '5000000' }, '1123200'],
    [{ primaryIncome: '5000010' }, '1123210'],
  ];
  for (const [scenario, expected] of cases) {
    assert.equal(calculateVerifiedNewRegime({ ...base, ...scenario }).finalTax, expected, JSON.stringify(scenario));
  }
});

test('red team: 5000 seeded differential cases, decimals and tax reconciliation', () => {
  let seed = 37912n;
  const rnd = () => { seed = seed * 48271n % 2147483647n; return seed; };
  const marks = [0n,400000n,800000n,1200000n,1210000n,1250000n,1275000n,1600000n,2000000n,2400000n,5000000n,10000000n,20000000n,50000000n];
  let executed = 0;
  for (let i = 0; i < 5000; i += 1) {
    const principal = i < marks.length * 100
      ? max(0n, marks[Math.floor(i / 100)] * 100n + BigInt(i % 100 - 50) * 100n + rnd() % 100n)
      : rnd() * 47n % 100000000001n;
    const extra = i % 7 === 0 ? rnd() % 10000000n : 0n;
    if (principal + extra > 100000000000n) continue;
    const input = {
      ...base, primaryIncome: money(principal), otherOrdinaryIncome: money(extra),
      incomeType: i % 3 === 0 ? 'salary' : i % 3 === 1 ? 'pension' : 'already_taxable',
      residency: i % 2 === 0 ? 'resident' : 'non_resident',
    };
    const computed = calculateVerifiedNewRegime(input), expected = oracle(input);
    assert.equal(computed.taxableIncome, expected.taxable.toString(), 'income sample ' + i);
    assert.equal(computed.finalTax, expected.total.toString(), 'tax sample ' + i);
    assert.equal(BigInt(computed.rebate.replace('.', '')), expected.rebate, 'rebate sample ' + i);
    assert.equal(BigInt(computed.standardDeduction.replace('.', '')), expected.deduction * 100n, 'deduction sample ' + i);
    assert.equal(BigInt(computed.finalTax) % 10n, 0n);
    executed += 1;
  }
  assert.ok(executed >= 4500, 'differential test did not execute enough cases');
});

test('red team: stable repeatability, financial identities and official citations', () => {
  const input = { ...base, primaryIncome: '1275000.25', otherOrdinaryIncome: '999.75', incomeType: 'salary' };
  const actual = calculateVerifiedNewRegime(input);
  assert.deepEqual(actual, calculateVerifiedNewRegime(input));
  assert.deepEqual(actual.inputsUsed, input);
  assert.ok(actual.sourceReferences.length >= 4);
  for (const url of actual.sourceReferences) assert.match(url, /^https:\/\/www\.incometaxindia\.gov\.in\//);
  const cash = k => BigInt(actual[k].replace('.', ''));
  assert.equal(cash('grossPrimaryIncome') + cash('otherOrdinaryIncome') - cash('standardDeduction'), cash('taxableIncomeBeforeRounding'));
  assert.equal(cash('taxBeforeRebate') - cash('rebate'), cash('taxAfterRebate'));
  assert.equal(cash('taxAfterRebate') + cash('surcharge') - cash('surchargeMarginalRelief') + cash('cess'), cash('taxBeforeStatutoryRounding'));
});

test('red team: malformed, unqualified and unknown scenarios cannot yield a figure', () => {
  for (const patch of [
    { taxYear: '2027-28' }, { taxYear: '2025-26' },
    { incomeType: 'family_pension' }, { incomeType: 'business' },
    { primaryIncome: '1e6' }, { primaryIncome: '-0.01' },
    { primaryIncome: '000000' }, { primaryIncome: '1.001' },
    { otherOrdinaryIncome: 500 }, { residency: 'overseas' },
    { section80C: '1000' }, { regime: 'old' }, { confirmedOrdinaryOnly: 1 },
  ]) assert.throws(() => calculateVerifiedNewRegime({ ...base, ...patch }));
  for (const patch of [
    { residency: 'unknown' }, { specialRateIncome: 'yes' },
    { specialRateIncome: 'unknown' }, { confirmedOrdinaryOnly: false },
  ]) {
    const actual = calculateVerifiedNewRegime({ ...base, ...patch });
    assert.equal(actual.status, 'UNAVAILABLE');
    assert.equal(actual.finalTax, null);
    assert.ok(actual.unavailableReasons.length > 0);
  }
});
