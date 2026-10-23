import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Authenticate decision snapshots with a key stored outside MongoDB.
 *
 * Production must configure GENIEDECISION_INTEGRITY_KEYS as a JSON object
 * of named 32+ byte hex keys, and GENIEDECISION_ACTIVE_KEY_ID. Keep old
 * key entries during rotation so existing receipts remain independently
 * verifiable. Test/development may derive a domain-separated key from
 * JWT_SECRET; this fallback is never permitted in production.
 */
export class DecisionIntegrityUnavailable extends Error {
  constructor() {
    super('GenieDecision authenticated receipt signing is unavailable.');
    this.name = 'DecisionIntegrityUnavailable';
    this.code = 'DECISION_INTEGRITY_UNAVAILABLE';
  }
}

const validKeyId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(id);
const failClosed = () => { throw new DecisionIntegrityUnavailable(); };

function getKeys() {
  const configured = process.env.GENIEDECISION_INTEGRITY_KEYS;
  if (configured !== undefined) {
    let entries;
    try {
      entries = JSON.parse(configured);
    } catch { failClosed(); }
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)
        || Object.keys(entries).length < 1 || Object.keys(entries).length > 8) failClosed();
    const keys = new Map();
    for (const [id, hex] of Object.entries(entries)) {
      if (!validKeyId(id) || typeof hex !== 'string'
          || !/^(?:[a-fA-F0-9]{2}){32,128}$/.test(hex)) failClosed();
      keys.set(id, Buffer.from(hex, 'hex'));
    }
    const active = process.env.GENIEDECISION_ACTIVE_KEY_ID;
    if (!validKeyId(active) || !keys.has(active)) failClosed();
    return { active, keys };
  }
  if (process.env.NODE_ENV === 'production') failClosed();
  const secret = process.env.JWT_SECRET;
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 16) failClosed();
  const key = createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update('WealthGenie/GenieDecision/private-integrity-signing/dev-only/v1')
    .digest();
  return { active: 'dev_v1', keys: new Map([['dev_v1', key]]) };
}

export function decisionIntegrityReady() {
  try { getKeys(); return true; } catch { return false; }
}

function stable(value, depth = 0) {
  if (depth > 30) failClosed();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => stable(item, depth + 1));
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') failClosed();
      sorted[key] = stable(value[key], depth + 1);
    }
    return sorted;
  }
  failClosed();
}

function message(purpose, context, payload) {
  if (!validKeyId(purpose)) failClosed();
  const document = JSON.stringify(stable({
    domain: 'wealthgenie.geniedecision.receipt.v1',
    purpose, context, payload,
  }));
  if (Buffer.byteLength(document) > 2_000_000) failClosed();
  return document;
}

export function signDecisionReceipt(purpose, context, payload) {
  const { active, keys } = getKeys();
  const integrityTag = createHmac('sha256', keys.get(active))
    .update(message(purpose, context, payload)).digest('hex');
  return { integrityKeyId: active, integrityTag };
}

export function verifyDecisionReceipt(receipt, purpose, context, payload) {
  const { keys } = getKeys();
  if (!validKeyId(receipt?.integrityKeyId)
    || !/^[a-f0-9]{64}$/.test(receipt?.integrityTag || '')) return false;
  const key = keys.get(receipt.integrityKeyId);
  if (!key) return false;
  const expected = createHmac('sha256', key)
    .update(message(purpose, context, payload)).digest();
  return timingSafeEqual(expected, Buffer.from(receipt.integrityTag, 'hex'));
}

export function hashDecisionValue(value) {
  return createHash('sha256').update(message('hash', {}, value)).digest('hex');
}
