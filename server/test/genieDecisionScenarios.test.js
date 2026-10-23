import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDecision, DECISION_TYPES } from '../services/genieDecision/decisionEngine.js';
import { DecisionInputError, toPaise } from '../services/genieDecision/ledger.js';

const baseline = {
  openingLiquidCash: '1000000.00',
  monthlyTakeHome: '100000.00',
  monthlyLivingExpenses: '50000.00',
  monthlyDebtPayments: '20000.00',
  monthlyInvestments: '20000.00',
  declaredMonthlySavings: '30000.00',
};
const goalReservations = [{ goalId: 'retirement', monthlyAllocation: '10000.00' }];
const facts = { baseline, horizonMonths: 12, goalReservations };

function run(scenarioType, details, options = {}) {
  return calculateDecision({ ...facts, ...options, scenarioType, details });
}
function fail(code, fn) {
  assert.throws(fn, e => e instanceof DecisionInputError && e.code === code);
}

test('GenieDecision supports all four independently modeled decisions', () => {
  assert.deepEqual(DECISION_TYPES, [
    'HOUSE_VS_RENT', 'MAJOR_EXPENSE', 'INCOME_INTERRUPTION', 'DEBT_VS_INVEST',
  ]);
});

test('House versus rent conserves shared cash, exposes upfront liquidity shortfall and no property appreciation', () => {
  const report = run('HOUSE_VS_RENT', {
    purchasePrice: '5000000.00', downPayment: '1200000.00', upfrontFees: '200000.00',
    loanAprBps: 800, loanTermMonths: 240, monthlyOwnerCosts: '4000.00',
    monthlyRent: '15000.00', rentalUpfrontCash: '30000.00',
    housingCostAlreadyInExpenses: '10000.00',
  });
  assert.equal(report.status, 'PARTIAL');
  assert.equal(report.alternatives.length, 2);
  assert.equal(report.alternatives[0].firstCashShortfallMonth, 0);
  assert.equal(report.alternatives[1].isFeasibleWithoutNewFinancing, true);
  assert.equal(report.alternatives[0].upfrontCashOutflow, '1400000.00');
  assert.equal(report.alternatives[1].upfrontCashOutflow, '30000.00');
  assert.equal(report.alternatives[0].remainingLoanBalance !== null, true);
  assert.ok(report.unmodeled.includes('Asset resale values, property valuation, insurance and transaction-specific charges'));
  assert.match(report.calculationHash, /^[a-f0-9]{64}$/);
});

test('Major purchase compares cash and financing while amortizing within term', () => {
  const report = run('MAJOR_EXPENSE', {
    purchaseCost: '100000.00', financePrincipal: '80000.00', financeFees: '1000.00',
    financeAprBps: 1200, financeTermMonths: 12, monthlyMaintenance: '1000.00',
  });
  assert.equal(report.alternatives[0].upfrontCashOutflow, '100000.00');
  assert.equal(report.alternatives[1].upfrontCashOutflow, '21000.00');
  assert.equal(report.alternatives[1].remainingLoanBalance, '0.00');
  assert.ok(toPaise(report.alternatives[1].loanInterestPaid, 'interest') > 0n);
  assert.ok(toPaise(report.alternatives[1].cumulativeOutflowsIncludingUpfront, 'outflow') > 0n);
});

test('Income interruption never invents replacement income', () => {
  const report = run('INCOME_INTERRUPTION', {
    startMonth: 2, durationMonths: 3, incomeLossPerMonth: '50000.00',
  });
  assert.equal(report.alternatives[0].endingProjectedLiquidCash, '1120000.00');
  assert.equal(report.alternatives[1].endingProjectedLiquidCash, '970000.00');
  assert.equal(report.alternativeBLiquidCashMinusA, '-150000.00');
});

test('Debt prepayment versus investment does not spend reserved goal contributions twice', () => {
  const report = run('DEBT_VS_INVEST', {
    loanPrincipal: '120000.00', loanAprBps: 1000, loanTermMonths: 12,
    existingLoanPayment: '11000.00', extraMonthlyBudget: '5000.00',
  });
  assert.equal(report.alternatives[1].remainingLoanBalance, '0.00');
  assert.ok(toPaise(report.alternatives[1].loanInterestPaid, 'prepay interest')
    < toPaise(report.alternatives[0].loanInterestPaid, 'regular interest'));
  assert.equal(report.alternatives[0].cumulativeInvestmentTransfers, '240000.00');
  assert.ok(toPaise(report.alternatives[1].cumulativeInvestmentTransfers, 'prepay investments')
    > toPaise('180000.00', 'minimum investment transfers'));
  assert.ok(toPaise(report.alternatives[1].cumulativeInvestmentTransfers, 'prepay investments')
    < toPaise('240000.00', 'original investment transfers'));
  assert.equal(report.alternatives[1].rows.at(-1).investments, '20000.00');
  assert.equal(report.alternatives[1].rows.at(-1).debtPayments, '9000.00');
});

test('Debt budget rejects double allocations, non-amortization and hidden debt', () => {
  fail('DOUBLE_ALLOCATED_GOAL_FUNDS', () => run('DEBT_VS_INVEST', {
    loanPrincipal: '120000.00', loanAprBps: 1000, loanTermMonths: 12,
    existingLoanPayment: '11000.00', extraMonthlyBudget: '10000.01',
  }));
  fail('DEBT_DOUBLE_COUNT', () => run('DEBT_VS_INVEST', {
    loanPrincipal: '120000.00', loanAprBps: 1000, loanTermMonths: 12,
    existingLoanPayment: '20000.01', extraMonthlyBudget: '5000.00',
  }));
  fail('NON_AMORTIZING_LOAN', () => run('DEBT_VS_INVEST', {
    loanPrincipal: '120000.00', loanAprBps: 1000, loanTermMonths: 12,
    existingLoanPayment: '1000.00', extraMonthlyBudget: '5000.00',
  }));
});

test('Strict typed decision validation blocks unsupported fields and repayment assumptions', () => {
  fail('INVALID_STRUCTURE', () => run('INCOME_INTERRUPTION', {
    startMonth: 1, durationMonths: 2, incomeLossPerMonth: '1000.00', fabricatedReturn: 0.2,
  }));
  fail('INVALID_RANGE', () => run('HOUSE_VS_RENT', {
    purchasePrice: '5000000.00', downPayment: '1000000.00', upfrontFees: '0.00',
    loanAprBps: 9000, loanTermMonths: 240, monthlyOwnerCosts: '3000.00',
    monthlyRent: '15000.00', rentalUpfrontCash: '0.00',
    housingCostAlreadyInExpenses: '10000.00',
  }));
  fail('HOUSING_DOUBLE_COUNT', () => run('HOUSE_VS_RENT', {
    purchasePrice: '5000000.00', downPayment: '1000000.00', upfrontFees: '0.00',
    loanAprBps: 900, loanTermMonths: 240, monthlyOwnerCosts: '3000.00',
    monthlyRent: '15000.00', rentalUpfrontCash: '0.00',
    housingCostAlreadyInExpenses: '60000.00',
  }));
});

test('Interest-only instalments are rejected as non-amortizing, below-interest instalments as negative amortization', () => {
  const input = { loanPrincipal: '120000.00', loanAprBps: 1000, loanTermMonths: 12,
    extraMonthlyBudget: '5000.00' };
  fail('NON_AMORTIZING_LOAN', () => run('DEBT_VS_INVEST', {
    ...input, existingLoanPayment: '1000.00',
  }));
  fail('NEGATIVE_AMORTIZATION', () => run('DEBT_VS_INVEST', {
    ...input, existingLoanPayment: '999.99',
  }));
});

test('Long-horizon aggregate balances exceed the input cap without corrupting exact-paise comparisons', () => {
  const scenario = {
    openingLiquidCash: '0.00', monthlyTakeHome: '100000000.00',
    monthlyLivingExpenses: '90000000.00', monthlyDebtPayments: '0.00',
    declaredMonthlySavings: '10000000.00', monthlyInvestments: '0.00',
  };
  const output = run('INCOME_INTERRUPTION', {
    startMonth: 1, durationMonths: 360, incomeLossPerMonth: '100000000.00',
  }, { baseline: scenario, horizonMonths: 360, goalReservations: [] });
  assert.equal(output.alternatives[0].endingProjectedLiquidCash, '3600000000.00');
  assert.equal(output.alternatives[1].endingProjectedLiquidCash, '-32400000000.00');
  assert.equal(output.alternativeBLiquidCashMinusA, '-36000000000.00');
});
