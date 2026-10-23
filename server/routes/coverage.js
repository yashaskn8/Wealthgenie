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
import {
  validateCoverageLedger, calculateCoverage, previewVoluntaryExclusions,
  COVERAGE_POLICY_VERSION, CoverageInputError, parseCalendarDate,
} from '../services/coverageEngine.js';

const router = Router();
const noStore = (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
router.use(noStore);

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
  if (ageDays < 0 || ageDays > 1) {
    throw createError(
      400, 'Opening accessible cash must be dated today or yesterday in India.',
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
  await verifyPersistenceIndexes({ models: [CoverageLedger, CoverageResult, CoverageDeletionReceipt], scope: 'persistence' });
}
async function resolveCoverageReplay(req, record) {
  const snapshot = await CoverageResult.findOne({ _id: record.resourceId, userId: req.user.userId }).lean();
  if (!snapshot) throw createError(503, 'Committed coverage result is unavailable.', 'Coverage result unavailable.', {
    code: 'COVERAGE_RESULT_UNAVAILABLE',
  });
  return publicSnapshot(snapshot);
}

router.get('/ledger', verifyJWT, asyncHandler(async (req, res) => {
  const ledger = await CoverageLedger.findOne({ userId: req.user.userId }).lean();
  if (!ledger) return res.json({ revision: 0, ledger: null, latestResult: null });
  if (ledger.deletedAt || ledger.input === null) {
    return res.json({ revision: ledger.revision, ledger: null, latestResult: null, deleted: true });
  }
  const snapshot = await CoverageResult.findOne({
    userId: req.user.userId, ledgerRevision: ledger.revision, policyVersion: COVERAGE_POLICY_VERSION,
  }).lean();
  if (!snapshot) {
    throw createError(503, 'Ledger result missing for the current revision.', 'Coverage temporarily unavailable.', {
      code: 'COVERAGE_RESULT_UNAVAILABLE',
    });
  }
  return res.json({
    revision: ledger.revision,
    ledger: ledger.input,
    latestResult: publicSnapshot(snapshot),
    requiresCashReconfirmation: (parseCalendarDate(todayInIndia()) - parseCalendarDate(ledger.input.asOfDate)) >= 86_400_000,
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
    assertRecentDeclaredCash(req.coverageValidatedInput);
    await ready();
    next();
  }),
  idempotency({ operation: 'coverage.ledger.replace', resolveReplay: resolveCoverageReplay }),
  asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const expectedRevision = req.coverageExpectedRevision;
    const input = req.coverageValidatedInput;
    const calculation = calculateCoverage(input);
    const inputHash = canonicalSha256({ policyVersion: COVERAGE_POLICY_VERSION, input });
    let saved;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const current = await CoverageLedger.findOne({ userId }).session(session).lean();
        if (current ? current.revision !== expectedRevision : expectedRevision !== 0) throw conflict();
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
        await completeMutationIdempotency(session, req.idempotencyClaim, {
          resourceType: 'CoverageResult', resourceId: snapshot._id, status: 200,
        });
        saved = snapshot;
      });
      req.idempotencyCommitted = true;
    } catch (error) {
      if (error?.code === 11000 || error?.code === 'COVERAGE_REVISION_CONFLICT'
          || error?.status === 409) {
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
    return res.json(publicSnapshot(saved));
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
  if (!ledger) throw conflict();
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

router.get('/revisions/:revision', verifyJWT, asyncHandler(async (req, res) => {
  const revision = parseRevision(req.params.revision);
  const snapshot = await CoverageResult.findOne({
    userId: req.user.userId, ledgerRevision: revision, policyVersion: COVERAGE_POLICY_VERSION,
  }).lean();
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
      if (error?.status === 409 || error?.code === 11000) {
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
