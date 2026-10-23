import { runMonteCarlo, percentile } from './monteCarloEngine.js';
import {
  classifyHoldingPeriodByDates, computeEquityCapitalGainsTax,
  getCapitalGainsHoldingPeriodMonths, getTaxPolicyMetadata,
} from './taxEngine.js';
export const TAX_AWARE_SCENARIO_VERSION='tax-aware-equity-lump-sum-1.0.0';
function unavailable(reasonCodes,gross=null) {
  return {status:'UNAVAILABLE',afterTaxAvailable:false,unavailableReasons:[...new Set(reasonCodes)],
    netPercentiles:null,netGoalProbability:null,grossPercentiles:gross,
    dataClass:'USER_DECLARED_MODEL_SCENARIO',notLiveMarketData:true,
    modelVersion:TAX_AWARE_SCENARIO_VERSION};
}
function requireFacts(tax) {
  const fields=['annualGrossIncome','userAge','incomeSource','regime','fiscalYear','section112AExemptionUsed'];
  const missing=fields.filter(k=>tax?.[k]===null||tax?.[k]===undefined||tax?.[k]==='');
  if(missing.length) return missing;
  // The favorable listed-equity special-rate scenario is conditional on
  // transaction-specific STT requirements; product type alone proves nothing.
  if(tax.sttConditionAssumedSatisfied !== true)
    return ['EQUITY_STT_CONDITION_NOT_ESTABLISHED'];
  if(!Number.isFinite(tax.annualGrossIncome)||tax.annualGrossIncome<0
    ||!Number.isInteger(tax.userAge)||tax.userAge<18||tax.userAge>120
    ||!Number.isFinite(tax.section112AExemptionUsed)||tax.section112AExemptionUsed<0
    ||!['salary','pension','family_pension','business','other'].includes(tax.incomeSource)
    ||tax.regime !== 'new' || !tax.deductions
    ||typeof tax.deductions!=='object'||Array.isArray(tax.deductions))return ['INVALID_TAX_CONTEXT'];
  return [];
}
function yearOf(iso){
  const y=Number(iso.slice(0,4)),m=Number(iso.slice(5,7));
  return 'FY'+(m>=4?y:y-1)+'-'+String(m>=4?y+1:y).slice(-2);
}
export function runTaxAwareEquityLumpSumScenario({
  principal,annualExpectedReturn,annualVolatility,years,simulations=500,
  inflationRate=0.05,seed=1337,targetAmount=null,
  acquisitionDate,redemptionDate,taxContext,
}={}) {
  const missing=requireFacts(taxContext);
  if(missing.length)return unavailable(missing);
  if(!Number.isFinite(principal)||principal<=0||principal>1e10
    ||!Number.isInteger(years)||years<1||years>30
    ||!Number.isInteger(simulations)||simulations<100||simulations>1000
    ||!Number.isInteger(seed)||seed<0||seed>0xffffffff
    ||!Number.isFinite(annualExpectedReturn)||annualExpectedReturn<=-1||annualExpectedReturn>1
    ||!Number.isFinite(annualVolatility)||annualVolatility<0||annualVolatility>0.6
    ||!Number.isFinite(inflationRate)||inflationRate<0||inflationRate>1
    ||(targetAmount!==null&&(!Number.isFinite(targetAmount)||targetAmount<=0))){
    throw new RangeError('Invalid bounded user-declared simulation inputs');
  }
  if(typeof acquisitionDate!=='string'||typeof redemptionDate!=='string'
    ||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(acquisitionDate)
    ||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(redemptionDate)) return unavailable(['EXACT_TRANSACTION_DATES_REQUIRED']);
  if(yearOf(redemptionDate)!==taxContext.fiscalYear)return unavailable(['TAX_REDEMPTION_FISCAL_YEAR_MISMATCH']);
  let policy, holding;
  try {
    policy=getTaxPolicyMetadata(taxContext.fiscalYear);
    if(taxContext.section112AExemptionUsed>policy.rules.capitalGains112AExemption)
      return unavailable(['SECTION_112A_USAGE_EXCEEDS_VERIFIED_ANNUAL_LIMIT']);
    const threshold=getCapitalGainsHoldingPeriodMonths(taxContext.fiscalYear,'listed');
    holding=classifyHoldingPeriodByDates({acquisitionDate,redemptionDate,thresholdMonths:threshold});
  }catch{return unavailable(['TAX_POLICY_OR_DATES_UNAVAILABLE']);}
  const observedYears=(Date.parse(redemptionDate+'T00:00:00Z')-Date.parse(acquisitionDate+'T00:00:00Z'))/86400000/365.25;
  if(!Number.isFinite(observedYears)||Math.abs(observedYears-years)>0.09){
    return unavailable(['SIMULATION_HORIZON_TRANSACTION_DATES_CONFLICT']);
  }
  // A valid input magnitude can still overflow safe rupee precision after
  // thirty years of compounding. Refuse the scenario before spawning paths.
  if(principal*Math.pow(1+annualExpectedReturn,years)>Number.MAX_SAFE_INTEGER-1)
    return unavailable(['SIMULATION_WEALTH_PRECISION_EXCEEDED']);
  const gross=runMonteCarlo({
    monthlyInvestment:0,currentSavings:principal,annualExpectedReturn,
    annualVolatility,years,simulations,inflationRate,seed,
  });
  const values=gross.finalValues;
  const grossSummary={p10:gross.p10.at(-1),p50:gross.p50.at(-1),p90:gross.p90.at(-1)};
  const afterTax=[];
  for(const value of values) {
    const gain=Math.max(0,value-principal);
    const tax=computeEquityCapitalGainsTax({
      grossGain:gain,holdingPeriodMonths:holding.holdingPeriodMonths,
      holdingPeriodClassification:holding,
      annualIncome:taxContext.annualGrossIncome,
      incomeSource:taxContext.incomeSource,regime:taxContext.regime,
      fiscalYear:taxContext.fiscalYear,userAge:taxContext.userAge,
      deductions:taxContext.deductions,
      section112AExemptionUsed:taxContext.section112AExemptionUsed,
    });
    if(tax.status!=='CALCULATED'||!Number.isFinite(tax.taxAmount)){
      return unavailable(tax.unavailableReasons?.length?tax.unavailableReasons:['TAX_RESULT_NOT_QUALIFIED'],grossSummary);
    }
    afterTax.push(Math.max(0,value-tax.taxAmount));
  }
  afterTax.sort((a,b)=>a-b);
  const netPercentiles={p10:percentile(afterTax,10),p50:percentile(afterTax,50),p90:percentile(afterTax,90)};
  return {
    status:'CALCULATED',afterTaxAvailable:true,dataClass:'USER_DECLARED_MODEL_SCENARIO',
    notLiveMarketData:true,suitabilityApproved:false,
    futureMarketReturnsGuaranteed:false,
    taxCalculationScope:'ONE_HYPOTHETICAL_LISTED_EQUITY_LUMP_SUM_REALIZATION',
    excludes:['PREEXISTING_CAPITAL_LOSSES','FUTURE_TAX_LAW','COSTS_AND_TRANSACTION_FEES','MULTI_PRODUCT_TAX_NETTING','STT_CONDITION_NOT_INDEPENDENTLY_VERIFIED'],
    sttConditionBasis:'USER_DECLARED_ASSUMED_SATISFIED_NOT_VERIFIED',
    fiscalYear:taxContext.fiscalYear,taxPolicyVersion:policy.policyVersion,
    modelVersion:TAX_AWARE_SCENARIO_VERSION,seedUsed:seed,simulationsRun:gross.simulations_run,
    principal,holdingPeriodBasis:holding.holdingPeriodBasis,
    grossPercentiles:grossSummary,netPercentiles,
    netGoalProbability:targetAmount===null?null:
      afterTax.filter(v=>v>=targetAmount).length/afterTax.length,
    targetAmount,
  };
}
