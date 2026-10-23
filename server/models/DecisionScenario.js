import mongoose from 'mongoose';
import { protectImmutableIdentity } from './immutableIdentity.js';

const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  profileId: { type: mongoose.Schema.Types.ObjectId, ref: 'FinancialProfile', required: true, immutable: true },
  profileStateRevision: { type: Number, required: true, min: 1, immutable: true },
  profileVersion: { type: Number, required: true, min: 1, immutable: true },
  profileFinancialFence: { type: Number, required: true, min: 0, immutable: true },
  profileFactsHash: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  scenarioType: { type: String, required: true,
    enum: ['HOUSE_VS_RENT', 'MAJOR_EXPENSE', 'INCOME_INTERRUPTION', 'DEBT_VS_INVEST'], immutable: true },
  quotaSlot: { type: Number, required: true, immutable: true, min: 0, max: 49 },
  revision: { type: Number, default: 1, min: 1, required: true },
  lastRunId: { type: mongoose.Schema.Types.ObjectId, ref: 'DecisionRun', default: null },
  runGeneration: { type: Number, default: 0, min: 0 },
  title: { type: String, required: true, maxlength: 100 },
  createKeyHash: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  createPayloadHash: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
}, { timestamps: true, strict: 'throw' });

schema.index({ userId: 1, createKeyHash: 1 }, { unique: true, name: 'uniq_decision_create_key' });
schema.index({ userId: 1, quotaSlot: 1 }, { unique: true, name: 'uniq_decision_owner_quota_slot' });
schema.index({ userId: 1, createdAt: -1 }, { name: 'decision_owner_history' });
protectImmutableIdentity(schema, ['userId', 'profileId', 'scenarioType', 'createKeyHash', 'createPayloadHash', 'quotaSlot', 'profileFactsHash'], {
  code: 'DECISION_SCENARIO_IDENTITY_IMMUTABLE', label: 'GenieDecision scenario identity',
});
export default mongoose.models.DecisionScenario || mongoose.model('DecisionScenario', schema);
