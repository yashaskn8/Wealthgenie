import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareRunwayEvidenceMigration, prepareRunwaySettlementIdentityMigration,
} from '../services/runwayEvidenceMigration.js';
import {
  createRunwayStatementSeal, verifyRunwayStatementSeal,
  createRunwaySettlementSeal, verifyRunwaySettlementSeal, RUNWAY_SEAL_VERSION,
} from '../services/runwaySeal.js';
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

test('legacy settlement identity backfill binds exact signed source row', () => {
  const original = source();
  const row = original.statement.records[0];
  const receipt = {
    _id: '1'.repeat(64), userId: original.userId,
    requestHash: '2'.repeat(64), ledgerRevision: 1, resultRevision: 2,
    priorInputHash: '3'.repeat(64), nextInputHash: '4'.repeat(64),
    statementId: original._id, rowIndex: 0, entryId: 'salary',
    rowHash: canonicalSha256(row), confirmedCashPaise: '5000',
    decidedAt: new Date('2026-10-23T13:00:00.000Z'),
    sealVersion: RUNWAY_SEAL_VERSION,
  };
  receipt.sealHmac = createRunwaySettlementSeal(receipt, env);
  assert.equal(verifyRunwaySettlementSeal(receipt, env), false,
    'Old receipts must not be accepted by live production before migration');
  const migrated = prepareRunwaySettlementIdentityMigration(receipt, original, env);
  const upgraded = { ...receipt, ...migrated };
  assert.ok(/^[a-f0-9]{64}$/.test(migrated.transactionIdentity));
  assert.equal(verifyRunwaySettlementSeal(upgraded, env), true);
  assert.equal(prepareRunwaySettlementIdentityMigration(upgraded, null, env), null);
  assert.throws(() => prepareRunwaySettlementIdentityMigration(receipt, null, env),
    e => e.code === 'RUNWAY_EVIDENCE_MIGRATION_FAILED');
  assert.throws(() => prepareRunwaySettlementIdentityMigration({
    ...receipt, rowHash: 'f'.repeat(64),
  }, original, env), e => e.code === 'RUNWAY_EVIDENCE_MIGRATION_FAILED');
});
