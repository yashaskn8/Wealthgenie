import test from 'node:test';
import assert from 'node:assert/strict';
import {runTaxAwareEquityLumpSumScenario} from '../services/taxAwareMonteCarlo.js';
const tax={
 annualGrossIncome:2000000,userAge:35,incomeSource:'salary',regime:'new',
 fiscalYear:'FY2026-27',deductions:{},section112AExemptionUsed:0,
};
const input={
 principal:100000,annualExpectedReturn:0.08,annualVolatility:0.15,
 years:1,simulations:100,inflationRate:0.05,seed:17,
 acquisitionDate:'2025-06-01',redemptionDate:'2026-06-01',taxContext:tax,
 targetAmount:110000,
};
test('tax-aware Monte Carlo uses canonical tax policy on bounded hypothetical lump-sum equity paths',()=>{
 const a=runTaxAwareEquityLumpSumScenario(input);
 assert.equal(a.status,'CALCULATED');
 assert.equal(a.dataClass,'USER_DECLARED_MODEL_SCENARIO');
 assert.equal(a.notLiveMarketData,true);
 assert.ok(a.netPercentiles.p10<=a.netPercentiles.p50);
 assert.ok(a.netPercentiles.p50<=a.netPercentiles.p90);
 assert.ok(a.netPercentiles.p50<=a.grossPercentiles.p50);
 assert.ok(a.netGoalProbability>=0 && a.netGoalProbability<=1);
 assert.deepEqual(runTaxAwareEquityLumpSumScenario(input),a);
});
test('missing investor income, age, allowance, or mismatched realization FY fail closed',()=>{
 for(const field of ['annualGrossIncome','userAge','section112AExemptionUsed']){
  const result=runTaxAwareEquityLumpSumScenario({...input,taxContext:{...tax,[field]:null}});
  assert.equal(result.status,'UNAVAILABLE',field);
  assert.equal(result.netPercentiles,null,field);
 }
 assert.equal(runTaxAwareEquityLumpSumScenario({...input,redemptionDate:'2027-06-01'}).status,'UNAVAILABLE');
 assert.equal(runTaxAwareEquityLumpSumScenario({...input,years:2}).status,'UNAVAILABLE');
});
