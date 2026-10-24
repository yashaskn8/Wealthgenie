import{describe,it}from'node:test';
import assert from'node:assert/strict';
import{validateSovereignTaskPlan,SOVEREIGN_TASK_PLAN_VERSION}from'../services/sovereignTaskPlanPolicy.js';
const step=(id,page,dependsOn=[])=>({id,operation:'APP_NAVIGATE',arguments:{page,tab:null},dependsOn});
const plan=steps=>({version:SOVEREIGN_TASK_PLAN_VERSION,steps});
describe('Sovereign task plan validation',()=>{
  it('produces dependency-respecting topological waves',()=>{
    const x=validateSovereignTaskPlan(plan([step('c','help',['a','b']),
      step('b','investments',['a']),step('a','goals')]));
    assert.equal(x.ok,true);
    assert.deepEqual(x.waves,[['a'],['b'],['c']]);
  });
  it('refuses missing, cycles, duplicates, and unauthorized operations',()=>{
    for(const x of [
      plan([step('a','goals',['b'])]),
      plan([step('a','goals',['b']),step('b','taxes',['a'])]),
      plan([step('a','goals'),step('a','taxes')]),
      plan([{...step('a','goals'),operation:'BROWSER_EXECUTE'}]),
      plan([{...step('a','goals'),arguments:{page:'admin',tab:null}}]),
      plan([{...step('a','goals'),arguments:{page:'goals',tab:null,url:'https://evil.test'}}]),
      plan([step('__proto__','goals')]),
      plan([{...step('a','goals'),dependsOn:['b','b']}]),
      plan([{...step('a','goals'),dependsOn:['a']}]),
      plan([{...step('a','goals'),dependsOn:['not_exist']}]),
      plan(Array.from({length:7},(_,i)=>step('n'+i,'goals'))),
    ]) assert.equal(validateSovereignTaskPlan(x).ok,false,JSON.stringify(x).slice(0,150));
  });
  it('rejects invalid financial units and prototype/hidden fields',()=>{
    const a={operation:'SIP_COMPARE_DRAFT',id:'sip',dependsOn:[],
      arguments:{monthlyInvestment:5000,years:10,annualReturnAssumptionsPct:[7,10]}};
    assert.equal(validateSovereignTaskPlan(plan([a])).ok,true);
    for(const bad of [
      {...a,arguments:{...a.arguments,monthlyInvestment:Infinity}},
      {...a,arguments:{...a.arguments,annualReturnAssumptionsPct:[7,7]}},
      {...a,arguments:{...a.arguments,years:100}},
      {...a,arguments:{...a.arguments,tool:'deleteGoal'}},
    ])assert.equal(validateSovereignTaskPlan(plan([bad])).ok,false);
  });
});
