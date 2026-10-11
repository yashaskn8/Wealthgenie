import crypto from 'node:crypto';
import mongoose from 'mongoose';
import GenieProofCase from '../../models/GenieProofCase.js';
import GenieProofRevision from '../../models/GenieProofRevision.js';
import ProofWatch from '../../models/ProofWatch.js';
import ProofBreakJob from '../../models/ProofBreakJob.js';
import ProofBreakEvent from '../../models/ProofBreakEvent.js';
import ProofNotificationOutbox from '../../models/ProofNotificationOutbox.js';
import ProofBreakWorkerHeartbeat from '../../models/ProofBreakWorkerHeartbeat.js';
import { refreshGenieProofIndiaPostPpfEvidence } from './genieProofEvidenceRegistryService.js';
import { reassessGenieProofCase } from './genieProofService.js';
import { PROOFBREAK_CHECK_INTERVAL_MS } from './proofBreakService.js';
import { canonicalSha256 } from '../../utils/canonicalJson.js';

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_LEASE_MS = 300_000;
const MAX_DUE_WATCH_SCAN = 100;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;
const RETRY_BASE_MS = 5_000;
const MAX_ATTEMPTS = 4;
const HEARTBEAT_TTL_MS = 30_000;

function isModified(result) {
  return Number(result?.modifiedCount ?? result?.nModified ?? 0) > 0;
}

function dateAdd(value, milliseconds) {
  return new Date(new Date(value).getTime() + milliseconds);
}

function isRightsBlocked(error) {
  return ['GENIEPROOF_SOURCE_REUSE_NOT_APPROVED', 'GENIEPROOF_SOURCE_REVIEW_RECORD_REQUIRED'].includes(error?.code)
    || error?.status === 403;
}

export function failedCheckEventType(error) {
  if (isRightsBlocked(error)) return 'POLICY_REVIEW_REQUIRED';
  if (typeof error?.code === 'string'
      && (error.code.startsWith('GENIEPROOF_SOURCE_') || error.code.startsWith('RESEARCH_'))) {
    return 'SOURCE_UNAVAILABLE';
  }
  return 'PROCESSING_FAILED';
}

function retryDelay(attempt) {
  return Math.min(MAX_RETRY_DELAY_MS, RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1)));
}

function claimQuery(now) {
  return {
    $or: [
      { status: 'QUEUED', scheduledAt: { $lte: now } },
      { status: 'LEASED', leaseUntil: { $lte: now } },
    ],
  };
}

export async function scheduleDueProofBreakJobs({
  watchModel = ProofWatch,
  jobModel = ProofBreakJob,
  now = () => new Date(),
  limit = MAX_DUE_WATCH_SCAN,
}) {
  const currentTime = now();
  const watches = await watchModel.find({
    status: 'ACTIVE',
    nextCheckAt: { $lte: currentTime },
    expiresAt: { $gt: currentTime },
    consentWithdrawnAt: null,
  }).sort({ nextCheckAt: 1, _id: 1 }).limit(Math.min(MAX_DUE_WATCH_SCAN, Math.max(1, limit))).lean();
  let scheduled = 0;
  for (const watch of watches) {
    if (await jobModel.exists({ watchId: watch.watchId, status: { $in: ['QUEUED', 'LEASED'] } })) continue;
    const scheduleKey = `scheduled:${watch.generation}:${new Date(watch.nextCheckAt).toISOString()}`;
    try {
      await jobModel.create([{
        jobId: crypto.randomUUID(),
        watchId: watch.watchId,
        userId: watch.userId,
        caseId: watch.caseId,
        scheduleKey,
        watchGeneration: watch.generation,
        status: 'QUEUED',
        scheduledAt: currentTime,
        attempt: 0,
        maxAttempts: MAX_ATTEMPTS,
        executionGeneration: 0,
        expiresAt: watch.expiresAt,
      }]);
      scheduled += 1;
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
    await watchModel.updateOne({
      watchId: watch.watchId,
      userId: watch.userId,
      status: 'ACTIVE',
      generation: watch.generation,
      nextCheckAt: { $lte: currentTime },
    }, { $set: { nextCheckAt: dateAdd(currentTime, PROOFBREAK_CHECK_INTERVAL_MS) } });
  }
  return { scanned: watches.length, scheduled };
}

export async function claimNextProofBreakJob({
  jobModel = ProofBreakJob,
  owner = crypto.randomUUID(),
  leaseMs = DEFAULT_LEASE_MS,
  now = () => new Date(),
}) {
  const currentTime = now();
  const claimed = await jobModel.findOneAndUpdate(claimQuery(currentTime), {
    $set: {
      status: 'LEASED',
      leaseOwner: owner,
      leaseUntil: dateAdd(currentTime, leaseMs),
      heartbeatAt: currentTime,
      failureCode: null,
    },
    $inc: { attempt: 1, executionGeneration: 1 },
  }, { new: true, sort: { scheduledAt: 1, _id: 1 } }).lean();
  return claimed ? { job: claimed, owner, executionGeneration: claimed.executionGeneration } : null;
}

async function recordFailedCheck({
  claimed,
  watch,
  error,
  now,
  watchModel,
  jobModel,
  eventModel,
  outboxModel,
  revisionModel,
  startSession,
}) {
  const currentTime = now();
  const blockedByRights = isRightsBlocked(error);
  const terminal = blockedByRights || claimed.job.attempt >= (claimed.job.maxAttempts || MAX_ATTEMPTS);
  const retryAt = terminal ? null : dateAdd(currentTime, retryDelay(claimed.job.attempt));
  const session = await startSession();
  try {
    session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
    const watchQuery = watchModel.findOne({
      watchId: watch.watchId,
      userId: watch.userId,
      caseId: watch.caseId,
      status: { $in: ['ACTIVE', 'FAILED_RETRYABLE'] },
      generation: claimed.job.watchGeneration,
      consentWithdrawnAt: null,
    });
    if (typeof watchQuery.session === 'function') watchQuery.session(session);
    const currentWatch = await watchQuery.lean();
    const jobQuery = jobModel.findOne({
      jobId: claimed.job.jobId,
      watchId: watch.watchId,
      status: 'LEASED',
      leaseOwner: claimed.owner,
      executionGeneration: claimed.executionGeneration,
      leaseUntil: { $gt: currentTime },
    });
    if (typeof jobQuery.session === 'function') jobQuery.session(session);
    const currentJob = await jobQuery.lean();
    if (!currentWatch || !currentJob) {
      await session.abortTransaction();
      return { status: 'FENCED' };
    }
    const latestQuery = revisionModel.findOne({ userId: watch.userId, caseId: watch.caseId }).sort({ revision: -1 });
    if (typeof latestQuery.session === 'function') latestQuery.session(session);
    const latestRevision = await latestQuery.lean();
  const eventType = failedCheckEventType(error);
    const eventRows = [];
    const outboxRows = [];
    if (latestRevision) {
      for (const claimId of watch.requestedClaimIds || []) {
        const finding = (latestRevision.manifest?.findings || []).find(item => item.claimId === claimId);
        const evidence = finding?.evidence?.revisions?.[0];
        const eventId = crypto.randomUUID();
        const deduplicationKey = canonicalSha256([watch.watchId, claimed.job.jobId, claimed.job.attempt, claimId, eventType]);
        eventRows.push({
          eventId,
          deduplicationKey,
          userId: watch.userId,
          caseId: watch.caseId,
          watchId: watch.watchId,
          claimId,
          previousAssessmentId: `${watch.caseId}:${latestRevision.revision}`,
          newAssessmentId: null,
          previousEvidenceRevision: evidence ? `${evidence.evidenceId}:${evidence.revision}` : null,
          newEvidenceRevision: null,
          changedFactFields: [],
          effectivePeriodImplications: {
            previousEffectiveFrom: evidence?.effectiveFrom ? new Date(evidence.effectiveFrom) : null,
            previousEffectiveTo: evidence?.effectiveTo ? new Date(evidence.effectiveTo) : null,
            currentEffectiveFrom: null,
            currentEffectiveTo: null,
          },
          eventType,
          detectedAt: currentTime,
          publishedAt: currentTime,
          notificationStatus: 'PENDING',
          acknowledgedAt: null,
          expiresAt: watch.expiresAt,
        });
        outboxRows.push({
          outboxId: crypto.randomUUID(), eventId, userId: watch.userId, caseId: watch.caseId,
          watchId: watch.watchId, status: 'PENDING', attempt: 0, nextAttemptAt: currentTime,
          executionGeneration: 0, expiresAt: watch.expiresAt,
        });
      }
    }
    if (eventRows.length) await eventModel.create(eventRows, { session });
    if (outboxRows.length) await outboxModel.create(outboxRows, { session });
    const watchStatus = blockedByRights ? 'BLOCKED_SOURCE_RIGHTS' : terminal ? 'FAILED_TERMINAL' : 'FAILED_RETRYABLE';
    const watchUpdate = await watchModel.updateOne({
      watchId: watch.watchId,
      userId: watch.userId,
      caseId: watch.caseId,
      status: { $in: ['ACTIVE', 'FAILED_RETRYABLE'] },
      generation: claimed.job.watchGeneration,
      consentWithdrawnAt: null,
    }, {
      $set: {
        status: watchStatus,
        sourceAvailability: blockedByRights ? 'RIGHTS_BLOCKED' : watch.sourceAvailability,
        nextCheckAt: retryAt,
        lastFailureCode: error?.code || 'PROOFBREAK_CHECK_FAILED',
      },
      ...(terminal ? { $inc: { generation: 1 } } : {}),
    }, { session });
    if (!isModified(watchUpdate)) throw Object.assign(new Error('Watch changed during source failure publication.'), { code: 'PROOFBREAK_WATCH_FENCE_LOST' });
    const jobUpdate = await jobModel.updateOne({
      jobId: claimed.job.jobId,
      status: 'LEASED',
      leaseOwner: claimed.owner,
      executionGeneration: claimed.executionGeneration,
      leaseUntil: { $gt: currentTime },
    }, {
      $set: {
        status: blockedByRights ? 'FAILED_TERMINAL' : terminal ? 'FAILED_TERMINAL' : 'QUEUED',
        scheduledAt: retryAt || currentTime,
        leaseOwner: null,
        leaseUntil: null,
        heartbeatAt: currentTime,
        failureCode: error?.code || 'PROOFBREAK_CHECK_FAILED',
      },
    }, { session });
    if (!isModified(jobUpdate)) throw Object.assign(new Error('Job lease changed during source failure publication.'), { code: 'PROOFBREAK_JOB_FENCE_LOST' });
    await session.commitTransaction();
    return { status: watchStatus, retryAt };
  } catch (failure) {
    if (session.inTransaction()) await session.abortTransaction().catch(() => {});
    throw failure;
  } finally {
    await session.endSession();
  }
}

async function claimOutbox({ outboxModel, owner, leaseMs, now }) {
  const currentTime = now();
  const item = await outboxModel.findOneAndUpdate({
    $or: [
      { status: 'PENDING', nextAttemptAt: { $lte: currentTime } },
      { status: 'FAILED_RETRYABLE', nextAttemptAt: { $lte: currentTime } },
      { status: 'LEASED', leaseUntil: { $lte: currentTime } },
    ],
  }, {
    $set: { status: 'LEASED', leaseOwner: owner, leaseUntil: dateAdd(currentTime, leaseMs) },
    $inc: { attempt: 1, executionGeneration: 1 },
  }, { new: true, sort: { nextAttemptAt: 1, _id: 1 } }).lean();
  return item;
}

async function deliverOutbox({ item, owner, watchModel, eventModel, outboxModel, caseModel, startSession, now }) {
  const currentTime = now();
  const session = await startSession();
  try {
    session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
    const watchQuery = watchModel.findOne({ userId: item.userId, watchId: item.watchId, consentWithdrawnAt: null });
    if (typeof watchQuery.session === 'function') watchQuery.session(session);
    const watch = await watchQuery.lean();
    const caseQuery = caseModel.findOne({ userId: item.userId, caseId: item.caseId, deletedAt: null, consentWithdrawnAt: null, expiresAt: { $gt: currentTime } });
    if (typeof caseQuery.session === 'function') caseQuery.session(session);
    const ownedCase = await caseQuery.lean();
    const mayDeliver = watch && ownedCase && watch.status !== 'CANCELLED' && watch.status !== 'EXPIRED';
    const outboxUpdate = await outboxModel.updateOne({
      outboxId: item.outboxId,
      status: 'LEASED',
      leaseOwner: owner,
      executionGeneration: item.executionGeneration,
      leaseUntil: { $gt: currentTime },
    }, {
      $set: {
        status: mayDeliver ? 'DELIVERED' : 'CANCELLED',
        deliveredAt: mayDeliver ? currentTime : null,
        leaseOwner: null,
        leaseUntil: null,
        failureCode: mayDeliver ? null : 'WATCH_OR_CASE_UNAVAILABLE',
      },
    }, { session });
    if (!isModified(outboxUpdate)) throw Object.assign(new Error('Notification outbox lease was lost.'), { code: 'PROOFBREAK_OUTBOX_FENCE_LOST' });
    await eventModel.updateOne({ eventId: item.eventId, userId: item.userId }, {
      $set: { notificationStatus: mayDeliver ? 'DELIVERED' : 'CANCELLED' },
    }, { session });
    await session.commitTransaction();
    return mayDeliver ? 'DELIVERED' : 'CANCELLED';
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(() => {});
    throw error;
  } finally {
    await session.endSession();
  }
}

export class ProofBreakWorker {
  constructor({
    signer,
    workerId = crypto.randomUUID(),
    watchModel = ProofWatch,
    jobModel = ProofBreakJob,
    eventModel = ProofBreakEvent,
    outboxModel = ProofNotificationOutbox,
    caseModel = GenieProofCase,
    revisionModel = GenieProofRevision,
    refreshEvidence = refreshGenieProofIndiaPostPpfEvidence,
    reassess = reassessGenieProofCase,
    evidenceResolver,
    heartbeatModel = ProofBreakWorkerHeartbeat,
    startSession = () => mongoose.startSession(),
    now = () => new Date(),
    leaseMs = DEFAULT_LEASE_MS,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  } = {}) {
    this.signer = signer;
    this.workerId = workerId;
    this.watchModel = watchModel;
    this.jobModel = jobModel;
    this.eventModel = eventModel;
    this.outboxModel = outboxModel;
    this.caseModel = caseModel;
    this.revisionModel = revisionModel;
    this.refreshEvidence = refreshEvidence;
    this.reassess = reassess;
    this.evidenceResolver = evidenceResolver;
    this.heartbeatModel = heartbeatModel;
    this.startSession = startSession;
    this.now = now;
    this.leaseMs = leaseMs;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.timer = null;
    this.heartbeatTimer = null;
    this.heartbeatInFlight = null;
    this.leaseHeartbeatTimer = null;
    this.activePromise = null;
    this.abortController = null;
    this.running = false;
    this.draining = false;
    this.completedChecks = 0;
    this.failedChecks = 0;
    this.workerStatus = 'RUNNING';
    this.lastSuccessfulPollAt = null;
    this.lastPollErrorCode = null;
  }

  state() {
    return { running: this.running, draining: this.draining, ready: Boolean(this.signer), workerId: this.workerId, activeJobs: this.activePromise ? 1 : 0, completedChecks: this.completedChecks, failedChecks: this.failedChecks };
  }

  async publishHeartbeat(status = 'RUNNING') {
    const currentTime = this.now();
    await this.heartbeatModel.updateOne({ workerId: this.workerId }, {
      $set: {
        status,
        heartbeatAt: currentTime,
        lastSuccessfulPollAt: this.lastSuccessfulPollAt,
        lastPollErrorCode: this.lastPollErrorCode,
        expiresAt: dateAdd(currentTime, HEARTBEAT_TTL_MS),
      },
      $setOnInsert: { workerId: this.workerId, startedAt: currentTime },
    }, { upsert: true });
  }

  heartbeatWorker() {
    if (this.heartbeatInFlight || !this.running || this.draining) return this.heartbeatInFlight;
    this.heartbeatInFlight = this.publishHeartbeat(this.workerStatus)
      .catch(() => {})
      .finally(() => { this.heartbeatInFlight = null; });
    return this.heartbeatInFlight;
  }

  async assertLease(claimed, abortController = this.abortController) {
    const currentTime = this.now();
    const valid = await this.jobModel.exists({
      jobId: claimed.job.jobId,
      status: 'LEASED',
      leaseOwner: claimed.owner,
      executionGeneration: claimed.executionGeneration,
      leaseUntil: { $gt: currentTime },
    });
    if (!valid) throw Object.assign(new Error('ProofBreak execution lease was lost.'), { code: 'PROOFBREAK_LEASE_LOST' });
    if (abortController?.signal.aborted) throw Object.assign(new Error('ProofBreak worker is stopping.'), { code: 'PROOFBREAK_WORKER_STOPPING' });
  }

  start({ intervalMs = DEFAULT_POLL_MS } = {}) {
    if (this.running) return this;
    this.running = true;
    this.draining = false;
    void this.heartbeatWorker();
    this.heartbeatTimer = this.setIntervalImpl(() => {
      if (!this.running || this.draining) return;
      void this.heartbeatWorker();
    }, Math.min(10_000, Math.max(1_000, Math.floor(intervalMs * 2))));
    this.timer = this.setIntervalImpl(() => { void this.processNext().catch(() => {}); }, Math.max(100, intervalMs));
    void this.processNext().catch(() => {});
    return this;
  }

  async processNext() {
    if (this.activePromise || this.draining || !this.signer) return { processed: false, reason: this.signer ? 'BUSY' : 'SIGNER_UNAVAILABLE' };
    this.activePromise = this.processOne();
    try {
      const result = await this.activePromise;
      this.lastSuccessfulPollAt = this.now();
      this.lastPollErrorCode = null;
      this.workerStatus = 'RUNNING';
      if (this.running && !this.draining) await this.publishHeartbeat(this.workerStatus);
      return result;
    } catch (error) {
      this.lastPollErrorCode = 'PROOFBREAK_WORKER_POLL_FAILED';
      this.workerStatus = 'DEGRADED';
      if (this.running && !this.draining) await this.publishHeartbeat(this.workerStatus).catch(() => {});
      throw error;
    } finally { this.activePromise = null; }
  }

  async processOne() {
    await scheduleDueProofBreakJobs({ watchModel: this.watchModel, jobModel: this.jobModel, now: this.now });
    const claimed = await claimNextProofBreakJob({ jobModel: this.jobModel, owner: this.workerId, leaseMs: this.leaseMs, now: this.now });
    if (claimed) {
      const jobAbortController = new AbortController();
      this.abortController = jobAbortController;
      let heartbeatBusy = false;
      let leaseHeartbeatInFlight = null;
      const heartbeat = this.setIntervalImpl(async () => {
        if (heartbeatBusy || this.draining || jobAbortController.signal.aborted) return;
        heartbeatBusy = true;
        leaseHeartbeatInFlight = (async () => {
          try {
          const currentTime = this.now();
          const updated = await this.jobModel.updateOne({
            jobId: claimed.job.jobId,
            status: 'LEASED',
            leaseOwner: claimed.owner,
            executionGeneration: claimed.executionGeneration,
            leaseUntil: { $gt: currentTime },
          }, { $set: { leaseUntil: dateAdd(currentTime, this.leaseMs), heartbeatAt: currentTime } });
          if (!isModified(updated)) jobAbortController.abort(Object.assign(new Error('ProofBreak lease was lost.'), { code: 'PROOFBREAK_LEASE_LOST' }));
          } catch { jobAbortController.abort(Object.assign(new Error('ProofBreak lease heartbeat failed.'), { code: 'PROOFBREAK_LEASE_LOST' })); }
          finally { heartbeatBusy = false; }
        })();
        await leaseHeartbeatInFlight;
      }, Math.max(1000, Math.min(10_000, Math.floor(this.leaseMs / 3))));
      this.leaseHeartbeatTimer = heartbeat;
      try {
        const result = await this.processClaimedJob(claimed, jobAbortController);
        if (result?.status === 'COMPLETED') this.completedChecks += 1;
        return { processed: true, kind: 'CHECK', ...result };
      } catch (error) {
        this.failedChecks += 1;
        if (!['PROOFBREAK_LEASE_LOST', 'PROOFBREAK_WATCH_FENCE_LOST', 'PROOFBREAK_JOB_FENCE_LOST', 'PROOFBREAK_WORKER_STOPPING'].includes(error?.code)) {
          const watch = await this.watchModel.findOne({ watchId: claimed.job.watchId, userId: claimed.job.userId }).lean();
          if (watch) {
            try {
              return { processed: true, kind: 'CHECK', ...(await recordFailedCheck({
                claimed, watch, error, now: this.now, watchModel: this.watchModel, jobModel: this.jobModel,
                eventModel: this.eventModel, outboxModel: this.outboxModel, revisionModel: this.revisionModel, startSession: this.startSession,
              })) };
            } catch (publishError) {
              if (!['PROOFBREAK_LEASE_LOST', 'PROOFBREAK_WATCH_FENCE_LOST', 'PROOFBREAK_JOB_FENCE_LOST'].includes(publishError?.code)) throw publishError;
            }
          }
        }
        return { processed: true, kind: 'CHECK', status: 'FENCED' };
      } finally {
        this.clearIntervalImpl(heartbeat);
        if (this.leaseHeartbeatTimer === heartbeat) this.leaseHeartbeatTimer = null;
        if (leaseHeartbeatInFlight) await leaseHeartbeatInFlight.catch(() => {});
        if (this.abortController === jobAbortController) this.abortController = null;
      }
    }

    const notification = await claimOutbox({ outboxModel: this.outboxModel, owner: `${this.workerId}:notification`, leaseMs: this.leaseMs, now: this.now });
    if (notification) {
      const status = await deliverOutbox({ item: notification, owner: `${this.workerId}:notification`, watchModel: this.watchModel, eventModel: this.eventModel, outboxModel: this.outboxModel, caseModel: this.caseModel, startSession: this.startSession, now: this.now });
      return { processed: true, kind: 'NOTIFICATION', status };
    }
    return { processed: false, reason: 'NO_DUE_WORK' };
  }

  async processClaimedJob(claimed, jobAbortController = this.abortController) {
    const currentTime = this.now();
    let watch = await this.watchModel.findOne({
      watchId: claimed.job.watchId,
      userId: claimed.job.userId,
      caseId: claimed.job.caseId,
      generation: claimed.job.watchGeneration,
      status: { $in: ['ACTIVE', 'FAILED_RETRYABLE'] },
      consentWithdrawnAt: null,
      expiresAt: { $gt: currentTime },
    }).lean();
    if (!watch) {
      await this.jobModel.updateOne({ jobId: claimed.job.jobId, status: 'LEASED', leaseOwner: claimed.owner, executionGeneration: claimed.executionGeneration }, {
        $set: { status: 'CANCELLED', leaseOwner: null, leaseUntil: null, failureCode: 'WATCH_UNAVAILABLE' },
      });
      return { status: 'CANCELLED' };
    }
    if (watch.status === 'FAILED_RETRYABLE') {
      const activated = await this.watchModel.updateOne({ watchId: watch.watchId, status: 'FAILED_RETRYABLE', generation: watch.generation, consentWithdrawnAt: null }, {
        $set: { status: 'ACTIVE', lastFailureCode: null },
      });
      if (!isModified(activated)) throw Object.assign(new Error('ProofBreak watch changed before retry.'), { code: 'PROOFBREAK_WATCH_FENCE_LOST' });
      watch = { ...watch, status: 'ACTIVE', lastFailureCode: null };
    }
    const ownedCase = await this.caseModel.findOne({
      userId: watch.userId,
      caseId: watch.caseId,
      deletedAt: null,
      consentWithdrawnAt: null,
      expiresAt: { $gt: currentTime },
    }).lean();
    if (!ownedCase) {
      await this.watchModel.updateOne({ watchId: watch.watchId, generation: watch.generation, status: 'ACTIVE' }, {
        $set: { status: 'EXPIRED', nextCheckAt: null, lastFailureCode: 'CASE_UNAVAILABLE' },
        $inc: { generation: 1 },
      });
      await this.jobModel.updateOne({ jobId: claimed.job.jobId, status: 'LEASED', leaseOwner: claimed.owner, executionGeneration: claimed.executionGeneration }, {
        $set: { status: 'CANCELLED', leaseOwner: null, leaseUntil: null, failureCode: 'CASE_UNAVAILABLE' },
      });
      return { status: 'CANCELLED' };
    }
    if (claimed.job.attempt > (claimed.job.maxAttempts || MAX_ATTEMPTS)) {
      throw Object.assign(new Error('The provider retry budget was exhausted after worker recovery.'), { code: 'PROOFBREAK_RETRY_EXHAUSTED' });
    }
    // Recheck the lease immediately before outbound retrieval. Pause, disable,
    // withdrawal, deletion, or a competing worker can fence the job while the
    // case/source setup above is running.
    await this.assertLease(claimed, jobAbortController);
    const observation = await this.refreshEvidence({ signer: this.signer, signal: jobAbortController?.signal });
    await this.assertLease(claimed, jobAbortController);
    const latest = await this.revisionModel.findOne({ userId: watch.userId, caseId: watch.caseId }).sort({ revision: -1 }).lean();
    if (!latest || latest.revision !== ownedCase.latestRevision || latest.manifestHash !== ownedCase.latestManifestHash) {
      throw Object.assign(new Error('The current GenieProof assessment head could not be loaded.'), { code: 'GENIEPROOF_CASE_HEAD_MISMATCH' });
    }
    const reassessmentKey = `proofbreak:${watch.watchId}:${claimed.job.scheduleKey}`;
    const result = await this.reassess({
      userId: watch.userId,
      caseId: watch.caseId,
      expectedRevision: latest.revision,
      expectedManifestHash: latest.manifestHash,
      reassessmentConsent: true,
      idempotencyKey: reassessmentKey,
      signer: this.signer,
      evidenceResolver: this.evidenceResolver,
      proofBreakRetrievalReceiptIds: Array.isArray(observation?.retrievalIds) ? observation.retrievalIds : [],
      now: this.now,
      startSession: this.startSession,
      watchFence: {
        watchId: watch.watchId,
        watchGeneration: claimed.job.watchGeneration,
        jobId: claimed.job.jobId,
        leaseOwner: claimed.owner,
        executionGeneration: claimed.executionGeneration,
      },
      watchModel: this.watchModel,
      jobModel: this.jobModel,
      eventModel: this.eventModel,
      outboxModel: this.outboxModel,
    });
    return { status: result.created ? 'COMPLETED' : 'REPLAYED', revision: result.revision };
  }

  async stop({ graceMs = 10_000 } = {}) {
    this.draining = true;
    this.running = false;
    if (this.timer) this.clearIntervalImpl(this.timer);
    this.timer = null;
    if (this.heartbeatTimer) this.clearIntervalImpl(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.leaseHeartbeatTimer) this.clearIntervalImpl(this.leaseHeartbeatTimer);
    this.leaseHeartbeatTimer = null;
    this.abortController?.abort(Object.assign(new Error('ProofBreak worker shutdown requested.'), { code: 'PROOFBREAK_WORKER_STOPPING' }));
    if (this.heartbeatInFlight) await this.heartbeatInFlight;
    this.workerStatus = 'STOPPED';
    await this.publishHeartbeat('STOPPED').catch(() => {});
    if (!this.activePromise) return { drained: true };
    let timer;
    const drained = await Promise.race([
      this.activePromise.then(() => true, () => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, graceMs)); }),
    ]);
    clearTimeout(timer);
    return { drained };
  }
}

export function createProofBreakWorker(options = {}) { return new ProofBreakWorker(options); }
