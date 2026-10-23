import mongoose from 'mongoose';

const coverageLedgerSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  revision: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  input: { type: mongoose.Schema.Types.Mixed, required: true },
}, { strict: 'throw', timestamps: true });

coverageLedgerSchema.index({ userId: 1 }, { unique: true, name: 'uniq_coverage_ledger_owner' });
export default mongoose.models.CoverageLedger || mongoose.model('CoverageLedger', coverageLedgerSchema);
