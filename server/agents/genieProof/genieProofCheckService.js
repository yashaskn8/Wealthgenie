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
      if (!resolved || typeof resolved.byClaimId !== 'object' || Array.isArray(resolved.byClaimId)) {
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
        'No approved public-key evidence verifier is configured. The claim has not been verified.');
    }
    if (evidenceError) {
      return unverified(candidate, 'EVIDENCE_LOOKUP_UNAVAILABLE',
        'Trusted source evidence could not be checked. No conclusion was reached.');
    }
    const evidence = evidenceByClaim[candidate.claimId];
    if (!Array.isArray(evidence) || evidence.length === 0) {
      return unverified(candidate, 'NO_QUALIFIED_SOURCE',
        'No current, licensed and qualified source evidence is available for this exact claim.');
    }
    // Reject old or future-dated source retrieval even if a persisted FRESH flag remains set.
    if (evidence.some(record => {
      const date = new Date(record?.retrievedAt).getTime();
      return !Number.isFinite(date) || date > checkedAt.getTime() + 5 * 60 * 1000
        || checkedAt.getTime() - date > MAX_EVIDENCE_AGE_MS;
    })) {
      return unverified(candidate, 'EVIDENCE_TOO_OLD',
        'The source has not been freshly checked; an older record cannot establish a current claim.');
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
        'The evidence could not be safely evaluated.');
    }
    if (!['SUPPORTED', 'CONTRADICTED'].includes(finding?.finding)) {
      return unverified(candidate, 'EVIDENCE_INCONCLUSIVE',
        'Evidence was incomplete, conflicting, stale or not applicable to this exact claim.');
    }
    const revisions = finding?.evidence?.revisions;
    if (!Array.isArray(revisions) || revisions.length === 0
        || revisions.some(rev => rev.sourceId !== 'india-post-small-savings'
          || !Number.isFinite(rev.fact?.value))) {
      return unverified(candidate, 'SOURCE_IDENTITY_NOT_QUALIFIED',
        'The source identity or fact could not be confirmed.');
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
    completeInputExamined: true,
  };
}
