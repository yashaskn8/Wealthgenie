/**
 * Fixed local explanation catalog. No user text, provider claims, or AI output
 * is interpreted as evidence. These strings explain process, not truth.
 */
const DIAGNOSTICS = Object.freeze({
  CLAIM_PRODUCT_OUTSIDE_SUPPORTED_SCOPE: {
    heading:'Product or claim type not supported',
    detail:'This verifier currently handles only an exact current PPF rate statement. For other products, consult the official issuer and its dated terms.',
  },
  CLAIM_MIXED_OR_PROMISSORY_SCOPE: {
    heading:'Multiple promises in one statement',
    detail:'A rate, guarantee, tax treatment and future projection are different claims. Do not treat checking one number as confirming the others.',
  },
  CLAIM_DATE_OUTSIDE_CURRENT_SCOPE: {
    heading:'Date-specific statement not supported',
    detail:'The current-rate verifier does not certify historical or explicitly dated claims. Confirm the effective quarter from the original official publication.',
  },
  CLAIM_WORDING_OUTSIDE_SUPPORTED_SCOPE: {
    heading:'Wording outside the current checker',
    detail:'The checker accepts a narrow current PPF rate sentence. Do not change a provider’s promise into a different claim just to get a result.',
  },
  CLAIM_NOT_SUPPORTED: {
    heading:'Outside this verification scope',
    detail:'Only a current PPF interest-rate claim can enter the official evidence pipeline. Unsupported does not mean false.',
  },
  NO_TRUSTED_EVIDENCE_VERIFIER: {
    heading:'Evidence verifier unavailable',
    detail:'This statement is in the supported format, but an approved evidence verifier is not active. Even a correct number cannot be marked verified.',
  },
  NO_QUALIFIED_SOURCE: {
    heading:'Approved official source missing',
    detail:'The checker has no qualified, current source record for this statement. An unqualified public webpage is not proof of a completed check.',
  },
  EVIDENCE_TOO_OLD: {
    heading:'Evidence outside freshness limit',
    detail:'The available source record is too old for a current-rate verdict. Check the date and obtain a new authorized official observation.',
  },
  EVIDENCE_LOOKUP_UNAVAILABLE: {
    heading:'Official evidence service unavailable',
    detail:'The source lookup did not complete. No financial conclusion was issued.',
  },
  EVIDENCE_INCONCLUSIVE: {
    heading:'Evidence inconclusive',
    detail:'The verified evidence chain did not support a definitive match or mismatch. No conclusion about the rate was issued.',
  },
  EVIDENCE_CHECK_FAILED: {
    heading:'Evidence validation failed',
    detail:'The required checks did not pass. The statement remains unverified; do not infer that it is true or false.',
  },
  SOURCE_LINEAGE_NOT_VERIFIED: {
    heading:'Source lineage incomplete',
    detail:'The evidence was not securely tied to the official source and its recorded content. No trusted conclusion was issued.',
  },
  SYNTHETIC_EVIDENCE_REJECTED: {
    heading:'Test evidence rejected',
    detail:'Synthetic demonstration records are not a basis for live financial verification.',
  },
  SOURCE_IDENTITY_NOT_QUALIFIED: {
    heading:'Source identity not qualified',
    detail:'The evidence did not meet official source identity requirements.',
  },
});
const UNKNOWN = Object.freeze({
  heading:'Verification could not be completed',
  detail:'No qualified conclusion was reached. Confirm the original statement and its dates directly with the official source.',
});
export function genieProofResultPresentation(claim) {
  if (claim?.verdict === 'SUPPORTED') return {
    heading:'Exact statement supported',
    detail:'Only this individual rate statement, for the indicated period and source, was supported. This is not an endorsement of an investment.',
  };
  if (claim?.verdict === 'CONTRADICTED') return {
    heading:'Exact rate mismatch',
    detail:'Only the quoted nominal rate conflicts with the qualified official evidence. This is not a finding of fraud or a product-safety assessment.',
  };
  if (claim?.verdict !== 'NOT_VERIFIED') return UNKNOWN;
  return DIAGNOSTICS[claim.reasonCode] || UNKNOWN;
}
