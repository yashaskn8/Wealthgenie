/**
 * Interpret unsupported claim scope without adjudicating its truth.
 * This is presentation metadata ONLY. It cannot turn an unsupported claim
 * into a supported one or supply an evidence-backed verdict.
 */
const MIXED_PROMISE = /\b(?:guarantee(?:d|s)?|assured|risk[- ]?free|tax[- ]?free|taxation|post[- ]tax|after[- ]tax|compound(?:ed|ing)?|credit(?:ed)?|double|maturity|withdraw(?:al)?|lock[- ]?in|future|remain(?:s)?|fixed|forever|will|expected|projected|approximately|about|around|may|might|if|whether|versus)\b/i;
const DATED_SCOPE = /\b(?:as\s+(?:of|at)|on\s+\d{1,2}\s+[a-z]+\s+20\d{2}|in\s+20\d{2}|for\s+(?:q[1-4]|the\s+quarter)|last\s+(?:year|quarter)|previously|historical)\b/i;
const PPF_SCOPE = /\b(?:ppf|public\s+provident\s+fund)\b/i;

export function triageUnsupportedGenieProofClaim(candidate) {
  const statement = candidate?.originalSpan;
  if (typeof statement !== 'string') {
    return { reasonCode:'CLAIM_NOT_SUPPORTED',
      explanation:'This statement cannot be checked by the available official evidence verifier.' };
  }
  if (!PPF_SCOPE.test(statement)) {
    return {
      reasonCode:'CLAIM_PRODUCT_OUTSIDE_SUPPORTED_SCOPE',
      explanation:'This checker has no approved official evidence path for this product or subject. No conclusion about the claim was reached.',
    };
  }
  if (MIXED_PROMISE.test(statement) || /\b(?:and|or)\b/i.test(statement)) {
    return {
      reasonCode:'CLAIM_MIXED_OR_PROMISSORY_SCOPE',
      explanation:'This statement includes conditions or promises beyond a current PPF interest-rate claim. None of those extra assertions has been verified.',
    };
  }
  if (DATED_SCOPE.test(statement) || /\b(?:\d{1,2}[./-]\d{1,2}[./-]20\d{2}|20\d{2}[./-]\d{1,2}[./-]\d{1,2})\b/.test(statement)) {
    return {
      reasonCode:'CLAIM_DATE_OUTSIDE_CURRENT_SCOPE',
      explanation:'This checker is limited to the current PPF interest rate, not statements with explicit historical or dated scope. The stated rate has not been checked.',
    };
  }
  return {
    reasonCode:'CLAIM_WORDING_OUTSIDE_SUPPORTED_SCOPE',
    explanation:'This wording is outside the checker’s narrowly defined current-rate syntax. Its truth has not been assessed. Use the supported wording only if it preserves the original claim’s meaning.',
  };
}
