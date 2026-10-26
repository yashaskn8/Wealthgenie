import { createHash } from 'node:crypto';

/** Financial event identity contains no user-supplied labels or raw balances. */
export function cashEventKey({ userId, revision, kind, sourceAsOfDate }) {
  return createHash('sha256').update(JSON.stringify([
    'coverage-alert-v1', String(userId), revision, kind, sourceAsOfDate,
  ])).digest('hex');
}
/** One full stale-cash scan per India calendar day. A non-null cursor means
 * the bounded scan is incomplete; a failed page must never mark the day done. */
export function shouldRunCashStalenessPage({ today, scanDay, completedDay, cursor }) {
  return scanDay !== today || cursor !== null || completedDay !== today;
}
const knownStatuses = new Set([
  'SHORTFALL_IN_ENTERED_PLAN', 'NO_SHORTFALL_IN_ENTERED_PLAN',
]);
export function evaluateCashRiskEvent({ userId, revision, input, result, priorResult }) {
  if (!userId || !Number.isSafeInteger(revision) || revision < 1
      || !input?.asOfDate || !result?.baseline || !knownStatuses.has(result.status)
      || !input.completenessConfirmed || input.openingCashPaise === null) return null;
  const shortfall = result.status === 'SHORTFALL_IN_ENTERED_PLAN';
  const priorShortfall = priorResult?.status === 'SHORTFALL_IN_ENTERED_PLAN';
  const dueDate = shortfall ? result.baseline.earliestShortfall?.date : null;
  const previousDue = priorShortfall ? priorResult.baseline?.earliestShortfall?.date : null;
  const previousLow = priorShortfall ? priorResult.baseline?.minWithinDayPaise : null;
  const currentLow = shortfall ? result.baseline.minWithinDayPaise : null;
  let kind;
  if (shortfall && !priorShortfall) kind = 'SHORTFALL_DETECTED';
  else if (shortfall && priorShortfall
      && (dueDate !== previousDue || currentLow !== previousLow)) kind = 'SHORTFALL_CHANGED';
  else if (!shortfall && priorShortfall) kind = 'SHORTFALL_RESOLVED';
  else return null;
  if (shortfall && (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate || ''))) return null;
  return {
    userId, eventKey: cashEventKey({ userId, revision, kind, sourceAsOfDate: input.asOfDate }),
    kind, ledgerRevision: revision, sourceAsOfDate: input.asOfDate, dueDate,
  };
}
export function cashReconfirmationEvent({ userId, revision, sourceAsOfDate, today }) {
  if (!userId || !Number.isSafeInteger(revision) || revision < 1
      || !/^\d{4}-\d{2}-\d{2}$/.test(sourceAsOfDate || '')
      || !/^\d{4}-\d{2}-\d{2}$/.test(today || '') || sourceAsOfDate >= today) return null;
  const kind = 'CASH_RECONFIRMATION_REQUIRED';
  return { userId, eventKey: cashEventKey({ userId, revision, kind, sourceAsOfDate }),
    ledgerRevision: revision, sourceAsOfDate, kind, dueDate: null };
}
