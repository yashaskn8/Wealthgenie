import mongoose from 'mongoose';

const proofBreakWorkerHeartbeatSchema = new mongoose.Schema({
  workerId: { type: String, required: true, maxlength: 120, immutable: true },
  status: { type: String, required: true, enum: ['RUNNING', 'DEGRADED', 'STOPPED'] },
  startedAt: { type: Date, required: true, immutable: true },
  heartbeatAt: { type: Date, required: true },
  lastSuccessfulPollAt: { type: Date, default: null },
  lastPollErrorCode: { type: String, enum: ['PROOFBREAK_WORKER_POLL_FAILED'], default: null },
  expiresAt: { type: Date, required: true },
}, { strict: 'throw', timestamps: { createdAt: true, updatedAt: false }, versionKey: false });

proofBreakWorkerHeartbeatSchema.index({ workerId: 1 }, { unique: true, name: 'uniq_proofbreak_worker_heartbeat' });
proofBreakWorkerHeartbeatSchema.index({ status: 1, heartbeatAt: -1 }, { name: 'proofbreak_worker_readiness' });
proofBreakWorkerHeartbeatSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'proofbreak_worker_heartbeat_ttl' });

export default mongoose.models.ProofBreakWorkerHeartbeat
  || mongoose.model('ProofBreakWorkerHeartbeat', proofBreakWorkerHeartbeatSchema);
