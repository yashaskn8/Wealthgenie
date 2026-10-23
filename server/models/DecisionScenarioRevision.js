import mongoose from 'mongoose';
import { protectImmutableIdentity } from './immutableIdentity.js';

const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  scenarioId: { type: mongoose.Schema.Types.ObjectId, ref: 'DecisionScenario', required: true, immutable: true },
  revision: { type: Number, min: 1, required: true, immutable: true },
  payload: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  inputHash: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  integrityKeyId: { type: String, required: true, immutable: true, match: /^[A-Za-z0-9_-]{1,32}$/ },
  integrityTag: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
}, { timestamps: { createdAt: true, updatedAt: false }, strict: 'throw' });

schema.index({ userId: 1, scenarioId: 1, revision: 1 },
  { unique: true, name: 'uniq_decision_revision_owner_sequence' });
protectImmutableIdentity(schema, ['userId', 'scenarioId', 'revision', 'payload', 'inputHash', 'integrityKeyId', 'integrityTag'], {
  code: 'DECISION_REVISION_IMMUTABLE', label: 'GenieDecision scenario revision',
});
export default mongoose.models.DecisionScenarioRevision || mongoose.model('DecisionScenarioRevision', schema);
