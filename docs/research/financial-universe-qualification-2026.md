# WealthGenie — 250-entry recommendation qualification audit

Review date: 2026-10-22. Scope: the repository's 155 legacy investment families and 95 expanded discovery families. This document is a research-informed engineering control plan, **not** an assertion that any individual product is safe, registered, available, licensed for commercial redistribution, or appropriate for a particular investor.

## Reviewed evidence

- SEBI, *Master Circular for Investment Advisers* (2026-02-06): https://www.sebi.gov.in/legal/master-circulars/feb-2026/master-circular-for-investment-advisers_99569.html
- SEBI, *Investment Advisers Regulations* (2025-11-25): https://www.sebi.gov.in/legal/regulations/nov-2025/securities-and-exchange-board-of-india-investment-advisers-regulations-2013-and-securities-last-amended-on-november-25-2025-_98246.html
- SEBI Investor Education, Investment Advisors: https://investor.sebi.gov.in/investment_advisor.html
- SEBI Investor Education, Bonds: https://investor.sebi.gov.in/understanding_bonds.html
- SEBI, Mutual Funds Regulations 2026 (2026-07-07): https://www.sebi.gov.in/web/?file=https%3A%2F%2Fwww.sebi.gov.in%2Fsebi_data%2Fattachdocs%2Fjul-2026%2F1783933012694.pdf
- PFRDA, NPS All Citizen: https://pfrda.org.in/en/schemes/national-pension-system/nps-for-all-citizen-models
- PFRDA, Exits and Withdrawals (amended 2026-07-20): https://pfrda.org.in/w/pension-fund-regulatory-and-development-authority-exits-and-withdrawals-under-the-national-pension-system-regulations-2015-last-amended-on-20th-july-2026-. 

Sources are regulatory or education references **only**. A regulator's category page is not a licence to copy financial data nor proof that an individual product is valid. Recheck these authorities when product rules or law change.

## Release decision

**Not approved:** Automatically promoting all 95 discovery archetypes. Their manifest explicitly states `recordKind=ARCHETYPE`, `recommendationEligible=false`, `availability=UNVERIFIED`, and unavailable market/post-tax facts. A category or index strategy is not a source-identified investable security.

**Implemented:** The deterministic generation path assesses all 250 manifest identities as part of its qualification ledger. Existing legacy entries proceed through established suitability and ranking. Every unqualified extension is explicitly screened out with `ACTUAL_PRODUCT_QUALIFICATION_REQUIRED`, rather than being dropped invisibly. The selected shortlist ceiling increases from eight to ten; fewer than ten must be returned when appropriate.

## How to qualify each discovery family, without blanket approval

1. **Canonical identity:** Determine a *real*, currently investable product with issuer/AMC, regulator-relevant identifiers (ISIN, AMFI scheme code, NSE/BSE security identifier, bond issue reference, bank scheme or government savings rule where applicable), correct plan/option/class, and traceable family mapping. Review duplicate/missing identifiers.
2. **Issuer and instrument status:** Confirm the exact offering is open/available to the user, and classify its record as `ACTUAL_PRODUCT`. A generic index/strategy remains an archetype, even if official educational references describe it.
3. **Evidence and data rights:** Capture official issuer/AMC/market-provider URLs, timestamps, source licence, commercial derivation and redistribution permissions, expiry and retention periods. Reject when rights are insufficient. Provider availability is not permission to reuse.
4. **Investor eligibility and risk:** Obtain verifiable min/max age, residency or account constraints, income and contribution restrictions, lock-in and exit penalties, principal-loss/credit/interest-rate risks, liquidity and investment-horizon bounds. Preserve unknowns and reject when critical.
5. **Product-appropriate market facts:** For funds, qualified scheme-level NAV, SID/KIM and riskometer; for bonds, issuer, credit and issue terms, yield/coupon distinction, maturity and call terms; for government schemes, current published rate/effective period and restrictions; for NPS, tier-specific exit rules; for listed equities/ETFs/REITs, exchange identity, liquidity and risk. Do not treat historical returns as projections or guarantee returns.
6. **Model and tax separation:** Make expected returns clearly versioned *model assumptions* when justified; do not silently substitute NAV, YTM, coupon or a displayed price. Post-tax calculation requires a qualified product tax class, acquisition and investor inputs under fiscal-year policy. Missing tax evidence produces unavailable, not 0 or an invented number.
7. **Deterministic approval:** Register actual products in PostgreSQL using existing `registerQualifiedActualProduct` control (which **does not** itself enable recommendation eligibility); build and test a reviewed exact-product suitability/scoring adapter, verify concentration, goal fit, liquidity, data provenance and fail-closed removal on revoked data rights or stale evidence.
8. **Compliance review:** Confirm WealthGenie's actual advisory business model, SEBI registration/permissions or applicable exemption with qualified counsel before offering regulated personalized advice. Security, privacy, disclosures, audit trails, conflicts and client suitability need independent review.

## Audit checks for each family

At a minimum, record: family ID, actual product ID(s), identity source, verification timestamp, issuer/source URL, source rights and expiry, risk evidence, eligibility and liquidity terms, fee/cost evidence, tax-status policy, maturity/exit rules, numeric data class and provenance, exact reviewed mapping to the deterministic engine, approval owner, next review date, and an explicit outcome `UNQUALIFIED` / `QUALIFIED_FOR_SUITABILITY_CHECK` / `SUSPENDED`.

A family need not result in any recommended product. No default approvals. Never alter MongoDB saved portfolio state or PostgreSQL database contents solely to make counts reach 250.

## Important limitations

- Live PostgreSQL and MongoDB content were **not independently inspected** by this GitHub-only analysis. Runtime counts, per-profile results, deployment, provider rights and SEBI regulatory compliance remain **Not verified**.
- The 155 legacy categories already pass through internal suitability checks, but their membership alone is not evidence of a verified currently purchasable security. Passing a legacy score is **not** a regulatory suitability certification.
