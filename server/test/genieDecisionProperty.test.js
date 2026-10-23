import test from 'node:test';
import assert from 'node:assert/strict';
import { toPaise, simulateHouseholdLedger } from '../services/genieDecision/ledger.js';
import { calculateDecision } from '../services/genieDecision/decisionEngine.js';

const money = cents => `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
const signed = value => {
  const negative = value.startsWith('-');
  const digits = (negative ? value.slice(1) : value).replace('.', '');
  return (negative ? -1n : 1n) * BigInt(digits);
};
let seed = 0x4957494c;
function nextInt(n) { seed = (1664525 * seed + 1013904223) >>> 0; return seed % n; }
test('200 seeded financial ledgers conserve exact paise for every modeled month', () => {
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const income = BigInt(1000000 + nextInt(40000000));
    const living = BigInt(nextInt(Number(income / 2n)));
    const debt = BigInt(nextInt(Number((income - living) / 2n)));
    const savings = income - living - debt;
    const investments = BigInt(nextInt(Number(savings + 1n)));
    const goal = BigInt(nextInt(Number(investments + 1n)));
    const opening = BigInt(nextInt(50000000));
    const horizon = 1 + nextInt(60);
    const base = {
      openingLiquidCash: money(opening),
      monthlyTakeHome: money(income),
      monthlyLivingExpenses: money(living),
      monthlyDebtPayments: money(debt),
      monthlyInvestments: money(investments),
      declaredMonthlySavings: money(savings),
    };
    const goalReservations = [{ goalId: 'g1', monthlyAllocation: money(goal) }];
    const result = simulateHouseholdLedger({ baseline: base, horizonMonths: horizon, goalReservations });
    assert.equal(result.rows.length, horizon);
    for (const row of result.rows) {
      const projected = opening + BigInt(row.month) * (income - living - debt - investments);
      assert.equal(signed(row.projectedLiquidCash), projected);
      assert.equal(signed(row.cashShortfall), projected < 0n ? -projected : 0n);
    }
    const start = 1 + nextInt(horizon);
    const duration = 1 + nextInt(horizon - start + 1);
    const lost = BigInt(nextInt(Number(income + 1n)));
    const report = calculateDecision({
      scenarioType: 'INCOME_INTERRUPTION', baseline: base, horizonMonths: horizon,
      goalReservations,
      details: { startMonth: start, durationMonths: duration, incomeLossPerMonth: money(lost) },
    });
    const current = report.alternatives[0];
    const stressed = report.alternatives[1];
    assert.equal(signed(report.alternativeBLiquidCashMinusA), -lost * BigInt(duration));
    assert.equal(signed(stressed.endingProjectedLiquidCash),
      signed(current.endingProjectedLiquidCash) - lost * BigInt(duration));
    assert.equal(report.status, 'PARTIAL');
  }
});

test('extreme valid signed ledger outputs do not overflow input bounds', () => {
  const base = {
    openingLiquidCash: '0.00', monthlyTakeHome: '100000000.00',
    monthlyLivingExpenses: '90000000.00', monthlyDebtPayments: '0.00',
    monthlyInvestments: '10000000.00', declaredMonthlySavings: '10000000.00',
  };
  const output = calculateDecision({
    scenarioType: 'INCOME_INTERRUPTION', baseline: base, horizonMonths: 360,
    goalReservations: [], details: {
      startMonth: 1, durationMonths: 360, incomeLossPerMonth: '100000000.00',
    },
  });
  assert.equal(signed(output.alternativeBLiquidCashMinusA), -36_000_000_000_00n);
  assert.equal(output.alternatives[1].firstCashShortfallMonth, 1);
  assert.equal(output.alternatives[1].rows.length, 360);
});
