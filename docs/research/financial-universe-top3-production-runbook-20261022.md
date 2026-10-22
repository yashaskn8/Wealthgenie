# WealthGenie — reviewed family-to-product top-three rollout

Status: **software implemented on main; live 750-product licensing/qualification and E2E deployment not established**. Product records start with no family approval; the UI correctly displays zero qualifying candidates.

## Operating model

1. Keep the 250 discovery-family IDs unchanged (155 legacy plus 95 new archetypes). They are **not** 250 verified financial instruments.
2. Product records need exact issuer/bank/AMC offer identification: issued scheme name and plan/option, fund manager/benchmark and ISIN where applicable; for government issues, unique issue/tenure/auction or scheme notification; for deposits, institution, term and interest-payment mode; for bonds, exact ISIN, redemption and issuer; and documented compatibility with the **specific family**, not just the broad category.
3. Financial source rights are separate. Operator must store actual provider evidence in `finance.provider_rights` with access, extraction, storage, derivation, public display, commercial use, redistribution, retention and expiry separately reviewed. Access to a public rate or regulator URL is **not** a data licence. Never set rights true without independent authorization.
4. Operator must use the already existing `registerQualifiedActualProduct` with its true source/identity, then establish tax class evidence in `finance.products`, and only then submit family review.
5. `server/postgres/qualifyFamilyProduct.js` performs a controlled SQL transaction with exact family/product/source pair, reviewer identity, three evidence URLs (product, terms, risk), risk classification, fee and investment limits, expiry, lock-in and eligibility flags. A regulator listing alone doesn't establish the specific scheme/issue's terms.
6. `finance.family_product_qualifications` records the approved link; DB trigger 010 refuses approval for archetype as purchasable actual product, mismatched category, missing authorized source or unverified tax class. Revoking rights, closing an offer, expiring review or suspending approval makes read-time comparison unavailable.
7. The authenticated profile-bound `POST /api/financial-universe/:familyId/top-products` never changes MongoDB portfolio allocations, and never returns more than 3. Missing demat/NPS/child/accreditation facts force exclusion. Use a separate legal review before enabling regulated personalized-investment-advice mode.
8. Rankings are *fit comparisons*, **not** total-return forecasts or tax recommendations. Annual fee, risk, minimum ticket and lock-in are surfaced with exact source timestamps. A family with fewer than 3 verified accessible products returns fewer—zero is a valid result.

## Database setup and operations

Run from `server/` with your actual authorized PostgreSQL connection:

```bash
npm ci
npm run finance:pg:migrate
npm run finance:pg:seed
npm run finance:top3:audit
```

The read-only `finance:top3:audit` output reports total archetypes, families with ≥3 preliminary source-eligible products and deficits; it explicitly does not certify personal suitability.

Reviews are a **separate restricted operator-only workflow**, not a user-facing button. After independent evidence and source-rights verification, prepare a strictly reviewed JSON array with `familyId`, `productId`, `sourceId`, `observationType`, `evidenceUrl`, `termsEvidenceUrl`, `riskEvidenceUrl`, `reviewedBy`, `reviewedAt`, `validUntil`, `riskLevel`, `minInvestmentInr`, `minHorizonYears`, `lockInMonths`, `annualFeeBps`, `minAge`, `maxAge`, `retailAccess`, investor account requirements, and `reviewNote`. Do **not** run from ordinary website request context.

```bash
FINANCE_QUALIFICATION_OPERATOR_CONFIRMED=yes npm run finance:top3:qualify -- /secure/reviewed-products.json --apply
npm run finance:top3:audit
```

Enabling `FINANCIAL_PERSONALIZED_ADVICE_ENABLED=true` requires verified business/regulatory authorization before production use. It does **not** itself provide such authorization. Also enable `FINANCIAL_POSTGRES_ENABLED=true`, valid `FINANCIAL_POSTGRES_URL`, and `FINANCIAL_ARCHITECTURE_ENABLED=true` with running MongoDB and latest migrations. Test both databases and the web UI in a deployment matching production before release.

## Acceptance requirements

- Database: ten applied migrations with expected hashes; 250 archetypes and 0 accidentally recommendable archetypes; actual product records clearly distinct.
- Source: real verifiable issuer identity; evidence still current; storage/display rights explicitly granted; no conflicting provider instrument; market observation retained and fresh; dated bank rates never treated as live exchange prices.
- Product: active subscription and min ticket, actual scheme/plan/ISIN, issuer document, costs, benchmark specificity, tax classification evidence. No product without investment facts can count towards the top three.
- Investor: authentic current profile and current recommendation/allocation pointer; age, horizon, risk, cash capacity, tax/product eligibility known. Unknown required account facts are not assumed.
- Safety: zero results for missing rights, stale facts, revoked licences, suspended/exhausted review, closed offer, non-current profile, or unavailable product. At most 3; never padded to 3.
- Test isolation: synthetic authorization fixture runs only on a PostgreSQL database name ending in `_test`, with `FINANCIAL_POSTGRES_TEST_MODE=true`. Synthetic fixtures **do not** establish 750 live-issuer eligibility.
- CI: frontend, backend, SQL migration/rights, security, and AI jobs must all finish green on the **same current commit**, plus manual deploy smoke tests with the actual databases. The GitHub push and a passing frontend build alone are not an E2E production certification.

## Source policy

SEBI Investment Advisers master circular (6 Feb 2026): https://www.sebi.gov.in/legal/master-circulars/feb-2026/master-circular-for-investment-advisers_99569.html

NSE Market Data Sharing & Usage Policy: https://www.nseindia.com/static/market-data/nse-data-policy

AMFI NAV official sources: https://www.amfiindia.com/net-asset-value/nav-download

Latest research queue: `docs/research/financial-universe-95-qualification-tracker.csv`.

**Not done / do not claim done:** independently verified bank/AMC/bond/provider-rights evidence for 750 distinct actual products, binding of actual issuers to every one of 250 strategies, live production PostgreSQL migration/seed, SEBI authorization, real-user E2E deployment, full green CI.
