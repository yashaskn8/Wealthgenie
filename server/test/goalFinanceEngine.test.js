import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeGoalBudget, allocateGoalFunding, calculateEmi,
  assessVehiclePurchase, projectGoalSavings, planGoalSpecification,
} from '../services/goalFinanceEngine.js';

const sampleBudget = () => ({
  monthlyIncome: 60000,
  expensesComplete: true,
  protectedMonthlyContributions: 4000,
  expenses: [
    { category: 'housing', frequency: 'recurring', amount: 18000 },
    { category: 'existing_emi', frequency: 'recurring', amount: 12000 },
    { category: 'groceries', frequency: 'recurring', amount: 8000 },
    { category: 'healthcare', frequency: 'one_off', amount: 5000 },
  ],
});
const goal = (id, sip, priority = 'High') => ({
  goalId: id, goal_name: id, priority, target_date: '2028-01-01',
  recommended_sip: sip, current_savings: 0, calculation_freshness: { fresh: true },
});
const purchaseWithoutExistingGoals = (budget, scenario) =>
  assessVehiclePurchase(budget, scenario, { monthlyGoalCommitments: 0 });
const purchase = () => ({
  price: 900000, downPayment: 200000, upfrontFees: 15000, monthlyOwnershipCost: 4500,
  annualInterestRate: 10, tenureMonths: 60, emergencyCash: 400000, emergencyFloor: 150000,
});

test('budget separates recurring spending, one-off spending and protected monthly savings', () => {
  const result = summarizeGoalBudget(sampleBudget());
  assert.equal(result.recurringExpenses, 38000);
  assert.equal(result.oneOffExpenses, 5000);
  assert.equal(result.recurringSurplus, 18000);
  assert.equal(result.actualMonthSurplus, 13000);
  assert.equal(result.verifiedByBank, false);
  assert.equal(result.budgetStatus, 'SELF_REPORTED');
});
test('budget cannot declare missing income, unconfirmed expenses or negative surplus affordable', () => {
  assert.equal(summarizeGoalBudget({ ...sampleBudget(), monthlyIncome: null }).budgetStatus, 'DATA_INSUFFICIENT');
  assert.equal(summarizeGoalBudget({ ...sampleBudget(), expensesComplete: false }).budgetStatus, 'DATA_INSUFFICIENT');
  assert.equal(summarizeGoalBudget({ ...sampleBudget(), monthlyIncome: 2000 }).budgetStatus, 'BUDGET_SHORTFALL');
  assert.throws(() => summarizeGoalBudget({ ...sampleBudget(), expenses: [{ category: 'fake', frequency: 'recurring', amount: 10 }] }), /Invalid expense/);
  assert.throws(() => summarizeGoalBudget({ ...sampleBudget(), monthlyIncome: NaN }), /monthlyIncome/);
});
test('two goals share one capacity; priority controls allocation, not duplication', () => {
  const plan = allocateGoalFunding([goal('car', 9000, 'Medium'), goal('emergency', 12000, 'Critical')], 18000);
  assert.equal(plan.status, 'OVERCOMMITTED');
  assert.equal(plan.totalRequested, 21000);
  assert.equal(plan.totalAllocated, 18000);
  assert.deepEqual(plan.allocations.map(g => [g.goalId, g.allocatedMonthly]), [
    ['emergency', 12000], ['car', 6000],
  ]);
  assert.equal(plan.allocations[1].shortfallMonthly, 3000);
  assert.equal(plan.remainingCapacity, 0);
});
test('stale or missing goal never receives a confident funding allocation', () => {
  const stale = goal('stale', 7000);
  stale.calculation_freshness.fresh = false;
  const plan = allocateGoalFunding([goal('fresh', 5000), stale], 18000);
  assert.equal(plan.status, 'DATA_INSUFFICIENT');
  assert.equal(plan.totalAllocated, null);
  assert.deepEqual(plan.allocations.map(g => g.allocatedMonthly), [null, null]);
  assert.equal(allocateGoalFunding([goal('g', 100)], null).status, 'DATA_INSUFFICIENT');
  assert.throws(() => allocateGoalFunding([goal('g', 1), goal('g', 2)], 100), /Duplicate/);
});
test('zero-interest amortization and nonzero EMI arithmetic are bounded', () => {
  assert.deepEqual(
    (({ monthlyEmi, totalRepayment, totalInterest }) => ({ monthlyEmi, totalRepayment, totalInterest }))(calculateEmi({ principal: 120000, annualInterestRate: 0, tenureMonths: 12 })),
    { monthlyEmi: 10000, totalRepayment: 120000, totalInterest: 0 },
  );
  const loan = calculateEmi({ principal: 700000, annualInterestRate: 10, tenureMonths: 60 });
  assert.ok(loan.monthlyEmi > 14800 && loan.monthlyEmi < 14900);
  assert.ok(loan.totalInterest > 190000 && loan.totalInterest < 200000);
  assert.throws(() => calculateEmi({ principal: 1, annualInterestRate: -2, tenureMonths: 10 }), /Interest/);
  assert.throws(() => calculateEmi({ principal: 1, annualInterestRate: 10, tenureMonths: 361 }), /duration/);
});
test('vehicle analysis respects upfront costs, monthly upkeep and emergency reserves', () => {
  const result = purchaseWithoutExistingGoals(sampleBudget(), purchase());
  assert.equal(result.priceBasis, 'USER_SUPPLIED_NOT_LIVE');
  assert.equal(result.lenderApproval, 'NOT_ASSESSED');
  assert.equal(result.upfront, 215000);
  assert.equal(result.emergencyCashAfterPurchase, 185000);
  assert.equal(result.status, 'BUDGET_SHORTFALL');
  assert.ok(result.monthlySurplusAfterPurchase < 0);
  const cheaper = purchaseWithoutExistingGoals(sampleBudget(), { ...purchase(), price: 500000 });
  assert.ok(cheaper.monthlySurplusAfterPurchase > result.monthlySurplusAfterPurchase);
  const unknown = purchaseWithoutExistingGoals({ ...sampleBudget(), expensesComplete: false }, purchase());
  assert.equal(unknown.status, 'DATA_INSUFFICIENT');
  const risky = purchaseWithoutExistingGoals({ ...sampleBudget(), monthlyIncome: 90000 }, { ...purchase(), emergencyFloor: 200000 });
  assert.equal(risky.status, 'RISK_WARNING');
  assert.throws(() => purchaseWithoutExistingGoals(sampleBudget(), { ...purchase(), downPayment: 1000000 }), /Down payment/);
});
test('goal projections label unsupported tax and return assumptions', () => {
  const result = projectGoalSavings({
    currentSavings: 10000, monthlyContribution: 1000, years: 1,
    annualReturnAssumption: 0, annualInflationAssumption: 0,
  });
  assert.equal(result.futureNominal, 22000);
  assert.equal(result.futurePurchasingPower, 22000);
  assert.equal(result.totalContributed, 22000);
  assert.equal(result.taxStatus, 'NOT_CALCULATED');
  assert.equal(result.guarantee, false);
  assert.throws(() => projectGoalSavings({
    currentSavings: 1, monthlyContribution: 1, years: 2,
    annualReturnAssumption: -100, annualInflationAssumption: 5,
  }), /annualReturnAssumption/);
});

test('typed goal cash baseline is price-inflation-aware without claiming investment growth', () => {
  const referenceDate = new Date('2026-10-23T00:00:00.000Z');
  const goal = {
    targetAmount: 600000, currentSavings: 120000, annualPriceInflationPct: 0,
    targetDate: '2027-10-23T00:00:00.000Z',
  };
  const forecast = planGoalSpecification(goal, referenceDate);
  assert.equal(forecast.futureTargetAmount, 600000);
  assert.equal(forecast.monthsRemaining, 12);
  assert.equal(forecast.monthlyNeededWithoutReturns, 40000);
  assert.equal(forecast.forecast, false);
  assert.equal(planGoalSpecification({ ...goal, annualPriceInflationPct: 10 }, referenceDate).futureTargetAmount, 660000);
  assert.equal(planGoalSpecification({ ...goal, targetDate: referenceDate }, referenceDate).status, 'TARGET_DATE_REACHED');
  assert.throws(() => planGoalSpecification({ ...goal, annualPriceInflationPct: 31 }, referenceDate), /inflation/);
  assert.throws(() => planGoalSpecification({ ...goal, targetDate: '2100-10-23' }, referenceDate), /50-year/);
});

test('one-off spending reduces this month, not nominal recurring earnings', () => {
  const budget = { ...sampleBudget(), monthlyIncome: 47000 };
  const result = summarizeGoalBudget(budget);
  assert.equal(result.recurringSurplus, 5000);
  assert.equal(result.actualMonthSurplus, 0);
  assert.equal(result.budgetStatus, 'SELF_REPORTED');
  const expensiveMonth = summarizeGoalBudget({ ...budget, monthlyIncome: 46000 });
  assert.equal(expensiveMonth.recurringSurplus, 4000);
  assert.equal(expensiveMonth.actualMonthSurplus, -1000);
  assert.equal(expensiveMonth.budgetStatus, 'BUDGET_SHORTFALL');
  const purchaseResult = purchaseWithoutExistingGoals(sampleBudget(), purchase());
  assert.equal(Math.round(purchaseResult.purchaseMonthSurplusAfterPurchase * 100),
    Math.round((purchaseResult.monthlySurplusAfterPurchase - 5000) * 100));
});
test('zero or omitted real-world vehicle costs never yield an affordable claim', () => {
  const base = { ...sampleBudget(), monthlyIncome: 95000 };
  assert.equal(purchaseWithoutExistingGoals(base, { ...purchase(), upfrontFees: 0 }).status, 'DATA_INSUFFICIENT');
  assert.equal(purchaseWithoutExistingGoals(base, { ...purchase(), monthlyOwnershipCost: 0 }).status, 'DATA_INSUFFICIENT');
  assert.throws(() => purchaseWithoutExistingGoals(base, { ...purchase(), price: 0, downPayment: 0 }), /price/);
  assert.equal(purchaseWithoutExistingGoals({ ...base, expensesComplete: false }, purchase()).status, 'DATA_INSUFFICIENT');
});
test('derived rupee limits reject unrepresentable goal targets, rather than giving extreme forecasts', () => {
  const now = new Date('2026-10-23T00:00:00.000Z');
  assert.throws(() => planGoalSpecification({
    targetAmount: 1_000_000_000, currentSavings: 0, annualPriceInflationPct: 30,
    targetDate: '2050-10-23',
  }, now), /Inflated target/);
  assert.throws(() => projectGoalSavings({
    currentSavings: 1_000_000_000, monthlyContribution: 1_000_000_000, years: 50,
    annualReturnAssumption: 100, annualInflationAssumption: 0,
  }), /precision/);
});

test('malformed persisted legacy goals cannot crash shared funding or receive money', () => {
  const good = goal('good', 3000);
  const bad = { ...goal('bad', 5000), target_date: 'invalid-date', priority: 'Suspicious' };
  const plan = allocateGoalFunding([good, bad], 20000);
  assert.equal(plan.status, 'DATA_INSUFFICIENT');
  assert.equal(plan.totalAllocated, null);
  assert.ok(plan.warnings.includes('INVALID_PERSISTED_GOAL_INPUT'));
  assert.ok(plan.allocations.every(item => item.allocatedMonthly === null));
  const badMoney = { ...goal('money', 3000), recommended_sip: 10.005 };
  const secondPlan = allocateGoalFunding([good, badMoney], 20000);
  assert.equal(secondPlan.status, 'DATA_INSUFFICIENT');
  assert.ok(secondPlan.warnings.includes('INVALID_PERSISTED_GOAL_INPUT'));
});

test('the same vehicle cannot be called affordable if it drains monthly commitments for other goals', () => {
  const budget = { ...sampleBudget(), monthlyIncome: 90000 };
  const scenario = { ...purchase(), price: 400000, downPayment: 200000,
    monthlyOwnershipCost: 3000 };
  const withoutGoals = assessVehiclePurchase(budget, scenario, { monthlyGoalCommitments: 0 });
  assert.equal(withoutGoals.status, 'PASSES_SELF_REPORTED_CHECKS');
  const withEducationAndEmergency = assessVehiclePurchase(budget, scenario, { monthlyGoalCommitments: 40000 });
  assert.equal(withEducationAndEmergency.status, 'BUDGET_SHORTFALL');
  assert.ok(withEducationAndEmergency.reasons.includes('GOALS_AND_PURCHASE_EXCEED_SAVINGS'));
  assert.equal(withEducationAndEmergency.requiredMonthlyGoalContributions, 40000);
  assert.ok(Math.abs(withEducationAndEmergency.purchaseMonthSurplusAfterGoals
    - (withEducationAndEmergency.purchaseMonthSurplusAfterPurchase - 40000)) < 0.001);
  assert.equal(assessVehiclePurchase(budget, scenario).status, 'DATA_INSUFFICIENT');
});

test('EMI ledger reconciles every rupee and paisa for fixed, zero and high rates', () => {
  let seed = 209381;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 750; i += 1) {
    const principal = Math.round((10000 + next() * 20_000_000) * 100) / 100;
    const annualInterestRate = i % 5 === 0 ? 0 : Math.round(next() * 4000) / 100;
    const tenureMonths = 1 + Math.floor(next() * 360);
    const loan = calculateEmi({ principal, annualInterestRate, tenureMonths });
    assert.equal(
      Math.round(loan.totalRepayment * 100),
      Math.round(principal * 100) + Math.round(loan.totalInterest * 100),
      `Loan did not reconcile for case ${i}`,
    );
    assert.ok(loan.monthlyEmi >= 0 && loan.finalPayment >= 0);
    assert.ok(loan.finalPayment < loan.monthlyEmi + 2);
    assert.ok(loan.totalInterest >= 0);
  }
  const zero = calculateEmi({ principal: 0, annualInterestRate: 0, tenureMonths: 60 });
  assert.equal(zero.totalRepayment, 0);
  assert.equal(zero.finalPayment, 0);
  const interesting = calculateEmi({ principal: 700000, annualInterestRate: 10, tenureMonths: 60 });
  assert.equal(
    Math.round(interesting.totalRepayment * 100),
    Math.round((interesting.loanPrincipal + interesting.totalInterest) * 100),
  );
});

test('two goals claiming positive saved balances cannot be called within capacity without separation evidence', () => {
  const first = { ...goal('car', 5000), current_savings: 50000 };
  const second = { ...goal('education', 4500), current_savings: 50000 };
  const output = allocateGoalFunding([first, second], 25000);
  assert.equal(output.status, 'DATA_INSUFFICIENT');
  assert.equal(output.totalRequested, null);
  assert.equal(output.totalAllocated, null);
  assert.ok(output.warnings.includes('MULTIPLE_GOALS_CLAIM_POTENTIALLY_OVERLAPPING_SAVINGS'));
  assert.ok(output.allocations.every(e => e.allocatedMonthly === null));
});

test('calendar-month goals never count one normal 31-day month as two payments', () => {
  const common = { targetAmount: 12000, currentSavings: 0, annualPriceInflationPct: 0 };
  const date = value => new Date(value + 'T00:00:00.000Z');
  const october = planGoalSpecification({ ...common, targetDate: '2026-11-23' }, date('2026-10-23'));
  assert.equal(october.monthsRemaining, 1);
  assert.equal(october.monthlyNeededWithoutReturns, 12000);
  assert.equal(planGoalSpecification({ ...common, targetDate: '2027-03-23' }, date('2027-02-23')).monthsRemaining, 1);
  assert.equal(planGoalSpecification({ ...common, targetDate: '2028-02-29' }, date('2028-01-29')).monthsRemaining, 1);
  assert.equal(planGoalSpecification({ ...common, targetDate: '2028-03-01' }, date('2028-02-29')).status, 'IMMEDIATE_FUNDING_REQUIRED');
  assert.equal(planGoalSpecification({ ...common, targetDate: '2027-11-24' }, date('2027-10-23')).monthsRemaining, 1);
  assert.equal(planGoalSpecification({ ...common, targetDate: '2027-10-23' }, date('2026-10-23')).monthsRemaining, 12);
  assert.equal(planGoalSpecification({ ...common, targetDate: '2026-10-23' }, date('2026-10-23')).status, 'TARGET_DATE_REACHED');
});
test('India-local date rollover is honored before UTC midnight', () => {
  const base = { targetAmount: 10000, currentSavings: 0, annualPriceInflationPct: 0 };
  const localOct23 = new Date('2026-10-22T20:00:00.000Z'); // 01:30 IST Oct 23
  assert.equal(planGoalSpecification({ ...base, targetDate: '2026-10-23' }, localOct23).status, 'TARGET_DATE_REACHED');
  const dueTomorrow = planGoalSpecification({ ...base, targetDate: '2026-10-24' }, localOct23);
  assert.equal(dueTomorrow.monthsRemaining, 0);
  assert.equal(dueTomorrow.status, 'IMMEDIATE_FUNDING_REQUIRED');
  assert.equal(dueTomorrow.monthlyNeededWithoutReturns, null);
  assert.equal(dueTomorrow.requiredLumpSumToday, 10000);
});

test('clamped payment dates prevent false monthly installments near month end', () => {
  const goalInput = { targetAmount: 70000, currentSavings: 0, annualPriceInflationPct: 0 };
  const calc = (start, end) => planGoalSpecification({ ...goalInput, targetDate: end },
    new Date(start + 'T00:00:00.000Z'));
  assert.equal(calc('2027-01-31', '2027-02-28').monthsRemaining, 1);
  assert.equal(calc('2027-01-31', '2027-02-27').status, 'IMMEDIATE_FUNDING_REQUIRED');
  assert.equal(calc('2026-10-23', '2026-11-24').monthsRemaining, 1);
  assert.equal(calc('2026-10-23', '2026-11-22').monthlyNeededWithoutReturns, null);
  assert.equal(calc('2026-10-23', '2026-11-22').requiredLumpSumToday, 70000);
  assert.equal(calc('2026-10-23', '2026-12-24').monthsRemaining, 2);
  assert.equal(calc('2026-10-23', '2026-12-22').monthsRemaining, 1);
});

test('missing deadline, blank title and suspected duplicated goals block affordability claims', () => {
  const missingDate = { ...goal('legacy', 3000), target_date: undefined };
  const missingTitle = { ...goal('untitled', 2000), goal_name: '   ' };
  for (const bad of [missingDate, missingTitle]) {
    const result = allocateGoalFunding([goal('valid', 1000), bad], 10000);
    assert.equal(result.status, 'DATA_INSUFFICIENT');
    assert.equal(result.totalAllocated, null);
    assert.ok(result.warnings.includes('INVALID_PERSISTED_GOAL_INPUT'));
  }
  const first = { ...goal('one', 2000), goal_name: '  School  Fees  ', target_date: '2028-12-20' };
  const duplicate = { ...goal('two', 2500), goal_name: 'school fees', target_date: '2028-12-20T00:00:00.000Z' };
  const duplicatePlan = allocateGoalFunding([first, duplicate], 10000);
  assert.equal(duplicatePlan.status, 'DATA_INSUFFICIENT');
  assert.equal(duplicatePlan.totalAllocated, null);
  assert.ok(duplicatePlan.warnings.includes('POSSIBLY_DUPLICATE_REAL_WORLD_GOAL'));
  const independent = allocateGoalFunding([first, { ...duplicate, target_date: '2029-12-20' }], 10000);
  assert.equal(independent.status, 'WITHIN_CAPACITY');
  assert.equal(independent.totalRequested, 4500);
});
