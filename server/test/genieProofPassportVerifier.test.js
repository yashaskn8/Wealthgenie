import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildGenieProofManifest, extractGenieProofClaims, GENIEPROOF_LEGACY_VERIFIER_VERSION, GENIEPROOF_SUPPORTED_PRODUCT_ID, verifyConfirmedGenieProofClaim } from '../agents/genieProof/genieProofCore.js';
import { verifyExportedGenieProofPassport } from '../agents/genieProof/genieProofPassportVerifier.js';
import { GenieProofPassportSigner, GenieProofPassportVerifier } from '../agents/genieProof/genieProofPassportSignature.js';

function keyPair() {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

function claimAndFinding() {
  const text = 'The current official PPF interest rate is 7.1% p.a.';
  const extraction = extractGenieProofClaims(text);
  const candidate = extraction.claims[0];
  const claim = {
    claimId: candidate.claimId,
    statement: candidate.originalSpan,
    claimType: candidate.claimType,
    productId: candidate.productId,
    value: candidate.value,
    unit: candidate.unit,
  };
  return { claim, finding: verifyConfirmedGenieProofClaim(claim) };
}

function signedPassport(signer, findingOverride) {
  const { claim, finding } = claimAndFinding();
  const { manifest } = buildGenieProofManifest({
    caseId: '00000000-0000-4000-8000-000000000001',
    ownerId: '65b000000000000000000001',
    submissionHash: 'a'.repeat(64),
    confirmedClaims: [claim],
    revision: 1,
    findings: [findingOverride || finding],
    assessedAt: '2026-10-11T08:00:00.000Z',
  });
  return signer.signManifest(manifest);
}

function signerFrom(keys, keyId) {
  return new GenieProofPassportSigner({ ...keys, keyId });
}

test('offline verifier checks an out-of-band trust anchor and replays the deterministic abstention', () => {
  const keys = keyPair();
  const signer = signerFrom(keys, 'offline-v1');
  const result = verifyExportedGenieProofPassport(signedPassport(signer), {
    trustedPublicKeys: { 'offline-v1': keys.publicKeyPem },
  });

  assert.equal(result.status, 'VERIFICATION_INCOMPLETE');
  assert.equal(result.signature, 'SIGNATURE_INTEGRITY_VALID');
  assert.equal(result.findings, 'FINDING_REPRODUCIBLE');
  assert.equal(result.evidence, 'VERIFICATION_INCOMPLETE');
  assert.equal(result.financialCorrectness, 'NOT_ESTABLISHED_BY_SIGNATURE');
  assert.equal(result.code, 'QUALIFIED_EVIDENCE_UNAVAILABLE');
});

test('offline verifier reports content integrity without trusting a manifest-supplied key', () => {
  const keys = keyPair();
  const signer = signerFrom(keys, 'offline-v1');
  const signed = signedPassport(signer);
  signed.manifest.publicKey = keys.publicKeyPem;
  const selfPublished = signer.signManifest(signed.manifest);
  const result = verifyExportedGenieProofPassport(selfPublished, { trustedPublicKeys: {} });
  assert.equal(result.status, 'VERIFICATION_INCOMPLETE');
  assert.equal(result.signature, 'VERIFICATION_INCOMPLETE');
  assert.equal(result.trustedIssuer, false);
  assert.equal(result.code, 'PASSPORT_SIGNING_KEY_UNTRUSTED');
  assert.throws(() => new GenieProofPassportVerifier({ trustedPublicKeys: { private: keys.privateKeyPem } }), /not a valid Ed25519 public key/);
});

test('offline verifier supports explicitly pinned historical signing keys after rotation', () => {
  const oldKeys = keyPair();
  const newKeys = keyPair();
  const oldPassport = signedPassport(signerFrom(oldKeys, 'key-v1'));
  const newPassport = signedPassport(signerFrom(newKeys, 'key-v2'));
  const trustStore = { 'key-v1': oldKeys.publicKeyPem, 'key-v2': newKeys.publicKeyPem };

  assert.equal(verifyExportedGenieProofPassport(oldPassport, { trustedPublicKeys: trustStore }).signature, 'SIGNATURE_INTEGRITY_VALID');
  assert.equal(verifyExportedGenieProofPassport(newPassport, { trustedPublicKeys: trustStore }).signature, 'SIGNATURE_INTEGRITY_VALID');
});

test('offline verifier replays a historical verifier version without rewriting its finding', () => {
  const keys = keyPair();
  const signer = signerFrom(keys, 'legacy-verifier-v1');
  const claim = {
    claimId: 'a'.repeat(32),
    statement: 'The PPF rate may be 7.1% p.a.',
    claimType: 'CURRENT_NOMINAL_RATE',
    productId: GENIEPROOF_SUPPORTED_PRODUCT_ID,
    value: 7.1,
    unit: 'PERCENT_PER_ANNUM',
  };
  const finding = verifyConfirmedGenieProofClaim(claim, { verifierVersion: GENIEPROOF_LEGACY_VERIFIER_VERSION });
  const { manifest } = buildGenieProofManifest({
    caseId: '00000000-0000-4000-8000-000000000001',
    ownerId: '65b000000000000000000001',
    submissionHash: 'a'.repeat(64),
    confirmedClaims: [claim],
    findings: [finding],
    revision: 1,
    assessedAt: '2026-10-11T08:00:00.000Z',
    verifierVersion: GENIEPROOF_LEGACY_VERIFIER_VERSION,
  });
  const result = verifyExportedGenieProofPassport(signer.signManifest(manifest), {
    trustedPublicKeys: { 'legacy-verifier-v1': keys.publicKeyPem },
  });
  assert.equal(result.findings, 'FINDING_REPRODUCIBLE');
  assert.equal(result.status, 'VERIFICATION_INCOMPLETE');
});

test('offline verifier rejects a tampered manifest and a signed finding that does not replay', () => {
  const keys = keyPair();
  const signer = signerFrom(keys, 'offline-v1');
  const trustedPublicKeys = { 'offline-v1': keys.publicKeyPem };

  const tampered = structuredClone(signedPassport(signer));
  tampered.manifest.confirmedClaims[0].value = 9;
  assert.equal(verifyExportedGenieProofPassport(tampered, { trustedPublicKeys }).status, 'VERIFICATION_FAILED');

  const { finding } = claimAndFinding();
  const signedMismatch = signedPassport(signer, { ...finding, finding: 'SUPPORTED' });
  const replay = verifyExportedGenieProofPassport(signedMismatch, { trustedPublicKeys });
  assert.equal(replay.status, 'VERIFICATION_FAILED');
  assert.equal(replay.findings, 'VERIFICATION_FAILED');
  assert.equal(replay.code, 'PASSPORT_FINDING_REPLAY_MISMATCH');
});

test('offline verifier rejects malformed and noncanonical Base64URL signature encodings', () => {
  const keys = keyPair();
  const signer = signerFrom(keys, 'offline-signature-encoding');
  const trustedPublicKeys = { 'offline-signature-encoding': keys.publicKeyPem };
  const signed = signedPassport(signer);

  for (const suffix of [' ', '!', '====', '\n']) {
    const malformed = structuredClone(signed);
    malformed.signature.value += suffix;
    const result = verifyExportedGenieProofPassport(malformed, { trustedPublicKeys });
    assert.equal(result.status, 'VERIFICATION_FAILED', `suffix ${JSON.stringify(suffix)} must be rejected`);
    assert.equal(result.code, 'PASSPORT_SIGNATURE_MALFORMED');
  }

  const noncanonical = structuredClone(signed);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const encoded = noncanonical.signature.value;
  const lastCharacterIndex = alphabet.indexOf(encoded.at(-1));
  const equivalentIndex = Math.floor(lastCharacterIndex / 16) * 16 + ((lastCharacterIndex % 16 + 1) % 16);
  noncanonical.signature.value = `${encoded.slice(0, -1)}${alphabet[equivalentIndex]}`;
  assert.deepEqual(
    Buffer.from(noncanonical.signature.value, 'base64url'),
    Buffer.from(encoded, 'base64url'),
    'the mutation must differ only in unused trailing pad bits',
  );
  const result = verifyExportedGenieProofPassport(noncanonical, { trustedPublicKeys });
  assert.equal(result.status, 'VERIFICATION_FAILED');
  assert.equal(result.code, 'PASSPORT_SIGNATURE_MALFORMED');
});
