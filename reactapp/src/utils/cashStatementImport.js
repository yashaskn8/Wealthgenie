/**
 * Local CSV statement assistant — never a bank connector.
 * Everything is parsed in the browser; only user-confirmed draft entries may
 * subsequently be sent to the existing coverage API. No file/transaction logs.
 */
export const MAX_CASH_CSV_BYTES = 512 * 1024;
export const MAX_CASH_CSV_ROWS = 1500;
const MAX_PAISE = 1_000_000_000_000;
const headerNames = {
  date: ['date', 'transactiondate', 'txn date', 'txndate', 'valuedate'],
  description: ['description', 'narration', 'particulars', 'transactiondetails', 'details'],
  debit: ['debit', 'debitamount', 'withdrawal', 'withdrawalamount', 'withdrawalamt', 'paidout'],
  credit: ['credit', 'creditamount', 'deposit', 'depositamount', 'depositamt', 'paidin'],
  balance: ['balance', 'closingbalance', 'availablebalance'],
  transactionId: ['transactionid', 'transactionreference', 'referencenumber', 'refno', 'transactionref'],
};
const canonicalHeader = value => value.toLowerCase().trim().replace(/[\s_.()₹-]/g, '');
const headerIndex = new Map(Object.entries(headerNames)
  .flatMap(([key, aliases]) => aliases.map(alias => [canonicalHeader(alias), key])));

export class CashCsvError extends Error {
  constructor(message) { super(message); this.name = 'CashCsvError'; }
}
const fail = message => { throw new CashCsvError(message); };

export function parseCashCsvTable(text) {
  if (typeof text !== 'string' || text.length > MAX_CASH_CSV_BYTES || text.includes('\0')) {
    fail('Invalid or oversized CSV statement.');
  }
  const value = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', quoted = false, closed = false, started = false;
  function pushField() {
    if (field.length > 512) fail('Statement column exceeds 512 characters.');
    row.push(field);
    field = ''; closed = false; started = false;
    if (row.length > 24) fail('Too many CSV columns.');
  }
  function pushRow() {
    pushField();
    if (row.some(cell => cell.trim() !== '')) rows.push(row);
    row = [];
    if (rows.length > MAX_CASH_CSV_ROWS + 1) fail('Statement exceeds 1,500 transactions.');
  }
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i];
    if (quoted) {
      if (c === '"') {
        if (value[i + 1] === '"') { field += '"'; i += 1; }
        else { quoted = false; closed = true; }
      } else { field += c; }
      if (field.length > 512) fail('Statement column exceeds 512 characters.');
      continue;
    }
    if (c === ',') { pushField(); continue; }
    if (c === '\n' || c === '\r') {
      pushRow();
      if (c === '\r' && value[i + 1] === '\n') i += 1;
      continue;
    }
    if (c === '"' && !started && field === '') { quoted = true; started = true; continue; }
    if (c === '"' || closed) fail('Malformed CSV quoting; import cancelled.');
    field += c; started = true;
    if (field.length > 512) fail('Statement column exceeds 512 characters.');
  }
  if (quoted) fail('Unclosed CSV quote; import cancelled.');
  if (row.length || field.length) pushRow();
  if (rows.length < 2) fail('CSV requires a header and transaction rows.');
  return rows;
}
function statementDate(value) {
  let year, month, day;
  const date = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) [year, month, day] = date.split('-').map(Number);
  else if (/^\d{2}\/\d{2}\/\d{4}$/.test(date)) [day, month, year] = date.split('/').map(Number);
  else fail('Dates must use YYYY-MM-DD or DD/MM/YYYY (India day-first).');
  if (year < 2000 || year > 2100) fail('Statement date outside supported years.');
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    fail('Invalid statement calendar date.');
  }
  return d.toISOString().slice(0, 10);
}
function decimalPaise(value, { nullable = false } = {}) {
  const raw = String(value).trim();
  if (nullable && (raw === '' || raw === '-')) return null;
  const stripped = raw.replace(/^(₹|INR\s*|Rs\.?\s*)/i, '').trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(stripped)) {
    fail('Statement amounts must be positive INR numbers with at most 2 decimal places.');
  }
  const [whole, fraction = ''] = stripped.replace(/,/g, '').split('.');
  // String-to-integer arithmetic: never round a binary floating rupee.
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || amount > MAX_PAISE) fail('Statement amount exceeds exact-paise limit.');
  return amount;
}
const daysBetween = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);
const monthId = date => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));
function dateAtMonth(monthNumber, anchorDay) {
  const year = Math.floor((monthNumber - 1) / 12);
  const month = (monthNumber - 1) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(anchorDay, lastDay))).toISOString().slice(0, 10);
}
function suggestDueDate(latest, anchorDay, recurrence, today) {
  let next;
  if (recurrence === 'MONTHLY') {
    next = dateAtMonth(monthId(latest) + 1, anchorDay);
    for (let k = 0; next < today && k < 3; k += 1) {
      next = dateAtMonth(monthId(next) + 1, anchorDay);
    }
  } else {
    next = new Date(Date.parse(latest + 'T00:00:00Z') + 7 * 86400000).toISOString().slice(0, 10);
    for (let k = 0; next < today && k < 8; k += 1) {
      next = new Date(Date.parse(next + 'T00:00:00Z') + 7 * 86400000).toISOString().slice(0, 10);
    }
  }
  return next >= today && daysBetween(next, today) <= 90 ? next : null;
}
// Bank statement files may be oldest-first, newest-first, or neither. A
// balance is displayable only if all rows are present and their arithmetic
// reconciles in a single unambiguous chronological ordering.
function statementClosingBalance(rows) {
  if (rows.some(row => row.balancePaise === null)) {
    return { balancePaise: null, balanceDate: null, status: 'MISSING_BALANCE_DATA' };
  }
  if (rows.length === 1) {
    return { balancePaise: rows[0].balancePaise, balanceDate: rows[0].date,
      status: 'FILE_REPORTED_UNVERIFIED' };
  }
  function validChronology(sequence) {
    return sequence.every((item, index) => {
      if (index === 0) return true;
      const previous = sequence[index - 1];
      if (item.date < previous.date) return false;
      const delta = item.direction === 'DEBIT' ? -item.amountPaise : item.amountPaise;
      return item.balancePaise - previous.balancePaise === delta;
    });
  }
  const ascending = validChronology(rows);
  const descending = validChronology([...rows].reverse());
  if (ascending === descending) {
    return { balancePaise: null, balanceDate: null,
      status: 'AMBIGUOUS_OR_INCONSISTENT_BALANCES' };
  }
  const latest = ascending ? rows.at(-1) : rows[0];
  return { balancePaise: latest.balancePaise, balanceDate: latest.date,
    status: 'FILE_ARITHMETIC_RECONCILED_UNVERIFIED' };
}
function redactCandidateLabel(description) {
  return description
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email redacted]')
    .replace(/\d{6,}/g, '[reference redacted]')
    .slice(0, 80).trim();
}
function proposalCandidates(transactions, today) {
  const groups = new Map();
  for (const item of transactions) {
    if (item.direction !== 'DEBIT' || daysBetween(item.date, today) > 0) continue;
    // Do not collapse different amounts or different payee narrations.
    const key = item.description.toLowerCase() + '\0' + item.amountPaise;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const proposals = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.date.localeCompare(b.date));
    // Same-day duplicates can come from merged accounts or repeated exports;
    // they are not independent recurrence evidence.
    if (group.length < 3 || new Set(group.map(item => item.date)).size !== group.length) continue;
    const last = group[group.length - 1];
    if (daysBetween(today, last.date) > 45) continue;
    const months = group.map(item => monthId(item.date));
    // Exactly one same-signature debit in each of the latest three consecutive months.
    const monthly = group.length >= 3
      && months.at(-1) - months.at(-2) === 1
      && months.at(-2) - months.at(-3) === 1
      && new Set(months).size === months.length;
    let recurrence = null, due = null;
    if (monthly) {
      const samples = group.slice(-3);
      const anchor = Math.max(...samples.map(item => Number(item.date.slice(8, 10))));
      const matches = samples.every(item =>
        Math.abs(Number(item.date.slice(8, 10))
          - Number(dateAtMonth(monthId(item.date), anchor).slice(8, 10))) <= 3);
      if (matches) { recurrence = 'MONTHLY'; due = suggestDueDate(last.date, anchor, recurrence, today); }
    }
    if (!recurrence && group.length >= 4) {
      const sample = group.slice(-4);
      if (sample.every((item, i) => i === 0 || daysBetween(item.date, sample[i - 1].date) === 7)) {
        recurrence = 'WEEKLY';
        due = suggestDueDate(last.date, 0, recurrence, today);
      }
    }
    if (!due) continue;
    proposals.push({
      id: 'suggestion-' + proposals.length,
      label: redactCandidateLabel(last.description),
      amountPaise: last.amountPaise,
      recurrence, firstDueDate: due,
      supportingDates: group.slice(-(recurrence === 'WEEKLY' ? 4 : 3)).map(x => x.date),
      status: 'REQUIRES_USER_CONFIRMATION',
    });
  }
  return proposals.sort((a, b) => a.firstDueDate.localeCompare(b.firstDueDate)).slice(0, 20);
}
export function inspectCashStatementCsv(text, { today } = {}) {
  const rows = parseCashCsvTable(text);
  const headings = rows[0].map(h => headerIndex.get(canonicalHeader(h)) || null);
  for (const field of ['date', 'description', 'debit', 'credit']) {
    if (headings.filter(h => h === field).length !== 1) {
      fail('CSV must contain one each of Date, Description/Narration, Debit and Credit.');
    }
  }
  if (headings.some((h, i) => h && headings.indexOf(h) !== i)) {
    fail('Ambiguous repeated CSV column; import cancelled.');
  }
  const todayDate = today === undefined ? null : statementDate(today);
  // Build India dates from formatToParts rather than locale-dependent text.
  const indiaParts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const parts = Object.fromEntries(indiaParts.map(x => [x.type, x.value]));
  const confirmedToday = today === undefined ? parts.year + '-' + parts.month + '-' + parts.day : todayDate;
  const transactions = [];
  const ids = new Set();
  for (const [idx, cells] of rows.slice(1).entries()) {
    if (cells.length !== headings.length) fail('CSV row ' + (idx + 2) + ' has an unexpected number of columns.');
    const get = key => cells[headings.indexOf(key)];
    const date = statementDate(get('date'));
    if (date > confirmedToday) fail('Future-dated bank transactions cannot be presented as completed.');
    const originalDescription = get('description');
    // Reject suspicious control bytes BEFORE normalizing whitespace, which
    // otherwise conceals tabs/newlines in payee narrations.
    const invalidControl = Array.from(originalDescription).some(char => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127;
    });
    const description = originalDescription.replace(/\s+/g, ' ').trim();
    if (invalidControl || !description || description.length > 160 || Array.from(description).some(char => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127;
    })) {
      fail('CSV row ' + (idx + 2) + ' has an invalid narration.');
    }
    const debit = decimalPaise(get('debit'), { nullable: true });
    const credit = decimalPaise(get('credit'), { nullable: true });
    if ((debit > 0) === (credit > 0)) fail('Every transaction must contain exactly one positive debit or credit.');
    const transactionId = headings.includes('transactionId') ? get('transactionId').trim() : '';
    if (transactionId) {
      if (ids.has(transactionId)) fail('Duplicate transaction reference in the same statement.');
      ids.add(transactionId);
    }
    const balance = headings.includes('balance') ? decimalPaise(get('balance'), { nullable: true }) : null;
    transactions.push({ date, description, amountPaise: debit || credit,
      direction: debit > 0 ? 'DEBIT' : 'CREDIT', balancePaise: balance });
  }
  if (!transactions.length) fail('No completed transactions found.');
  const balanceEvidence = statementClosingBalance(transactions);
  transactions.sort((a, b) => a.date.localeCompare(b.date));
  const last = transactions[transactions.length - 1];
  return {
    provenance: 'USER_UPLOADED_CSV_NOT_BANK_VERIFIED',
    rowsInspected: transactions.length,
    firstTransactionDate: transactions[0].date,
    lastTransactionDate: last.date,
    lastReportedBalancePaise: balanceEvidence.balancePaise,
    lastReportedBalanceDate: balanceEvidence.balanceDate,
    balanceEvidenceStatus: balanceEvidence.status,
    // Only show a bounded list of settled debits dated TODAY to help the
    // user identify potential double-counting; no auto-matching or subtraction.
    settledToday: transactions.filter(item =>
      item.date === confirmedToday && item.direction === 'DEBIT')
      .slice(0, 20)
      .map(({ date, description, amountPaise }) => ({ date, description, amountPaise })),
    settledTodayTruncated: transactions.filter(item =>
      item.date === confirmedToday && item.direction === 'DEBIT').length > 20,
    freshness: last.date === confirmedToday ? 'DATED_TODAY_NOT_VERIFIED' : 'HISTORICAL_NOT_LIVE',
    proposals: proposalCandidates(transactions, confirmedToday),
    warning: 'This is locally uploaded, unverified history. Suggestions are not future bills until you confirm them; never add settled debits to opening cash.',
  };
}
