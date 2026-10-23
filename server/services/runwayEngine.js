/**
 * Household Runway's sole monetary authority. All inputs are declared by the user.
 * No LLM, market feed, investment portfolio or profile balance enters this engine.
 * Dates are proleptic Gregorian civil dates; money is bounded BigInt paise.
 */
// A financial-result semantics change must change this version. Historical
// results are never quietly reinterpreted using a different algorithm.
export const RUNWAY_ENGINE_VERSION = 'runway-cashflow-1.2.0';
export const MAX_PAISE = 1000000000000000n;
const DAY_LIMIT = 395;
const ENTRY_LIMIT = 256;
const EVENT_LIMIT = 512;
const SCENARIO_LIMIT = 3;
const ID = /^[a-zA-Z0-9_-]{1,64}$/;

export class RunwayInputError extends Error {
  constructor(message, code = 'RUNWAY_INPUT_INVALID') {
    super(message);
    this.name = 'RunwayInputError';
    this.status = 400;
    this.clientMessage = message;
    this.code = code;
  }
}
function reject(message) { throw new RunwayInputError(message); }
function object(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !keys.includes(key))) reject('Invalid ' + name + ' fields.');
}
export function paise(value, { allowZero = false } = {}) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value)) reject('Amounts must be canonical, nonnegative integer-paise strings.');
  const result = BigInt(value);
  if (result > MAX_PAISE || (!allowZero && result === 0n)) reject('Amount is outside the allowed range.');
  return result;
}
function leap(y) { return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0); }
function daysInMonth(y, m) { return [31, leap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]; }
export function civilDate(iso) {
  if (typeof iso !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(iso)) reject('Date must be YYYY-MM-DD.');
  const [y, m, d] = iso.split('-').map(Number);
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) reject('Invalid civil date.');
  // Howard Hinnant's days-from-civil algorithm, independent of local timezone.
  const adjusted = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(adjusted / 400);
  const yoe = adjusted - era * 400;
  const shifted = m + (m > 2 ? -3 : 9);
  const doy = Math.floor((153 * shifted + 2) / 5) + d - 1;
  return { iso, y, m, d, ordinal: era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy };
}
function checkId(v, name) { if (typeof v !== 'string' || !ID.test(v)) reject('Invalid ' + name + '.'); }
function validateEntry(entry, asOf, limit) {
  object(entry, ['id', 'label', 'kind', 'amountPaise', 'date', 'recurrence', 'untilDate', 'monthEndRule'], 'entry');
  checkId(entry.id, 'entry ID');
  if (typeof entry.label !== 'string' || entry.label.trim().length < 1 || entry.label.length > 80) reject('Entry label must contain 1-80 characters.');
  if (!['OBLIGATION', 'EXPECTED_INCOME'].includes(entry.kind)) reject('Entry kind must be OBLIGATION or EXPECTED_INCOME.');
  paise(entry.amountPaise);
  const start = civilDate(entry.date);
  if (start.ordinal < asOf.ordinal || start.ordinal > limit) reject('Entry date lies outside the confirmed horizon.');
  if (!['NONE', 'MONTHLY'].includes(entry.recurrence)) reject('Recurrence must be explicit.');
  if (entry.recurrence === 'NONE') {
    if ('untilDate' in entry || 'monthEndRule' in entry) reject('One-time entry cannot contain recurrence options.');
  } else {
    if (!['CLAMP', 'SKIP'].includes(entry.monthEndRule)) reject('Explicit monthEndRule CLAMP or SKIP is required.');
    const until = civilDate(entry.untilDate);
    if (until.ordinal < start.ordinal || until.ordinal > limit) reject('Monthly recurrence needs an end date inside the horizon.');
  }
}
export function validateLedger(ledger) {
  object(ledger, ['asOfDate', 'openingCashPaise', 'entries', 'confirmationDate'], 'ledger');
  const asOf = civilDate(ledger.asOfDate);
  if (ledger.confirmationDate !== ledger.asOfDate) reject('Cash confirmation date must match the ledger as-of date.');
  paise(ledger.openingCashPaise, { allowZero: true });
  if (!Array.isArray(ledger.entries) || ledger.entries.length > ENTRY_LIMIT) reject('At most 256 entries are allowed.');
  const seen = new Set();
  for (const e of ledger.entries) {
    // A 1-day horizon is the as-of date only, not today plus tomorrow.
    validateEntry(e, asOf, asOf.ordinal + DAY_LIMIT - 1);
    if (seen.has(e.id)) reject('Duplicate ledger entry ID.');
    seen.add(e.id);
  }
  return ledger;
}
export function validateRequest(request, ledger) {
  object(request, ['ledgerRevision', 'horizonDays', 'scenarios'], 'simulation request');
  if (!Number.isSafeInteger(request.horizonDays) || request.horizonDays < 1 || request.horizonDays > DAY_LIMIT) reject('Horizon must be 1-395 days.');
  if (!Number.isSafeInteger(request.ledgerRevision) || request.ledgerRevision < 1
      || request.ledgerRevision > 2048) reject('Ledger revision must be an integer from 1 to 2048.');
  if (!Array.isArray(request.scenarios) || request.scenarios.length > SCENARIO_LIMIT) reject('At most 3 scenarios are supported.');
  const asOf = civilDate(ledger.asOfDate);
  const end = asOf.ordinal + request.horizonDays - 1;
  const ids = new Set();
  for (const scenario of request.scenarios) {
    object(scenario, ['id', 'type', 'receiptIds', 'fromDate', 'throughDate', 'date', 'amountPaise', 'label'], 'scenario');
    checkId(scenario.id, 'scenario ID');
    if (ids.has(scenario.id)) reject('Duplicate scenario ID.');
    ids.add(scenario.id);
    if (scenario.type === 'SKIP_RECEIPTS') {
      if ('date' in scenario || 'amountPaise' in scenario || 'label' in scenario) reject('Unexpected receipt-shock fields.');
      if (!Array.isArray(scenario.receiptIds) || !scenario.receiptIds.length || scenario.receiptIds.length > ENTRY_LIMIT) reject('Choose receipt entry IDs.');
      const receiptIds = new Set();
      for (const id of scenario.receiptIds) {
        checkId(id, 'receipt ID');
        if (receiptIds.has(id) || !ledger.entries.some(e => e.id === id && e.kind === 'EXPECTED_INCOME')) reject('Unknown or duplicated expected receipt ID.');
        receiptIds.add(id);
      }
      const from = civilDate(scenario.fromDate).ordinal;
      const through = civilDate(scenario.throughDate).ordinal;
      if (from < asOf.ordinal || through > end || from > through) reject('Receipt shock dates are outside the horizon.');
    } else if (scenario.type === 'EXTRA_EXPENSE') {
      if ('receiptIds' in scenario || 'fromDate' in scenario || 'throughDate' in scenario) reject('Unexpected expense-shock fields.');
      paise(scenario.amountPaise);
      const day = civilDate(scenario.date).ordinal;
      if (day < asOf.ordinal || day > end) reject('Expense shock date is outside the horizon.');
      if (typeof scenario.label !== 'string' || !scenario.label.trim() || scenario.label.length > 80) reject('Expense label is required.');
    } else reject('Unsupported shock type.');
  }
  return request;
}
function expand(ledger, end) {
  const events = [];
  function push(event) {
    if (events.length >= EVENT_LIMIT) reject('Expanded event limit exceeded.');
    events.push(event);
  }
  for (const e of ledger.entries) {
    const start = civilDate(e.date);
    if (start.ordinal > end) continue;
    if (e.recurrence === 'NONE') {
      push({ id: e.id, label: e.label, kind: e.kind, amount: paise(e.amountPaise), date: start.iso, day: start.ordinal });
      continue;
    }
    const until = Math.min(civilDate(e.untilDate).ordinal, end);
    for (let offset = 0; offset <= 13; offset++) {
      const absoluteMonth = (start.y * 12 + start.m - 1) + offset;
      const y = Math.floor(absoluteMonth / 12);
      const m = absoluteMonth % 12 + 1;
      const maxDay = daysInMonth(y, m);
      if (start.d > maxDay && e.monthEndRule === 'SKIP') continue;
      const d = Math.min(start.d, maxDay);
      const iso = [String(y).padStart(4, '0'), String(m).padStart(2, '0'), String(d).padStart(2, '0')].join('-');
      const day = civilDate(iso).ordinal;
      if (day > until) break;
      if (day >= start.ordinal) push({ id: e.id, label: e.label, kind: e.kind, amount: paise(e.amountPaise), date: iso, day });
    }
  }
  return events;
}
function track(events, openingCash, includeExpected) {
  const dates = [...new Set(events.map(e => e.day))].sort((a, b) => a - b);
  let balance = openingCash;
  let firstPossibleShortfall = null;
  let firstCertainShortfall = null;
  const timingAmbiguities = [];
  let lowWatermark = balance;
  for (const day of dates) {
    const today = events.filter(e => e.day === day);
    const debits = today.filter(e => e.kind === 'OBLIGATION').sort((a, b) => a.id.localeCompare(b.id));
    const credits = includeExpected ? today.filter(e => e.kind === 'EXPECTED_INCOME') : [];
    const credited = credits.reduce((sum, e) => sum + e.amount, 0n);
    const prior = balance;
    // Same-day debit ordering is unknown: never arbitrarily blame the alphabetically
    // first payment or present an order-dependent partial deficit as exact.
    const totalDebits = debits.reduce((sum, e) => sum + e.amount, 0n);
    const afterDebits = prior - totalDebits;
    const afterCreditsFirst = prior + credited - totalDebits;
    const shortage = amount => ({
      date: today[0].date,
      entryId: debits.length === 1 ? debits[0].id : null,
      label: debits.length === 1 ? debits[0].label : 'Multiple payments due',
      obligationIds: debits.map(e => e.id),
      deficitPaise: String(-amount),
    });
    const possible = debits.length && afterDebits < 0n ? shortage(afterDebits) : null;
    const certain = debits.length && afterCreditsFirst < 0n ? shortage(afterCreditsFirst) : null;
    if (possible && !firstPossibleShortfall) firstPossibleShortfall = possible;
    if (certain && !firstCertainShortfall) firstCertainShortfall = certain;
    if (includeExpected && credited > 0n && debits.length > 0 && afterDebits < 0n) {
      timingAmbiguities.push({ date: today[0].date, obligationIds: debits.map(e => e.id), receiptIds: credits.map(e => e.id), code: 'SAME_DAY_TIMING_UNKNOWN' });
    }
    if (afterDebits < lowWatermark) lowWatermark = afterDebits;
    balance = afterDebits + credited;
  }
  return {
    status: firstCertainShortfall ? 'LISTED_SHORTFALL'
      : firstPossibleShortfall ? 'SAME_DAY_TIMING_UNKNOWN' : 'NO_LISTED_SHORTFALL',
    firstPossibleShortfall,
    firstCertainShortfall,
    timingAmbiguities,
    endBalancePaise: String(balance),
    lowestDebitFirstBalancePaise: String(lowWatermark),
  };
}
export function simulateRunway(ledger, request) {
  validateLedger(ledger);
  validateRequest(request, ledger);
  const asOf = civilDate(ledger.asOfDate);
  const events = expand(ledger, asOf.ordinal + request.horizonDays - 1);
  // A payment listed beyond the selected period is NOT evidence that bills
  // inside this period were assessed. Never report an all-clear on an empty
  // obligation horizon even when there are future obligations in the ledger.
  if (!events.some(event => event.kind === 'OBLIGATION')) {
    return {
      status: 'INSUFFICIENT_INPUT',
      engineVersion: RUNWAY_ENGINE_VERSION,
      asOfDate: ledger.asOfDate,
      horizonDays: request.horizonDays,
      unknowns: ['NO_LISTED_OBLIGATIONS_IN_HORIZON', 'UNLISTED_SPENDING'],
      disclaimer: 'No listed payments fall within the selected horizon; no affordability conclusion is possible.',
      scenarios: [],
    };
  }
  const scenarioEvents = [{ id: 'baseline', events }, ...request.scenarios.map(scenario => {
    if (scenario.type === 'SKIP_RECEIPTS') {
      const ids = new Set(scenario.receiptIds);
      const from = civilDate(scenario.fromDate).ordinal;
      const to = civilDate(scenario.throughDate).ordinal;
      const omitted = events.filter(e => e.kind === 'EXPECTED_INCOME' && ids.has(e.id)
        && e.day >= from && e.day <= to);
      if (!omitted.length) {
        reject('The selected income-loss scenario has no matching receipt within this date range and horizon.');
      }
      return { id: scenario.id, events: events.filter(e => !(e.kind === 'EXPECTED_INCOME'
        && ids.has(e.id) && e.day >= from && e.day <= to)) };
    }
    if (events.length >= EVENT_LIMIT) reject('Expanded event limit exceeded with added expense.');
    return { id: scenario.id, events: [...events, {
      id: 'shock_' + scenario.id,
      label: scenario.label, kind: 'OBLIGATION', amount: paise(scenario.amountPaise),
      day: civilDate(scenario.date).ordinal, date: scenario.date,
    }] };
  })];
  const opening = paise(ledger.openingCashPaise, { allowZero: true });
  return {
    status: 'READY',
    engineVersion: RUNWAY_ENGINE_VERSION,
    asOfDate: ledger.asOfDate,
    horizonDays: request.horizonDays,
    unknowns: ['UNLISTED_SPENDING', 'BANK_HOLDS', 'PAYMENT_SETTLEMENT_TIMING', 'DECLARATION_ACCURACY'],
    disclaimer: 'Conditional calculation using only listed payments and user-confirmed accessible cash; not a guarantee of affordability.',
    scenarios: scenarioEvents.map(s => ({
      scenarioId: s.id,
      eventCount: s.events.length,
      cashAlreadyAvailable: track(s.events, opening, false),
      ifExpectedIncomeArrives: track(s.events, opening, true),
    })),
  };
}
