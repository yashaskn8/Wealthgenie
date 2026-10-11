import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildGenieProofManifest, extractGenieProofClaims, verifyConfirmedGenieProofClaim } from '../agents/genieProof/genieProofCore.js';
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
