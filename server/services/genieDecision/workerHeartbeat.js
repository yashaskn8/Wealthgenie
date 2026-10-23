import crypto from 'node:crypto';
import DecisionWorkerHeartbeat from '../../models/DecisionWorkerHeartbeat.js';
export const HEARTBEAT_MAX_AGE_MS = 45000;
export async function hasActiveDecisionWorker({ now = new Date(), model = DecisionWorkerHeartbeat } = {}) {
  if (process.env.GENIEDECISION_MONITOR_ENABLED !== 'true') return false;
  const latest = await model.findOne({
    heartbeatAt: { $gte: new Date(now.getTime() - HEARTBEAT_MAX_AGE_MS), $lte: now },
    expiresAt: { $gt: now },
  }).select('_id').lean();
  return Boolean(latest);
}
export function createDecisionWorkerHeartbeat({ model = DecisionWorkerHeartbeat, now = () => new Date() } = {}) {
  const workerId = crypto.randomUUID();
  const beat = async () => {
    const date = now();
    await model.updateOne({ _id: workerId }, {
      $set: { heartbeatAt: date, expiresAt: new Date(date.getTime() + 90000) },
    }, { upsert: true });
  };
  return { workerId, beat, async stop() { await model.deleteOne({ _id: workerId }); } };
}
