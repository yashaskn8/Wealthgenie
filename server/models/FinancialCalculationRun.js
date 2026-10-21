import mongoose from 'mongoose';
const schema=new mongoose.Schema({
 userId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true,index:true},
 profileId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
 profileVersion:{type:Number,required:true,immutable:true},
 taxContextId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
 taxContextVersion:{type:Number,required:true,immutable:true},
 kind:{type:String,enum:['USER_DECLARED_EQUITY_LUMP_SUM'],required:true,immutable:true},
 inputFingerprint:{type:String,required:true,match:/^[a-f0-9]{64}$/,immutable:true},
 result:{type:mongoose.Schema.Types.Mixed,required:true,immutable:true},
 createdAt:{type:Date,default:Date.now,immutable:true},
},{strict:'throw',versionKey:false});
schema.index({userId:1,profileId:1,createdAt:-1});
schema.pre('save',function(next){if(!this.isNew)return next(new Error('Financial calculation history is immutable'));next();});
for(const op of ['updateOne','updateMany','findOneAndUpdate','replaceOne','deleteOne','deleteMany','findOneAndDelete','bulkWrite']){
 schema.pre(op,function(next){next(new Error('Financial calculation history is append-only'));});
}
export default mongoose.model('FinancialCalculationRun',schema);
