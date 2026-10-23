import mongoose from 'mongoose';
import { protectImmutableIdentity } from './immutableIdentity.js';

const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  scenarioId: { type: mongoose.Schema.Types.ObjectId, ref: 'DecisionScenario', required: true, immutable: true },
  revision: { type: Number, required: true, min: 1, immutable: true },
  profileId: { type: mongoose.Schema.Types.ObjectId, ref: 'FinancialProfile', required: true, immutable: true },
  profileStateRevision: { type: Number, required: true, min: 1, immutable: true },
  profileVersion: { type: Number, required: true, min: 1, immutable: true },
  profileFinancialFence: { type: Number, required: true, min: 0, immutable: true },
  runKeyHash: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  inputHash: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  result: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false }, strict: 'throw' });

schema.index({ userId: 1, runKeyHash: 1 }, { unique: true, name: 'uniq_decision_run_key' });
schema.index({ userId: 1, scenarioId: 1, createdAt: -1 }, { name: 'decision_run_owner_history' });
protectImmutableIdentity(schema, [
  'userId', 'scenarioId', 'revision', 'profileId', 'runKeyHash', 'inputHash', 'result',
], { code: 'DECISION_REPORT_IMMUTABLE', label: 'GenieDecision report' });
export default mongoose.models.DecisionRun || mongoose.model('DecisionRun', schema);
