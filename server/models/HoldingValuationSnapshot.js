import mongoose from 'mongoose';
const schema=new mongoose.Schema({
 userId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true,index:true},
 profileId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
 holdingLotId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
 canonicalProductId:{type:String,required:true,immutable:true},
 observationId:{type:String,required:true,immutable:true},
 observationKind:{type:String,enum:['PRICE','NAV'],required:true,immutable:true},
 sourceId:{type:String,required:true,immutable:true},
 dataClass:{type:String,required:true,immutable:true},
 observedAt:{type:Date,required:true,immutable:true},
 result:{type:mongoose.Schema.Types.Mixed,required:true,immutable:true},
 createdAt:{type:Date,default:Date.now,immutable:true},
},{strict:'throw',versionKey:false});
schema.index({userId:1,holdingLotId:1,observationId:1},{unique:true});
schema.pre('save',function(next){if(!this.isNew)return next(new Error('Valuation snapshots are immutable'));next();});
for(const op of ['updateOne','updateMany','findOneAndUpdate','replaceOne','deleteOne','deleteMany','findOneAndDelete','bulkWrite']){
 schema.pre(op,function(next){next(new Error('Valuation snapshots are append-only'));});
}
export default mongoose.model('HoldingValuationSnapshot',schema);
