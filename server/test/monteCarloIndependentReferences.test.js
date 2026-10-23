import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMulberry32, runMonteCarlo, runMonteCarloWithGoal,
  sampleLogNormalMonthly, reverseSIP,
} from '../services/monteCarloEngine.js';
import { calculatePostTaxReturn, calculatePostTaxProjection } from '../services/postTaxCalculator.js';

const run=(overrides={})=>runMonteCarlo({
  monthlyInvestment:2500,currentSavings:120000,annualExpectedReturn:0.08,
  annualVolatility:0.20,years:2,simulations:400,
  inflationRate:0.05,seed:0,...overrides,
});
test('explicit seed zero is reproducible and must not collide with seed 1337',()=>{
  assert.notEqual(createMulberry32(0)(),createMulberry32(1337)());
  const a=run(), b=run(), c=run({seed:1337});
  assert.deepEqual(a.p50,b.p50);
  assert.deepEqual(a.finalValues,b.finalValues);
  assert.notDeepEqual(a.finalValues,c.finalValues);
  assert.equal(a.seed_used,0);
  assert.equal(a.is_reproducible,true);
});
test('zero-volatility deterministic reference matches every simulated percentile',()=>{
  for(const annual of [-0.07,0,0.12]){
    for(const years of [1,3,10]){
      const nominal=run({annualExpectedReturn:annual,annualVolatility:0,years,simulations:100});
      let money=120000;
      for(let m=0;m<years*12;m++)money=(money+2500)*Math.pow(1+annual,1/12);
      for(const band of ['p10','p25','p50','p75','p90','mean']){
        assert.ok(Math.abs(nominal[band].at(-1)-money)<=1,band+': '+years);
      }
      assert.ok(Math.abs(nominal.deterministic_fv-money)<=1);
      assert.equal(nominal.p10.at(-1),nominal.p90.at(-1));
      const real=money/Math.pow(1.05,years);
      assert.ok(Math.abs(nominal.p50_real.at(-1)-real)<=1);
    }
  }
});
test('GBM monthly log-return drift uses log1p annual effective return',()=>{
  const multiplier=sampleLogNormalMonthly(0.12,0,1.7);
  assert.ok(Math.abs(multiplier-Math.pow(1.12,1/12))<1e-12);
});
test('goal success is exactly zero or one with zero uncertainty when no stochastic volatility',()=>{
 const low=runMonteCarloWithGoal({monthlyInvestment:2500,currentSavings:120000,
   annualExpectedReturn:0.08,annualVolatility:0,years:1,
   simulations:200,inflationRate:0.05,targetAmount:1e12,seed:0});
 assert.equal(low.goal_probability,0);
 assert.equal(low.goal_probability_ci,null);
 const high=runMonteCarloWithGoal({monthlyInvestment:2500,currentSavings:120000,
   annualExpectedReturn:0.08,annualVolatility:0,years:1,
   simulations:200,inflationRate:0.05,targetAmount:1,seed:0});
 assert.equal(high.goal_probability,1);
 assert.equal(high.goal_probability_ci_status,'NOT_ESTIMATED_DEPENDENT_SIMULATIONS');
});

test('large finite balances never produce unsafe rounded rupee forecasts',()=>{
  assert.throws(()=>run({currentSavings:1e16}),/SIMULATION_WEALTH_PRECISION_EXCEEDED/);
  assert.throws(()=>run({currentSavings:1e14,years:30,
    annualExpectedReturn:1,annualVolatility:0,simulations:100}),
    /SIMULATION_WEALTH_PRECISION_EXCEEDED/);
  assert.throws(()=>run({monthlyInvestment:1e15,years:30,
    annualExpectedReturn:1,annualVolatility:0,simulations:100}),
    /SIMULATION_WEALTH_PRECISION_EXCEEDED/);
});

test('reverse SIP and forward annuity use the same annual effective return',()=>{
 const target=1250000,rate=.12,years=6,savings=45000;
 const monthlyRate=Math.expm1(Math.log1p(rate)/12);
 const contribution=reverseSIP(target,rate,years,savings);
 const fv=savings*Math.pow(1+monthlyRate,years*12)
  +contribution*((Math.pow(1+monthlyRate,years*12)-1)/monthlyRate)*(1+monthlyRate);
 assert.ok(Math.abs(fv-target)<0.01);
});

test('seeded 30-year simulated mean stays within five percent of independent analytical reference', () => {
  const scenario = run({
    monthlyInvestment: 10000, currentSavings: 0,
    annualExpectedReturn: 0.15, annualVolatility: 0.18,
    years: 30, simulations: 10000, seed: 20261021,
  });
  const error = Math.abs(scenario.mean.at(-1) - scenario.deterministic_fv) / scenario.deterministic_fv;
  assert.ok(error < 0.05, `30-year sampling deviation: ${(error * 100).toFixed(2)}%`);
  assert.equal(scenario.variance_reduction, 'antithetic');
  assert.equal(scenario.model_version, 'monte-carlo-gbm-2.3.0');
});

test('cash-flow and Monte Carlo nominal engines reconcile when their rate conventions match', () => {
  // This is a model-arithmetic consistency test, NOT approval to run GBM for
  // fixed deposits in the HTTP API or proof of any issuer-specific product rate.
  const monthlySIP = 2500;
  const context = {
    annualGrossIncome: 0, regime: 'new', incomeSource: 'salary',
    userAge: 35, fiscalYear: 'FY2026-27', deductions: {},
  };
  for (const years of [1, 3, 5]) {
    for (const nominalAPR of [0, 0.05, 0.08, 0.12]) {
      const annualEffective = Math.pow(1 + nominalAPR / 12, 12) - 1;
      const monteCarlo = run({
        monthlyInvestment: monthlySIP, currentSavings: 0,
        annualExpectedReturn: annualEffective, annualVolatility: 0,
        years, simulations: 100, inflationRate: 0,
      });
      const taxResult = calculatePostTaxReturn(
        'FD', nominalAPR, context.annualGrossIncome, years, 'new',
        monthlySIP, 35, 'salary', undefined, 'FY2026-27', { deductions: {} },
      );
      const cashFlow = calculatePostTaxProjection(
        taxResult, { nominalRate: nominalAPR, holdingYears: years, monthlySIP },
        0, context,
      );
      assert.equal(cashFlow.status, 'CALCULATED');
      assert.equal(cashFlow.taxEvents.every(event => event.tax === 0), true);
      assert.ok(Math.abs(monteCarlo.p50.at(-1) - cashFlow.nominalFutureValue) <= 1,
        `nominal reconciliation failed for APR ${nominalAPR} over ${years} years`);
      assert.ok(Math.abs(cashFlow.postTaxFutureValue - cashFlow.nominalFutureValue) <= 1);
    }
  }
});

test('same investment amounts with different rate assumptions yield different nominal outcomes', () => {
  const low = run({
    currentSavings: 0, monthlyInvestment: 15000,
    annualExpectedReturn: 0.06, annualVolatility: 0, years: 5,
  });
  const high = run({
    currentSavings: 0, monthlyInvestment: 15000,
    annualExpectedReturn: 0.12, annualVolatility: 0, years: 5,
  });
  assert.ok(high.p50.at(-1) > low.p50.at(-1));
  assert.equal(low.p10.at(-1), low.p90.at(-1));
  assert.equal(high.p10.at(-1), high.p90.at(-1));
});
