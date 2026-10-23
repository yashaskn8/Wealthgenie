import mongoose from 'mongoose';

// Explicit user attestation; a CSV suggestion is NOT evidence of bank settlement.
// Immutable settlement revisions permit an audit while preserving data deletion.
const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  ledgerRevision: { type: Number, required: true, min: 2, immutable: true },
  priorRevision: { type: Number, required: true, min: 1, immutable: true },
  entryId: { type: String, required: true, immutable: true, match: /^[A-Za-z0-9_-]{1,64}$/ },
  entryType: { type: String, required: true, immutable: true,
    enum: ['ESSENTIAL_PAYMENT', 'CONTRACTUAL_PAYMENT', 'VOLUNTARY_CONTRIBUTION', 'OTHER_PAYMENT'] },
  amountPaise: { type: Number, required: true, immutable: true, min: 1, validate: Number.isSafeInteger },
  declaredAsOfDate: { type: String, required: true, immutable: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  provenance: { type: String, required: true, immutable: true, enum: ['USER_CONFIRMED_NOT_BANK_VERIFIED'] },
}, { strict: 'throw', timestamps: { createdAt: true, updatedAt: false } });
schema.index({ userId: 1, ledgerRevision: 1 }, { unique: true, name: 'uniq_cash_settlement_owner_revision' });
schema.index({ userId: 1, createdAt: -1 }, { name: 'cash_settlement_owner_history' });
export default mongoose.models.CoverageSettlement || mongoose.model('CoverageSettlement', schema);
