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
  });  it('flags settled-today outflows for human double-count review without changing cash', () => {
    const r = inspectCashStatementCsv(headers
      + '2026-10-01,Rent already withdrawn,12000,,8000\n'
      + '2026-10-01,Salary,,50000,58000\n', { today: '2026-10-01' });
    expect(r.lastReportedBalancePaise).toBe(5800000);
    expect(r.settledToday).toEqual([{ date: '2026-10-01',
      description: 'Rent already withdrawn', amountPaise: 1200000 }]);
    expect(r.proposals).toEqual([]);
    expect(r).not.toHaveProperty('openingCashPaise');
  });

  it('supports descending bank order only when debit/credit balance arithmetic reconciles', () => {
    const csv = headers + '2026-09-03,Salary,,500,1500\n'
      + '2026-09-02,Rent,200,,1000\n'
      + '2026-09-01,Salary,,700,1200\n';
    const report = inspectCashStatementCsv(csv, { today: '2026-10-01' });
    expect(report.lastReportedBalancePaise).toBe(150000);
    expect(report.lastReportedBalanceDate).toBe('2026-09-03');
    expect(report.balanceEvidenceStatus).toBe('FILE_ARITHMETIC_RECONCILED_UNVERIFIED');
  });
  it('suppresses a bank balance for missing, inconsistent or shuffled entries', () => {
    const samples = [
      headers + '2026-09-03,Salary,,500,1500\n2026-09-01,Rent,200,,1200\n2026-09-02,Shop,10,,1000\n',
      headers + '2026-09-01,Rent,200,,1000\n2026-09-02,Shop,10,,800\n',
      headers + '2026-09-01,Rent,200,,1000\n2026-09-02,Shop,10,,\n',
    ];
    for (const csv of samples) {
      const report = inspectCashStatementCsv(csv, { today: '2026-10-01' });
      expect(report.lastReportedBalancePaise).toBeNull();
      expect(report.lastReportedBalanceDate).toBeNull();
    }
  });
  it('ignores duplicate same-date receipts as independent recurring-payment evidence', () => {
    const csv = headers + '2026-07-05,Rent,15000,,60000\n'
      + '2026-08-05,Rent,15000,,45000\n'
      + '2026-08-05,Rent,15000,,30000\n'
      + '2026-09-05,Rent,15000,,15000\n';
    expect(inspectCashStatementCsv(csv, { today: '2026-10-01' }).proposals).toEqual([]);
  });
  it('redacts personal bank references and emails from recurring labels', () => {
    const csv = 'Date,Description,Debit,Credit\n'
      + [7, 8, 9].map(m => '2026-0' + m + '-05,Rent ref 123456789012 payee@example.com,15000,').join('\n');
    const label = inspectCashStatementCsv(csv, { today: '2026-10-01' }).proposals[0].label;
    expect(label).not.toContain('123456789012');
    expect(label).not.toContain('payee@example.com');
    expect(label).toContain('[reference redacted]');
    expect(label).toContain('[email redacted]');
  });
  it('sorts the 20 earliest upcoming candidates before truncation', () => {
    const lines = [];
    for (let i = 0; i < 25; i += 1) {
      const day = String(i + 1).padStart(2, '0');
      for (const month of ['07', '08', '09']) {
        lines.push('2026-' + month + '-' + day + ',Bill ' + i + ',100,');
      }
    }
    const report = inspectCashStatementCsv('Date,Description,Debit,Credit\n' + lines.join('\n'),
      { today: '2026-10-01' });
    expect(report.proposals).toHaveLength(20);
    expect(report.proposals[0].firstDueDate).toBe('2026-10-01');
    expect(report.proposals.at(-1).firstDueDate).toBe('2026-10-20');
  });
  it('rejects hidden control characters before normalizing narration whitespace', () => {
    const csv = 'Date,Description,Debit,Credit\n2026-09-01,"Bill\twith tab",500,\n';
    expect(() => inspectCashStatementCsv(csv, { today: '2026-10-01' })).toThrow(CashCsvError);
  });

});
