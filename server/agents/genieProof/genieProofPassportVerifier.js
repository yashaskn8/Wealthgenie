import { canonicalSha256 } from '../../utils/canonicalJson.js';
import { GENIEPROOF_MANIFEST_VERSION, GENIEPROOF_VERIFIER_VERSION, verifyConfirmedGenieProofClaim } from './genieProofCore.js';
import { genieProofConfirmedClaimSchema } from './genieProofSchemas.js';
import { GenieProofPassportVerifier } from './genieProofPassportSignature.js';

function incompleteResult({ signatureCheck, findingStatus = 'VERIFICATION_INCOMPLETE', code, reason }) {
  return {
    status: 'VERIFICATION_INCOMPLETE',
    signature: signatureCheck,
    evidence: 'VERIFICATION_INCOMPLETE',
    findings: findingStatus,
    trustedIssuer: signatureCheck === 'SIGNATURE_INTEGRITY_VALID',
    financialCorrectness: 'NOT_ESTABLISHED_BY_SIGNATURE',
    code,
    reasons: reason ? [reason] : [],
  };
}

function hasReproducibleFindings(manifest) {
  const claims = manifest?.confirmedClaims;
  const findings = manifest?.findings;
  if (!Array.isArray(claims) || !Array.isArray(findings) || claims.length !== findings.length) return false;
  const claimsById = new Map();
  for (const claim of claims) {
    if (!claim || typeof claim.claimId !== 'string' || claimsById.has(claim.claimId)) return false;
    if (genieProofConfirmedClaimSchema.validate(claim, { convert: false, allowUnknown: false }).error) return false;
    claimsById.set(claim.claimId, claim);
  }
  const findingsById = new Map();
  for (const finding of findings) {
    if (!finding || typeof finding.claimId !== 'string' || findingsById.has(finding.claimId)) return false;
    findingsById.set(finding.claimId, finding);
  }
  if (claimsById.size !== findingsById.size) return false;
  for (const [claimId, claim] of claimsById) {
    const actual = findingsById.get(claimId);
    if (!actual) return false;
    let expected;
    try {
      expected = verifyConfirmedGenieProofClaim(claim);
    } catch {
      return false;
    }
    try {
      if (canonicalSha256(expected) !== canonicalSha256(actual)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function hasValidManifestBindings(manifest) {
  if (!Array.isArray(manifest?.confirmedClaims) || !Array.isArray(manifest?.findings)
      || manifest?.schemaVersion !== GENIEPROOF_MANIFEST_VERSION
      || manifest?.verifierVersion !== GENIEPROOF_VERIFIER_VERSION
      || manifest?.policyVersion !== GENIEPROOF_VERIFIER_VERSION
      || !/^[0-9a-f-]{36}$/i.test(manifest?.caseId || '')
      || !Number.isSafeInteger(manifest?.revision) || manifest.revision < 1
      || !/^[a-f0-9]{64}$/.test(manifest?.submissionHash || '')
      || !/^[a-f0-9]{64}$/.test(manifest?.ownerBindingHash || '')
      || !/^[a-f0-9]{64}$/.test(manifest?.confirmedClaimsHash || '')
      || !/^[a-f0-9]{64}$/.test(manifest?.productIdentityHash || '')
      || !(manifest.previousManifestHash === null || /^[a-f0-9]{64}$/.test(manifest.previousManifestHash || ''))
      || typeof manifest.assessedAt !== 'string' || !Number.isFinite(Date.parse(manifest.assessedAt))) return false;
  const claims = [...manifest.confirmedClaims].sort((a, b) => a.claimId.localeCompare(b.claimId));
  const products = claims.map(claim => ({ claimId: claim.claimId, productId: claim.productId }))
    .sort((a, b) => a.claimId.localeCompare(b.claimId));
  const evidenceHashes = [];
  for (const finding of manifest.findings) {
    if (!finding?.evidence) continue;
    if (!/^[a-f0-9]{64}$/.test(finding.evidence.factHash || '')) return false;
    evidenceHashes.push(finding.evidence.factHash);
  }
  const canonicalEvidenceHashes = [...new Set(evidenceHashes)].sort();
  return canonicalSha256(claims) === manifest.confirmedClaimsHash
    && canonicalSha256(products) === manifest.productIdentityHash
    && Array.isArray(manifest.evidenceRevisionHashes)
    && manifest.evidenceRevisionHashes.every(hash => /^[a-f0-9]{64}$/.test(hash))
    && canonicalSha256(canonicalEvidenceHashes) === canonicalSha256(manifest.evidenceRevisionHashes);
}

/**
 * Verify a downloaded GenieProof passport without a database or private key.
 * Trust anchors must be provided out-of-band by the caller. This verifies the
 * signed content and replays the deterministic finding policy; it cannot
 * establish financial correctness when qualified evidence is absent.
 */
export function verifyExportedGenieProofPassport(signedPassport, options = {}) {
  let signatureResult;
  try {
    const trustedPublicKeys = options && typeof options === 'object'
      ? (options.trustedPublicKeys ?? {})
      : null;
    signatureResult = new GenieProofPassportVerifier({ trustedPublicKeys }).verifySignedManifest(signedPassport);
  } catch {
    return incompleteResult({
      signatureCheck: 'VERIFICATION_INCOMPLETE',
      code: 'PASSPORT_TRUST_STORE_INVALID',
      reason: 'A valid out-of-band Ed25519 trust store is required.',
    });
  }

  if (!signatureResult.integrityValid) {
    return {
      status: 'VERIFICATION_FAILED',
      signature: 'VERIFICATION_FAILED',
      evidence: 'VERIFICATION_INCOMPLETE',
      findings: 'VERIFICATION_INCOMPLETE',
      trustedIssuer: false,
      financialCorrectness: 'NOT_ESTABLISHED_BY_SIGNATURE',
      code: signatureResult.code,
      reasons: ['The manifest hash or signature envelope is invalid.'],
    };
  }
  if (!signatureResult.valid || !signatureResult.trustedIssuer) {
    return incompleteResult({
      signatureCheck: 'VERIFICATION_INCOMPLETE',
      code: signatureResult.code,
      reason: 'The passport key is not verified by the supplied out-of-band trust store.',
    });
  }

  const manifest = signedPassport.manifest;
  const findingsReproduced = hasReproducibleFindings(manifest)
    && hasValidManifestBindings(manifest);
  if (!findingsReproduced) {
    return {
      status: 'VERIFICATION_FAILED',
      signature: 'SIGNATURE_INTEGRITY_VALID',
      evidence: 'VERIFICATION_INCOMPLETE',
      findings: 'VERIFICATION_FAILED',
      trustedIssuer: true,
      financialCorrectness: 'NOT_ESTABLISHED_BY_SIGNATURE',
      code: 'PASSPORT_FINDING_REPLAY_MISMATCH',
      reasons: ['The signed findings do not reproduce under the included deterministic verifier version.'],
    };
  }

  const hasEvidenceBindings = Array.isArray(manifest.evidenceRevisionHashes)
    && manifest.evidenceRevisionHashes.length > 0;
  return {
    status: 'VERIFICATION_INCOMPLETE',
    signature: 'SIGNATURE_INTEGRITY_VALID',
    evidence: 'VERIFICATION_INCOMPLETE',
    findings: 'FINDING_REPRODUCIBLE',
    trustedIssuer: true,
    financialCorrectness: 'NOT_ESTABLISHED_BY_SIGNATURE',
    code: hasEvidenceBindings ? 'QUALIFIED_EVIDENCE_NOT_INCLUDED' : 'QUALIFIED_EVIDENCE_UNAVAILABLE',
    reasons: [
      hasEvidenceBindings
        ? 'The passport references evidence revisions, but this export contains no independently checkable qualified evidence package.'
        : 'The passport contains no qualified evidence revisions, so its abstaining result can be replayed but not independently checked against financial facts.',
    ],
  };
}
