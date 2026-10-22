import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintQualifiedHistory } from '../services/qualifiedHistoryFingerprint.js';

const rows = Array.from({length: 100}, (_, i) => ({
  id: String(i + 1),
  value: (100 + i / 10).toFixed(8),
  observed_at: new Date(Date.UTC(2026, 5, i + 1)).toISOString(),
  source_id: 'qualified-provider',
  source_instrument_id: 'ISIN:TEST',
  source_revision: '0',
  data_class: 'END_OF_DAY',
}));

test('the entire market history must remain unchanged across a computation', () => {
  const start = fingerprintQualifiedHistory(rows);
  assert.equal(fingerprintQualifiedHistory(rows.map(x => ({...x}))), start);
  const changedMiddle = rows.map((x, i) => i === 50
    ? {...x, value: '124.00000000', source_revision: '1'} : x);
  assert.equal(changedMiddle.length, rows.length);
  assert.equal(changedMiddle[0].id, rows[0].id);
  assert.equal(changedMiddle.at(-1).id, rows.at(-1).id);
  assert.notEqual(fingerprintQualifiedHistory(changedMiddle), start);
  const changedTime = rows.map((x, i) => i === 50
    ? {...x, observed_at: '2026-08-12T00:00:00.000Z'} : x);
  assert.notEqual(fingerprintQualifiedHistory(changedTime), start);
  assert.notEqual(fingerprintQualifiedHistory([...rows].reverse()), start);
  assert.notEqual(fingerprintQualifiedHistory(rows.slice(1)), start);
});

test('a changed instrument/source and invalid history shape fail the identity check', () => {
  const original = fingerprintQualifiedHistory(rows);
  assert.notEqual(fingerprintQualifiedHistory(rows.map((x, i) => i === 50
    ? {...x, source_instrument_id: 'ISIN:OTHER'} : x)), original);
  assert.throws(() => fingerprintQualifiedHistory(null), /Bounded/);
  assert.throws(() => fingerprintQualifiedHistory([null]), /record/);
});
