import { Router } from 'express';
import mongoose from 'mongoose';
import { verifyJWT } from '../middleware/authMiddleware.js';
import { asyncHandler, createError } from '../middleware/errorHandler.js';
import {
  idempotency, completeMutationIdempotency,
  resolveCommittedMutationForClaim,
} from '../middleware/idempotency.js';
import { verifyPersistenceIndexes } from '../services/persistenceIndexReadiness.js';
import { canonicalSha256 } from '../utils/canonicalJson.js';
import CoverageLedger from '../models/CoverageLedger.js';
import CoverageResult from '../models/CoverageResult.js';
import CoverageDeletionReceipt from '../models/CoverageDeletionReceipt.js';
import CoverageRiskAlert from '../models/CoverageRiskAlert.js';
import { evaluateCashRiskEvent } from '../services/coverageRiskPolicy.js';
import {
  validateCoverageLedger, calculateCoverage, previewVoluntaryExclusions,
  COVERAGE_POLICY_VERSION, CoverageInputError, parseCalendarDate,
} from '../services/coverageEngine.js';

const router = Router();
const MAX_SAVED_REVISIONS = 256;
const noStore = (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
router.use(noStore);

// Mongo write conflicts can surface as code 112 after two owners race to
// update the same revision. This is a stale revision, not an internal error.
function isRevisionRace(error) {
  return error?.code === 11000
    || error?.code === 112
    || error?.codeName === 'WriteConflict'
    || error?.code === 'COVERAGE_REVISION_CONFLICT';
}
function conflict() {
  return createError(409, 'Cash entries changed. Reload and reconcile before saving.', 'Cash entries changed.', {
    code: 'COVERAGE_REVISION_CONFLICT',
  });
}
function parseIfMatch(value) {
  const match = /^"((?:0|[1-9]\d{0,12}))"$/.exec(String(value || ''));
  if (!match || !Number.isSafeInteger(Number(match[1]))) {
    throw createError(428, 'If-Match with the quoted current ledger revision is required.', 'Ledger revision required.', {
      code: 'COVERAGE_IF_MATCH_REQUIRED',
    });
  }
  return Number(match[1]);
}
function parseRevision(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,12}$/.test(value)
      || !Number.isSafeInteger(Number(value))) {
    throw createError(400, 'Invalid ledger revision.', 'Invalid revision.', {
      code: 'COVERAGE_REVISION_INVALID',
    });
  }
  return Number(value);
}
function todayInIndia() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return byType.year + '-' + byType.month + '-' + byType.day;
}
function assertRecentDeclaredCash(input) {
  const today = parseCalendarDate(todayInIndia());
  const asOf = parseCalendarDate(input.asOfDate);
  const ageDays = (today - asOf) / 86_400_000;
  // A yesterday balance can already include paid bills. Require an explicitly
  // current declaration to avoid misrepresenting old cash as today's balance.
  if (ageDays !== 0) {
    throw createError(
      400, 'Opening accessible cash must be dated today in India.',
      'Please reconfirm your accessible cash for today.', { code: 'COVERAGE_CASH_AS_OF_STALE' },
    );
  }
}
function publicSnapshot(snapshot) {
  return {
    revision: snapshot.ledgerRevision,
    inputHash: snapshot.inputHash,
    calculatedAt: snapshot.createdAt,
    policyVersion: snapshot.policyVersion,
    result: snapshot.calculation,
  };
}
async function ready() {
  await verifyPersistenceIndexes({ models: [CoverageLedger, CoverageResult, CoverageDeletionReceipt, CoverageRiskAlert], scope: 'persistence' });
}
async function resolveCoverageReplay(req, record) {
  const snapshot = await CoverageResult.findOne({ _id: record.resourceId, userId: req.user.userId }).lean();
  if (!snapshot) throw createError(503, 'Committed coverage result is unavailable.', 'Coverage result unavailable.', {
    code: 'COVERAGE_RESULT_UNAVAILABLE',
  });
  // A historical retry can be correct but superseded by a newer save.
  const current = await CoverageLedger.findOne({ userId: req.user.userId })
    .select('revision deletedAt').lean();
  return {
    ...publicSnapshot(snapshot), replayed: true,
    superseded: !current || Boolean(current.deletedAt)
      || current.revision !== snapshot.ledgerRevision
      || snapshot.policyVersion !== COVERAGE_POLICY_VERSION,
    currentRevision: current?.revision ?? null,
  };
}

router.get('/ledger', verifyJWT, asyncHandler(async (req, res) => {
  const ledger = await CoverageLedger.findOne({ userId: req.user.userId }).lean();
  if (!ledger) return res.json({ revision: 0, ledger: null, latestResult: null });
  if (ledger.deletedAt || ledger.input === null) {
    return res.json({ revision: ledger.revision, ledger: null, latestResult: null, deleted: true });
  }
  // Model upgrades must not brick all existing plans: load the exact current
  // policy when present, otherwise disclose the retained historical policy
  // and require an explicit new declaration. Never silently reuse old results.
  const snapshot = await CoverageResult.findOne({
    userId: req.user.userId, ledgerRevision: ledger.revision, policyVersion: COVERAGE_POLICY_VERSION,
  }).lean() || await CoverageResult.findOne({
    userId: req.user.userId, ledgerRevision: ledger.revision,
  }).sort({ createdAt: -1 }).lean();
  if (!snapshot) {
    throw createError(503, 'Ledger result missing for the current revision.', 'Coverage temporarily unavailable.', {
      code: 'COVERAGE_RESULT_UNAVAILABLE',
    });
  }
  return res.json({
    revision: ledger.revision,
    ledger: ledger.input,
    latestResult: publicSnapshot(snapshot),
    requiresPolicyReconfirmation: snapshot.policyVersion !== COVERAGE_POLICY_VERSION,
    requiresCashReconfirmation: parseCalendarDate(todayInIndia()) !== parseCalendarDate(ledger.input.asOfDate),
  });
}));

router.put(
  '/ledger',
  verifyJWT,
  asyncHandler(async (req, _res, next) => {
    req.coverageExpectedRevision = parseIfMatch(req.headers['if-match']);
    try {
      req.coverageValidatedInput = validateCoverageLedger(req.body);
    } catch (error) {
      if (error instanceof CoverageInputError) {
        throw createError(400, error.message, error.message, { code: error.code });
      }
      throw error;
    }
    await ready();
    next();
  }),
  idempotency({ operation: 'coverage.ledger.replace', resolveReplay: resolveCoverageReplay }),
  asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const expectedRevision = req.coverageExpectedRevision;
    const input = req.coverageValidatedInput;
    // Do not reject a legitimate replay merely because India moved to a new day.
    // This check applies to new mutations only; the durable replay path precedes it.
    assertRecentDeclaredCash(input);
    const calculation = calculateCoverage(input);
    const inputHash = canonicalSha256({ policyVersion: COVERAGE_POLICY_VERSION, input });
    let saved;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const current = await CoverageLedger.findOne({ userId }).session(session).lean();
        if (current ? current.revision !== expectedRevision : expectedRevision !== 0) throw conflict();
        const storedCount = await CoverageResult.countDocuments({ userId }).session(session);
        const previous = current && !current.deletedAt ? await CoverageResult.findOne({
          userId, ledgerRevision: expectedRevision,
        }).session(session).lean() : null;
        if (current && !current.deletedAt && !previous) {
          throw createError(503, 'Prior cash snapshot missing; refusing ungrounded risk transition.',
            'Cash calculation history unavailable.', { code: 'COVERAGE_RESULT_UNAVAILABLE' });
        }
        if (storedCount >= MAX_SAVED_REVISIONS) {
          throw createError(409,
            'The saved history limit is reached; export and delete the old cash plan before creating a new one.',
            'Saved cash history has reached its 256-revision limit.',
            { code: 'COVERAGE_HISTORY_LIMIT_REACHED' });
        }
        const revision = expectedRevision + 1;
        if (current) {
          const mutation = await CoverageLedger.updateOne(
            { _id: current._id, userId, revision: expectedRevision },
            { $set: { input, deletedAt: null }, $inc: { revision: 1 } },
            { session, runValidators: true },
          );
          if (mutation.modifiedCount !== 1) throw conflict();
        } else {
          await CoverageLedger.create([{ userId, revision, input }], { session });
        }
        const [snapshot] = await CoverageResult.create([{
          userId, ledgerRevision: revision, policyVersion: COVERAGE_POLICY_VERSION,
          inputHash, input, calculation,
        }], { session });
        await CoverageRiskAlert.updateMany({ userId, state: 'UNREAD' },
          { $set: { state: 'SUPERSEDED' } }, { session });
        const event = evaluateCashRiskEvent({
          userId, revision, input, result: calculation, priorResult: previous?.calculation || null,
        });
        if (event) await CoverageRiskAlert.create([event], { session });
        await completeMutationIdempotency(session, req.idempotencyClaim, {
          resourceType: 'CoverageResult', resourceId: snapshot._id, status: 200,
        });
        saved = snapshot;
      });
      req.idempotencyCommitted = true;
    } catch (error) {
      if (isRevisionRace(error)) {
        const completed = await resolveCommittedMutationForClaim(req, req.idempotencyClaim);
        if (completed) {
          req.idempotencyCommitted = true;
          return res.status(completed.status).json(completed.body);
        }
        throw conflict();
      }
      throw error;
    } finally {
      await session.endSession();
    }
    return res.json({ ...publicSnapshot(saved), replayed: false, superseded: false });
  }),
);

router.post('/scenarios/preview', verifyJWT, asyncHandler(async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(k => !['revision', 'excludedVoluntaryEntryIds'].includes(k))
      || !Number.isSafeInteger(body.revision) || body.revision < 1) {
    throw createError(400, 'Revision and voluntary contribution exclusions required.', 'Invalid preview.', {
      code: 'COVERAGE_PREVIEW_INVALID',
    });
  }
  const ledger = await CoverageLedger.findOne({ userId: req.user.userId, revision: body.revision }).lean();
  if (!ledger || ledger.deletedAt || ledger.input === null) throw conflict();
  assertRecentDeclaredCash(ledger.input);
  const currentPolicySnapshot = await CoverageResult.exists({
    userId: req.user.userId, ledgerRevision: body.revision,
    policyVersion: COVERAGE_POLICY_VERSION,
  });
  if (!currentPolicySnapshot) {
    throw createError(
      409, 'Reconfirm your entries and save a new cash plan before requesting a hypothetical calculation.',
      'Cash calculation policy has changed.', { code: 'COVERAGE_POLICY_RECONFIRMATION_REQUIRED' },
    );
  }
  let result;
  try {
    result = previewVoluntaryExclusions(ledger.input, body.excludedVoluntaryEntryIds);
  } catch (error) {
    if (error instanceof CoverageInputError) {
      throw createError(400, error.message, error.message, { code: error.code });
    }
    throw error;
  }
  const stillCurrent = await CoverageLedger.exists({
    _id: ledger._id, userId: req.user.userId, revision: body.revision,
  });
  if (!stillCurrent) throw conflict();
  return res.json({ revision: body.revision, hypothetical: true, result });
}));


router.get('/alerts', verifyJWT, asyncHandler(async (req, res) => {
  if (Object.keys(req.query).some(key => key !== 'limit')
      || (req.query.limit !== undefined && (typeof req.query.limit !== 'string'
        || !/^(?:[1-9]|1\d|20)$/.test(req.query.limit)))) {
    throw createError(400, 'Invalid alerts request.', 'Invalid alerts request.',
      { code: 'COVERAGE_ALERT_QUERY_INVALID' });
  }
  const owner = req.user.userId;
  const limit = Number(req.query.limit || '20');
  const ledger = await CoverageLedger.findOne({ userId: owner }).select('revision deletedAt').lean();
  if (!ledger || ledger.deletedAt) return res.json({ revision: ledger?.revision || 0, alerts: [] });
  const rows = await CoverageRiskAlert.find({
    userId: owner, ledgerRevision: ledger.revision, state: { $ne: 'SUPERSEDED' },
  }).sort({ createdAt: -1, _id: -1 }).limit(limit).lean();
  if (!await CoverageLedger.exists({
    _id: ledger._id, userId: owner, revision: ledger.revision, deletedAt: null,
  })) throw conflict();
  return res.json({ revision: ledger.revision, alerts: rows.map(row => ({
    id: String(row._id), kind: row.kind, dueDate: row.dueDate,
    sourceAsOfDate: row.sourceAsOfDate, createdAt: row.createdAt,
    acknowledged: row.state === 'ACKNOWLEDGED',
  })) });
}));
router.patch('/alerts/:id/ack', verifyJWT, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)
      || !req.body || typeof req.body !== 'object'
      || Array.isArray(req.body) || Object.keys(req.body).length !== 0) {
    throw createError(400, 'Invalid alert acknowledgement.', 'Invalid alert acknowledgement.',
      { code: 'COVERAGE_ACK_INVALID' });
  }
  const owner = req.user.userId;
  const ledger = await CoverageLedger.findOne({ userId: owner }).select('revision deletedAt').lean();
  if (!ledger || ledger.deletedAt) {
    throw createError(404, 'Current alert not found.', 'Alert not found.',
      { code: 'COVERAGE_ALERT_NOT_FOUND' });
  }
  // User-visible acknowledgement is idempotent and only scoped to the
  // current owner's current revision.
  const changed = await CoverageRiskAlert.findOneAndUpdate({
    _id: req.params.id, userId: owner, ledgerRevision: ledger.revision, state: 'UNREAD',
  }, { $set: { state: 'ACKNOWLEDGED', acknowledgedAt: new Date() } },
  { new: true, runValidators: true }).lean();
  const saved = changed || await CoverageRiskAlert.findOne({
    _id: req.params.id, userId: owner, ledgerRevision: ledger.revision, state: 'ACKNOWLEDGED',
  }).lean();
  if (!saved) {
    throw createError(404, 'Current alert not found.', 'Alert not found.',
      { code: 'COVERAGE_ALERT_NOT_FOUND' });
  }
  if (!await CoverageLedger.exists({
    _id: ledger._id, userId: owner, revision: ledger.revision, deletedAt: null,
  })) throw conflict();
  return res.json({ id: String(saved._id), acknowledged: true, revision: ledger.revision });
}));

// Privacy export: bounded, cursor-paginated owned data, never an unbounded query.
router.get('/export', verifyJWT, asyncHandler(async (req, res) => {
  if (Object.keys(req.query).some(key => !['afterRevision', 'limit'].includes(key))) {
    throw createError(400, 'Unknown export parameters.', 'Invalid export parameters.', { code: 'COVERAGE_EXPORT_INVALID' });
  }
  const rawAfter = req.query.afterRevision ?? '0';
  const rawLimit = req.query.limit ?? '20';
  if (typeof rawAfter !== 'string' || !/^(0|[1-9]\d{0,12})$/.test(rawAfter)
      || typeof rawLimit !== 'string' || !/^[1-9]\d?$|^20$/.test(rawLimit)) {
    throw createError(400, 'Invalid export cursor or limit.', 'Invalid export request.', { code: 'COVERAGE_EXPORT_INVALID' });
  }
  const afterRevision = Number(rawAfter);
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(afterRevision) || !Number.isSafeInteger(limit) || limit > 20) {
    throw createError(400, 'Invalid export cursor or limit.', 'Invalid export request.', { code: 'COVERAGE_EXPORT_INVALID' });
  }
  const owner = req.user.userId;
  const snapshots = await CoverageResult.find({
    userId: owner, ledgerRevision: { $gt: afterRevision },
  }).sort({ ledgerRevision: 1 }).limit(limit + 1).lean();
  const page = snapshots.slice(0, limit);
  return res.json({
    records: page.map(row => ({ ...publicSnapshot(row), input: row.input })),
    nextAfterRevision: snapshots.length > limit ? page[page.length - 1].ledgerRevision : null,
    userDeclaredOnly: true,
  });
}));

router.get('/revisions/:revision', verifyJWT, asyncHandler(async (req, res) => {
  const revision = parseRevision(req.params.revision);
  const snapshot = await CoverageResult.findOne({
    userId: req.user.userId, ledgerRevision: revision,
  }).sort({ createdAt: -1 }).lean();
  if (!snapshot) {
    throw createError(404, 'Coverage revision not found.', 'Coverage revision not found.', {
      code: 'COVERAGE_REVISION_NOT_FOUND',
    });
  }
  res.json({ ...publicSnapshot(snapshot), input: snapshot.input });
}));


async function resolveDeletionReplay(req, record) {
  const receipt = await CoverageDeletionReceipt.findOne({
    _id: record.resourceId, userId: req.user.userId,
    idempotencyOperationId: record._id,
  }).lean();
  if (!receipt) {
    throw createError(503, 'Committed deletion receipt is unavailable.', 'Deletion state unavailable.', {
      code: 'COVERAGE_DELETION_STATE_UNAVAILABLE',
    });
  }
  return { deleted: true, deletedRevision: receipt.deletedRevision,
    nextRevision: receipt.nextRevision, deletedAt: receipt.deletedAt };
}

/**
 * Explicit, revision-bound removal of all saved cash plans and results.
 * A minimal receipt and hashed idempotency keys remain solely to prevent
 * deleted mutation requests being resurrected by retries.
 */
router.delete('/ledger',
  verifyJWT,
  asyncHandler(async (req, _res, next) => {
    req.coverageExpectedRevision = parseIfMatch(req.headers['if-match']);
    await ready();
    next();
  }),
  idempotency({ operation: 'coverage.ledger.delete', resolveReplay: resolveDeletionReplay }),
  asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const session = await mongoose.startSession();
    let deletedReceipt;
    try {
      await session.withTransaction(async () => {
        const ledger = await CoverageLedger.findOne({
          userId, revision: req.coverageExpectedRevision,
        }).session(session).lean();
        if (!ledger || ledger.deletedAt || !ledger.input) throw conflict();
        // A tombstone fences stale PUTs with If-Match:0 after deletion.
        // Retain the anonymous revision number, never the financial payload.
        const removed = await CoverageLedger.updateOne({
          _id: ledger._id, userId, revision: req.coverageExpectedRevision,
        }, { $set: { input: null, deletedAt: new Date() }, $inc: { revision: 1 } },
        { session, runValidators: true });
        if (removed.modifiedCount !== 1) throw conflict();
        await CoverageResult.deleteMany({ userId }, { session });
        await CoverageRiskAlert.deleteMany({ userId }, { session });
        const [receipt] = await CoverageDeletionReceipt.create([{
          userId, idempotencyOperationId: req.idempotencyClaim.operationId,
          deletedRevision: ledger.revision, nextRevision: ledger.revision + 1, deletedAt: new Date(),
        }], { session });
        await completeMutationIdempotency(session, req.idempotencyClaim, {
          resourceType: 'CoverageDeletionReceipt', resourceId: receipt._id, status: 200,
        });
        deletedReceipt = receipt;
      });
      req.idempotencyCommitted = true;
    } catch (error) {
      if (isRevisionRace(error)) {
        const completed = await resolveCommittedMutationForClaim(req, req.idempotencyClaim);
        if (completed) {
          req.idempotencyCommitted = true;
          return res.status(completed.status).json(completed.body);
        }
        throw conflict();
      }
      throw error;
    } finally {
      await session.endSession();
    }
    return res.json({
      deleted: true, deletedRevision: deletedReceipt.deletedRevision,
      nextRevision: deletedReceipt.nextRevision,
      deletedAt: deletedReceipt.deletedAt,
    });
  }),
);

export default router;
