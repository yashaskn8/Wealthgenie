import mongoose from 'mongoose';

const coverageResultSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  ledgerRevision: { type: Number, required: true, min: 1, immutable: true, validate: Number.isSafeInteger },
  policyVersion: { type: String, required: true, immutable: true },
  inputHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  input: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  calculation: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
}, { strict: 'throw', timestamps: { createdAt: true, updatedAt: false } });

coverageResultSchema.index(
  { userId: 1, ledgerRevision: 1, policyVersion: 1 },
  { unique: true, name: 'uniq_coverage_owner_revision_policy' },
);
export default mongoose.models.CoverageResult || mongoose.model('CoverageResult', coverageResultSchema);
