import { describe,it } from 'node:test';
import assert from 'node:assert/strict';
import { previewSovereignReadOnlyTask,SOVEREIGN_READ_ONLY_PREVIEW_VERSION } from '../services/sovereignReadOnlyTaskPreview.js';
import { SOVEREIGN_TASK_PLAN_VERSION } from '../services/sovereignTaskPlanPolicy.js';
import { sipFV } from '../services/projectionEngine.js';

const navigation=(id,page,dependsOn=[])=>({
  id,operation:'APP_NAVIGATE',arguments:{page,tab:null},dependsOn
});
const sip=(id,dependsOn=[])=>({
  id,operation:'SIP_COMPARE_DRAFT',
  arguments:{monthlyInvestment:5000,years:10,annualReturnAssumptionsPct:[7,10]},dependsOn
});
const task=(steps)=>({version:SOVEREIGN_TASK_PLAN_VERSION,steps});
const profile=()=>({profile:{
  _id:'64b000000000000000000001',version:1,financialStateFence:0,
  monthlySavings:10000,investmentHorizonYears:20
},state:{currentProfileId:'64b000000000000000000001',revision:1,
  promotionFence:1,resolutionStatus:'CURRENT'}});
const registry=()=>({executeTool:async(_name,args)=>{
  const totalInvested=args.monthlyInvestment*args.years*12;
  const futureValue=Math.round(sipFV(args.monthlyInvestment,args.annualRate,args.years));
  return {success:true,result:{
    monthlyInvestment:args.monthlyInvestment,years:args.years,
    annualRatePct:args.annualRate*100,totalInvested,futureValue,
    totalReturns:futureValue-totalInvested,
    returnBasis:'USER_SUPPLIED_NOMINAL_ASSUMPTION',
    classification:'NON_RECOMMENDATION_PROFILE_CONSTRAINED_WHAT_IF'
  }};
}});
describe('Sovereign X read-only task preview',()=>{
  it('proposes navigation and verifies a dependent financial comparison',async()=>{
    let calls=0;
    const out=await previewSovereignReadOnlyTask({
      userId:'actor',plan:task([sip('b',['a']),navigation('a','goals')]),
      resolveProfile:async()=>{calls++;return profile();},
      financialRegistry:registry()
    });
    assert.equal(out.version,SOVEREIGN_READ_ONLY_PREVIEW_VERSION);
    assert.equal(out.persisted,false);
    assert.equal(out.navigationApplied,false);
    assert.equal(out.financialStateModified,false);
    assert.deepEqual(out.steps.map(s=>s.id),['a','b']);
    assert.deepEqual(out.steps[0],{
      id:'a',kind:'NAVIGATION_PROPOSAL',status:'PREVIEWED',
      page:'goals',tab:null,applied:false
    });
    assert.equal(out.steps[1].kind,'FINANCIAL_COMPARISON');
    assert.equal(out.steps[1].comparison.persisted,false);
    assert.equal(out.steps[1].comparison.scenarios.length,2);
    assert.equal(calls,2);
  });
  it('rejects privilege smuggling before invoking any registered tool',async()=>{
    let calls=0;
    for(const bad of [
      task([{...navigation('a','goals'),operation:'BROWSER_EXECUTE'}]),
      task([navigation('a','admin')]),
      task([navigation('a','goals',['b']),navigation('b','taxes',['a'])]),
      task([sip('a'),sip('b')]),
      task([{...sip('a'),arguments:{...sip('a').arguments,provider:'https://evil.test'}}])
    ]) {
      await assert.rejects(()=>previewSovereignReadOnlyTask({
        userId:'actor',plan:bad,resolveProfile:async()=>{calls++;return profile();},
        financialRegistry:registry()
      }));
    }
    assert.equal(calls,0);
  });
  it('fails closed on early cancellation and does no work',async()=>{
    let calls=0;
    const controller=new AbortController();controller.abort();
    await assert.rejects(()=>previewSovereignReadOnlyTask({
      userId:'actor',plan:task([sip('a')]),signal:controller.signal,
      resolveProfile:async()=>{calls++;return profile();},financialRegistry:registry()
    }),{code:'SOVEREIGN_PREVIEW_CANCELLED'});
    assert.equal(calls,0);
  });
  it('fences a late financial response after cancellation',async()=>{
    const controller=new AbortController();
    let resolve;
    const pending=new Promise(r=>{resolve=r});
    const request=previewSovereignReadOnlyTask({
      userId:'actor',plan:task([sip('a')]),signal:controller.signal,
      resolveProfile:async()=>profile(),
      financialRegistry:{executeTool:async()=>pending}
    });
    await Promise.resolve();
    controller.abort();
    resolve({success:false});
    await assert.rejects(request);
  });
  it('does not allow a missing actor',async()=>{
    await assert.rejects(()=>previewSovereignReadOnlyTask({
      userId:null,plan:task([navigation('a','goals')])
    }),{code:'SOVEREIGN_PREVIEW_AUTH_REQUIRED'});
  });
});
