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
import CoverageSettlement from '../models/CoverageSettlement.js';
import IdempotencyKey from '../models/IdempotencyKey.js';
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
  await verifyPersistenceIndexes({ models: [CoverageLedger, CoverageResult, CoverageDeletionReceipt, CoverageRiskAlert, CoverageSettlement], scope: 'persistence' });
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

async function resolveSettlementReplay(req, record) {
  const replay = await resolveCoverageReplay(req, record);
  const receipt = await CoverageSettlement.findOne({
    userId: req.user.userId, ledgerRevision: replay.revision,
    entryId: req.params.entryId,
  }).select('entryId').lean();
  if (!receipt) {
    throw createError(503, 'Committed settlement audit unavailable.',
      'Settlement confirmation unavailable.', { code: 'COVERAGE_SETTLEMENT_AUDIT_UNAVAILABLE' });
  }
  return { ...replay, userConfirmedSettlement: true,
    settledEntryId: receipt.entryId, bankVerified: false };
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
  // A concurrent save/delete can commit while the historical snapshot is
  // loading. As in the export endpoints, never label that snapshot as current
  // once its owning ledger revision has changed or been tombstoned.
  const stillCurrent = await CoverageLedger.exists({
    _id: ledger._id, userId: req.user.userId,
    revision: ledger.revision, deletedAt: null,
  });
  if (!stillCurrent) throw conflict();
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
          userId, revision, input, result: calculation,
          // Retired calculation policies are not comparable risk baselines.
          priorResult: previous?.policyVersion === COVERAGE_POLICY_VERSION
            ? previous.calculation : null,
        });
        if (event) await CoverageRiskAlert.create([event], { session });
        await completeMutationIdempotency(session, req.idempotencyClaim, {
          resourceType: 'CoverageResult', resourceId: snapshot._id, status: 200,
        });
        saved = snapshot;
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
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


/** Explicit settlement of a SINGLE planned one-off payment.
 * Users must confirm a refreshed cash balance AFTER the payment. Without it,
 * deleting a planned debit would falsely inflate the forecast.
 */
router.post('/commitments/:entryId/settle',
  verifyJWT,
  asyncHandler(async (req, _res, next) => {
    req.coverageExpectedRevision = parseIfMatch(req.headers['if-match']);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(req.params.entryId || '')) {
      throw createError(400, 'Invalid commitment identity.', 'Invalid commitment.',
        { code: 'COVERAGE_COMMITMENT_INVALID' });
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => !['asOfDate', 'openingCashPaise', 'completenessConfirmed', 'settlementConfirmed'].includes(key))
        || body.settlementConfirmed !== true || body.completenessConfirmed !== true
        || !Number.isSafeInteger(body.openingCashPaise)
        || body.openingCashPaise < 0 || body.openingCashPaise > 1_000_000_000_000) {
      throw createError(400, 'Reconfirm cash AFTER the payment and explicitly attest settlement.',
        'Cash and settlement confirmation required.', { code: 'COVERAGE_SETTLEMENT_INVALID' });
    }
    // Only syntactic validation runs before idempotency. A previously
    // committed settlement must still replay correctly after India midnight.
    try {
      parseCalendarDate(body.asOfDate);
    } catch (error) {
      if (error instanceof CoverageInputError) {
        throw createError(400, error.message, error.message, { code: error.code });
      }
      throw error;
    }
    await ready();
    next();
  }),
  idempotency({ operation: 'coverage.commitment.settle', resolveReplay: resolveSettlementReplay }),
  asyncHandler(async (req, res) => {
    assertRecentDeclaredCash({ asOfDate: req.body.asOfDate });
    const userId = req.user.userId;
    const expectedRevision = req.coverageExpectedRevision;
    let resultSnapshot;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const existing = await CoverageLedger.findOne({ userId, revision: expectedRevision,
          deletedAt: null }).session(session).lean();
        if (!existing?.input) throw conflict();
        const target = existing.input.entries?.find(entry => entry.id === req.params.entryId);
        if (!target || target.recurrence !== 'ONCE' || target.type === 'EXPECTED_INCOME') {
          throw createError(409, 'Only one-off user-confirmed outflows may be settled. Recurring bills require manual date review.',
            'Cannot automatically settle this commitment.',
            { code: 'COVERAGE_SETTLEMENT_NOT_ONE_OFF' });
        }
        const input = validateCoverageLedger({
          ...existing.input,
          asOfDate: req.body.asOfDate,
          openingCashPaise: req.body.openingCashPaise,
          completenessConfirmed: true,
          entries: existing.input.entries.filter(entry => entry.id !== target.id),
        });
        const count = await CoverageResult.countDocuments({ userId }).session(session);
        if (count >= MAX_SAVED_REVISIONS) {
          throw createError(409, 'Cash history capacity reached.',
            'Export and archive financial history before another revision.',
            { code: 'COVERAGE_HISTORY_LIMIT_REACHED' });
        }
        const prior = await CoverageResult.findOne({
          userId, ledgerRevision: expectedRevision,
        }).session(session).lean();
        if (!prior) {
          throw createError(503, 'Previous saved calculation unavailable.',
            'Cash calculation history unavailable.', { code: 'COVERAGE_RESULT_UNAVAILABLE' });
        }
        const revision = expectedRevision + 1;
        const calculation = calculateCoverage(input);
        const inputHash = canonicalSha256({ policyVersion: COVERAGE_POLICY_VERSION, input });
        const cas = await CoverageLedger.updateOne({
          _id: existing._id, userId, revision: expectedRevision, deletedAt: null,
        }, { $set: { input }, $inc: { revision: 1 } },
        { session, runValidators: true });
        if (cas.modifiedCount !== 1) throw conflict();
        const [snapshot] = await CoverageResult.create([{
          userId, ledgerRevision: revision, policyVersion: COVERAGE_POLICY_VERSION,
          inputHash, input, calculation,
        }], { session });
        await CoverageSettlement.create([{
          userId, ledgerRevision: revision, priorRevision: expectedRevision,
          entryId: target.id, entryType: target.type, amountPaise: target.amountPaise,
          declaredAsOfDate: input.asOfDate, provenance: 'USER_CONFIRMED_NOT_BANK_VERIFIED',
        }], { session });
        await CoverageRiskAlert.updateMany({ userId, state: 'UNREAD' },
          { $set: { state: 'SUPERSEDED' } }, { session });
        const nextEvent = evaluateCashRiskEvent({
          userId, revision, input, result: calculation,
          priorResult: prior.policyVersion === COVERAGE_POLICY_VERSION
            ? prior.calculation : null,
        });
        if (nextEvent) await CoverageRiskAlert.create([nextEvent], { session });
        await completeMutationIdempotency(session, req.idempotencyClaim, {
          resourceType: 'CoverageResult', resourceId: snapshot._id, status: 200,
        });
        resultSnapshot = snapshot;
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
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
    return res.json({ ...publicSnapshot(resultSnapshot), userConfirmedSettlement: true,
      settledEntryId: req.params.entryId, bankVerified: false,
      replayed: false, superseded: false });
  }),
);

router.get('/settlements', verifyJWT, asyncHandler(async (req, res) => {
  const queryKeys = Object.keys(req.query);
  const exportMode = queryKeys.includes('afterRevision');
  if (queryKeys.some(key => !['afterRevision', 'limit'].includes(key))) {
    throw createError(400, 'Invalid settlements query.', 'Invalid settlements query.',
      { code: 'COVERAGE_SETTLEMENT_QUERY_INVALID' });
  }
  const rawCursor = req.query.afterRevision;
  const rawLimit = req.query.limit ?? '20';
  if (exportMode && (typeof rawCursor !== 'string'
      || !/^(0|[1-9]\d{0,12})$/.test(rawCursor)
      || !Number.isSafeInteger(Number(rawCursor)))) {
    throw createError(400, 'Invalid settlement export cursor.', 'Invalid settlement export cursor.',
      { code: 'COVERAGE_SETTLEMENT_QUERY_INVALID' });
  }
  if (typeof rawLimit !== 'string' || !/^(?:[1-9]|1\d|20)$/.test(rawLimit)) {
    throw createError(400, 'Invalid settlement export limit.', 'Invalid settlement export limit.',
      { code: 'COVERAGE_SETTLEMENT_QUERY_INVALID' });
  }
  const userId = req.user.userId;
  const current = await CoverageLedger.findOne({ userId }).select('revision deletedAt').lean();
  if (!current || current.deletedAt) {
    return res.json({ settlements: [], ...(exportMode ? { nextAfterRevision: null } : {}) });
  }
  const limit = Number(rawLimit);
  const rows = await CoverageSettlement.find({
    userId,
    ...(exportMode ? { ledgerRevision: { $gt: Number(rawCursor) } } : {}),
  }).sort({ ledgerRevision: exportMode ? 1 : -1 })
    .limit(exportMode ? limit + 1 : limit).lean();
  if (!await CoverageLedger.exists({
    _id: current._id, userId, revision: current.revision, deletedAt: null,
  })) throw conflict();
  const records = rows.slice(0, limit).map(row => ({
    ledgerRevision: row.ledgerRevision, entryId: row.entryId,
    amountPaise: row.amountPaise, entryType: row.entryType,
    declaredAsOfDate: row.declaredAsOfDate,
    provenance: row.provenance, createdAt: row.createdAt,
  }));
  return res.json({
    settlements: records,
    ...(exportMode ? {
      nextAfterRevision: rows.length > limit ? records.at(-1).ledgerRevision : null,
    } : {}),
  });
}));

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
  const ledger = await CoverageLedger.findOne({ userId: owner }).select('revision deletedAt input.asOfDate').lean();
  if (!ledger || ledger.deletedAt) return res.json({ revision: ledger?.revision || 0, alerts: [] });
  const requiresCashReconfirmation = ledger.input?.asOfDate !== todayInIndia();
  const currentPolicy = await CoverageResult.exists({
    userId: owner, ledgerRevision: ledger.revision, policyVersion: COVERAGE_POLICY_VERSION,
  });
  const requiresPolicyReconfirmation = !currentPolicy;
  // Invalidation rules are mutually exclusive:
  // - stale cash: ONLY dated cash reconfirmation notices
  // - current cash but retired policy: NO stale financial predictions
  // - current cash/current policy: ONLY current financial risk transitions
  // This also fences old reconfirmation messages generated before fresh cash
  // was attested, even when tests or clocks advance independently.
  const eligibleAlertKinds = requiresCashReconfirmation
    ? { kind: 'CASH_RECONFIRMATION_REQUIRED' }
    : requiresPolicyReconfirmation
      ? { kind: { $in: [] } }
      : { kind: { $ne: 'CASH_RECONFIRMATION_REQUIRED' } };
  const rows = await CoverageRiskAlert.find({
    userId: owner, ledgerRevision: ledger.revision, state: { $ne: 'SUPERSEDED' },
    ...eligibleAlertKinds,
  }).sort({ createdAt: -1, _id: -1 }).limit(limit).lean();
  if (!await CoverageLedger.exists({
    _id: ledger._id, userId: owner, revision: ledger.revision, deletedAt: null,
  })) throw conflict();
  return res.json({ revision: ledger.revision, requiresCashReconfirmation,
    requiresPolicyReconfirmation,
    alerts: rows.map(row => ({
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
  const session = await mongoose.startSession();
  let acknowledged;
  let revision;
  try {
    await session.withTransaction(async () => {
      // The acknowledgement and current cash revision share a write fence.
      // Without this touch, a concurrent delete/save can invalidate the
      // request while its acknowledgement remains committed.
      acknowledged = null;
      const ledger = await CoverageLedger.findOne({ userId: owner })
        .select('revision deletedAt input.asOfDate').session(session).lean();
      if (!ledger || ledger.deletedAt) {
        throw createError(404, 'Current alert not found.', 'Alert not found.',
          { code: 'COVERAGE_ALERT_NOT_FOUND' });
      }
      revision = ledger.revision;
      const requiresCashReconfirmation = ledger.input?.asOfDate !== todayInIndia();
      const currentPolicy = await CoverageResult.exists({
        userId: owner, ledgerRevision: revision, policyVersion: COVERAGE_POLICY_VERSION,
      }).session(session);
      const eligibleAlertKinds = requiresCashReconfirmation
        ? { kind: 'CASH_RECONFIRMATION_REQUIRED' }
        : !currentPolicy
          ? { kind: { $in: [] } }
          : { kind: { $ne: 'CASH_RECONFIRMATION_REQUIRED' } };
      const fence = await CoverageLedger.updateOne({
        _id: ledger._id, userId: owner, revision, deletedAt: null,
        'input.asOfDate': ledger.input.asOfDate,
      }, { $currentDate: { updatedAt: true } }, { session });
      if (fence.matchedCount !== 1) throw conflict();
      const changed = await CoverageRiskAlert.findOneAndUpdate({
        _id: req.params.id, userId: owner, ledgerRevision: revision,
        state: 'UNREAD', ...eligibleAlertKinds,
      }, { $set: { state: 'ACKNOWLEDGED', acknowledgedAt: new Date() } },
      { session, new: true, runValidators: true }).lean();
      const saved = changed || await CoverageRiskAlert.findOne({
        _id: req.params.id, userId: owner, ledgerRevision: revision,
        state: 'ACKNOWLEDGED', ...eligibleAlertKinds,
      }).session(session).lean();
      if (!saved) {
        throw createError(404, 'Current alert not found.', 'Alert not found.',
          { code: 'COVERAGE_ALERT_NOT_FOUND' });
      }
      acknowledged = saved;
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
  } catch (error) {
    if (isRevisionRace(error)) throw conflict();
    throw error;
  } finally {
    await session.endSession();
  }
  return res.json({ id: String(acknowledged._id), acknowledged: true, revision });
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
  // Never export orphaned or explicitly erased financial snapshots. A deleted
  // ledger must not be resurrected through a lagging history read.
  const ledger = await CoverageLedger.findOne({ userId: owner })
    .select('_id revision deletedAt').lean();
  if (!ledger || ledger.deletedAt) {
    return res.json({ records: [], nextAfterRevision: null, userDeclaredOnly: true });
  }
  const snapshots = await CoverageResult.find({
    userId: owner, ledgerRevision: { $gt: afterRevision, $lte: ledger.revision },
  }).sort({ ledgerRevision: 1 }).limit(limit + 1).lean();
  const page = snapshots.slice(0, limit);
  // A save or delete could commit while a page is being assembled. Refuse an
  // inconsistent export instead of returning a pre-delete snapshot as current.
  if (!await CoverageLedger.exists({
    _id: ledger._id, userId: owner, revision: ledger.revision, deletedAt: null,
  })) throw conflict();
  return res.json({
    records: page.map(row => ({ ...publicSnapshot(row), input: row.input })),
    nextAfterRevision: snapshots.length > limit ? page[page.length - 1].ledgerRevision : null,
    userDeclaredOnly: true,
  });
}));

router.get('/revisions/:revision', verifyJWT, asyncHandler(async (req, res) => {
  const revision = parseRevision(req.params.revision);
  const owner = req.user.userId;
  const ledger = await CoverageLedger.findOne({ userId: owner })
    .select('_id revision deletedAt').lean();
  // A deleted plan cannot be read using an orphaned retained snapshot.
  if (!ledger || ledger.deletedAt || revision > ledger.revision) {
    throw createError(404, 'Coverage revision not found.', 'Coverage revision not found.', {
      code: 'COVERAGE_REVISION_NOT_FOUND',
    });
  }
  const snapshot = await CoverageResult.findOne({
    userId: owner, ledgerRevision: revision,
  }).sort({ createdAt: -1 }).lean();
  if (!snapshot) {
    throw createError(404, 'Coverage revision not found.', 'Coverage revision not found.', {
      code: 'COVERAGE_REVISION_NOT_FOUND',
    });
  }
  if (!await CoverageLedger.exists({
    _id: ledger._id, userId: owner, revision: ledger.revision, deletedAt: null,
  })) throw conflict();
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
        await CoverageSettlement.deleteMany({ userId }, { session });
        // Privacy: historical cash-save/settlement request hashes are derived
        // from the user's amounts and obligations. Clear those command
        // identities along with the financial history in ONE transaction.
        // The ledger tombstone still rejects old If-Match retries. Keep the
        // deletion idempotency identity/receipt to replay a lost delete ACK.
        await IdempotencyKey.deleteMany({
          userId, operation: { $in: ['coverage.ledger.replace', 'coverage.commitment.settle'] },
        }, { session });
        const [receipt] = await CoverageDeletionReceipt.create([{
          userId, idempotencyOperationId: req.idempotencyClaim.operationId,
          deletedRevision: ledger.revision, nextRevision: ledger.revision + 1, deletedAt: new Date(),
        }], { session });
        await completeMutationIdempotency(session, req.idempotencyClaim, {
          resourceType: 'CoverageDeletionReceipt', resourceId: receipt._id, status: 200,
        });
        deletedReceipt = receipt;
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
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
