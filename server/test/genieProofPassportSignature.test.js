import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  createGenieProofRuntime,
  GenieProofPassportSigner,
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
});
