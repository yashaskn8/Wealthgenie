import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSipPlan } from '../services/sipPlanningEngine.js';
import { sipFV, stepUpSipFV } from '../services/projectionEngine.js';

const base = Object.freeze({
  monthlyInvestment: 1000,
  annualReturnRate: 0.12,
  annualStepUpRate: 0.1,
  years: 3,
});

test('zero returns: no invented growth and correct stepped principal', () => {
  const result = buildSipPlan({ ...base, annualReturnRate: 0, annualStepUpRate: 0.1 });
  assert.equal(result.flatFinal, 36000);
  assert.equal(result.stepUpInvested, 39720);
  assert.equal(result.stepUpFinal, 39720);
  assert.equal(result.stepUpProjectedGrowth, 0);
  assert.equal(result.additionalCorpus, 3720);
  assert.equal(result.additionalContributions, 3720);
  assert.equal(result.additionalProjectedGrowth, 0);
  assert.deepEqual(result.chartData.map(row => row.monthlySip), [1000, 1100, 1210]);
});

test('zero step-up means exactly identical investments and wealth', () => {
  const result = buildSipPlan({ ...base, annualStepUpRate: 0 });
  assert.equal(result.flatFinal, result.stepUpFinal);
  assert.equal(result.flatInvested, result.stepUpInvested);
  assert.equal(result.additionalCorpus, 0);
  assert.equal(result.additionalProjectedGrowth, 0);
});

test('reference annuity-due engines agree for fixed and annual step-up contributions', () => {
  for (const rate of [-0.25, 0, 0.08, 0.12, 0.35]) {
    for (const years of [1, 3, 10, 20]) {
      const result = buildSipPlan({
        ...base, annualReturnRate: rate, annualStepUpRate: 0.05, years,
      });
      assert.ok(Math.abs(result.flatFinal - sipFV(1000, rate, years)) <= 1,
        'flat SIP disagreement at '+rate+' / '+years);
      // Legacy formula compounds theoretical sub-paise instalments. The planner
      // instead schedules actual annual SIP payments rounded to paise.
      const legacy = stepUpSipFV(1000, rate, years, 0.05);
      const upperBound = 1 + 0.005 * 12 * years
        * Math.pow(1 + Math.max(rate, 0) / 12, years * 12);
      assert.ok(Math.abs(result.stepUpFinal - legacy) <= upperBound,
        'step-up exceeds accumulated paise-rounding bound at '+rate+' / '+years);
      assert.equal(result.additionalCorpus, result.stepUpFinal - result.flatFinal);
      assert.equal(result.additionalProjectedGrowth,
        result.additionalCorpus - result.additionalContributions);
    }
  }
});

test('terminal inflation adjustment deflates the nominal terminal rupees', () => {
  const result = buildSipPlan({ ...base, inflationRate: 0.07 });
  const expected = Math.round(result.stepUpFinal / Math.pow(1.07, 3));
  assert.ok(Math.abs(result.inflationAdjustedStepUpFinal - expected) <= 1);
  assert.equal(result.chartData.at(-1).inflationAdjustedStepUp, result.inflationAdjustedStepUpFinal);
});

test('downside zero-return scenario equals the actual stepped contributions', () => {
  const result = buildSipPlan({ ...base, downsideAnnualReturnRate: 0 });
  assert.equal(result.downsideFinal, result.stepUpInvested);
  assert.equal(result.scenario_interpretation, 'ILLUSTRATIVE_CONSTANT_RETURN_PATHS_NOT_PROBABILITIES');
});

test('declared expense and EMI affordability are checked for each future contribution year', () => {
  const result = buildSipPlan({
    ...base, years: 10, annualReturnRate: 0.07,
    monthlyIncome: 10000, monthlyExpenses: 7500, monthlyEmi: 1500,
    annualIncomeGrowthRate: 0, annualExpenseGrowthRate: 0,
  });
  assert.equal(result.affordability.status, 'OVER_DECLARED_BUDGET');
  assert.equal(result.affordability.firstUnaffordableMonth, 13);
  assert.ok(result.affordability.maxMonthlyShortfall > 0);
  assert.equal(result.affordability.annualContributionSchedule[0].monthlyBudgetSurplus, 0);
  assert.equal(result.affordability.annualContributionSchedule[1].monthlyBudgetSurplus, -100);
});

test('missing expenses or unknown EMI cannot turn into a false affordability pass', () => {
  const missing = buildSipPlan({ ...base, monthlyIncome: 50000 });
  assert.equal(missing.affordability.status, 'NOT_ASSESSED');
  assert.equal(missing.emergency_buffer.status, 'NOT_ASSESSED');
  const missingEmi = buildSipPlan({
    ...base, monthlyIncome: 50000, monthlyExpenses: 20000,
    emergencySavings: 200000,
  });
  assert.equal(missingEmi.affordability.status, 'NOT_ASSESSED');
  assert.equal(missingEmi.emergency_buffer.status, 'NOT_ASSESSED');
  assert.ok(missingEmi.warnings.includes('MONTHLY_EMI_NOT_DECLARED'));
});

test('declared emergency coverage requires explicit expenses, EMI and reserve', () => {
  const result = buildSipPlan({
    ...base, monthlyIncome: 50000, monthlyExpenses: 10000,
    monthlyEmi: 5000, emergencySavings: 75000, emergencyMonths: 6,
  });
  assert.equal(result.emergency_buffer.requiredAmount, 90000);
  assert.equal(result.emergency_buffer.status, 'DECLARED_BUFFER_SHORT');
  assert.equal(buildSipPlan({
    ...base, monthlyExpenses: 10000, monthlyEmi: 5000,
    emergencySavings: 90000,
  }).emergency_buffer.status, 'DECLARED_BUFFER_MET');
});

test('model is key-free, deterministic, explicitly pre-tax and not an actual-return forecast', () => {
  const x = buildSipPlan(base);
  assert.deepEqual(x, buildSipPlan(base));
  assert.equal(x.return_basis, 'PRE_TAX_NOMINAL');
  assert.equal(x.monthly_rate_convention, 'NOMINAL_APR_DIVIDED_BY_12');
  assert.equal(x.observed_market_fact, false);
  assert.equal(x.provider_forecast, false);
  assert.equal(x.capital_gains_tax, null);
  assert.equal(x.estimated_post_tax_corpus, null);
  assert.ok(x.warnings.includes('PRE_TAX_NOT_A_TAX_ESTIMATE'));
});

test('invalid, malicious and money-precision edge cases are rejected', () => {
  for (const patch of [
    { monthlyInvestment: 0 }, { monthlyInvestment: -1 }, { monthlyInvestment: NaN },
    { monthlyInvestment: Infinity }, { monthlyInvestment: 1000.001 },
    { monthlyInvestment: 10000001 }, { years: 0 }, { years: 1.5 },
    { years: 51 }, { annualReturnRate: -1 }, { annualReturnRate: 1.1 },
    { annualStepUpRate: -0.01 }, { annualStepUpRate: 1.1 },
    { monthlyEmi: -1 }, { monthlyIncome: 100.001 }, { monthlyExpenses: -1 },
    { inflationRate: 1.1 }, { downsideAnnualReturnRate: -1 }, { downsideAnnualReturnRate: 0.13 },
    { annualIncomeGrowthRate: 1.1 }, { emergencyMonths: 25 },
    { annualExpenseGrowthRate: Infinity },
  ]) {
    assert.throws(() => buildSipPlan({ ...base, ...patch }), /SIP_PLAN_INVALID_INPUT|SIP_PLAN_LIMIT_EXCEEDED/);
  }
  assert.throws(() => buildSipPlan({
    ...base, monthlyInvestment: 10000000, annualStepUpRate: 1, years: 50,
  }), /SIP_PLAN_LIMIT_EXCEEDED/);
  assert.throws(() => buildSipPlan({
    ...base, monthlyIncome: 100000000, monthlyExpenses: 0, monthlyEmi: 0,
    annualIncomeGrowthRate: 1, years: 50,
  }), /SIP_PLAN_LIMIT_EXCEEDED/);
});

test('independent monthly cash-flow oracle matches chart contributions and terminal corpus', () => {
  for (const [starting, g, annualReturn, yrs] of [
    [1000, 0, 0, 1], [1000, 0.1, 0.12, 15],
    [500, 0.075, -0.25, 12], [12500.37, 0.033, 0.06, 7],
    [23000, 0.4, 0, 6], [600, 0.04, 0.3, 20],
  ]) {
    const result = buildSipPlan({
      monthlyInvestment: starting, annualStepUpRate: g,
      annualReturnRate: annualReturn, years: yrs,
    });
    let invested = 0;
    let corpus = 0;
    for (let m = 0; m < yrs * 12; m += 1) {
      const annualContribution = Math.round(starting * Math.pow(1 + g, Math.floor(m / 12)) * 100) / 100;
      invested += annualContribution;
      corpus = (corpus + annualContribution) * (1 + annualReturn / 12);
      if (m % 12 === 11) {
        const yearly = result.chartData[Math.floor(m / 12)];
        assert.equal(yearly.stepUpInvested, Math.round(invested * 100) / 100);
        assert.equal(yearly.stepUpSIP, Math.round(corpus));
      }
    }
    assert.equal(result.stepUpFinal, Math.round(corpus));
    assert.equal(result.stepUpInvested, Math.round(invested * 100) / 100);
  }
});

test('money contributions retain exact paise instead of silently rounding to whole INR', () => {
  const result = buildSipPlan({
    monthlyInvestment: 1000.37, annualReturnRate: 0,
    annualStepUpRate: 0, years: 2, monthlyIncome: 12345.67,
    monthlyExpenses: 1000.13, monthlyEmi: 0,
    emergencySavings: 6000.78, emergencyMonths: 6,
  });
  assert.equal(result.chartData[0].flatInvested, 12004.44);
  assert.equal(result.stepUpInvested, 24008.88);
  assert.equal(result.additionalContributions, 0);
  assert.equal(result.stepUpFinal, Math.round(result.stepUpInvested));
  assert.equal(result.emergency_buffer.requiredAmount, 6000.78);
  assert.equal(result.emergency_buffer.status, 'DECLARED_BUFFER_MET');
  assert.equal(result.affordability.status, 'WITHIN_DECLARED_BUDGET');
});

test('downside scenario cannot use a higher annual return than the main projection', () => {
  assert.throws(() => buildSipPlan({
    ...base, annualReturnRate: 0.02, downsideAnnualReturnRate: 0.08,
  }), /SIP_PLAN_INVALID_INPUT/);
  const negative = buildSipPlan({ ...base, annualReturnRate: -0.995 });
  assert.ok(negative.assumptions.downsideAnnualReturnRate <= negative.assumptions.annualReturnRate);
  assert.ok(negative.downsideFinal <= negative.stepUpFinal);
});
