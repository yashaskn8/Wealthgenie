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
  eventType: { type: String, enum: ['LEDGER_UPDATED', 'STATEMENT_IMPORTED', 'STATEMENT_DELETED'], required: true, immutable: true },
  occurredAt: { type: Date, required: true, immutable: true },
  expiresAt: { type: Date, required: true, immutable: true },
}, { strict: 'throw', versionKey: false, timestamps: true });
signalSchema.index({ userId: 1, _id: 1 }, { name: 'runway_signal_owner_cursor' });
signalSchema.index({ expiresAt: 1 }, { name: 'runway_signal_ttl', expireAfterSeconds: 0 });

export const RunwayStatement = mongoose.models.RunwayStatement || mongoose.model('RunwayStatement', statementSchema);
export const RunwaySignal = mongoose.models.RunwaySignal || mongoose.model('RunwaySignal', signalSchema);
