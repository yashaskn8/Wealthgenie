import mongoose from 'mongoose';
const taxContextSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref:'User', required:true, immutable:true, index:true },
  profileId: { type: mongoose.Schema.Types.ObjectId, ref:'FinancialProfile', required:true, immutable:true },
  profileVersion: { type:Number, required:true, min:1, immutable:true },
  version: { type:Number, required:true, min:1, immutable:true },
  fiscalYear: { type:String, required:true, immutable:true },
  userAge: { type:Number, required:true, min:18, max:120, immutable:true },
  annualGrossIncome: { type:Number, required:true, min:0, immutable:true },
  incomeSource: { type:String, enum:['salary','pension','family_pension','business','other'], required:true, immutable:true },
  regime: { type:String, enum:['old','new'], required:true, immutable:true },
  deductions: { type:mongoose.Schema.Types.Mixed, required:true, immutable:true },
  section112AExemptionUsed: { type:Number, min:0, default:null, immutable:true },
  inputFingerprint: { type:String, required:true, match:/^[a-f0-9]{64}$/, immutable:true },
  userDeclared: { type:Boolean, enum:[true], default:true, immutable:true },
  createdAt: { type:Date, default:Date.now, immutable:true },
}, {strict:'throw',versionKey:false});
taxContextSchema.index({userId:1,profileId:1,version:-1},{unique:true});
taxContextSchema.pre('save',function(next) {
  if(!this.isNew) return next(new Error('Tax contexts are immutable.'));
  next();
});
for(const action of ['updateOne','updateMany','findOneAndUpdate','replaceOne','deleteOne','deleteMany','findOneAndDelete','bulkWrite']) {
  taxContextSchema.pre(action,function(next){ next(new Error('Tax contexts are append-only.')); });
}
export default mongoose.model('InvestorTaxContext',taxContextSchema);
