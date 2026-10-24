/**
 * Pure validation for bounded read-only task DAG proposals.
 * Deliberately does not execute a plan, access external domains or grant rights.
 * Future planners must pass their output through this policy before any tool call.
 */
export const SOVEREIGN_TASK_PLAN_VERSION='sovereign-task-plan-v1';
const ALLOWED=new Set(['APP_NAVIGATE','SIP_COMPARE_DRAFT']);
const NAV_PAGES=new Set(['home','plan','investments','taxes','progress','goals',
  'grow-my-sip','keep-on-track','account','help']);
const ID=/^[a-z][a-z0-9_-]{0,31}$/;
// Only own, ordinary data properties have authority. Inherited properties,
// accessors and symbols must never cross the planner-to-executor boundary.
const isPlainDataObject=(obj)=>{
  if(!obj||typeof obj!=='object'||Array.isArray(obj))return false;
  const proto=Object.getPrototypeOf(obj);
  if(proto!==Object.prototype&&proto!==null)return false;
  if(Object.getOwnPropertySymbols(obj).length)return false;
  return Object.values(Object.getOwnPropertyDescriptors(obj)).every(
    descriptor=>'value' in descriptor && descriptor.enumerable
  );
};
// Array holes, accessor indices, custom properties and symbols must never be
// interpreted as missing dependencies or silently omitted scenario inputs.
const isDenseDataArray=(array)=>{
  if(!Array.isArray(array)||Object.getPrototypeOf(array)!==Array.prototype)return false;
  const keys=Reflect.ownKeys(array);
  if(keys.length!==array.length+1)return false;
  for(let index=0;index<array.length;index++){
    const entry=Object.getOwnPropertyDescriptor(array,String(index));
    if(!entry||!Object.hasOwn(entry,'value')||entry.enumerable!==true)return false;
  }
  return true;
};
const hasExactly=(obj,fields)=>isPlainDataObject(obj) &&
  Reflect.ownKeys(obj).length===fields.length &&
  fields.every(field=>Object.hasOwn(obj,field));
export function validateSovereignTaskPlan(plan) {
  if(!hasExactly(plan,['version','steps']) ||
     plan.version!==SOVEREIGN_TASK_PLAN_VERSION ||
     !isDenseDataArray(plan.steps) || plan.steps.length<1 || plan.steps.length>6) {
    return {ok:false,reason:'PLAN_SCHEMA_INVALID'};
  }
  const ids=new Set();
  for(const step of plan.steps) {
    if(!hasExactly(step,['id','operation','arguments','dependsOn']) ||
      typeof step.id!=='string'||!ID.test(step.id)||ids.has(step.id)||
      !ALLOWED.has(step.operation)||!isDenseDataArray(step.dependsOn)||
      step.dependsOn.length>5 ||new Set(step.dependsOn).size!==step.dependsOn.length||
      !isPlainDataObject(step.arguments))return {ok:false,reason:'STEP_SCHEMA_INVALID'};
    ids.add(step.id);
    if(step.operation==='APP_NAVIGATE') {
      if(!hasExactly(step.arguments,['page','tab']) ||
        !NAV_PAGES.has(step.arguments.page) ||
        step.arguments.tab!==null)return {ok:false,reason:'TARGET_NOT_ALLOWED'};
    } else {
      const a=step.arguments;
      if(!hasExactly(a,['monthlyInvestment','years','annualReturnAssumptionsPct']) ||
        !Number.isSafeInteger(a.monthlyInvestment)||a.monthlyInvestment<100||
        a.monthlyInvestment>10000000||
        !Number.isSafeInteger(a.years)||a.years<1||a.years>30||
        !isDenseDataArray(a.annualReturnAssumptionsPct)||
        a.annualReturnAssumptionsPct.length!==2||
        a.annualReturnAssumptionsPct.some(v=>!Number.isFinite(v)||v<0.1||v>30)||
        a.annualReturnAssumptionsPct[0]===a.annualReturnAssumptionsPct[1]) {
        return {ok:false,reason:'SCENARIO_SCHEMA_INVALID'};
      }
    }
  }
  const completed=new Set(),pending=new Map(plan.steps.map(s=>[s.id,s]));
  const waves=[];
  while(pending.size){
    const ready=[];
    for(const [id,step]of pending){
      if(step.dependsOn.some(dep=>!ids.has(dep)||dep===id))
        return {ok:false,reason:'DEPENDENCY_NOT_FOUND'};
      if(step.dependsOn.every(dep=>completed.has(dep)))ready.push(id);
    }
    if(!ready.length)return {ok:false,reason:'DEPENDENCY_CYCLE'};
    for(const id of ready){pending.delete(id);completed.add(id);}
    waves.push(ready);
  }
  return {ok:true,version:SOVEREIGN_TASK_PLAN_VERSION,waves,steps:plan.steps.map(step=>({
    id:step.id,operation:step.operation,
    arguments:structuredClone(step.arguments),dependsOn:[...step.dependsOn]
  }))};
}
