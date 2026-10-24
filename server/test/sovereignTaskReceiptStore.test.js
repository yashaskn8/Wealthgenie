import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import { recordSovereignTaskPreview,getSovereignTaskReceipt,sovereignReceiptId }
  from '../services/sovereignTaskReceiptStore.js';
const userId='60d5ecb8b3b3a72d9c8e4a11';
const otherId='60d5ecb8b3b3a72d9c8e4a12';
const key='123e4567-e89b-42d3-a456-426614174000';
const plan={version:'sovereign-task-plan-v1',steps:[{
  id:'nav',operation:'APP_NAVIGATE',arguments:{page:'goals',tab:null},dependsOn:[]
}]};
const preview={version:'sovereign-task-preview-v1',persisted:false,
  navigationApplied:false,financialStateModified:false,steps:[]
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
        value.requestHash!==filter.requestHash||value.status!==filter.status)
        return {matchedCount:0};
      Object.assign(value,update.$set);
      return {matchedCount:1};
    }
  };
}
const ready=async()=>{};
const args=repository=>({userId,key,plan,repository,ensureReady:ready,
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
      '_id','completedAt','createdAt','expiresAt','requestHash',
      'resultHash','status','userId'
    ]);
    assert.equal(JSON.stringify(saved).includes('monthlyInvestment'),false);
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
