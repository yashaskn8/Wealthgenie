import mongoose from 'mongoose';
const { Schema } = mongoose;
const opts = { strict: 'throw', versionKey: false, timestamps: true };

const statementSchema = new Schema({
  _id: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  userId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  statement: { type: Schema.Types.Mixed, required: true, immutable: true },
  evidenceHash: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  importedAt: { type: Date, required: true, immutable: true },
  sealVersion: { type: String, required: true, immutable: true, enum: ['HMAC_SHA256_V1'] },
  sealHmac: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
}, opts);
statementSchema.index({ userId: 1, importedAt: -1 }, { name: 'runway_statement_owner_newest' });

const signalSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  eventType: { type: String, enum: ['LEDGER_UPDATED', 'STATEMENT_IMPORTED', 'STATEMENT_DELETED', 'SETTLEMENT_CONFIRMED'], required: true, immutable: true },
  occurredAt: { type: Date, required: true, immutable: true },
  expiresAt: { type: Date, required: true, immutable: true },
}, { strict: 'throw', versionKey: false, timestamps: true });
signalSchema.index({ userId: 1, _id: 1 }, { name: 'runway_signal_owner_cursor' });
signalSchema.index({ expiresAt: 1 }, { name: 'runway_signal_ttl', expireAfterSeconds: 0 });

export const RunwayStatement = mongoose.models.RunwayStatement || mongoose.model('RunwayStatement', statementSchema);
export const RunwaySignal = mongoose.models.RunwaySignal || mongoose.model('RunwaySignal', signalSchema);

/**
 * Immutable receipt for one user-confirmed forecast settlement.
 * Raw bank references/descriptions are NOT copied to this record.
 */
const settlementSchema = new Schema({
  _id: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  userId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  requestHash: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  ledgerRevision: { type: Number, required: true, immutable: true, min: 1 },
  resultRevision: { type: Number, required: true, immutable: true, min: 2 },
  priorInputHash: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  nextInputHash: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  statementId: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  rowIndex: { type: Number, required: true, immutable: true, min: 0 },
  entryId: { type: String, required: true, immutable: true },
  rowHash: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  confirmedCashPaise: { type: String, required: true, immutable: true },
  decidedAt: { type: Date, required: true, immutable: true },
  sealVersion: { type: String, required: true, immutable: true, enum: ['HMAC_SHA256_V1'] },
  sealHmac: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
}, opts);
settlementSchema.index({ userId: 1, decidedAt: -1 }, { name: 'runway_settlement_owner_audit' });
// Exactly one approved forecast adjustment per imported posted transaction row.
settlementSchema.index({ userId: 1, statementId: 1, rowIndex: 1 }, {
  name: 'uniq_runway_settled_source_row', unique: true,
});
export const RunwaySettlement = mongoose.models.RunwaySettlement || mongoose.model('RunwaySettlement', settlementSchema);
