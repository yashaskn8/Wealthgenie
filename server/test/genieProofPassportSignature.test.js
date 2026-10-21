import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  createGenieProofRuntime,
  GenieProofPassportSigner,
  parseGenieProofTrustedPublicKeysJson,
} from '../agents/genieProof/genieProofPassportSignature.js';

function keyPair() {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

test('signed passport verifies only against its trusted Ed25519 key', () => {
  const keys = keyPair();
  const signer = new GenieProofPassportSigner({ ...keys, keyId: 'local-test-v1' });
  const signed = signer.signManifest({ schemaVersion: 'test/1', revision: 1, findings: [] });
  assert.deepEqual(signer.verifySignedManifest(signed), {
    valid: true,
    integrityValid: true,
    trustedIssuer: true,
    code: 'PASSPORT_SIGNATURE_VERIFIED',
  });

  const tampered = structuredClone(signed);
  tampered.manifest.findings.push({ finding: 'SUPPORTED' });
  assert.equal(signer.verifySignedManifest(tampered).code, 'PASSPORT_MANIFEST_HASH_MISMATCH');

  const other = new GenieProofPassportSigner({ ...keyPair(), keyId: 'other-key' });
  const untrusted = other.verifySignedManifest(signed);
  assert.equal(untrusted.integrityValid, true);
  assert.equal(untrusted.trustedIssuer, false);
  assert.equal(untrusted.code, 'PASSPORT_SIGNING_KEY_UNTRUSTED');
});

test('in-process verifier rejects noncanonical Ed25519 signature encodings', () => {
  const keys = keyPair();
  const signer = new GenieProofPassportSigner({ ...keys, keyId: 'canonical-signature-test' });
  const signed = signer.signManifest({ schemaVersion: 'test/1', revision: 1, findings: [] });
  for (const suffix of [' ', '!', '====', '\n']) {
    const malformed = structuredClone(signed);
    malformed.signature.value += suffix;
    assert.equal(signer.verifySignedManifest(malformed).valid, false, `suffix ${JSON.stringify(suffix)} must not be accepted`);
    assert.equal(signer.verifySignedManifest(malformed).code, 'PASSPORT_SIGNATURE_MALFORMED');
  }
});

test('in-process verifier distinguishes a trusted key from an invalid document signature', () => {
  const keys = keyPair();
  const signer = new GenieProofPassportSigner({ ...keys, keyId: 'trusted-invalid-signature' });
  const signed = signer.signManifest({ schemaVersion: 'test/1', revision: 1, findings: [] });
  const invalid = structuredClone(signed);
  invalid.signature.value = 'A'.repeat(86);

  const result = signer.verifySignedManifest(invalid);
  assert.deepEqual(result, {
    valid: false,
    integrityValid: true,
    trustedIssuer: false,
    code: 'PASSPORT_SIGNATURE_INVALID',
  });
});

test('in-process verifier rejects a signature made by an explicitly revoked rotated key', () => {
  const retired = keyPair();
  const retiredSigner = new GenieProofPassportSigner({ ...retired, keyId: 'retired-key-v1' });
  const passport = retiredSigner.signManifest({ schemaVersion: 'test/1', revision: 1, findings: [] });
  const active = keyPair();
  const activeSigner = new GenieProofPassportSigner({
    ...active,
    keyId: 'active-key-v2',
    trustedPublicKeys: { 'retired-key-v1': retired.publicKeyPem },
    revokedKeyIds: ['retired-key-v1'],
  });

  assert.deepEqual(activeSigner.verifySignedManifest(passport), {
    valid: false,
    integrityValid: true,
    trustedIssuer: false,
    code: 'PASSPORT_SIGNING_KEY_REVOKED',
  });
  const invalidSignature = structuredClone(passport);
  invalidSignature.signature.value = 'A'.repeat(86);
  assert.equal(activeSigner.verifySignedManifest(invalidSignature).code, 'PASSPORT_SIGNATURE_INVALID',
    'signature validity stays distinct from the separate key-revocation status');
});

test('signer refuses key type and pair mismatches', () => {
  const first = keyPair();
  const second = keyPair();
  assert.throws(() => new GenieProofPassportSigner({
    privateKeyPem: first.privateKeyPem,
    publicKeyPem: second.publicKeyPem,
    keyId: 'mismatch',
  }), /do not match/);
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => new GenieProofPassportSigner({
    privateKeyPem: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: rsa.publicKey.export({ type: 'spki', format: 'pem' }),
    keyId: 'rsa',
  }), /Ed25519/);
  assert.throws(() => new GenieProofPassportSigner({
    privateKeyPem: first.privateKeyPem,
    publicKeyPem: first.privateKeyPem,
    keyId: 'private-as-public',
  }), /public-key configuration/);
  assert.throws(() => new GenieProofPassportSigner({
    ...first,
    keyId: 'pinned-key',
    trustedPublicKeys: { 'pinned-key': second.publicKeyPem },
  }), /conflicts with a different pinned public key/);
});

test('runtime enables GenieProof only with explicit local keys in development or test', () => {
  const keys = keyPair();
  assert.equal(createGenieProofRuntime({ env: { NODE_ENV: 'development', GENIEPROOF_ENABLED: 'true' } }).enabled, false);
  assert.equal(createGenieProofRuntime({
    env: {
      NODE_ENV: 'production',
      GENIEPROOF_ENABLED: 'true',
      GENIEPROOF_SIGNING_PRIVATE_KEY: keys.privateKeyPem,
      GENIEPROOF_SIGNING_PUBLIC_KEY: keys.publicKeyPem,
      GENIEPROOF_SIGNING_KEY_ID: 'production-blocked',
    },
  }).enabled, false);
  assert.equal(createGenieProofRuntime({
    env: {
      NODE_ENV: 'staging',
      GENIEPROOF_ENABLED: 'true',
      GENIEPROOF_SIGNING_PRIVATE_KEY: keys.privateKeyPem,
      GENIEPROOF_SIGNING_PUBLIC_KEY: keys.publicKeyPem,
      GENIEPROOF_SIGNING_KEY_ID: 'staging-blocked',
    },
  }).enabled, false);
  assert.equal(createGenieProofRuntime({
    env: {
      NODE_ENV: 'development',
      GENIEPROOF_ENABLED: 'true',
      GENIEPROOF_SIGNING_PRIVATE_KEY: keys.privateKeyPem,
      GENIEPROOF_SIGNING_PUBLIC_KEY: keys.publicKeyPem,
      GENIEPROOF_SIGNING_KEY_ID: 'local-v1',
    },
  }).enabled, true);
  assert.equal(createGenieProofRuntime({
    env: {
      NODE_ENV: 'development',
      GENIEPROOF_ENABLED: 'true',
      GENIEPROOF_SIGNING_PRIVATE_KEY: keys.privateKeyPem,
      GENIEPROOF_SIGNING_PUBLIC_KEY: keys.publicKeyPem,
      GENIEPROOF_SIGNING_KEY_ID: 'local-v1',
      GENIEPROOF_REVOKED_SIGNING_KEY_IDS_JSON: '["local-v1"]',
    },
  }).enabled, false, 'a revoked active signing key cannot enable the prototype runtime');
});

test('runtime produces safe distinct activation reasons, never key data', () => {
  const keys = keyPair();
  const base = {
    NODE_ENV: 'development',
    GENIEPROOF_ENABLED: 'true',
    GENIEPROOF_SIGNING_PRIVATE_KEY: keys.privateKeyPem,
    GENIEPROOF_SIGNING_PUBLIC_KEY: keys.publicKeyPem,
    GENIEPROOF_SIGNING_KEY_ID: 'local-test-v1',
  };
  const cases = [
    [{ ...base, NODE_ENV: 'production' }, 'GENIEPROOF_LOCAL_RESEARCH_ONLY'],
    [{ ...base, NODE_ENV: 'staging' }, 'GENIEPROOF_LOCAL_RESEARCH_ONLY'],
    [{ ...base, GENIEPROOF_ENABLED: 'false' }, 'GENIEPROOF_FLAG_DISABLED'],
    [{ ...base, GENIEPROOF_SIGNING_PRIVATE_KEY: '' }, 'GENIEPROOF_SIGNING_KEYS_MISSING'],
    [{ ...base, GENIEPROOF_SIGNING_PUBLIC_KEY: '' }, 'GENIEPROOF_SIGNING_KEYS_MISSING'],
    [{ ...base, GENIEPROOF_SIGNING_KEY_ID: '' }, 'GENIEPROOF_SIGNING_KEYS_MISSING'],
    [{ ...base, GENIEPROOF_SIGNING_PUBLIC_KEY: keyPair().publicKeyPem }, 'GENIEPROOF_SIGNING_CONFIGURATION_INVALID'],
    [{ ...base, GENIEPROOF_VERIFY_PUBLIC_KEYS_JSON: '{bad' }, 'GENIEPROOF_SIGNING_CONFIGURATION_INVALID'],
    [{ ...base, GENIEPROOF_REVOKED_SIGNING_KEY_IDS_JSON: '["local-test-v1"]' }, 'GENIEPROOF_SIGNING_CONFIGURATION_INVALID'],
  ];
  for (const [env, reason] of cases) {
    const runtime = createGenieProofRuntime({ env });
    assert.equal(runtime.enabled, false, reason);
    assert.equal(runtime.signer, null, reason);
    assert.equal(runtime.productionActivationAllowed, false, reason);
    assert.equal(runtime.reasonCode, reason);
    assert.ok(!JSON.stringify(runtime).includes(keys.privateKeyPem));
  }
  const good = createGenieProofRuntime({ env: base });
  assert.equal(good.enabled, true);
  assert.equal(good.reasonCode, undefined);
  assert.equal(good.productionActivationAllowed, false);
});

test('trusted-key JSON rejects duplicate IDs, including escaped aliases, before runtime activation', () => {
  const keys = keyPair();
  const other = keyPair();
  const duplicate = `{"history":${JSON.stringify(keys.publicKeyPem)},"history":${JSON.stringify(other.publicKeyPem)}}`;
  const escapedAlias = `{"hist\\u006fry":${JSON.stringify(keys.publicKeyPem)},"history":${JSON.stringify(other.publicKeyPem)}}`;
  for (const trustJson of [duplicate, escapedAlias]) {
    assert.throws(() => parseGenieProofTrustedPublicKeysJson(trustJson), /duplicate key ID/);
    const runtime = createGenieProofRuntime({ env: {
      NODE_ENV: 'development',
      GENIEPROOF_ENABLED: 'true',
      GENIEPROOF_SIGNING_PRIVATE_KEY: keys.privateKeyPem,
      GENIEPROOF_SIGNING_PUBLIC_KEY: keys.publicKeyPem,
      GENIEPROOF_SIGNING_KEY_ID: 'local-v1',
      GENIEPROOF_VERIFY_PUBLIC_KEYS_JSON: trustJson,
    } });
    assert.equal(runtime.enabled, false);
    assert.equal(runtime.reasonCode, 'GENIEPROOF_SIGNING_CONFIGURATION_INVALID');
  }
  assert.deepEqual(parseGenieProofTrustedPublicKeysJson(JSON.stringify({ history: keys.publicKeyPem })), {
    history: keys.publicKeyPem,
  });
});
