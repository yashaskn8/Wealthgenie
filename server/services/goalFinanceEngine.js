/**
 * Goals-only deterministic cash-flow planning. No market data, LLM, or lender authority.
 * Amounts are user-entered nominal INR and do not establish verified income.
 */
export const GOAL_FINANCE_POLICY_VERSION = 'goal-finance-1.0.1';
export const GOAL_EXPENSE_CATEGORIES = Object.freeze([
  'housing', 'groceries', 'utilities', 'transport', 'healthcare', 'education',
  'insurance', 'existing_emi', 'subscriptions', 'taxes', 'family', 'other',
]);
const PRIORITIES = Object.freeze({ Critical: 0, High: 1, Medium: 2, Low: 3 });
const MAX_RUPEES = 1_000_000_000;
const MONEY_PRECISION = 100;

function money(value, label, { allowNull = false } = {}) {
  if (allowNull && (value === null || value === undefined)) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
      || value > MAX_RUPEES || Number(value.toFixed(2)) !== value) {
    throw new RangeError(`${label} must be a finite non-negative INR amount with at most two decimal places`);
  }
  return value;
}
const rupees = value => {
  if (!Number.isFinite(value) || !Number.isSafeInteger(Math.round(value * MONEY_PRECISION))) {
    throw new RangeError('Derived INR amount is outside supported precision');
  }
  return Math.round((value + Number.EPSILON) * MONEY_PRECISION) / MONEY_PRECISION;
};
function sum(values) { return rupees(values.reduce((total, value) => total + value, 0)); }

export function summarizeGoalBudget(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Budget is required');
  const income = money(input.monthlyIncome, 'monthlyIncome', { allowNull: true });
  const committed = money(input.protectedMonthlyContributions ?? 0, 'protectedMonthlyContributions');
  if (!Array.isArray(input.expenses) || input.expenses.length > 100) throw new TypeError('expenses must be an array of at most 100 items');
  const expenses = input.expenses.map((entry, index) => {
    if (!entry || !GOAL_EXPENSE_CATEGORIES.includes(entry.category)
      || !['recurring', 'one_off'].includes(entry.frequency)) {
      throw new TypeError(`Invalid expense at ${index}`);
    }
    return { category: entry.category, frequency: entry.frequency, amount: money(entry.amount, `expense ${index}`) };
  });
  const recurringExpenses = sum(expenses.filter(e => e.frequency === 'recurring').map(e => e.amount));
  const oneOffExpenses = sum(expenses.filter(e => e.frequency === 'one_off').map(e => e.amount));
  const declaredComplete = input.expensesComplete === true;
  const recurringSurplus = income === null ? null : rupees(income - recurringExpenses - committed);
  const actualMonthSurplus = recurringSurplus === null ? null : rupees(recurringSurplus - oneOffExpenses);
  const missing = [];
  if (income === null) missing.push('MONTHLY_INCOME_MISSING');
  if (!declaredComplete) missing.push('EXPENSE_COVERAGE_UNCONFIRMED');
  return {
    policyVersion: GOAL_FINANCE_POLICY_VERSION, dataClass: 'USER_DECLARED',
    monthlyIncome: income, recurringExpenses, oneOffExpenses,
    protectedMonthlyContributions: committed, recurringSurplus, actualMonthSurplus,
    budgetStatus: missing.length ? 'DATA_INSUFFICIENT'
      : recurringSurplus < 0 || actualMonthSurplus < 0 ? 'BUDGET_SHORTFALL' : 'SELF_REPORTED',
    missing,
    // A self-reported budget is never independently bank-verified.
    verifiedByBank: false,
  };
}

/** Allocate one shared monthly envelope. Never sum separately-claimed balances as independent funds. */
export function allocateGoalFunding(goals, capacity) {
  if (!Array.isArray(goals) || goals.length > 250) throw new TypeError('Expected up to 250 goals');
  const available = money(capacity, 'available goal capacity', { allowNull: true });
  const entries = goals.map((g, index) => {
    if (!g || typeof g !== 'object') throw new TypeError(`Goal ${index} is not an object`);
    // Legacy and corrupted records must fail closed, not crash the entire planner
    // or be coerced into a plausible rupee amount or valid deadline.
    let required = null;
    let currentSavings = null;
    let invalidInputs = false;
    try { required = money(g.recommended_sip, `goal ${index} required_sip`, { allowNull: true }); }
    catch { invalidInputs = true; }
    try { currentSavings = money(g.current_savings ?? null, `goal ${index} current_savings`, { allowNull: true }); }
    catch { invalidInputs = true; }
    const date = g.target_date ? new Date(g.target_date) : null;
    if (date && !Number.isFinite(date.getTime())) invalidInputs = true;
    const knownPriority = Object.hasOwn(PRIORITIES, g.priority);
    if (!knownPriority) invalidInputs = true;
    return {
      goalId: String(g.goalId ?? g._id ?? ''),
      name: String(g.goal_name ?? '').slice(0, 100),
      priority: knownPriority ? g.priority : 'Unknown',
      dueDate: date && Number.isFinite(date.getTime()) ? date.toISOString() : null,
      required, currentSavings, invalidInputs,
      fresh: !invalidInputs && g.calculation_freshness?.fresh === true,
    };
  });
  if (entries.some(e => !e.goalId)) throw new TypeError('Goal identity invalid');
  if (new Set(entries.map(e => e.goalId)).size !== entries.length) throw new TypeError('Duplicate goal identities');
  const ordered = entries.sort((a, b) => (PRIORITIES[a.priority] ?? 99) - (PRIORITIES[b.priority] ?? 99)
    || (a.dueDate || '').localeCompare(b.dueDate || '') || a.goalId.localeCompare(b.goalId));
  const fundingVerified = available !== null && ordered.every(e => e.fresh && e.required !== null);
  let remaining = available;
  const allocations = ordered.map(e => {
    const eligible = fundingVerified && e.fresh && e.required !== null;
    const contribution = eligible ? rupees(Math.min(e.required, remaining)) : null;
    if (eligible) remaining = rupees(remaining - contribution);
    return {
      goalId: e.goalId, name: e.name, priority: e.priority, targetDate: e.dueDate,
      requiredMonthly: e.fresh ? e.required : null,
      allocatedMonthly: contribution,
      shortfallMonthly: eligible ? rupees(e.required - contribution) : null,
      balanceUniqueness: e.currentSavings === null ? 'UNKNOWN' : 'NOT_VERIFIED',
    };
  });
  const totalRequested = fundingVerified ? sum(ordered.map(e => e.required)) : null;
  const totalAllocated = fundingVerified ? sum(allocations.map(e => e.allocatedMonthly)) : null;
  return {
    policyVersion: GOAL_FINANCE_POLICY_VERSION,
    status: fundingVerified ? totalRequested > available ? 'OVERCOMMITTED' : 'WITHIN_CAPACITY' : 'DATA_INSUFFICIENT',
    capacity: available, totalRequested, totalAllocated,
    remainingCapacity: fundingVerified ? remaining : null,
    warnings: [
      ...(!fundingVerified ? ['GOAL_CALCULATION_OR_BUDGET_MISSING'] : []),
      ...(ordered.some(e => e.invalidInputs) ? ['INVALID_PERSISTED_GOAL_INPUT'] : []),
      ...(fundingVerified && totalRequested > available ? ['GOALS_COMPETE_FOR_ONE_SAVINGS_POOL'] : []),
      'CURRENT_GOAL_SAVINGS_NOT_PROVEN_DISTINCT',
      'PER_GOAL_PROBABILITIES_NOT_JOINT_PROBABILITY',
    ],
    allocations,
  };
}

export function calculateEmi({ principal, annualInterestRate, tenureMonths }) {
  money(principal, 'principal');
  if (typeof annualInterestRate !== 'number' || !Number.isFinite(annualInterestRate)
    || annualInterestRate < 0 || annualInterestRate > 45) throw new RangeError('Interest rate must be between 0 and 45%');
  if (!Number.isInteger(tenureMonths) || tenureMonths < 1 || tenureMonths > 360) {
    throw new RangeError('Loan duration must be 1–360 months');
  }
  const principalPaise = Math.round(principal * MONEY_PRECISION);
  const rate = annualInterestRate / 1200;
  // A textbook (unrounded) EMI can underpay a loan after hundreds of rounded
  // interest accruals. Find the smallest cent-denominated regular instalment
  // which actually amortizes the rounded ledger by the stated month.
  const theoreticalEmi = principalPaise === 0 ? 0 : rate === 0 ? principal / tenureMonths
    : principal * rate / (-Math.expm1(-tenureMonths * Math.log1p(rate)));
  if (!Number.isFinite(theoreticalEmi)) throw new RangeError('EMI could not be calculated');
  if (principalPaise > 0 && theoreticalEmi * MONEY_PRECISION < 0.5) {
    throw new RangeError('Loan is too small for a nonzero monthly EMI at this tenure');
  }
  const amortizes = regularPaise => {
    let remaining = principalPaise;
    for (let month = 1; month <= tenureMonths && remaining > 0; month += 1) {
      const interest = Math.round(remaining * rate);
      const next = remaining + interest - regularPaise;
      remaining = Math.max(0, next);
    }
    return remaining === 0;
  };
  let low = 0;
  let high = Math.ceil(principalPaise * (1 + rate));
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (amortizes(mid)) high = mid;
    else low = mid + 1;
  }
  const scheduledPaymentPaise = low;
  if (!Number.isSafeInteger(scheduledPaymentPaise)) throw new RangeError('EMI exceeds safe precision');
  let balance = principalPaise;
  let paid = 0;
  let finalPaymentPaise = 0;
  let totalInterestPaise = 0;
  for (let month = 1; month <= tenureMonths; month += 1) {
    // Explicit paise rounding of monthly interest; last payment pays all remaining balance.
    const interestPaise = Math.round(balance * rate);
    const due = balance + interestPaise;
    const paymentPaise = month === tenureMonths ? due : Math.min(scheduledPaymentPaise, due);
    if (paymentPaise < interestPaise && balance > 0) throw new RangeError('EMI does not amortize loan');
    balance = due - paymentPaise;
    paid += paymentPaise;
    totalInterestPaise += interestPaise;
    finalPaymentPaise = paymentPaise;
  }
  if (balance !== 0 || paid !== principalPaise + totalInterestPaise) {
    throw new RangeError('EMI reconciliation failed');
  }
  return {
    monthlyEmi: scheduledPaymentPaise / MONEY_PRECISION,
    finalPayment: finalPaymentPaise / MONEY_PRECISION,
    totalRepayment: paid / MONEY_PRECISION,
    totalInterest: totalInterestPaise / MONEY_PRECISION,
    loanPrincipal: principal, annualInterestRate, tenureMonths,
    calculation: 'REDUCING_BALANCE_FIXED_RATE_MONTHLY_PAISE_ROUNDING',
    paymentTiming: 'END_OF_MONTH', rounding: 'NEAREST_PAISE_EACH_MONTH',
    feeCoverage: 'EXCLUDES_LENDER_FEES_AND_VARIABLE_RATE_CHANGES',
    assumptionSource: 'USER_DECLARED', policyVersion: GOAL_FINANCE_POLICY_VERSION,
  };
}

export function assessVehiclePurchase(budget, scenario, { monthlyGoalCommitments = null } = {}) {
  const summary = summarizeGoalBudget(budget);
  const reservedForGoals = money(monthlyGoalCommitments, 'monthlyGoalCommitments', { allowNull: true });
  if (!scenario || typeof scenario !== 'object') throw new TypeError('Purchase scenario required');
  const price = money(scenario.price, 'price');
  const downPayment = money(scenario.downPayment, 'downPayment');
  const upfrontFees = money(scenario.upfrontFees, 'upfrontFees');
  const recurringOwnership = money(scenario.monthlyOwnershipCost, 'monthlyOwnershipCost');
  if (price === 0) throw new RangeError('Vehicle purchase price must be greater than zero');
  const emergencyCash = money(scenario.emergencyCash, 'emergencyCash', { allowNull: true });
  const emergencyFloor = money(scenario.emergencyFloor, 'emergencyFloor', { allowNull: true });
  if (downPayment > price) throw new RangeError('Down payment cannot exceed purchase price');
  const loan = calculateEmi({ principal: rupees(price - downPayment),
    annualInterestRate: scenario.annualInterestRate, tenureMonths: scenario.tenureMonths });
  const ongoing = rupees(loan.monthlyEmi + recurringOwnership);
  const afterPurchase = summary.recurringSurplus === null ? null : rupees(summary.recurringSurplus - ongoing);
  const actualMonthAfterPurchase = summary.actualMonthSurplus === null ? null
    : rupees(summary.actualMonthSurplus - ongoing);
  const actualMonthAfterPurchaseAndGoals = actualMonthAfterPurchase === null || reservedForGoals === null
    ? null : rupees(actualMonthAfterPurchase - reservedForGoals);
  const upfront = rupees(downPayment + upfrontFees);
  const afterCash = emergencyCash === null ? null : rupees(emergencyCash - upfront);
  const missing = [...summary.missing];
  if (emergencyCash === null) missing.push('AVAILABLE_CASH_UNKNOWN');
  if (emergencyFloor === null) missing.push('EMERGENCY_RESERVE_FLOOR_UNKNOWN');
  if (reservedForGoals === null) missing.push('GOAL_COMMITMENTS_UNVERIFIED');
  if (upfrontFees === 0) missing.push('UPFRONT_FEES_UNCONFIRMED');
  if (recurringOwnership === 0) missing.push('VEHICLE_RUNNING_COSTS_UNCONFIRMED');
  const bufferInsufficient = afterCash !== null && emergencyFloor !== null && afterCash < emergencyFloor;
  const status = missing.length ? 'DATA_INSUFFICIENT'
    : afterPurchase < 0 || actualMonthAfterPurchase < 0
        || actualMonthAfterPurchaseAndGoals < 0 || afterCash < 0 ? 'BUDGET_SHORTFALL'
      : bufferInsufficient ? 'RISK_WARNING' : 'PASSES_SELF_REPORTED_CHECKS';
  const reasons = [
    ...missing,
    ...(afterPurchase !== null && afterPurchase < 0 ? ['NEGATIVE_MONTHLY_CASHFLOW'] : []),
    ...(actualMonthAfterPurchase !== null && actualMonthAfterPurchase < 0 ? ['NEGATIVE_PURCHASE_MONTH_CASHFLOW'] : []),
    ...(actualMonthAfterPurchaseAndGoals !== null && actualMonthAfterPurchaseAndGoals < 0 ? ['GOALS_AND_PURCHASE_EXCEED_SAVINGS'] : []),
    ...(afterCash !== null && afterCash < 0 ? ['UPFRONT_CASH_SHORTFALL'] : []),
    ...(bufferInsufficient ? ['EMERGENCY_RESERVE_BREACHED'] : []),
  ];
  return {
    policyVersion: GOAL_FINANCE_POLICY_VERSION, dataClass: 'USER_DECLARED',
    status, reasons, loan, upfront, monthlyOwnershipCost: recurringOwnership,
    additionalMonthlyCommitment: ongoing, monthlySurplusAfterPurchase: afterPurchase,
    purchaseMonthSurplusAfterPurchase: actualMonthAfterPurchase,
    requiredMonthlyGoalContributions: reservedForGoals,
    purchaseMonthSurplusAfterGoals: actualMonthAfterPurchaseAndGoals,
    emergencyCashAfterPurchase: afterCash,
    totalNominalCostDuringLoan: rupees(price + loan.totalInterest + upfrontFees + recurringOwnership * scenario.tenureMonths),
    priceBasis: 'USER_SUPPLIED_NOT_LIVE', priceUpdatedAt: null, lenderApproval: 'NOT_ASSESSED',
    warnings: ['USER_QUOTES_NOT_LIVE_VERIFIED', 'ASSUMES_BUY_NOW_AND_FIRST_EMI_THIS_MONTH',
      'COSTS_MUST_INCLUDE_ALL_REQUIRED_FEES_AND_MAINTENANCE', 'USER_INPUTS_NOT_INDEPENDENTLY_VERIFIED'],
  };
}

export function projectGoalSavings({ currentSavings, monthlyContribution, years, annualReturnAssumption, annualInflationAssumption }) {
  const capital = money(currentSavings, 'currentSavings');
  const contribution = money(monthlyContribution, 'monthlyContribution');
  if (!Number.isInteger(years) || years < 1 || years > 50) throw new RangeError('Years must be between 1 and 50');
  for (const [name, rate] of [['annualReturnAssumption', annualReturnAssumption], ['annualInflationAssumption', annualInflationAssumption]]) {
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= -100 || rate > 100) throw new RangeError(`${name} invalid`);
  }
  const months = years * 12;
  const r = Math.expm1(Math.log1p(annualReturnAssumption / 100) / 12);
  const fvContributions = Math.abs(r) < 1e-12 ? contribution * months
    : contribution * Math.expm1(months * Math.log1p(r)) / r;
  const futureNominal = rupees(capital * Math.pow(1 + r, months) + fvContributions);
  if (!Number.isFinite(futureNominal) || !Number.isSafeInteger(Math.floor(futureNominal))) {
    throw new RangeError('Projection exceeds safe rupee precision');
  }
  const futurePurchasingPower = rupees(futureNominal / Math.pow(1 + annualInflationAssumption / 100, years));
  if (!Number.isFinite(futurePurchasingPower) || !Number.isSafeInteger(Math.floor(futurePurchasingPower))) {
    throw new RangeError('Inflation-adjusted projection exceeds safe rupee precision');
  }
  return { futureNominal, futurePurchasingPower, totalContributed: rupees(capital + months * contribution),
    returnBasis: 'USER_HYPOTHETICAL_PRE_TAX', taxStatus: 'NOT_CALCULATED',
    forecast: false, guarantee: false, policyVersion: GOAL_FINANCE_POLICY_VERSION };
}

/**
 * No-growth cash-savings baseline for a typed goal. Not an investment projection.
 * Current savings are treated as unique to the goal only when declared by user;
 * their overlap with other goals cannot be established automatically.
 */
export function planGoalSpecification(spec, now = new Date()) {
  if (!spec || typeof spec !== 'object') throw new TypeError('Goal specification required');
  const currentSavings = money(spec.currentSavings, 'currentSavings');
  const targetAmount = money(spec.targetAmount, 'targetAmount');
  const inflation = spec.annualPriceInflationPct;
  if (typeof inflation !== 'number' || !Number.isFinite(inflation) || inflation < 0 || inflation > 30) {
    throw new RangeError('Annual target-price inflation assumption must be 0–30%');
  }
  const targetDate = new Date(spec.targetDate);
  const asOf = new Date(now);
  if (!Number.isFinite(targetDate.getTime()) || !Number.isFinite(asOf.getTime())) {
    throw new TypeError('Valid goal and calculation dates are required');
  }
  const millisecondsRemaining = targetDate.getTime() - asOf.getTime();
  if (millisecondsRemaining <= 0) return {
    status: 'TARGET_DATE_REACHED', monthsRemaining: 0,
    futureTargetAmount: targetAmount, monthlyNeededWithoutReturns: null,
    remainingGap: rupees(Math.max(0, targetAmount - currentSavings)),
    assumptionSource: 'USER_DECLARED', forecast: false,
    policyVersion: GOAL_FINANCE_POLICY_VERSION,
  };
  const monthsRemaining = Math.max(1, Math.ceil(millisecondsRemaining / (365.25 * 86400 * 1000 / 12)));
  if (monthsRemaining > 600) throw new RangeError('Goal date beyond 50-year planning horizon');
  // Use the same modeled month count for cost inflation and cash funding,
  // preventing annual targets from drifting due to 365 vs 365.25 days.
  const modeledYears = monthsRemaining / 12;
  const futureTargetAmount = rupees(targetAmount * Math.pow(1 + inflation / 100, modeledYears));
  if (futureTargetAmount > MAX_RUPEES) {
    throw new RangeError('Inflated target exceeds supported planning amount');
  }
  const remainingGap = rupees(Math.max(0, futureTargetAmount - currentSavings));
  const monthlyNeededWithoutReturns = rupees(Math.ceil(remainingGap * 100 / monthsRemaining) / 100);
  return {
    status: remainingGap === 0 ? 'CASH_TARGET_FUNDED' : 'MONTHLY_FUNDING_REQUIRED',
    monthsRemaining, futureTargetAmount, remainingGap, monthlyNeededWithoutReturns,
    returnAssumption: 0, taxStatus: 'NOT_CALCULATED',
    assumptionSource: 'USER_DECLARED', forecast: false, guarantee: false,
    policyVersion: GOAL_FINANCE_POLICY_VERSION,
  };
}
