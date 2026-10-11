import mongoose from 'mongoose';

export const PROOF_WATCH_STATES = Object.freeze([
  'ACTIVE',
  'PAUSED',
  'WAITING_FOR_SOURCE',
  'BLOCKED_SOURCE_RIGHTS',
  'FAILED_RETRYABLE',
  'FAILED_TERMINAL',
  'EXPIRED',
  'CANCELLED',
]);

const proofWatchSchema = new mongoose.Schema({
  watchId: { type: String, required: true, match: /^[0-9a-f-]{36}$/i, immutable: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  caseId: { type: String, required: true, match: /^[0-9a-f-]{36}$/i, immutable: true },
  creationKeyHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  requestHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  status: { type: String, required: true, enum: PROOF_WATCH_STATES },
  consentVersion: { type: String, required: true, enum: ['genieproof-proofbreak-watch/1'], immutable: true },
  consentAt: { type: Date, required: true, immutable: true },
  consentWithdrawnAt: { type: Date, default: null },
  generation: { type: Number, default: 1, min: 1, validate: Number.isInteger },
  requestedClaimIds: { type: [String], required: true, validate: values => values.length > 0 && values.length <= 10, immutable: true },
  sourceAvailability: {
    type: String,
    required: true,
    enum: ['AVAILABLE', 'WAITING', 'RIGHTS_BLOCKED', 'TECHNICALLY_BLOCKED'],
  },
  monitoredSourceIds: { type: [String], default: [], validate: values => values.length <= 10 },
  lastSuccessfulCheckAt: { type: Date, default: null },
  nextCheckAt: { type: Date, default: null },
  lastFailureCode: { type: String, default: null, maxlength: 120 },
  expiresAt: { type: Date, required: true, immutable: true },
}, { strict: 'throw', timestamps: true, versionKey: false });

proofWatchSchema.index({ watchId: 1 }, { unique: true, name: 'uniq_proof_watch_id' });
proofWatchSchema.index({ userId: 1, creationKeyHash: 1 }, { unique: true, name: 'uniq_proof_watch_idempotency' });
proofWatchSchema.index({ userId: 1, caseId: 1 }, {
  unique: true,
  partialFilterExpression: { status: { $in: ['ACTIVE', 'PAUSED', 'WAITING_FOR_SOURCE', 'BLOCKED_SOURCE_RIGHTS', 'FAILED_RETRYABLE', 'FAILED_TERMINAL'] } },
  name: 'uniq_active_proof_watch_case_owner',
});
proofWatchSchema.index({ status: 1, nextCheckAt: 1, _id: 1 }, { name: 'proof_watch_due_scan' });
proofWatchSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'proof_watch_retention_ttl' });

export default mongoose.models.ProofWatch || mongoose.model('ProofWatch', proofWatchSchema);
