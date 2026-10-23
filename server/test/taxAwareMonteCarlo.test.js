import test from 'node:test';
import assert from 'node:assert/strict';
import {runTaxAwareEquityLumpSumScenario} from '../services/taxAwareMonteCarlo.js';
import { classifyHoldingPeriodByDates, computeEquityCapitalGainsTax, getCapitalGainsHoldingPeriodMonths } from '../services/taxEngine.js';
const tax={
 annualGrossIncome:2000000,userAge:35,incomeSource:'salary',regime:'new',
 fiscalYear:'FY2026-27',deductions:{},section112AExemptionUsed:0,
 sttConditionAssumedSatisfied:true,
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
 assert.equal(a.sttConditionBasis,'USER_DECLARED_ASSUMED_SATISFIED_NOT_VERIFIED');
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

test('tax-aware equity paths fail closed without explicit STT treatment and valid 112A usage',()=>{
 for(const stt of [undefined,false,null]){
  const out=runTaxAwareEquityLumpSumScenario({
   ...input,taxContext:{...tax,sttConditionAssumedSatisfied:stt},
  });
  assert.equal(out.status,'UNAVAILABLE');
  assert.equal(out.afterTaxAvailable,false);
  assert.deepEqual(out.unavailableReasons,['EQUITY_STT_CONDITION_NOT_ESTABLISHED']);
  assert.equal(out.netPercentiles,null);
 }
 const excessiveExemption=runTaxAwareEquityLumpSumScenario({
  ...input,taxContext:{...tax,section112AExemptionUsed:125001},
 });
 assert.equal(excessiveExemption.status,'UNAVAILABLE');
 assert.deepEqual(excessiveExemption.unavailableReasons,
  ['SECTION_112A_USAGE_EXCEEDS_VERIFIED_ANNUAL_LIMIT']);
});

test('tax-aware 30-year gross paths reject rupee precision overflow before simulation',()=>{
 const out=runTaxAwareEquityLumpSumScenario({
  ...input,principal:1e10,annualExpectedReturn:1,years:30,
  acquisitionDate:'1996-06-01',redemptionDate:'2026-06-01',
 });
 assert.equal(out.status,'UNAVAILABLE');
 assert.equal(out.afterTaxAvailable,false);
 assert.deepEqual(out.unavailableReasons,['SIMULATION_WEALTH_PRECISION_EXCEEDED']);
});

test('zero-volatility after-tax Monte Carlo matches independent tax and compound-interest oracles', () => {
 const outcome=runTaxAwareEquityLumpSumScenario({ ...input, annualVolatility:0, targetAmount:110000 });
 assert.equal(outcome.status,'CALCULATED');
 const grossExpected=input.principal*Math.pow(1+input.annualExpectedReturn,input.years);
 const holding=classifyHoldingPeriodByDates({
  acquisitionDate:input.acquisitionDate,redemptionDate:input.redemptionDate,
  thresholdMonths:getCapitalGainsHoldingPeriodMonths(tax.fiscalYear,'listed'),
 });
 const liability=computeEquityCapitalGainsTax({
  grossGain:grossExpected-input.principal,
  holdingPeriodMonths:holding.holdingPeriodMonths,holdingPeriodClassification:holding,
  annualIncome:tax.annualGrossIncome,incomeSource:tax.incomeSource,
  regime:tax.regime,fiscalYear:tax.fiscalYear,userAge:tax.userAge,
  deductions:tax.deductions,section112AExemptionUsed:tax.section112AExemptionUsed,
 });
 assert.equal(liability.status,'CALCULATED');
 const netExpected=grossExpected-liability.taxAmount;
 for(const key of ['p10','p50','p90']) {
  assert.ok(Math.abs(outcome.grossPercentiles[key]-grossExpected)<=1,key+' gross');
  assert.ok(Math.abs(outcome.netPercentiles[key]-netExpected)<=1,key+' net');
 }
 assert.equal(outcome.netGoalProbability,netExpected>=110000?1:0);
 assert.equal(outcome.notLiveMarketData,true);
 assert.equal(outcome.futureMarketReturnsGuaranteed,false);
});
