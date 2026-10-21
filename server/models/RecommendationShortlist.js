import mongoose from 'mongoose';
const pickSchema=new mongoose.Schema({
  canonicalParentId:{type:String,required:true},
  name:{type:String,required:true},
  riskGroup:{type:String,required:true,enum:['LOW','MODERATE','AGGRESSIVE']},
  riskScore:{type:Number,required:true,min:1,max:5},
  suitabilityScope:{type:String,required:true,enum:['SAVED_PARENT_CATEGORY']},
  productSpecificSuitability:{type:String,required:true,enum:['NOT_ESTABLISHED']},
},{_id:false,strict:'throw'});
const schema=new mongoose.Schema({
  userId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
  profileId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
  recommendationId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
  allocationRevisionId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
  profileVersion:{type:Number,required:true,immutable:true},
  portfolioFingerprint:{type:String,required:true,immutable:true},
  groupedPicks:{type:[pickSchema],required:true,immutable:true},
  createdAt:{type:Date,default:Date.now,immutable:true},
},{versionKey:false,strict:'throw'});
schema.index({userId:1,profileId:1,recommendationId:1,allocationRevisionId:1},{unique:true});
schema.pre('validate',function(next){
  if(!this.isNew)return next(new Error('Shortlist snapshot is immutable'));
  const counts={LOW:0,MODERATE:0,AGGRESSIVE:0};
  for(const pick of this.groupedPicks){counts[pick.riskGroup]=(counts[pick.riskGroup]||0)+1;}
  if(this.groupedPicks.length>15 || Object.values(counts).some(n=>n>5))return next(new Error('Maximum five picks per risk group'));
  next();
});
for(const op of ['updateOne','updateMany','findOneAndUpdate','replaceOne','deleteOne','deleteMany','findOneAndDelete','bulkWrite']){
  schema.pre(op,function(next){next(new Error('Shortlist snapshots are append-only'));});
}
export default mongoose.model('RecommendationShortlist',schema);
