/**
 * GenieDecision V3: bounded, return-free household cash-flow truth foundation.
 * Analysis only: no portfolio writes, rates, tax facts or investment advice.
 */
export const DECISION_LEDGER_VERSION = 'geniedecision-ledger-1.0.0';
const MAX_MONTHS = 360;
const MAX_MONEY_PAISE = 1_000_000_000_000n;
const MONEY_PATTERN = /^(?:0|[1-9]\d{0,10})(?:\.\d{1,2})?$/;

export class DecisionInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DecisionInputError';
    this.code = code;
  }
}

function fail(code, message) { throw new DecisionInputError(code, message); }

export function toPaise(value, field) {
  if (typeof value !== 'string' || !MONEY_PATTERN.test(value)) {
    fail('INVALID_MONEY', `${field} must be a non-negative INR decimal string with at most two fractional digits.`);
  }
  const [rupees, fraction = ''] = value.split('.');
  const paise = BigInt(rupees) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
  if (paise > MAX_MONEY_PAISE) fail('MONEY_OUT_OF_RANGE', `${field} is above the supported amount.`);
  return paise;
}

export function fromPaise(amount) {
  const negative = amount < 0n;
  const value = negative ? -amount : amount;
  return `${negative ? '-' : ''}${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

function exactKeys(object, allowed, field) {
  if (!object || typeof object !== 'object' || Array.isArray(object)
    || Object.keys(object).some(key => !allowed.includes(key))) {
    fail('INVALID_STRUCTURE', `${field} contains an unexpected or invalid field.`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(object, key)) fail('MISSING_INPUT', `${field}.${key} is required.`);
  }
}

function integerBetween(value, min, max, field) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('INVALID_RANGE', `${field} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

/**
 * All cash movements use paise (BigInt). Goal reservations subdivide monthly
 * investments; they NEVER debit cash a second time or create extra assets.
 *
 * Baseline declared savings must reconcile exactly to income minus living
 * expenses and debt obligations, without inferred or fabricated corrections.
 */
export function simulateHouseholdLedger({ baseline, horizonMonths, goalReservations, incomeInterruption = null }) {
  exactKeys(baseline, [
    'openingLiquidCash', 'monthlyTakeHome', 'monthlyLivingExpenses',
    'monthlyDebtPayments', 'monthlyInvestments', 'declaredMonthlySavings',
  ], 'baseline');
  const horizon = integerBetween(horizonMonths, 1, MAX_MONTHS, 'horizonMonths');
  const opening = toPaise(baseline.openingLiquidCash, 'openingLiquidCash');
  const income = toPaise(baseline.monthlyTakeHome, 'monthlyTakeHome');
  const expenses = toPaise(baseline.monthlyLivingExpenses, 'monthlyLivingExpenses');
  const debts = toPaise(baseline.monthlyDebtPayments, 'monthlyDebtPayments');
  const investments = toPaise(baseline.monthlyInvestments, 'monthlyInvestments');
  const savings = toPaise(baseline.declaredMonthlySavings, 'declaredMonthlySavings');
  if (income === 0n) fail('MISSING_INCOME', 'A positive monthly take-home is required.');
  if (income - expenses - debts !== savings) {
    fail('SAVINGS_RECONCILIATION_REQUIRED', 'Income minus living expenses and debt must match declared monthly savings.');
  }
  if (investments > savings) {
    fail('OVERALLOCATED_SAVINGS', 'Investments cannot exceed reconciled monthly savings.');
  }
  if (!Array.isArray(goalReservations) || goalReservations.length > 30) {
    fail('INVALID_GOALS', 'An explicit list of at most 30 monthly goal reservations is required.');
  }
  const goalIds = new Set();
  let reserved = 0n;
  for (const [index, goal] of goalReservations.entries()) {
    exactKeys(goal, ['goalId', 'monthlyAllocation'], `goalReservations[${index}]`);
    if (typeof goal.goalId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(goal.goalId)
      || goalIds.has(goal.goalId)) fail('INVALID_GOALS', 'Goal identifiers must be unique and bounded.');
    goalIds.add(goal.goalId);
    reserved += toPaise(goal.monthlyAllocation, `goalReservations[${index}].monthlyAllocation`);
  }
  if (reserved > investments) {
    fail('DOUBLE_ALLOCATED_GOAL_FUNDS', 'Combined goal reservations exceed the shared monthly investment budget.');
  }

  let loss = 0n;
  let interruptionStart = 0;
  let interruptionEnd = 0;
  if (incomeInterruption !== null) {
    exactKeys(incomeInterruption, ['startMonth', 'durationMonths', 'incomeLossPerMonth'], 'incomeInterruption');
    interruptionStart = integerBetween(incomeInterruption.startMonth, 1, horizon, 'startMonth');
    const duration = integerBetween(incomeInterruption.durationMonths, 1, horizon, 'durationMonths');
    interruptionEnd = interruptionStart + duration - 1;
    if (interruptionEnd > horizon) fail('INVALID_RANGE', 'Income interruption extends beyond the horizon.');
    loss = toPaise(incomeInterruption.incomeLossPerMonth, 'incomeLossPerMonth');
    if (loss > income) fail('INVALID_RANGE', 'Monthly income loss cannot exceed take-home income.');
  }

  const rows = [];
  let cash = opening;
  let totalIncome = 0n;
  let totalExpenses = 0n;
  let totalDebt = 0n;
  let totalInvestments = 0n;
  let firstCashShortfallMonth = null;
  for (let month = 1; month <= horizon; month += 1) {
    const monthIncome = income - (month >= interruptionStart && month <= interruptionEnd ? loss : 0n);
    cash += monthIncome - expenses - debts - investments;
    totalIncome += monthIncome;
    totalExpenses += expenses;
    totalDebt += debts;
    totalInvestments += investments;
    if (cash < 0n && firstCashShortfallMonth === null) firstCashShortfallMonth = month;
    rows.push({
      month, income: fromPaise(monthIncome), livingExpenses: fromPaise(expenses),
      debtPayments: fromPaise(debts), investments: fromPaise(investments),
      // Negative liquid cash means UNFUNDED need, not a permitted overdraft.
      projectedLiquidCash: fromPaise(cash),
      cashShortfall: fromPaise(cash < 0n ? -cash : 0n),
    });
  }
  const conserved = opening + totalIncome - totalExpenses - totalDebt - totalInvestments;
  if (conserved !== cash) throw new Error('GENIEDECISION_LEDGER_CONSERVATION_FAILURE');
  return {
    status: 'COMPLETE',
    version: DECISION_LEDGER_VERSION,
    calculationClass: 'DETERMINISTIC_NOMINAL_NO_RETURNS',
    isFeasibleWithoutNewFinancing: firstCashShortfallMonth === null,
    firstCashShortfallMonth,
    startingLiquidCash: fromPaise(opening),
    endingProjectedLiquidCash: fromPaise(cash),
    cumulativeInvestmentTransfers: fromPaise(totalInvestments),
    monthlyGoalFundsReservedWithinInvestments: fromPaise(reserved),
    unreservedMonthlyInvestmentBudget: fromPaise(investments - reserved),
    totals: {
      income: fromPaise(totalIncome), livingExpenses: fromPaise(totalExpenses),
      debtPayments: fromPaise(totalDebt), investments: fromPaise(totalInvestments),
    },
    rows,
    limitations: [
      'No investment returns, inflation, taxes, interest accrual, or future rate changes modeled.',
      'Negative projected liquid cash is an unfunded requirement, not an approved loan.',
      'Monthly goal reservations subdivide investment transfers, not extra assets.',
    ],
  };
}

/** Compare a baseline with a bounded explicit income-loss hypothetical. */
export function compareIncomeInterruption({ baseline, horizonMonths, goalReservations, incomeInterruption }) {
  if (!incomeInterruption) fail('MISSING_INPUT', 'An explicit incomeInterruption is required.');
  const common = { baseline, horizonMonths, goalReservations };
  const withoutInterruption = simulateHouseholdLedger(common);
  const withInterruption = simulateHouseholdLedger({ ...common, incomeInterruption });
  const baseCash = BigInt(withoutInterruption.endingProjectedLiquidCash.replace('.', ''));
  const stressedCash = BigInt(withInterruption.endingProjectedLiquidCash.replace('.', ''));
  return {
    scenarioType: 'INCOME_INTERRUPTION',
    version: DECISION_LEDGER_VERSION,
    withoutInterruption,
    withInterruption,
    projectedLiquidCashDifference: fromPaise(stressedCash - baseCash),
    presentationClassification: 'HYPOTHETICAL_CASH_FLOW_ONLY',
  };
}
