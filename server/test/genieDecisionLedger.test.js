import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DecisionInputError, DECISION_LEDGER_VERSION, toPaise, fromPaise,
  simulateHouseholdLedger, compareIncomeInterruption,
} from '../services/genieDecision/ledger.js';

const baseline = Object.freeze({
  openingLiquidCash: '100000.00',
  monthlyTakeHome: '100000.00',
  monthlyLivingExpenses: '50000.00',
  monthlyDebtPayments: '20000.00',
  declaredMonthlySavings: '30000.00',
  monthlyInvestments: '20000.00',
});
const goals = [
  { goalId: 'home', monthlyAllocation: '12000.00' },
  { goalId: 'retirement', monthlyAllocation: '8000.00' },
];

function reject(code, fn) {
  assert.throws(fn, error => error instanceof DecisionInputError && error.code === code);
}

test('GenieDecision money parser accepts only exact INR decimal strings', () => {
  assert.equal(toPaise('0.01', 'amount'), 1n);
  assert.equal(toPaise('100000.50', 'amount'), 10000050n);
  assert.equal(fromPaise(-1n), '-0.01');
  for (const value of [1.2, -1, '1e8', 'NaN', 'Infinity', '1.234', '-0.01', '01', '', null]) {
    reject('INVALID_MONEY', () => toPaise(value, 'amount'));
  }
});

test('GenieDecision ledger conserves money and does not invent returns', () => {
  const result = simulateHouseholdLedger({ baseline, horizonMonths: 12, goalReservations: goals });
  assert.equal(result.version, DECISION_LEDGER_VERSION);
  assert.equal(result.endingProjectedLiquidCash, '220000.00');
  assert.equal(result.cumulativeInvestmentTransfers, '240000.00');
  assert.equal(result.monthlyGoalFundsReservedWithinInvestments, '20000.00');
  assert.equal(result.unreservedMonthlyInvestmentBudget, '0.00');
  assert.equal(result.isFeasibleWithoutNewFinancing, true);
  assert.equal(result.rows.length, 12);
  const net = toPaise(result.startingLiquidCash, 'starting')
    + toPaise(result.totals.income, 'income')
    - toPaise(result.totals.livingExpenses, 'expenses')
    - toPaise(result.totals.debtPayments, 'debt')
    - toPaise(result.totals.investments, 'investments');
  assert.equal(fromPaise(net), result.endingProjectedLiquidCash);
});

test('GenieDecision rejects double-funded and duplicate goals', () => {
  reject('DOUBLE_ALLOCATED_GOAL_FUNDS', () => simulateHouseholdLedger({
    baseline, horizonMonths: 1,
    goalReservations: [...goals, { goalId: 'third', monthlyAllocation: '1.00' }],
  }));
  reject('INVALID_GOALS', () => simulateHouseholdLedger({
    baseline, horizonMonths: 1,
    goalReservations: [{ goalId: 'home', monthlyAllocation: '100.00' },
      { goalId: 'home', monthlyAllocation: '100.00' }],
  }));
});

test('GenieDecision reconciles profile savings; never subtracts living costs twice', () => {
  reject('SAVINGS_RECONCILIATION_REQUIRED', () => simulateHouseholdLedger({
    baseline: { ...baseline, monthlyLivingExpenses: '60000.00' },
    horizonMonths: 2, goalReservations: [],
  }));
  reject('OVERALLOCATED_SAVINGS', () => simulateHouseholdLedger({
    baseline: { ...baseline, monthlyInvestments: '30000.01' },
    horizonMonths: 2, goalReservations: [],
  }));
});

test('GenieDecision income interruption exposes unfunded cash exhaustion', () => {
  const result = compareIncomeInterruption({
    baseline, horizonMonths: 6, goalReservations: goals,
    incomeInterruption: { startMonth: 2, durationMonths: 3, incomeLossPerMonth: '100000.00' },
  });
  assert.equal(result.withoutInterruption.endingProjectedLiquidCash, '160000.00');
  assert.equal(result.withInterruption.endingProjectedLiquidCash, '-140000.00');
  assert.equal(result.projectedLiquidCashDifference, '-300000.00');
  assert.equal(result.withInterruption.isFeasibleWithoutNewFinancing, false);
  assert.equal(result.withInterruption.firstCashShortfallMonth, 3);
  assert.equal(result.withInterruption.rows[2].cashShortfall, '70000.00');
});

test('GenieDecision rejects unbounded horizon, unexpected fields and impossible loss', () => {
  reject('INVALID_RANGE', () => simulateHouseholdLedger({
    baseline, horizonMonths: 361, goalReservations: [],
  }));
  reject('INVALID_STRUCTURE', () => simulateHouseholdLedger({
    baseline: { ...baseline, madeUpRate: '0.08' }, horizonMonths: 12, goalReservations: [],
  }));
  reject('INVALID_RANGE', () => compareIncomeInterruption({
    baseline, horizonMonths: 2, goalReservations: [],
    incomeInterruption: { startMonth: 2, durationMonths: 2, incomeLossPerMonth: '50000.00' },
  }));
  reject('INVALID_RANGE', () => compareIncomeInterruption({
    baseline, horizonMonths: 2, goalReservations: [],
    incomeInterruption: { startMonth: 1, durationMonths: 1, incomeLossPerMonth: '100000.01' },
  }));
});

test('GenieDecision keeps monthly investments separate from goal allocations', () => {
  const result = simulateHouseholdLedger({
    baseline, horizonMonths: 1,
    goalReservations: [{ goalId: 'house', monthlyAllocation: '12000.00' }],
  });
  assert.equal(result.endingProjectedLiquidCash, '110000.00');
  assert.equal(result.monthlyGoalFundsReservedWithinInvestments, '12000.00');
  assert.equal(result.unreservedMonthlyInvestmentBudget, '8000.00');
  assert.equal(result.totals.investments, '20000.00');
});
