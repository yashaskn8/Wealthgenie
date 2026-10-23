import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  _id: { type: String, required: true, match: /^[a-f0-9-]{36}$/ },
  heartbeatAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  integrityKeyId: { type: String, required: true, match: /^[A-Za-z0-9_-]{1,32}$/ },
  integrityTag: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
}, { strict: 'throw', versionKey: false });
schema.index({ heartbeatAt: -1 }, { name: 'decision_worker_last_heartbeat' });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'decision_worker_heartbeat_ttl' });
export default mongoose.models.DecisionWorkerHeartbeat || mongoose.model('DecisionWorkerHeartbeat', schema);
