import { createError } from '../middleware/errorHandler.js';

/**
 * Read-only SIP scenario comparison. No LLM / browser / persistence access.
 * All projected results are the existing deterministic financial engine output.
 */
const SNAPSHOT_KEYS=['_id','version','financialStateFence'];
function fingerprint(snapshot) {
  return JSON.stringify({
    profile: SNAPSHOT_KEYS.map(key=>String(snapshot?.profile?.[key]??'')),
    currentId:String(snapshot?.state?.currentProfileId??''),
    revision:String(snapshot?.state?.revision??''),
    promotionFence:String(snapshot?.state?.promotionFence??''),
  });
}
function invalidState() {
  return createError(409,'The financial profile changed during comparison.',
    'Your financial profile changed. Refresh it and recalculate.',
    {code:'VOICE_FINANCIAL_SNAPSHOT_CHANGED'});
}
function unavailable() {
  return createError(409,'A current financial profile is required for voice scenarios.',
    'Complete and confirm your financial profile before comparing SIP scenarios.',
    {code:'VOICE_FINANCIAL_PROFILE_REQUIRED'});
}
export async function compareVoiceSipScenarios({
  userId, input, resolveProfile, financialRegistry
}) {
  if(!userId || !input || !Array.isArray(input.annualReturnAssumptionsPct) ||
     input.annualReturnAssumptionsPct.length!==2) throw new TypeError('Invalid SIP scenario');
  const before=await resolveProfile({userId,requireRecommendation:false});
  if(!before?.profile || before?.state?.resolutionStatus!=='CURRENT') throw unavailable();
  const signature=fingerprint(before);
  const args={monthlyInvestment:input.monthlyInvestment,years:input.years};
  const rates=input.annualReturnAssumptionsPct;
  const projections=[];
  for(const pct of rates) {
    const run=await financialRegistry.executeTool('sip_projection',{
      ...args,annualRate:pct/100
    },{profile:before.profile});
    if(!run?.success || !run.result ||
       run.result.returnBasis!=='USER_SUPPLIED_NOMINAL_ASSUMPTION' ||
       run.result.classification!=='NON_RECOMMENDATION_PROFILE_CONSTRAINED_WHAT_IF') {
      throw createError(422,'The requested projection is unsupported or violates profile capacity.',
        'One or more scenarios are not supported by your financial profile.',
        {code:'VOICE_SIP_SCENARIO_REJECTED'});
    }
    const {monthlyInvestment,annualRatePct,years,totalInvested,futureValue,totalReturns}=run.result;
    if(![monthlyInvestment,annualRatePct,years,totalInvested,futureValue,totalReturns]
      .every(n=>Number.isFinite(n) && n>=0) ||
      monthlyInvestment!==args.monthlyInvestment || years!==args.years ||
      Math.abs(annualRatePct-pct)>1e-7 ||
      Math.abs(totalReturns-(futureValue-totalInvested))>0) {
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
  const after=await resolveProfile({userId,requireRecommendation:false});
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
