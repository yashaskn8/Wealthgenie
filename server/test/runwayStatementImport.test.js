import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRunwayStatement } from '../services/runwayStatementImport.js';

const today = '2026-10-23';
const csv = [
  'date,description,debit,credit,balance,reference',
  '2026-10-21,"Opening salary",0,25000.75,30000.75,SAL123',
  '2026-10-22,UPI transfer,1500.20,0,28500.55,TXN1',
  '2026-10-23,Rent,12000.55,0,16500.00,TXN2',
].join('\r\n');
const parse = (data = csv, label = 'Salary account') => parseRunwayStatement({ csvText: data, accountLabel: label, today });
test('strict Indian rupee CSV reconciles every row using integer paise', () => {
  const x = parse();
  assert.equal(x.openingBalancePaise, '500000');
  assert.equal(x.closingBalancePaise, '1650000');
  assert.equal(x.transactionCount, 3);
  assert.equal(x.source, 'USER_IMPORTED_CSV');
  assert.equal(x.verification, 'USER_IMPORTED_UNVERIFIED');
  assert.equal(x.records[1].debitPaise, '150020');
  assert.ok(/^[a-f0-9]{64}$/.test(x.records[0].referenceHash));
  assert.equal(parse('\uFEFF' + csv.replaceAll('\r\n', '\n')).evidenceHash, x.evidenceHash);
});
test('rejects fabricated running totals, future dates, reversed rows and both debit+credit', () => {
  for (const bad of [
    csv.replace('28500.55', '28501.55'),
    csv.replace('2026-10-21', '2026-10-24'),
    csv.replace('2026-10-23,Rent', '2026-10-20,Rent'),
    csv.replace('1500.20,0', '1500.20,1'),
    csv.replace('1500.20,0', '0,0'),
    csv.replace('25000.75', '25000.751'),
    csv.replace('2026-10-22,UPI', '2026-09-22,UPI'),
    csv.replace('2026-10-22,UPI transfer', '2026-10-22,=HYPERLINK("evil")'),
  ]) assert.throws(() => parse(bad));
});
test('rejects formula injection, missing references, giant CSV and malformed quote escapes', () => {
  for (const bad of [
    csv.replace('TXN2', '@formula'),
    csv.replace('TXN2', ''),
    csv.replace('TXN2', 'bad"quote'),
    csv.replace('Rent', '"Rent'),
    csv.replace('date,description,debit,credit,balance,reference',
      'date,debit,description,credit,balance,reference'),
    csv + '\n' + 'a'.repeat(192 * 1024),
  ]) assert.throws(() => parse(bad));
  assert.throws(() => parse(csv, '=HYPERLINK()'));
});
test('handles one row, negative overdraft balances, quoted commas and zero-sized opening', () => {
  const one = parse(['date,description,debit,credit,balance,reference',
    '2026-10-23,"ATM, main branch",200.00,0,-200.00,abc'].join('\n'));
  assert.equal(one.openingBalancePaise, '0');
  assert.equal(one.closingBalancePaise, '-20000');
  assert.equal(one.records[0].description, 'ATM, main branch');
});
test('bounded deterministic statement parser caps 250 transactions', () => {
  const lines = Array.from({ length: 251 }, (_, n) =>
    '2026-10-23,Salary,0,1.00,' + (n + 1) + '.00,ref' + n);
  assert.throws(() => parse('date,description,debit,credit,balance,reference\n' + lines.join('\n')));
});
