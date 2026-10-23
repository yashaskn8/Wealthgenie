/**
 * Tamper-evident Household Runway result sealing, independent of MongoDB.
 * A database-only writer cannot recalculate this HMAC without the server key.
 * Key rotation must preserve access to old sealed records (no silent fallback).
 */
import crypto from 'node:crypto';
import { canonicalJson } from '../utils/canonicalJson.js';

export const RUNWAY_SEAL_VERSION = 'HMAC_SHA256_V1';

function keyFromEnv(env) {
  const value = env.RUNWAY_INTEGRITY_SECRET;
  if (typeof value !== 'string' || !/^(?:[a-fA-F0-9]{2}){32,64}$/.test(value)) {
    const error = new Error('Household Runway snapshot signing key is unavailable.');
    error.code = 'RUNWAY_SEAL_KEY_UNAVAILABLE';
    throw error;
  }
  return Buffer.from(value, 'hex');
}
function sealPayload(record) {
  return {
    purpose: 'WEALTHGENIE_RUNWAY_SNAPSHOT_V1',
    snapshotId: String(record._id),
    userId: String(record.userId),
    ledgerRevision: record.ledgerRevision,
    inputHash: record.inputHash,
    requestHash: record.requestHash,
    request: record.request,
    resultHash: record.resultHash,
    result: record.result,
    createdAt: record.createdAt,
  };
}
export function createRunwaySeal(record, env = process.env) {
  return crypto.createHmac('sha256', keyFromEnv(env))
    .update('wealthgenie:household-runway:snapshot:v1:', 'utf8')
    .update(canonicalJson(sealPayload(record)), 'utf8')
    .digest('hex');
}
export function verifyRunwaySeal(record, env = process.env) {
  // Validate key availability even if the DB record lacks a seal. Never
  // downgrade to an unauthenticated SHA256-only "verified" response.
  const expected = createRunwaySeal(record, env);
  if (record.sealVersion !== RUNWAY_SEAL_VERSION
      || typeof record.sealHmac !== 'string'
      || !/^[a-f0-9]{64}$/.test(record.sealHmac)) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(record.sealHmac, 'hex'));
}

function ledgerSealPayload(record) {
  return {
    purpose: 'WEALTHGENIE_RUNWAY_LEDGER_REVISION_V1',
    userId: String(record.userId),
    revision: record.revision,
    ledger: record.ledger,
    inputHash: record.inputHash,
    confirmedAt: record.confirmedAt,
  };
}
export function createRunwayLedgerSeal(record, env = process.env) {
  return crypto.createHmac('sha256', keyFromEnv(env))
    .update('wealthgenie:household-runway:ledger-revision:v1:', 'utf8')
    .update(canonicalJson(ledgerSealPayload(record)), 'utf8')
    .digest('hex');
}
export function verifyRunwayLedgerSeal(record, env = process.env) {
  const expected = createRunwayLedgerSeal(record, env);
  if (record.sealVersion !== RUNWAY_SEAL_VERSION
      || typeof record.sealHmac !== 'string'
      || !/^[a-f0-9]{64}$/.test(record.sealHmac)) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(record.sealHmac, 'hex'));
}

/** Validate startup readiness without exporting or logging the signing key. */
export function assertRunwaySigningKey(env = process.env) {
  keyFromEnv(env);
  return true;
}
