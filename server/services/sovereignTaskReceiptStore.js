import mongoose from 'mongoose';
import { createHmac } from 'node:crypto';
import { canonicalSha256,canonicalJson } from '../utils/canonicalJson.js';
import { createError } from '../middleware/errorHandler.js';
import { verifyPersistenceIndexes } from './persistenceIndexReadiness.js';
import SovereignTaskReceipt from '../models/SovereignTaskReceipt.js';
import { validateSovereignTaskPlan } from './sovereignTaskPlanPolicy.js';
import { previewSovereignReadOnlyTask } from './sovereignReadOnlyTaskPreview.js';
import { isVerifiedSovereignReadOnlyPreview } from './sovereignPreviewReceiptPolicy.js';

export const SOVEREIGN_RECEIPT_VERSION='sovereign-task-receipt-v1';
export const SOVEREIGN_RECEIPT_RETENTION_MS=7*24*60*60*1000;
const KEY=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const IDENTIFIER=/^[a-f0-9]{64}$/;
const RECEIPT_LEASE_MS=30_000;
const error=(status,code,message)=>createError(status,message,message,{code});
export function hasSovereignReceiptTtlIndex(indexes) {
  return Array.isArray(indexes)&&indexes.some(i=>
    i.name==='ttl_sovereign_task_receipt' && i.key?.expiresAt===1 &&
    Object.keys(i.key).length===1 && i.expireAfterSeconds===0 &&
    // A partial/sparse TTL index could silently retain financial task metadata.
    i.partialFilterExpression===undefined && i.sparse!==true);
}
const ready=async()=>{
  await verifyPersistenceIndexes({models:[SovereignTaskReceipt],scope:'persistence'});
  if(!hasSovereignReceiptTtlIndex(await SovereignTaskReceipt.collection.indexes()))
    throw storeUnavailable();
};
const publicReceipt=record=>({
  version:SOVEREIGN_RECEIPT_VERSION,
  id:String(record._id),
  status:record.status,
  requestHash:record.requestHash,
  resultHash:record.resultHash||null,
  createdAt:new Date(record.createdAt).toISOString(),
  leaseExpiresAt:new Date(record.leaseExpiresAt).toISOString(),
  completedAt:record.completedAt?new Date(record.completedAt).toISOString():null,
  expiresAt:new Date(record.expiresAt).toISOString(),
  financialStateModified:false,
  navigationApplied:false,
  financialDataStored:false
});
function observedReceipt(record,now=Date.now()){
  if(new Date(record.expiresAt).getTime()<=now)
    throw error(410,'SOVEREIGN_RECEIPT_EXPIRED','This task receipt has expired.');
  if(record.status==='RUNNING'&&new Date(record.leaseExpiresAt).getTime()<=now)
    return publicReceipt({...record,status:'OUTCOME_UNKNOWN'});
  return publicReceipt(record);
}
function receiptDigest(value,secret){
  if(typeof secret!=='string'||Buffer.byteLength(secret,'utf8')<32)
    throw error(503,'SOVEREIGN_RECEIPT_HASH_KEY_MISSING',
      'Task receipts require an independent server secret.');
  return createHmac('sha256',secret).update(canonicalJson(value)).digest('hex');
}
function cancellableReadOnlyPreview(run,signal) {
  if(!signal)return Promise.resolve().then(run);
  if(signal.aborted)return Promise.reject(error(409,'SOVEREIGN_RECEIPT_CANCELLED',
    'Task preview was interrupted before execution.'));
  return new Promise((resolve,reject)=>{
    let finished=false;
    const settle=(fn,value)=>{
      if(finished)return;
      finished=true;
      signal.removeEventListener('abort',onAbort);
      fn(value);
    };
    const onAbort=()=>settle(reject,error(409,'SOVEREIGN_RECEIPT_CANCELLED',
      'Task preview was interrupted. Upstream read-only work may still be finishing.'));
    signal.addEventListener('abort',onAbort,{once:true});
    if(signal.aborted){onAbort();return;}
    Promise.resolve().then(()=>{
      if(signal.aborted)throw error(409,'SOVEREIGN_RECEIPT_CANCELLED',
        'Task preview was interrupted.');
      return run();
    }).then(value=>settle(resolve,value),cause=>settle(reject,cause));
  });
}
const storeUnavailable=()=>error(503,'SOVEREIGN_RECEIPT_STORE_UNAVAILABLE',
  'Task receipt storage is unavailable. No task preview was published.');
export function sovereignReceiptId({userId,key}) {
  if(!mongoose.isValidObjectId(userId)||!KEY.test(key||'')){
    throw error(400,'SOVEREIGN_RECEIPT_ID_INVALID','An authenticated account and a UUIDv4 Idempotency-Key are required.');
  }
  return canonicalSha256({domain:'genievoice.readonly.receipt.v1',userId:String(userId),key:key.toLowerCase()});
}

/**
 * Executes the already-authorized read-only preview exactly once within the
 * seven-day receipt window. A same-key retry returns metadata, not stale
 * financial values. A lost original response MUST be explicitly recalculated
 * with a fresh key and current profile state; no mutation tool is supported.
 */
export async function recordSovereignTaskPreview({
  userId,key,plan,signal,resolveProfile,financialRegistry,
  repository=SovereignTaskReceipt,ensureReady=ready,
  executePreview=previewSovereignReadOnlyTask,
  secret=process.env.GENIEVOICE_RECEIPT_HASH_KEY
}) {
  const id=sovereignReceiptId({userId,key});
  const valid=validateSovereignTaskPlan(plan);
  if(!valid.ok)throw error(422,'SOVEREIGN_RECEIPT_PLAN_REJECTED',
    'Invalid task plan. No task receipt was stored.');
  if(signal?.aborted)throw error(409,'SOVEREIGN_RECEIPT_CANCELLED',
    'This task was cancelled before it started.');
  const normalizedPlan={version:valid.version,steps:valid.steps};
  const requestHash=receiptDigest({domain:SOVEREIGN_RECEIPT_VERSION,
    userId:String(userId),plan:normalizedPlan},secret);
  try{await ensureReady();}catch{throw storeUnavailable();}
  if(signal?.aborted)throw error(409,'SOVEREIGN_RECEIPT_CANCELLED',
    'Task preview was interrupted before receipt reservation.');
  const now=new Date();
  const record={
    _id:id,userId,requestHash,status:'RUNNING',resultHash:null,
    createdAt:now,completedAt:null,
    leaseExpiresAt:new Date(now.getTime()+RECEIPT_LEASE_MS),
    expiresAt:new Date(now.getTime()+SOVEREIGN_RECEIPT_RETENTION_MS)
  };
  try{
    await repository.create(record);
  }catch(cause){
    if(cause?.code!==11000)throw storeUnavailable();
    let existing;
    try{existing=await repository.findOne({_id:id,userId}).lean();}catch{throw storeUnavailable();}
    if(!existing)throw storeUnavailable();
    if(new Date(existing.expiresAt).getTime()<=Date.now())
      throw error(410,'SOVEREIGN_RECEIPT_EXPIRED','This task receipt has expired.');
    if(existing.requestHash!==requestHash)throw error(409,
      'SOVEREIGN_RECEIPT_KEY_REUSED','This operation ID was used for a different task plan.');
    if(existing.status==='SUCCEEDED'){
      return {outcome:'ALREADY_COMPLETED',receipt:observedReceipt(existing),preview:null};
    }
    throw error(409,existing.status==='RUNNING'&&
      new Date(existing.leaseExpiresAt).getTime()<=Date.now()
        ? 'SOVEREIGN_RECEIPT_OUTCOME_UNKNOWN':'SOVEREIGN_RECEIPT_ALREADY_CLAIMED',
      'This task operation was already attempted. Check its receipt before starting another.');
  }
  try{
    if(signal?.aborted)throw error(409,'SOVEREIGN_RECEIPT_CANCELLED',
      'This task was cancelled before execution.');
    const preview=await cancellableReadOnlyPreview(()=>executePreview({
      userId,plan:normalizedPlan,resolveProfile,financialRegistry,signal
    }),signal);
    if(signal?.aborted)throw error(409,'SOVEREIGN_RECEIPT_CANCELLED',
      'This task was cancelled before publication.');
    if(!isVerifiedSovereignReadOnlyPreview(preview,valid)){
      throw error(503,'SOVEREIGN_RECEIPT_UNSAFE_RESULT',
        'Task executor did not return a verifiable read-only result.');
    }
    const resultHash=receiptDigest({domain:SOVEREIGN_RECEIPT_VERSION,
      userId:String(userId),preview},secret);
    const completedAt=new Date();
    const result=await repository.updateOne(
      {_id:id,userId,requestHash,status:'RUNNING',leaseExpiresAt:{$gt:completedAt}},
      {$set:{status:'SUCCEEDED',resultHash,completedAt}},
      {runValidators:true}
    );
    if(result?.matchedCount!==1)throw storeUnavailable();
    return {outcome:'COMPLETED',receipt:publicReceipt({
      ...record,status:'SUCCEEDED',resultHash,completedAt
    }),preview};
  }catch(cause){
    // A late/failed persistence response is never classified as success.
    try{
      const timedOut=signal?.aborted&&signal.reason?.name==='TimeoutError';
      const expired=Date.now()>=record.leaseExpiresAt.getTime();
      await repository.updateOne({_id:id,userId,requestHash,status:'RUNNING'},
        {$set:{status:expired||timedOut?'OUTCOME_UNKNOWN':signal?.aborted?'CANCELLED':'FAILED',
          completedAt:new Date()}},
        {runValidators:true});
    }catch{throw storeUnavailable();}
    throw cause;
  }
}
export async function getSovereignTaskReceipt({
  userId,id,repository=SovereignTaskReceipt,ensureReady=ready
}) {
  if(!mongoose.isValidObjectId(userId)||typeof id!=='string'||!IDENTIFIER.test(id)){
    throw error(400,'SOVEREIGN_RECEIPT_ID_INVALID','Invalid task receipt identifier.');
  }
  try{await ensureReady();}catch{throw storeUnavailable();}
  let record;
  try{record=await repository.findOne({_id:id,userId}).lean();}catch{throw storeUnavailable();}
  if(!record)throw error(404,'SOVEREIGN_RECEIPT_NOT_FOUND','Task receipt not found.');
  return observedReceipt(record);
}
