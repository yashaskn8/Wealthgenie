import crypto from 'node:crypto';
import DecisionWorkerHeartbeat from '../../models/DecisionWorkerHeartbeat.js';
import { signDecisionReceipt, verifyDecisionReceipt } from './integrity.js';

export const HEARTBEAT_MAX_AGE_MS = 45000;
const LIFETIME_MS = 90000;
const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
const validDate = value => value instanceof Date && Number.isFinite(value.getTime());

export function signDecisionWorkerHeartbeat({ workerId, heartbeatAt, expiresAt }) {
  if (!validId(workerId) || !validDate(heartbeatAt) || !validDate(expiresAt)
    || expiresAt.getTime() - heartbeatAt.getTime() !== LIFETIME_MS) {
    throw new Error('INVALID_DECISION_WORKER_HEARTBEAT');
  }
  return signDecisionReceipt('decision_worker_heartbeat', { workerId }, {
    heartbeatAt: heartbeatAt.toISOString(), expiresAt: expiresAt.toISOString(),
  });
}

export function verifyDecisionWorkerHeartbeat(record, { now = new Date() } = {}) {
  if (!record || !validId(record._id)
    || !validDate(record.heartbeatAt) || !validDate(record.expiresAt) || !validDate(now)
    || record.heartbeatAt > now
    || now.getTime() - record.heartbeatAt.getTime() > HEARTBEAT_MAX_AGE_MS
    || record.expiresAt <= now
    || record.expiresAt.getTime() - record.heartbeatAt.getTime() !== LIFETIME_MS) return false;
  return verifyDecisionReceipt(record, 'decision_worker_heartbeat', { workerId: record._id }, {
    heartbeatAt: record.heartbeatAt.toISOString(), expiresAt: record.expiresAt.toISOString(),
  });
}

export async function hasActiveDecisionWorker({ now = new Date(), model = DecisionWorkerHeartbeat } = {}) {
  if (process.env.GENIEDECISION_MONITOR_ENABLED !== 'true') return false;
  const latest = await model.findOne({
    heartbeatAt: { $gte: new Date(now.getTime() - HEARTBEAT_MAX_AGE_MS), $lte: now },
    expiresAt: { $gt: now },
  }).sort({ heartbeatAt: -1 }).lean();
  // A timestamp alone is not proof that an authorized worker is running.
  return verifyDecisionWorkerHeartbeat(latest, { now });
}

export function createDecisionWorkerHeartbeat({ model = DecisionWorkerHeartbeat, now = () => new Date() } = {}) {
  const workerId = crypto.randomUUID();
  const beat = async () => {
    const date = now();
    if (!validDate(date)) throw new Error('INVALID_DECISION_WORKER_HEARTBEAT_CLOCK');
    const expiresAt = new Date(date.getTime() + LIFETIME_MS);
    const receipt = signDecisionWorkerHeartbeat({ workerId, heartbeatAt: date, expiresAt });
    await model.updateOne({ _id: workerId }, {
      $set: { heartbeatAt: date, expiresAt, ...receipt },
    }, { upsert: true });
  };
  return { workerId, beat, async stop() { await model.deleteOne({ _id: workerId }); } };
}
