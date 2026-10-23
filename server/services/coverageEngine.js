/**
 * Obligation Firewall v1 — arithmetic on user-declared cash, never investment advice.
 * Dates are India calendar dates encoded as YYYY-MM-DD; computations use UTC ordinal
 * days to avoid host timezone/DST dependence. All amounts are integer paise.
 */
export const COVERAGE_POLICY_VERSION = 'cash-coverage-90d-v1';
export const COVERAGE_DAYS = 90;
export const MAX_COVERAGE_ENTRIES = 100;
const MAX_AMOUNT_PAISE = 1_000_000_000_000;
const DAY_MS = 86_400_000;
const TYPES = new Set([
  'EXPECTED_INCOME', 'ESSENTIAL_PAYMENT', 'CONTRACTUAL_PAYMENT',
  'VOLUNTARY_CONTRIBUTION', 'OTHER_PAYMENT',
]);
const RULES = new Set(['ONCE', 'WEEKLY', 'MONTHLY']);
const SOURCES = new Set([
  'USER_DECLARED_BANK_CASH', 'USER_DECLARED_WALLET_CASH',
  'USER_DECLARED_OTHER_ACCESSIBLE_CASH',
]);
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const OWN = (obj, name) => Object.prototype.hasOwnProperty.call(obj, name);

export class CoverageInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CoverageInputError';
    this.status = 400;
    this.code = 'COVERAGE_INPUT_INVALID';
  }
}
function fail(message) { throw new CoverageInputError(message); }
function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !allowed.includes(key))) fail(name + ' has invalid fields.');
}
export function parseCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('Expected YYYY-MM-DD date.');
  const [year, month, day] = value.split('-').map(Number);
  if (year < 2000 || year > 2100) fail('Date is outside supported years.');
  const timestamp = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    fail('Invalid calendar date.');
  }
  return timestamp;
}
export function dayAt(offset, startingDate) {
  return new Date(parseCalendarDate(startingDate) + offset * DAY_MS).toISOString().slice(0, 10);
}
function safePaise(value, name, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_AMOUNT_PAISE) {
    fail(name + ' must be a nonnegative safe integer number of paise.');
  }
  return value;
}
function safeArithmetic(value) {
  if (!Number.isSafeInteger(value)) fail('Calculation exceeds exact paise range.');
  return value;
}
export function validateCoverageLedger(input) {
  exactKeys(input, ['asOfDate', 'openingCashPaise', 'cashSource', 'completenessConfirmed', 'entries'], 'Ledger');
  parseCalendarDate(input.asOfDate);
  if (!SOURCES.has(input.cashSource)) fail('Cash source must be a user-declared accessible-cash source.');
  if (typeof input.completenessConfirmed !== 'boolean') fail('Explicit completeness declaration required.');
  if (!OWN(input, 'openingCashPaise')) fail('Opening cash must be specified (null if unknown).');
  const openingCashPaise = safePaise(input.openingCashPaise, 'Opening cash', { nullable: true });
  if (!Array.isArray(input.entries) || input.entries.length > MAX_COVERAGE_ENTRIES) {
    fail('At most 100 cash entries can be supplied.');
  }
  const seen = new Set();
  const entries = input.entries.map((entry) => {
    exactKeys(entry, ['id', 'type', 'label', 'amountPaise', 'startDate', 'recurrence'], 'Cash entry');
    if (!ID.test(entry.id) || seen.has(entry.id)) fail('Entry IDs must be unique and safe.');
    seen.add(entry.id);
    if (!TYPES.has(entry.type) || !RULES.has(entry.recurrence)) fail('Unsupported entry type or recurrence.');
    if (typeof entry.label !== 'string' || entry.label.trim().length < 1
        || entry.label.length > 80 || /[\u0000-\u001f\u007f]/.test(entry.label)) {
      fail('Entry label must be 1–80 visible characters.');
    }
    const amountPaise = safePaise(entry.amountPaise, 'Entry amount');
    if (amountPaise === 0) fail('Cash entries must have a positive amount.');
    parseCalendarDate(entry.startDate);
    return {
      id: entry.id, type: entry.type, label: entry.label.trim(),
      amountPaise, startDate: entry.startDate, recurrence: entry.recurrence,
    };
  });
  return {
    asOfDate: input.asOfDate, openingCashPaise, cashSource: input.cashSource,
    completenessConfirmed: input.completenessConfirmed, entries,
  };
}
/**
 * One bounded recurrence expansion is reused by both scenarios.
 * The original monthly anchor is never advanced through clamped dates.
 */
function expandSchedule(ledger) {
  const origin = parseCalendarDate(ledger.asOfDate);
  const prepared = ledger.entries.map(entry => ({
    ...entry,
    startOrdinal: parseCalendarDate(entry.startDate),
    originalDay: Number(entry.startDate.slice(8, 10)),
  }));
  const days = [];
  for (let index = 0; index < COVERAGE_DAYS; index += 1) {
    const ordinal = origin + index * DAY_MS;
    const current = new Date(ordinal);
    const date = current.toISOString().slice(0, 10);
    const dayOfMonth = current.getUTCDate();
    const monthLastDay = new Date(Date.UTC(
      current.getUTCFullYear(), current.getUTCMonth() + 1, 0,
    )).getUTCDate();
    const outflows = [];
    const inflows = [];
    for (const entry of prepared) {
      if (ordinal < entry.startOrdinal) continue;
      const occurs = entry.recurrence === 'ONCE'
        ? ordinal === entry.startOrdinal
        : entry.recurrence === 'WEEKLY'
          ? (ordinal - entry.startOrdinal) % (7 * DAY_MS) === 0
          : dayOfMonth === Math.min(entry.originalDay, monthLastDay);
      if (!occurs) continue;
      if (entry.type === 'EXPECTED_INCOME') inflows.push(entry);
      else outflows.push(entry);
    }
    days.push({ date, outflows, inflows });
  }
  return days;
}
function computeScenario(ledger, schedule, { omitExpectedIncome = false } = {}) {
  let cash = ledger.openingCashPaise;
  let minWithinDayPaise = cash;
  let earliestShortfall = null;
  const daily = [];
  for (const day of schedule) {
    let withinDayPaise = cash;
    const contributingEntryIds = [];
    // Bank intraday settlement order is unknown: all outflows precede inflows.
    for (const payment of day.outflows) {
      cash = safeArithmetic(cash - payment.amountPaise);
      contributingEntryIds.push(payment.id);
      if (cash < withinDayPaise) withinDayPaise = cash;
    }
    if (cash < 0 && !earliestShortfall) {
      earliestShortfall = {
        date: day.date, lowestBalancePaise: cash,
        dueOutflowEntryIds: [...contributingEntryIds],
      };
    }
    if (!omitExpectedIncome) {
      for (const income of day.inflows) cash = safeArithmetic(cash + income.amountPaise);
    }
    if (withinDayPaise < minWithinDayPaise) minWithinDayPaise = withinDayPaise;
    daily.push({ date: day.date, lowestBalancePaise: withinDayPaise, closingBalancePaise: cash });
  }
  return {
    status: earliestShortfall ? 'SHORTFALL_IN_ENTERED_PLAN' : 'NO_SHORTFALL_IN_ENTERED_PLAN',
    earliestShortfall, minWithinDayPaise, closingBalancePaise: cash, daily,
  };
}
export function calculateCoverage(input) {
  const ledger = validateCoverageLedger(input);
  const base = {
    policyVersion: COVERAGE_POLICY_VERSION,
    horizonDays: COVERAGE_DAYS,
    asOfDate: ledger.asOfDate,
    cashProvenance: 'USER_DECLARED_NOT_BANK_VERIFIED',
    disclaimer: 'Scenario from user-declared entries, not a guarantee of affordability or complete bills.',
  };
  if (ledger.openingCashPaise === null || !ledger.completenessConfirmed) {
    return {
      ...base, status: 'CANNOT_CALCULATE',
      missingInputCodes: [
        ...(ledger.openingCashPaise === null ? ['OPENING_CASH_UNKNOWN'] : []),
        ...(!ledger.completenessConfirmed ? ['ENTRIES_NOT_CONFIRMED'] : []),
      ],
      baseline: null, noExpectedIncome: null,
    };
  }
  const schedule = expandSchedule(ledger);
  const baseline = computeScenario(ledger, schedule);
  const noExpectedIncome = computeScenario(ledger, schedule, { omitExpectedIncome: true });
  return {
    ...base, status: baseline.status, missingInputCodes: [],
    message: baseline.status === 'NO_SHORTFALL_IN_ENTERED_PLAN'
      ? 'No shortfall in the entries supplied for these dates.'
      : 'Your entered cash plan shows a dated shortfall. Recheck actual balances and bill timing.',
    baseline, noExpectedIncome,
  };
}
export function previewVoluntaryExclusions(input, excludedIds) {
  const ledger = validateCoverageLedger(input);
  if (!Array.isArray(excludedIds) || excludedIds.length > 100
      || new Set(excludedIds).size !== excludedIds.length) fail('Invalid exclusion IDs.');
  const allowed = new Set(ledger.entries.filter(e => e.type === 'VOLUNTARY_CONTRIBUTION').map(e => e.id));
  if (excludedIds.some(id => !allowed.has(id))) {
    fail('Only existing voluntary contributions may be excluded from a hypothetical scenario.');
  }
  return calculateCoverage({
    ...ledger, entries: ledger.entries.filter(e => !excludedIds.includes(e.id)),
  });
}
