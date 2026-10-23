/**
 * Zero-fee bank-statement ingestion and owner-scoped live dashboard events.
 * Uploaded CSV is evidence supplied by the user, never an authenticated bank feed.
 */
import { Router } from 'express';
import mongoose from 'mongoose';
import { asyncHandler, createError } from '../middleware/errorHandler.js';
import { canonicalSha256 } from '../utils/canonicalJson.js';
import { parseRunwayStatement } from '../services/runwayStatementImport.js';
import {
  encryptRunwayStatement, decryptRunwayStatement,
} from '../services/runwayEvidenceCrypto.js';
import {
  createRunwayStatementSeal, verifyRunwayStatementSeal, RUNWAY_SEAL_VERSION,
  createRunwayLedgerSeal, verifyRunwayLedgerSeal,
  createRunwaySettlementSeal, verifyRunwaySettlementSeal,
} from '../services/runwaySeal.js';
import { simulateRunway } from '../services/runwayEngine.js';
import {
  buildRunwayMatchCandidates, prepareRunwaySettlement, runwayTransactionIdentity,
} from '../services/runwayReconciliation.js';
import { RunwayLedgerState, RunwayLedgerRevision } from '../models/Runway.js';
import { buildRunwayObservedAccounts } from '../services/runwayAccountObservations.js';
import { RunwayStatement, RunwaySignal, RunwaySettlement } from '../models/RunwayEvidence.js';
import { RunwayProjectionJob, RunwayProjectionResult } from '../models/RunwayProjection.js';
import {
  queueRunwayProjection, runwayProjectionId, verifyRunwayProjectionResult,
} from '../services/runwayProjectionOutbox.js';
import { decryptRunwayProjectionResult } from '../services/runwayEvidenceCrypto.js';

const MAX_IMPORTS = 30;
const MAX_SETTLEMENTS = 500;
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
  if (!authentic) {
    throw fail(503, 'RUNWAY_EVIDENCE_INVALID', 'Imported statement authenticity could not be verified.');
  }
  let statement;
  try { statement = decryptRunwayStatement(item); } catch {
    throw fail(503, 'RUNWAY_EVIDENCE_DECRYPTION_FAILED',
      'Imported evidence cannot be decrypted or still requires a secure migration.');
  }
  if (canonicalSha256({
    accountLabel: statement.accountLabel, records: statement.records,
  }) !== item.evidenceHash || statement.evidenceHash !== item.evidenceHash) {
    throw fail(503, 'RUNWAY_EVIDENCE_INVALID', 'Imported statement checksum does not match decrypted source.');
  }
  return { ...item, statement };
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
  requireRecentSession, indiaCivilToday, requireRunwayIndexes, idempotency,
}) {
  const router = Router();
  router.get('/overview', asyncHandler(async (req, res) => {
    const userId = owner(req);
    const horizonDays = req.query.horizonDays === undefined
      ? 90 : queryNumber(req.query.horizonDays, 1, 395);
    const current = await currentRevision(userId);
    // Imported-file time is not the underlying bank observation date.
    // Pick the newest available transaction date across retained imports.
    // Every candidate is authenticated before it can affect the view.
    const candidates = await RunwayStatement.find({ userId })
      .sort({ importedAt: -1, _id: -1 }).limit(MAX_IMPORTS).lean();
    const authenticated = candidates.map(verified);
    const source = authenticated.sort((a, b) =>
      b.statement.periodEnd.localeCompare(a.statement.periodEnd)
      || b.importedAt.getTime() - a.importedAt.getTime())[0] || null;
    const observed = source ? summary(source) : null;
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
  router.get('/accounts', asyncHandler(async (req, res) => {
    const userId = owner(req);
    const records = await RunwayStatement.find({ userId }).sort({ importedAt: -1, _id: -1 })
      .limit(MAX_IMPORTS).lean();
    return res.json(buildRunwayObservedAccounts(records.map(verified), indiaCivilToday()));
  }));
  router.get('/projection', asyncHandler(async (req, res) => {
    const userId = owner(req);
    const current = await currentRevision(userId);
    if (!current) return res.json({ status: 'NO_CONFIRMED_LEDGER', revision: null });
    const id = runwayProjectionId(userId, current.state.revision);
    const [job, result] = await Promise.all([
      RunwayProjectionJob.findOne({ _id: id, userId }).lean(),
      RunwayProjectionResult.findOne({ _id: id, userId }).lean(),
    ]);
    if (!job) return res.json({ status: 'LEGACY_PROJECTION_NOT_QUEUED',
      revision: current.state.revision, source: 'CURRENT_VERIFIED_LEDGER' });
    if (job.inputHash !== current.revision.inputHash || job.revision !== current.state.revision) {
      throw fail(503, 'RUNWAY_PROJECTION_SOURCE_INVALID', 'Projection job mismatches signed current ledger.');
    }
    if (job.status !== 'DONE') {
      return res.json({ status: job.status, revision: current.state.revision,
        attempts: job.attempts, errorCode: job.status === 'BLOCKED' ? job.lastErrorCode : null });
    }
    if (!result || result.revision !== current.state.revision
      || result.inputHash !== current.revision.inputHash
      || !verifyRunwayProjectionResult(result)) {
      throw fail(503, 'RUNWAY_PROJECTION_INTEGRITY_INVALID', 'Projection result integrity failed.');
    }
    return res.json({ status: 'DONE', revision: result.revision,
      engineVersion: result.engineVersion, computedAt: result.computedAt,
      result: decryptRunwayProjectionResult(result),
      verified: 'SERVER_SEALED_DETERMINISTIC_SOURCE' });
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

  async function verifiedSources(userId, session = null) {
    const records = await RunwayStatement.find({ userId }).sort({ importedAt: -1 })
      .limit(MAX_IMPORTS).session(session).lean();
    return records.map(x => {
      const authenticated = verified(x);
      return { statementId: x._id, statement: authenticated.statement };
    });
  }
  async function verifiedSettledRows(userId, session = null) {
    // Never derive "available to match" rows from unauthenticated database
    // metadata: a writer could alter the row identity to bypass replay defense.
    const receipts = await RunwaySettlement.find({ userId })
      .limit(MAX_SETTLEMENTS + 1).session(session).lean();
    if (receipts.length > MAX_SETTLEMENTS) {
      throw fail(503, 'RUNWAY_SETTLEMENT_INTEGRITY_INVALID', 'Settlement history exceeds its verified limit.');
    }
    for (const receipt of receipts) {
      if (!verifyRunwaySettlementSeal(receipt)) {
        throw fail(503, 'RUNWAY_SETTLEMENT_INTEGRITY_INVALID',
          'Existing settlement row identity was modified without authorization.');
      }
    }
    return receipts;
  }
  async function verifiedSettlement(userId, receipt) {
    if (!verifyRunwaySettlementSeal(receipt)) {
      throw fail(503, 'RUNWAY_SETTLEMENT_INTEGRITY_INVALID', 'Settlement authenticity failed.');
    }
    const prior = await RunwayLedgerRevision.findOne({ userId, revision: receipt.ledgerRevision }).lean();
    const next = await RunwayLedgerRevision.findOne({ userId, revision: receipt.resultRevision }).lean();
    if (!prior || !next || receipt.resultRevision !== receipt.ledgerRevision + 1
      || canonicalSha256(prior.ledger) !== prior.inputHash
      || canonicalSha256(next.ledger) !== next.inputHash
      || !verifyRunwayLedgerSeal(prior) || !verifyRunwayLedgerSeal(next)
      || receipt.priorInputHash !== prior.inputHash || receipt.nextInputHash !== next.inputHash) {
      throw fail(503, 'RUNWAY_SETTLEMENT_INTEGRITY_INVALID', 'Settlement source revisions failed verification.');
    }
    const expected = {
      ...prior.ledger, openingCashPaise: receipt.confirmedCashPaise,
      entries: prior.ledger.entries.filter(x => x.id !== receipt.entryId),
    };
    if (prior.ledger.entries.length !== expected.entries.length + 1
      || canonicalSha256(expected) !== next.inputHash) {
      throw fail(503, 'RUNWAY_SETTLEMENT_INTEGRITY_INVALID',
        'Settlement receipt cannot explain the exact ledger change.');
    }
    return receipt;
  }

  router.get('/matches', asyncHandler(async (req, res) => {
    const userId = owner(req);
    const found = await currentRevision(userId);
    if (!found) return res.json({ revision: null, items: [], status: 'NO_CONFIRMED_LEDGER' });
    if (found.revision.ledger.asOfDate !== indiaCivilToday()) {
      return res.json({ revision: found.state.revision, items: [], status: 'CASH_CONFIRMATION_STALE' });
    }
    const sources = await verifiedSources(userId);
    const used = await verifiedSettledRows(userId);
    const consumed = new Set(used.map(x => x.statementId + '/' + x.rowIndex));
    const consumedIdentity = new Set(used.map(x => x.transactionIdentity));
    return res.json({
      revision: found.state.revision,
      items: buildRunwayMatchCandidates(found.revision.ledger, sources, indiaCivilToday())
        .filter(x => !consumed.has(x.statementId + '/' + x.rowIndex)
          && !consumedIdentity.has(x.transactionIdentity)),
      status: 'REVIEW_REQUIRED',
      notice: 'Amount/date matches are suggestions only, not independently bank-verified posting.',
    });
  }));

  router.get('/settlements', asyncHandler(async (req, res) => {
    const userId = owner(req);
    requireRecentSession(req);
    const page = req.query.page === undefined ? 0 : queryNumber(req.query.page, 0, 19);
    const [items, total] = await Promise.all([
      RunwaySettlement.find({ userId }).sort({ decidedAt: -1, _id: -1 })
        .skip(page * 25).limit(25).lean(),
      RunwaySettlement.countDocuments({ userId }),
    ]);
    const checked = [];
    for (const item of items) checked.push(await verifiedSettlement(userId, item));
    return res.json({
      page, total, hasMore: (page + 1) * 25 < total,
      items: checked.map(x => ({
        receiptId: x._id, ledgerRevision: x.ledgerRevision,
        resultRevision: x.resultRevision, entryId: x.entryId,
        statementId: x.statementId, rowIndex: x.rowIndex,
        confirmedCashPaise: x.confirmedCashPaise, decidedAt: x.decidedAt,
        status: 'USER_CONFIRMED_NOT_BANK_VERIFIED',
      })),
    });
  }));

  router.post('/settlements', asyncHandler(async (req, res) => {
    const userId = owner(req);
    requireRecentSession(req);
    await requireRunwayIndexes();
    const key = idempotency(req);
    const receiptId = canonicalSha256({ operation: 'RUNWAY_SETTLEMENT', userId: String(userId), key });
    const requestHash = canonicalSha256({
      operation: 'RUNWAY_SETTLEMENT', userId: String(userId), request: req.body,
    });
    const earlier = await RunwaySettlement.findOne({ _id: receiptId, userId }).lean();
    if (earlier) {
      if (earlier.requestHash !== requestHash) {
        throw fail(409, 'RUNWAY_IDEMPOTENCY_CONFLICT', 'Settlement key was reused with different inputs.');
      }
      await verifiedSettlement(userId, earlier);
      return res.json({ revision: earlier.resultRevision, receiptId, replayed: true,
        evidenceStatus: 'USER_CONFIRMED_NOT_BANK_VERIFIED' });
    }
    const requested = req.body;
    if (!requested || typeof requested !== 'object'
      || !Number.isSafeInteger(requested.ledgerRevision) || requested.ledgerRevision >= 2048) {
      throw fail(400, 'RUNWAY_RECONCILIATION_INVALID', 'Valid ledger revision below the cap is required.');
    }
    let created;
    try {
      created = await inTransaction(async session => {
        const found = await currentRevision(userId, session);
        if (!found || found.state.revision !== requested.ledgerRevision) {
          throw fail(409, 'RUNWAY_STALE_INPUT', 'Ledger changed. Refresh and review matches again.');
        }
        if (found.revision.ledger.asOfDate !== indiaCivilToday()) {
          throw fail(409, 'RUNWAY_CASH_CONFIRMATION_STALE', 'Reconfirm household cash for today.');
        }
        const usedRows = await verifiedSettledRows(userId, session);
        if (usedRows.length >= MAX_SETTLEMENTS) {
          throw fail(409, 'RUNWAY_SETTLEMENT_LIMIT',
            'Export settled-item history and manage older ledger records before continuing.');
        }
        const previouslyApplied = usedRows.some(receipt =>
          receipt.statementId === requested.statementId && receipt.rowIndex === requested.rowIndex);
        if (previouslyApplied) {
          throw fail(409, 'RUNWAY_POSTED_ROW_REUSED',
            'This user-imported transaction was already applied to a ledger.');
        }
        const sources = await verifiedSources(userId, session);
        const requestedSource = sources.find(x => x.statementId === requested.statementId);
        const requestedRow = Number.isSafeInteger(requested.rowIndex)
          && requested.rowIndex >= 0
          ? requestedSource?.statement?.records?.[requested.rowIndex] : null;
        // A re-uploaded consumed row must report an explicit reuse conflict
        // even if the duplicate files also make the match ambiguous.
        if (requestedSource && requestedRow && usedRows.some(x =>
          x.transactionIdentity === runwayTransactionIdentity(requestedSource, requestedRow))) {
          throw fail(409, 'RUNWAY_POSTED_TRANSACTION_REUSED',
            'This apparent bank transaction already changed a financial ledger.');
        }
        const { nextLedger, match } = prepareRunwaySettlement(
          found.revision.ledger, sources, requested, indiaCivilToday(),
        );
        if (usedRows.some(x => x.transactionIdentity === match.transactionIdentity)) {
          throw fail(409, 'RUNWAY_POSTED_TRANSACTION_REUSED',
            'The same apparent bank transaction has already changed a forecast.');
        }
        const next = found.state.revision + 1;
        const nextInputHash = canonicalSha256(nextLedger);
        const revisionRecord = {
          userId, revision: next, ledger: nextLedger, inputHash: nextInputHash,
          confirmedAt: new Date(), sealVersion: RUNWAY_SEAL_VERSION,
        };
        revisionRecord.sealHmac = createRunwayLedgerSeal(revisionRecord);
        const fence = await RunwayLedgerState.updateOne({
          _id: userId, revision: found.state.revision,
        }, { $set: { revision: next }, $inc: { snapshotGeneration: 1 } }, { session });
        if (fence.matchedCount !== 1) {
          throw fail(409, 'RUNWAY_STALE_INPUT', 'Ledger was edited concurrently.');
        }
        await RunwayLedgerRevision.create([revisionRecord], { session });
        const receipt = {
          _id: receiptId, userId, requestHash,
          ledgerRevision: found.state.revision, resultRevision: next,
          priorInputHash: found.revision.inputHash, nextInputHash,
          statementId: match.statementId, rowIndex: match.rowIndex, entryId: match.entryId,
          rowHash: match.rowHash, transactionIdentity: match.transactionIdentity,
          confirmedCashPaise: requested.openingCashPaise,
          decidedAt: new Date(), sealVersion: RUNWAY_SEAL_VERSION,
        };
        receipt.sealHmac = createRunwaySettlementSeal(receipt);
        await RunwaySettlement.create([receipt], { session });
        await queueRunwayProjection(userId, next, nextInputHash, session);
        await createRunwaySignal(userId, 'SETTLEMENT_CONFIRMED', session);
        return { revision: next, receiptId };
      });
    } catch (error) {
      if (error?.code === 11000) {
        const sources = await verifiedSources(userId);
        const source = sources.find(x => x.statementId === requested.statementId);
        const originalRow = source?.statement?.records?.[requested.rowIndex];
        const identity = originalRow
          ? runwayTransactionIdentity(source, originalRow) : null;
        const rowAlreadyUsed = await RunwaySettlement.findOne({
          userId, _id: { $ne: receiptId },
          $or: [
            { statementId: requested.statementId, rowIndex: requested.rowIndex },
            ...(identity ? [{ transactionIdentity: identity }] : []),
          ],
        }).lean();
        if (rowAlreadyUsed) {
          if (!verifyRunwaySettlementSeal(rowAlreadyUsed)) {
            throw fail(503, 'RUNWAY_SETTLEMENT_INTEGRITY_INVALID',
              'Settlement provenance has been modified.');
          }
          throw fail(409, 'RUNWAY_POSTED_ROW_REUSED',
            'This posted row has already been applied.');
        }
        const saved = await RunwaySettlement.findOne({ _id: receiptId, userId }).lean();
        if (saved) {
          if (saved.requestHash !== requestHash) {
            throw fail(409, 'RUNWAY_IDEMPOTENCY_CONFLICT', 'Settlement request conflicted.');
          }
          await verifiedSettlement(userId, saved);
          return res.json({ revision: saved.resultRevision, receiptId,
            replayed: true, evidenceStatus: 'USER_CONFIRMED_NOT_BANK_VERIFIED' });
        }
      }
      rethrowTransaction(error);
    }
    return res.status(201).json({
      ...created, replayed: false, evidenceStatus: 'USER_CONFIRMED_NOT_BANK_VERIFIED',
      note: 'Planned item removed only after independently reconfirmed household cash.',
    });
  }));

  router.get('/statements', asyncHandler(async (req, res) => {
    const items = await RunwayStatement.find({ userId: owner(req) })
      .sort({ importedAt: -1, _id: -1 }).limit(MAX_IMPORTS).lean();
    return res.json({ items: items.map(x => summary(verified(x))), maxImports: MAX_IMPORTS });
  }));
  router.get('/statements/:id', asyncHandler(async (req, res) => {
    const userId = owner(req);
    requireRecentSession(req);
    if (!/^[a-f0-9]{64}$/.test(req.params.id)) throw fail(404, 'RUNWAY_STATEMENT_NOT_FOUND', 'Import not found.');
    const existing = await RunwayStatement.findOne({ _id: req.params.id, userId }).lean();
    if (!existing) throw fail(404, 'RUNWAY_STATEMENT_NOT_FOUND', 'Import not found.');
    const authenticated = verified(existing);
    return res.json({ ...summary(authenticated), records: authenticated.statement.records });
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
          _id: id, userId, evidenceHash: statement.evidenceHash,
          importedAt: new Date(), sealVersion: RUNWAY_SEAL_VERSION,
        };
        item.statement = encryptRunwayStatement({ ...item, statement });
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
