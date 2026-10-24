import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {compareVoiceSipScenarios} from '../services/voiceSipComparison.js';
import {sipFV} from '../services/projectionEngine.js';
const input={monthlyInvestment:5000,years:10,annualReturnAssumptionsPct:[7,10]};
const profile={_id:'64b000000000000000000001',version:1,financialStateFence:4};
const state={currentProfileId:profile._id,revision:5,promotionFence:3,resolutionStatus:'CURRENT'};
const authority=()=>({profile:{...profile},state:{...state}});
const financialRegistry={executeTool:async(name,args)=>{
  const totalInvested=args.monthlyInvestment*args.years*12;
  const futureValue=Math.round(sipFV(args.monthlyInvestment,args.annualRate,args.years));
  return {success:true,result:{
    monthlyInvestment:args.monthlyInvestment,years:args.years,
    annualRatePct:args.annualRate*100,totalInvested,futureValue,
    totalReturns:futureValue-totalInvested,
    classification:'NON_RECOMMENDATION_PROFILE_CONSTRAINED_WHAT_IF',
    returnBasis:'USER_SUPPLIED_NOMINAL_ASSUMPTION'
  }};
}};
describe('Sovereign voice SIP comparison integrity',()=>{
  it('creates read-only attributable scenarios and rechecks profile',async()=>{
    const x=await compareVoiceSipScenarios({userId:'u',input,resolveProfile:async()=>authority(),financialRegistry});
    assert.equal(x.persisted,false);
    assert.equal(x.scenarios.length,2);
    assert.equal(x.differences.futureValue,
      Math.round(sipFV(5000,.10,10))-Math.round(sipFV(5000,.07,10)));
    assert.equal(x.scenarios[0].returnBasis,'USER_SUPPLIED_NOMINAL_ASSUMPTION');
  });
  it('fails closed on direct-service bypass of HTTP numeric schemas',async()=>{
    for(const patch of [{monthlyInvestment:1},{years:99},
      {annualReturnAssumptionsPct:[7,7]},{annualReturnAssumptionsPct:[7,50]},
      {annualReturnAssumptionsPct:[7,Number.NaN]}]) {
      await assert.rejects(()=>compareVoiceSipScenarios({
        userId:'u',input:{...input,...patch},
        resolveProfile:async()=>authority(),financialRegistry
      }),TypeError);
    }
  });
  it('rejects missing canonical profiles',async()=>{
    await assert.rejects(()=>compareVoiceSipScenarios({
      userId:'u',input,resolveProfile:async()=>({profile:null,state:{resolutionStatus:'NO_CURRENT'}}),financialRegistry
    }),{code:'VOICE_FINANCIAL_PROFILE_REQUIRED'});
  });
  it('fails closed on state changes after first calculation',async()=>{
    let calls=0;
    await assert.rejects(()=>compareVoiceSipScenarios({
      userId:'u',input,
      resolveProfile:async()=>{calls++;const x=authority();if(calls===2)x.state.revision=6;return x;},
      financialRegistry
    }),{code:'VOICE_FINANCIAL_SNAPSHOT_CHANGED'});
  });
  it('refuses forged tool values, rate substitution and mismatched arithmetic',async()=>{
    for(const wrong of [{futureValue:123},{annualRatePct:9},{totalReturns:20},
      {returnBasis:'VERIFIED_LIVE_RATE'}, {classification:'PERSONALIZED_ADVICE'}]){
      const fake={executeTool:async(name,args)=>({
        success:true,result:{...(await financialRegistry.executeTool(name,args)).result,...wrong}
      })};
      await assert.rejects(()=>compareVoiceSipScenarios({
        userId:'u',input,resolveProfile:async()=>authority(),financialRegistry:fake
      }));
    }
  });
  it('rejects fabricated total invested even if the rest of the output is self-consistent',async()=>{
    const fake={executeTool:async(name,args)=>({
      success:true,result:{...(await financialRegistry.executeTool(name,args)).result,
        totalInvested:500000,totalReturns:args.annualRate<.08?350000:450000}
    })};
    await assert.rejects(()=>compareVoiceSipScenarios({
      userId:'u',input,resolveProfile:async()=>authority(),financialRegistry:fake
    }),{code:'VOICE_SIP_ENGINE_MISMATCH'});
  });
  it('rejects relevant financial profile changes even if the state revision is unchanged',async()=>{
    let calls=0;
    await assert.rejects(()=>compareVoiceSipScenarios({
      userId:'u',input,resolveProfile:async()=>{
        calls++;
        const x=authority(); x.profile.monthlySavings=calls===1?15000:2000;return x;
      },financialRegistry
    }),{code:'VOICE_FINANCIAL_SNAPSHOT_CHANGED'});
  });
  it('blocks fabricated but self-consistent projection values',async()=>{
    const fake={executeTool:async(name,args)=>{
      const canonical=(await financialRegistry.executeTool(name,args)).result;
      return {success:true,result:{
        ...canonical,futureValue:canonical.futureValue+100000,
        totalReturns:canonical.totalReturns+100000
      }};
    }};
    await assert.rejects(()=>compareVoiceSipScenarios({
      userId:'u',input,resolveProfile:async()=>authority(),financialRegistry:fake
    }),{code:'VOICE_SIP_ENGINE_MISMATCH'});
  });
  it('refuses denied engine calls and profile constraints',async()=>{
    await assert.rejects(()=>compareVoiceSipScenarios({
      userId:'u',input,resolveProfile:async()=>authority(),
      financialRegistry:{executeTool:async()=>({success:false,error:'capacity'})}
    }),{code:'VOICE_SIP_SCENARIO_REJECTED'});
  });
});
