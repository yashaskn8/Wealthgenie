# WealthGenie all-250 family verification — source-based audit contract

This audit is executed against the **250 discovery categories on main**.
It does **not** verify 250 investable securities or prove that any family has
two real suitable current products.

`npm run finance:catalog:verify --prefix server` emits a structured JSON report
with one row for each of 155 legacy and 95 extended family IDs.
`npm run finance:catalog:verify --prefix server -- --csv` emits a 250-row CSV.
The financial PostgreSQL CI job publishes both to the
`financial-catalog-250-verification` artifact on each main commit.

## What is independently checked against repository source

- Exact 155 + 95 counts, unique IDs and normalized names, known categories.
- Exactly 750 **empty** review slots (3 per family; no fictitious approvals).
- All 95 extended archetypes have verified source-category references,
  but all 95 explicitly declare no current security identity, available
  offer verification, commercial data-use rights, or suitability clearance.
- The legacy 155 are reference families with model assumptions, **not**
  provider-authenticated actual-product qualification records.
- No confidential approval document, screenshot, hash, or password is read
  by this audit.

The report's `actualProductIdentitiesApprovedByThisSource: 0` means **none
approved by the source inventory**. It does not imply that no corresponding
investment exists. `currentProductionQualifiedProducts: null` means that
the real production database was **not queried** by this source-only tool.

## Separate real-product gates

Actual production qualification must check product-level issuer/ISIN or scheme
identity, retail availability, investor eligibility, dated terms, risk,
fees, tax evidence, independently authenticated provider rights, a fresh
publishable market fact, and appropriate regulated-advice authorization.
The existing `finance:top3:audit` measures potential source-eligible
products in the configured Postgres database and produces an independent
`financial-top3-coverage-report` artifact. CI's isolated `*_test`
database only proves contract behavior, **not real-world rights or products**.

Never replace `null`/unverified with a guessed count, duplicate an
instrument to fill slots, or flip recommendation eligibility to meet 250.
