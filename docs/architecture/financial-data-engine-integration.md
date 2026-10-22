# MongoDB + PostgreSQL + Cashflow + Monte Carlo: integration contract

This document describes implemented code paths, **not a claim that external production data or investor-adviser approval already exists**.

## Authority and trust boundaries

**MongoDB** stores user-owned profiles, tax contexts, append-only purchase declarations, private valuations and versioned hypothetical computation runs. User identity is checked server-side before private reads and writes. Declared lots are not reconciled holdings after withdrawals or sales. Valuation snapshots have Mongo TTL and need the separate cross-database revocation prune job.

**PostgreSQL** stores discovery archetypes, source-identified actual products, provider rights, verified source-to-product instrument IDs, effective-dated product terms, and rights-qualified market observations. There are **250 discovery archetypes** but **not 250 actual products or 250 complete tax calculations**.

**Redis** provides transient rate limiting, caching and worker coordination; it is not the authoritative financial database.

**Two financial engines share rules:** a deterministic product cash-flow engine for source-qualified contractual schedules, and tax-aware Monte Carlo for declared hypothetical listed-equity cash flows. They do not override source licensing, real instrument identity, legal suitability, or unavailable tax policy years.

## New code paths

1. `server/postgres/registerActualProduct.js` registers a real product plus a source-specific instrument ID in one SQL transaction. Provider rights and official instrument identity must be independently qualified. Registration intentionally leaves `recommendation_eligible=false` and `qualified_tax_class=UNVERIFIED`.
2. `server/postgres/financialStore.js` exposes `qualifiedHistoricalPrices(productId, kind, sourceId)`, with exact source matching, retained observations, EOD-only data, financial product eligibility, evidence-backed listed-equity tax class, source approval, and correction exclusion. Nothing passes without the complete stored-data/derived-use rights gate.
3. `server/services/qualifiedHistoricalVolatility.js` measures observed historical NAV/price-change volatility. It refuses mixed instruments, stale/incomplete history, duplicate dates and suspicious unadjusted corporate-action jumps. Historical prices are **not** a guaranteed expected future return, a total-return series, or automatically split-adjusted market data.
4. `POST /api/tax-aware-simulation/equity-history-risk` requires a signed-in user, current owned MongoDB profile and matching tax context, explicit user-declared expected return, verified SQL history, and a post-simulation source-rights recheck. Its result is intentionally **ephemeral**; it must not become permanent MongoDB/Redis storage under an unverified retention grant. It does not endorse the instrument for investment.
5. `server/services/qualifiedPostgresCashflow.js` consumes actual products, qualified official `PUBLISHED_RATE` observations and independently recorded effective-dated product terms, restricted to exact India Post term deposits and NSC. Quotes or generic FD names cannot become deterministic contractual promises.
6. `POST /api/financial-universe/:productId/contract-cashflow` requires authentication, finance feature readiness, a qualified official rate and exact independent issuer terms. It accepts optional user-declared dated tax events, but tax calculations additionally require a product-specific evidenced `ORDINARY_INTEREST` classification. Unknown cash flows/tax years remain `UNAVAILABLE`.
7. `server/postgres/migrations/007_actual_product_tax_class.sql` requires explicit source evidence and review timestamps to qualify an actual security's statutory tax class. It leaves all imported products `UNVERIFIED` by default.
8. SQL migrations and catalog are ready only after the checksum-based SQL startup test; Mongo personal-finance routes additionally require correct persistence indexes. Neither storage license nor adviser compliance is inferred from passing CI.

## Real infrastructure deployment

Use the exact Supabase project URI only in `server/.env` or the runtime secret store; never commit the URI or credentials. The local IDE may be an older/wrong branch. The GitHub PR branch is `feature/financial-architecture-unified-20261022`.

In an **isolated clean checkout**, install locked dependencies and execute:
```bash
npm ci --prefix server
npm run finance:pg:migrate --prefix server
npm run finance:pg:seed --prefix server
npm run finance:mongo:migrate-indexes --prefix server
```

`finance:mongo:migrate-indexes` requires a separately configured **real MongoDB URI**, a suitable authorized deployment role, and a safe backup. Verify Mongo connectivity, transaction support, indexes, PostgreSQL TLS identity and migration count **before** enabling `FINANCIAL_POSTGRES_ENABLED=true` and the independent `FINANCIAL_ARCHITECTURE_ENABLED=true` switch. The frontend opts in separately.

The production runtime needs a scheduled, audited `finance:pg:prune` and `finance:mongo:prune-valuations` for retention and source revocation. PostgreSQL Free trial capacity must be monitored and backup/restores verified. See `docs/architecture/supabase-free-financial-trial.md`.

## Unresolved production blockers (do not silently bypass)

- Source licensing for persistent database retention, derived calculations, display and commercial distribution (the owner reported small-scale read/display permission but did **not** establish storage/derivation rights from the missing correspondence).
- Issuer-verified real products, EOD history and terms for each supported scheme; not every discovery archetype qualifies.
- Correct scheme-specific cashflows for products other than the explicitly implemented contracts; dividends, capital gains, STT, charges, losses, tax withholding and multiasset investor lot reconciliation require separate implementation.
- Independent statutory review of the 2025 Income-tax Act, Finance Act 2026, exemptions and later tax years; versioned deterministic reference tests.
- Staging with actual TLS-verified Supabase + replica-set MongoDB, restore rehearsal, load testing, provider revocation and model validation.
- SEBI classification, suitability and registrations as required by the deployed feature set.

## Local IDE handoff without losing uncommitted work

Do **not** run `git reset --hard`, `git clean -fd`, `git checkout --force`, `git pull --rebase` over uncommitted work, or `npm install --no-save pg`. The GitHub branch already pins `pg:8.16.3` in `server/package.json` and lockfile. Use a separate Git worktree tracking this feature branch, leaving the existing working tree and its untracked work untouched. Check `git remote -v` for `yashaskn8/Wealthgenie` first; never overwrite a real `.env` file. Only port over deliberate local changes after reviewing diffs and checking for secrets.
