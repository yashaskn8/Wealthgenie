import mongoose from 'mongoose';

const proofNotificationOutboxSchema = new mongoose.Schema({
  outboxId: { type: String, required: true, match: /^[0-9a-f-]{36}$/i, immutable: true },
  eventId: { type: String, required: true, match: /^[0-9a-f-]{36}$/i, immutable: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  caseId: { type: String, required: true, match: /^[0-9a-f-]{36}$/i, immutable: true },
  watchId: { type: String, required: true, match: /^[0-9a-f-]{36}$/i, immutable: true },
  status: { type: String, required: true, enum: ['PENDING', 'LEASED', 'DELIVERED', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'CANCELLED'] },
  attempt: { type: Number, default: 0, min: 0, validate: Number.isInteger },
  nextAttemptAt: { type: Date, required: true },
  leaseOwner: { type: String, default: null, maxlength: 120 },
  leaseUntil: { type: Date, default: null },
  executionGeneration: { type: Number, default: 0, min: 0, validate: Number.isInteger },
  deliveredAt: { type: Date, default: null },
  failureCode: { type: String, default: null, maxlength: 120 },
  expiresAt: { type: Date, required: true, immutable: true },
}, { strict: 'throw', timestamps: true, versionKey: false });

proofNotificationOutboxSchema.index({ outboxId: 1 }, { unique: true, name: 'uniq_proof_notification_outbox_id' });
proofNotificationOutboxSchema.index({ eventId: 1 }, { unique: true, name: 'uniq_proof_notification_event' });
proofNotificationOutboxSchema.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1 }, { name: 'proof_notification_outbox_claim' });
proofNotificationOutboxSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'proof_notification_outbox_ttl' });

export default mongoose.models.ProofNotificationOutbox
  || mongoose.model('ProofNotificationOutbox', proofNotificationOutboxSchema);
