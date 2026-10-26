import mongoose from 'mongoose';

// Atomic per-owner sequence allocator. All increments happen inside the same
// transaction as the decision mutation and its durable event.
const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  sequence: { type: Number, required: true, default: 0, min: 0, validate: Number.isSafeInteger },
}, { strict: 'throw', versionKey: false });

schema.index({ userId: 1 }, { unique: true, name: 'uniq_decision_event_owner_sequence' });

export default mongoose.models.DecisionEventState || mongoose.model('DecisionEventState', schema);
