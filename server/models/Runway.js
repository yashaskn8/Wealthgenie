import mongoose from 'mongoose';

const { Schema } = mongoose;
const options = { strict: 'throw', versionKey: false, timestamps: true };

const stateSchema = new Schema({
  _id: { type: Schema.Types.ObjectId, required: true },
  revision: { type: Number, min: 1, required: true, validate: Number.isSafeInteger },
  // Serializes snapshot creation transactions so the per-owner hard cap cannot
  // be bypassed by concurrent requests reading the same count.
  snapshotGeneration: { type: Number, min: 0, default: 0, validate: Number.isSafeInteger },
}, options);

const ledgerRevisionSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  revision: { type: Number, required: true, min: 1, immutable: true, validate: Number.isSafeInteger },
  ledger: { type: Schema.Types.Mixed, required: true, immutable: true },
  inputHash: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  confirmedAt: { type: Date, required: true, immutable: true },
  sealVersion: { type: String, required: true, immutable: true, enum: ['HMAC_SHA256_V1'] },
  sealHmac: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
}, options);
ledgerRevisionSchema.index({ userId: 1, revision: 1 }, { unique: true, name: 'uniq_runway_ledger_revision' });

const receiptSchema = new Schema({
  _id: { type: String, required: true, immutable: true },
  userId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  operation: { type: String, enum: ['LEDGER'], required: true, immutable: true },
  requestHash: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  revision: { type: Number, min: 1, required: true, immutable: true },
}, options);

const snapshotSchema = new Schema({
  _id: { type: String, required: true, immutable: true },
  userId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  ledgerRevision: { type: Number, min: 1, required: true, immutable: true },
  inputHash: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  requestHash: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  request: { type: Schema.Types.Mixed, required: true, immutable: true },
  result: { type: Schema.Types.Mixed, required: true, immutable: true },
  resultHash: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  sealVersion: { type: String, required: true, immutable: true, enum: ['HMAC_SHA256_V1'] },
  sealHmac: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
}, options);
snapshotSchema.index({ userId: 1, createdAt: -1 }, { name: 'runway_snapshots_by_owner' });

const snapshotDeletionSchema = new Schema({
  // Retain a non-financial deletion marker until full account Runway erasure.
  // This prevents a delayed/retried Idempotency-Key from resurrecting a deleted result.
  _id: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  userId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  deletedAt: { type: Date, required: true, immutable: true },
  expiresAt: { type: Date, required: true, immutable: true },
}, options);
snapshotDeletionSchema.index({ expiresAt: 1 }, {
  name: 'runway_deleted_snapshot_ttl', expireAfterSeconds: 0,
});

// Retain only the owner ID and last erasure timestamp to prevent a stale
// authenticated initial-ledger request from resurrecting deleted financial data.
// This is non-financial deletion-control metadata, not a restored ledger.
const erasureFenceSchema = new Schema({
  _id: { type: Schema.Types.ObjectId, required: true },
  generation: { type: Number, min: 1, required: true, validate: Number.isSafeInteger },
  erasedAt: { type: Date, default: null },
}, options);
// Old sessions expire, and a deleted ledger's as-of date becomes stale.
// Seven days is therefore a conservative bounded fence-retention window.
erasureFenceSchema.index({ erasedAt: 1 }, {
  name: 'runway_erasure_fence_retention', expireAfterSeconds: 7 * 24 * 60 * 60,
});

export const RunwayErasureFence = mongoose.models.RunwayErasureFence
  || mongoose.model('RunwayErasureFence', erasureFenceSchema);

export const RunwayLedgerState = mongoose.models.RunwayLedgerState || mongoose.model('RunwayLedgerState', stateSchema);
export const RunwayLedgerRevision = mongoose.models.RunwayLedgerRevision || mongoose.model('RunwayLedgerRevision', ledgerRevisionSchema);
export const RunwayMutationReceipt = mongoose.models.RunwayMutationReceipt || mongoose.model('RunwayMutationReceipt', receiptSchema);
export const RunwaySnapshot = mongoose.models.RunwaySnapshot || mongoose.model('RunwaySnapshot', snapshotSchema);
export const RunwaySnapshotDeletion = mongoose.models.RunwaySnapshotDeletion || mongoose.model('RunwaySnapshotDeletion', snapshotDeletionSchema);
