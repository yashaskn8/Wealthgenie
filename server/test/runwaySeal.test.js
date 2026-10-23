import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunwaySeal, verifyRunwaySeal, RUNWAY_SEAL_VERSION } from '../services/runwaySeal.js';

const env = { RUNWAY_INTEGRITY_SECRET: '8f'.repeat(32) };
const record = () => ({
  _id: 'a'.repeat(64), userId: 'b'.repeat(24), ledgerRevision: 1,
  inputHash: 'c'.repeat(64), requestHash: 'd'.repeat(64),
  request: { ledgerRevision: 1, horizonDays: 1, scenarios: [] },
  result: { engineVersion: 'runway-cashflow-1.2.0', status: 'READY', scenarios: [] },
  resultHash: 'e'.repeat(64), createdAt: new Date('2026-10-23T10:00:00.000Z'),
  sealVersion: RUNWAY_SEAL_VERSION,
});
test('HMAC binds every critical financial assertion and owner across DB rewrites', () => {
  const base = record(); base.sealHmac = createRunwaySeal(base, env);
  assert.equal(verifyRunwaySeal(base, env), true);
  for (const changed of [
    { ...base, userId: 'f'.repeat(24) },
    { ...base, _id: 'f'.repeat(64) },
    { ...base, ledgerRevision: 2 },
    { ...base, inputHash: 'f'.repeat(64) },
    { ...base, requestHash: 'f'.repeat(64) },
    { ...base, request: { ...base.request, horizonDays: 2 } },
    { ...base, result: { ...base.result, status: 'NO_LISTED_SHORTFALL' } },
    { ...base, resultHash: 'f'.repeat(64) },
    { ...base, createdAt: new Date('2026-10-24T10:00:00.000Z') },
    { ...base, sealHmac: 'f'.repeat(64) },
    { ...base, sealVersion: 'LEGACY' },
  ]) assert.equal(verifyRunwaySeal(changed, env), false);
});
test('missing, too-short and malformed keys never downgrade to checksum-only access', () => {
  const base = record(); base.sealHmac = createRunwaySeal(base, env);
  for (const val of [undefined, '', 'x', 'f'.repeat(63), 'z'.repeat(64)]) {
    assert.throws(() => verifyRunwaySeal(base, { RUNWAY_INTEGRITY_SECRET: val }), /unavailable/i);
    assert.throws(() => createRunwaySeal(base, { RUNWAY_INTEGRITY_SECRET: val }), /unavailable/i);
  }
  assert.equal(verifyRunwaySeal({ ...base, sealHmac: '' }, env), false);
});
