import mongoose from 'mongoose';

const TYPES = ['SCENARIO_CREATED', 'SCENARIO_UPDATED', 'RUN_PUBLISHED', 'SCENARIO_DELETED'];

// Never store profile facts, monetary amounts, titles, access credentials or
// raw provider observations in the notification envelope.
const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  sequence: { type: Number, required: true, min: 1, immutable: true, validate: Number.isSafeInteger },
  type: { type: String, required: true, enum: TYPES, immutable: true },
  scenarioId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  scenarioRevision: { type: Number, required: true, min: 1, immutable: true },
  expiresAt: { type: Date, required: true, immutable: true },
}, { strict: 'throw', timestamps: { createdAt: true, updatedAt: false }, versionKey: false });

schema.index({ userId: 1, sequence: 1 }, { unique: true, name: 'uniq_decision_event_owner_order' });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'decision_event_expiration' });

export default mongoose.models.DecisionEvent || mongoose.model('DecisionEvent', schema);
