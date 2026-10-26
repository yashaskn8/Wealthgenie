import mongoose from 'mongoose';

const coverageLedgerSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  revision: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  input: { type: mongoose.Schema.Types.Mixed, default: null },
  // A non-sensitive tombstone retains monotonic revision fencing after deletion.
  deletedAt: { type: Date, default: null },
}, { strict: 'throw', timestamps: true });

coverageLedgerSchema.index({ userId: 1 }, { unique: true, name: 'uniq_coverage_ledger_owner' });
coverageLedgerSchema.index({ 'input.asOfDate': 1, _id: 1 },
  { name: 'cash_staleness_batch_scan' });
export default mongoose.models.CoverageLedger || mongoose.model('CoverageLedger', coverageLedgerSchema);
