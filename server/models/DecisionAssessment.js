import mongoose from 'mongoose';
import { protectImmutableIdentity } from './immutableIdentity.js';

const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  scenarioId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  scenarioRevision: { type: Number, required: true, min: 1, immutable: true },
  monitorGeneration: { type: Number, required: true, min: 1, immutable: true },
  profileId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  profileStateRevision: { type: Number, required: true, min: 1, immutable: true },
  profileVersion: { type: Number, required: true, min: 1, immutable: true },
  profileFinancialFence: { type: Number, required: true, min: 0, immutable: true },
  profileFactsHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  sourceSnapshot: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  sourceSnapshotHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  modelVersion: { type: String, required: true, immutable: true },
  inputHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  status: { type: String, required: true, enum: ['RECALCULATED', 'NEEDS_REVIEW'], immutable: true },
  reasonCode: { type: String, required: true, enum: ['FINANCIAL_FACTS_CHANGED', 'ASSUMPTIONS_REQUIRE_REVIEW'], immutable: true },
  result: { type: mongoose.Schema.Types.Mixed, default: null, immutable: true },
  resultHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  issuedAt: { type: String, required: true, immutable: true },
  integrityKeyId: { type: String, required: true, match: /^[A-Za-z0-9_-]{1,32}$/, immutable: true },
  integrityTag: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
}, { strict: 'throw', timestamps: { createdAt: true, updatedAt: false } });
schema.index({ userId: 1, scenarioId: 1, scenarioRevision: 1, monitorGeneration: 1,
  profileId: 1, profileFactsHash: 1, profileStateRevision: 1, profileVersion: 1, profileFinancialFence: 1, modelVersion: 1 },
{ unique: true, name: 'uniq_decision_assessment_source_policy_v2' });
schema.index({ userId: 1, scenarioId: 1, createdAt: -1 }, { name: 'decision_assessment_owner_history' });
protectImmutableIdentity(schema, [
  'userId', 'scenarioId', 'scenarioRevision', 'monitorGeneration', 'profileId', 'profileStateRevision',
  'profileFactsHash', 'profileVersion', 'profileFinancialFence', 'sourceSnapshot', 'sourceSnapshotHash', 'modelVersion', 'inputHash', 'status', 'reasonCode', 'result', 'resultHash',
  'issuedAt', 'integrityKeyId', 'integrityTag',
], { code: 'DECISION_ASSESSMENT_IMMUTABLE', label: 'GenieDecision reassessment' });
export default mongoose.models.DecisionAssessment || mongoose.model('DecisionAssessment', schema);
