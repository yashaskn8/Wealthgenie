import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateVerifiedComplexCapitalGainsTax as calculate } from '../services/verifiedComplexCapitalGainsTax.js';

const BASE = Object.freeze({
  taxYear: '2026-27', residency: 'resident', incomeType: 'already_taxable',
  primaryIncome: '1500000', otherOrdinaryIncome: '0',
  stcg196: '200000', ltcg198: '225000',
  completeYearGainsConfirmed: true, sttAndClassificationConfirmed: true,
  noOtherTaxSituationsConfirmed: true,
});
const scenario = patch => calculate({ ...BASE, ...patch });
const lower = (a, b) => a < b ? a : b;

// Independent piecewise calculation, intentionally not importing the production
// slabs, policy internals, or production rounding utility.
function oracle({ incomeType, primaryIncome, otherOrdinaryIncome, stcg196, ltcg198 }) {
  const gross = BigInt(primaryIncome), other = BigInt(otherOrdinaryIncome);
  const short = BigInt(stcg196), long = BigInt(ltcg198);
  const deduction = incomeType === 'already_taxable' ? 0n : lower(gross, 75000n);
  const normal = gross + other - deduction;
  const combined = normal + short + long;
  if (normal < 1300000n || combined > 5000000n || short + long === 0n) {
    return { status: 'UNAVAILABLE' };
  }
  const brackets = [400000n, 800000n, 1200000n, 1600000n, 2000000n, 2400000n];
  const rates = [0n, 5n, 10n, 15n, 20n, 25n, 30n];
  let ordinaryTaxMilli = 0n;
  let preceding = 0n;
  for (let j = 0; j < rates.length; j += 1) {
    const upper = j < brackets.length ? brackets[j] : normal;
    const segment = lower(normal, upper) - preceding;
    if (segment > 0n) ordinaryTaxMilli += segment * rates[j] * 10n;
    preceding = upper;
  }
  const shortTaxMilli = short * 200n;
  const longTaxMilli = (long > 125000n ? long - 125000n : 0n) * 125n;
  const beforeCessMilli = ordinaryTaxMilli + shortTaxMilli + longTaxMilli;
  const cessMilli = beforeCessMilli * 4n / 100n;
  const grossTaxMilli = beforeCessMilli + cessMilli;
  const tax = ((grossTaxMilli / 1000n + 5n) / 10n) * 10n;
  return { status: 'CALCULATED', normal, combined, deduction, shortTaxMilli,
    longTaxMilli, ordinaryTaxMilli, cessMilli, grossTaxMilli, tax };
}

test('capital-gains red team: 4096 reproducible adversarial inputs against an independent oracle', () => {
  let state = 104729n, checked = 0, refused = 0;
  const next = () => { state = (state * 48271n) % 2147483647n; return state; };
  const marks = [0n, 1299990n, 1300000n, 1300010n, 2000000n, 2400000n, 4500000n, 4999990n, 5000000n];
  for (let i = 0; i < 4096; i += 1) {
    const choice = i % 3;
    const gross = i < marks.length * 25
      ? marks[Math.floor(i / 25)] + BigInt((i % 25) - 12) * 10n
      : next() % 510001n * 10n;
    const input = {
      ...BASE,
      incomeType: choice === 0 ? 'already_taxable' : choice === 1 ? 'salary' : 'pension',
      primaryIncome: (gross < 0n ? 0n : gross).toString(),
      otherOrdinaryIncome: (next() % 301n * 10n).toString(),
      stcg196: (next() % 80001n * 10n).toString(),
      ltcg198: (next() % 80001n * 10n).toString(),
    };
    const expected = oracle(input);
    const actual = calculate(input);
    assert.equal(actual.status, expected.status, 'eligibility at iteration ' + i);
    if (expected.status === 'UNAVAILABLE') {
      refused += 1;
      assert.equal(actual.finalTax, null);
      assert.ok(actual.unavailableReasons.length > 0);
      continue;
    }
    checked += 1;
    assert.equal(actual.ordinaryTaxableIncome, expected.normal.toString(), 'ordinary ' + i);
    assert.equal(actual.grossTotalIncome, expected.combined.toString(), 'total ' + i);
    assert.equal(actual.standardDeduction, expected.deduction.toString(), 'standard deduction ' + i);
    assert.equal(BigInt(actual.ordinarySlabTax.replace('.', '')), expected.ordinaryTaxMilli, 'slab ' + i);
    assert.equal(BigInt(actual.section196Tax.replace('.', '')), expected.shortTaxMilli, '196 ' + i);
    assert.equal(BigInt(actual.section198Tax.replace('.', '')), expected.longTaxMilli, '198 ' + i);
    assert.equal(BigInt(actual.cess.replace('.', '')), expected.cessMilli, 'cess ' + i);
    assert.equal(BigInt(actual.taxBeforeStatutoryRounding.replace('.', '')), expected.grossTaxMilli, 'total ' + i);
    assert.equal(actual.finalTax, expected.tax.toString(), 'final ' + i);
    assert.equal(BigInt(actual.finalTax) % 10n, 0n);
  }
  assert.ok(checked >= 1600, 'Insufficient calculated scenarios ' + checked);
  assert.ok(refused >= 200, 'Fail-closed cases were not exercised ' + refused);
});

test('capital-gains red team: amount permutations, one annual exemption, and strict gates', () => {
  for (const primaryIncome of ['1300000', '1500000', '2000000', '4000000']) {
    const allInOne = scenario({ primaryIncome, stcg196: '100000', ltcg198: '225000' });
    assert.equal(allInOne.status, 'CALCULATED');
    const shortOnly = scenario({ primaryIncome, stcg196: '100000', ltcg198: '0' });
    const longOnly = scenario({ primaryIncome, stcg196: '0', ltcg198: '225000' });
    assert.equal(shortOnly.section198Tax, '0.000');
    assert.equal(longOnly.section196Tax, '0.000');
    assert.equal(allInOne.section198ExemptLongTermGain, '125000');
    assert.equal(allInOne.section198Tax, '12500.000');
  }
  for (const patch of [
    { residency: 'unknown' }, { residency: 'non_resident' },
    { primaryIncome: '1299990' }, { primaryIncome: '5000000' },
    { completeYearGainsConfirmed: false },
    { sttAndClassificationConfirmed: false },
    { noOtherTaxSituationsConfirmed: false },
    { stcg196: '0', ltcg198: '0' },
  ]) {
    const result = scenario(patch);
    assert.equal(result.status, 'UNAVAILABLE', JSON.stringify(patch));
    assert.equal(result.finalTax, null);
  }
  for (const patch of [
    { primaryIncome: '1200000.01' }, { stcg196: '100.01' },
    { ltcg198: '-100' }, { otherOrdinaryIncome: '1000000001' },
    { specialRateIncome: 'no' }, { taxYear: '2025-26' },
    { incomeType: 'business' }, { residency: 'foreign' },
  ]) assert.throws(() => scenario(patch), JSON.stringify(patch));
});
