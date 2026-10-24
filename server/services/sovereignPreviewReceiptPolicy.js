/**
 * Independent, fail-closed result boundary for a durable, read-only task receipt.
 * The executor is untrusted even if it is internal: only the explicitly
 * reviewed plan's ordered, fully validated results may be recorded as success.
 */
const isRecord=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
  Object.getPrototypeOf(value)===Object.prototype;
const exactly=(value,fields)=>isRecord(value)&&
  Reflect.ownKeys(value).length===fields.length&&
  fields.every(key=>Object.hasOwn(value,key));
const safeMoney=value=>Number.isSafeInteger(value)&&value>=0;
const safeRate=value=>typeof value==='number'&&Number.isFinite(value);
const PLAN_RESULT_FIELDS=['version','classification','persisted',
  'navigationApplied','financialStateModified','steps'];
const FINANCIAL_FIELDS=['version','classification','profileStateRevision','note',
  'scenarios','differences','persisted'];
const ANNUAL_NOTE='These are nominal projections using user-supplied hypothetical annual returns, not quotes, guarantees, investment recommendations or post-tax results.';

function referenceValue(monthly,rate,years) {
  let result=0;
  for(let month=0;month<years*12;month++) {
    result=(result+monthly)*(1+rate/1200);
    if(!Number.isFinite(result)||result>Number.MAX_SAFE_INTEGER/100)return null;
  }
  return Math.round(result);
}

function validComparison(output,expected) {
  if(!exactly(output,FINANCIAL_FIELDS)||
    output.version!=='sovereign-voice-sip-compare-v1'||
    output.classification!=='UNSAVED_WHAT_IF_SIMULATION'||
    output.persisted!==false||
    output.note!==ANNUAL_NOTE||
    !Number.isSafeInteger(output.profileStateRevision)||
    output.profileStateRevision<1||
    !Array.isArray(output.scenarios)||output.scenarios.length!==2||
    !exactly(output.differences,['futureValue','invested']))return false;
  const args=expected.arguments;
  const invested=args.monthlyInvestment*args.years*12;
  if(!safeMoney(invested))return false;
  for(let i=0;i<2;i++){
    const scenario=output.scenarios[i];
    const requested=args.annualReturnAssumptionsPct[i];
    if(!exactly(scenario,['assumedAnnualReturnPct','monthlyInvestment','years',
      'totalInvested','futureValue','totalReturns','classification','returnBasis'])||
      !safeRate(scenario.assumedAnnualReturnPct)||
      Math.abs(scenario.assumedAnnualReturnPct-requested)>1e-7||
      scenario.monthlyInvestment!==args.monthlyInvestment||
      scenario.years!==args.years||
      scenario.totalInvested!==invested||
      !safeMoney(scenario.futureValue)||
      !safeMoney(scenario.totalReturns)||
      scenario.totalReturns!==scenario.futureValue-scenario.totalInvested||
      scenario.classification!=='NON_RECOMMENDATION_PROFILE_CONSTRAINED_WHAT_IF'||
      scenario.returnBasis!=='USER_SUPPLIED_NOMINAL_ASSUMPTION'){
      return false;
    }
    const independent=referenceValue(args.monthlyInvestment,requested,args.years);
    if(independent===null||Math.abs(scenario.futureValue-independent)>2)return false;
  }
  return Number.isSafeInteger(output.differences.futureValue)&&
    output.differences.futureValue===output.scenarios[1].futureValue-output.scenarios[0].futureValue&&
    output.differences.invested===0;
}

export function isVerifiedSovereignReadOnlyPreview(output,validatedPlan) {
  if(!exactly(output,PLAN_RESULT_FIELDS)||
    output.version!=='sovereign-task-preview-v1'||
    output.classification!=='READ_ONLY_USER_REVIEWED_PREVIEW'||
    output.persisted!==false||
    output.navigationApplied!==false||
    output.financialStateModified!==false||
    !Array.isArray(output.steps))return false;
  const order=validatedPlan.waves.flat();
  if(output.steps.length!==order.length)return false;
  const byId=new Map(validatedPlan.steps.map(step=>[step.id,step]));
  for(let i=0;i<order.length;i++){
    const spec=byId.get(order[i]),item=output.steps[i];
    if(!spec||!isRecord(item)||item.id!==spec.id)return false;
    if(spec.operation==='APP_NAVIGATE'){
      if(!exactly(item,['id','kind','status','page','tab','applied'])||
        item.kind!=='NAVIGATION_PROPOSAL'||item.status!=='PREVIEWED'||
        item.page!==spec.arguments.page||item.tab!==null||item.applied!==false)return false;
    } else if(spec.operation==='SIP_COMPARE_DRAFT'){
      if(!exactly(item,['id','kind','status','comparison'])||
        item.kind!=='FINANCIAL_COMPARISON'||item.status!=='VERIFIED'||
        !validComparison(item.comparison,spec))return false;
    } else return false;
  }
  return true;
}
