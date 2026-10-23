/**
 * Durable Runway projection outbox. No external queue, no LLM, no paid API.
 * A worker can be restarted without losing a committed ledger update.
 */
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { RunwayLedgerRevision } from '../models/Runway.js';
import { RunwayProjectionJob, RunwayProjectionResult, RunwayAlert } from '../models/RunwayProjection.js';
import { RunwaySignal } from '../models/RunwayEvidence.js';
import { canonicalSha256, canonicalJson } from '../utils/canonicalJson.js';
import { verifyRunwayLedgerSeal, assertRunwaySigningKey } from './runwaySeal.js';
import { simulateRunway } from './runwayEngine.js';
import {
  encryptRunwayProjectionResult, decryptRunwayProjectionResult,
} from './runwayEvidenceCrypto.js';

const LEASE_MS = 45_000;
export const MAX_ATTEMPTS = 5;
const HORIZON_DAYS = 90;
const RE = /^[a-f0-9]{64}$/;
const SIGN_DOMAIN = 'wealthgenie:runway:projection-result:v1:';
export const runwayProjectionId = (userId, revision) =>
  canonicalSha256({ purpose: 'RUNWAY_PROJECTION_V1', owner: String(userId), revision });

function failed(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}
function seal(record, env = process.env) {
  assertRunwaySigningKey(env);
  const key = String(env.RUNWAY_INTEGRITY_SECRET);
  // Same validated key contract as ledger signing, separate domain.
  const hmac = crypto.createHmac('sha256', /^[a-fA-F0-9]{64,}$/.test(key)
    ? Buffer.from(key, 'hex') : Buffer.from(key, 'utf8'));
  return hmac.update(SIGN_DOMAIN).update(canonicalJson({
    id: String(record._id), userId: String(record.userId), revision: record.revision,
    inputHash: record.inputHash, engineVersion: record.engineVersion,
    resultHash: record.resultHash, result: record.result, computedAt: record.computedAt,
  })).digest('hex');
}
export function verifyRunwayProjectionResult(record, env = process.env) {
  if (!record || !RE.test(record.resultHash || '') || !RE.test(record.sealHmac || '')) return false;
  let plaintext;
  try { plaintext = decryptRunwayProjectionResult(record, env); } catch { return false; }
  if (canonicalSha256(plaintext) !== record.resultHash) return false;
  const expected = seal(record, env);
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(record.sealHmac, 'hex'));
}
export async function queueRunwayProjection(userId, revision, inputHash, session) {
  if (!Number.isSafeInteger(revision) || revision < 1 || !RE.test(inputHash || '')) {
    throw failed('RUNWAY_PROJECTION_BAD_SOURCE');
  }
  const now = new Date();
  const _id = runwayProjectionId(userId, revision);
  await RunwayProjectionJob.create([{
    _id, userId, revision, inputHash, status: 'PENDING',
    availableAt: now, attempts: 0,
  }], { session });
  return _id;
}
export function calculateRunwayProjection(revision) {
  if (!revision || canonicalSha256(revision.ledger) !== revision.inputHash
    || !verifyRunwayLedgerSeal(revision)) throw failed('RUNWAY_PROJECTION_SOURCE_INTEGRITY');
  return simulateRunway(revision.ledger, {
    ledgerRevision: revision.revision, horizonDays: HORIZON_DAYS, scenarios: [],
  });
}
/**
 * Terminal recovery for a worker killed repeatedly while holding a lease.
 * Without this transition expired LEASED jobs can be reclaimed forever,
 * overflow the schema attempt counter, and make the queue appear healthy.
 * Metadata only; does not touch financial evidence or already stored results.
 */
export async function quarantineExhaustedRunwayProjectionJobs({
  at = new Date(), jobModel = RunwayProjectionJob,
} = {}) {
  const filter = {
    attempts: { $gte: MAX_ATTEMPTS },
    $or: [
      { status: 'LEASED', leaseUntil: { $lte: at } },
      { status: 'PENDING', availableAt: { $lte: at } },
    ],
  };
  const result = await jobModel.updateMany(filter, {
    $set: {
      status: 'BLOCKED', leaseToken: null, leaseUntil: null,
      lastErrorCode: 'RUNWAY_PROJECTION_LEASE_EXHAUSTED',
    },
  });
  return result.modifiedCount || 0;
}
export async function processOneRunwayProjection({
  now = () => new Date(), randomUUID = () => crypto.randomUUID(),
  jobModel = RunwayProjectionJob, resultModel = RunwayProjectionResult,
  revisionModel = RunwayLedgerRevision, alertModel = RunwayAlert,
  signalModel = RunwaySignal, sessionFactory = () => mongoose.startSession(),
} = {}) {
  const at = now();
  const token = randomUUID();
  const exhausted = await quarantineExhaustedRunwayProjectionJobs({ at, jobModel });
  if (exhausted) {
    return {
      status: 'BLOCKED', code: 'RUNWAY_PROJECTION_LEASE_EXHAUSTED', count: exhausted,
    };
  }
  // Due states include expired leases. DB compare-and-swap guarantees
  // one live owner per token; stolen claims cannot publish financial results.
  const job = await jobModel.findOneAndUpdate({
    attempts: { $lt: MAX_ATTEMPTS },
    $or: [
      { status: 'PENDING', availableAt: { $lte: at } },
      { status: 'LEASED', leaseUntil: { $lte: at } },
    ],
  }, { $set: { status: 'LEASED', leaseToken: token,
    leaseUntil: new Date(at.getTime() + LEASE_MS) },
  $inc: { attempts: 1 } }, {
    sort: { availableAt: 1, _id: 1 }, new: true, lean: true,
  });
  if (!job) return { status: 'IDLE' };
  let code = null;
  try {
    const source = await revisionModel.findOne({
      userId: job.userId, revision: job.revision,
    }).lean();
    if (!source || source.inputHash !== job.inputHash) throw failed('RUNWAY_PROJECTION_SOURCE_MISSING');
    const computed = calculateRunwayProjection(source);
    const record = {
      _id: job._id, userId: job.userId, revision: job.revision,
      inputHash: job.inputHash, resultHash: canonicalSha256(computed),
      engineVersion: computed.engineVersion, computedAt: now(),
    };
    record.result = encryptRunwayProjectionResult({ ...record, result: computed });
    record.sealHmac = seal(record);
    const session = await sessionFactory();
    try {
      await session.withTransaction(async () => {
        const held = await jobModel.findOne({
          _id: job._id, userId: job.userId, status: 'LEASED', leaseToken: token,
          leaseUntil: { $gt: now() },
        }).session(session).lean();
        if (!held) throw failed('RUNWAY_PROJECTION_LEASE_LOST');
        const prior = await resultModel.findById(job._id).session(session).lean();
        if (prior) {
          if (!verifyRunwayProjectionResult(prior)
            || prior.inputHash !== job.inputHash || prior.revision !== job.revision
            || prior.resultHash !== record.resultHash) {
            throw failed('RUNWAY_PROJECTION_REPLAY_CONFLICT');
          }
        } else {
          await resultModel.create([record], { session });
        }
        // A warning is persisted in the SAME transaction as the completed
        // projection; neither duplicated warnings nor phantom warning rows
        // can survive crash recovery.
        const risk = computed.scenarios?.[0]?.cashAlreadyAvailable?.firstCertainShortfall;
        if (risk) {
          const alertId = canonicalSha256({
            purpose: 'RUNWAY_ALERT_V1', userId: String(job.userId),
            revision: job.revision, kind: 'LISTED_CASH_SHORTFALL',
          });
          const presentAlert = await alertModel.findById(alertId).session(session).lean();
          if (presentAlert) {
            if (presentAlert.resultHash !== record.resultHash
              || presentAlert.projectionId !== job._id) {
              throw failed('RUNWAY_PROJECTION_ALERT_CONFLICT');
            }
          } else {
            await alertModel.create([{
              _id: alertId, userId: job.userId, revision: job.revision,
              projectionId: job._id, resultHash: record.resultHash,
              kind: 'LISTED_CASH_SHORTFALL', createdAt: now(),
            }], { session });
          }
        }
        const applied = await jobModel.updateOne({
          _id: job._id, status: 'LEASED', leaseToken: token,
        }, { $set: { status: 'DONE', leaseToken: null, leaseUntil: null, lastErrorCode: null } },
        { session });
        if (applied.matchedCount !== 1) throw failed('RUNWAY_PROJECTION_LEASE_LOST');
        const createdAt = now();
        await signalModel.create([{
          userId: job.userId, eventType: 'PROJECTION_READY', occurredAt: createdAt,
          expiresAt: new Date(createdAt.getTime() + 7 * 24 * 60 * 60 * 1000),
        }], { session });
      });
    } finally { await session.endSession(); }
    return { status: 'DONE', revision: job.revision };
  } catch (error) {
    code = typeof error?.code === 'string' && /^RUNWAY_[A-Z_]+$/.test(error.code)
      ? error.code : 'RUNWAY_PROJECTION_PROCESSING_FAILED';
    const final = job.attempts >= MAX_ATTEMPTS || code === 'RUNWAY_PROJECTION_SOURCE_INTEGRITY'
      || code === 'RUNWAY_PROJECTION_REPLAY_CONFLICT'
      || code === 'RUNWAY_PROJECTION_SOURCE_MISSING'
      || code === 'RUNWAY_PROJECTION_ALERT_CONFLICT';
    await jobModel.updateOne({ _id: job._id, status: 'LEASED', leaseToken: token },
      { $set: { status: final ? 'BLOCKED' : 'PENDING', leaseToken: null, leaseUntil: null,
        availableAt: new Date(now().getTime() + Math.min(job.attempts * 5_000, 60_000)),
        lastErrorCode: code } });
    return { status: final ? 'BLOCKED' : 'RETRY', code };
  }
}
