const CITATION_PATTERN = /\[E_[A-Z0-9_:-]+\]/g;
const URL_PATTERN = /https?:\/\/[^\s)\]}]+/gi;
const TOKEN_PATTERN = /\d[\d,]*(?:\.\d+)?|[\p{L}]+/gu;
const NEGATION_PATTERN = /\b(?:not|never|no|without|cannot|can't|isn't|aren't|doesn't|don't|won't|neither)\b/i;
const FINANCIAL_DIRECTIVE_PATTERNS = Object.freeze([
  /\b(?:i|we)\s+(?:recommend|suggest)\b/i,
  /\byou\s+(?:should|must|need to|ought to|could consider|may want to)\s+(?:buy|sell|invest|allocate|rebalance|switch|withdraw|deposit|choose|increase|decrease)\b/i,
  /\b(?:buy|sell|invest|allocate|rebalance|switch|withdraw|deposit)\s+(?:in|into|to)\s+(?:this|these|that|the|a|an|your)\b/i,
  /\bconsider\s+(?:buying|selling|investing|allocating|rebalancing|switching|withdrawing|depositing)\b/i,
  /\b(?:best|top|ideal|perfect|right|better|safer)\s+(?:investment|fund|product|option|choice|fit)\b/i,
  /\b(?:most\s+)?suitable\s+for\s+(?:you|your\s+(?:profile|goals|risk\s+tolerance))\b/i,
  /\b(?:this|that|the)\s+(?:investment|fund|product|option|choice)\s+(?:fits|suits)\s+(?:you|your\s+(?:profile|goals|risk\s+tolerance))\b/i,
]);
const GENERIC_TERMS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'about', 'available', 'be', 'been', 'being', 'by',
  'can', 'current', 'data', 'does', 'do', 'down', 'evidence', 'entry', 'entries', 'fact',
  'facts', 'financial', 'for', 'from', 'has', 'have', 'had', 'how', 'in', 'information',
  'into', 'is', 'it', 'its', 'less', 'may', 'more', 'not', 'of', 'on', 'or', 'our', 'per',
  'profile', 'record', 'recorded', 'reported', 'show', 'shown', 'snapshot', 'source', 'that',
  'the', 'their', 'there', 'these', 'this', 'those', 'to', 'under', 'unavailable', 'up', 'was',
  'were', 'what', 'when', 'where', 'which', 'will', 'with', 'you', 'your', 'backend',
  'authoritative', 'value', 'values', 'verified',
]);

function tokens(value) {
  return [...String(value || '').replace(CITATION_PATTERN, ' ').replace(URL_PATTERN, ' ').toLowerCase().matchAll(TOKEN_PATTERN)]
    .map(match => match[0].replace(/,/g, ''))
    .filter(token => /^\d/.test(token) || (token.length >= 3 && !GENERIC_TERMS.has(token)));
}

function evidenceDisplayText(entry) {
  if (typeof entry?.displayValue === 'string' && entry.displayValue.trim()) return entry.displayValue;
  if (typeof entry?.value === 'string' || typeof entry?.value === 'number') return String(entry.value);
  return '';
}

// Reviewed public pages and exact regulatory excerpts are cited only for their
// actual words. Token overlap is not enough: a model can otherwise reverse a
// claim while using the same source ID (citation laundering).
function isExtractivePublicClaim(claimText, entry) {
  if (!['EDUCATION', 'REGULATORY_REFERENCE'].includes(entry?.kind)) return true;
  const removeMarkers = value => String(value || '').replace(CITATION_PATTERN, ' ')
    .replace(/\s+/g, ' ').trim().replace(/[\s.!?;:]+$/g, '').toLowerCase();
  const statement = removeMarkers(claimText);
  const evidence = removeMarkers(evidenceDisplayText(entry));
  return statement.length >= 20 && evidence.includes(statement);
}

function hasTypedEvidenceBinding(claim, candidate, evidenceId) {
  const claimText = String(claim?.text || '').replace(/\s+/g, ' ').trim();
  return (candidate?.financialClaims || []).some(item => item?.evidenceId === evidenceId
    && typeof item.statement === 'string'
    && item.statement.replace(/\s+/g, ' ').trim() === claimText);
}


// A source ID and two shared terms must never turn the user's stated risk
// preference into the backend's stricter final suitability ceiling. Risk labels
// are checked by semantic field, not by proximity/token overlap alone.
function isStructuredRiskClaimSupported(claimText, entry) {
  if (entry?.id !== 'E_PROFILE_RISK' || entry?.kind !== 'SUITABILITY') return true;
  const text = String(claimText || '').replace(CITATION_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  if (/\b(?:actually|instead|rather than|however|or)\b/i.test(text)) return false;
  const checks = [
    { pattern: /\b(?:final\s+suitability\s+ceiling|final\s+risk|suitability\s+ceiling)\s+(?:is|:|=)\s+/gi,
      expected: entry.value?.finalSuitabilityRisk },
    { pattern: /\b(?:stated\s+)?risk\s+tolerance\s+(?:is|:|=)\s+/gi,
      expected: entry.value?.statedRiskTolerance },
  ];
  let assertions = 0;
  for (const { pattern, expected } of checks) {
    for (const match of text.matchAll(pattern)) {
      const actual = String(expected || '').trim().toLowerCase();
      const remainder = text.slice(match.index + match[0].length).toLowerCase();
      if (!actual || !remainder.startsWith(actual) || /[\p{L}\p{N}]/u.test(remainder.charAt(actual.length))) {
        return false;
      }
      assertions += 1;
    }
  }
  return assertions > 0;
}

function claimAnchoredToEvidence(claim, candidate, evidenceById) {
  const claimText = String(claim?.text || '');
  const claimTokens = new Set(tokens(claimText));
  for (const evidenceId of claim?.evidenceIds || []) {
    const entry = evidenceById.get(evidenceId);
    if (!entry || !isExtractivePublicClaim(claimText, entry)
        || !isStructuredRiskClaimSupported(claimText, entry)) continue;
    const evidenceText = evidenceDisplayText(entry);
    const anchors = new Set(tokens(evidenceText));
    // Word overlap alone can accept a sentence that reverses a cited fact.
    // Fail closed when the claim introduces a polarity marker absent from
    // the supporting display text.
    if (NEGATION_PATTERN.test(claimText) !== NEGATION_PATTERN.test(evidenceText)) continue;
    if (anchors.size === 0) {
      if (hasTypedEvidenceBinding(claim, candidate, evidenceId)) return true;
      continue;
    }
    const wordAnchors = [...anchors].filter(token => !/^\d/.test(token));
    const numericAnchors = [...anchors].filter(token => /^\d/.test(token));
    const requiredWordOverlap = wordAnchors.length >= 2 ? 2 : wordAnchors.length;
    const wordOverlap = wordAnchors.filter(token => claimTokens.has(token)).length;
    const numericOverlap = numericAnchors.some(token => claimTokens.has(token));
    if (requiredWordOverlap > 0 && wordOverlap >= requiredWordOverlap) return true;
    if (requiredWordOverlap === 0 && numericOverlap
        && hasTypedEvidenceBinding(claim, candidate, evidenceId)) return true;
  }
  return false;
}

/**
 * Adds a bounded completeness check without changing the financial grounding
 * validator. Every model-authored claim must state a fact anchored in at least
 * one cited evidence display value; evidence-existence boilerplate is rejected.
 */
export function validateGroundedExplanationCompleteness(candidate, packet) {
  if (!candidate || typeof candidate !== 'object' || !Array.isArray(candidate.claims) || candidate.claims.length === 0) {
    return { valid: false, errors: ['SEMANTIC_CONTENT_MISSING'] };
  }
  const evidenceById = new Map((packet?.entries || []).map(entry => [entry.id, entry]));
  const claimsAnchored = candidate.claims.every(claim => claimAnchoredToEvidence(claim, candidate, evidenceById));

  // The app appends the statutory disclosure to every answer. That source
  // cannot, by itself, establish that the user's actual question was
  // answered. Demand at least one cited, anchored, non-disclosure fact;
  // otherwise a legal notice can masquerade as a successful RAG answer.
  const substantiveIds = new Set([...evidenceById.values()]
    .filter(entry => entry.kind !== 'DISCLOSURE' && entry.id !== 'E_REGULATORY_NOTICE')
    .map(entry => entry.id));
  const citesSubstantiveFact = candidate.claims.some(claim =>
    Array.isArray(claim.evidenceIds) && claim.evidenceIds.some(id => substantiveIds.has(id)));
  return claimsAnchored && citesSubstantiveFact
    ? { valid: true, errors: [] }
    : { valid: false, errors: ['CLAIM_EVIDENCE_RELEVANCE_INSUFFICIENT'] };
}

/** The explainer may describe verified facts but may not issue investment instructions. */
export function validateGroundedExplanationPolicy(candidate) {
  const claims = Array.isArray(candidate?.claims) ? candidate.claims : [];
  const directiveFound = claims.some(claim => typeof claim?.text === 'string'
    && FINANCIAL_DIRECTIVE_PATTERNS.some(pattern => pattern.test(claim.text)));
  return directiveFound
    ? { valid: false, errors: ['UNAUTHORIZED_FINANCIAL_DIRECTIVE'] }
    : { valid: true, errors: [] };
}
