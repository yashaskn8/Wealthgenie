import { createHash } from 'node:crypto';
import {
  DecisionInputError, toPaise, fromPaise, simulateHouseholdLedger, compareIncomeInterruption,
  DECISION_LEDGER_VERSION,
} from './ledger.js';

const error = (code, message) => { throw new DecisionInputError(code, message); };
const money = (v, name) => toPaise(v, name);
const whole = (v, low, high, name) => {
  if (!Number.isSafeInteger(v) || v < low || v > high) error('INVALID_RANGE', `${name} must be an integer between ${low} and ${high}.`);
  return v;
};
const ensure = (condition, code, message) => { if (!condition) error(code, message); };
const fields = (value, required, optional = []) => {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value)
    && required.every(k => Object.hasOwn(value, k))
    && Object.keys(value).every(k => [...required, ...optional].includes(k)),
  'INVALID_STRUCTURE', 'Scenario details have missing or unsupported fields.');
};
const SHA = obj => createHash('sha256').update(JSON.stringify(obj)).digest('hex');

const roundInterest = (balance, annualBps) => (balance * BigInt(annualBps) + 60000n) / 120000n;

function debtTrajectory({ principal, annualBps, termMonths, monthlyPayment, extraPayment = 0n, horizonMonths }) {
  let balance = principal;
  let paid = 0n;
  let interestTotal = 0n;
  const payments = [];
  for (let month = 1; month <= horizonMonths; month += 1) {
    if (balance <= 0n) { payments.push({ debt: 0n, interest: 0n, balance: 0n }); continue; }
    const interest = roundInterest(balance, annualBps);
    const due = balance + interest;
    const payment = monthlyPayment + extraPayment < due ? monthlyPayment + extraPayment : due;
    ensure(payment >= interest || payment === due, 'NEGATIVE_AMORTIZATION',
      'Provided repayment does not cover monthly interest.');
    ensure(payment !== interest || payment === due, 'NON_AMORTIZING_LOAN',
      'Provided repayment covers interest but cannot amortize the principal.');
    balance = due - payment;
    paid += payment;
    interestTotal += interest;
    payments.push({ debt: payment, interest, balance });
  }
  if (horizonMonths >= termMonths) {
    ensure(balance === 0n, 'NON_AMORTIZING_LOAN', 'Loan is not repaid within its declared term.');
  }
  return { payments, endingBalance: balance, totalPaid: paid, interestTotal };
}

function loanPayment(principal, annualBps, termMonths) {
  if (principal === 0n) return 0n;
  let low = 1n;
  let high = principal + roundInterest(principal, annualBps);
  // Bounded BigInt binary search: smallest fixed instalment that clears principal.
  while (low < high) {
    const middle = (low + high) / 2n;
    let balance = principal;
    for (let month = 0; month < termMonths && balance > 0n; month += 1) {
      const due = balance + roundInterest(balance, annualBps);
      balance = due > middle ? due - middle : 0n;
    }
    if (balance > 0n) low = middle + 1n;
    else high = middle;
  }
  return low;
}

function modelAlternative({ baseline, horizonMonths, goalReservations, name,
  upfront = 0n, incomeDelta = [], expensesDelta = [], debtDelta = [], investmentDelta = [], obligations = null }) {
  const unmodified = simulateHouseholdLedger({ baseline, horizonMonths, goalReservations });
  let liquid = money(baseline.openingLiquidCash, 'openingLiquidCash') - upfront;
  let firstShortfallMonth = liquid < 0n ? 0 : null;
  let spent = upfront;
  let transferred = 0n;
  const rows = [];
  for (let index = 0; index < horizonMonths; index += 1) {
    const row = unmodified.rows[index];
    const income = money(row.income, 'income') + (incomeDelta[index] || 0n);
    const expenses = money(row.livingExpenses, 'livingExpenses') + (expensesDelta[index] || 0n);
    const debts = money(row.debtPayments, 'debtPayments') + (debtDelta[index] || 0n);
    const investments = money(row.investments, 'investments') + (investmentDelta[index] || 0n);
    ensure(income >= 0n && expenses >= 0n && debts >= 0n && investments >= 0n,
      'INVALID_CASHFLOW', 'A scenario produces negative income or outgoing payments.');
    // Dedicated goal reservations are always backed by actual investment transfers.
    ensure(investments >= money(unmodified.monthlyGoalFundsReservedWithinInvestments, 'goalFunds'),
      'DOUBLE_ALLOCATED_GOAL_FUNDS', 'Scenario leaves too little investment budget to fund existing goal reservations.');
    liquid += income - expenses - debts - investments;
    // Spending, financing and investment transfers all leave liquid cash.
    spent += expenses + debts + investments;
    transferred += investments;
    if (firstShortfallMonth === null && liquid < 0n) firstShortfallMonth = index + 1;
    rows.push({ month: index + 1, income: fromPaise(income), livingExpenses: fromPaise(expenses),
      debtPayments: fromPaise(debts), investments: fromPaise(investments),
      projectedLiquidCash: fromPaise(liquid),
      cashShortfall: fromPaise(liquid < 0n ? -liquid : 0n) });
  }
  return {
    name, status: 'COMPLETE', calculationClass: 'USER_ASSUMPTION_DETERMINISTIC',
    isFeasibleWithoutNewFinancing: firstShortfallMonth === null,
    firstCashShortfallMonth: firstShortfallMonth,
    upfrontCashOutflow: fromPaise(upfront), endingProjectedLiquidCash: fromPaise(liquid),
    cumulativeInvestmentTransfers: fromPaise(transferred),
    cumulativeOutflowsIncludingUpfront: fromPaise(spent),
    remainingLoanBalance: obligations?.endingBalance === undefined ? null : fromPaise(obligations.endingBalance),
    loanInterestPaid: obligations?.interestTotal === undefined ? null : fromPaise(obligations.interestTotal),
    rows,
  };
}

function changeMonthForHousing(baseline, amount, newAmount) {
  const included = money(amount, 'includedHousingCost');
  ensure(included <= money(baseline.monthlyLivingExpenses, 'monthlyLivingExpenses'),
    'HOUSING_DOUBLE_COUNT', 'Included housing cost exceeds declared monthly living expenses.');
  return newAmount - included;
}

function loanFacts(details, principalField = 'loanPrincipal', rateField = 'loanAprBps', termField = 'loanTermMonths') {
  const principal = money(details[principalField], principalField);
  const rate = whole(details[rateField], 0, 5000, rateField);
  const months = whole(details[termField], 1, 360, termField);
  return { principal, rate, months, instalment: loanPayment(principal, rate, months) };
}

export const DECISION_TYPES = Object.freeze([
  'HOUSE_VS_RENT', 'MAJOR_EXPENSE', 'INCOME_INTERRUPTION', 'DEBT_VS_INVEST',
]);

/**
 * No external rate/return is inferred. Every displayed numerical result is
 * derived from profile facts plus explicit user-entered hypothetical terms.
 */
export function calculateDecision({ scenarioType, baseline, horizonMonths, goalReservations, details }) {
  ensure(DECISION_TYPES.includes(scenarioType), 'INVALID_DECISION_TYPE', 'Unsupported financial decision type.');
  const horizon = whole(horizonMonths, 1, 360, 'horizonMonths');
  // Shared budget is always validated, even for scenarios with no new investment.
  simulateHouseholdLedger({ baseline, horizonMonths: horizon, goalReservations });
  const zero = Array(horizon).fill(0n);
  let alternatives;
  if (scenarioType === 'INCOME_INTERRUPTION') {
    fields(details, ['startMonth', 'durationMonths', 'incomeLossPerMonth']);
    const comparison = compareIncomeInterruption({
      baseline, horizonMonths: horizon, goalReservations, incomeInterruption: details,
    });
    alternatives = [
      { name: 'Current income', ...comparison.withoutInterruption },
      { name: 'Income interruption', ...comparison.withInterruption },
    ];
  } else if (scenarioType === 'HOUSE_VS_RENT') {
    fields(details, ['purchasePrice', 'downPayment', 'upfrontFees', 'loanAprBps',
      'loanTermMonths', 'monthlyOwnerCosts', 'monthlyRent', 'rentalUpfrontCash',
      'housingCostAlreadyInExpenses']);
    const purchase = money(details.purchasePrice, 'purchasePrice');
    const deposit = money(details.downPayment, 'downPayment');
    const fees = money(details.upfrontFees, 'upfrontFees');
    ensure(purchase > 0n && deposit <= purchase, 'INVALID_PURCHASE', 'Down payment cannot exceed purchase price.');
    const loan = loanFacts({
      loanPrincipal: fromPaise(purchase - deposit),
      loanAprBps: details.loanAprBps,
      loanTermMonths: details.loanTermMonths,
    });
    const loanSchedule = debtTrajectory({
      principal: loan.principal, annualBps: loan.rate, termMonths: loan.months,
      monthlyPayment: loan.instalment, horizonMonths: horizon,
    });
    const ownerCost = money(details.monthlyOwnerCosts, 'monthlyOwnerCosts');
    const rent = money(details.monthlyRent, 'monthlyRent');
    const purchasedExpenses = changeMonthForHousing(baseline, details.housingCostAlreadyInExpenses, ownerCost);
    const rentalExpenses = changeMonthForHousing(baseline, details.housingCostAlreadyInExpenses, rent);
    alternatives = [
      modelAlternative({
        baseline, horizonMonths: horizon, goalReservations, name: 'Purchase',
        upfront: deposit + fees, expensesDelta: zero.map(() => purchasedExpenses),
        debtDelta: loanSchedule.payments.map(p => p.debt), obligations: loanSchedule,
      }),
      modelAlternative({
        baseline, horizonMonths: horizon, goalReservations, name: 'Rent',
        upfront: money(details.rentalUpfrontCash, 'rentalUpfrontCash'),
        expensesDelta: zero.map(() => rentalExpenses),
      }),
    ];
  } else if (scenarioType === 'MAJOR_EXPENSE') {
    fields(details, ['purchaseCost', 'financePrincipal', 'financeFees',
      'financeAprBps', 'financeTermMonths', 'monthlyMaintenance']);
    const cost = money(details.purchaseCost, 'purchaseCost');
    const financed = money(details.financePrincipal, 'financePrincipal');
    ensure(cost > 0n && financed <= cost, 'INVALID_PURCHASE', 'Financed amount cannot exceed expense cost.');
    const loan = loanFacts({
      loanPrincipal: fromPaise(financed), loanAprBps: details.financeAprBps,
      loanTermMonths: details.financeTermMonths,
    });
    const loanSchedule = debtTrajectory({
      principal: loan.principal, annualBps: loan.rate, termMonths: loan.months,
      monthlyPayment: loan.instalment, horizonMonths: horizon,
    });
    const maintenance = money(details.monthlyMaintenance, 'monthlyMaintenance');
    alternatives = [
      modelAlternative({
        baseline, horizonMonths: horizon, goalReservations, name: 'Pay in cash',
        upfront: cost, expensesDelta: zero.map(() => maintenance),
      }),
      modelAlternative({
        baseline, horizonMonths: horizon, goalReservations, name: 'Finance',
        upfront: cost - financed + money(details.financeFees, 'financeFees'),
        expensesDelta: zero.map(() => maintenance),
        debtDelta: loanSchedule.payments.map(p => p.debt), obligations: loanSchedule,
      }),
    ];
  } else {
    fields(details, ['loanPrincipal', 'loanAprBps', 'loanTermMonths', 'existingLoanPayment',
      'extraMonthlyBudget']);
    const loan = loanFacts(details);
    const regular = money(details.existingLoanPayment, 'existingLoanPayment');
    const extra = money(details.extraMonthlyBudget, 'extraMonthlyBudget');
    ensure(loan.principal > 0n && extra > 0n, 'REQUIRES_INPUTS', 'A positive loan and extra monthly budget are required.');
    ensure(regular <= money(baseline.monthlyDebtPayments, 'monthlyDebtPayments'),
      'DEBT_DOUBLE_COUNT', 'Existing loan payment exceeds monthly debt obligations.');
    const investment = money(baseline.monthlyInvestments, 'monthlyInvestments');
    const reserved = goalReservations.reduce((sum, goal) => sum + money(goal.monthlyAllocation, 'goalAllocation'), 0n);
    ensure(extra <= investment - reserved,
      'DOUBLE_ALLOCATED_GOAL_FUNDS', 'Extra budget must be unreserved money already within monthly investments.');
    const onRegular = debtTrajectory({
      principal: loan.principal, annualBps: loan.rate, termMonths: loan.months,
      monthlyPayment: regular, horizonMonths: horizon,
    });
    const onPrepay = debtTrajectory({
      principal: loan.principal, annualBps: loan.rate, termMonths: loan.months,
      monthlyPayment: regular, extraPayment: extra, horizonMonths: horizon,
    });
    alternatives = [
      modelAlternative({
        baseline, horizonMonths: horizon, goalReservations,
        name: 'Invest unreserved budget',
        debtDelta: onRegular.payments.map(p => p.debt - regular),
        obligations: onRegular,
      }),
      modelAlternative({
        baseline, horizonMonths: horizon, goalReservations, name: 'Prepay loan',
        debtDelta: onPrepay.payments.map(p => p.debt - regular),
        // Redirect only the unreserved amount actually applied to principal/interest.
        // Once debt is cleared, resume normal investing; do not mislabel idle
        // post-payoff cash as a permanently reduced investment contribution.
        investmentDelta: onPrepay.payments.map(p => {
          const redirected = p.debt > regular ? p.debt - regular : 0n;
          return - (redirected < extra ? redirected : extra);
        }),
        obligations: onPrepay,
      }),
    ];
    // No invented market returns, investment NAV or future gains.
  }
  const [a, b] = alternatives;
  const parseSigned = value => {
    // Generated ledger balances are already validated BigInt outputs. A
    // 360-month cumulative balance may exceed the per-input amount ceiling;
    // never re-apply input limits to a computed result.
    if (typeof value !== 'string' || !/^-?(?:0|[1-9][0-9]*)[.][0-9]{2}$/.test(value)) {
      throw new Error('GENIEDECISION_INVALID_GENERATED_LEDGER_BALANCE');
    }
    const negative = value.startsWith('-');
    const digits = (negative ? value.slice(1) : value).replace('.', '');
    return (negative ? -1n : 1n) * BigInt(digits);
  };
  const delta = parseSigned(b.endingProjectedLiquidCash) - parseSigned(a.endingProjectedLiquidCash);
  const result = {
    schemaVersion: 'geniedecision-report-1.0.0',
    modelVersion: DECISION_LEDGER_VERSION,
    scenarioType,
    status: 'PARTIAL', // Independent factual confirmation and net-worth valuation unavailable.
    classification: 'ILLUSTRATIVE_USER_INPUT_NO_LIVE_FINANCIAL_FACTS',
    alternatives,
    alternativeBLiquidCashMinusA: fromPaise(delta),
    warningCodes: [
      'USER_ENTERED_EXPENSES_UNVERIFIED', 'NO_VERIFIED_MARKET_OR_TAX_FACTS',
      'ILLUSTRATIVE_NOT_PERSONALIZED_INVESTMENT_ADVICE',
      ...(alternatives.some(alt => !alt.isFeasibleWithoutNewFinancing) ? ['CASH_SHORTFALL'] : []),
    ],
    unmodeled: [
      'Tax and inflation', 'Investment appreciation and market risk',
      'Floating loan rates, refinancing and credit qualification',
      'Asset resale values, property valuation, insurance and transaction-specific charges',
    ],
  };
  return { ...result, calculationHash: SHA(result) };
}
