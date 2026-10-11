import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  buildGenieProofManifest,
  extractGenieProofClaims,
  GENIEPROOF_EVIDENCE_VERIFIER_VERSION,
  GENIEPROOF_LEGACY_EVIDENCE_VERIFIER_VERSION,
  GENIEPROOF_PREVIOUS_EVIDENCE_VERIFIER_VERSION,
  GENIEPROOF_SUPPORTED_PRODUCT_ID,
  verifyConfirmedGenieProofClaim,
} from '../agents/genieProof/genieProofCore.js';
import {
  buildGenieProofEvidenceAttestationPayload,
  buildGenieProofEvidenceFactHash,
  GENIEPROOF_PPF_PARSER_VERSION,
  GENIEPROOF_PPF_RATE_RULE_VERSION,
} from '../agents/genieProof/genieProofEvidenceContract.js';
import { verifyExportedGenieProofPassport } from '../agents/genieProof/genieProofPassportVerifier.js';
import { GenieProofPassportSigner } from '../agents/genieProof/genieProofPassportSignature.js';

const assessedAt = new Date('2026-10-11T10:00:00.000Z');

function createSigner() {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    signer: new GenieProofPassportSigner({
      privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
      keyId: 'synthetic-evidence-test-key',
    }),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

function ppfClaim(value = 7.1) {
  const statement = `The current official PPF interest rate is ${value}% p.a.`;
  const candidate = extractGenieProofClaims(statement).claims[0];
  return {
    claimId: candidate.claimId,
    statement,
    claimType: 'CURRENT_NOMINAL_RATE',
    productId: GENIEPROOF_SUPPORTED_PRODUCT_ID,
    value,
    unit: 'PERCENT_PER_ANNUM',
  };
}

function syntheticEvidence(signer, {
  sourceId = 'synthetic-test-source',
  value = 7.1,
  effectiveFrom = '2026-10-01T00:00:00.000Z',
  effectiveTo = '2026-12-31T18:29:59.999Z',
  freshnessStatus = 'FRESH',
  revocationStatus = 'ACTIVE',
  qualification = 'QUALIFIED_FOR_USER_PRESENTATION',
  reuse = 'APPROVED',
  revision = 1,
} = {}) {
  const fact = {
    claimType: 'CURRENT_NOMINAL_RATE',
    productId: GENIEPROOF_SUPPORTED_PRODUCT_ID,
    value,
    unit: 'PERCENT_PER_ANNUM',
    effectiveFrom: new Date(effectiveFrom),
    effectiveTo: effectiveTo == null ? null : new Date(effectiveTo),
    conditions: [],
  };
  const evidence = {
    evidenceId: `${sourceId}:ppf-rate`,
    revision,
    sourceId,
    sourceRevision: 1,
    sourceDefinitionHash: 'a'.repeat(64),
    retrievalIds: ['00000000-0000-4000-8000-000000000011'],
    retrievalReceiptHashes: ['b'.repeat(64)],
    publicationAt: null,
    retrievedAt: new Date('2026-10-10T10:00:00.000Z'),
    sourceContentCommitment: 'c'.repeat(64),
    sourceQualificationAtAssessment: qualification,
    reusePermissionAtAssessment: reuse,
    freshnessStatus,
    revocationStatus,
    fact,
    parserVersion: GENIEPROOF_PPF_PARSER_VERSION,
    ruleVersion: GENIEPROOF_PPF_RATE_RULE_VERSION,
    sourceLineage: ['SYNTHETIC_TEST_FIXTURE_ONLY'],
    supersedes: null,
    factHash: buildGenieProofEvidenceFactHash(fact),
  };
  evidence.attestation = signer.signManifest(buildGenieProofEvidenceAttestationPayload(evidence));
  return evidence;
}

function verify(claim, evidence, signer) {
  return verifyConfirmedGenieProofClaim(claim, {
    verifierVersion: GENIEPROOF_EVIDENCE_VERIFIER_VERSION,
    evidenceRevisions: evidence ? (Array.isArray(evidence) ? evidence : [evidence]) : [],
    signatureVerifier: signer,
    now: assessedAt,
  });
}

test('synthetic golden evidence supports and contradicts only an exact current PPF rate claim', () => {
  const { signer } = createSigner();
  assert.equal(verify(ppfClaim(7.1), syntheticEvidence(signer), signer).finding, 'SUPPORTED');
  const contradicted = verify(ppfClaim(8.25), syntheticEvidence(signer), signer);
  assert.equal(contradicted.finding, 'CONTRADICTED');
  assert.deepEqual(contradicted.reasonCodes, ['EXACT_CURRENT_RATE_MISMATCH']);
  assert.equal(contradicted.contradictingEvidenceIds.length, 1);
});

test('current verifier rejects temporal scope and extra unverified rate semantics while preserving historical replay semantics', () => {
  const { signer } = createSigner();
  for (const statement of [
    'The PPF interest rate is no longer 7.1% p.a.',
    'The PPF interest rate is no more 7.1% p.a.',
    'The PPF interest rate as at 01.04.2026 is 7.1% p.a.',
    'The PPF interest rate as of 2026-04-01 is 7.1% p.a.',
    'The PPF interest rate as of April 2026 is 7.1% p.a.',
    'The PPF interest rate for Q2 2026 is 7.1% p.a.',
    'The PPF interest rate is 7.1% p.a. compounded monthly.',
    'The PPF interest rate is 7.1% p.a. compounded yearly.',
    'The PPF interest rate is 7.1% p.a. throughout the 15-year tenure.',
    'The PPF interest rate is 7.1% p.a. for 15 years.',
  ]) {
    const finding = verify({ ...ppfClaim(), statement }, syntheticEvidence(signer), signer);
    assert.equal(finding.finding, 'INSUFFICIENT_INPUTS', statement);
    assert.deepEqual(finding.reasonCodes, ['CLAIM_IDENTITY_OR_SEMANTICS_NOT_EXACT'], statement);
  }

  const historicalVersionClaim = {
    ...ppfClaim(),
    statement: 'The PPF interest rate is no longer 7.1% p.a.',
  };
  const historicalVersionFinding = verifyConfirmedGenieProofClaim(historicalVersionClaim, {
    verifierVersion: GENIEPROOF_PREVIOUS_EVIDENCE_VERIFIER_VERSION,
    evidenceRevisions: [syntheticEvidence(signer)],
    signatureVerifier: signer,
    now: assessedAt,
  });
  assert.equal(historicalVersionFinding.verifierVersion, GENIEPROOF_PREVIOUS_EVIDENCE_VERIFIER_VERSION);
  assert.equal(historicalVersionFinding.finding, 'SUPPORTED');
});

test('legacy Unicode-minus replay is explicitly not current-policy verification', () => {
  const { signer } = createSigner();
  const claim = { ...ppfClaim(7.1), statement: 'The PPF interest rate is −7.1% p.a.' };
  const evidence = syntheticEvidence(signer, { value: 7.1 });
  const legacy = verifyConfirmedGenieProofClaim(claim, {
    verifierVersion: GENIEPROOF_PREVIOUS_EVIDENCE_VERIFIER_VERSION,
    evidenceRevisions: [evidence],
    signatureVerifier: signer,
    now: assessedAt,
  });
  const current = verifyConfirmedGenieProofClaim(claim, {
    verifierVersion: GENIEPROOF_EVIDENCE_VERIFIER_VERSION,
    evidenceRevisions: [evidence],
    signatureVerifier: signer,
    now: assessedAt,
  });
  assert.equal(legacy.finding, 'SUPPORTED', 'legacy verifier behavior is preserved for signed replay compatibility');
  assert.equal(current.finding, 'INSUFFICIENT_INPUTS', 'current exact wording rules reject the Unicode-minus claim');
  assert.equal(current.reasonCodes[0], 'CLAIM_IDENTITY_OR_SEMANTICS_NOT_EXACT');
});

test('missing, wrong-product, expired, revoked, stale, and unpermitted evidence never becomes a negative finding', () => {
  const { signer } = createSigner();
  assert.equal(verify(ppfClaim(), null, signer).finding, 'NOT_VERIFIABLE');
  const wrongProduct = syntheticEvidence(signer);
  wrongProduct.fact.productId = 'government:india-post:nsc';
  wrongProduct.factHash = buildGenieProofEvidenceFactHash(wrongProduct.fact);
  wrongProduct.attestation = signer.signManifest(buildGenieProofEvidenceAttestationPayload(wrongProduct));
  assert.equal(verify(ppfClaim(), wrongProduct, signer).finding, 'NOT_VERIFIABLE');
  assert.equal(verify(ppfClaim(), syntheticEvidence(signer, {
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    effectiveTo: '2026-09-30T18:29:59.999Z',
  }), signer).finding, 'OUTDATED_EVIDENCE');
  assert.equal(verify(ppfClaim(), syntheticEvidence(signer, { revocationStatus: 'REVOKED' }), signer).finding, 'NOT_VERIFIABLE');
  assert.equal(verify(ppfClaim(), syntheticEvidence(signer, { freshnessStatus: 'STALE' }), signer).finding, 'OUTDATED_EVIDENCE');
  assert.equal(verify(ppfClaim(), syntheticEvidence(signer, { reuse: 'BLOCKED' }), signer).finding, 'NOT_VERIFIABLE');
});

test('current verifier rejects a signed evidence revision without a bounded effective end date', () => {
  const { signer } = createSigner();
  const unbounded = syntheticEvidence(signer, { effectiveTo: null });
  const finding = verify(ppfClaim(), unbounded, signer);
  assert.equal(finding.finding, 'NOT_VERIFIABLE');
  assert.deepEqual(finding.reasonCodes, ['EVIDENCE_EFFECTIVE_PERIOD_INVALID']);

  const priorVersionFinding = verifyConfirmedGenieProofClaim(ppfClaim(), {
    verifierVersion: GENIEPROOF_PREVIOUS_EVIDENCE_VERIFIER_VERSION,
    evidenceRevisions: [unbounded],
    signatureVerifier: signer,
    now: assessedAt,
  });
  assert.equal(priorVersionFinding.finding, 'SUPPORTED');
});

test('offline replay preserves the signed evidence-bound 0.4 rules and manifest version', () => {
  const { signer, publicKeyPem } = createSigner();
  const claim = { ...ppfClaim(), statement: 'The PPF interest rate is no longer 7.1% p.a.' };
  const evidence = syntheticEvidence(signer);
  const finding = verifyConfirmedGenieProofClaim(claim, {
    verifierVersion: GENIEPROOF_PREVIOUS_EVIDENCE_VERIFIER_VERSION,
    evidenceRevisions: [evidence],
    signatureVerifier: signer,
    now: assessedAt,
  });
  const { manifest } = buildGenieProofManifest({
    caseId: '00000000-0000-4000-8000-000000000001',
    ownerId: '65b000000000000000000001',
    submissionHash: 'd'.repeat(64),
    confirmedClaims: [claim],
    findings: [finding],
    revision: 1,
    assessedAt: assessedAt.toISOString(),
    verifierVersion: GENIEPROOF_PREVIOUS_EVIDENCE_VERIFIER_VERSION,
    evidenceRegistrySnapshotHash: 'f'.repeat(64),
  });
  assert.equal(manifest.schemaVersion, 'genieproof-passport/0.3.0');
  const replay = verifyExportedGenieProofPassport(signer.signManifest(manifest), {
    trustedPublicKeys: { 'synthetic-evidence-test-key': publicKeyPem },
  });
  assert.equal(replay.signature, 'SIGNATURE_INTEGRITY_VALID');
  assert.equal(replay.findings, 'FINDING_REPRODUCIBLE');
  assert.equal(replay.findingSemantics, 'LEGACY_REPLAY_ONLY');
  assert.equal(replay.evidence, 'EVIDENCE_INTEGRITY_CHECKABLE');
});

test('offline replay preserves the older evidence-bound 0.3 manifest contract', () => {
  const { signer, publicKeyPem } = createSigner();
  const claim = { ...ppfClaim(), statement: 'The PPF interest rate is no longer 7.1% p.a.' };
  const evidence = syntheticEvidence(signer);
  const finding = verifyConfirmedGenieProofClaim(claim, {
    verifierVersion: GENIEPROOF_LEGACY_EVIDENCE_VERIFIER_VERSION,
    evidenceRevisions: [evidence],
    signatureVerifier: signer,
    now: assessedAt,
  });
  const { manifest } = buildGenieProofManifest({
    caseId: '00000000-0000-4000-8000-000000000001',
    ownerId: '65b000000000000000000001',
    submissionHash: 'd'.repeat(64),
    confirmedClaims: [claim],
    findings: [finding],
    revision: 1,
    assessedAt: assessedAt.toISOString(),
    verifierVersion: GENIEPROOF_LEGACY_EVIDENCE_VERIFIER_VERSION,
    evidenceRegistrySnapshotHash: 'f'.repeat(64),
  });
  assert.equal(manifest.schemaVersion, 'genieproof-passport/0.2.0');
  const replay = verifyExportedGenieProofPassport(signer.signManifest(manifest), {
    trustedPublicKeys: { 'synthetic-evidence-test-key': publicKeyPem },
  });
  assert.equal(replay.signature, 'SIGNATURE_INTEGRITY_VALID');
  assert.equal(replay.findings, 'FINDING_REPRODUCIBLE');
  assert.equal(replay.findingSemantics, 'LEGACY_REPLAY_ONLY');
});

test('conflicting qualified evidence abstains and unsupported claim classes remain out of scope', () => {
  const { signer } = createSigner();
  const conflict = verify(ppfClaim(), [
    syntheticEvidence(signer, { sourceId: 'synthetic-source-a', value: 7.1 }),
    syntheticEvidence(signer, { sourceId: 'synthetic-source-b', value: 7.2 }),
  ], signer);
  assert.equal(conflict.finding, 'NOT_VERIFIABLE');
  assert.deepEqual(conflict.reasonCodes, ['QUALIFIED_SOURCE_CONFLICT']);
  assert.equal(verify({ ...ppfClaim(), claimType: 'PROMISED_RETURN' }, [], signer).finding, 'OUT_OF_SCOPE');
});

test('attestation tampering fails closed and a signed synthetic Passport replays evidence integrity separately from correctness', () => {
  const { signer, publicKeyPem } = createSigner();
  const claim = ppfClaim();
  const evidence = syntheticEvidence(signer);
  const finding = verify(claim, evidence, signer);
  const { manifest } = buildGenieProofManifest({
    caseId: '00000000-0000-4000-8000-000000000001',
    ownerId: '65b000000000000000000001',
    submissionHash: 'd'.repeat(64),
    confirmedClaims: [claim],
    findings: [finding],
    revision: 2,
    previousManifestHash: 'e'.repeat(64),
    assessedAt: assessedAt.toISOString(),
    verifierVersion: GENIEPROOF_EVIDENCE_VERIFIER_VERSION,
    evidenceRegistrySnapshotHash: 'f'.repeat(64),
  });
  const replay = verifyExportedGenieProofPassport(signer.signManifest(manifest), {
    trustedPublicKeys: { 'synthetic-evidence-test-key': publicKeyPem },
  });
  assert.equal(replay.signature, 'SIGNATURE_INTEGRITY_VALID');
  assert.equal(replay.evidence, 'EVIDENCE_INTEGRITY_CHECKABLE');
  assert.equal(replay.findings, 'FINDING_REPRODUCIBLE');
  assert.equal(replay.findingSemantics, 'CURRENT_POLICY_REPLAY_ONLY');
  assert.equal(replay.financialCorrectness, 'NOT_ESTABLISHED_BY_SIGNATURE');

  const tampered = structuredClone(evidence);
  tampered.fact.value = 8.25;
  assert.equal(verify(ppfClaim(), tampered, signer).finding, 'NOT_VERIFIABLE');

  const wrongUnit = structuredClone(evidence);
  wrongUnit.fact.unit = 'PERCENT';
  wrongUnit.factHash = buildGenieProofEvidenceFactHash(wrongUnit.fact);
  wrongUnit.attestation = signer.signManifest(buildGenieProofEvidenceAttestationPayload(wrongUnit));
  assert.equal(verify(ppfClaim(), wrongUnit, signer).finding, 'NOT_VERIFIABLE');

  const unsupportedParser = structuredClone(evidence);
  unsupportedParser.parserVersion = 'synthetic-parser/999.0.0';
  unsupportedParser.attestation = signer.signManifest(buildGenieProofEvidenceAttestationPayload(unsupportedParser));
  assert.equal(verify(ppfClaim(), unsupportedParser, signer).finding, 'NOT_VERIFIABLE');
});
