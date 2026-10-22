import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateGenieProofScenario } from '../agents/genieProof/genieProofMathService.js';

const scenario = (type, amountRupees, annualRatePercent, months, extras = {}) => ({
  type, amountRupees, annualRatePercent, months, ...extras,
});
const rejects = input => assert.throws(() => calculateGenieProofScenario(input), error =>
  error instanceof RangeError || error instanceof TypeError);

test('lump sum: zero interest, one month, paise and deterministic repeatability', () => {
  const input = scenario('LUMPSUM', '1234.56', '0', 120, { claimedResultRupees: '1234.56' });
  const out = calculateGenieProofScenario(input);
  assert.equal(out.resultRupees, '1234.56');
  assert.equal(out.totalInterestRupees, '0.00');
  assert.equal(out.arithmeticFinding, 'MATCHES_ASSUMPTIONS_WITHIN_ONE_PAISE');
  assert.equal(out.saved, false);
  assert.equal(out.assumptionSource, 'USER_SUPPLIED_NOT_VERIFIED');
  assert.equal(out.caveat.includes('NOT verified'), true);
  assert.deepEqual(out, calculateGenieProofScenario(input));
  const month = calculateGenieProofScenario(scenario('LUMPSUM', '1000.00', '12', 1));
  assert.equal(month.resultRupees, '1010.00');
  assert.equal(month.totalInterestRupees, '10.00');
});

test('SIP: contributions at month end, zero growth and annual step-up boundary', () => {
  const zero = calculateGenieProofScenario(scenario('SIP', '100.00', '0', 12));
  assert.equal(zero.resultRupees, '1200.00');
  assert.equal(zero.totalPaidOrContributedRupees, '1200.00');
  assert.equal(zero.totalInterestRupees, '0.00');
  const step = calculateGenieProofScenario(scenario('SIP', '100.00', '0', 13, { stepUpPercent: '10' }));
  assert.equal(step.resultRupees, '1310.00');
  assert.equal(step.totalPaidOrContributedRupees, '1310.00');
  const months2 = calculateGenieProofScenario(scenario('SIP', '1000.00', '12', 2));
  // Month 1 contribution at end: 1000; month 2 interest 1%: 10.
  assert.equal(months2.resultRupees, '2010.00');
  assert.equal(months2.totalInterestRupees, '10.00');
});

test('EMI: 0% exact payment schedule with final instalment adjustment', () => {
  const result = calculateGenieProofScenario(scenario('EMI', '1000.00', '0', 3));
  assert.equal(result.resultRupees, '333.34');
  assert.equal(result.lastInstallmentRupees, '333.32');
  assert.equal(result.totalPaidOrContributedRupees, '1000.00');
  assert.equal(result.totalInterestRupees, '0.00');
  assert.equal(calculateGenieProofScenario(scenario('EMI', '1200.00', '12', 12)).resultRupees, '106.62');
  const firstMonth = calculateGenieProofScenario(scenario('EMI', '1200.00', '12', 1));
  assert.equal(firstMonth.resultRupees, '1212.00');
  assert.equal(firstMonth.totalInterestRupees, '12.00');
});

test('claim comparison never certifies actual rates or investment performance', () => {
  const calc = calculateGenieProofScenario(scenario('LUMPSUM', '1000', '0', 1,
    { claimedResultRupees: '2000' }));
  assert.equal(calc.arithmeticFinding, 'DIFFERS_FROM_ASSUMPTIONS');
  assert.equal(calc.absoluteDifferenceRupees, '1000.00');
  assert.ok(calc.exclusions.includes('TAXES'));
  assert.ok(calc.exclusions.includes('RATE_CHANGES'));
  assert.equal(calc.assumptionSource, 'USER_SUPPLIED_NOT_VERIFIED');
});

test('inputs reject negative amounts, scientific notation, float money, unsupported precision and overflows', () => {
  const base = scenario('SIP', '100.00', '12', 12);
  const cases = [
    { ...base, amountRupees: '-100' },
    { ...base, amountRupees: '1e9' },
    { ...base, amountRupees: 100 },
    { ...base, amountRupees: '0' },
    { ...base, amountRupees: '100.001' },
    { ...base, amountRupees: '1000000001' },
    { ...base, annualRatePercent: '-1' },
    { ...base, annualRatePercent: 'NaN' },
    { ...base, annualRatePercent: '100.0001' },
    { ...base, annualRatePercent: '2.12345' },
    { ...base, stepUpPercent: '25.0001' },
    { ...base, months: 0 },
    { ...base, months: 601 },
    { ...base, months: 5.5 },
    { ...base, months: '12' },
    { ...base, bogus: true },
    { ...base, type: 'UNRESTRICTED' },
    { ...base, claimedResultRupees: '11.003' },
    { ...base, claimedResultRupees: 'Infinity' },
    { ...base, type: 'EMI', stepUpPercent: '1' },
  ];
  for (const invalid of cases) rejects(invalid);
});

test('largest supported inputs remain finite, deterministic, non-negative and JSON safe', () => {
  for (const type of ['SIP', 'LUMPSUM', 'EMI']) {
    const input = scenario(type, '1000000000.00', '100', 600,
      type === 'SIP' ? { stepUpPercent: '25' } : {});
    const out = calculateGenieProofScenario(input);
    assert.match(out.resultRupees, /^\d+\.\d{2}$/);
    assert.match(out.totalInterestRupees, /^\d+\.\d{2}$/);
    assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
  }
});

test('SIP and EMI scenario values are monetary illustrations and never claimed verified evidence', () => {
  const examples = [
    scenario('SIP', '10000.00', '12', 120, { stepUpPercent: '5', claimedResultRupees: '1000000' }),
    scenario('EMI', '2500000.00', '8.5', 240, { claimedResultRupees: '20000' }),
  ];
  for (const input of examples) {
    const value = calculateGenieProofScenario(input);
    assert.equal(value.ok, true);
    assert.equal(value.mode, 'USER_INPUT_MATH_CHECK');
    assert.equal(value.saved, false);
    assert.equal(value.assumptionSource, 'USER_SUPPLIED_NOT_VERIFIED');
    assert.equal(typeof value.caveat, 'string');
    assert.equal(Object.hasOwn(value, 'source'), false);
    assert.equal(Object.hasOwn(value, 'verified'), false);
  }
});
