import mongoose from 'mongoose';
const schema=new mongoose.Schema({
 userId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true,index:true},
 profileId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
 canonicalProductId:{type:String,required:true,immutable:true},
 clientMutationId:{type:String,required:true,immutable:true},
 quantityDecimal:{type:String,required:true,immutable:true},
 costBasisPaise:{type:String,required:true,immutable:true},
 acquisitionDate:{type:String,required:true,immutable:true},
 inputFingerprint:{type:String,required:true,immutable:true},
 evidenceClass:{type:String,enum:['USER_DECLARED'],required:true,immutable:true},
 createdAt:{type:Date,default:Date.now,immutable:true},
},{strict:'throw',versionKey:false});
schema.index({userId:1,clientMutationId:1},{unique:true});
schema.index({userId:1,profileId:1,createdAt:-1});
schema.pre('save',function(next){if(!this.isNew)return next(new Error('Holding lots are immutable'));next();});
for(const op of ['updateOne','updateMany','findOneAndUpdate','replaceOne','deleteOne','deleteMany','findOneAndDelete','bulkWrite']){
 schema.pre(op,function(next){next(new Error('Holding lots are append-only'));});
}
export default mongoose.model('InvestorHoldingLot',schema);
