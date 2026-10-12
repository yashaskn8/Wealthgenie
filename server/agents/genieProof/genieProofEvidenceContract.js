import { canonicalSha256 } from '../../utils/canonicalJson.js';

export const GENIEPROOF_EVIDENCE_ATTESTATION_VERSION = 'genieproof-financial-evidence/1.0.0';
// Version used by already-signed evidence-bound 0.3/0.4 passports. It is
// accepted only while replaying those legacy manifests, never for current
// assessments or source selection.
export const GENIEPROOF_LEGACY_PPF_PARSER_VERSION = 'india-post-small-savings/qualified-identities-2';
// Supersedes the loose bundle marker association. Older evidence may remain
// signed history, but cannot be selected for a new current assessment.
export const GENIEPROOF_PPF_PARSER_VERSION = 'india-post-small-savings/source-record-association-unqualified-3';
export const GENIEPROOF_PPF_RATE_RULE_VERSION = 'genieproof-current-nominal-rate/0.1.0';

export function buildGenieProofEvidenceAttestationPayload(evidence) {
  const fact = evidence?.fact || {};
  const retrievalIds = Array.isArray(evidence?.retrievalIds) ? [...evidence.retrievalIds].sort() : [];
  const retrievalReceiptHashes = Array.isArray(evidence?.retrievalReceiptHashes)
    ? [...evidence.retrievalReceiptHashes].sort() : [];
  return {
    schemaVersion: GENIEPROOF_EVIDENCE_ATTESTATION_VERSION,
    evidenceId: evidence?.evidenceId,
    revision: evidence?.revision,
    sourceId: evidence?.sourceId,
    sourceRevision: evidence?.sourceRevision,
    sourceDefinitionHash: evidence?.sourceDefinitionHash,
    retrievalIds,
    retrievalReceiptHashes,
    publicationAt: evidence?.publicationAt || null,
    retrievedAt: evidence?.retrievedAt,
    sourceContentCommitment: evidence?.sourceContentCommitment,
    sourceQualificationAtAssessment: evidence?.sourceQualificationAtAssessment,
    reusePermissionAtAssessment: evidence?.reusePermissionAtAssessment,
    freshnessStatus: evidence?.freshnessStatus,
    revocationStatus: evidence?.revocationStatus,
    fact: {
      claimType: fact.claimType,
      productId: fact.productId,
      value: fact.value,
      unit: fact.unit,
      effectiveFrom: fact.effectiveFrom,
      effectiveTo: fact.effectiveTo || null,
      conditions: Array.isArray(fact.conditions) ? [...fact.conditions] : [],
    },
    parserVersion: evidence?.parserVersion,
    ruleVersion: evidence?.ruleVersion,
    sourceLineage: Array.isArray(evidence?.sourceLineage) ? [...evidence.sourceLineage] : [],
    supersedes: evidence?.supersedes || null,
    factHash: evidence?.factHash,
  };
}

export function buildGenieProofEvidenceFactHash(fact) {
  return canonicalSha256({
    claimType: fact?.claimType,
    productId: fact?.productId,
    value: fact?.value,
    unit: fact?.unit,
    effectiveFrom: fact?.effectiveFrom,
    effectiveTo: fact?.effectiveTo || null,
    conditions: Array.isArray(fact?.conditions) ? [...fact.conditions] : [],
  });
}

export function evidenceRevisionHashesFromFindings(findings = []) {
  return [...new Set(findings.flatMap(finding => {
    const revisions = finding?.evidence?.revisions;
    if (Array.isArray(revisions)) return revisions.map(revision => revision.factHash).filter(Boolean);
    return finding?.evidence?.factHash ? [finding.evidence.factHash] : [];
  }))].sort();
}
