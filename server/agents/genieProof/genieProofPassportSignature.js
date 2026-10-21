import crypto from 'node:crypto';
import { canonicalJson, canonicalSha256 } from '../../utils/canonicalJson.js';

export const GENIEPROOF_SIGNATURE_ALGORITHM = 'Ed25519';

// A trust store is intentionally a flat JSON object of key IDs to PEM strings.
// JSON.parse alone silently keeps the last occurrence of a duplicate key ID.
export function parseGenieProofTrustedPublicKeysJson(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object'
      || Object.values(parsed).some(value => typeof value !== 'string')) {
    throw new TypeError('GenieProof trusted keys must be a flat object of public-key strings.');
  }
  let index = 0;
  const skipWhitespace = () => { while (/\s/.test(raw[index] || '') && index < raw.length) index += 1; };
  const readString = () => {
    if (raw[index] !== '"') throw new TypeError('GenieProof trusted-key JSON is not a flat object.');
    const start = index++;
    while (index < raw.length) {
      if (raw[index] === '\\') { index += 2; continue; }
      if (raw[index] === '"') return JSON.parse(raw.slice(start, ++index));
      index += 1;
    }
    throw new TypeError('GenieProof trusted-key JSON string is incomplete.');
  };
  skipWhitespace();
  if (raw[index++] !== '{') throw new TypeError('GenieProof trusted-key JSON must be an object.');
  skipWhitespace();
  const seen = new Set();
  while (raw[index] !== '}') {
    const keyId = readString();
    if (seen.has(keyId)) throw new TypeError('GenieProof trusted-key JSON contains a duplicate key ID.');
    seen.add(keyId);
    skipWhitespace();
    if (raw[index++] !== ':') throw new TypeError('GenieProof trusted-key JSON is not a flat object.');
    skipWhitespace();
    readString();
    skipWhitespace();
    if (raw[index] === ',') { index += 1; skipWhitespace(); continue; }
    if (raw[index] !== '}') throw new TypeError('GenieProof trusted-key JSON is not a flat object.');
  }
  index += 1;
  skipWhitespace();
  if (index !== raw.length || seen.size !== Object.keys(parsed).length) {
    throw new TypeError('GenieProof trusted-key JSON is not a flat object.');
  }
  return parsed;
}

function readPublicKey(value) {
  try {
    if (typeof value === 'string' && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return null;
    const key = typeof value === 'string' ? crypto.createPublicKey(value) : value;
    return key?.type === 'public' && key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

function readRevokedKeyIds(value) {
  if (!Array.isArray(value)) throw new TypeError('GenieProof revoked key IDs must be an array.');
  const ids = new Set();
  for (const keyId of value) {
    if (typeof keyId !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(keyId)) {
      throw new TypeError('GenieProof revoked key IDs must be valid identifiers.');
    }
    ids.add(keyId);
  }
  return ids;
}

export class GenieProofPassportVerifier {
  constructor({ trustedPublicKeys = {}, revokedKeyIds = [] } = {}) {
    if (!trustedPublicKeys || Array.isArray(trustedPublicKeys) || typeof trustedPublicKeys !== 'object') {
      throw new TypeError('GenieProof verification requires an explicit public-key trust store.');
    }
    this.trustedPublicKeys = new Map();
    this.revokedKeyIds = readRevokedKeyIds(revokedKeyIds);
    for (const [trustedId, trustedValue] of Object.entries(trustedPublicKeys)) {
      if (!/^[A-Za-z0-9._-]{1,120}$/.test(trustedId)) {
        throw new TypeError('GenieProof trust-store key IDs must be valid identifiers.');
      }
      const key = readPublicKey(trustedValue);
      if (!key) throw new TypeError(`GenieProof trust-store key ${trustedId} is not a valid Ed25519 public key.`);
      this.trustedPublicKeys.set(trustedId, key);
    }
  }

  verifySignedManifest(signed) {
    const manifest = signed?.manifest;
    const signature = signed?.signature;
    if (!manifest || signature?.algorithm !== GENIEPROOF_SIGNATURE_ALGORITHM
        || typeof signature.keyId !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(signature.keyId)
        || typeof signature.value !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature.value)
        || !/^[a-f0-9]{64}$/.test(signed?.manifestHash || '')) {
      return { valid: false, integrityValid: false, trustedIssuer: false, code: 'PASSPORT_SIGNATURE_MALFORMED' };
    }
    const signatureBytes = Buffer.from(signature.value, 'base64url');
    if (signatureBytes.length !== 64 || signatureBytes.toString('base64url') !== signature.value) {
      return { valid: false, integrityValid: false, trustedIssuer: false, code: 'PASSPORT_SIGNATURE_MALFORMED' };
    }
    let canonicalManifest;
    try {
      canonicalManifest = canonicalJson(manifest);
      if (canonicalSha256(manifest) !== signed.manifestHash) {
        return { valid: false, integrityValid: false, trustedIssuer: false, code: 'PASSPORT_MANIFEST_HASH_MISMATCH' };
      }
    } catch {
      return { valid: false, integrityValid: false, trustedIssuer: false, code: 'PASSPORT_MANIFEST_INVALID' };
    }
    const trustedKey = this.trustedPublicKeys.get(signature.keyId);
    if (!trustedKey) {
      return this.revokedKeyIds.has(signature.keyId)
        ? { valid: false, integrityValid: true, trustedIssuer: false, code: 'PASSPORT_SIGNING_KEY_REVOKED' }
        : { valid: false, integrityValid: true, trustedIssuer: false, code: 'PASSPORT_SIGNING_KEY_UNTRUSTED' };
    }
    const publicDer = trustedKey.export({ type: 'spki', format: 'der' });
    const fingerprint = crypto.createHash('sha256').update(publicDer).digest('hex');
    if (signature.publicKeyFingerprint !== fingerprint) {
      return { valid: false, integrityValid: true, trustedIssuer: false, code: 'PASSPORT_KEY_FINGERPRINT_MISMATCH' };
    }
    let signatureValid = false;
    try {
      signatureValid = crypto.verify(null, Buffer.from(canonicalManifest, 'utf8'), trustedKey, signatureBytes);
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) return { valid: false, integrityValid: true, trustedIssuer: false, code: 'PASSPORT_SIGNATURE_INVALID' };
    if (this.revokedKeyIds.has(signature.keyId)) {
      return { valid: false, integrityValid: true, trustedIssuer: false, code: 'PASSPORT_SIGNING_KEY_REVOKED' };
    }
    return { valid: true, integrityValid: true, trustedIssuer: true, code: 'PASSPORT_SIGNATURE_VERIFIED' };
  }
}

export class GenieProofPassportSigner {
  constructor({ privateKeyPem, publicKeyPem, keyId, trustedPublicKeys = {}, revokedKeyIds = [] } = {}) {
    if (!privateKeyPem || !publicKeyPem || typeof keyId !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(keyId)) {
      throw new TypeError('GenieProof signing requires an Ed25519 key pair and key ID.');
    }
    if (typeof publicKeyPem === 'string' && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(publicKeyPem)) {
      throw new TypeError('GenieProof public-key configuration must contain only a public key.');
    }
    this.privateKey = crypto.createPrivateKey(privateKeyPem);
    this.publicKey = crypto.createPublicKey(publicKeyPem);
    if (this.privateKey.asymmetricKeyType !== 'ed25519' || this.publicKey.asymmetricKeyType !== 'ed25519') {
      throw new TypeError('GenieProof passport keys must use Ed25519.');
    }
    const publicDer = this.publicKey.export({ type: 'spki', format: 'der' });
    const challenge = Buffer.from('genieproof-key-pair-check');
    const keyPairMatches = crypto.verify(null, challenge, this.publicKey,
      crypto.sign(null, challenge, this.privateKey));
    if (!keyPairMatches) throw new TypeError('GenieProof private and public keys do not match.');

    this.keyId = keyId;
    this.publicKeyFingerprint = crypto.createHash('sha256').update(publicDer).digest('hex');
    this.revokedKeyIds = readRevokedKeyIds(revokedKeyIds);
    if (this.revokedKeyIds.has(keyId)) throw new TypeError('GenieProof signing key is revoked.');
    this.trustedPublicKeys = new Map();
    for (const [trustedId, trustedValue] of Object.entries(trustedPublicKeys)) {
      if (!/^[A-Za-z0-9._-]{1,120}$/.test(trustedId)) {
        throw new TypeError('GenieProof trust-store key IDs must be valid identifiers.');
      }
      const key = readPublicKey(trustedValue);
      if (!key) throw new TypeError(`GenieProof trust-store key ${trustedId} is not a valid Ed25519 public key.`);
      this.trustedPublicKeys.set(trustedId, key);
    }
    // The configured signing public key is an explicit local trust anchor for
    // the environment using it. A manifest cannot introduce its own key.
    const existingKey = this.trustedPublicKeys.get(keyId);
    if (existingKey && !existingKey.export({ type: 'spki', format: 'der' }).equals(publicDer)) {
      throw new TypeError('GenieProof signing key ID conflicts with a different pinned public key.');
    }
    this.trustedPublicKeys.set(keyId, this.publicKey);
  }

  signManifest(manifest) {
    const canonicalManifest = canonicalJson(manifest);
    const signature = crypto.sign(null, Buffer.from(canonicalManifest, 'utf8'), this.privateKey).toString('base64url');
    return {
      manifest,
      manifestHash: canonicalSha256(manifest),
      signature: {
        algorithm: GENIEPROOF_SIGNATURE_ALGORITHM,
        keyId: this.keyId,
        publicKeyFingerprint: this.publicKeyFingerprint,
        value: signature,
      },
    };
  }

  verifySignedManifest(signed) {
    const manifest = signed?.manifest;
    const signature = signed?.signature;
    if (!manifest || signature?.algorithm !== GENIEPROOF_SIGNATURE_ALGORITHM
        || typeof signature.keyId !== 'string' || typeof signature.value !== 'string'
        || !/^[A-Za-z0-9_-]{86}$/.test(signature.value)
        || !/^[a-f0-9]{64}$/.test(signed?.manifestHash || '')) {
      return { valid: false, integrityValid: false, trustedIssuer: false, code: 'PASSPORT_SIGNATURE_MALFORMED' };
    }
    const signatureBytes = Buffer.from(signature.value, 'base64url');
    if (signatureBytes.length !== 64 || signatureBytes.toString('base64url') !== signature.value) {
      return { valid: false, integrityValid: false, trustedIssuer: false, code: 'PASSPORT_SIGNATURE_MALFORMED' };
    }
    let canonicalManifest;
    try {
      canonicalManifest = canonicalJson(manifest);
      if (canonicalSha256(manifest) !== signed.manifestHash) {
        return { valid: false, integrityValid: false, trustedIssuer: false, code: 'PASSPORT_MANIFEST_HASH_MISMATCH' };
      }
    } catch {
      return { valid: false, integrityValid: false, trustedIssuer: false, code: 'PASSPORT_MANIFEST_INVALID' };
    }
    const trustedKey = this.trustedPublicKeys.get(signature.keyId);
    if (!trustedKey) {
      return this.revokedKeyIds.has(signature.keyId)
        ? { valid: false, integrityValid: true, trustedIssuer: false, code: 'PASSPORT_SIGNING_KEY_REVOKED' }
        : { valid: false, integrityValid: true, trustedIssuer: false, code: 'PASSPORT_SIGNING_KEY_UNTRUSTED' };
    }
    const publicDer = trustedKey.export({ type: 'spki', format: 'der' });
    const fingerprint = crypto.createHash('sha256').update(publicDer).digest('hex');
    if (signature.publicKeyFingerprint !== fingerprint) {
      return { valid: false, integrityValid: true, trustedIssuer: false, code: 'PASSPORT_KEY_FINGERPRINT_MISMATCH' };
    }
    let signatureValid = false;
    try {
      signatureValid = crypto.verify(null, Buffer.from(canonicalManifest, 'utf8'), trustedKey, signatureBytes);
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) return { valid: false, integrityValid: true, trustedIssuer: false, code: 'PASSPORT_SIGNATURE_INVALID' };
    if (this.revokedKeyIds.has(signature.keyId)) {
      return { valid: false, integrityValid: true, trustedIssuer: false, code: 'PASSPORT_SIGNING_KEY_REVOKED' };
    }
    return { valid: true, integrityValid: true, trustedIssuer: true, code: 'PASSPORT_SIGNATURE_VERIFIED' };
  }
}

export function createGenieProofRuntime({ env = process.env } = {}) {
  const environmentAllowsPrototype = ['development', 'test'].includes(env.NODE_ENV);
  const explicitlyEnabled = env.GENIEPROOF_ENABLED === 'true';
  const keyConfigurationPresent = Boolean(env.GENIEPROOF_SIGNING_PRIVATE_KEY
    && env.GENIEPROOF_SIGNING_PUBLIC_KEY && env.GENIEPROOF_SIGNING_KEY_ID);
  // Preserve the research-only gate. Expose only a fixed diagnostic code
  // internally so the authenticated capability endpoint can explain why this
  // instance is unavailable without disclosing environment values or keys.
  if (!environmentAllowsPrototype) {
    return Object.freeze({ enabled: false, signer: null, productionActivationAllowed: false, reasonCode: 'GENIEPROOF_LOCAL_RESEARCH_ONLY' });
  }
  if (!explicitlyEnabled) {
    return Object.freeze({ enabled: false, signer: null, productionActivationAllowed: false, reasonCode: 'GENIEPROOF_FLAG_DISABLED' });
  }
  if (!keyConfigurationPresent) {
    return Object.freeze({ enabled: false, signer: null, productionActivationAllowed: false, reasonCode: 'GENIEPROOF_SIGNING_KEYS_MISSING' });
  }
  try {
    const trustedPublicKeys = env.GENIEPROOF_VERIFY_PUBLIC_KEYS_JSON
      ? parseGenieProofTrustedPublicKeysJson(env.GENIEPROOF_VERIFY_PUBLIC_KEYS_JSON)
      : {};
    const revokedKeyIds = env.GENIEPROOF_REVOKED_SIGNING_KEY_IDS_JSON
      ? JSON.parse(env.GENIEPROOF_REVOKED_SIGNING_KEY_IDS_JSON)
      : [];
    if (!trustedPublicKeys || Array.isArray(trustedPublicKeys) || typeof trustedPublicKeys !== 'object') {
      throw new TypeError('Trusted GenieProof verification keys must be an object.');
    }
    if (!Array.isArray(revokedKeyIds)) throw new TypeError('Revoked GenieProof signing key IDs must be an array.');
    const signer = new GenieProofPassportSigner({
      privateKeyPem: env.GENIEPROOF_SIGNING_PRIVATE_KEY,
      publicKeyPem: env.GENIEPROOF_SIGNING_PUBLIC_KEY,
      keyId: env.GENIEPROOF_SIGNING_KEY_ID,
      trustedPublicKeys,
      revokedKeyIds,
    });
    return Object.freeze({ enabled: true, signer, productionActivationAllowed: false });
  } catch {
    // Do not send parser or private-key validation exceptions to callers.
    return Object.freeze({ enabled: false, signer: null, productionActivationAllowed: false, reasonCode: 'GENIEPROOF_SIGNING_CONFIGURATION_INVALID' });
  }
}
