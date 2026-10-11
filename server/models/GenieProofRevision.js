import mongoose from 'mongoose';

const signatureSchema = new mongoose.Schema({
  algorithm: { type: String, enum: ['Ed25519'], required: true, immutable: true },
  keyId: { type: String, required: true, maxlength: 120, immutable: true },
  publicKeyFingerprint: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  value: { type: String, required: true, maxlength: 256, immutable: true },
}, { _id: false, strict: 'throw', versionKey: false });

const genieProofRevisionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  caseId: { type: String, required: true, match: /^[0-9a-f-]{36}$/i, immutable: true },
  revision: { type: Number, required: true, min: 1, immutable: true },
  manifest: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  manifestHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  signature: { type: signatureSchema, required: true, immutable: true },
  assessedAt: { type: Date, required: true, immutable: true },
}, { strict: 'throw', timestamps: { createdAt: true, updatedAt: false } });

genieProofRevisionSchema.index(
  { userId: 1, caseId: 1, revision: 1 },
  { unique: true, name: 'uniq_genieproof_revision' },
);
genieProofRevisionSchema.index({ userId: 1, caseId: 1, createdAt: -1 }, { name: 'genieproof_case_revision_history' });

export default mongoose.models.GenieProofRevision || mongoose.model('GenieProofRevision', genieProofRevisionSchema);
