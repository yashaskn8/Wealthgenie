import mongoose from 'mongoose';
import { RISK_SHORTLIST_POLICY_VERSION } from '../services/riskShortlist.js';
const scoreFactorsSchema = new mongoose.Schema({
  expectedReturn:{type:Number,required:true,min:0,max:100},
  riskFit:{type:Number,required:true,min:0,max:100},
  liquidity:{type:Number,required:true,min:0,max:100},
  goalFit:{type:Number,required:true,min:0,max:100},
  horizonFit:{type:Number,required:true,min:0,max:100},
  cost:{type:Number,required:true,min:0,max:100},
},{_id:false,strict:'throw'});
const pickSchema = new mongoose.Schema({
  canonicalParentId:{type:String,required:true},
  name:{type:String,required:true},
  riskGroup:{type:String,required:true,enum:['LOW','MODERATE','AGGRESSIVE']},
  riskScore:{type:Number,required:true,min:1,max:5},
  suitabilityScope:{type:String,required:true,enum:['PROFILE_ELIGIBLE_PARENT_CATEGORY']},
  productSpecificSuitability:{type:String,required:true,enum:['NOT_ESTABLISHED']},
  shortlistSource:{type:String,required:true,
    enum:['CURRENT_SAVED_ALLOCATION','ADDITIONAL_PROFILE_ELIGIBLE_CANDIDATE']},
  rankScore:{type:Number,required:true,min:0,max:100},
  scoreFactors:{type:scoreFactorsSchema,required:true},
},{_id:false,strict:'throw'});
const schema = new mongoose.Schema({
  userId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
  profileId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
  recommendationId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
  allocationRevisionId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
  profileVersion:{type:Number,required:true,immutable:true},
  portfolioFingerprint:{type:String,required:true,immutable:true},
  shortlistPolicyVersion:{type:String,required:true,immutable:true,
    enum:[RISK_SHORTLIST_POLICY_VERSION]},
  selectionFingerprint:{type:String,required:true,immutable:true,match:/^[a-f0-9]{64}$/},
  groupedPicks:{type:[pickSchema],required:true,immutable:true},
  createdAt:{type:Date,default:Date.now,immutable:true},
},{versionKey:false,strict:'throw'});
schema.index({userId:1,profileId:1,recommendationId:1,allocationRevisionId:1},{unique:true});
schema.pre('validate',function(next){
  if(!this.isNew)return next(new Error('Shortlist snapshot is immutable'));
  const counts={LOW:0,MODERATE:0,AGGRESSIVE:0};
  const ids=new Set();
  for(const pick of this.groupedPicks){
    counts[pick.riskGroup]=(counts[pick.riskGroup]||0)+1;
    if(ids.has(pick.canonicalParentId))return next(new Error('Shortlist contains duplicate catalog IDs'));
    ids.add(pick.canonicalParentId);
    if(pick.riskGroup!==(pick.riskScore<=2?'LOW':pick.riskScore===3?'MODERATE':'AGGRESSIVE')){
      return next(new Error('Risk group must match authoritative risk score'));
    }
  }
  if(this.groupedPicks.length>15||Object.values(counts).some(n=>n>5)){
    return next(new Error('Maximum five eligible picks per risk group'));
  }
  next();
});
for(const op of ['updateOne','updateMany','findOneAndUpdate','replaceOne',
  'deleteOne','deleteMany','findOneAndDelete','bulkWrite']){
  schema.pre(op,function(next){next(new Error('Shortlist snapshots are append-only'));});
}
export default mongoose.model('RecommendationShortlist',schema);
