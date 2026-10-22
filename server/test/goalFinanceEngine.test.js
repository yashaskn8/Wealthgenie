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
  assert.equal(purchaseResult.purchaseMonthSurplusAfterPurchase,
    purchaseResult.monthlySurplusAfterPurchase - 5000);
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
  assert.equal(withoutGoals.status, 'AFFORDABLE_WITH_DECLARED_BUFFER');
  const withEducationAndEmergency = assessVehiclePurchase(budget, scenario, { monthlyGoalCommitments: 40000 });
  assert.equal(withEducationAndEmergency.status, 'BUDGET_SHORTFALL');
  assert.ok(withEducationAndEmergency.reasons.includes('GOALS_AND_PURCHASE_EXCEED_SAVINGS'));
  assert.equal(withEducationAndEmergency.requiredMonthlyGoalContributions, 40000);
  assert.ok(Math.abs(withEducationAndEmergency.purchaseMonthSurplusAfterGoals
    - (withEducationAndEmergency.purchaseMonthSurplusAfterPurchase - 40000)) < 0.001);
  assert.equal(assessVehiclePurchase(budget, scenario).status, 'DATA_INSUFFICIENT');
});
