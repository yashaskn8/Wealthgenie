import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptRunwayStatement, decryptRunwayStatement,
  assertRunwayEvidenceEncryptionReady } from '../services/runwayEvidenceCrypto.js';

const env = {
  RUNWAY_EVIDENCE_ACTIVE_KID: 'V1',
  RUNWAY_EVIDENCE_KEY_V1: '8a'.repeat(32),
  RUNWAY_EVIDENCE_KEY_V2: 'bc'.repeat(32),
  RUNWAY_INTEGRITY_SECRET: 'cd'.repeat(32),
};
const record = {
  _id: 'a'.repeat(64), userId: 'b'.repeat(24), evidenceHash: 'c'.repeat(64),
  statement: { accountLabel: 'Salary account', openingBalancePaise: '500000',
    records: [{ description: 'Private ₹salary UPI', date: '2026-10-23', debitPaise: '0' }] },
};
test('AES-256-GCM hides whole financial statement and uses authenticated owner/source AAD', () => {
  assertRunwayEvidenceEncryptionReady(env);
  const first = encryptRunwayStatement(record, env);
  const next = encryptRunwayStatement(record, env);
  assert.notDeepEqual(first, next, 'Fresh 96-bit random nonce per encryption');
  assert.equal(JSON.stringify(first).includes('Private'), false);
  assert.equal(JSON.stringify(first).includes('Salary account'), false);
  assert.deepEqual(decryptRunwayStatement({ ...record, statement: first }, env), record.statement);
  for (const tampered of [
    { ...record, userId: 'f'.repeat(24), statement: first },
    { ...record, _id: 'f'.repeat(64), statement: first },
    { ...record, evidenceHash: 'f'.repeat(64), statement: first },
    { ...record, statement: { ...first, tag: 'f'.repeat(32) } },
    { ...record, statement: { ...first, ciphertext: 'AA==' } },
    { ...record, statement: record.statement },
  ]) assert.throws(() => decryptRunwayStatement(tampered, env),
    e => e.code === 'RUNWAY_EVIDENCE_DECRYPTION_FAILED');
});
test('rotating new writes to V2 preserves V1 reads only while old key remains present', () => {
  const first = encryptRunwayStatement(record, env);
  const rotated = { ...env, RUNWAY_EVIDENCE_ACTIVE_KID: 'V2' };
  const second = encryptRunwayStatement(record, rotated);
  assert.equal(second.kid, 'V2');
  assert.deepEqual(decryptRunwayStatement({ ...record, statement: first }, rotated), record.statement);
  assert.deepEqual(decryptRunwayStatement({ ...record, statement: second }, rotated), record.statement);
  assert.throws(() => decryptRunwayStatement({
    ...record, statement: first,
  }, { ...rotated, RUNWAY_EVIDENCE_KEY_V1: '' }), e => e.code === 'RUNWAY_EVIDENCE_KEY_UNAVAILABLE');
});
test('invalid, reused or missing keys fail closed, never decrypt with the signing key', () => {
  for (const changed of [
    { ...env, RUNWAY_EVIDENCE_KEY_V1: '' },
    { ...env, RUNWAY_EVIDENCE_KEY_V1: 'f'.repeat(63) },
    { ...env, RUNWAY_EVIDENCE_KEY_V1: env.RUNWAY_INTEGRITY_SECRET },
    { ...env, RUNWAY_EVIDENCE_ACTIVE_KID: 'V3' },
  ]) assert.throws(() => assertRunwayEvidenceEncryptionReady(changed),
    e => e.code === 'RUNWAY_EVIDENCE_KEY_UNAVAILABLE');
});

test('V2 activation requires a different V1 key to retain historical decryptability', () => {
  const v2 = { ...env, RUNWAY_EVIDENCE_ACTIVE_KID: 'V2' };
  assert.equal(assertRunwayEvidenceEncryptionReady(v2), true);
  assert.throws(() => assertRunwayEvidenceEncryptionReady({
    ...v2, RUNWAY_EVIDENCE_KEY_V1: '',
  }), e => e.code === 'RUNWAY_EVIDENCE_KEY_UNAVAILABLE');
  assert.throws(() => assertRunwayEvidenceEncryptionReady({
    ...v2, RUNWAY_EVIDENCE_KEY_V2: env.RUNWAY_EVIDENCE_KEY_V1,
  }), e => e.code === 'RUNWAY_EVIDENCE_KEY_UNAVAILABLE');
});
