# Supabase Free — WealthGenie financial-data trial

This guide deliberately does not require Gmail or a copy of any historical approval email.

## Purpose and boundaries

The project owner reported that an external party allowed reading and displaying data in a small-scale project, with no right to resell it. The relevant source/provider was not identified here, and the original correspondence is unavailable. Therefore:
- **Claimed scope:** personal/small-scale read + display, no resale. Record only as an operator-reported statement.
- **NOT established:** commercial redistribution, persistent database storage, bulk historical caching, derived post-tax calculations, general SaaS distribution or duration of a data grant.
- **Do not turn on** `finance.provider_rights.storage_allowed`, `derivation_allowed`, `commercial_use_allowed` or `redistribution_allowed` on this statement alone.
- SQL migration `006_permission_assertions.sql` records claimed scope without automatically approving any provider rights. The `finance.provider_rights` rights gate remains authoritative.
- Enforce user account authorization for private holdings; do not expose APIs for bulk market-data download or resale.

## Supabase Free capacity

Supabase currently lists **500 MB of database storage** and automatic pausing after approximately **7 days of inactivity**. Free should be treated as a small-scale development or proof-of-concept environment, **not a continuously available production database**.
Official: https://supabase.com/pricing and https://supabase.com/docs/guides/platform/free-project-pausing .

## Safe connection and trial deployment

1. Create a **Free** Supabase organization/project in the Indian region supported for your workload. Do not send credentials into chat or commit them in GitHub.
2. From **Connect**, copy the **Session pooler** connection string for a persistent IPv4-only Node server, or the Direct connection if your backend supports IPv6. Do not guess the pooler host. Use a dedicated least-privilege DB role for the app and a migration role for schema upgrades. Official: https://supabase.com/docs/guides/database/connecting-to-postgres .
3. Require verified TLS. On production deployments use **sslmode=verify-full** with the Supabase CA certificate loaded by the server. The certificate must be installed into the server trust store or configured using an explicitly trusted path. A plain `sslmode=require` offers encryption but does not fully verify identity.
4. In the backend secret manager, set:
   `FINANCIAL_POSTGRES_URL` = actual project connection string;
   `FINANCIAL_POSTGRES_ENABLED=true`;
   `FINANCIAL_POSTGRES_TRIAL_MODE=true`;
   `FINANCIAL_POSTGRES_MAX_BYTES=350000000` (leave ~150 MB of Free-tier database headroom).
5. In `server/`, run `npm ci`, then `npm run finance:pg:migrate`, then `npm run finance:pg:seed`. The seed reconciles **250 investment archetypes**; it does **not** import fabricated securities, NAVs, quotes, interest rates or an unsupported provider grant.
6. Verify `getFinancialPostgresPool()` readiness before serving requests. Startup verifies the full migration checksums and the catalog count. The PostgreSQL adapter will refuse market-observation inserts when a verified storage right is absent or the trial database budget is exhausted.
7. Leave `FINANCIAL_ARCHITECTURE_ENABLED=false` until MongoDB's unique indexes, retention TTL, user tax-context authorization, and broader engine integration are verified. The browser flags `VITE_FINANCIAL_POSTGRES_ENABLED` and `VITE_FINANCIAL_ARCHITECTURE_ENABLED` are independent opt-ins; they should only be enabled after their matching server gates are ready.
8. If a license later explicitly covers persistent storage, approved display and analytics, register the exact **provider + endpoint + instrument** and its allowable retention period in `finance.provider_rights` after independent verification. This does not mean reselling provider data. Run the rights-revocation prune jobs and verify their results.
9. Do not use the Free project as a durable financial ledger: Supabase Free lacks downloadable managed backups. Maintain secure, tested off-platform backups of data you are permitted to retain; restore validation is mandatory before a production service launch.

## Both financial engines

The deterministic cash-flow and Monte Carlo engines share WealthGenie's canonical tax authority. No market-data API supplies personal post-tax results by itself. They must be computed from verified user tax context, instrument classification, dated cash flows or simulated paths, and effective tax rules.

- **Deterministic cash-flow:** already supports a qualified scheduled ordinary-interest event extension; product-specific fixed income terms still require reliable issuer/product facts and explicit authorized source usage.
- **Monte Carlo:** currently supports a bounded user-declared equity lump-sum scenario with path-specific tax calculation, **not** a live-market-calibrated model across 250 options. Historical price points can support calibration only where storage and derived calculations are authorized and validated.
- Rates published by government schemes are effective-dated **published rates**, not live market prices.
- Unavailable input must yield `UNAVAILABLE` and a null result, never a guessed post-tax value.

## Explicit release checklist

- [ ] A real Supabase project is connected using server-held secrets.
- [ ] The source/provider in the owner's earlier permission is identified.
- [ ] Scope and duration of any permitted **storage and derived calculations** are confirmed.
- [ ] Real products and identities are qualified, rather than merely their archetypes.
- [ ] Correct current rules are implemented and independently verified for every claimed tax product class and year.
- [ ] Both financial engines reject source data whose rights, freshness, identity or tax rules cannot be established.
- [ ] CI + production staging integration, MongoDB index migrations, backup/restore and load tests pass.

**Do not interpret a passing CI job as proof of a licensed live data source.**
