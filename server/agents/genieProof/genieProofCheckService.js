import { extractGenieProofClaims, GENIEPROOF_EVIDENCE_VERIFIER_VERSION, verifyConfirmedGenieProofClaim } from './genieProofCore.js';
import { resolveGenieProofEvidenceForClaims } from './genieProofEvidenceRegistryService.js';
import { GenieProofPassportVerifier, parseGenieProofTrustedPublicKeysJson } from './genieProofPassportSignature.js';

const SOURCE_URL = 'https://www.indiapost.gov.in/banking-services/savings';
const MAX_EVIDENCE_AGE_MS = 72 * 60 * 60 * 1000;

export function createGenieProofReadOnlyVerifier(env = process.env) {
  if (!env.GENIEPROOF_VERIFY_PUBLIC_KEYS_JSON) return null;
  try {
    const trustedPublicKeys = parseGenieProofTrustedPublicKeysJson(env.GENIEPROOF_VERIFY_PUBLIC_KEYS_JSON);
    if (Object.keys(trustedPublicKeys).length === 0) return null;
    const revokedKeyIds = env.GENIEPROOF_REVOKED_SIGNING_KEY_IDS_JSON
      ? JSON.parse(env.GENIEPROOF_REVOKED_SIGNING_KEY_IDS_JSON) : [];
    return new GenieProofPassportVerifier({ trustedPublicKeys, revokedKeyIds });
  } catch {
    // Invalid or missing public-key trust is never treated as successful verification.
    return null;
  }
}

function warningSignals(statement) {
  const warnings = [];
  if (/\b(?:guaranteed?\s+(?:returns?|profit|income)|risk[- ]?free|assured\s+(?:returns?|profit))\b/i.test(statement)) {
    warnings.push('Guarantee or risk-free wording needs independently checked product terms.');
  }
  if (/\b(?:SEBI|RBI|government)\s+(?:approved|certified|guaranteed|endorsed)\b/i.test(statement)) {
    warnings.push('Regulatory or government endorsement wording needs an official source.');
  }
  if (/\b(?:act\s+now|limited[- ]time|today\s+only|double\s+your\s+money)\b/i.test(statement)) {
    warnings.push('Urgency or unusually strong return wording deserves extra scrutiny.');
  }
  return warnings;
}

function unverified(candidate, reasonCode, explanation) {
  return {
    claimId: candidate.claimId,
    statement: candidate.originalSpan,
    verdict: 'NOT_VERIFIED',
    reasonCode,
    explanation,
    source: null,
    warningSignals: warningSignals(candidate.originalSpan),
  };
}

export async function checkGenieProofClaims({
  offerText,
  now = () => new Date(),
  verifier = null,
  evidenceResolver = resolveGenieProofEvidenceForClaims,
} = {}) {
  const extracted = extractGenieProofClaims(offerText);
  if (!extracted.ok) return { ok: false, code: extracted.code };
  // Do not silently drop claims and imply that the whole submitted offer was checked.
  if (extracted.claimsTruncated) return { ok: false, code: 'GENIEPROOF_TOO_MANY_CLAIMS' };

  const checkedAt = now();
  if (!(checkedAt instanceof Date) || !Number.isFinite(checkedAt.getTime())) {
    return { ok: false, code: 'GENIEPROOF_CHECK_TIME_UNAVAILABLE' };
  }

  const supported = extracted.claims.filter(claim => claim.claimType === 'CURRENT_NOMINAL_RATE');
  let evidenceByClaim = {};
  let evidenceError = false;
  if (supported.length && verifier?.verifySignedManifest) {
    try {
      const resolved = await evidenceResolver({ claims: supported, now: () => checkedAt });
      if (!resolved || !resolved.byClaimId || typeof resolved.byClaimId !== 'object' || Array.isArray(resolved.byClaimId)) {
        evidenceError = true;
      } else {
        evidenceByClaim = resolved.byClaimId;
      }
    } catch {
      evidenceError = true;
    }
  }

  const claims = extracted.claims.map(candidate => {
    if (candidate.claimType !== 'CURRENT_NOMINAL_RATE') {
      return unverified(candidate, 'CLAIM_NOT_SUPPORTED',
        'An official evidence check for this type of financial statement is not available.');
    }
    if (!verifier?.verifySignedManifest) {
      return unverified(candidate, 'NO_TRUSTED_EVIDENCE_VERIFIER',
        'We cannot confirm this claim with an approved official source right now.');
    }
    if (evidenceError) {
      return unverified(candidate, 'EVIDENCE_LOOKUP_UNAVAILABLE',
        'Official source records could not be checked right now.');
    }
    const evidence = evidenceByClaim[candidate.claimId];
    if (!Array.isArray(evidence) || evidence.length === 0) {
      return unverified(candidate, 'NO_QUALIFIED_SOURCE',
        'No approved, up-to-date official source is available for this exact statement.');
    }
    // Reject old or future-dated source retrieval even if a persisted FRESH flag remains set.
    if (evidence.some(record => {
      const date = new Date(record?.retrievedAt).getTime();
      return !Number.isFinite(date) || date > checkedAt.getTime() + 5 * 60 * 1000
        || checkedAt.getTime() - date > MAX_EVIDENCE_AGE_MS;
    })) {
      return unverified(candidate, 'EVIDENCE_TOO_OLD',
        'The available source record is too old to confirm the current rate.');
    }
    const claim = {
      claimId: candidate.claimId,
      statement: candidate.originalSpan,
      claimType: candidate.claimType,
      productId: candidate.productId,
      value: candidate.value,
      unit: candidate.unit,
    };
    let finding;
    try {
      finding = verifyConfirmedGenieProofClaim(claim, {
        verifierVersion: GENIEPROOF_EVIDENCE_VERIFIER_VERSION,
        evidenceRevisions: evidence,
        signatureVerifier: verifier,
        now: checkedAt,
      });
    } catch {
      return unverified(candidate, 'EVIDENCE_CHECK_FAILED',
        'The source data did not pass our verification checks.');
    }
    if (!['SUPPORTED', 'CONTRADICTED'].includes(finding?.finding)) {
      return unverified(candidate, 'EVIDENCE_INCONCLUSIVE',
        'The available official evidence is incomplete, inconsistent or out of date.');
    }
    const revisions = finding?.evidence?.revisions;
    if (!Array.isArray(revisions) || revisions.length === 0
        || revisions.some(rev => rev.sourceId !== 'india-post-small-savings'
          || !Number.isFinite(rev.fact?.value))) {
      return unverified(candidate, 'SOURCE_IDENTITY_NOT_QUALIFIED',
        'We could not establish that the source refers to this exact scheme.');
    }
    // Test-only evidence must never become a public financial truth claim.
    if (revisions.some(rev => Array.isArray(rev.sourceLineage)
      && rev.sourceLineage.some(item => /synthetic|test[-_ ]fixture/i.test(String(item))))) {
      return unverified(candidate, 'SYNTHETIC_EVIDENCE_REJECTED',
        'This is test data, not evidence of a real-world rate.');
    }
    // Signed source evidence must bind to the exact official page origin and
    // the original page content digest; random or missing lineage is not enough.
    const officialOrigin = new URL(SOURCE_URL).origin;
    if (revisions.some(rev => !Array.isArray(rev.sourceLineage)
      || rev.sourceLineage.length !== 2
      || rev.sourceLineage[0] !== officialOrigin
      || !/^[a-f0-9]{64}$/.test(rev.sourceLineage[1]))) {
      return unverified(candidate, 'SOURCE_LINEAGE_NOT_VERIFIED',
        'We could not confirm that the data came from the expected official publication.');
    }
    const first = revisions[0];
    return {
      claimId: candidate.claimId,
      statement: candidate.originalSpan,
      verdict: finding.finding,
      reasonCode: finding.finding === 'SUPPORTED' ? 'EXACT_RATE_MATCH' : 'EXACT_RATE_MISMATCH',
      explanation: finding.finding === 'SUPPORTED'
        ? 'The exact PPF interest-rate claim matches qualified evidence for the indicated period.'
        : 'The claimed PPF interest rate differs from qualified evidence for the indicated period.',
      source: {
        name: 'India Post — Savings',
        url: SOURCE_URL,
        observedRatePercentPerAnnum: first.fact.value,
        retrievedAt: new Date(first.retrievedAt).toISOString(),
        effectiveFrom: first.effectiveFrom,
        effectiveTo: first.effectiveTo,
      },
      warningSignals: [],
    };
  });
  return {
    ok: true,
    mode: 'READ_ONLY_FINANCIAL_CLAIM_CHECK',
    checkedAt: checkedAt.toISOString(),
    saved: false,
    claims,
    noClaimsFound: claims.length === 0,
    allExtractedCandidatesProcessed: true,
    verificationScope: 'DETECTED_CLAIMS_ONLY',
  };
}
