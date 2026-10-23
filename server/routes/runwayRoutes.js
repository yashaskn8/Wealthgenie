import { Router } from 'express';
import mongoose from 'mongoose';
import { canonicalSha256 } from '../utils/canonicalJson.js';
import { verifyJWTWithRevocationAvailability as requireSession } from '../middleware/authMiddleware.js';
import { createEndpointRateLimiter, ipKeyGenerator } from '../middleware/rateLimiter.js';
import { asyncHandler, createError } from '../middleware/errorHandler.js';
import { RunwayInputError, simulateRunway, validateLedger, validateRequest } from '../services/runwayEngine.js';
import {
  RunwayLedgerState, RunwayLedgerRevision, RunwayMutationReceipt, RunwaySnapshot,
} from '../models/Runway.js';

const router = Router();
const KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const SNAPSHOT_ID = /^[a-f0-9]{64}$/;
const USER_ID = /^[a-f0-9]{24}$/i;
const MAX_SNAPSHOTS = 100;

const limiter = createEndpointRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 40,
  message: 'Household Runway rate limit reached. Try again later.',
  prefix: 'rl:ep:runway:',
  keyGenerator: req => req.user?.userId
    ? String(req.user.userId)
    : ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown'),
});

function failure(status, code, message) {
  return createError(status, message, message, { code });
}
function enable(req, _res, next) {
  if (req.app.locals.runwayEnabled !== true) return next(failure(404, 'FEATURE_UNAVAILABLE', 'Household Runway is not enabled.'));
  return next();
}
function owner(req) {
  const id = req.user?.userId;
  if (!USER_ID.test(String(id || ''))) throw failure(401, 'AUTH_TOKEN_INVALID', 'A valid user session is required.');
  return new mongoose.Types.ObjectId(id);
}
function assertShape(payload, keys) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).some(key => !keys.includes(key))) {
    throw failure(400, 'RUNWAY_INPUT_INVALID', 'Unexpected or missing request fields.');
  }
}
function indiaCivilToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const pick = type => parts.find(part => part.type === type)?.value;
  return pick('year') + '-' + pick('month') + '-' + pick('day');
}
function idempotency(req) {
  const key = req.get('Idempotency-Key');
  if (!key || !KEY.test(key)) throw failure(400, 'RUNWAY_IDEMPOTENCY_REQUIRED', 'Valid Idempotency-Key required.');
  return key;
}
function matchRevision(req) {
  const match = /^"(0|[1-9][0-9]{0,12})"$/.exec(req.get('If-Match') || '');
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw failure(428, 'RUNWAY_IF_MATCH_REQUIRED', 'A quoted If-Match revision is required.');
  return Number(match[1]);
}
async function currentRevision(userId, session = null) {
  const state = await RunwayLedgerState.findById(userId).session(session).lean();
  if (!state) return null;
  const revision = await RunwayLedgerRevision.findOne({ userId, revision: state.revision }).session(session).lean();
  if (!revision) throw failure(503, 'RUNWAY_INTEGRITY_UNAVAILABLE', 'Saved ledger could not be reconciled.');
  return { state, revision };
}
async function inTransaction(action) {
  const session = await mongoose.startSession();
  try {
    let output;
    await session.withTransaction(async () => { output = await action(session); }, {
      readPreference: 'primary', readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' },
    });
    return output;
  } finally {
    await session.endSession();
  }
}
function rethrowTransaction(error) {
  if (error?.code === 11000 || error?.code === 112 || error?.hasErrorLabel?.('TransientTransactionError')) {
    throw failure(409, 'RUNWAY_REVISION_CONFLICT', 'Ledger changed concurrently. Refresh and retry.');
  }
  throw error;
}
function serializeLedger(found) {
  return { revision: found.state.revision, ledger: found.revision.ledger, inputHash: found.revision.inputHash,
    confirmedAt: found.revision.confirmedAt };
}

router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use(requireSession, enable, limiter);

router.get('/current', asyncHandler(async (req, res) => {
  const found = await currentRevision(owner(req));
  if (!found) throw failure(404, 'RUNWAY_LEDGER_NOT_FOUND', 'No confirmed cash ledger exists.');
  return res.json(serializeLedger(found));
}));

router.put('/ledger', asyncHandler(async (req, res) => {
  const userId = owner(req);
  const key = idempotency(req);
  const expected = matchRevision(req);
  validateLedger(req.body);
  if (req.body.asOfDate !== indiaCivilToday()) throw failure(400, 'RUNWAY_CASH_CONFIRMATION_STALE', 'Confirm accessible cash for today in India before saving.');
  const ledger = req.body;
  const requestHash = canonicalSha256({ userId, ledger, expected, operation: 'LEDGER' });
  const receiptId = canonicalSha256({ operation: 'LEDGER', key, userId: String(userId) });
  const replay = await RunwayMutationReceipt.findOne({ _id: receiptId, userId }).lean();
  if (replay) {
    if (replay.requestHash !== requestHash) throw failure(409, 'RUNWAY_IDEMPOTENCY_CONFLICT', 'Idempotency key reused with different input.');
    const found = await currentRevision(userId);
    const rev = await RunwayLedgerRevision.findOne({ userId, revision: replay.revision }).lean();
    if (!rev) throw failure(503, 'RUNWAY_INTEGRITY_UNAVAILABLE', 'Committed revision is unavailable.');
    return res.status(200).json({ revision: rev.revision, ledger: rev.ledger, inputHash: rev.inputHash,
      confirmedAt: rev.confirmedAt, historical: found?.state.revision !== rev.revision, replayed: true });
  }
  if (expected >= Number.MAX_SAFE_INTEGER) throw failure(400, 'RUNWAY_REVISION_LIMIT', 'Revision counter is exhausted.');
  let created;
  try {
    created = await inTransaction(async session => {
      const previous = await RunwayLedgerState.findById(userId).session(session).lean();
      if ((previous?.revision || 0) !== expected) throw failure(409, 'RUNWAY_REVISION_CONFLICT', 'Ledger was edited elsewhere. Refresh before saving.');
      const next = expected + 1;
      const inputHash = canonicalSha256(ledger);
      await RunwayLedgerRevision.create([{ userId, revision: next, ledger, inputHash, confirmedAt: new Date() }], { session });
      if (!previous) await RunwayLedgerState.create([{ _id: userId, revision: next }], { session });
      else {
        const cas = await RunwayLedgerState.updateOne({ _id: userId, revision: expected }, { $set: { revision: next } }, { session });
        if (cas.matchedCount !== 1) throw failure(409, 'RUNWAY_REVISION_CONFLICT', 'Ledger was edited elsewhere.');
      }
      await RunwayMutationReceipt.create([{ _id: receiptId, userId, operation: 'LEDGER', requestHash, revision: next }], { session });
      return next;
    });
  } catch (error) { rethrowTransaction(error); }
  const found = await RunwayLedgerRevision.findOne({ userId, revision: created }).lean();
  return res.status(201).json({ revision: created, ledger: found.ledger, inputHash: found.inputHash, confirmedAt: found.confirmedAt, replayed: false });
}));

router.post('/simulations', asyncHandler(async (req, res) => {
  const userId = owner(req);
  const found = await currentRevision(userId);
  if (!found) throw failure(404, 'RUNWAY_LEDGER_NOT_FOUND', 'Confirm accessible cash before simulating.');
  if (req.body?.ledgerRevision !== found.state.revision) throw failure(409, 'RUNWAY_STALE_INPUT', 'Ledger changed. Refresh before simulating.');
  validateRequest(req.body, found.revision.ledger);
  if (found.revision.ledger.entries.length === 0) return res.json({ status: 'INSUFFICIENT_INPUT', unknowns: ['NO_LISTED_OBLIGATIONS'] });
  return res.json({ ledgerRevision: found.state.revision, inputHash: found.revision.inputHash,
    ...simulateRunway(found.revision.ledger, req.body) });
}));

router.post('/snapshots', asyncHandler(async (req, res) => {
  const userId = owner(req);
  const key = idempotency(req);
  assertShape(req.body, ['ledgerRevision', 'horizonDays', 'scenarios']);
  const snapshotId = canonicalSha256({ operation: 'SNAPSHOT', userId: String(userId), key });
  const requestHash = canonicalSha256({ operation: 'SNAPSHOT', userId: String(userId), request: req.body });
  const existing = await RunwaySnapshot.findOne({ _id: snapshotId, userId }).lean();
  if (existing) {
    if (existing.requestHash !== requestHash) throw failure(409, 'RUNWAY_IDEMPOTENCY_CONFLICT', 'Idempotency key reused with different input.');
    return res.json({ snapshotId, ledgerRevision: existing.ledgerRevision, replayed: true });
  }
  let saved;
  try {
    saved = await inTransaction(async session => {
      const found = await currentRevision(userId, session);
      if (!found || found.state.revision !== req.body.ledgerRevision) throw failure(409, 'RUNWAY_STALE_INPUT', 'Ledger changed. Refresh before saving.');
      validateRequest(req.body, found.revision.ledger);
      if (!found.revision.ledger.entries.length) throw failure(400, 'RUNWAY_INSUFFICIENT_INPUT', 'Add at least one dated obligation.');
      const count = await RunwaySnapshot.countDocuments({ userId }).session(session);
      if (count >= MAX_SNAPSHOTS) throw failure(409, 'RUNWAY_SNAPSHOT_LIMIT', 'Delete old Runway data before saving additional results.');
      const result = simulateRunway(found.revision.ledger, req.body);
      await RunwaySnapshot.create([{
        _id: snapshotId, userId, ledgerRevision: found.state.revision,
        inputHash: found.revision.inputHash, requestHash, request: req.body, result,
      }], { session });
      return { snapshotId, ledgerRevision: found.state.revision };
    });
  } catch (error) {
    if (error?.code === 11000) {
      const committed = await RunwaySnapshot.findOne({ _id: snapshotId, userId }).lean();
      if (committed) {
        if (committed.requestHash !== requestHash) throw failure(409, 'RUNWAY_IDEMPOTENCY_CONFLICT', 'Idempotency key reused with different input.');
        return res.json({ snapshotId, ledgerRevision: committed.ledgerRevision, replayed: true });
      }
    }
    rethrowTransaction(error);
  }
  return res.status(201).json({ ...saved, replayed: false });
}));

router.get('/snapshots/:id', asyncHandler(async (req, res) => {
  const userId = owner(req);
  if (!SNAPSHOT_ID.test(req.params.id)) throw failure(404, 'RUNWAY_SNAPSHOT_NOT_FOUND', 'Snapshot not found.');
  const snapshot = await RunwaySnapshot.findOne({ _id: req.params.id, userId }).lean();
  if (!snapshot) throw failure(404, 'RUNWAY_SNAPSHOT_NOT_FOUND', 'Snapshot not found.');
  const state = await RunwayLedgerState.findById(userId).lean();
  return res.json({ snapshotId: snapshot._id, ledgerRevision: snapshot.ledgerRevision, inputHash: snapshot.inputHash,
    status: state?.revision === snapshot.ledgerRevision ? 'CURRENT' : 'HISTORICAL',
    createdAt: snapshot.createdAt, request: snapshot.request, result: snapshot.result });
}));

router.post('/explanations', asyncHandler(async (req, res) => {
  assertShape(req.body, ['snapshotId']);
  if (!SNAPSHOT_ID.test(req.body.snapshotId || '')) throw failure(404, 'RUNWAY_SNAPSHOT_NOT_FOUND', 'Snapshot not found.');
  const userId = owner(req);
  const snapshot = await RunwaySnapshot.findOne({ _id: req.body.snapshotId, userId }).lean();
  if (!snapshot) throw failure(404, 'RUNWAY_SNAPSHOT_NOT_FOUND', 'Snapshot not found.');
  const messages = snapshot.result.scenarios.map(s => ({
    scenarioId: s.scenarioId,
    text: s.ifExpectedIncomeArrives.status === 'LISTED_SHORTFALL'
      ? 'A listed payment may exceed the modeled cash even if expected income arrives.'
      : s.ifExpectedIncomeArrives.status === 'SAME_DAY_TIMING_UNKNOWN'
        ? 'Receipt and payment timing on the same date may change whether listed payments can be covered.'
        : 'No shortfall was found among listed payments under the declared income schedule. Unlisted costs remain unknown.',
  }));
  return res.json({ source: 'LOCAL_DETERMINISTIC_TEMPLATE', modelUsed: false, messages,
    disclosure: 'Explanations do not replace source data, bank settlement evidence, or a financial adviser.' });
}));

router.delete('/data', asyncHandler(async (req, res) => {
  const userId = owner(req);
  assertShape(req.body, ['confirmation']);
  if (req.body.confirmation !== 'DELETE_RUNWAY_DATA') throw failure(400, 'RUNWAY_DELETE_CONFIRMATION', 'Explicit deletion confirmation required.');
  const age = Math.floor(Date.now() / 1000) - Number(req.user.iat);
  if (!Number.isFinite(age) || age < 0 || age > 300) throw failure(403, 'RUNWAY_RECENT_AUTH_REQUIRED', 'Sign in again before deleting Runway data.');
  await inTransaction(async session => {
    await RunwaySnapshot.deleteMany({ userId }, { session });
    await RunwayMutationReceipt.deleteMany({ userId }, { session });
    await RunwayLedgerRevision.deleteMany({ userId }, { session });
    await RunwayLedgerState.deleteOne({ _id: userId }, { session });
  });
  return res.json({ status: 'DELETED', scope: 'RUNWAY_PRIMARY_DATABASE', backupExpiryVerified: false });
}));

export default router;
