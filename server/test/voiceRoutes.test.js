import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import User from '../models/User.js';
import { createVoiceRouter } from '../routes/voiceRoutes.js';
import {sipFV} from '../services/projectionEngine.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { withServer, rawRequest } from '../test-utils/httpTestUtils.js';

const originalSecret=process.env.JWT_SECRET;
const secret=originalSecret || 'voice-route-test-secret-2026';
const mockUserId='60d5ecb8b3b3a72d9c8e4a11';
const token=()=>jwt.sign({userId:mockUserId,email:'voice@example.com'},secret,{expiresIn:'1h'});

const financialProfile={_id:'64b000000000000000000101',version:1,financialStateFence:0,monthlySavings:10000,investmentHorizonYears:20};
function fakeResolver() {
  return Promise.resolve({profile:{...financialProfile},state:{
    resolutionStatus:'CURRENT',currentProfileId:financialProfile._id,revision:1,promotionFence:1
  }});
}
function fakeRegistry() {
  return {executeTool:async(_name,args)=>{
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
}
function buildApp(enabled=true, options={}) {
  const app=express();
  app.use(express.json());
  app.use('/api/voice',createVoiceRouter({enabled,...options}));
  app.use(errorHandler);
  return app;
}
function request(url,transcript,withAuth=true) {
  return rawRequest(url,{
    method:'POST',
    headers:{
      'content-type':'application/json',
      ...(withAuth?{authorization:'Bearer '+token()}:{})
    },
    body:JSON.stringify({transcript})
  });
}
let originalFindById,originalReadyState;

beforeEach(()=>{
  process.env.JWT_SECRET=secret;
  originalFindById=User.findById;
  originalReadyState=mongoose.connection.readyState;
  mongoose.connection.readyState=1;
  User.findById=()=>({select(){return this;},lean:async()=>({role:'user'})});
});
afterEach(()=>{
  User.findById=originalFindById;
  mongoose.connection.readyState=originalReadyState;
  if(originalSecret===undefined)delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET=originalSecret;
});
describe('GenieVoice protected route',()=>{
  it('rejects unauthenticated navigation',async()=>{
    await withServer(buildApp(),async(base)=>{
      const r=await request(base+'/api/voice/interpret','open goals',false);
      assert.equal(r.status,401);
    });
  });
  it('feature flag denies authenticated requests by default',async()=>{
    await withServer(buildApp(false),async(base)=>{
      const r=await request(base+'/api/voice/interpret','open goals');
      assert.equal(r.status,404);
      assert.equal(r.headers.get('cache-control'),'no-store');
    });
  });
  it('issues only bounded read-only page commands',async()=>{
    await withServer(buildApp(),async(base)=>{
      const r=await request(base+'/api/voice/interpret','open goals');
      assert.equal(r.status,200);
      assert.equal(r.headers.get('cache-control'),'no-store');
      const body=await r.json();
      assert.deepEqual(body,{action:'APP_NAVIGATE',page:'goals',tab:null,version:'sovereign-voice-intent-v1'});
    });
  });
  it('rejects schema smuggling, long transcripts and unexpected fields',async()=>{
    await withServer(buildApp(),async(base)=>{
      for(const body of [{transcript:'open goals',tool:'deleteProfile'}, {transcript:'x'.repeat(1001)}, {transcript:123}]){
        const r=await rawRequest(base+'/api/voice/interpret',{
          method:'POST',
          headers:{'content-type':'application/json',authorization:'Bearer '+token()},
          body:JSON.stringify(body)
        });
        assert.equal(r.status,400,JSON.stringify(body).slice(0,80));
      }
    });
  });
  it('compares two explicit user-supplied SIP assumptions under authenticated profile binding',async()=>{
    let actor=null;
    await withServer(buildApp(true,{resolveProfile:async query=>{
      actor=query.userId;
      return fakeResolver();
    },financialRegistry:fakeRegistry()}),async(base)=>{
      const r=await rawRequest(base+'/api/voice/sip-compare',{
        method:'POST',
        headers:{'content-type':'application/json',authorization:'Bearer '+token()},
        body:JSON.stringify({monthlyInvestment:5000,years:10,annualReturnAssumptionsPct:[7,10]})
      });
      assert.equal(r.status,200);
      const result=await r.json();
      assert.equal(actor,mockUserId);
      assert.equal(result.persisted,false);
      assert.equal(result.classification,'UNSAVED_WHAT_IF_SIMULATION');
      assert.equal(result.scenarios.length,2);
      assert.equal(result.differences.futureValue,
        Math.round(sipFV(5000,.10,10))-Math.round(sipFV(5000,.07,10)));
      assert.match(result.note,/hypothetical annual returns/i);
    });
  });
  it('rejects missing auth, extra tools, forbidden rates and malformed SIP comparisons',async()=>{
    const body={monthlyInvestment:5000,years:10,annualReturnAssumptionsPct:[7,10]};
    await withServer(buildApp(true,{resolveProfile:fakeResolver,financialRegistry:fakeRegistry()}),async(base)=>{
      const noAuth=await rawRequest(base+'/api/voice/sip-compare',{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)
      });
      assert.equal(noAuth.status,401);
      for(const mutation of [
        {...body,operation:'buyMutualFund'}, {...body,annualReturnAssumptionsPct:[7,7]},
        {...body,annualReturnAssumptionsPct:[-1,10]},{...body,years:50},
        {...body,monthlyInvestment:5000.25},
        {...body,annualReturnAssumptionsPct:[7.12345,10]},
        {...body,annualReturnAssumptionsPct:['7',10]},
      ]) {
        const r=await rawRequest(base+'/api/voice/sip-compare',{
          method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token()},
          body:JSON.stringify(mutation)
        });
        assert.equal(r.status,400,JSON.stringify(mutation));
      }
    });
  });
  it('authenticates and previews a bounded read-only dependent plan',async()=>{
    const plan={version:'sovereign-task-plan-v1',steps:[
      {id:'navigate',operation:'APP_NAVIGATE',arguments:{page:'goals',tab:null},dependsOn:[]},
      {id:'compare',operation:'SIP_COMPARE_DRAFT',
        arguments:{monthlyInvestment:5000,years:10,annualReturnAssumptionsPct:[7,10]},
        dependsOn:['navigate']}
    ]};
    await withServer(buildApp(true,{resolveProfile:fakeResolver,financialRegistry:fakeRegistry()}),async(base)=>{
      const url=base+'/api/voice/task-preview';
      const response=await rawRequest(url,{
        method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token()},
        body:JSON.stringify({plan})
      });
      assert.equal(response.status,200);
      const preview=await response.json();
      assert.equal(preview.navigationApplied,false);
      assert.equal(preview.financialStateModified,false);
      assert.equal(preview.persisted,false);
      assert.deepEqual(preview.steps.map(s=>s.id),['navigate','compare']);
      assert.equal(preview.steps[0].applied,false);
      const noAuth=await rawRequest(url,{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({plan})
      });
      assert.equal(noAuth.status,401);
      const denied=await rawRequest(url,{
        method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token()},
        body:JSON.stringify({plan:{...plan,steps:[{...plan.steps[0],operation:'BROWSER_EXECUTE'}]}})
      });
      assert.equal(denied.status,422);
    });
  });
  it('keeps durable receipts disabled and refuses recording without explicit opt-in',async()=>{
    const plan={version:'sovereign-task-plan-v1',steps:[{
      id:'navigate',operation:'APP_NAVIGATE',arguments:{page:'goals',tab:null},dependsOn:[]
    }]};
    await withServer(buildApp(true,{receiptsEnabled:false}),async(base)=>{
      const r=await rawRequest(base+'/api/voice/task-preview/recorded',{
        method:'POST',
        headers:{'content-type':'application/json','authorization':'Bearer '+token(),
          'idempotency-key':'123e4567-e89b-42d3-a456-426614174000'},
        body:JSON.stringify({plan,persistReceipt:true})
      });
      assert.equal(r.status,404);
    });
    await withServer(buildApp(true,{receiptsEnabled:true}),async(base)=>{
      const r=await rawRequest(base+'/api/voice/task-preview/recorded',{
        method:'POST',
        headers:{'content-type':'application/json','authorization':'Bearer '+token(),
          'idempotency-key':'123e4567-e89b-42d3-a456-426614174000'},
        body:JSON.stringify({plan,persistReceipt:false})
      });
      assert.equal(r.status,400);
    });
  });
  it('stores metadata-only receipts and refuses reuse with a different plan',async()=>{
    const saved=new Map();
    const receiptRepository={
      async create(doc){
        if(saved.has(doc._id)){const e=new Error('duplicate');e.code=11000;throw e;}
        saved.set(doc._id,{...doc});
      },
      findOne(query){
        return {lean:async()=>{const found=saved.get(query._id);
          return String(found?.userId)===String(query.userId)?{...found}:null;}};
      },
      async updateOne(query,update){
        const rec=saved.get(query._id);
        if(!rec||rec.status!==query.status||rec.requestHash!==query.requestHash||
          (query.leaseExpiresAt?.$gt &&
            rec.leaseExpiresAt.getTime()<=query.leaseExpiresAt.$gt.getTime()))
          return {matchedCount:0};
        Object.assign(rec,update.$set);return {matchedCount:1};
      }
    };
    const plan={version:'sovereign-task-plan-v1',steps:[{
      id:'navigate',operation:'APP_NAVIGATE',arguments:{page:'goals',tab:null},dependsOn:[]
    }]};
    await withServer(buildApp(true,{
      receiptsEnabled:true,receiptRepository,
      receiptHashSecret:'test-only-independent-secret-key-with-more-than-32-bytes',
      ensureReceiptReady:async()=>{}
    }),async(base)=>{
      const url=base+'/api/voice/task-preview/recorded';
      const headers={'content-type':'application/json','authorization':'Bearer '+token(),
        'idempotency-key':'123e4567-e89b-42d3-a456-426614174000'};
      const send=body=>rawRequest(url,{method:'POST',headers,body:JSON.stringify(body)});
      const first=await send({plan,persistReceipt:true});
      assert.equal(first.status,201);
      const data=await first.json();
      assert.equal(data.outcome,'COMPLETED');
      assert.equal(data.receipt.financialDataStored,false);
      assert.equal(data.preview.navigationApplied,false);
      const duplicate=await send({plan,persistReceipt:true});
      assert.equal(duplicate.status,200);
      const again=await duplicate.json();
      assert.equal(again.outcome,'ALREADY_COMPLETED');
      assert.equal(again.preview,null);
      assert.equal(again.receipt.resultHash,data.receipt.resultHash);
      const collision=await send({
        plan:{...plan,steps:[{...plan.steps[0],arguments:{page:'taxes',tab:null}}]},
        persistReceipt:true
      });
      assert.equal(collision.status,409);
      const readback=await rawRequest(base+'/api/voice/task-preview/receipts/'+data.receipt.id,{
        headers:{authorization:'Bearer '+token()}
      });
      assert.equal(readback.status,200);
      assert.equal((await readback.json()).receipt.status,'SUCCEEDED');
      assert.equal(saved.size,1);
    });
  });
  it('does not execute or transform external and mutating requests into navigation',async()=>{
    await withServer(buildApp(),async(base)=>{
      for(const text of ['open https://evil.example','open google','open goals and delete them','open my account and transfer funds']){
        const r=await request(base+'/api/voice/interpret',text);
        assert.equal(r.status,200);
        const body=await r.json();
        assert.equal(body.action,'REJECTED',text);
        assert.equal(body.page,undefined);
      }
    });
  });
});
