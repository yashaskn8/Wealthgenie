/**
 * Authenticated, owner- and evidence-bound encryption at rest for imported
 * self-reported bank statements. No automatic plaintext fallback.
 * The signing secret and encryption key MUST be independently generated.
 */
import crypto from 'node:crypto';
import { canonicalJson } from '../utils/canonicalJson.js';

const VERSION = 'RUNWAY_AES256GCM_V1';
const KIDS = new Set(['V1', 'V2']);
function unavailable(message = 'Runway evidence encryption key unavailable.') {
  const error = new Error(message);
  error.code = 'RUNWAY_EVIDENCE_KEY_UNAVAILABLE';
  throw error;
}
function integrity(message = 'Runway encrypted evidence cannot be authenticated.') {
  const error = new Error(message);
  error.code = 'RUNWAY_EVIDENCE_DECRYPTION_FAILED';
  throw error;
}
function getKey(env, kid) {
  if (!KIDS.has(kid)) unavailable();
  const value = env['RUNWAY_EVIDENCE_KEY_' + kid];
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) unavailable();
  if (value.toLowerCase() === String(env.RUNWAY_INTEGRITY_SECRET || '').toLowerCase()) {
    unavailable('Runway encryption and signing keys must be independent.');
  }
  return Buffer.from(value, 'hex');
}
function activeKid(env) {
  const kid = env.RUNWAY_EVIDENCE_ACTIVE_KID || 'V1';
  if (!KIDS.has(kid)) unavailable();
  return kid;
}
export function assertRunwayEvidenceEncryptionReady(env = process.env) {
  const kid = activeKid(env);
  getKey(env, kid);
  return true;
}
function aad(record) {
  if (!/^[a-f0-9]{64}$/.test(record?._id || '')
    || !/^[a-f0-9]{64}$/.test(record?.evidenceHash || '')
    || !/^[a-f0-9]{24}$/.test(String(record?.userId || ''))) integrity();
  return Buffer.from(canonicalJson({
    purpose: VERSION,
    owner: String(record.userId),
    statementId: record._id,
    evidenceHash: record.evidenceHash,
  }), 'utf8');
}
export function isRunwayStatementEncrypted(statement) {
  return statement?.encryptionVersion === VERSION;
}
export function encryptRunwayStatement(record, env = process.env) {
  const kid = activeKid(env);
  const key = getKey(env, kid);
  if (!record?.statement || isRunwayStatementEncrypted(record.statement)) integrity();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(aad(record));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(canonicalJson(record.statement), 'utf8')),
    cipher.final(),
  ]);
  return {
    encryptionVersion: VERSION, kid, iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('base64'),
  };
}
export function decryptRunwayStatement(record, env = process.env) {
  const envelope = record?.statement;
  if (!isRunwayStatementEncrypted(envelope)
    || !KIDS.has(envelope?.kid)
    || !/^[a-f0-9]{24}$/.test(envelope?.iv || '')
    || !/^[a-f0-9]{32}$/.test(envelope?.tag || '')
    || typeof envelope?.ciphertext !== 'string'
    || envelope.ciphertext.length < 4 || envelope.ciphertext.length > 500_000
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext)
    || Object.keys(envelope).sort().join(',') !== 'ciphertext,encryptionVersion,iv,kid,tag') {
    integrity('Unencrypted or malformed Runway evidence is not served. Migrate legacy evidence first.');
  }
  const key = getKey(env, envelope.kid);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key,
      Buffer.from(envelope.iv, 'hex'), { authTagLength: 16 });
    decipher.setAAD(aad(record));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final(),
    ]);
    const parsed = JSON.parse(plain.toString('utf8'));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object'
      || !Array.isArray(parsed.records)) integrity();
    return parsed;
  } catch { integrity(); }
}
