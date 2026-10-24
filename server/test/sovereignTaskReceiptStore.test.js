import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import { recordSovereignTaskPreview,getSovereignTaskReceipt,sovereignReceiptId,
  hasSovereignReceiptTtlIndex }
  from '../services/sovereignTaskReceiptStore.js';
const userId='60d5ecb8b3b3a72d9c8e4a11';
const otherId='60d5ecb8b3b3a72d9c8e4a12';
const key='123e4567-e89b-42d3-a456-426614174000';
const secret='test-only-independent-secret-key-with-more-than-32-bytes';
const plan={version:'sovereign-task-plan-v1',steps:[{
  id:'nav',operation:'APP_NAVIGATE',arguments:{page:'goals',tab:null},dependsOn:[]
}]};
const preview={version:'sovereign-task-preview-v1',
  classification:'READ_ONLY_USER_REVIEWED_PREVIEW',persisted:false,
  navigationApplied:false,financialStateModified:false,steps:[
    {id:'nav',kind:'NAVIGATION_PROPOSAL',status:'PREVIEWED',page:'goals',
      tab:null,applied:false}
  ]
};
function memoryRepository(){
  const rows=new Map();
  return {
    rows,
    async create(row){
      if(rows.has(row._id)){const err=new Error('Duplicate');err.code=11000;throw err;}
      rows.set(row._id,{...row});
    },
    findOne(filter){
      return {lean:async()=>{
        const x=rows.get(filter._id);
        return x&&String(x.userId)===String(filter.userId)?{...x}:null;
      }};
    },
    async updateOne(filter,update){
      const value=rows.get(filter._id);
      if(!value||String(value.userId)!==String(filter.userId)||
        value.requestHash!==filter.requestHash||value.status!==filter.status||
        (filter.leaseExpiresAt?.$gt &&
          value.leaseExpiresAt.getTime()<=filter.leaseExpiresAt.$gt.getTime()))
        return {matchedCount:0};
      Object.assign(value,update.$set);
      return {matchedCount:1};
    }
  };
}
const ready=async()=>{};
const args=repository=>({userId,key,plan,repository,ensureReady:ready,secret,
  executePreview:async()=>preview});
describe('Sovereign opt-in durable preview receipts',()=>{
  it('records only hashes and returns a completed metadata receipt',async()=>{
    const repository=memoryRepository();
    const out=await recordSovereignTaskPreview(args(repository));
    assert.equal(out.outcome,'COMPLETED');
    assert.deepEqual(out.preview,preview);
    assert.equal(out.receipt.status,'SUCCEEDED');
    assert.equal(out.receipt.financialDataStored,false);
    assert.match(out.receipt.resultHash,/^[a-f0-9]{64}$/);
    const saved=repository.rows.get(out.receipt.id);
    assert.deepEqual(Object.keys(saved).sort(),[
      '_id','completedAt','createdAt','expiresAt','leaseExpiresAt',
      'requestHash','resultHash','status','userId'
    ]);
    assert.equal(JSON.stringify(saved).includes('monthlyInvestment'),false);
  });
  it('rejects forged success output and does not persist a success receipt',async()=>{
    const mutations=[
      {...preview,version:'sovereign-task-preview-v0'},
      {...preview,steps:[]},
      {...preview,steps:[{...preview.steps[0],page:'account'}]},
      {...preview,steps:[{...preview.steps[0],applied:true}]},
      {...preview,steps:[{...preview.steps[0],secret:'financialData'}]},
      {...preview,classification:'EXECUTED'},
      {...preview,financialStateModified:true},
      {...preview,steps:[{...preview.steps[0],status:'VERIFIED'}]}
    ];
    for(const forged of mutations){
      const repository=memoryRepository();
      await assert.rejects(()=>recordSovereignTaskPreview({
        ...args(repository),executePreview:async()=>forged
      }),{code:'SOVEREIGN_RECEIPT_UNSAFE_RESULT'});
      const row=[...repository.rows.values()][0];
      assert.equal(row.status,'FAILED');
      assert.equal(row.resultHash,null);
    }
  });
  it('rejects an accessor smuggled into the executor result',async()=>{
    const forged={...preview};
    Object.defineProperty(forged,'steps',{enumerable:true,get(){return preview.steps;}});
    const repository=memoryRepository();
    await assert.rejects(()=>recordSovereignTaskPreview({
      ...args(repository),executePreview:async()=>forged
    }),{code:'SOVEREIGN_RECEIPT_UNSAFE_RESULT'});
    assert.equal([...repository.rows.values()][0].status,'FAILED');
  });
  it('accepts a real-shaped financial preview and denies coherent forged figures',async()=>{
    const {sipFV}=await import('../services/projectionEngine.js');
    const multiPlan={version:'sovereign-task-plan-v1',steps:[
      {id:'nav',operation:'APP_NAVIGATE',arguments:{page:'goals',tab:null},dependsOn:[]},
      {id:'compare',operation:'SIP_COMPARE_DRAFT',arguments:{
        monthlyInvestment:5000,years:10,annualReturnAssumptionsPct:[7,10]
      },dependsOn:['nav']}
    ]};
    const scenarios=[7,10].map(rate=>{
      const futureValue=Math.round(sipFV(5000,rate/100,10));
      return {
        assumedAnnualReturnPct:rate,monthlyInvestment:5000,years:10,
        totalInvested:600000,futureValue,totalReturns:futureValue-600000,
        classification:'NON_RECOMMENDATION_PROFILE_CONSTRAINED_WHAT_IF',
        returnBasis:'USER_SUPPLIED_NOMINAL_ASSUMPTION'
      };
    });
    const trusted={
      version:'sovereign-task-preview-v1',
      classification:'READ_ONLY_USER_REVIEWED_PREVIEW',
      persisted:false,navigationApplied:false,financialStateModified:false,
      steps:[
        preview.steps[0],
        {id:'compare',kind:'FINANCIAL_COMPARISON',status:'VERIFIED',
          comparison:{
            version:'sovereign-voice-sip-compare-v1',
            classification:'UNSAVED_WHAT_IF_SIMULATION',
            profileStateRevision:1,
            note:'These are nominal projections using user-supplied hypothetical annual returns, not quotes, guarantees, investment recommendations or post-tax results.',
            scenarios,
            differences:{futureValue:scenarios[1].futureValue-scenarios[0].futureValue,invested:0},
            persisted:false
          }}
      ]
    };
    const repository=memoryRepository();
    const accepted=await recordSovereignTaskPreview({
      ...args(repository),plan:multiPlan,executePreview:async()=>trusted
    });
    assert.equal(accepted.outcome,'COMPLETED');
    assert.equal(accepted.receipt.status,'SUCCEEDED');
    const forged=structuredClone(trusted);
    forged.steps[1].comparison.scenarios[0].futureValue+=100;
    forged.steps[1].comparison.scenarios[0].totalReturns+=100;
    forged.steps[1].comparison.differences.futureValue-=100;
    const badRepo=memoryRepository();
    await assert.rejects(()=>recordSovereignTaskPreview({
      ...args(badRepo),plan:multiPlan,executePreview:async()=>forged
    }),{code:'SOVEREIGN_RECEIPT_UNSAFE_RESULT'});
    const row=[...badRepo.rows.values()][0];
    assert.equal(row.status,'FAILED');
    assert.equal(row.resultHash,null);
  });
  it('returns metadata and never repeats a completed operation with the same key',async()=>{
    const repository=memoryRepository();
    let executions=0;
    const a=await recordSovereignTaskPreview({...args(repository),
      executePreview:async()=>{executions++;return preview;}});
    const b=await recordSovereignTaskPreview({...args(repository),
      executePreview:async()=>{executions++;return preview;}});
    assert.equal(executions,1);
    assert.equal(b.outcome,'ALREADY_COMPLETED');
    assert.equal(b.preview,null);
    assert.equal(a.receipt.resultHash,b.receipt.resultHash);
  });
  it('settles a cancelled receipt even when a read-only provider never responds',async()=>{
    const repository=memoryRepository();
    const controller=new AbortController();
    let entered=false;
    const request=recordSovereignTaskPreview({
      ...args(repository),signal:controller.signal,
      executePreview:async()=>{
        entered=true;
        return new Promise(()=>{});
      }
    });
    for(let n=0;n<30&&!entered;n++)await Promise.resolve();
    assert.equal(entered,true);
    controller.abort();
    await assert.rejects(request,{code:'SOVEREIGN_RECEIPT_CANCELLED'});
    const saved=[...repository.rows.values()][0];
    assert.equal(saved.status,'CANCELLED');
    assert.equal(saved.resultHash,null);
  });
  it('rejects cross-plan key reuse, even when the first plan succeeded',async()=>{
    const repository=memoryRepository();
    await recordSovereignTaskPreview(args(repository));
    await assert.rejects(()=>recordSovereignTaskPreview({...args(repository),
      plan:{...plan,steps:[{...plan.steps[0],arguments:{page:'taxes',tab:null}}]}}),
      {code:'SOVEREIGN_RECEIPT_KEY_REUSED'});
  });
  it('returns conflict instead of replaying concurrent or failed attempts',async()=>{
    const repository=memoryRepository();
    let release;
    const waiting=new Promise(resolve=>{release=resolve;});
    const first=recordSovereignTaskPreview({...args(repository),
      executePreview:async()=>waiting});
    // Yield enough microtasks for the atomic reservation to be created.
    for(let n=0;n<15&&repository.rows.size===0;n++)await Promise.resolve();
    assert.equal(repository.rows.size,1);
    await assert.rejects(()=>recordSovereignTaskPreview(args(repository)),
      {code:'SOVEREIGN_RECEIPT_ALREADY_CLAIMED'});
    release(preview);
    await first;
  });
  it('fails closed if result cannot be recorded durably',async()=>{
    const repository=memoryRepository();
    repository.updateOne=async()=>({matchedCount:0});
    await assert.rejects(()=>recordSovereignTaskPreview(args(repository)),
      {code:'SOVEREIGN_RECEIPT_STORE_UNAVAILABLE'});
  });
  it('checks ownership for readback and never stores raw task plans',async()=>{
    const repository=memoryRepository();
    const a=await recordSovereignTaskPreview(args(repository));
    assert.deepEqual(await getSovereignTaskReceipt({
      userId,id:a.receipt.id,repository,ensureReady:ready
    }),a.receipt);
    await assert.rejects(()=>getSovereignTaskReceipt({
      userId:otherId,id:a.receipt.id,repository,ensureReady:ready
    }),{code:'SOVEREIGN_RECEIPT_NOT_FOUND'});
    assert.notEqual(sovereignReceiptId({userId,key}),sovereignReceiptId({userId:otherId,key}));
  });
  it('rejects unhashed receipts without an independent cryptographic secret',async()=>{
    const repository=memoryRepository();
    await assert.rejects(()=>recordSovereignTaskPreview({
      ...args(repository),secret:'short'
    }),{code:'SOVEREIGN_RECEIPT_HASH_KEY_MISSING'});
    assert.equal(repository.rows.size,0);
  });
  it('requires exact seven-day TTL index settings for retention',()=>{
    assert.equal(hasSovereignReceiptTtlIndex([]),false);
    assert.equal(hasSovereignReceiptTtlIndex([{
      name:'ttl_sovereign_task_receipt',key:{expiresAt:1},expireAfterSeconds:60
    }]),false);
    assert.equal(hasSovereignReceiptTtlIndex([{
      name:'ttl_sovereign_task_receipt',key:{expiresAt:1},expireAfterSeconds:0
    }]),true);
  });
  it('never replays an expired or stale-running receipt as a completed outcome',async()=>{
    const repository=memoryRepository();
    const id=sovereignReceiptId({userId,key});
    repository.rows.set(id,{
      _id:id,userId,requestHash:'a'.repeat(64),status:'RUNNING',
      createdAt:new Date(Date.now()-90_000),
      leaseExpiresAt:new Date(Date.now()-60_000),
      expiresAt:new Date(Date.now()+60_000)
    });
    const receipt=await getSovereignTaskReceipt({userId,id,repository,ensureReady:ready});
    assert.equal(receipt.status,'OUTCOME_UNKNOWN');
    repository.rows.get(id).expiresAt=new Date(Date.now()-1000);
    await assert.rejects(()=>getSovereignTaskReceipt({
      userId,id,repository,ensureReady:ready
    }),{code:'SOVEREIGN_RECEIPT_EXPIRED'});
  });
  it('never stores invalid plans or unauthenticated request IDs',async()=>{
    const repository=memoryRepository();
    await assert.rejects(()=>recordSovereignTaskPreview({
      ...args(repository),plan:{...plan,steps:[{...plan.steps[0],operation:'BROWSER_EXECUTE'}]}
    }),{code:'SOVEREIGN_RECEIPT_PLAN_REJECTED'});
    await assert.rejects(()=>recordSovereignTaskPreview({
      ...args(repository),key:'not-an-id'
    }),{code:'SOVEREIGN_RECEIPT_ID_INVALID'});
    assert.equal(repository.rows.size,0);
  });
});
