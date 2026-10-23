/**
 * Append-once Runway projection requests and versioned, tamper-evident results.
 * Jobs are written inside the same Mongo transaction as a ledger revision.
 * The worker is independently controlled by RUNWAY_PROJECTION_WORKER_ENABLED.
 */
import mongoose from 'mongoose';
const { Schema } = mongoose;
const opts = { strict: 'throw', versionKey: false, timestamps: true };
const projectionJobSchema = new Schema({
  _id: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  userId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  revision: { type: Number, required: true, immutable: true, min: 1 },
  inputHash: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  status: { type: String, enum: ['PENDING', 'LEASED', 'DONE', 'BLOCKED'], required: true },
  availableAt: { type: Date, required: true },
  leaseUntil: { type: Date, default: null },
  leaseToken: { type: String, default: null },
  attempts: { type: Number, min: 0, max: 8, default: 0 },
  lastErrorCode: { type: String, default: null },
}, opts);
projectionJobSchema.index({ status: 1, availableAt: 1, _id: 1 },
  { name: 'runway_projection_queue_claim' });
projectionJobSchema.index({ userId: 1, revision: 1 },
  { name: 'uniq_runway_projection_job_revision', unique: true });

const resultSchema = new Schema({
  _id: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  userId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  revision: { type: Number, required: true, immutable: true, min: 1 },
  inputHash: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  engineVersion: { type: String, required: true, immutable: true },
  resultHash: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  result: { type: Schema.Types.Mixed, required: true, immutable: true },
  computedAt: { type: Date, required: true, immutable: true },
  sealHmac: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
}, opts);
resultSchema.index({ userId: 1, revision: -1 },
  { name: 'runway_projection_owner_revision' });
export const RunwayProjectionJob = mongoose.models.RunwayProjectionJob
  || mongoose.model('RunwayProjectionJob', projectionJobSchema);
export const RunwayProjectionResult = mongoose.models.RunwayProjectionResult
  || mongoose.model('RunwayProjectionResult', resultSchema);
