import mongoose from 'mongoose';

// Durable in-app financial event; no bank account numbers, raw CSV narrations,
// email addresses, external notification payloads, or payment credentials.
const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  eventKey: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  kind: { type: String, required: true, immutable: true,
    enum: ['SHORTFALL_DETECTED', 'SHORTFALL_CHANGED', 'SHORTFALL_RESOLVED', 'CASH_RECONFIRMATION_REQUIRED'] },
  ledgerRevision: { type: Number, required: true, immutable: true, min: 1 },
  sourceAsOfDate: { type: String, required: true, immutable: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  dueDate: { type: String, default: null, immutable: true,
    validate: value => value === null || /^\d{4}-\d{2}-\d{2}$/.test(value) },
  state: { type: String, enum: ['UNREAD', 'ACKNOWLEDGED', 'SUPERSEDED'], default: 'UNREAD' },
  acknowledgedAt: { type: Date, default: null },
}, { strict: 'throw', timestamps: { createdAt: true, updatedAt: false } });
schema.index({ userId: 1, eventKey: 1 }, { unique: true, name: 'uniq_cash_alert_owner_event' });
schema.index({ userId: 1, createdAt: -1 }, { name: 'cash_alert_owner_history' });

export default mongoose.models.CoverageRiskAlert || mongoose.model('CoverageRiskAlert', schema);
