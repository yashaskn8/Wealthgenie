import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateVerifiedNewRegime } from '../services/verifiedNewRegimeCalculator.js';

// Release-blocking regression checks for the explicitly restricted TY 2026-27
// calculator. They do NOT claim that complex Indian income-tax returns are in scope.
const base = Object.freeze({
  taxYear: '2026-27',
  incomeType: 'already_taxable',
  primaryIncome: '1200000',
  otherOrdinaryIncome: '0',
  residency: 'resident',
  specialRateIncome: 'no',
  confirmedOrdinaryOnly: true,
});
const calculate = changes => calculateVerifiedNewRegime({ ...base, ...changes });
const units = (answer, key) => BigInt(answer[key].replace('.', ''));

test('red team: invalid shapes and polluted JSON inputs cannot pass the financial contract', () => {
  for (const malformed of [null, [], ['1200000'], 0, 1, '1200000', true]) {
    assert.throws(() => calculateVerifiedNewRegime(malformed), { code: 'INVALID_TAX_REQUEST' });
  }
  for (const key of ['__proto__', 'constructor', 'prototype', 'taxPolicyOverride', 'deductions', 'regime']) {
    const payload = JSON.parse(JSON.stringify(base));
    Object.defineProperty(payload, key, { value: { rebate: '1000000000' }, enumerable: true });
    assert.throws(() => calculateVerifiedNewRegime(payload), { code: 'INVALID_TAX_REQUEST' }, key);
  }
  const missing = { ...base };
  delete missing.residency;
  assert.throws(() => calculateVerifiedNewRegime(missing), { code: 'INVALID_TAX_REQUEST' });
  for (const field of ['residency', 'specialRateIncome', 'confirmedOrdinaryOnly', 'incomeType']) {
    const payload = { ...base, [field]: null };
    assert.throws(() => calculateVerifiedNewRegime(payload), { code: 'INVALID_TAX_REQUEST' }, field);
  }
});

test('red team: adversarial rupee strings never silently coerce or round before tax policy', () => {
  for (const invalid of [
    '-0', '-0.01', '+1', '.50', '1.', '1.000', '01', ' 1', '1 ', '1,00,000',
    '1e5', 'Infinity', 'NaN', '', '1_000', '0x10', '１２', '1000000000.01',
    '0000000000', '1\\n2', '1\\t2', '₹1000', '١٠٠', '1.2.3',
  ]) {
    assert.throws(() => calculate({ primaryIncome: invalid }), { code: 'INVALID_MONEY' }, invalid);
    assert.throws(() => calculate({ otherOrdinaryIncome: invalid }), { code: 'INVALID_MONEY' }, invalid);
  }
  for (const invalid of [0, 1200000, false, null, {}, [], 12.75]) {
    assert.throws(() => calculate({ primaryIncome: invalid }), { code: 'INVALID_MONEY' });
  }
  assert.throws(() => calculate({ primaryIncome: '1000000000', otherOrdinaryIncome: '0.01' }), { code: 'INVALID_MONEY' });
  assert.equal(calculate({ primaryIncome: '1000000000', otherOrdinaryIncome: '0' }).status, 'CALCULATED');
});

test('red team: uncertain facts and unsupported tax years never produce a payable figure', () => {
  for (const changes of [
    { residency: 'unknown' }, { specialRateIncome: 'unknown' }, { specialRateIncome: 'yes' },
    { confirmedOrdinaryOnly: false }, { residency: 'unknown', specialRateIncome: 'yes', confirmedOrdinaryOnly: false },
  ]) {
    const response = calculate(changes);
    assert.equal(response.status, 'UNAVAILABLE');
    assert.equal(response.finalTax, null);
    assert.ok(response.unavailableReasons.length > 0);
    assert.equal(Object.prototype.hasOwnProperty.call(response, 'taxBeforeRebate'), false);
  }
  for (const year of ['2025-26', '2027-28', '2026–27', '', null]) {
    assert.throws(() => calculate({ taxYear: year }), { code: 'UNSUPPORTED_TAX_YEAR' });
  }
});

test('red team: statutory landmarks, paise cutoff and four-decimal ledger integrity', () => {
  // Official Income-tax Act, 2025: sections 19, 156, 202, 516.
  const landmarks = [0n, 400000n, 800000n, 1200000n, 1200005n, 1210000n,
    1225000n, 1250000n, 1270588n, 1600000n, 2000000n, 2400000n,
    5000000n, 10000000n, 20000000n, 50000000n, 1000000000n];
  const deltas = [-501n, -500n, -499n, -101n, -100n, -99n, -1n, 0n, 1n, 99n, 100n, 101n, 499n, 500n, 501n];
  let checked = 0;
  for (const mark of landmarks) for (const delta of deltas) {
    const paise = mark * 100n + delta;
    if (paise < 0n || paise > 100000000000n) continue;
    const value = (paise / 100n).toString() + '.' + (paise % 100n).toString().padStart(2, '0');
    for (const residency of ['resident', 'non_resident']) {
      const r = calculate({ primaryIncome: value, residency });
      assert.equal(r.status, 'CALCULATED');
      assert.equal(BigInt(r.finalTax) % 10n, 0n, value);
      assert.equal(units(r, 'grossPrimaryIncome') + units(r, 'otherOrdinaryIncome') - units(r, 'standardDeduction'),
        units(r, 'taxableIncomeBeforeRounding'), value);
      assert.equal(units(r, 'taxBeforeRebate') - units(r, 'rebate'), units(r, 'taxAfterRebate'), value);
      assert.equal(units(r, 'taxAfterRebate') + units(r, 'surcharge') - units(r, 'surchargeMarginalRelief') + units(r, 'cess'),
        units(r, 'taxBeforeStatutoryRounding'), value);
      assert.equal(r.rebate, residency === 'non_resident' ? '0.0000' : r.rebate);
      checked += 1;
    }
  }
  assert.ok(checked > 450);
});

test('red team: 25,000 seeded scenarios maintain nonnegative, ten-rupee payable and consistent financial identities', () => {
  let state = 49837n;
  let checked = 0;
  for (let i = 0; i < 25000; i += 1) {
    state = state * 48271n % 2147483647n;
    const primaryPaise = (state * BigInt(i + 1)) % 100000000001n;
    state = state * 48271n % 2147483647n;
    const remaining = 100000000000n - primaryPaise;
    const additionalPaise = state % (remaining + 1n);
    const fmt = paise => (paise / 100n).toString() + '.' + (paise % 100n).toString().padStart(2, '0');
    const r = calculate({
      primaryIncome: fmt(primaryPaise), otherOrdinaryIncome: fmt(additionalPaise),
      incomeType: i % 3 === 0 ? 'salary' : i % 3 === 1 ? 'pension' : 'already_taxable',
      residency: i % 2 ? 'resident' : 'non_resident',
    });
    assert.equal(r.status, 'CALCULATED', String(i));
    assert.ok(BigInt(r.finalTax) >= 0n, String(i));
    assert.equal(BigInt(r.finalTax) % 10n, 0n, String(i));
    assert.equal(units(r, 'grossPrimaryIncome') + units(r, 'otherOrdinaryIncome') - units(r, 'standardDeduction'),
      units(r, 'taxableIncomeBeforeRounding'), String(i));
    assert.equal(units(r, 'taxBeforeRebate') - units(r, 'rebate'), units(r, 'taxAfterRebate'), String(i));
    assert.equal(units(r, 'taxAfterRebate') + units(r, 'surcharge') - units(r, 'surchargeMarginalRelief') + units(r, 'cess'),
      units(r, 'taxBeforeStatutoryRounding'), String(i));
    checked += 1;
  }
  assert.equal(checked, 25000);
});
