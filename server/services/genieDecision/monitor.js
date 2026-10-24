import crypto from 'node:crypto';
import mongoose from 'mongoose';
import DecisionMonitor from '../../models/DecisionMonitor.js';
import DecisionAssessment from '../../models/DecisionAssessment.js';
import DecisionScenario from '../../models/DecisionScenario.js';
import DecisionScenarioRevision from '../../models/DecisionScenarioRevision.js';
import DecisionRun from '../../models/DecisionRun.js';
import { appendDecisionEvent } from './liveEvents.js';
import { signDecisionReceipt, verifyDecisionReceipt } from './integrity.js';
import { DecisionInputError, DECISION_LEDGER_VERSION } from './ledger.js';
import { resolveCurrentFinancialProfile } from '../currentFinancialProfile.js';
import { createDecisionWorkerHeartbeat } from './workerHeartbeat.js';
import {
  makeDecisionSourceSnapshot, hashDecisionSourceSnapshot, verifyDecisionSourceSnapshot,
} from './sourceSnapshot.js';
import {
  computeDecisionScenario, fingerprintCurrentFacts, verifyDecisionRevision, verifyDecisionRun,
} from '../../routes/decisionScenarios.js';

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = value => String(value);
// Bounded failure taxonomy is safe to publish in worker health output.
// Never emit attacker-supplied exception messages or unbounded error codes.
const MONITOR_FAILURE_CODES = new Set([
  'DECISION_MONITOR_CONSENT_INTEGRITY_FAILURE',
  'DECISION_ASSESSMENT_INTEGRITY_FAILURE',
  'DECISION_REVISION_INTEGRITY_FAILURE',
  'DECISION_REPORT_INTEGRITY_FAILURE',
  'DECISION_MONITOR_REPORT_POINTER_MISSING',
  'DECISION_SNAPSHOT_SOURCE_UNAVAILABLE',
  'DECISION_INTEGRITY_UNAVAILABLE',
  'DECISION_EVENT_SEQUENCE_OUT_OF_RANGE',
]);
export function classifyDecisionMonitorFailure(error) {
  if (MONITOR_FAILURE_CODES.has(error?.code)) return error.code;
  if (error?.code === 11000 || error?.hasErrorLabel?.('TransientTransactionError')) {
    return 'DECISION_MONITOR_CONCURRENT_WRITE';
  }
  return 'DECISION_MONITOR_UNEXPECTED_FAILURE';
}
export function signMonitorConsent({ userId, scenarioId, generation, enabled }) {
  return signDecisionReceipt('decision_monitor_consent',
    { userId: id(userId), scenarioId: id(scenarioId), generation }, { enabled });
}
export function verifyMonitorConsent(monitor) {
  if (!monitor || !verifyDecisionReceipt(monitor, 'decision_monitor_consent', {
    userId: id(monitor.userId), scenarioId: id(monitor.scenarioId),
    generation: monitor.generation,
  }, { enabled: monitor.enabled })) {
    const error = new Error('Monitoring consent could not be authenticated.');
    error.code = 'DECISION_MONITOR_CONSENT_INTEGRITY_FAILURE';
    throw error;
  }
}

export function assessmentContext(item) {
  return {
    userId: id(item.userId), scenarioId: id(item.scenarioId),
    scenarioRevision: item.scenarioRevision, monitorGeneration: item.monitorGeneration,
    profileId: id(item.profileId), profileStateRevision: item.profileStateRevision,
    profileVersion: item.profileVersion, profileFinancialFence: item.profileFinancialFence,
    profileFactsHash: item.profileFactsHash, modelVersion: item.modelVersion,
    inputHash: item.inputHash, issuedAt: item.issuedAt, sourceSnapshotHash: item.sourceSnapshotHash,
  };
}

export function verifyDecisionAssessment(item) {
  if (!item || !['RECALCULATED', 'NEEDS_REVIEW'].includes(item.status)
      || !Object.hasOwn(item, 'result') || !/^[a-f0-9]{64}$/.test(item.resultHash || '')
      || (item.status === 'RECALCULATED' && (!item.result || typeof item.result !== 'object'))
      || (item.status === 'NEEDS_REVIEW' && item.result !== null)
      || hash(item.result) !== item.resultHash
      || !verifyDecisionReceipt(item, 'decision_reassessment', assessmentContext(item), {
        status: item.status, reasonCode: item.reasonCode, resultHash: item.resultHash,
      })) {
    const error = new Error('Saved reassessment failed authenticated integrity verification.');
    error.code = 'DECISION_ASSESSMENT_INTEGRITY_FAILURE';
    throw error;
  }
  verifyDecisionSourceSnapshot(item.sourceSnapshot, item);
  // Two independently signed blobs are insufficient unless they agree on
  // the *same* canonical input amounts. Block internally inconsistent reports
  // even if a signer bug produced a valid receipt for both blobs.
  if (item.status === 'RECALCULATED') {
    const expected = Object.fromEntries(item.sourceSnapshot.facts.map(fact => [fact.field, fact.value]));
    const actual = item.result.profileFacts;
    if (!actual || Object.keys(expected).some(key => actual[key] !== expected[key])
        || item.result.modelVersion !== item.modelVersion) {
      const error = new Error('Reassessment report disagrees with its financial evidence.');
      error.code = 'DECISION_ASSESSMENT_INTEGRITY_FAILURE';
      throw error;
    }
  }
}

export function assessmentDto(assessment, current, scenario, monitor) {
  verifyDecisionAssessment(assessment);
  let currentHash = null;
  try {
    if (current?.profile && current?.state?.resolutionStatus === 'CURRENT') {
      currentHash = fingerprintCurrentFacts(current.profile);
    }
  } catch { /* invalid canonical facts must never be interpreted as current */ }
  const currentStatus = Boolean(monitor?.enabled
    && monitor.generation === assessment.monitorGeneration
    && scenario?.revision === assessment.scenarioRevision
    && current?.profile && id(current.profile._id) === id(assessment.profileId)
    && current.state.revision === assessment.profileStateRevision
    && current.profile.version === assessment.profileVersion
    && Number(current.profile.financialStateFence ?? 0) === assessment.profileFinancialFence
    && currentHash === assessment.profileFactsHash
    && assessment.modelVersion === DECISION_LEDGER_VERSION);
  return {
    id: id(assessment._id), scenarioId: id(assessment.scenarioId),
    scenarioRevision: assessment.scenarioRevision, status: currentStatus ? assessment.status : 'HISTORICAL',
    originalStatus: assessment.status, reasonCode: assessment.reasonCode,
    asOf: assessment.issuedAt, result: assessment.result,
    source: {
      profileStateRevision: assessment.profileStateRevision,
      profileFactsHash: assessment.profileFactsHash, modelVersion: assessment.modelVersion,
      sourceSnapshotHash: assessment.sourceSnapshotHash,
      facts: assessment.sourceSnapshot.facts,
    },
    requiresUserReview: assessment.status === 'NEEDS_REVIEW' || !currentStatus,
    isCurrent: currentStatus,
  };
}

export async function assessMonitoredDecision(monitor, {
  resolveProfile = resolveCurrentFinancialProfile,
} = {}) {
  if (!monitor) return 'DISABLED';
  verifyMonitorConsent(monitor);
  if (!monitor.enabled) return 'DISABLED';
  const scenario = await DecisionScenario.findOne({
    _id: monitor.scenarioId, userId: monitor.userId,
  }).lean();
  if (!scenario) return 'DELETED';
  const revision = await DecisionScenarioRevision.findOne({
    userId: monitor.userId, scenarioId: scenario._id, revision: scenario.revision,
  }).lean();
  verifyDecisionRevision(revision, scenario);
  const current = await resolveProfile({ userId: monitor.userId, requireRecommendation: false });
  if (!current.profile || current.state.resolutionStatus !== 'CURRENT') return 'SOURCE_UNAVAILABLE';
  const sourceHash = fingerprintCurrentFacts(current.profile);
  const sameSource = sourceHash === scenario.profileFactsHash
    && id(current.profile._id) === id(scenario.profileId)
    && current.state.revision === scenario.profileStateRevision
    && current.profile.version === scenario.profileVersion
    && Number(current.profile.financialStateFence ?? 0) === scenario.profileFinancialFence;
  let changedPolicy = false;
  let changedRevision = false;
  if (sameSource) {
    // A new financial engine version can invalidate the last signed report
    // even when household inputs have not changed. Do not leave a monitored
    // decision silently stale after deployment.
    if (scenario.lastRunId) {
      const priorRun = await DecisionRun.findOne({
        _id: scenario.lastRunId, userId: monitor.userId, scenarioId: scenario._id,
      }).lean();
      if (!priorRun) throw new Error('DECISION_MONITOR_REPORT_POINTER_MISSING');
      verifyDecisionRun(priorRun);
      changedPolicy = priorRun.revision === scenario.revision
        && priorRun.result.modelVersion !== DECISION_LEDGER_VERSION;
    }
    const latestAssessment = await DecisionAssessment.findOne({
      userId: monitor.userId, scenarioId: scenario._id, monitorGeneration: monitor.generation,
    }).sort({ createdAt: -1, _id: -1 }).lean();
    if (latestAssessment) {
      verifyDecisionAssessment(latestAssessment);
      changedPolicy ||= latestAssessment.modelVersion !== DECISION_LEDGER_VERSION;
      changedRevision = latestAssessment.scenarioRevision !== scenario.revision;
    }
    if (!changedPolicy && !changedRevision) {
      await DecisionMonitor.updateOne({
        _id: monitor._id, enabled: true, generation: monitor.generation,
        ...(monitor.leaseToken ? { leaseToken: monitor.leaseToken } : {}),
      }, { $set: { lastCheckedAt: new Date() } });
      return 'UNCHANGED';
    }
  }
  const filter = {
    userId: monitor.userId, scenarioId: scenario._id,
    scenarioRevision: scenario.revision, monitorGeneration: monitor.generation,
    profileId: current.profile._id,
    profileFactsHash: sourceHash, profileStateRevision: current.state.revision,
    profileVersion: current.profile.version,
    profileFinancialFence: Number(current.profile.financialStateFence ?? 0),
    modelVersion: DECISION_LEDGER_VERSION,
  };
  const already = await DecisionAssessment.findOne(filter).lean();
  if (already) { verifyDecisionAssessment(already); return 'DUPLICATE'; }

  let status = 'RECALCULATED';
  let reasonCode = changedPolicy ? 'CALCULATION_POLICY_CHANGED'
    : changedRevision ? 'SCENARIO_REVISION_CHANGED' : 'FINANCIAL_FACTS_CHANGED';
  let result = null;
  try {
    result = computeDecisionScenario(current, revision.payload);
  } catch (error) {
    if (!(error instanceof DecisionInputError)) throw error;
    // Old expense, debt and savings assumptions may no longer reconcile to
    // a new income. Never silently invent a balancing number.
    status = 'NEEDS_REVIEW';
    reasonCode = 'ASSUMPTIONS_REQUIRE_REVIEW';
  }
  const resultHash = hash(result);
  const issuedAt = new Date().toISOString();
  const sourceSnapshot = makeDecisionSourceSnapshot(current, issuedAt);
  const sourceSnapshotHash = hashDecisionSourceSnapshot(sourceSnapshot);
  const candidate = {
    ...filter, inputHash: revision.inputHash,
    sourceSnapshot, sourceSnapshotHash,
    status, reasonCode, result, resultHash, issuedAt,
  };
  const receipt = signDecisionReceipt('decision_reassessment', assessmentContext(candidate), {
    status, reasonCode, resultHash,
  });
  const session = await mongoose.startSession();
  try {
    let outcome = 'CREATED';
    await session.withTransaction(async () => {
      const freshMonitor = await DecisionMonitor.findOne({
        _id: monitor._id, enabled: true, generation: monitor.generation,
      }).session(session).lean();
      if (!freshMonitor) { outcome = 'WATCH_DISABLED'; return; }
      verifyMonitorConsent(freshMonitor);
      const freshScenario = await DecisionScenario.findOne({
        _id: scenario._id, userId: monitor.userId, revision: scenario.revision,
      }).session(session).lean();
      if (!freshScenario) { outcome = 'SCENARIO_CHANGED'; return; }
      const freshRevision = await DecisionScenarioRevision.findOne({
        userId: monitor.userId, scenarioId: scenario._id, revision: scenario.revision,
      }).session(session).lean();
      verifyDecisionRevision(freshRevision, freshScenario);
      if (freshRevision.inputHash !== revision.inputHash) {
        outcome = 'SCENARIO_CHANGED'; return;
      }
      const freshProfile = await resolveProfile({ userId: monitor.userId, requireRecommendation: false, session });
      if (!freshProfile.profile || freshProfile.state.resolutionStatus !== 'CURRENT'
        || id(freshProfile.profile._id) !== id(candidate.profileId)
        || freshProfile.state.revision !== candidate.profileStateRevision
        || freshProfile.profile.version !== candidate.profileVersion
        || Number(freshProfile.profile.financialStateFence ?? 0) !== candidate.profileFinancialFence
        || fingerprintCurrentFacts(freshProfile.profile) !== sourceHash) {
        outcome = 'SOURCE_CHANGED'; return;
      }
      const existing = await DecisionAssessment.findOne(filter).session(session).lean();
      if (existing) { verifyDecisionAssessment(existing); outcome = 'DUPLICATE'; return; }
      // The conditional monitor update serializes disable/re-enable with the
      // scan transaction; only a still-enabled generation may publish alerts.
      const touched = await DecisionMonitor.updateOne({
        _id: monitor._id, enabled: true, generation: monitor.generation,
        ...(monitor.leaseToken ? { leaseToken: monitor.leaseToken } : {}),
      }, { $set: { lastCheckedAt: new Date() } }, { session });
      if (touched.matchedCount !== 1) { outcome = 'WATCH_DISABLED'; return; }
      await DecisionAssessment.create([{ ...candidate, ...receipt }], { session });
      await appendDecisionEvent(session, {
        userId: monitor.userId, type: 'ASSESSMENT_AVAILABLE',
        scenarioId: scenario._id, revision: scenario.revision,
      });
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    return outcome;
  } catch (error) {
    if (error?.code === 11000 || error?.hasErrorLabel?.('TransientTransactionError')) {
      const committed = await DecisionAssessment.findOne(filter).lean();
      if (committed) { verifyDecisionAssessment(committed); return 'DUPLICATE'; }
      return 'RETRYABLE_CONFLICT';
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

export async function scanDecisionMonitors({
  limit = 25, resolveProfile, minCheckIntervalMs = 0, leaseMs = 75000,
  now = () => new Date(),
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50
      || !Number.isSafeInteger(minCheckIntervalMs) || minCheckIntervalMs < 0
      || !Number.isSafeInteger(leaseMs) || leaseMs < 10000) {
    throw new RangeError('Invalid monitoring scan limit or lease');
  }
  const summary = { inspected: 0, created: 0, failed: 0, statuses: {}, failureCodes: {} };
  const recordFailure = code => {
    summary.failed += 1;
    summary.failureCodes[code] = (summary.failureCodes[code] || 0) + 1;
  };
  const visited = [];
  for (let index = 0; index < limit; index += 1) {
    const claimedAt = now();
    const token = crypto.randomUUID();
    const monitor = await DecisionMonitor.findOneAndUpdate({
      enabled: true, _id: { $nin: visited },
      $and: [
        { $or: [{ leaseUntil: null }, { leaseUntil: { $lte: claimedAt } }] },
        { $or: [{ lastCheckedAt: null },
          { lastCheckedAt: { $lte: new Date(claimedAt.getTime() - minCheckIntervalMs) } }] },
      ],
    }, { $set: {
      leaseToken: token, leaseUntil: new Date(claimedAt.getTime() + leaseMs),
    } }, { sort: { lastCheckedAt: 1, _id: 1 }, new: true }).lean();
    if (!monitor) break;
    visited.push(monitor._id);
    summary.inspected += 1;
    try {
      const outcome = await assessMonitoredDecision(monitor, { resolveProfile });
      summary.statuses[outcome] = (summary.statuses[outcome] || 0) + 1;
      if (outcome === 'CREATED') summary.created += 1;
    } catch (error) { recordFailure(classifyDecisionMonitorFailure(error)); }
    finally {
      try {
        await DecisionMonitor.updateOne({
          _id: monitor._id, generation: monitor.generation, leaseToken: token,
        }, { $set: { lastCheckedAt: now(), leaseToken: null, leaseUntil: null } });
      } catch { recordFailure('DECISION_MONITOR_LEASE_RELEASE_FAILED'); }
    }
  }
  return summary;
}

export function createDecisionMonitorWorker({
  pollMs = 60000, scan = scanDecisionMonitors,
  heartbeat = createDecisionWorkerHeartbeat(),
} = {}) {
  if (!Number.isSafeInteger(pollMs) || pollMs < 10000) throw new RangeError('Poll must be >=10 seconds');
  let timer = null;
  let active = null;
  let lastResult = null;
  let heartTimer = null;
  let heartbeatHealthy = false;
  let lastHeartbeatAt = null;
  let heartbeatInFlight = null;
  const beat = async () => {
    // Serialize heartbeat writes. An old, in-flight upsert must never
    // resurrect a healthy-worker marker after shutdown deletes it.
    if (heartbeatInFlight) return heartbeatInFlight;
    heartbeatInFlight = Promise.resolve().then(() => heartbeat.beat()).then(() => {
      heartbeatHealthy = true;
      lastHeartbeatAt = new Date().toISOString();
    });
    try { await heartbeatInFlight; }
    finally { heartbeatInFlight = null; }
  };
  const tick = async () => {
    if (active) return active;
    active = Promise.resolve().then(() => scan({ limit: 25, minCheckIntervalMs: pollMs }));
    try { lastResult = await active; return lastResult; }
    finally { active = null; }
  };
  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick().catch(error => {
        lastResult = { inspected: 0, created: 0, failed: 1, statuses: {},
          failureCodes: { [classifyDecisionMonitorFailure(error)]: 1 } };
      }); }, pollMs);
      heartTimer = setInterval(() => {
        void beat().catch(() => { heartbeatHealthy = false; });
      }, 15000);
      heartTimer.unref?.();
      void beat().catch(() => { heartbeatHealthy = false; });
      timer.unref?.();
      void tick().catch(error => {
        lastResult = { inspected: 0, created: 0, failed: 1, statuses: {},
          failureCodes: { [classifyDecisionMonitorFailure(error)]: 1 } };
      });
    },
    async stop() {
      if (timer) clearInterval(timer);
      if (heartTimer) clearInterval(heartTimer);
      timer = null;
      heartTimer = null;
      heartbeatHealthy = false;
      if (active) await active;
      if (heartbeatInFlight) {
        // A failed heartbeat should not prevent revoking the previous worker
        // identity. The deleted record must never be silently resurrected.
        try { await heartbeatInFlight; } catch { heartbeatHealthy = false; }
      }
      heartbeatHealthy = false;
      await heartbeat.stop();
      return { drained: true };
    },
    state: () => ({ enabled: Boolean(timer), activeJobs: active ? 1 : 0,
      heartbeatHealthy, lastHeartbeatAt, lastResult }),
    runOnce: tick,
  };
}
