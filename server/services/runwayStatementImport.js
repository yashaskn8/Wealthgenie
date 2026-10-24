/**
 * Strict, no-network bank statement importer. Accepts a single explicitly
 * documented CSV schema, not arbitrary bank formats or undocumented guesses.
 * A valid statement is USER_IMPORTED_UNVERIFIED, never bank-authenticated.
 */
import { civilDate, MAX_PAISE } from './runwayEngine.js';
import { canonicalSha256 } from '../utils/canonicalJson.js';

export const STATEMENT_CSV_HEADER = 'date,description,debit,credit,balance,reference';
const LIMIT_BYTES = 48 * 1024;
const MAX_ROWS = 250;
const AMOUNT = /^(0|[1-9][0-9]{0,12})(?:\.([0-9]{1,2}))?$/;
const SIGNED = /^-?(?:0|[1-9][0-9]{0,12})(?:\.([0-9]{1,2}))?$/;
const RISKY_FORMULA = /^[\s\uFEFF]*[=+@\t\r]/u;
// Direction overrides can visually impersonate payees, accounts and references
// even though React safely escapes HTML. Reject formatting controls; ordinary
// non-Latin script characters remain supported.
const BIDI_FORMAT_CONTROLS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

export class RunwayStatementError extends Error {
  constructor(message, code = 'RUNWAY_STATEMENT_INVALID') {
    super(message);
    this.status = 400;
    this.code = code;
    this.clientMessage = message;
  }
}
const reject = message => { throw new RunwayStatementError(message); };

function rupees(value, { negative = false } = {}) {
  if (typeof value !== 'string' || !(negative ? SIGNED : AMOUNT).test(value)) {
    reject('Use plain rupee amounts with up to two decimal places and no grouping separators.');
  }
  const sign = value.startsWith('-') ? -1n : 1n;
  const positive = sign < 0n ? value.slice(1) : value;
  const [whole, fraction = ''] = positive.split('.');
  const amount = sign * (BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2)));
  if (amount > MAX_PAISE || amount < -MAX_PAISE) reject('Amount is outside the supported cash limit.');
  return amount;
}
function csvRows(text) {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > LIMIT_BYTES) {
    reject('CSV must be nonempty and at most 48 KiB.');
  }
  const rows = [];
  let row = [], cell = '', quoted = false, wasQuoted = false, justClosed = false;
  let pos = 0;
  const finishCell = () => {
    if (cell.length > 500) reject('CSV cell is too long.');
    row.push(cell);
    cell = '';
    wasQuoted = false;
    justClosed = false;
  };
  const finishRow = () => {
    finishCell();
    if (row.length === 1 && row[0] === '') { row = []; return; }
    if (row.length !== 6) reject('CSV must have exactly six fields on every row.');
    rows.push(row);
    if (rows.length > MAX_ROWS + 1) reject('CSV exceeds 250 transactions.');
    row = [];
  };
  while (pos < text.length) {
    const char = text[pos++];
    if (quoted) {
      if (char === '"') {
        if (text[pos] === '"') { cell += '"'; pos++; }
        else { quoted = false; justClosed = true; }
      } else if (char === '\r' || char === '\n') {
        reject('Multiline CSV fields are not accepted.');
      } else cell += char;
    } else if (char === '"') {
      if (cell || wasQuoted || justClosed) reject('Invalid CSV quoting.');
      quoted = true; wasQuoted = true;
    } else if (char === ',' || char === '\r' || char === '\n') {
      finishCell();
      if (char === ',') continue;
      if (char === '\r' && text[pos] === '\n') pos++;
      if (row.length !== 6) reject('CSV must have exactly six fields on every row.');
      rows.push(row);
      if (rows.length > MAX_ROWS + 1) reject('CSV exceeds 250 transactions.');
      row = [];
    } else {
      if (justClosed) reject('Unexpected characters after closing quote.');
      if (char === '\u0000') reject('CSV contains invalid control data.');
      cell += char;
      if (cell.length > 500) reject('CSV cell is too long.');
    }
  }
  if (quoted) reject('Unclosed CSV quote.');
  if (cell || row.length) finishRow();
  return rows;
}
function safeText(value, name, maxLength) {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > maxLength
      || RISKY_FORMULA.test(value) || BIDI_FORMAT_CONTROLS.test(value)
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    reject(name + ' contains unsafe or invalid text.');
  }
  return value.trim();
}
export function parseRunwayStatement({ accountLabel, csvText, today } = {}) {
  const label = safeText(accountLabel, 'Account label', 40);
  if (typeof today !== 'string') reject('A trustworthy India calendar date is required.');
  const current = civilDate(today);
  const rows = csvRows(csvText);
  if (rows.length < 2) reject('CSV must include the header and at least one transaction.');
  const actualHeader = rows[0].map(v => v.replace(/^\uFEFF/u, '').trim().toLowerCase()).join(',');
  if (actualHeader !== STATEMENT_CSV_HEADER) reject('CSV must use date,description,debit,credit,balance,reference, in this order.');
  const records = [];
  let openingBalance = null, lastBalance = null, lastDay = null;
  for (const [idx, fields] of rows.slice(1).entries()) {
    const [date, description, debitText, creditText, balanceText, reference] = fields;
    const parsedDate = civilDate(date);
    if (parsedDate.ordinal > current.ordinal || parsedDate.ordinal < current.ordinal - 1095) {
      reject('Statement date is in the future or more than three years old.');
    }
    if (lastDay !== null && parsedDate.ordinal < lastDay) reject('CSV transaction dates must be ascending.');
    const debit = rupees(debitText);
    const credit = rupees(creditText);
    const balance = rupees(balanceText, { negative: true });
    if ((debit > 0n) === (credit > 0n)) reject('Exactly one of debit and credit must be positive.');
    if (openingBalance === null) {
      openingBalance = balance + debit - credit;
      if (openingBalance > MAX_PAISE || openingBalance < -MAX_PAISE) reject('Statement opening balance exceeds supported bounds.');
    }
    if (lastBalance !== null && lastBalance + credit - debit !== balance) {
      reject('Running balance mismatch on row ' + (idx + 2) + '. Verify order and missing transactions.');
    }
    const entry = {
      date,
      description: safeText(description, 'Description', 120),
      debitPaise: String(debit),
      creditPaise: String(credit),
      balancePaise: String(balance),
      // Full reference text is not retained: use only an unkeyed transaction
      // discriminator, never a customer account or full payment identifier.
      referenceHash: canonicalSha256(safeText(reference, 'Reference', 100)),
    };
    records.push(entry);
    lastBalance = balance;
    lastDay = parsedDate.ordinal;
  }
  const periodStart = records[0].date;
  const periodEnd = records.at(-1).date;
  return {
    source: 'USER_IMPORTED_CSV',
    verification: 'USER_IMPORTED_UNVERIFIED',
    accountLabel: label,
    periodStart, periodEnd,
    openingBalancePaise: String(openingBalance),
    closingBalancePaise: String(lastBalance),
    transactionCount: records.length,
    records,
    // Deterministic digest makes a byte-equivalent import idempotent despite
    // BOM, harmless field quoting and line-ending differences.
    evidenceHash: canonicalSha256({ accountLabel: label, records }),
  };
}
