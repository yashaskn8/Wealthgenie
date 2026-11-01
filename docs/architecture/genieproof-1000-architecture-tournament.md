# GenieProof architecture tournament and adversarial milestone

**Decision date:** 2026-11-01  
**Branch:** `main`  
**Status:** selected architecture implemented as an incremental, backward-compatible GenieProof improvement; not a release authorization or legal source-rights approval.

## Problem

A correct, dated PPF rate statement was previously shown as generic "Not verified", even though the parser rejected it for being dated and no production-qualified evidence source was available. The experience collapsed (1) out-of-scope syntax, (2) unavailable evidence and (3) unsupported promises into the same unhelpful explanation. Generative advice can assist with follow-up research but must not be an evidentiary adjudicator.

## Tournament method

`server/agents/genieProof/genieProofArchitectureTournament.js` enumerates **10 evidence backbones × 10 data lifecycles × 10 user experiences = 1,000 distinct design configurations**. This is a reproducible *architecture design-space comparison*, not 1,000 independently built systems, live attack engagements, measured accuracy evaluations, or empirical benchmarks. All combinations are evaluated with immutable declared characteristics.

### Hard disqualification gates

Any failure rejects the entire configuration, irrespective of its numerical score:

1. Official-source licensing and user-presentation rights gate.
2. Signed / authenticated evidence lineage.
3. Bounded freshness and effective-date applicability.
4. Fail-closed abstention on uncertainty, no evidence, or invalid data.
5. No LLM-written financial truth verdict or AI override.
6. Explicit consent plus data minimization; no unsolicited raw-claim storage.
7. Transparent distinction between "not checked" and "disproved."

Survivors receive a transparent ordinal engineering score (not a measured probability): safety 35%, explanatory clarity 20%, privacy 15%, accessibility 10%, evidence operating simplicity 10%, data operating simplicity 5%, evidence latency 5%. Stable ID breaks ties. Each score is in [0,100]. Reproducible expected result: **1,000 evaluated, 100 survive, 900 rejected**; winner:

`signed_attested_rules::ephemeral_minimal_no_account_record::scope_first_reason_coded_triage`

## Chosen architecture

```text
User-provided financial statement
        |
        v
Client-side identifier / size screening (advisory)
        |
        v
Strict server-side PII + 16KB + claim count checks
        |
        v
Deterministic candidate extraction
        |
        +-- Outside precise scope ---> typed non-evidentiary abstention
        |                             (date / wording / product / mixed promise)
        |
        +-- Exact current PPF rate --> trusted verifier present?
                                        |
                                      No ---> abstain: evidence gate unavailable
                                        |
                                      Yes
                                        v
                      approved source + attested fact + rights + freshness
                                        |
                            fail any ---> abstain (reason)
                                        |
                            all pass ---> signed deterministic match/mismatch
                                        |
                                        v
                 Client validates exact source and response invariants
                                        |
                                        v
                  Plain-language explanation + official source *if qualified*
                                        |
                             Optional explicit user consent
                                        |
                                        v
                               NVIDIA next-step guidance
                               (never changes verdict)
```

The 2026 PPF nominal rate can also be displayed elsewhere from clearly labeled dated public research; that research does **not** activate or authorize the GenieProof evidence verifier.

## Security and availability boundaries

- **Production rights status:** Still blocked for official source redistribution. The app must return `NOT_VERIFIED` until signed official evidence satisfies existing legal, temporal, parser, and lineage constraints. Do not manufacture approval or make a positive verdict from a cached research table.
- **Mixed assertions:** A single accurate interest rate does not endorse guarantees, tax outcomes, redemption terms, or compounded returns.
- **Privacy:** Raw text is not saved by the claim check; disallowed identifiers are rejected before extraction; optional NVIDIA text transfer requires separate explicit user consent.
- **Presentation:** A date-specific claim reports a date-scope limitation. An exact current PPF rate with disabled verifier reports evidence unavailability. All unknown reason codes default to no conclusion.
- **Resilience:** Editing cancels any in-flight request and clears stale results. Client rejects forged positive verdicts, mismatch rates, stale timestamps, unexpected source identities, and cross-statement responses. The existing backend strict evidence signing flow is preserved.
- **Scope:** The current release changes only GenieProof claim triage, its local result explanations, scoped workbench styling, dedicated tests and documentation. It does not change financial recommendation services or other application UIs.

## Adversarial milestone

The reproducible milestone consists of:

1. Architecture tournament: 1,000 combinations, fail-closed safety constraints, and nine mutated high-scoring-but-unsafe designs that must remain rejected.
2. A synthetic corpus of 1,000 generated financial assertions that must never escalate to verification without approved evidence.
3. Targeted cases for unsupported date, wording, product, and compound promises; no PII echo, no unchecked third-party AI routing.
4. Existing signed source tests: forged manifests, stale/revoked source, ambiguous rate, source impersonation, synthetic lineage, and replay boundaries.
5. Client/browser tests: official source appears only after valid response, unsupported results cannot masquerade as supported, editing cancels stale findings, accessible example never auto-submits.
6. CI gates: `GenieProof Production Safety Gate` plus full repository `CI`. **Passing tests is necessary, not sufficient, for production release.**

**Release blockers:** independent India Post data-rights qualification, authorized current verified source receipts, operational monitoring, independent third-party penetration testing, and final product owner release review remain separate from code test success.

## External engineering references

- OWASP ASVS 5.0.0 (2025): https://asvs.owasp.org/
- NIST AI RMF 1.0 functions: https://airc.nist.gov/airmf-resources/airmf/5-sec-core/
- W3C WCAG 2.2 input error identification and assistance: https://www.w3.org/TR/wcag/

These references guide controls and user-experience requirements. They do not confer certification or certify the code.
