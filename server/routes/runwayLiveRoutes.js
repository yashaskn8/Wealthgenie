/**
 * Zero-fee bank-statement ingestion and owner-scoped live dashboard events.
 * Uploaded CSV is evidence supplied by the user, never an authenticated bank feed.
 */
import { Router } from 'express';
import mongoose from 'mongoose';
import { asyncHandler, createError } from '../middleware/errorHandler.js';
import { canonicalSha256 } from '../utils/canonicalJson.js';
import { parseRunwayStatement } from '../services/runwayStatementImport.js';
import { createRunwayStatementSeal, verifyRunwayStatementSeal, RUNWAY_SEAL_VERSION } from '../services/runwaySeal.js';
import { simulateRunway } from '../services/runwayEngine.js';
import { RunwayLedgerState } from '../models/Runway.js';
import { RunwayStatement, RunwaySignal } from '../models/RunwayEvidence.js';

const MAX_IMPORTS = 30;
const SIGNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const fail = (status, code, message) => createError(status, message, message, { code });

function summary(item) {
  const s = item.statement;
  return {
    statementId: item._id, accountLabel: s.accountLabel,
    periodStart: s.periodStart, periodEnd: s.periodEnd,
    openingBalancePaise: s.openingBalancePaise,
    closingBalancePaise: s.closingBalancePaise, transactionCount: s.transactionCount,
    verification: 'USER_IMPORTED_UNVERIFIED', importedAt: item.importedAt,
  };
}
function verified(item) {
  let authentic = false;
  try { authentic = verifyRunwayStatementSeal(item); } catch {
    throw fail(503, 'RUNWAY_EVIDENCE_KEY_UNAVAILABLE', 'Statement verification key is unavailable.');
  }
  if (!authentic || canonicalSha256({
    accountLabel: item.statement?.accountLabel, records: item.statement?.records,
  }) !== item.evidenceHash || item.statement?.evidenceHash !== item.evidenceHash) {
    throw fail(503, 'RUNWAY_EVIDENCE_INVALID', 'Imported statement authenticity could not be verified.');
  }
  return item;
}
export async function createRunwaySignal(userId, eventType, session) {
  const at = new Date();
  await RunwaySignal.create([{
    userId, eventType, occurredAt: at,
    expiresAt: new Date(at.getTime() + SIGNAL_RETENTION_MS),
  }], { session });
}
function possibleOverlaps(ledger, statement) {
  if (!ledger || !statement) return [];
  const hints = [];
  for (const item of ledger.entries) {
    if (item.recurrence !== 'NONE') continue;
    const key = item.kind === 'EXPECTED_INCOME' ? 'creditPaise' : 'debitPaise';
    const matches = statement.records.filter(row => row.date === item.date && row[key] === item.amountPaise);
    if (matches.length) hints.push({
      entryId: item.id, label: item.label, date: item.date,
      possibleMatchingRows: matches.length,
      status: 'UNVERIFIED_MATCH_REVIEW_REQUIRED',
    });
    if (hints.length === 12) break;
  }
  return hints;
}
function queryNumber(value, min, max) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw fail(400, 'RUNWAY_QUERY_INVALID', 'Invalid query parameter.');
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw fail(400, 'RUNWAY_QUERY_INVALID', 'Query parameter out of bounds.');
  }
  return n;
}
export function createRunwayLiveRouter({
  owner, currentRevision, inTransaction, rethrowTransaction,
  requireRecentSession, indiaCivilToday, requireRunwayIndexes,
}) {
  const router = Router();
  router.get('/overview', asyncHandler(async (req, res) => {
    const userId = owner(req);
    const horizonDays = req.query.horizonDays === undefined
      ? 90 : queryNumber(req.query.horizonDays, 1, 395);
    const current = await currentRevision(userId);
    const source = await RunwayStatement.findOne({ userId })
      .sort({ createdAt: -1, _id: -1 }).lean();
    const observed = source ? summary(verified(source)) : null;
    let modeled = { status: 'NO_CONFIRMED_LEDGER' };
    if (current) {
      if (current.revision.ledger.asOfDate !== indiaCivilToday()) {
        modeled = { status: 'CASH_CONFIRMATION_STALE', revision: current.state.revision };
      } else {
        const result = simulateRunway(current.revision.ledger, {
          ledgerRevision: current.state.revision, horizonDays, scenarios: [],
        });
        modeled = {
          status: result.status, revision: current.state.revision,
          inputHash: current.revision.inputHash, engineVersion: result.engineVersion,
          asOfDate: result.asOfDate, baseline: result.scenarios?.[0] || null,
          possibleOverlaps: source ? possibleOverlaps(current.revision.ledger, source.statement) : [],
        };
      }
    }
    return res.json({
      mode: 'FREE_SELF_MANAGED_NEAR_REAL_TIME',
      observedStatement: observed, modeled, bankConnected: false,
      freshness: observed
        ? (observed.periodEnd === indiaCivilToday() ? 'UPLOADED_TODAY_UNVERIFIED' : 'HISTORICAL_USER_UPLOAD')
        : 'NO_IMPORTED_EVIDENCE',
      notice: 'Statements are user-uploaded, not a real-time bank feed. Imported transactions never silently change your confirmed cash or settle planned bills.',
    });
  }));
  router.get('/events', asyncHandler(async (req, res) => {
    const userId = owner(req), after = req.query.after;
    if (after !== undefined && (typeof after !== 'string' || !/^[a-f0-9]{24}$/.test(after))) {
      throw fail(400, 'RUNWAY_CURSOR_INVALID', 'Invalid change cursor.');
    }
    const where = { userId, ...(after ? { _id: { $gt: new mongoose.Types.ObjectId(after) } } : {}) };
    const items = await RunwaySignal.find(where).sort({ _id: 1 }).limit(30).lean();
    return res.json({
      items: items.map(x => ({ id: String(x._id), eventType: x.eventType, occurredAt: x.occurredAt })),
      nextCursor: items.length ? String(items.at(-1)._id) : (after || null),
      hasMore: items.length === 30,
    });
  }));
  router.get('/statements', asyncHandler(async (req, res) => {
    const items = await RunwayStatement.find({ userId: owner(req) })
      .sort({ createdAt: -1, _id: -1 }).limit(MAX_IMPORTS).lean();
    return res.json({ items: items.map(x => summary(verified(x))), maxImports: MAX_IMPORTS });
  }));
  router.get('/statements/:id', asyncHandler(async (req, res) => {
    const userId = owner(req);
    requireRecentSession(req);
    if (!/^[a-f0-9]{64}$/.test(req.params.id)) throw fail(404, 'RUNWAY_STATEMENT_NOT_FOUND', 'Import not found.');
    const existing = await RunwayStatement.findOne({ _id: req.params.id, userId }).lean();
    if (!existing) throw fail(404, 'RUNWAY_STATEMENT_NOT_FOUND', 'Import not found.');
    return res.json({ ...summary(verified(existing)), records: existing.statement.records });
  }));
  router.post('/statements', asyncHandler(async (req, res) => {
    const userId = owner(req);
    await requireRunwayIndexes();
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
      || Object.keys(req.body).sort().join(',') !== 'accountLabel,csvText') {
      throw fail(400, 'RUNWAY_STATEMENT_INVALID', 'Specify only accountLabel and csvText.');
    }
    const statement = parseRunwayStatement({ ...req.body, today: indiaCivilToday() });
    const id = canonicalSha256({ userId: String(userId), evidenceHash: statement.evidenceHash });
    const duplicate = await RunwayStatement.findOne({ _id: id, userId }).lean();
    if (duplicate) return res.json({ ...summary(verified(duplicate)), replayed: true });
    let output;
    try {
      output = await inTransaction(async session => {
        const found = await currentRevision(userId, session);
        if (!found) throw fail(409, 'RUNWAY_LEDGER_REQUIRED', 'Save your Household Runway cash ledger before importing statements.');
        const old = await RunwayStatement.findOne({ _id: id, userId }).session(session).lean();
        if (old) return { item: old, replayed: true };
        const count = await RunwayStatement.countDocuments({ userId }).session(session);
        if (count >= MAX_IMPORTS) throw fail(409, 'RUNWAY_IMPORT_LIMIT', 'Delete older statement evidence before importing more.');
        const fence = await RunwayLedgerState.updateOne({ _id: userId, revision: found.state.revision },
          { $inc: { snapshotGeneration: 1 } }, { session });
        if (fence.matchedCount !== 1) throw fail(409, 'RUNWAY_LEDGER_CHANGED', 'Ledger changed concurrently.');
        const item = {
          _id: id, userId, statement, evidenceHash: statement.evidenceHash,
          importedAt: new Date(), sealVersion: RUNWAY_SEAL_VERSION,
        };
        item.sealHmac = createRunwayStatementSeal(item);
        await RunwayStatement.create([item], { session });
        await createRunwaySignal(userId, 'STATEMENT_IMPORTED', session);
        return { item, replayed: false };
      });
    } catch (error) {
      if (error?.code === 11000) {
        const other = await RunwayStatement.findOne({ _id: id, userId }).lean();
        if (other) return res.json({ ...summary(verified(other)), replayed: true });
      }
      rethrowTransaction(error);
    }
    return res.status(output.replayed ? 200 : 201)
      .json({ ...summary(verified(output.item)), replayed: output.replayed });
  }));
  router.delete('/statements/:id', asyncHandler(async (req, res) => {
    const userId = owner(req);
    requireRecentSession(req);
    if (!/^[a-f0-9]{64}$/.test(req.params.id)) throw fail(404, 'RUNWAY_STATEMENT_NOT_FOUND', 'Import not found.');
    try {
      await inTransaction(async session => {
        const existing = await RunwayStatement.findOne({ _id: req.params.id, userId }).session(session).lean();
        if (!existing) throw fail(404, 'RUNWAY_STATEMENT_NOT_FOUND', 'Import not found.');
        const found = await currentRevision(userId, session);
        if (!found) throw fail(503, 'RUNWAY_INTEGRITY_UNAVAILABLE', 'Ledger unavailable.');
        const fence = await RunwayLedgerState.updateOne({ _id: userId, revision: found.state.revision },
          { $inc: { snapshotGeneration: 1 } }, { session });
        if (fence.matchedCount !== 1) throw fail(409, 'RUNWAY_LEDGER_CHANGED', 'Ledger changed concurrently.');
        await RunwayStatement.deleteOne({ _id: req.params.id, userId }).session(session);
        await createRunwaySignal(userId, 'STATEMENT_DELETED', session);
      });
    } catch (error) { rethrowTransaction(error); }
    return res.json({ status: 'DELETED', scope: 'ONE_USER_IMPORTED_STATEMENT' });
  }));
  return router;
}
