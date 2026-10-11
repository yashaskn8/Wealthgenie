import crypto from 'node:crypto';
import { canonicalJson, canonicalSha256 } from '../../utils/canonicalJson.js';

export const GENIEPROOF_VERIFIER_VERSION = 'genieproof-current-rate/0.1.0';
export const GENIEPROOF_MANIFEST_VERSION = 'genieproof-passport/0.1.0';
export const GENIEPROOF_MAX_SUBMISSION_BYTES = 16_000;
export const GENIEPROOF_MAX_CLAIMS = 10;
export const GENIEPROOF_SUPPORTED_PRODUCT_ID = 'government:india-post:ppf';

const UNSUPPORTED_SEMANTICS = /\b(?:guarantee(?:s|d)?|assured|maturity|tax(?:-free|able|ation)?|after\s+tax|post[- ]tax|withdraw(?:al|als)?|lock[- ]?in|liquid(?:ity)?|safe|risk|returns?|yield|eligible|eligibility|claim\s+now|buy|sell|invest\s+now|historical|previously|last\s+(?:year|quarter)|in\s+20\d{2}|was|were|will\s+be|expected|projected|not|isn't|wasn't|cannot|can't|fixed|remain(?:s|ed|ing)?|until|through\s+20\d{2}|next\s+(?:quarter|month|year|financial\s+year)|ignore\s+(?:all\s+)?instructions|system\s+prompt|assistant\s+tool|another\s+scheme|other\s+scheme|\band\b|\bor\b|versus|\bvs\b)\b/i;
const PERCENT_PER_ANNUM = /(?:\b(\d{1,2}(?:\.\d{1,4})?)\s*%\s*(?:p\.?\s*a\.?|per\s+annum|annually|annual(?:\s+rate)?)(?=$|[\s,;.!?])|\b(\d{1,2}(?:\.\d{1,4})?)\s*percent\s+per\s+annum\b)/i;
const PPF_IDENTITY = /\b(?:PPF|Public Provident Fund(?: Scheme)?)\b/gi;
const RATE_WORDING = /\b(?:rate|interest)\b/i;
const FINANCIAL_CLAIM_SIGNAL = /\b(?:interest\s+rate|returns?|yield|guarantee(?:d)?|assured|capital\s+(?:protection|guarantee)|deposit\s+insurance|lock[- ]?in|withdraw(?:al|als)|liquid(?:ity)?|minimum\s+investment|maximum\s+investment|NAV|net\s+asset\s+value|mutual\s+fund|historical\s+performance|historical\s+return|tax(?:-free|able|ation|\s+exemption)?|deduction|80C|112A|50AA|registered\s+with\s+(?:SEBI|RBI)|(?:SEBI|RBI)[- ]registered)\b/i;

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableClaimId(inputHash, start, end, index) {
  return sha256(`${inputHash}:${start}:${end}:${index}`).slice(0, 32);
}

function containsUnsupportedClaimSemantics(text) {
  return UNSUPPORTED_SEMANTICS.test(text) || /-\s*\d+(?:\.\d+)?\s*%/.test(text);
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
    if (!rateMatch && !FINANCIAL_CLAIM_SIGNAL.test(span.text)) continue;
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
    const supportedCandidate = Boolean(rateMatch) && hasSinglePpfIdentity && !unsupportedSemantics && rateCount === 1 && hasRateWording;
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
          ...(!rateMatch ? ['CLAIM_CLASS_NOT_SUPPORTED_BY_EXTRACTOR'] : []),
        ],
    });
  }

  return {
    ok: true,
    inputHash,
    extractionVersion: 'genieproof-deterministic-extractor/0.1.0',
    claims,
    claimsTruncated: omittedClaimCount > 0,
    omittedClaimCount,
    requiresCustomerConfirmation: true,
    rawOfferRetained: false,
  };
}

export function verifyConfirmedGenieProofClaim(claim) {
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
    verifierVersion: GENIEPROOF_VERIFIER_VERSION,
    explanation: 'This claim could not be checked against all required product-specific evidence.',
  };
  if (claim?.claimType !== 'CURRENT_NOMINAL_RATE') {
    return { ...base, finding: 'OUT_OF_SCOPE', reasonCodes: ['CLAIM_TYPE_NOT_SUPPORTED'], explanation: 'This claim type is outside the current narrow GenieProof prototype.' };
  }
  if (claim?.productId !== GENIEPROOF_SUPPORTED_PRODUCT_ID || claim?.unit !== 'PERCENT_PER_ANNUM'
      || typeof claim?.value !== 'number' || !Number.isFinite(claim.value) || claim.value <= 0
      || typeof claim?.statement !== 'string' || containsUnsupportedClaimSemantics(claim.statement)) {
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

export function buildGenieProofManifest({ caseId, ownerId, submissionHash, confirmedClaims, findings, revision, previousManifestHash = null, assessedAt = new Date().toISOString() }) {
  if (!/^[a-f0-9]{64}$/i.test(submissionHash || '') || !Array.isArray(confirmedClaims) || !Array.isArray(findings)) {
    throw new TypeError('GenieProof manifest requires a submission hash, confirmed claims, and findings.');
  }
  const normalizedClaims = confirmedClaims.map(claim => ({ ...claim })).sort((a, b) => a.claimId.localeCompare(b.claimId));
  const normalizedFindings = findings.map(finding => ({ ...finding })).sort((a, b) => a.claimId.localeCompare(b.claimId));
  const manifest = {
    schemaVersion: GENIEPROOF_MANIFEST_VERSION,
    caseId,
    ownerBindingHash: canonicalSha256([String(caseId), String(ownerId)]),
    revision,
    submissionHash,
    confirmedClaimsHash: canonicalSha256(normalizedClaims),
    confirmedClaims: normalizedClaims,
    productIdentityHash: canonicalSha256(normalizedClaims.map(claim => ({ claimId: claim.claimId, productId: claim.productId })).sort((a, b) => a.claimId.localeCompare(b.claimId))),
    evidenceRevisionHashes: [...new Set(normalizedFindings.flatMap(finding => finding.evidence ? [finding.evidence.factHash] : []))].sort(),
    policyVersion: GENIEPROOF_VERIFIER_VERSION,
    verifierVersion: GENIEPROOF_VERIFIER_VERSION,
    findings: normalizedFindings,
    assessedAt,
    previousManifestHash,
  };
  return { manifest, manifestHash: canonicalSha256(manifest), canonicalManifest: canonicalJson(manifest) };
}
