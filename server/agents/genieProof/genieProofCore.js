import crypto from 'node:crypto';
import { canonicalJson, canonicalSha256 } from '../../utils/canonicalJson.js';
import {
  buildGenieProofEvidenceAttestationPayload,
  buildGenieProofEvidenceFactHash,
  evidenceRevisionHashesFromFindings,
  GENIEPROOF_PPF_PARSER_VERSION,
  GENIEPROOF_PPF_RATE_RULE_VERSION,
} from './genieProofEvidenceContract.js';

export const GENIEPROOF_LEGACY_PREVIOUS_VERIFIER_VERSION = 'genieproof-current-rate/0.2.0';
export const GENIEPROOF_PREVIOUS_VERIFIER_VERSION = 'genieproof-current-rate/0.3.0';
export const GENIEPROOF_VERIFIER_VERSION = 'genieproof-current-rate/0.4.0';
export const GENIEPROOF_LEGACY_EVIDENCE_VERIFIER_VERSION = 'genieproof-evidence-bound/0.3.0';
export const GENIEPROOF_PREVIOUS_EVIDENCE_VERIFIER_VERSION = 'genieproof-evidence-bound/0.4.0';
export const GENIEPROOF_EVIDENCE_VERIFIER_VERSION = 'genieproof-evidence-bound/0.5.0';
export const GENIEPROOF_LEGACY_VERIFIER_VERSION = 'genieproof-current-rate/0.1.0';
export const GENIEPROOF_SUPPORTED_VERIFIER_VERSIONS = Object.freeze([
  GENIEPROOF_LEGACY_VERIFIER_VERSION,
  GENIEPROOF_LEGACY_PREVIOUS_VERIFIER_VERSION,
  GENIEPROOF_PREVIOUS_VERIFIER_VERSION,
  GENIEPROOF_VERIFIER_VERSION,
  GENIEPROOF_LEGACY_EVIDENCE_VERIFIER_VERSION,
  GENIEPROOF_PREVIOUS_EVIDENCE_VERIFIER_VERSION,
  GENIEPROOF_EVIDENCE_VERIFIER_VERSION,
]);
export const GENIEPROOF_MANIFEST_VERSION = 'genieproof-passport/0.1.0';
export const GENIEPROOF_LEGACY_EVIDENCE_MANIFEST_VERSION = 'genieproof-passport/0.2.0';
export const GENIEPROOF_PREVIOUS_EVIDENCE_MANIFEST_VERSION = 'genieproof-passport/0.3.0';
export const GENIEPROOF_EVIDENCE_MANIFEST_VERSION = 'genieproof-passport/0.4.0';
export const GENIEPROOF_MAX_SUBMISSION_BYTES = 16_000;
export const GENIEPROOF_MAX_CLAIMS = 10;
export const GENIEPROOF_SUPPORTED_PRODUCT_ID = 'government:india-post:ppf';

const UNSUPPORTED_SEMANTICS = /\b(?:guarantee(?:s|d)?|assured|maturity|tax(?:-free|able|ation)?|after\s+tax|post[- ]tax|withdraw(?:al|als)?|lock[- ]?in|liquid(?:ity)?|safe|risk|returns?|yield|eligible|eligibility|claim\s+now|buy|sell|invest\s+now|historical|previously|last\s+(?:year|quarter)|in\s+20\d{2}|was|were|will\s+be|expected|projected|not|isn't|wasn't|cannot|can't|fixed|remain(?:s|ed|ing)?|until|through\s+20\d{2}|next\s+(?:quarter|month|year|financial\s+year)|may|might|could|would|should|if|whether|assuming|possibly|perhaps|approximately|approx|about|around|up\s+to|ignore\s+(?:all\s+)?instructions|system\s+prompt|assistant\s+tool|another\s+scheme|other\s+scheme|\band\b|\bor\b|versus|\bvs\b)\b/i;
const LEGACY_UNSUPPORTED_SEMANTICS = /\b(?:guarantee(?:s|d)?|assured|maturity|tax(?:-free|able|ation)?|after\s+tax|post[- ]tax|withdraw(?:al|als)?|lock[- ]?in|liquid(?:ity)?|safe|risk|returns?|yield|eligible|eligibility|claim\s+now|buy|sell|invest\s+now|historical|previously|last\s+(?:year|quarter)|in\s+20\d{2}|was|were|will\s+be|expected|projected|not|isn't|wasn't|cannot|can't|fixed|remain(?:s|ed|ing)?|until|through\s+20\d{2}|next\s+(?:quarter|month|year|financial\s+year)|ignore\s+(?:all\s+)?instructions|system\s+prompt|assistant\s+tool|another\s+scheme|other\s+scheme|\band\b|\bor\b|versus|\bvs\b)\b/i;
const PERCENT_PER_ANNUM = /(?:\b(\d{1,2}(?:\.\d{1,4})?)\s*%\s*(?:p\.?\s*a\.?|per\s+annum|annually|annual(?:\s+rate)?)(?=$|[\s,;.!?])|\b(\d{1,2}(?:\.\d{1,4})?)\s*percent\s+per\s+annum\b)/i;
const PERCENT_VALUE = /\b(\d{1,2}(?:\.\d{1,4})?)\s*%/gi;
const PPF_IDENTITY = /\b(?:PPF|Public Provident Fund(?: Scheme)?)\b/gi;
const RATE_WORDING = /\b(?:rate|interest)\b/i;
const CURRENT_RATE_SCOPE_UNSUPPORTED = /\b(?:no\s+(?:longer|more)|never)\b|\b(?:q[1-4]\s*(?:fy\s*)?20\d{2}|fy\s*20\d{2}\s*[-/]\s*\d{2}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+20\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{4}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+\d{4})\b/i;
const EXACT_CURRENT_PPF_RATE_STATEMENT = /^\s*(?:the\s+)?(?:(?:current|official)\s+){0,2}(?:ppf|public\s+provident\s+fund(?:\s+scheme)?)\s+(?:current\s+)?(?:official\s+)?interest\s+rate\s+(?:is|stands\s+at|:)\s*(\d{1,2}(?:\.\d{1,4})?)\s*%\s*(?:p\.?\s*a\.?|per\s+annum)\.?\s*$/i;
const FINANCIAL_CLAIM_SIGNAL = /\b(?:interest\s+rate|returns?|yield|guarantee(?:d)?|assured|capital\s+(?:protection|guarantee)|deposit\s+insurance|lock[- ]?in|withdraw(?:al|als)|liquid(?:ity)?|minimum\s+investment|maximum\s+investment|NAV|net\s+asset\s+value|mutual\s+fund|historical\s+performance|historical\s+return|tax(?:-free|able|ation|\s+exemption)?|deduction|80C|112A|50AA|registered\s+with\s+(?:SEBI|RBI)|(?:SEBI|RBI)[- ]registered)\b/i;

export function isGenieProofEvidenceVerifierVersion(verifierVersion) {
  return verifierVersion === GENIEPROOF_LEGACY_EVIDENCE_VERIFIER_VERSION
    || verifierVersion === GENIEPROOF_PREVIOUS_EVIDENCE_VERIFIER_VERSION
    || verifierVersion === GENIEPROOF_EVIDENCE_VERIFIER_VERSION;
}

export function genieProofManifestVersionForVerifier(verifierVersion) {
  if (verifierVersion === GENIEPROOF_EVIDENCE_VERIFIER_VERSION) return GENIEPROOF_EVIDENCE_MANIFEST_VERSION;
  if (verifierVersion === GENIEPROOF_PREVIOUS_EVIDENCE_VERIFIER_VERSION) return GENIEPROOF_PREVIOUS_EVIDENCE_MANIFEST_VERSION;
  if (verifierVersion === GENIEPROOF_LEGACY_EVIDENCE_VERIFIER_VERSION) return GENIEPROOF_LEGACY_EVIDENCE_MANIFEST_VERSION;
  return GENIEPROOF_MANIFEST_VERSION;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableClaimId(inputHash, start, end, index) {
  return sha256(`${inputHash}:${start}:${end}:${index}`).slice(0, 32);
}

function containsUnsupportedClaimSemantics(text, verifierVersion = GENIEPROOF_VERIFIER_VERSION) {
  const semantics = verifierVersion === GENIEPROOF_LEGACY_VERIFIER_VERSION
    ? LEGACY_UNSUPPORTED_SEMANTICS : UNSUPPORTED_SEMANTICS;
  return semantics.test(text) || /-\s*\d+(?:\.\d+)?\s*%/.test(text)
    || (verifierVersion !== GENIEPROOF_LEGACY_VERIFIER_VERSION && /\?/.test(text))
    || (verifierVersion === GENIEPROOF_VERIFIER_VERSION
      || verifierVersion === GENIEPROOF_EVIDENCE_VERIFIER_VERSION)
      && CURRENT_RATE_SCOPE_UNSUPPORTED.test(text);
}

function isExactCurrentPpfRateStatement(statement, value) {
  if (typeof statement !== 'string' || !Number.isFinite(value)) return false;
  const match = statement.match(EXACT_CURRENT_PPF_RATE_STATEMENT);
  return Boolean(match) && Number(match[1]) === Number(value);
}

function splitSentences(text) {
  const spans = [];
  const boundaries = /(?<!p\.a)[.!?]+(?=\s+|$)|\n+/gi;
  let segmentStart = 0;
  const addSegment = (start, end) => {
    const original = text.slice(start, end);
    const leading = original.search(/\S/);
    if (leading < 0) return;
    const sentence = original.trim();
    const actualStart = start + leading;
    spans.push({ text: sentence, start: actualStart, end: actualStart + sentence.length });
  };
  for (const match of text.matchAll(boundaries)) {
    addSegment(segmentStart, match.index + match[0].length);
    segmentStart = match.index + match[0].length;
  }
  addSegment(segmentStart, text.length);
  return spans;
}

export function extractGenieProofClaims(offerText) {
  if (typeof offerText !== 'string') {
    return { ok: false, code: 'OFFER_TEXT_REQUIRED' };
  }
  const normalized = offerText.normalize('NFC');
  if (!normalized.trim()) return { ok: false, code: 'OFFER_TEXT_REQUIRED' };
  if (Buffer.byteLength(normalized, 'utf8') > GENIEPROOF_MAX_SUBMISSION_BYTES) {
    return { ok: false, code: 'OFFER_TEXT_TOO_LARGE' };
  }

  const inputHash = sha256(offerText);
  const claims = [];
  let omittedClaimCount = 0;
  for (const span of splitSentences(normalized)) {
    const rateMatch = span.text.match(PERCENT_PER_ANNUM);
    const percentMatches = [...span.text.matchAll(PERCENT_VALUE)];
    const hasPpfIdentity = PPF_IDENTITY.test(span.text);
    PPF_IDENTITY.lastIndex = 0;
    const hasFinancialPercent = percentMatches.length > 0
      && (hasPpfIdentity || FINANCIAL_CLAIM_SIGNAL.test(span.text));
    if (!rateMatch && !FINANCIAL_CLAIM_SIGNAL.test(span.text) && !hasFinancialPercent) continue;
    if (claims.length >= GENIEPROOF_MAX_CLAIMS) {
      omittedClaimCount += 1;
      continue;
    }
    const numericText = rateMatch ? (rateMatch[1] || rateMatch[2]) : null;
    const productMatches = [...span.text.matchAll(PPF_IDENTITY)];
    const hasSinglePpfIdentity = productMatches.length === 1;
    const unsupportedSemantics = containsUnsupportedClaimSemantics(span.text);
    const rateCount = rateMatch ? [...span.text.matchAll(new RegExp(PERCENT_PER_ANNUM.source, 'gi'))].length : 0;
    const hasRateWording = RATE_WORDING.test(span.text);
    const supportedCandidate = Boolean(rateMatch) && percentMatches.length === 1 && hasSinglePpfIdentity
      && !unsupportedSemantics && rateCount === 1 && hasRateWording
      && isExactCurrentPpfRateStatement(span.text, Number(numericText));
    const claimId = stableClaimId(inputHash, span.start, span.end, claims.length);

    claims.push({
      claimId,
      originalSpan: span.text,
      startOffset: span.start,
      endOffset: span.end,
      claimType: supportedCandidate ? 'CURRENT_NOMINAL_RATE' : 'UNSUPPORTED',
      productId: supportedCandidate ? GENIEPROOF_SUPPORTED_PRODUCT_ID : null,
      value: numericText == null ? null : Number(numericText),
      unit: numericText == null ? 'UNKNOWN' : 'PERCENT_PER_ANNUM',
      interpretation: supportedCandidate
        ? 'The official current nominal annual interest rate for the exact PPF scheme.'
        : null,
      candidateReasonCodes: supportedCandidate
        ? []
        : [
          ...(hasSinglePpfIdentity ? [] : ['EXACT_SUPPORTED_PRODUCT_IDENTITY_MISSING']),
          ...(unsupportedSemantics ? ['CLAIM_CONTAINS_UNSUPPORTED_OR_MIXED_SEMANTICS'] : []),
          ...(rateCount !== 1 ? ['CLAIM_CONTAINS_AMBIGUOUS_RATE_COUNT'] : []),
          ...(!hasRateWording ? ['RATE_ASSERTION_WORDING_MISSING'] : []),
          ...(!isExactCurrentPpfRateStatement(span.text, Number(numericText)) ? ['CLAIM_NOT_EXACT_CURRENT_RATE_STATEMENT'] : []),
          ...(!rateMatch ? ['CLAIM_CLASS_NOT_SUPPORTED_BY_EXTRACTOR'] : []),
        ],
    });
  }

  return {
    ok: true,
    inputHash,
    extractionVersion: 'genieproof-deterministic-extractor/0.4.0',
    claims,
    claimsTruncated: omittedClaimCount > 0,
    omittedClaimCount,
    requiresCustomerConfirmation: true,
    rawOfferRetained: false,
  };
}

function validateEvidenceRevision(evidence, { signatureVerifier, now, requireBoundedEffectivePeriod }) {
  if (!evidence || typeof evidence !== 'object' || !signatureVerifier?.verifySignedManifest) {
    return { valid: false, reason: 'EVIDENCE_ATTESTATION_UNAVAILABLE' };
  }
  const fact = evidence.fact;
  const factHash = buildGenieProofEvidenceFactHash(fact);
  if (factHash !== evidence.factHash) return { valid: false, reason: 'EVIDENCE_FACT_HASH_MISMATCH' };
  const payload = buildGenieProofEvidenceAttestationPayload(evidence);
  if (canonicalSha256(payload) !== canonicalSha256(evidence.attestation?.manifest || null)) {
    return { valid: false, reason: 'EVIDENCE_ATTESTATION_BINDING_MISMATCH' };
  }
  const signature = signatureVerifier.verifySignedManifest(evidence.attestation);
  if (!signature.valid || !signature.trustedIssuer) {
    return { valid: false, reason: 'EVIDENCE_ATTESTATION_SIGNATURE_INVALID' };
  }
  if (!/^[a-z0-9][a-z0-9._:-]{1,119}$/.test(evidence.evidenceId || '')
      || !Number.isSafeInteger(evidence.revision) || evidence.revision < 1
      || !/^[a-z0-9][a-z0-9._:-]{1,119}$/.test(evidence.sourceId || '')
      || !Number.isSafeInteger(evidence.sourceRevision) || evidence.sourceRevision < 1
      || !/^[a-f0-9]{64}$/.test(evidence.sourceDefinitionHash || '')
      || !/^[a-f0-9]{64}$/.test(evidence.sourceContentCommitment || '')
      || !Array.isArray(evidence.retrievalIds) || evidence.retrievalIds.length < 1
      || evidence.retrievalIds.some(id => !/^[0-9a-f-]{36}$/i.test(id))
      || !Array.isArray(evidence.retrievalReceiptHashes) || evidence.retrievalReceiptHashes.length < 1
      || evidence.retrievalReceiptHashes.some(hash => !/^[a-f0-9]{64}$/.test(hash))
      || evidence.parserVersion !== GENIEPROOF_PPF_PARSER_VERSION
      || evidence.ruleVersion !== GENIEPROOF_PPF_RATE_RULE_VERSION
      || typeof fact?.productId !== 'string' || !fact.productId
      || typeof fact?.claimType !== 'string' || !fact.claimType
      || typeof fact?.value !== 'number' || !Number.isFinite(fact.value)
      || fact?.unit !== 'PERCENT_PER_ANNUM') {
    return { valid: false, reason: 'EVIDENCE_BINDING_INVALID' };
  }
  const retrievedAt = Date.parse(evidence.retrievedAt);
  const effectiveFrom = Date.parse(fact?.effectiveFrom);
  const effectiveTo = fact?.effectiveTo == null ? null : Date.parse(fact.effectiveTo);
  const assessedAt = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(retrievedAt) || !Number.isFinite(effectiveFrom) || !Number.isFinite(assessedAt)
      || (requireBoundedEffectivePeriod && effectiveTo === null)
      || (effectiveTo !== null && (!Number.isFinite(effectiveTo) || effectiveTo < effectiveFrom))) {
    return { valid: false, reason: 'EVIDENCE_EFFECTIVE_PERIOD_INVALID' };
  }
  return { valid: true, fact, retrievedAt, effectiveFrom, effectiveTo, assessedAt };
}

function evidenceBoundFinding(claim, {
  evidenceRevisions = [],
  signatureVerifier = null,
  now = new Date(),
  verifierVersion = GENIEPROOF_EVIDENCE_VERIFIER_VERSION,
} = {}) {
  const base = {
    claimId: claim?.claimId || null,
    claimHash: canonicalSha256(claim || null),
    claimType: claim?.claimType || 'UNSUPPORTED',
    confirmedInterpretation: typeof claim?.statement === 'string' ? claim.statement : null,
    productId: claim?.productId || null,
    exactProductBinding: claim?.productId || null,
    finding: 'NOT_VERIFIABLE',
    reasonCodes: [],
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    conditions: [],
    applicabilityConditions: [],
    missingConditions: [],
    missingFacts: [],
    effectiveTime: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    effectivePeriodBinding: null,
    freshness: 'UNKNOWN',
    ruleVersion: GENIEPROOF_PPF_RATE_RULE_VERSION,
    verifierVersion,
    explanation: 'This claim could not be checked against all required product-specific evidence.',
  };
  if (claim?.claimType !== 'CURRENT_NOMINAL_RATE') {
    return { ...base, finding: 'OUT_OF_SCOPE', reasonCodes: ['CLAIM_TYPE_NOT_SUPPORTED'], explanation: 'This claim type is outside the currently implemented evidence-bound verifier.' };
  }
  if (claim?.productId !== GENIEPROOF_SUPPORTED_PRODUCT_ID || claim?.unit !== 'PERCENT_PER_ANNUM'
      || typeof claim?.value !== 'number' || !Number.isFinite(claim.value) || claim.value <= 0
      || typeof claim?.statement !== 'string' || containsUnsupportedClaimSemantics(claim.statement, verifierVersion)
      || (verifierVersion === GENIEPROOF_EVIDENCE_VERIFIER_VERSION
        && !isExactCurrentPpfRateStatement(claim.statement, claim.value))) {
    return {
      ...base,
      finding: 'INSUFFICIENT_INPUTS',
      reasonCodes: ['CLAIM_IDENTITY_OR_SEMANTICS_NOT_EXACT'],
      missingFacts: ['A single current nominal annual PPF rate with exact product identity.'],
    };
  }
  const statementRates = [...claim.statement.matchAll(new RegExp(PERCENT_PER_ANNUM.source, 'gi'))];
  const statementProducts = [...claim.statement.matchAll(PPF_IDENTITY)];
  if (!RATE_WORDING.test(claim.statement) || statementRates.length !== 1 || statementProducts.length !== 1
      || Number(statementRates[0][1] || statementRates[0][2]) !== Number(claim.value)
      || (verifierVersion === GENIEPROOF_EVIDENCE_VERIFIER_VERSION
        && !isExactCurrentPpfRateStatement(claim.statement, claim.value))) {
    return { ...base, finding: 'INSUFFICIENT_INPUTS', reasonCodes: ['CONFIRMED_INTERPRETATION_DOES_NOT_MATCH_CLAIM_TEXT'] };
  }
  const candidates = Array.isArray(evidenceRevisions) ? evidenceRevisions : [];
  if (!candidates.length) {
    return {
      ...base,
      reasonCodes: ['QUALIFIED_FINANCIAL_EVIDENCE_UNAVAILABLE'],
      missingConditions: [
        'A current immutable source-to-fact evidence revision for the exact PPF scheme.',
        'User-presentation source qualification and reviewed source-reuse permission.',
      ],
      explanation: 'No current qualified, permitted financial evidence revision is available, so this assessment abstains.',
    };
  }

  const checked = candidates.map(evidence => ({ evidence, check: validateEvidenceRevision(evidence, {
    signatureVerifier,
    now,
    requireBoundedEffectivePeriod: verifierVersion === GENIEPROOF_EVIDENCE_VERIFIER_VERSION,
  }) }));
  const mismatchedProduct = checked.some(({ check }) => check.valid
    && (check.fact.productId !== claim.productId || check.fact.claimType !== claim.claimType));
  if (mismatchedProduct) {
    return { ...base, reasonCodes: ['EVIDENCE_PRODUCT_OR_CLAIM_BINDING_MISMATCH'], explanation: 'The available evidence does not bind to the exact claimed product and claim type.' };
  }
  const blocked = checked.filter(({ evidence }) => evidence.sourceQualificationAtAssessment !== 'QUALIFIED_FOR_USER_PRESENTATION'
    || evidence.reusePermissionAtAssessment !== 'APPROVED');
  const revoked = checked.some(({ evidence }) => evidence.revocationStatus !== 'ACTIVE');
  if (revoked) return { ...base, reasonCodes: ['EVIDENCE_REVOKED'], explanation: 'The evidence has been revoked and cannot support a current finding.' };
  if (blocked.length) {
    return { ...base, reasonCodes: ['SOURCE_NOT_QUALIFIED_FOR_USER_PRESENTATION'], explanation: 'The source is not qualified and permitted for a user-facing financial finding.' };
  }
  const invalid = checked.filter(item => !item.check.valid);
  if (invalid.length) {
    return { ...base, reasonCodes: [...new Set(invalid.map(item => item.check.reason))], explanation: 'The source-to-fact attestation could not be verified.' };
  }
  const applicable = checked.filter(({ evidence, check }) => {
    if (evidence.freshnessStatus !== 'FRESH') return false;
    return check.effectiveFrom <= check.assessedAt
      && (check.effectiveTo === null || check.assessedAt <= check.effectiveTo);
  });
  if (!applicable.length) {
    const expiredEvidence = checked.some(({ check }) => check.valid
      && check.effectiveTo !== null && check.assessedAt > check.effectiveTo);
    return {
      ...base,
      finding: expiredEvidence || checked.some(({ evidence }) => evidence.freshnessStatus === 'STALE') ? 'OUTDATED_EVIDENCE' : 'NOT_VERIFIABLE',
      reasonCodes: ['NO_CURRENT_APPLICABLE_EVIDENCE'],
      explanation: 'The available evidence does not cover the effective date of this current-rate question.',
    };
  }
  const observedValues = new Set(applicable.map(({ check }) => check.fact.value));
  if (observedValues.size !== 1) {
    return {
      ...base,
      reasonCodes: ['QUALIFIED_SOURCE_CONFLICT'],
      evidence: { factHash: canonicalSha256(applicable.map(({ evidence }) => evidence.factHash).sort()), revisions: applicable.map(({ evidence }) => evidence) },
      explanation: 'Qualified sources disagree on the applicable financial fact, so the verifier abstains.',
    };
  }
  const selected = applicable.map(({ evidence, check }) => ({ evidence, check }))
    .sort((a, b) => `${a.evidence.sourceId}:${a.evidence.revision}`.localeCompare(`${b.evidence.sourceId}:${b.evidence.revision}`));
  const observedValue = selected[0].check.fact.value;
  const matched = observedValue === claim.value;
  const evidenceSnapshots = selected.map(({ evidence, check }) => ({
    evidenceId: evidence.evidenceId,
    revision: evidence.revision,
    sourceId: evidence.sourceId,
    sourceRevision: evidence.sourceRevision,
    sourceDefinitionHash: evidence.sourceDefinitionHash,
    retrievalIds: evidence.retrievalIds,
    retrievalReceiptHashes: evidence.retrievalReceiptHashes,
    publicationAt: evidence.publicationAt || null,
    retrievedAt: evidence.retrievedAt,
    sourceContentCommitment: evidence.sourceContentCommitment,
    sourceQualificationAtAssessment: evidence.sourceQualificationAtAssessment,
    reusePermissionAtAssessment: evidence.reusePermissionAtAssessment,
    freshnessStatus: evidence.freshnessStatus,
    revocationStatus: evidence.revocationStatus,
    fact: evidence.fact,
    parserVersion: evidence.parserVersion,
    ruleVersion: evidence.ruleVersion,
    sourceLineage: evidence.sourceLineage,
    supersedes: evidence.supersedes || null,
    factHash: evidence.factHash,
    attestation: evidence.attestation,
    effectiveFrom: new Date(check.effectiveFrom).toISOString(),
    effectiveTo: check.effectiveTo === null ? null : new Date(check.effectiveTo).toISOString(),
  }));
  return {
    ...base,
    finding: matched ? 'SUPPORTED' : 'CONTRADICTED',
    reasonCodes: [matched ? 'EXACT_CURRENT_RATE_MATCH' : 'EXACT_CURRENT_RATE_MISMATCH'],
    supportingEvidenceIds: matched ? evidenceSnapshots.map(item => `${item.evidenceId}:${item.revision}`) : [],
    contradictingEvidenceIds: matched ? [] : evidenceSnapshots.map(item => `${item.evidenceId}:${item.revision}`),
    conditions: [...new Set(evidenceSnapshots.flatMap(item => item.fact.conditions || []))],
    applicabilityConditions: [...new Set(evidenceSnapshots.flatMap(item => item.fact.conditions || []))],
    effectivePeriodBinding: { effectiveFrom: evidenceSnapshots[0].effectiveFrom, effectiveTo: evidenceSnapshots[0].effectiveTo },
    freshness: 'FRESH',
    evidence: { factHash: canonicalSha256(evidenceSnapshots.map(item => item.factHash).sort()), revisions: evidenceSnapshots },
    explanation: matched
      ? 'The stated rate matches the exact product-specific source fact for the assessment date.'
      : 'The stated rate differs from the exact product-specific source fact for the assessment date.',
  };
}

export function verifyConfirmedGenieProofClaim(claim, {
  verifierVersion = GENIEPROOF_VERIFIER_VERSION,
  evidenceRevisions = [],
  signatureVerifier = null,
  now = new Date(),
} = {}) {
  if (isGenieProofEvidenceVerifierVersion(verifierVersion)) {
    return evidenceBoundFinding(claim, { evidenceRevisions, signatureVerifier, now, verifierVersion });
  }
  const version = GENIEPROOF_SUPPORTED_VERIFIER_VERSIONS.includes(verifierVersion)
    ? verifierVersion : GENIEPROOF_VERIFIER_VERSION;
  const base = {
    claimId: claim?.claimId || null,
    claimHash: canonicalSha256(claim || null),
    claimType: claim?.claimType || 'UNSUPPORTED',
    productId: claim?.productId || null,
    finding: 'NOT_VERIFIABLE',
    reasonCodes: [],
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    conditions: [],
    missingConditions: [],
    effectiveTime: null,
    freshness: 'UNKNOWN',
    verifierVersion: version,
    explanation: 'This claim could not be checked against all required product-specific evidence.',
  };
  if (claim?.claimType !== 'CURRENT_NOMINAL_RATE') {
    return { ...base, finding: 'OUT_OF_SCOPE', reasonCodes: ['CLAIM_TYPE_NOT_SUPPORTED'], explanation: 'This claim type is outside the current narrow GenieProof prototype.' };
  }
  if (claim?.productId !== GENIEPROOF_SUPPORTED_PRODUCT_ID || claim?.unit !== 'PERCENT_PER_ANNUM'
      || typeof claim?.value !== 'number' || !Number.isFinite(claim.value) || claim.value <= 0
      || typeof claim?.statement !== 'string' || containsUnsupportedClaimSemantics(claim.statement, version)
      || (version === GENIEPROOF_VERIFIER_VERSION && !isExactCurrentPpfRateStatement(claim.statement, claim.value))) {
    return {
      ...base,
      finding: 'INSUFFICIENT_INPUTS',
      reasonCodes: ['CLAIM_IDENTITY_OR_SEMANTICS_NOT_EXACT'],
      missingConditions: ['A single current nominal annual PPF rate statement with no additional guarantee, tax, maturity, or suitability assertion.'],
    };
  }
  const statementRates = [...claim.statement.matchAll(new RegExp(PERCENT_PER_ANNUM.source, 'gi'))];
  const statementProducts = [...claim.statement.matchAll(PPF_IDENTITY)];
  if (!RATE_WORDING.test(claim.statement) || statementRates.length !== 1 || statementProducts.length !== 1
      || Number(statementRates[0][1] || statementRates[0][2]) !== Number(claim.value)) {
    return {
      ...base,
      finding: 'INSUFFICIENT_INPUTS',
      reasonCodes: ['CONFIRMED_INTERPRETATION_DOES_NOT_MATCH_CLAIM_TEXT'],
      missingConditions: ['The confirmed text must state one PPF nominal annual rate matching the structured value.'],
    };
  }
  return {
    ...base,
    finding: 'NOT_VERIFIABLE',
    reasonCodes: ['TRUSTED_SOURCE_ATTESTATION_PIPELINE_UNAVAILABLE'],
    missingConditions: [
      'A qualified source fetcher that cryptographically binds the official source bytes, parser output, exact product fact, and retrieval time.',
      'Reviewed source-reuse permission for user-facing financial claim checks.',
    ],
    explanation: 'No qualified source-attestation pipeline and reviewed reuse permission are configured, so no positive or negative source-based verdict can be issued.',
  };
}

export function buildGenieProofManifest({
  caseId,
  ownerId,
  submissionHash,
  confirmedClaims,
  findings,
  revision,
  previousManifestHash = null,
  assessedAt = new Date().toISOString(),
  verifierVersion = GENIEPROOF_VERIFIER_VERSION,
  evidenceRegistrySnapshotHash = null,
}) {
  if (!/^[a-f0-9]{64}$/i.test(submissionHash || '') || !Array.isArray(confirmedClaims) || !Array.isArray(findings)) {
    throw new TypeError('GenieProof manifest requires a submission hash, confirmed claims, and findings.');
  }
  if (!GENIEPROOF_SUPPORTED_VERIFIER_VERSIONS.includes(verifierVersion)) {
    throw new TypeError('GenieProof manifest requires a supported verifier version.');
  }
  const normalizedClaims = confirmedClaims.map(claim => ({ ...claim })).sort((a, b) => a.claimId.localeCompare(b.claimId));
  const normalizedFindings = findings.map(finding => ({ ...finding })).sort((a, b) => a.claimId.localeCompare(b.claimId));
  const evidenceRevisionHashes = evidenceRevisionHashesFromFindings(normalizedFindings);
  const evidenceBound = isGenieProofEvidenceVerifierVersion(verifierVersion);
  if (evidenceBound && evidenceRegistrySnapshotHash !== null
      && !/^[a-f0-9]{64}$/.test(evidenceRegistrySnapshotHash)) {
    throw new TypeError('GenieProof evidence-bound manifests require a registry snapshot hash.');
  }
  const manifest = {
    schemaVersion: genieProofManifestVersionForVerifier(verifierVersion),
    caseId,
    ownerBindingHash: canonicalSha256([String(caseId), String(ownerId)]),
    revision,
    submissionHash,
    confirmedClaimsHash: canonicalSha256(normalizedClaims),
    confirmedClaims: normalizedClaims,
    productIdentityHash: canonicalSha256(normalizedClaims.map(claim => ({ claimId: claim.claimId, productId: claim.productId })).sort((a, b) => a.claimId.localeCompare(b.claimId))),
    evidenceRevisionHashes,
    policyVersion: verifierVersion,
    verifierVersion,
    findings: normalizedFindings,
    assessedAt,
    previousManifestHash,
    ...(evidenceBound ? { evidenceRegistrySnapshotHash: evidenceRegistrySnapshotHash || canonicalSha256([]) } : {}),
  };
  return { manifest, manifestHash: canonicalSha256(manifest), canonicalManifest: canonicalJson(manifest) };
}
