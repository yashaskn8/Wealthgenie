/**
 * Explicit, replay-safe transition from signed legacy plaintext imports to
 * independent AES-GCM encryption. NEVER silently migrate on normal API reads.
 */
import crypto from 'node:crypto';
import { canonicalSha256 } from '../utils/canonicalJson.js';
import { runwayTransactionIdentity } from './runwayReconciliation.js';
import { encryptRunwayStatement, decryptRunwayStatement,
  isRunwayStatementEncrypted } from './runwayEvidenceCrypto.js';
import {
  createRunwayStatementSeal, verifyRunwayStatementSeal,
  createRunwaySettlementSeal, verifyRunwaySettlementSeal,
} from './runwaySeal.js';

function bad(message) {
  const error = new Error(message);
  error.code = 'RUNWAY_EVIDENCE_MIGRATION_FAILED';
  throw error;
}
export function prepareRunwayEvidenceMigration(record, env = process.env) {
  if (!record?.statement) bad('Statement missing.');
  if (!verifyRunwayStatementSeal(record, env)) bad('Legacy evidence signature invalid.');
  if (isRunwayStatementEncrypted(record.statement)) {
    const plaintext = decryptRunwayStatement(record, env);
    if (canonicalSha256({
      accountLabel: plaintext.accountLabel, records: plaintext.records,
    }) !== record.evidenceHash || plaintext.evidenceHash !== record.evidenceHash) {
      bad('Encrypted evidence no longer matches original checksum.');
    }
    return null;
  }
  const original = record.statement;
  if (!Array.isArray(original.records)
    || canonicalSha256({
      accountLabel: original.accountLabel, records: original.records,
    }) !== record.evidenceHash || original.evidenceHash !== record.evidenceHash) {
    bad('Legacy plaintext does not match original checksum.');
  }
  const encrypted = encryptRunwayStatement(record, env);
  const newRecord = { ...record, statement: encrypted };
  const sealHmac = createRunwayStatementSeal(newRecord, env);
  const decoded = decryptRunwayStatement(newRecord, env);
  if (canonicalSha256(decoded) !== canonicalSha256(original)
    || !verifyRunwayStatementSeal({ ...newRecord, sealHmac }, env)) {
    bad('Evidence encryption changed financial data or cannot be verified.');
  }
  return { statement: encrypted, sealHmac };
}

/**
 * Offline migration of previously valid signed settlement receipts whose
 * cross-import identity was not included in the original HMAC payload.
 * This can only proceed while the original signed statement still exists.
 */
export function prepareRunwaySettlementIdentityMigration(receipt, source, env = process.env) {
  if (receipt?.transactionIdentity != null) {
    if (!verifyRunwaySettlementSeal(receipt, env)) bad('Existing receipt identity HMAC invalid.');
    return null;
  }
  if (!receipt || typeof receipt.sealHmac !== 'string'
    || !/^[a-f0-9]{64}$/.test(receipt.sealHmac)) bad('Invalid legacy settlement.');
  const oldExpected = createRunwaySettlementSeal(receipt, env);
  if (!crypto.timingSafeEqual(Buffer.from(oldExpected, 'hex'),
    Buffer.from(receipt.sealHmac, 'hex'))) bad('Legacy settlement HMAC invalid.');
  if (!source || String(source.userId) !== String(receipt.userId)
    || source._id !== receipt.statementId || !verifyRunwayStatementSeal(source, env)) {
    bad('Original owner-scoped signed statement unavailable. Manual recovery required.');
  }
  const statement = isRunwayStatementEncrypted(source.statement)
    ? decryptRunwayStatement(source, env) : source.statement;
  if (!Array.isArray(statement.records)
    || canonicalSha256({
      accountLabel: statement.accountLabel, records: statement.records,
    }) !== source.evidenceHash || statement.evidenceHash !== source.evidenceHash) {
    bad('Original statement checksum mismatch.');
  }
  const row = statement.records[receipt.rowIndex];
  if (!row || canonicalSha256(row) !== receipt.rowHash) {
    bad('Posted row is missing or differs from the original signed receipt.');
  }
  const transactionIdentity = runwayTransactionIdentity({
    statementId: source._id, statement,
  }, row);
  const upgraded = { ...receipt, transactionIdentity };
  const sealHmac = createRunwaySettlementSeal(upgraded, env);
  if (!verifyRunwaySettlementSeal({ ...upgraded, sealHmac }, env)) {
    bad('Resealed settlement receipt failed verification.');
  }
  return { transactionIdentity, sealHmac };
}
