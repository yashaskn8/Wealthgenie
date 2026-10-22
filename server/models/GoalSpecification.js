import mongoose from 'mongoose';

export const GOAL_SPEC_KINDS = Object.freeze([
  'vehicle', 'home', 'education', 'retirement', 'emergency', 'debt_repayment',
  'wedding', 'travel', 'gold_education', 'general',
]);

const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, immutable: true, required: true, ref: 'User' },
  creationKey: { type: String, required: true, immutable: true, minlength: 16, maxlength: 128 },
  creationRequestHash: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  version: { type: Number, default: 1, required: true, min: 1 },
  kind: { type: String, required: true, enum: GOAL_SPEC_KINDS },
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
  targetAmount: { type: Number, required: true, min: 1000, max: 1_000_000_000 },
  currentSavings: { type: Number, required: true, min: 0, max: 1_000_000_000 },
  targetDate: { type: Date, required: true },
  priority: { type: String, enum: ['Critical', 'High', 'Medium', 'Low'], default: 'Medium' },
  annualPriceInflationPct: { type: Number, min: 0, max: 30, required: true, default: 0 },
  notes: { type: String, maxlength: 800, default: '' },
}, { timestamps: true, strict: 'throw', optimisticConcurrency: true });

schema.index({ userId: 1, targetDate: 1 });
schema.index({ userId: 1, creationKey: 1 }, { unique: true, name: 'goal_spec_owner_create_key_unique' });
export default mongoose.model('GoalSpecification', schema);
