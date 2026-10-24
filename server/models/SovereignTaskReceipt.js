import mongoose from 'mongoose';
import { protectImmutableIdentity } from './immutableIdentity.js';

/**
 * Opt-in, metadata-only task preview ledger. Financial inputs and outputs are
 * NEVER stored here; only one-way request/response digests and state markers.
 * TTL is safe only because this feature executes read-only previews.
 */
const sovereignTaskReceiptSchema=new mongoose.Schema({
  _id:{type:String,required:true,immutable:true,match:/^[a-f0-9]{64}$/},
  userId:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true,immutable:true},
  requestHash:{type:String,required:true,immutable:true,match:/^[a-f0-9]{64}$/},
  status:{type:String,required:true,enum:['RUNNING','SUCCEEDED','FAILED','CANCELLED']},
  resultHash:{type:String,default:null,match:/^[a-f0-9]{64}$/},
  createdAt:{type:Date,default:Date.now,required:true},
  completedAt:{type:Date,default:null},
  expiresAt:{type:Date,required:true}
},{strict:'throw',versionKey:false});
sovereignTaskReceiptSchema.index({userId:1,_id:1},{
  unique:true,name:'uniq_sovereign_task_receipt_owner'
});
sovereignTaskReceiptSchema.index({expiresAt:1},{
  expireAfterSeconds:0,name:'ttl_sovereign_task_receipt'
});
protectImmutableIdentity(sovereignTaskReceiptSchema,['userId','requestHash'],{
  code:'SOVEREIGN_RECEIPT_IDENTITY_IMMUTABLE',label:'Sovereign task receipt'
});
export default mongoose.models.SovereignTaskReceipt ||
  mongoose.model('SovereignTaskReceipt',sovereignTaskReceiptSchema);
