import crypto from 'node:crypto';
import { canonicalJson, canonicalSha256 } from '../../utils/canonicalJson.js';

export const GENIEPROOF_SIGNATURE_ALGORITHM = 'Ed25519';

function readPublicKey(value) {
  try {
    const key = typeof value === 'string' ? crypto.createPublicKey(value) : value;
    return key?.type === 'public' && key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

export class GenieProofPassportSigner {
  constructor({ privateKeyPem, publicKeyPem, keyId, trustedPublicKeys = {} } = {}) {
    if (!privateKeyPem || !publicKeyPem || typeof keyId !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(keyId)) {
      throw new TypeError('GenieProof signing requires an Ed25519 key pair and key ID.');
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
    this.trustedPublicKeys = new Map();
    for (const [trustedId, trustedValue] of Object.entries(trustedPublicKeys)) {
      const key = readPublicKey(trustedValue);
      if (key) this.trustedPublicKeys.set(trustedId, key);
    }
    // The configured signing public key is an explicit local trust anchor for
    // the environment using it. A manifest cannot introduce its own key.
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
        || !/^[a-f0-9]{64}$/.test(signed?.manifestHash || '')) {
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
    if (!trustedKey) return { valid: false, integrityValid: true, trustedIssuer: false, code: 'PASSPORT_SIGNING_KEY_UNTRUSTED' };
    const publicDer = trustedKey.export({ type: 'spki', format: 'der' });
    const fingerprint = crypto.createHash('sha256').update(publicDer).digest('hex');
    if (signature.publicKeyFingerprint !== fingerprint) {
      return { valid: false, integrityValid: true, trustedIssuer: false, code: 'PASSPORT_KEY_FINGERPRINT_MISMATCH' };
    }
    let signatureValid = false;
    try {
      signatureValid = crypto.verify(null, Buffer.from(canonicalManifest, 'utf8'), trustedKey, Buffer.from(signature.value, 'base64url'));
    } catch {
      signatureValid = false;
    }
    return signatureValid
      ? { valid: true, integrityValid: true, trustedIssuer: true, code: 'PASSPORT_SIGNATURE_VERIFIED' }
      : { valid: false, integrityValid: true, trustedIssuer: true, code: 'PASSPORT_SIGNATURE_INVALID' };
  }
}

export function createGenieProofRuntime({ env = process.env } = {}) {
  const environmentAllowsPrototype = ['development', 'test'].includes(env.NODE_ENV);
  const explicitlyEnabled = env.GENIEPROOF_ENABLED === 'true';
  const keyConfigurationPresent = Boolean(env.GENIEPROOF_SIGNING_PRIVATE_KEY
    && env.GENIEPROOF_SIGNING_PUBLIC_KEY && env.GENIEPROOF_SIGNING_KEY_ID);
  if (!environmentAllowsPrototype || !explicitlyEnabled || !keyConfigurationPresent) {
    return Object.freeze({ enabled: false, signer: null, productionActivationAllowed: false });
  }
  try {
    const trustedPublicKeys = env.GENIEPROOF_VERIFY_PUBLIC_KEYS_JSON
      ? JSON.parse(env.GENIEPROOF_VERIFY_PUBLIC_KEYS_JSON)
      : {};
    if (!trustedPublicKeys || Array.isArray(trustedPublicKeys) || typeof trustedPublicKeys !== 'object') {
      throw new TypeError('Trusted GenieProof verification keys must be an object.');
    }
    const signer = new GenieProofPassportSigner({
      privateKeyPem: env.GENIEPROOF_SIGNING_PRIVATE_KEY,
      publicKeyPem: env.GENIEPROOF_SIGNING_PUBLIC_KEY,
      keyId: env.GENIEPROOF_SIGNING_KEY_ID,
      trustedPublicKeys,
    });
    return Object.freeze({ enabled: true, signer, productionActivationAllowed: false });
  } catch {
    return Object.freeze({ enabled: false, signer: null, productionActivationAllowed: false });
  }
}
