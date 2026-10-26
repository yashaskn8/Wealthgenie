import mongoose from 'mongoose';

// Only a minimal deletion receipt is retained to make retries safe. Never store
// balances, schedules, labels, or scenarios here.
const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  idempotencyOperationId: { type: String, required: true, immutable: true },
  deletedRevision: { type: Number, required: true, min: 1, immutable: true },
  nextRevision: { type: Number, required: true, min: 2, immutable: true },
  deletedAt: { type: Date, required: true, immutable: true },
}, { strict: 'throw', timestamps: false });
schema.index({ userId: 1, idempotencyOperationId: 1 }, {
  unique: true, name: 'uniq_coverage_deletion_owner_operation',
});
export default mongoose.models.CoverageDeletionReceipt
  || mongoose.model('CoverageDeletionReceipt', schema);
