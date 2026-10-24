import { createError } from '../middleware/errorHandler.js';

 /**
  * Independent iterative annuity-due reference implementation.
  * Deliberately does not import the canonical SIP engine or trust its output.
  * Each contribution is made at the start of the month.
  */
function independentlyProjectedSipValue(monthlyInvestment, annualRate, years) {
  const monthlyRate=annualRate / 12;
  let balance=0;
  for(let month=0;month<years*12;month++) {
    balance=(balance+monthlyInvestment)*(1+monthlyRate);
    if(!Number.isFinite(balance)||balance>Number.MAX_SAFE_INTEGER/100) {
      throw createError(422,'The projection exceeds supported monetary precision.',
        'This scenario is outside the supported calculation range.',
        {code:'VOICE_SIP_PRECISION_EXCEEDED'});
    }
  }
  return Math.round(balance);
}

/**
 * Read-only SIP scenario comparison. No LLM / browser / persistence access.
 * All projected results are the existing deterministic financial engine output.
 */
// Canonicalize all financial profile and pointer fields, not an incomplete list
// of capacity keys. Never log or return this potentially sensitive digest.
function canonicalize(value) {
  if(value===null || typeof value!=='object')return value;
  if(typeof value.toJSON==='function')return canonicalize(value.toJSON());
  if(Array.isArray(value))return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalize(value[key])]));
}
function fingerprint(snapshot) {
  return JSON.stringify(canonicalize({
    profile:snapshot?.profile??null,
    state:snapshot?.state??null
  }));
}
function invalidState() {
  return createError(409,'The financial profile changed during comparison.',
    'Your financial profile changed. Refresh it and recalculate.',
    {code:'VOICE_FINANCIAL_SNAPSHOT_CHANGED'});
}
function assertActive(signal) {
  if(signal?.aborted) {
    throw createError(409, 'The voice comparison was cancelled.',
      'The comparison was interrupted. No financial action was performed.',
      {code:'VOICE_SIP_CANCELLED'});
  }
}
function unavailable() {
  return createError(409,'A current financial profile is required for voice scenarios.',
    'Complete and confirm your financial profile before comparing SIP scenarios.',
    {code:'VOICE_FINANCIAL_PROFILE_REQUIRED'});
}
export async function compareVoiceSipScenarios({
  userId, input, resolveProfile, financialRegistry, signal
}) {
  const amount=input?.monthlyInvestment,years=input?.years;
  const assumptions=input?.annualReturnAssumptionsPct;
  if(!userId || !Number.isSafeInteger(amount) || amount<100 || amount>10000000 ||
     !Number.isSafeInteger(years)||years<1||years>30 ||
     !Array.isArray(assumptions)||assumptions.length!==2 ||
     assumptions.some(pct=>!Number.isFinite(pct)||pct<0.1||pct>30) ||
     assumptions[0]===assumptions[1]) throw new TypeError('Invalid SIP scenario');
  assertActive(signal);
  const before=await resolveProfile({userId,requireRecommendation:false});
  assertActive(signal);
  if(!before?.profile || before?.state?.resolutionStatus!=='CURRENT') throw unavailable();
  const signature=fingerprint(before);
  const args={monthlyInvestment:input.monthlyInvestment,years:input.years};
  const rates=input.annualReturnAssumptionsPct;
  const projections=[];
  for(const pct of rates) {
    assertActive(signal);
    const run=await financialRegistry.executeTool('sip_projection',{
      ...args,annualRate:pct/100
    },{profile:before.profile});
    assertActive(signal);
    if(!run?.success || !run.result ||
       run.result.returnBasis!=='USER_SUPPLIED_NOMINAL_ASSUMPTION' ||
       run.result.classification!=='NON_RECOMMENDATION_PROFILE_CONSTRAINED_WHAT_IF') {
      throw createError(422,'The requested projection is unsupported or violates profile capacity.',
        'One or more scenarios are not supported by your financial profile.',
        {code:'VOICE_SIP_SCENARIO_REJECTED'});
    }
    const {monthlyInvestment,annualRatePct,years,totalInvested,futureValue,totalReturns}=run.result;
    if(!Number.isSafeInteger(monthlyInvestment) || monthlyInvestment<0 ||
      !Number.isSafeInteger(years) || years<0 ||
      !Number.isSafeInteger(totalInvested) || !Number.isSafeInteger(futureValue) ||
      !Number.isSafeInteger(totalReturns) || totalReturns<0 ||
      !Number.isFinite(annualRatePct) || annualRatePct<0 ||
      monthlyInvestment!==args.monthlyInvestment || years!==args.years ||
      totalInvested!==args.monthlyInvestment*args.years*12 ||
      Math.abs(annualRatePct-pct)>1e-7 ||
      totalReturns!==futureValue-totalInvested ||
      Math.abs(futureValue-independentlyProjectedSipValue(
        args.monthlyInvestment,pct/100,args.years
      ))>2) {
      throw createError(503,'The financial tool returned an inconsistent result.',
        'The comparison could not be verified. No result was published.',
        {code:'VOICE_SIP_ENGINE_MISMATCH'});
    }
    projections.push({
      assumedAnnualReturnPct:pct,monthlyInvestment,years,totalInvested,
      futureValue,totalReturns,
      classification:'NON_RECOMMENDATION_PROFILE_CONSTRAINED_WHAT_IF',
      returnBasis:'USER_SUPPLIED_NOMINAL_ASSUMPTION'
    });
  }
  assertActive(signal);
  const after=await resolveProfile({userId,requireRecommendation:false});
  assertActive(signal);
  if(fingerprint(after)!==signature) throw invalidState();
  return {
    version:'sovereign-voice-sip-compare-v1',
    classification:'UNSAVED_WHAT_IF_SIMULATION',
    profileStateRevision:before.state.revision,
    note:'These are nominal projections using user-supplied hypothetical annual returns, not quotes, guarantees, investment recommendations or post-tax results.',
    scenarios:projections,
    differences:{
      futureValue:projections[1].futureValue-projections[0].futureValue,
      invested:projections[1].totalInvested-projections[0].totalInvested
    },
    persisted:false
  };
}
