import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareRunwayEvidenceMigration } from '../services/runwayEvidenceMigration.js';
import { createRunwayStatementSeal, verifyRunwayStatementSeal, RUNWAY_SEAL_VERSION } from '../services/runwaySeal.js';
import { decryptRunwayStatement } from '../services/runwayEvidenceCrypto.js';
import { canonicalSha256 } from '../utils/canonicalJson.js';
const env = {
  RUNWAY_INTEGRITY_SECRET: 'a8'.repeat(32),
  RUNWAY_EVIDENCE_KEY_V1: 'b9'.repeat(32),
};
const statement = {
  accountLabel: 'Savings account', evidenceHash: '',
  records: [{ date: '2026-10-23', description: 'Employer salary private',
    debitPaise: '0', creditPaise: '1000', balancePaise: '5000',
    referenceHash: 'e'.repeat(64) }],
};
statement.evidenceHash = canonicalSha256({
  accountLabel: statement.accountLabel, records: statement.records,
});
const source = () => {
  const record = { _id: 'a'.repeat(64), userId: 'b'.repeat(24),
    statement: structuredClone(statement), evidenceHash: statement.evidenceHash,
    importedAt: new Date('2026-10-23T12:00:00.000Z'),
    sealVersion: RUNWAY_SEAL_VERSION };
  record.sealHmac = createRunwayStatementSeal(record, env);
  return record;
};
test('signed legacy plaintext transitions to ciphertext without changing source evidence', () => {
  const legacy = source();
  const result = prepareRunwayEvidenceMigration(legacy, env);
  const after = { ...legacy, ...result };
  assert.ok(result.statement.encryptionVersion);
  assert.equal(JSON.stringify(result).includes('Employer salary private'), false);
  assert.ok(verifyRunwayStatementSeal(after, env));
  assert.deepEqual(decryptRunwayStatement(after, env), statement);
  assert.equal(prepareRunwayEvidenceMigration(after, env), null);
});
test('legacy tampering and ciphertext tag substitution stop migration', () => {
  const legacy = source();
  assert.throws(() => prepareRunwayEvidenceMigration({
    ...legacy, statement: { ...legacy.statement, accountLabel: 'Forger' },
  }, env), e => e.code === 'RUNWAY_EVIDENCE_MIGRATION_FAILED');
  const encrypted = { ...legacy, ...prepareRunwayEvidenceMigration(legacy, env) };
  assert.throws(() => prepareRunwayEvidenceMigration({
    ...encrypted, statement: { ...encrypted.statement, tag: 'f'.repeat(32) },
  }, env), e => e.code === 'RUNWAY_EVIDENCE_MIGRATION_FAILED');
});
