/**
 * Explicit, replay-safe transition from signed legacy plaintext imports to
 * independent AES-GCM encryption. NEVER silently migrate on normal API reads.
 */
import { canonicalSha256 } from '../utils/canonicalJson.js';
import { encryptRunwayStatement, decryptRunwayStatement,
  isRunwayStatementEncrypted } from './runwayEvidenceCrypto.js';
import { createRunwayStatementSeal, verifyRunwayStatementSeal } from './runwaySeal.js';

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
