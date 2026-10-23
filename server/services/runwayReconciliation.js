/**
 * User-directed reconciliation of a posted transaction against a planned item.
 * Never automatically count a CSV as bank-verified or change the cash ledger.
 * Only today's unique, one-time exact matches can use the guided settlement.
 */
import { paise, validateLedger } from './runwayEngine.js';
import { canonicalSha256 } from '../utils/canonicalJson.js';

export class RunwayReconciliationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RunwayReconciliationError';
    this.code = code;
    this.status = code === 'RUNWAY_RECONCILIATION_AMBIGUOUS' ? 409 : 400;
    this.clientMessage = message;
  }
}
function invalid(code, message) { throw new RunwayReconciliationError(code, message); }
const MAX_SOURCES = 30;
const MAX_MATCHES = 100;
/**
 * Exact cross-import identity for the SAME user-labeled account and stated
 * transaction reference/date/direction/amount. A heuristic, NOT a verified
 * bank transaction ID. Does not use CSV filenames, row order, descriptions
 * or changing running balances.
 */
export function runwayTransactionIdentity(source, row) {
  const label = source?.statement?.accountLabel;
  if (typeof label !== 'string' || !label.trim() || !row
    || !/^[a-f0-9]{64}$/.test(row.referenceHash || '')) {
    invalid('RUNWAY_RECONCILIATION_INVALID', 'Invalid transaction identity input.');
  }
  return canonicalSha256({
    purpose: 'RUNWAY_IMPORT_TRANSACTION_ID_V1',
    accountLabel: label.trim().toLowerCase().normalize('NFC'),
    date: row.date, debitPaise: row.debitPaise,
    creditPaise: row.creditPaise, referenceHash: row.referenceHash,
  });
}
function matchInfo(entry, row) {
  return row.date === entry.date
    && row[entry.kind === 'OBLIGATION' ? 'debitPaise' : 'creditPaise'] === entry.amountPaise;
}
function eligible(entry, today) {
  return entry.recurrence === 'NONE' && entry.date === today
    && ['OBLIGATION', 'EXPECTED_INCOME'].includes(entry.kind);
}
function sortCandidates(a, b) {
  return a.entryId.localeCompare(b.entryId) || a.statementId.localeCompare(b.statementId)
    || a.rowIndex - b.rowIndex;
}
/** Requires caller-verified signed statements: {statementId, statement:{records}}. */
export function buildRunwayMatchCandidates(ledger, sources, today) {
  validateLedger(ledger);
  if (ledger.asOfDate !== today) invalid('RUNWAY_CASH_CONFIRMATION_STALE', 'Cash must be confirmed for today.');
  if (!Array.isArray(sources) || sources.length > MAX_SOURCES) {
    invalid('RUNWAY_RECONCILIATION_INVALID', 'Statement source limit exceeded.');
  }
  const candidates = [];
  for (const source of sources) {
    if (!/^[a-f0-9]{64}$/.test(source?.statementId || '')
      || !Array.isArray(source?.statement?.records) || source.statement.records.length > 250) {
      invalid('RUNWAY_RECONCILIATION_INVALID', 'Invalid normalized source records.');
    }
    source.statement.records.forEach((row, rowIndex) => {
      for (const entry of ledger.entries) {
        if (!eligible(entry, today) || !matchInfo(entry, row)) continue;
        candidates.push({
          statementId: source.statementId, rowIndex, entryId: entry.id,
          entryLabel: entry.label, kind: entry.kind, amountPaise: entry.amountPaise,
          date: entry.date, rowHash: canonicalSha256(row),
          transactionIdentity: runwayTransactionIdentity(source, row),
          verification: 'USER_IMPORTED_UNVERIFIED',
          status: 'REVIEW_REQUIRED',
        });
        if (candidates.length > MAX_MATCHES) {
          invalid('RUNWAY_RECONCILIATION_INVALID', 'Too many potential matches; reduce imported evidence.');
        }
      }
    });
  }
  const byEntry = new Map(), byRow = new Map(), byIdentity = new Map();
  for (const item of candidates) {
    byEntry.set(item.entryId, (byEntry.get(item.entryId) || 0) + 1);
    const key = item.statementId + '/' + item.rowIndex;
    byRow.set(key, (byRow.get(key) || 0) + 1);
    byIdentity.set(item.transactionIdentity, (byIdentity.get(item.transactionIdentity) || 0) + 1);
  }
  return candidates.map(item => ({
    ...item,
    status: byEntry.get(item.entryId) === 1
      && byRow.get(item.statementId + '/' + item.rowIndex) === 1
      && byIdentity.get(item.transactionIdentity) === 1
      ? 'UNIQUE_POSSIBLE_MATCH' : 'AMBIGUOUS_REQUIRES_MANUAL_EDIT',
  })).sort(sortCandidates);
}
/**
 * Never derive today's cash by adding/subtracting statement transactions.
 * The user must independently reconfirm the *household* cash balance after
 * posting; only then omit the same-day one-time matched item from projections.
 */
export function prepareRunwaySettlement(ledger, sources, request, today) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).sort().join(',')
      !== 'confirmation,entryId,ledgerRevision,openingCashPaise,rowIndex,statementId') {
    invalid('RUNWAY_RECONCILIATION_INVALID', 'Unexpected settlement request fields.');
  }
  if (!Number.isSafeInteger(request.ledgerRevision) || request.ledgerRevision < 1
      || !Number.isSafeInteger(request.rowIndex) || request.rowIndex < 0
      || !/^[a-f0-9]{64}$/.test(request.statementId || '')
      || typeof request.entryId !== 'string'
      || request.confirmation !== 'I_RECONFIRM_HOUSEHOLD_CASH_AFTER_TRANSACTION') {
    invalid('RUNWAY_RECONCILIATION_INVALID', 'Explicit settlement confirmation and valid identifiers required.');
  }
  paise(request.openingCashPaise, { allowZero: true });
  const match = buildRunwayMatchCandidates(ledger, sources, today)
    .find(item => item.statementId === request.statementId
      && item.rowIndex === request.rowIndex && item.entryId === request.entryId);
  if (!match) invalid('RUNWAY_RECONCILIATION_NO_MATCH', 'No exact same-day posted transaction match exists.');
  if (match.status !== 'UNIQUE_POSSIBLE_MATCH') {
    invalid('RUNWAY_RECONCILIATION_AMBIGUOUS',
      'Multiple possible matches exist. Review and edit the ledger manually instead.');
  }
  const nextLedger = {
    ...ledger,
    asOfDate: today, confirmationDate: today,
    openingCashPaise: request.openingCashPaise,
    entries: ledger.entries.filter(x => x.id !== request.entryId),
  };
  validateLedger(nextLedger);
  return { nextLedger, match };
}
