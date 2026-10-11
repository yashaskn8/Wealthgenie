import mongoose from 'mongoose';

export const PROOF_BREAK_EVENT_TYPES = Object.freeze([
  'EVIDENCE_CHANGED',
  'EVIDENCE_EXPIRED',
  'FINDING_CHANGED',
  'CONDITIONS_CHANGED',
  'SOURCE_UNAVAILABLE',
  'PROCESSING_FAILED',
  'POLICY_REVIEW_REQUIRED',
  'RECHECK_UNCHANGED',
]);

const effectivePeriodSchema = new mongoose.Schema({
  previousEffectiveFrom: { type: Date, default: null },
  previousEffectiveTo: { type: Date, default: null },
  currentEffectiveFrom: { type: Date, default: null },
  currentEffectiveTo: { type: Date, default: null },
}, { _id: false, strict: 'throw' });

const proofBreakEventSchema = new mongoose.Schema({
  eventId: { type: String, required: true, match: /^[0-9a-f-]{36}$/i, immutable: true },
  deduplicationKey: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  caseId: { type: String, required: true, match: /^[0-9a-f-]{36}$/i, immutable: true },
  watchId: { type: String, required: true, match: /^[0-9a-f-]{36}$/i, immutable: true },
  claimId: { type: String, required: true, match: /^[a-f0-9]{32}$/, immutable: true },
  previousAssessmentId: { type: String, required: true, maxlength: 200, immutable: true },
  newAssessmentId: { type: String, default: null, maxlength: 200, immutable: true },
  previousEvidenceRevision: { type: String, default: null, maxlength: 240, immutable: true },
  newEvidenceRevision: { type: String, default: null, maxlength: 240, immutable: true },
  retrievalReceiptIds: {
    type: [String],
    default: [],
    validate: values => values.length <= 40 && values.every(value => /^[0-9a-f-]{36}$/i.test(value)),
    immutable: true,
  },
  changedFactFields: { type: [String], default: [], validate: values => values.length <= 30, immutable: true },
  effectivePeriodImplications: { type: effectivePeriodSchema, default: () => ({}) , immutable: true },
  eventType: { type: String, required: true, enum: PROOF_BREAK_EVENT_TYPES, immutable: true },
  detectedAt: { type: Date, required: true, immutable: true },
  publishedAt: { type: Date, required: true, immutable: true },
  notificationStatus: { type: String, required: true, enum: ['PENDING', 'DELIVERED', 'NOT_REQUIRED', 'FAILED', 'CANCELLED'] },
  acknowledgedAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true, immutable: true },
}, { strict: 'throw', timestamps: { createdAt: true, updatedAt: false }, versionKey: false });

proofBreakEventSchema.index({ eventId: 1 }, { unique: true, name: 'uniq_proofbreak_event_id' });
proofBreakEventSchema.index({ deduplicationKey: 1 }, { unique: true, name: 'uniq_proofbreak_event_dedupe' });
proofBreakEventSchema.index({ userId: 1, caseId: 1, publishedAt: -1, _id: -1 }, { name: 'proofbreak_user_timeline' });
proofBreakEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'proofbreak_event_retention_ttl' });

export default mongoose.models.ProofBreakEvent || mongoose.model('ProofBreakEvent', proofBreakEventSchema);
