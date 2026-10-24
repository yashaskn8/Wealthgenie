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
  it('does not grant planner authority to inherited, accessor or hidden properties',()=>{
    const inheritedArgs=Object.create({page:'goals',tab:null});
    const accessorArgs={tab:null};Object.defineProperty(accessorArgs,'page',{
      enumerable:true,get(){return 'goals';}
    });
    const hiddenArgs={page:'goals'};Object.defineProperty(hiddenArgs,'tab',{
      value:null,enumerable:false
    });
    const symbolArgs={page:'goals',tab:null};symbolArgs[Symbol('secret')]='x';
    const hiddenStep={...step('a','goals')};
    Object.defineProperty(hiddenStep,'forbidden',{
      value:'DELETE_PROFILE',enumerable:false
    });
    for(const candidate of [
      plan([{...step('a','goals'),arguments:inheritedArgs}]),
      plan([{...step('a','goals'),arguments:accessorArgs}]),
      plan([{...step('a','goals'),arguments:hiddenArgs}]),
      plan([{...step('a','goals'),arguments:symbolArgs}]),
      plan([hiddenStep])
    ])assert.equal(validateSovereignTaskPlan(candidate).ok,false);
    const normal=validateSovereignTaskPlan(plan([step('a','goals')]));
    assert.equal(normal.ok,true);
    assert.deepEqual(normal.steps[0].arguments,{page:'goals',tab:null});
  });
  it('rejects sparse dependency arrays and accessor-based or sparse financial rates',()=>{
    const missingDependencySlot=Array(1);
    const sparseRates=[7,,];
    const accessorRates=[7,10];
    Object.defineProperty(accessorRates,'1',{enumerable:true,configurable:true,
      get(){return 10;}
    });
    const sparseSteps=Array(1);
    for(const malformed of [
      plan(sparseSteps),
      plan([{...step('a','goals'),dependsOn:missingDependencySlot}]),
      plan([{id:'a',operation:'SIP_COMPARE_DRAFT',
        arguments:{monthlyInvestment:5000,years:10,annualReturnAssumptionsPct:sparseRates},
        dependsOn:[]}]),
      plan([{id:'a',operation:'SIP_COMPARE_DRAFT',
        arguments:{monthlyInvestment:5000,years:10,annualReturnAssumptionsPct:accessorRates},
        dependsOn:[]}])
    ])assert.equal(validateSovereignTaskPlan(malformed).ok,false);
    assert.equal(validateSovereignTaskPlan(plan([step('a','goals')])).ok,true);
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
