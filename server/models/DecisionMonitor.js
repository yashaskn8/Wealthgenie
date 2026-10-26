import mongoose from 'mongoose';
import { protectImmutableIdentity } from './immutableIdentity.js';

// One current monitored scenario per owner, explicitly opted into monitoring.
const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  scenarioId: { type: mongoose.Schema.Types.ObjectId, ref: 'DecisionScenario', required: true, immutable: true },
  enabled: { type: Boolean, required: true, default: false },
  generation: { type: Number, required: true, default: 1, min: 1, validate: Number.isSafeInteger },
  lastCheckedAt: { type: Date, default: null },
  leaseToken: { type: String, default: null, match: /^[a-f0-9-]{36}$/ },
  leaseUntil: { type: Date, default: null },
  integrityKeyId: { type: String, required: true, match: /^[A-Za-z0-9_-]{1,32}$/ },
  integrityTag: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
}, { strict: 'throw', timestamps: true });
schema.index({ userId: 1, scenarioId: 1 }, { unique: true, name: 'uniq_decision_monitor_owner_scenario' });
schema.index({ enabled: 1, lastCheckedAt: 1 }, { name: 'decision_monitor_scan' });
schema.index({ enabled: 1, leaseUntil: 1, lastCheckedAt: 1 },
  { name: 'decision_monitor_lease_claim' });
protectImmutableIdentity(schema, ['userId', 'scenarioId'], { code: 'DECISION_MONITOR_OWNER_IMMUTABLE', label: 'Decision monitor' });
export default mongoose.models.DecisionMonitor || mongoose.model('DecisionMonitor', schema);
