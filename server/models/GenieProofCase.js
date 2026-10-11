import mongoose from 'mongoose';

const confirmedClaimSchema = new mongoose.Schema({
  claimId: { type: String, required: true, match: /^[a-f0-9]{32}$/ },
  statement: { type: String, required: true, minlength: 1, maxlength: 500 },
  claimType: { type: String, enum: ['CURRENT_NOMINAL_RATE', 'UNSUPPORTED'], required: true },
  productId: { type: String, default: null, maxlength: 128 },
  value: { type: Number, default: null, min: 0, validate: value => value == null || Number.isFinite(value) },
  unit: { type: String, enum: ['PERCENT_PER_ANNUM', 'UNKNOWN'], required: true },
}, { _id: false, strict: 'throw' });

const genieProofCaseSchema = new mongoose.Schema({
  caseId: { type: String, required: true, match: /^[0-9a-f-]{36}$/i, immutable: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  // Optional only for legacy records. New cases are assigned a unique per-user slot.
  quotaSlot: { type: Number, min: 0, max: 24, validate: Number.isInteger, immutable: true },
  submissionHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  requestHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  idempotencyKeyHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  confirmedClaims: { type: [confirmedClaimSchema], required: true, validate: claims => claims.length > 0 && claims.length <= 10, immutable: true },
  savingConsentVersion: { type: String, required: true, enum: ['genieproof-private-save/1'], immutable: true },
  savingConsentAt: { type: Date, required: true, immutable: true },
  consentWithdrawnAt: { type: Date, default: null },
  consentGeneration: { type: Number, min: 0, default: 0, validate: Number.isInteger },
  latestRevision: { type: Number, required: true, min: 1, default: 1 },
  latestManifestHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  expiresAt: { type: Date, required: true, immutable: true },
  deletedAt: { type: Date, default: null },
}, { strict: 'throw', timestamps: true });

genieProofCaseSchema.index({ userId: 1, caseId: 1 }, { unique: true, name: 'uniq_genieproof_owner_case' });
genieProofCaseSchema.index({ userId: 1, idempotencyKeyHash: 1 }, { unique: true, name: 'uniq_genieproof_owner_idempotency' });
genieProofCaseSchema.index({ userId: 1, createdAt: -1 }, { name: 'genieproof_owner_created' });
genieProofCaseSchema.index(
  { userId: 1, quotaSlot: 1 },
  {
    unique: true,
    name: 'uniq_genieproof_owner_quota_slot',
    partialFilterExpression: { quotaSlot: { $type: 'number' } },
  },
);
genieProofCaseSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'genieproof_case_expiry' });

export default mongoose.models.GenieProofCase || mongoose.model('GenieProofCase', genieProofCaseSchema);
