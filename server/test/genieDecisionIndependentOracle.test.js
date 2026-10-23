import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { calculateDecision } from '../services/genieDecision/decisionEngine.js';

// Independent arithmetic in cents: this reference does not import any
// production parsing, ledger, debt, amortization or projection helpers.
const cents = value => {
  const [rupees, fraction] = value.split('.');
  return BigInt(rupees) * 100n + BigInt(fraction);
};
const display = value => {
  const minus = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  return `${minus}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
};
const base = Object.freeze({
  openingLiquidCash: '100000.00', monthlyTakeHome: '10000.00',
  monthlyLivingExpenses: '6000.00', monthlyDebtPayments: '1000.00',
  monthlyInvestments: '2000.00', declaredMonthlySavings: '3000.00',
});
const run = (scenarioType, details, horizonMonths = 12) => calculateDecision({
  scenarioType, details, horizonMonths, baseline: base, goalReservations: [],
});
function independentCash(upfront, months, row) {
  let cash = cents(base.openingLiquidCash) - BigInt(upfront);
  const amounts = [];
  for (let month = 1; month <= months; month += 1) {
    const [income, living, debt, investments] = row(month).map(BigInt);
    cash += income - living - debt - investments;
    amounts.push(cash);
  }
  return { cash, amounts };
}

test('independent oracle: all four decisions conserve month-by-month cash at 0% APR', () => {
  const interrupted = run('INCOME_INTERRUPTION', {
    startMonth: 3, durationMonths: 2, incomeLossPerMonth: '3000.00',
  });
  const normal = independentCash(0, 12, () => [1000000, 600000, 100000, 200000]);
  const stressed = independentCash(0, 12, month =>
    [month === 3 || month === 4 ? 700000 : 1000000, 600000, 100000, 200000]);
  assert.equal(interrupted.alternatives[0].endingProjectedLiquidCash, display(normal.cash));
  assert.equal(interrupted.alternatives[1].endingProjectedLiquidCash, display(stressed.cash));

  const housing = run('HOUSE_VS_RENT', {
    purchasePrice: '12000.00', downPayment: '6000.00', upfrontFees: '100.00',
    loanAprBps: 0, loanTermMonths: 6, monthlyOwnerCosts: '500.00',
    monthlyRent: '700.00', rentalUpfrontCash: '500.00',
    housingCostAlreadyInExpenses: '0.00',
  });
  const purchase = independentCash(610000, 12, month =>
    [1000000, 650000, month <= 6 ? 200000 : 100000, 200000]);
  const rent = independentCash(50000, 12, () => [1000000, 670000, 100000, 200000]);
  assert.equal(housing.alternatives[0].endingProjectedLiquidCash, display(purchase.cash));
  assert.equal(housing.alternatives[1].endingProjectedLiquidCash, display(rent.cash));
  assert.equal(housing.alternatives[0].remainingLoanBalance, '0.00');
  assert.equal(housing.alternatives[0].loanInterestPaid, '0.00');

  const expense = run('MAJOR_EXPENSE', {
    purchaseCost: '6000.00', financePrincipal: '3000.00',
    financeFees: '1000.00', financeAprBps: 0, financeTermMonths: 6,
    monthlyMaintenance: '100.00',
  });
  const cash = independentCash(600000, 12, () => [1000000, 610000, 100000, 200000]);
  const finance = independentCash(400000, 12, month =>
    [1000000, 610000, month <= 6 ? 150000 : 100000, 200000]);
  assert.equal(expense.alternatives[0].endingProjectedLiquidCash, display(cash.cash));
  assert.equal(expense.alternatives[1].endingProjectedLiquidCash, display(finance.cash));

  const debt = run('DEBT_VS_INVEST', {
    loanPrincipal: '6000.00', loanAprBps: 0, loanTermMonths: 6,
    existingLoanPayment: '1000.00', extraMonthlyBudget: '500.00',
  });
  const invest = independentCash(0, 12, month =>
    [1000000, 600000, month <= 6 ? 100000 : 0, 200000]);
  const prepay = independentCash(0, 12, month =>
    [1000000, 600000, month <= 4 ? 150000 : 0, month <= 4 ? 150000 : 200000]);
  assert.equal(debt.alternatives[0].endingProjectedLiquidCash, display(invest.cash));
  assert.equal(debt.alternatives[1].endingProjectedLiquidCash, display(prepay.cash));
  for (const [output, reference] of [
    [housing.alternatives[0], purchase], [housing.alternatives[1], rent],
    [expense.alternatives[0], cash], [expense.alternatives[1], finance],
    [debt.alternatives[0], invest], [debt.alternatives[1], prepay],
  ]) {
    for (let i = 0; i < 12; i += 1) {
      assert.equal(output.rows[i].projectedLiquidCash, display(reference.amounts[i]));
    }
  }
});

test('independent Python Decimal oracle verifies cent-level loan schedule and APR interest', () => {
  const executable = fileURLToPath(new URL('./oracles/decision_loan.py', import.meta.url));
  for (const aprBps of [0, 375, 900, 1375]) {
    const reference = spawnSync('python3', [executable], {
      input: JSON.stringify({
        principalPaise: 600000, aprBps, termMonths: 12, horizonMonths: 12,
      }),
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(reference.status, 0, reference.stderr || 'Python oracle unavailable');
    const loan = JSON.parse(reference.stdout);
    const scenario = run('HOUSE_VS_RENT', {
      purchasePrice: '12000.00', downPayment: '6000.00', upfrontFees: '100.00',
      loanAprBps: aprBps, loanTermMonths: 12, monthlyOwnerCosts: '500.00',
      monthlyRent: '700.00', rentalUpfrontCash: '500.00',
      housingCostAlreadyInExpenses: '0.00',
    });
    const buying = scenario.alternatives[0];
    const oracle = independentCash(610000, 12, month =>
      [1000000, 650000, 100000 + Number(loan.paymentsPaise[month - 1]), 200000]);
    assert.equal(buying.endingProjectedLiquidCash, display(oracle.cash));
    assert.equal(buying.remainingLoanBalance, display(BigInt(loan.remainingPaise)));
    assert.equal(buying.loanInterestPaid, display(BigInt(loan.interestPaise)));
    assert.deepEqual(buying.rows.map(row => cents(row.debtPayments).toString()),
      loan.paymentsPaise.map(amount => String(100000 + amount)));
  }
});
