import mongoose from 'mongoose';

const proofBreakJobSchema = new mongoose.Schema({
  jobId: { type: String, required: true, match: /^[0-9a-f-]{36}$/i, immutable: true },
  watchId: { type: String, required: true, match: /^[0-9a-f-]{36}$/i, immutable: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  caseId: { type: String, required: true, match: /^[0-9a-f-]{36}$/i, immutable: true },
  scheduleKey: { type: String, required: true, maxlength: 80, immutable: true },
  watchGeneration: { type: Number, required: true, min: 1, validate: Number.isInteger, immutable: true },
  status: { type: String, required: true, enum: ['QUEUED', 'LEASED', 'COMPLETED', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'CANCELLED'] },
  scheduledAt: { type: Date, required: true },
  attempt: { type: Number, default: 0, min: 0, validate: Number.isInteger },
  maxAttempts: { type: Number, default: 4, min: 1, max: 8, validate: Number.isInteger, immutable: true },
  leaseOwner: { type: String, default: null, maxlength: 120 },
  leaseUntil: { type: Date, default: null },
  heartbeatAt: { type: Date, default: null },
  executionGeneration: { type: Number, default: 0, min: 0, validate: Number.isInteger },
  failureCode: { type: String, default: null, maxlength: 120 },
  expiresAt: { type: Date, required: true, immutable: true },
}, { strict: 'throw', timestamps: true, versionKey: false });

proofBreakJobSchema.index({ jobId: 1 }, { unique: true, name: 'uniq_proofbreak_job_id' });
proofBreakJobSchema.index({ watchId: 1, scheduleKey: 1 }, { unique: true, name: 'uniq_proofbreak_watch_schedule' });
proofBreakJobSchema.index({ status: 1, scheduledAt: 1, leaseUntil: 1 }, { name: 'proofbreak_job_claim' });
proofBreakJobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'proofbreak_job_retention_ttl' });

export default mongoose.models.ProofBreakJob || mongoose.model('ProofBreakJob', proofBreakJobSchema);
