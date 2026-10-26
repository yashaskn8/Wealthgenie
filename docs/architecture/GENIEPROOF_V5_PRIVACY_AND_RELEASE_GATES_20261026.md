# GenieProof V5 — production-safe claim check hardening

Date: 26 October 2026. Do **not** conflate read-only financial text checking
or deterministic scenario math with independent evidence qualification.

## Current launch status

The repository's `GENIEPROOF_STATUS.json` records
`IMPLEMENTED_VERIFIED_BLOCKED_PRODUCTION` and `BLOCKED_LEGAL`: no independently
verifiable Department of Posts source-reuse approval or legal qualification
is present. This release does NOT enable signed passports/ProofBreak, change
`GENIEPROOF_ENABLED`, add data providers, or claim rates are official.

The server now unconditionally suppresses production initialization of the
read-only signature verifier. Merely injecting Ed25519 public keys cannot
authorize public financial facts. Until a reviewed legal/evidence rights
gate replaces this precaution, PPF claim verdicts remain NOT_VERIFIED in
production; genuinely unsupported financial claims also remain NOT_VERIFIED.

## Defensive changes

- One cross-runtime pure sensitive-identifier detector, shared by the browser,
  server-side read-only claim verifier and opt-in NVIDIA guidance.
- Additional detection for grouped PAN, Aadhaar (including Devanagari/Kannada
  digits), bank/account numbers, common UPI/payment handles, labelled Indian
  mobile numbers, e-mail addresses and common invisible-character obfuscation.
- Both unsaved candidate extraction and locally consented signed-case
  persistence reject flagged identifiers **before** processing or creating
  Mongo transactions. Returned errors do not echo supplied identifiers.
- Real examples of user-facing rates and money are not converted to facts by
  this privacy gate. NVIDIA remains optional, explicit-consent and limited to
  review of server-validated candidates. All calculated SIP/EMI/lump-sum values
  remain hypothetical arithmetic from user-entered assumptions.

## Required proof before a financial-verification production launch

1. Legal determination and retained artifacts for the precise official
   financial data source, reuse permission, freshness and public display.
2. Separate cryptographic source provenance, verified effective dates,
   qualified issuer/product identity and revocation/rollback procedures.
3. Exact-SHA full CI, negative/positive claim regression suite, independent
   review of issuer data and current fiscal-year treatment where relevant.
4. Consent and third-party data-processing review, personal data retention
   and deletion, Indian-language privacy tests and accessibility tests.
5. A non-skipped cluster deployment smoke verification and monitored canary
   with an immediate disable path.

This patch is deliberately a production **safety** step, not permission to
activate research-only workflows.
