import crypto from 'node:crypto';
import DecisionEvent from '../../models/DecisionEvent.js';
import DecisionEventState from '../../models/DecisionEventState.js';

const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const LIVE_POLL_MS = 2500;
export const LIVE_STREAM_LIMIT_MS = 45000;

export function parseEventCursor(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,14})$/.test(value)
      || !Number.isSafeInteger(Number(value))) {
    const error = new Error('Invalid live-event cursor.');
    error.status = 400;
    error.code = 'INVALID_DECISION_EVENT_CURSOR';
    throw error;
  }
  return Number(value);
}

export async function appendDecisionEvent(session, { userId, type, scenarioId, revision }) {
  if (!session || !['SCENARIO_CREATED', 'SCENARIO_UPDATED', 'RUN_PUBLISHED', 'SCENARIO_DELETED'].includes(type)) {
    throw new Error('INVALID_DECISION_EVENT_OPERATION');
  }
  // The unique userId index serializes writers on an owner even across pods.
  // The event is inserted in the SAME Mongo transaction as the mutation.
  const head = await DecisionEventState.findOneAndUpdate(
    { userId }, { $inc: { sequence: 1 }, $setOnInsert: { userId } },
    { upsert: true, new: true, session },
  );
  if (!Number.isSafeInteger(head.sequence) || head.sequence < 1) {
    throw new Error('DECISION_EVENT_SEQUENCE_OUT_OF_RANGE');
  }
  await DecisionEvent.create([{
    userId, sequence: head.sequence, type, scenarioId, scenarioRevision: revision,
    expiresAt: new Date(Date.now() + RETENTION_MS),
  }], { session });
  return head.sequence;
}

export async function fetchDecisionEvents({ userId, after = null, limit = 32 }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('INVALID_EVENT_PAGE_LIMIT');
  const state = await DecisionEventState.findOne({ userId }).select('sequence').lean();
  const latestSequence = state?.sequence ?? 0;
  const cursor = after ?? latestSequence;
  // A cursor from a future event or a rolled-back replica cannot be accepted.
  if (cursor > latestSequence) return { events: [], latestSequence, resetRequired: true };
  const oldest = await DecisionEvent.findOne({ userId }).sort({ sequence: 1 }).select('sequence').lean();
  if (cursor < latestSequence && (!oldest || cursor < oldest.sequence - 1)) {
    return { events: [], latestSequence, resetRequired: true };
  }
  const rows = await DecisionEvent.find({ userId, sequence: { $gt: cursor } })
    .sort({ sequence: 1 }).limit(limit).lean();
  const events = rows.map(row => ({
    sequence: row.sequence, type: row.type, scenarioId: String(row.scenarioId),
    scenarioRevision: row.scenarioRevision, createdAt: row.createdAt.toISOString(),
  }));
  return { events, latestSequence, resetRequired: false };
}

export function sourceStateFingerprint(current) {
  // This is used only to detect a changed *currentness pointer*, never as
  // a security receipt or as a substitute for persisted report provenance.
  const data = current?.profile && current?.state?.resolutionStatus === 'CURRENT'
    ? [current.state.revision, String(current.profile._id), current.profile.version,
      current.profile.financialStateFence ?? 0, current.profile.monthlyTakeHome,
      current.profile.monthlySavings, current.profile.liquidSavings]
    : [current?.state?.resolutionStatus || 'UNAVAILABLE', current?.state?.revision ?? null];
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}
