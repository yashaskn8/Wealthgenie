# GenieProof — Claim-First Architecture and Red-Team Contract

## Scope
GenieProof's beginner-facing product is now a **read-only claim check**, not a passport creation workflow. The legacy signed-passport and ProofBreak source files/endpoints remain in the repository solely to avoid destructive migration or breaking existing saved-record access; the new screen does not invoke them. No existing user records are deleted.

## Execution path
1. The authenticated frontend submits text only on **Check claim** via `POST /api/genieproof/check`.
2. Backend applies the existing strict UTF-8 payload validation, authentication, rate limiting, and no-store header.
3. Deterministic extraction identifies up to ten exact statement spans. Inputs with more candidates are rejected, never silently truncated.
4. Unsupported and compound assertions return **Not verified**, with non-adjudicative wording cautions where applicable.
5. Currently the only evidentiary verification contract is the exact *current nominal annual PPF rate*. For this claim the backend consults the existing source/evidence registry, which permits only explicitly qualified, approved source definitions with bound retrieval receipts.
6. A public-key trust store, not a private signing key, verifies evidence attestations. The independent deterministic verifier enforces product, claim, date, parser, signature, effective-period, conditions, source agreement, and revocation constraints.
7. Evidence older than 72 hours, future-dated evidence, and synthetic/test-fixture lineage are rejected. Result status is **Supported**, **Contradicted**, or **Not verified**; positive/negative results include source, retrieved date, effective period, and exact comparison.
8. No case, passport, watch, revision, text storage, or signing happens in this flow.

## Current production blockers (do not override)
- **Not verified:** independent provider permission and technical qualification for the India Post source. Existing repository source candidates are marked blocked.
- **Not verified:** any live qualified source producing end-user positive/negative findings in production.
- Broader claims (bank FD rate tiers, mutual fund returns, insurance, guarantee, tax, government schemes, suitability) need separate versioned product-specific claim contracts and official qualified sources.
- Merely providing a signing key or setting a feature flag cannot solve source legal/technical constraints. Do not enable a synthetic fixture as a live source.
- The new UI is functional as an honest read-only triage and abstention surface, **not yet a production-grade general financial fact-checker**.

## Adversarial release gates
| Attack | Required behavior |
| --- | --- |
| Signed fake-source fact | Reject if source is unapproved or synthetic; signature alone does not imply truth |
| Replayed old fact labelled fresh | Reject records older than 72 hours |
| Multiple conflicting facts | Abstain, do not select a convenient rate |
| Product mismatch / unsupported claim | Not verified, never auto-correct claim identity |
| Invalid signature / revoked public key | Not verified |
| Missing DB / source / trust store | Not verified; no guess or invented quote |
| Eleven claims in one offer | Reject entire check; never hide the eleventh |
| HTML/prompt injection in user text | Treated as inert text by deterministic backend and React escaping |
| Accidental submission / retries | No persistence; POST is read-only, retries disabled, in-flight UI requests canceled |
| Wrong authenticated user | No saved-history access on the new endpoint; legacy API remains ownership checked |
| Lack of source rights | Do not fetch, store or present unqualified evidence as truth |
| Misleading headline | UI distinguishes inability to verify from a contradicted claim |

## Verification requirements
- Unit tests: supported exact rate and mismatch with in-process signed fixture; no trust; invalid/blocked/stale/revoked/future source; synthetic fixture; extraction overflow; unsupported wording; source failure.
- Frontend tests: default one-step UI, no passport flow, supported source link, malicious response rejection, byte limit, cancellation race, errors, no-claim abstention.
- CI and browser E2E: must be green on the exact PR head before merge. Prior passport browser tests need migration to the new UI before they can be considered coverage.
- Production qualification: explicit source-rights review, parser-to-official-publication binding, attestation verification on genuine source receipts, freshness checks, repeated live probes, policy approvals and independent adversarial review.

## Source ownership and future work
For additional types, implement independent claim contracts and source-specific qualified adapters, never a single LLM truth score. An LLM may extract candidate text in the future, but must never authorize a financial verdict. Preserve claim origin spans and source-to-fact provenance, use fail-closed deterministic comparison for the decision.

**Coverage semantics:** A successful check covers only financial statements detected by the deterministic extractor; it never certifies the full original text. `allExtractedCandidatesProcessed` means no detected candidate was truncated. The UI must disclose this limitation on every result.
