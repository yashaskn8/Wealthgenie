import mongoose from 'mongoose';
import { protectImmutableIdentity } from './immutableIdentity.js';

/** Durable mutation operation log. Redis is deliberately not authoritative here. */
const idempotencyKeySchema = new mongoose.Schema({
  _id: { type: String, required: true }, // SHA-256 of operation + owner + caller key
  status: { type: String, enum: ['LOCK', 'DONE'], default: 'LOCK' },
  operation: { type: String, required: true, immutable: true },
  method: { type: String, required: true, immutable: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  profileId: { type: mongoose.Schema.Types.ObjectId, ref: 'FinancialProfile', default: null },
  requestHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  lockOwnerId: { type: String, default: null },
  leaseExpiresAt: { type: Date, default: null },
  resourceType: { type: String, enum: ['FinancialProfile', 'Goal', 'CoverageResult', 'CoverageDeletionReceipt', null], default: null },
  resourceId: { type: mongoose.Schema.Types.ObjectId, default: null },
  response: { type: mongoose.Schema.Types.Mixed, default: null },
  responseStatus: { type: Number, min: 200, max: 299, default: null },
  committedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
}, { strict: 'throw' });

protectImmutableIdentity(idempotencyKeySchema, ['operation', 'method', 'userId', 'requestHash'], {
  code: 'IDEMPOTENCY_IDENTITY_IMMUTABLE',
  label: 'Idempotency operation identity',
});

// No TTL: deleting a completed operation record would make an old retry capable
// of creating a second durable resource. Retention is an explicit data policy.

export default mongoose.model('IdempotencyKey', idempotencyKeySchema);
