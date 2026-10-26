import {after,before,describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import mongoose from 'mongoose';
import SovereignTaskReceipt from '../models/SovereignTaskReceipt.js';
import {
  recordSovereignTaskPreview,getSovereignTaskReceipt,
  hasSovereignReceiptTtlIndex,sovereignReceiptId
} from '../services/sovereignTaskReceiptStore.js';

// This suite must be launched separately against the isolated MongoDB replica
// in CI, never against an ordinary user's configured application database.
const uri=process.env.GENIEVOICE_TEST_MONGODB_URI;
if(!uri || !uri.includes('wealthgenie_genievoice_receipts_ci'))
  throw new Error('GENIEVOICE_TEST_MONGODB_URI must identify the isolated GenieVoice CI database.');
const owner='60d5ecb8b3b3a72d9c8e4a11';
const otherOwner='60d5ecb8b3b3a72d9c8e4a12';
const secret='test-only-genievoice-ledger-hmac-key-over-32-bytes';
const plan={version:'sovereign-task-plan-v1',steps:[
  {id:'goals',operation:'APP_NAVIGATE',
   arguments:{page:'goals',tab:null},dependsOn:[]}
]};
before(async()=>{await mongoose.connect(uri,{autoIndex:false});});
after(async()=>{await mongoose.disconnect();});

describe('GenieVoice durable receipt MongoDB replica integration',()=>{
  it('requires real unique-owner and exact unrestricted seven-day TTL indexes',async()=>{
    const indexes=await SovereignTaskReceipt.collection.indexes();
    assert.ok(indexes.some(i=>i.unique===true &&
      i.key?.userId===1 && i.key?._id===1 &&
      Object.keys(i.key).length===2),'owner-unique index not migrated');
    assert.equal(hasSovereignReceiptTtlIndex(indexes),true);
  });

  it('uses one atomic Mongo claim under concurrent repeated submissions',async()=>{
    const key=randomUUID();
    const requests=Array.from({length:12},()=>recordSovereignTaskPreview({
      userId:owner,key,plan,secret
    }));
    const settled=await Promise.allSettled(requests);
    const completed=settled.filter(x=>x.status==='fulfilled'&&x.value.outcome==='COMPLETED');
    assert.equal(completed.length,1,'multiple workers published an original result');
    for(const item of settled){
      if(item.status==='fulfilled'){
        assert.ok(['COMPLETED','ALREADY_COMPLETED'].includes(item.value.outcome));
        if(item.value.outcome==='ALREADY_COMPLETED')assert.equal(item.value.preview,null);
      }else assert.equal(item.reason?.code,'SOVEREIGN_RECEIPT_ALREADY_CLAIMED');
    }
    const id=sovereignReceiptId({userId:owner,key});
    assert.equal(await SovereignTaskReceipt.countDocuments({_id:id}),1);
    const row=await SovereignTaskReceipt.findById(id).lean();
    assert.equal(row.status,'SUCCEEDED');
    assert.equal(row.resultHash?.length,64);
    assert.equal(row.plan,undefined);
    assert.equal(row.preview,undefined);
    assert.equal(row.transcript,undefined);
  });

  it('filters real Mongo reads by owner and isolates per-user idempotency keys',async()=>{
    const key=randomUUID();
    const a=await recordSovereignTaskPreview({userId:owner,key,plan,secret});
    const b=await recordSovereignTaskPreview({userId:otherOwner,key,plan,secret});
    assert.notEqual(a.receipt.id,b.receipt.id);
    assert.equal(a.receipt.status,'SUCCEEDED');
    assert.equal(b.receipt.status,'SUCCEEDED');
    const own=await getSovereignTaskReceipt({userId:owner,id:a.receipt.id});
    assert.equal(own.id,a.receipt.id);
    await assert.rejects(
      ()=>getSovereignTaskReceipt({userId:otherOwner,id:a.receipt.id}),
      {code:'SOVEREIGN_RECEIPT_NOT_FOUND'}
    );
    await assert.rejects(
      ()=>getSovereignTaskReceipt({userId:owner,id:b.receipt.id}),
      {code:'SOVEREIGN_RECEIPT_NOT_FOUND'}
    );
  });

  it('blocks replay with changed plan and never persists raw financial assumptions',async()=>{
    const key=randomUUID();
    const a=await recordSovereignTaskPreview({userId:owner,key,plan,secret});
    assert.equal(a.outcome,'COMPLETED');
    await assert.rejects(()=>recordSovereignTaskPreview({
      userId:owner,key,secret,
      plan:{...plan,steps:[{...plan.steps[0],arguments:{page:'taxes',tab:null}}]}
    }),{code:'SOVEREIGN_RECEIPT_KEY_REUSED'});
    const row=await SovereignTaskReceipt.findById(a.receipt.id).lean();
    assert.deepEqual(Object.keys(row).sort(),[
      '_id','completedAt','createdAt','expiresAt','leaseExpiresAt',
      'requestHash','resultHash','status','userId'
    ]);
  });
});
