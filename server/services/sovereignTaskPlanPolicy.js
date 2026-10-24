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
const hasOnly=(obj,allowed)=>Object.keys(obj).every(x=>allowed.includes(x));
export function validateSovereignTaskPlan(plan) {
  if(!plan || typeof plan!=='object' || Array.isArray(plan) ||
     !hasOnly(plan,['version','steps']) ||
     plan.version!==SOVEREIGN_TASK_PLAN_VERSION ||
     !Array.isArray(plan.steps) || plan.steps.length<1 || plan.steps.length>6) {
    return {ok:false,reason:'PLAN_SCHEMA_INVALID'};
  }
  const ids=new Set();
  for(const step of plan.steps) {
    if(!step || typeof step!=='object'||Array.isArray(step) ||
      !hasOnly(step,['id','operation','arguments','dependsOn']) ||
      typeof step.id!=='string'||!ID.test(step.id)||ids.has(step.id)||
      !ALLOWED.has(step.operation)||!Array.isArray(step.dependsOn)||
      step.dependsOn.length>5 ||new Set(step.dependsOn).size!==step.dependsOn.length||
      !step.arguments ||typeof step.arguments!=='object' ||
      Array.isArray(step.arguments))return {ok:false,reason:'STEP_SCHEMA_INVALID'};
    ids.add(step.id);
    if(step.operation==='APP_NAVIGATE') {
      if(!hasOnly(step.arguments,['page','tab']) ||
        !NAV_PAGES.has(step.arguments.page) ||
        step.arguments.tab!==null)return {ok:false,reason:'TARGET_NOT_ALLOWED'};
    } else {
      const a=step.arguments;
      if(!hasOnly(a,['monthlyInvestment','years','annualReturnAssumptionsPct']) ||
        !Number.isSafeInteger(a.monthlyInvestment)||a.monthlyInvestment<100||
        a.monthlyInvestment>10000000||
        !Number.isSafeInteger(a.years)||a.years<1||a.years>30||
        !Array.isArray(a.annualReturnAssumptionsPct)||
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
