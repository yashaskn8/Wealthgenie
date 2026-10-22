import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateGoalCompoundingScenario } from '../services/chatGoalScenarioMath.js';
import {
  isFinancialGoalPlanningQuestion, isFinancialGoalFollowUpQuestion,
  retrieveChatGoalPlanningEvidence,
} from '../services/chatGoalPlanning.js';
import { validateTypedFinancialClaims } from '../services/typedFinancialClaims.js';

test('scenario: high-precision effective annual CAGR is not mistaken for nominal 12% / 12', () => {
  const actual = calculateGoalCompoundingScenario({
    target: 20_000_000, earmarkedSavings: 0, months: 120, annualReturnPercent: '12',
  });
  // Independent Decimal reference: (1.12)^(1/12) - 1; end-of-month ordinary annuity.
  assert.equal(actual.requiredMonthlyContribution, 90_118.49);
  assert.equal(actual.inflatedTarget, 20_000_000);
  assert.equal(actual.rateConvention, 'EFFECTIVE_ANNUAL_CAGR');
  assert.equal(actual.monthlyPaymentTiming, 'END_OF_MONTH');
  assert.equal(actual.savedBalanceGrowth, 'NONE');
  assert.equal(actual.illustrativeOnly, true);
});

test('scenario: 6% annual inflation on a stated present-day wedding cost and 12% annual return', () => {
  const actual = calculateGoalCompoundingScenario({
    target: 20_000_000, earmarkedSavings: 2_000_000, months: 120,
    annualReturnPercent: '12', annualInflationPercent: '6', targetIsPresentValue: true,
  });
  assert.equal(actual.inflatedTarget, 35_816_953.94);
  assert.equal(actual.requiredMonthlyContribution, 152_376.64);
  assert.equal(actual.treatment, 'GROSS_BEFORE_TAX_FEES_AND_UNMODELED_COSTS');
});

test('scenario: zero/negative rates and short tenors use paise ceiling; no return is not automatically invented', () => {
  assert.equal(calculateGoalCompoundingScenario({
    target: 10_000_000, months: 120, annualReturnPercent: '0',
  }).requiredMonthlyContribution, 83_333.34);
  assert.equal(calculateGoalCompoundingScenario({
    target: 10_000_000, months: 12, annualReturnPercent: '12',
  }).requiredMonthlyContribution, 790_732.75);
  assert.equal(calculateGoalCompoundingScenario({
    target: 20_000_000, months: 120, annualReturnPercent: '-10',
  }).requiredMonthlyContribution, 268_426.89);
});

test('scenario: invalid percentage basis, invalid money, oversized or missing rate are never projected', () => {
  const base = { target: 20_000_000, earmarkedSavings: 0, months: 120 };
  for (const annualReturnPercent of ['-100', '101', '1000', '12.12345', 'not-a-rate', null]) {
    assert.equal(calculateGoalCompoundingScenario({ ...base, annualReturnPercent }), null);
  }
  assert.equal(calculateGoalCompoundingScenario({ ...base, months: 0, annualReturnPercent: '12' }), null);
  assert.equal(calculateGoalCompoundingScenario({ ...base, target: 0, annualReturnPercent: '12' }), null);
  assert.equal(calculateGoalCompoundingScenario({ ...base, earmarkedSavings: -1, annualReturnPercent: '12' }), null);
  assert.equal(calculateGoalCompoundingScenario({
    ...base, annualReturnPercent: '12', annualInflationPercent: '6',
    targetIsPresentValue: false,
  }), null);
});

test('goal integration: user-provided 12% return produces an explicit conditional scenario', () => {
  const question = "I need 2 crore for my daughter's marriage in 10 years assuming 12% annual return";
  assert.equal(isFinancialGoalPlanningQuestion(question), true);
  const entries = retrieveChatGoalPlanningEvidence(question);
  const rate = entries.find(e => e.id === 'E_GOAL_RETURN_SCENARIO');
  const baseline = entries.find(e => e.id === 'E_GOAL_MONTHLY_BASELINE');
  assert.ok(rate);
  assert.ok(baseline);
  assert.equal(rate.value.scenario, 'ZERO_START_CONDITIONAL');
  assert.equal(rate.value.annualReturnPercent, 12);
  assert.equal(rate.value.monthlyRequiredAmount, 90_118.49);
  assert.equal(rate.value.beforeTax, true);
  assert.equal(baseline.value.monthlyRequiredAmount, 166_666.67);
});

test('goal integration: annual rate assumptions are inherited from trusted financial USER turns only', () => {
  const previous = [{ role: 'user', content: "I need 2 crore for my daughter's marriage in 10 years" }];
  assert.equal(isFinancialGoalFollowUpQuestion('What if annual return is 12%?', previous), true);
  const entries = retrieveChatGoalPlanningEvidence('What if annual return is 12%?', { priorUserTurns: previous });
  assert.equal(entries.find(e => e.id === 'E_GOAL_RETURN_SCENARIO')?.value.monthlyRequiredAmount, 90_118.49);
});

test('goal integration: inflation without present-cost basis must not silently change the corpus', () => {
  const entries = retrieveChatGoalPlanningEvidence('I need 2 crore in 10 years with 6% annual inflation');
  assert.equal(entries.some(e => e.id === 'E_GOAL_RETURN_SCENARIO'), false);
  assert.match(entries.find(e => e.id === 'E_GOAL_PLANNING_GUIDANCE').displayValue, /present-day cost/);
});

test('goal integration: nominal monthly rates and out-of-range growth assumptions fail closed', () => {
  const entries = retrieveChatGoalPlanningEvidence("I need 2 crore for daughter's marriage in 10 years, 12% nominal annual return");
  assert.equal(entries.some(e => e.id === 'E_GOAL_RETURN_SCENARIO'), false);
  assert.match(entries.find(e => e.id === 'E_GOAL_PLANNING_GUIDANCE').displayValue, /Conflicting annual-rate assumptions|growth assumptions/i);
});

test('typed financial claim: adversarial model cannot substitute a cheaper monthly SIP amount', () => {
  const entries = retrieveChatGoalPlanningEvidence("I need 2 crore for daughter's marriage in 10 years with 12% annual return");
  const entry = entries.find(e => e.id === 'E_GOAL_RETURN_SCENARIO');
  assert.ok(entry);
  const makeClaim = value => ({
    type: 'GOAL_RETURN_SCENARIO_PAYMENT', value, unit: 'INR_PER_MONTH',
    timePeriod: 'MONTHLY_USER_ASSUMPTION_SCENARIO', source: 'WEALTHGENIE_BACKEND',
    evidenceId: entry.id, jurisdiction: null, effectivePeriod: null,
    statement: 'Illustrative monthly goal payment: INR ' + value.toLocaleString('en-IN')
      + ' per month, not a forecast [' + entry.id + '].',
  });
  const good = makeClaim(entry.value.monthlyRequiredAmount);
  assert.equal(validateTypedFinancialClaims({
    claims: [good], narrative: good.statement, evidenceEntries: entries,
  }).passed, true);
  const bad = makeClaim(entry.value.monthlyRequiredAmount - 100);
  assert.equal(validateTypedFinancialClaims({
    claims: [bad], narrative: bad.statement, evidenceEntries: entries,
  }).passed, false);
});


test('metamorphic red-team: user-assumed growth, horizon and earmarked cash obey monotonicity', () => {
  for (let i = 0; i < 60; i += 1) {
    const target = 1_000_000 + 2_345.67 * i;
    const months = 36 + i;
    const rate = String(1 + i % 14);
    const common = { target, months, annualReturnPercent: rate, earmarkedSavings: 50_000 };
    const base = calculateGoalCompoundingScenario(common);
    const moreTime = calculateGoalCompoundingScenario({ ...common, months: months + 12 });
    const betterRate = calculateGoalCompoundingScenario({ ...common, annualReturnPercent: String(2 + i % 14) });
    const moreCash = calculateGoalCompoundingScenario({ ...common, earmarkedSavings: 60_000 });
    const biggerGoal = calculateGoalCompoundingScenario({ ...common, target: target + 10_000 });
    assert.ok(base && moreTime && betterRate && moreCash && biggerGoal, i);
    assert.ok(moreTime.requiredMonthlyContribution <= base.requiredMonthlyContribution, i);
    assert.ok(betterRate.requiredMonthlyContribution <= base.requiredMonthlyContribution, i);
    assert.ok(moreCash.requiredMonthlyContribution <= base.requiredMonthlyContribution, i);
    assert.ok(biggerGoal.requiredMonthlyContribution >= base.requiredMonthlyContribution, i);
    assert.equal(Math.round(base.requiredMonthlyContribution * 100),
      base.requiredMonthlyContribution * 100, 'Expected integer paise');
  }
});

test('metamorphic red-team: higher stated inflation cannot lower the payment', () => {
  const common = {
    target: 2_000_000, months: 132, earmarkedSavings: 0,
    annualReturnPercent: '8', targetIsPresentValue: true,
  };
  const low = calculateGoalCompoundingScenario({ ...common, annualInflationPercent: '4' });
  const high = calculateGoalCompoundingScenario({ ...common, annualInflationPercent: '7' });
  assert.ok(low && high);
  assert.ok(high.inflatedTarget > low.inflatedTarget);
  assert.ok(high.requiredMonthlyContribution > low.requiredMonthlyContribution);
});

test('input red-team: annual returns are not silently extracted from unrelated percentages', () => {
  const entries = retrieveChatGoalPlanningEvidence(
    'Need 2 crore for my daughter wedding in 10 years; income tax rate 30%; 12% annual return and 6% inflation',
  );
  assert.equal(entries.some(e => e.id === 'E_GOAL_RETURN_SCENARIO'), false,
    'Inflation cannot be applied when current-versus-future cost basis is unspecified');
  const second = retrieveChatGoalPlanningEvidence(
    "Need 2 crore for daughter's wedding at today's prices in 10 years with 12% annual return and 6% annual inflation",
  );
  assert.equal(second.find(e => e.id === 'E_GOAL_RETURN_SCENARIO')?.value.inflationAdjustedTargetAmount,
    35_816_953.94);
});
