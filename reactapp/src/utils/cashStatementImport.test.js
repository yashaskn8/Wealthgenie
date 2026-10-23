import { describe, it, expect } from 'vitest';
import { inspectCashStatementCsv, parseCashCsvTable, CashCsvError, MAX_CASH_CSV_ROWS } from './cashStatementImport';

const headers = 'Date,Description,Debit,Credit,Balance\n';
const threeMonths = headers
  + '05/07/2026,Flat rent,15000.01,,45000.00\n'
  + '05/08/2026,Flat rent,15000.01,,29999.99\n'
  + '05/09/2026,Flat rent,15000.01,,14999.98\n';

describe('local-only Indian bank statement review', () => {
  it('parses exact paise, day-first dates and proposes only reviewed FUTURE payments', () => {
    const report = inspectCashStatementCsv(threeMonths, { today: '2026-10-01' });
    expect(report).toMatchObject({
      rowsInspected: 3, firstTransactionDate: '2026-07-05',
      lastTransactionDate: '2026-09-05', lastReportedBalancePaise: 1499998,
      freshness: 'HISTORICAL_NOT_LIVE',
    });
    expect(report.proposals).toEqual([expect.objectContaining({
      label: 'Flat rent', amountPaise: 1500001, recurrence: 'MONTHLY',
      firstDueDate: '2026-10-05', status: 'REQUIRES_USER_CONFIRMATION',
      supportingDates: ['2026-07-05', '2026-08-05', '2026-09-05'],
    })]);
    expect(JSON.stringify(report)).not.toContain('45000.00');
    expect(report).not.toHaveProperty('transactions');
  });
  it('handles quoted comma narrations, escaped quotes, CRLF, BOM and exact thousand separators', () => {
    const input = '\uFEFFDate,Narration,Withdrawal Amt,Deposit Amt,Balance\r\n'
      + '"2026-09-09","Rent, ""Block A""","₹1,234.50",,"2,005.01"\r\n';
    const parsed = inspectCashStatementCsv(input, { today: '2026-10-01' });
    expect(parsed.rowsInspected).toBe(1);
    expect(parsed.lastReportedBalancePaise).toBe(200501);
    expect(parsed.proposals).toEqual([]);
  });
  it('finds candidate weekly payments from four exact previous occurrences', () => {
    const csv = 'Transaction Date,Particulars,Withdrawal,Deposit\n'
      + [8, 15, 22, 29].map(day => '2026-09-' + String(day).padStart(2, '0') + ',School lunch,120.50,').join('\n');
    const r = inspectCashStatementCsv(csv, { today: '2026-10-01' });
    expect(r.proposals).toEqual([expect.objectContaining({
      amountPaise: 12050, recurrence: 'WEEKLY', firstDueDate: '2026-10-06',
    })]);
  });
  it('never assumes future income or recurrences from one-off or varying debits', () => {
    const partial = headers + '2026-08-05,Rent,15000,,70000\n2026-09-05,Rent,15000,,55000\n';
    const varying = headers + '2026-07-05,Rent,15000,,70000\n2026-08-05,Rent,17000,,53000\n2026-09-05,Rent,15000,,38000\n';
    const credits = headers + '2026-07-05,Salary,,75000,100000\n2026-08-05,Salary,,75000,100000\n2026-09-05,Salary,,75000,100000\n';
    for (const csv of [partial, varying, credits]) {
      expect(inspectCashStatementCsv(csv, { today: '2026-10-01' }).proposals).toEqual([]);
    }
  });
  it('distinguishes file-dated-today from a verified live bank connection', () => {
    const r = inspectCashStatementCsv(headers + '2026-10-01,ATM withdrawal,1000,,10000\n',
      { today: '2026-10-01' });
    expect(r.freshness).toBe('DATED_TODAY_NOT_VERIFIED');
    expect(r.provenance).toBe('USER_UPLOADED_CSV_NOT_BANK_VERIFIED');
    expect(r.lastReportedBalancePaise).toBe(1000000);
  });
  it('fails closed on ambiguous dates, amounts, schema, duplicates and quoting', () => {
    const invalids = [
      'Date,Description,Debit,Debit,Credit\n2026-09-01,Rent,10,10,\n',
      'Date,Description,Debit,Credit\n2026-09-01,Rent,10,10\n',
      'Date,Description,Debit,Credit\n2026-09-01,Rent,,\n',
      'Date,Description,Debit,Credit\n09/14/2026,Rent,10,\n',
      'Date,Description,Debit,Credit\n2026-02-29,Rent,10,\n',
      'Date,Description,Debit,Credit\n2026-11-01,Rent,10,\n',
      'Date,Description,Debit,Credit\n2026-09-01,Rent,-10,\n',
      'Date,Description,Debit,Credit\n2026-09-01,Rent,1.001,\n',
      'Date,Description,Debit,Credit\n2026-09-01,Rent,1,23,',
      'Date,Description,Debit,Credit\n2026-09-01,Rent,99999999999,\n',
      'Date,Description,Debit,Credit\n2026-09-01,"broken,10,\n',
      'Date,Description,Debit,Credit,Transaction ID\n2026-09-01,Rent,100,,dup\n2026-09-02,Rent,100,,dup\n',
      'Date,Description,Credit\n2026-09-01,Salary,9000\n',
    ];
    for (const input of invalids) expect(() => inspectCashStatementCsv(input, {
      today: '2026-10-01',
    })).toThrow(CashCsvError);
  });
  it('retains legitimate same-day duplicate debits when no transaction IDs are supplied', () => {
    const csv = headers + '2026-09-01,Cafe,10,,100\n2026-09-01,Cafe,10,,90\n';
    expect(inspectCashStatementCsv(csv, { today: '2026-10-01' }).rowsInspected).toBe(2);
  });
  it('bounds rows, cell size and rejects control characters', () => {
    expect(() => parseCashCsvTable('Date,Description\n"unterminated')).toThrow(CashCsvError);
    expect(() => parseCashCsvTable('Date,Description\nbad"\n')).toThrow(CashCsvError);
    expect(() => parseCashCsvTable('A,' + 'x'.repeat(513) + '\nB,C')).toThrow(CashCsvError);
    expect(() => parseCashCsvTable('A,B\nC,\0')).toThrow(CashCsvError);
    const rows = 'Date,Description,Debit,Credit\n'
      + Array.from({ length: MAX_CASH_CSV_ROWS + 1 }, (_, i) => '2026-09-01,R' + i + ',10,').join('\n');
    expect(() => inspectCashStatementCsv(rows, { today: '2026-10-01' })).toThrow(CashCsvError);
  });
  it('rejects obsolete historical patterns rather than forecasting confidence', () => {
    expect(inspectCashStatementCsv(threeMonths, { today: '2026-11-20' }).proposals).toEqual([]);
  });
});
