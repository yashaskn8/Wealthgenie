# Verified financial data and post-tax audit — 20 October 2026

Scope: the current `yashaskn8/Wealthgenie` code on `codex/live-market-storage`, based on `main` at `a39c0ca60d02866527baccf32fbbdc43e6d5e13a`. This is a source-and-test audit, not a production permission or tax-law sign-off. No credentials or provider payloads are recorded here.

## Current execution paths

| Path | Classification | Evidence and boundary |
| --- | --- | --- |
| Upstox V3 quote → private API → React | PARTIAL | `marketDataService.fetchPrivateMarketDemoData`, `marketQuotes.js`, and `PrivateMarketDataDemo.jsx` return an uncached, authenticated loopback preview. The exact ETF quote is displayed only beside its matching product and does not change ranking. A prior bounded live read returned an available but stale ETF observation. The isolated provider → Mongo → authenticated API → React browser test passed with a deterministic fixture; a genuine signed-in provider → React browser read has not been captured. |
| Upstox equity history → validation → MongoDB → retained read API | PARTIAL | `fetchQualifiedEquityHistory`, `QualifiedEquityHistoryStore`, and `marketDataAdmin.js` enforce exact identity, complete calendar coverage, rights, transaction-capable storage, and read-time rights checks. Storage is disabled until retention and downstream rights qualify. No production Upstox history is claimed stored. |
| Market refresh → canonical repository | PARTIAL | `marketDataRefresh.js` has bounded target, lease and persistence paths. Only RAW Upstox history targets are now accepted, matching the fetcher and API schema. `MarketDataRepository.js` writes a product/observation batch in one MongoDB transaction and preserves previously inserted observations on duplicate fetches. This does not establish one revision shared by recommendations, tax results and every provider store. |
| Product catalog → provider coverage → Where-to-Invest | PARTIAL | The generated `market_data_coverage.json` covers 155 catalog entries. It records source paths and unavailable states; it does not prove live availability. NIFTY 50 and India VIX are market context, never a substitute for an unrelated product's NAV, bank rate, bond yield or expected return. |
| Tax policy → model calculation → tax API → Post-Tax Analysis | PARTIAL | `taxEngine.js` has FY2025-26 and FY2026-27 policy versions. `postTaxCalculator.js` delegates to `taxEventProjectionEngine.js`; `tax.js` labels the batch as a separate modeled what-if and React checks its echoed inputs. The batch accepts model assumptions, not a durable observation revision. A complete independent legal and reference-case audit of all supported instruments remains outstanding. |
| Recommendation → product-specific post-tax evidence | PARTIAL | `RecommendationPipeline.js`, `productTaxAuthority.js`, and `postTaxCoverageMatrix.js` keep source-qualified product tax treatment separate from parent-category assumptions. The matrix reports 0 production-rights-qualified provider paths and 0 numeric production results eligible. |
| One immutable financial revision across recommendation, Plan Review, and tax | NOT VERIFIED | The current separate market observation, recommendation, and tax scenario contracts do not establish one atomic cross-feature observation/tax-context revision. Do not claim these screens share a single calculation snapshot. |

## Catalog and source coverage

The generated matrix in `server/data/postTaxCoverageMatrix.json` enumerates 155 catalog parents: Government 10, Gold 5, Retirement 5, Bank Deposits 24, Debt Mutual Funds 17, Equity Mutual Funds 45, ETFs 18, REITs/InvITs 7, Bonds/Debentures 7, Insurance-linked 3, Direct Equity 8, Other 6. It reports 45 qualified product discovery paths, all 45 blocked for production source use under the current rights register. The remaining categories have no qualified product path or are educational/unsupported. None of those statuses may be converted into a numeric quote or post-tax result by borrowing an Upstox benchmark.

The active Upstox registry has exact NIFTY 50, India VIX and Nifty 50 BeES ETF quote identities. Its local preview is ephemeral. AMFI, bank, government savings and RBI facts retain their own adapters and authority checks. The removed second-provider runtime is not a fallback. Existing historical database rows are not deleted; the active retained-history read query selects Upstox only.

## Rights and tax verification

`postTaxSourceRights.js` and `marketDataRights.js` continue to block storage, commercial display and redistribution without endpoint-specific scope. A successful read-only API response does not change these decisions. The [Income-tax Act, 2025](https://incometaxindia.gov.in/Documents/Act/Income-tax-Act-2025.pdf) establishes its general commencement on 1 April 2026. This check validates the policy transition date only; it does not independently validate every FY2026-27 slab, deduction, exemption, product classification or transitional rule in the implementation. No new tax rate is introduced by this change.

A bounded private Upstox probe on 20 October returned HTTP 200 with a qualified schema for benchmark quotes. The market-status endpoint remained blocked by the current source-rights register and was not called. The probe stored no provider payload. This establishes connectivity for the qualified quote endpoint only, not current ETF freshness, commercial rights or frontend live display.

## Confirmed repairs in this change

1. Removed the inactive second-provider adapter, routes, runtime flags and frontend panels while retaining historical evidence in Git and MongoDB.
2. Added a single exact-identity ETF to the private Upstox quote registry, with provider timestamp and freshness displayed as a last-traded educational preview.
3. Removed the dead adjusted-history selection from the React retained-history panel and scheduled target allowlist. The route, service and storage now consistently accept RAW input and preserve `UPSTOX_PROVIDER_NATIVE` output semantics.
4. Bound the private ETF preview to the current profile and provider response status; obsolete profile responses cannot appear beside a new profile's product card.
5. Restored admin authentication, source-rights, OpenAPI and deployment-wiring regression coverage after retiring provider-specific tests.
6. Made normalized provider observations insert-only under their unique provider/time identity. A changed value, metric or source reference at that identity now fails the write instead of rewriting prior evidence. Product and observation batches commit together in a MongoDB transaction; an older refresh cannot roll back newer catalog metadata.

## Persistence finding and repair boundary

**High — mixed or mutable market evidence.** Before this repair, a refetch of a nonquote provider observation used `$set`, allowing historical values and source metadata to change in place. Product and observation batches also wrote separately, so a later observation failure could leave a newer catalog row with the earlier observation set. A delayed older refresh could overwrite newer catalog metadata. The repository now uses insert-only provider-observation upserts, a monotonic product verification filter and a transaction for the real MongoDB model pair. The isolated replica-set test proves unchanged duplicate fetches retain the original first/last fetch timestamps, changed value or provenance conflicts roll back the catalog update, and older catalog snapshots are rejected. The previous observation remains queryable. Derived market-context snapshots still use their existing update behavior because policy output can change when another market fact updates at the same NIFTY timestamp; they need a separate revision identity before insert-only publication.

The normalized-content match covers the value, source URL, effective and publication dates, provider timestamp, unit, class and OHLC/volume metrics. Fetch time and computed freshness are excluded because they change on re-read. This is not a raw provider-payload digest, a globally versioned publication pointer, or an immutable product-catalog history. Those remain explicit design work. A transaction gives readers a consistent MongoDB commit boundary only when their reads use a suitable read concern/session; existing independent multi-query frontend flows are not yet one cross-feature snapshot.

## Verification performed

- This storage repair: the focused provider-observation, index-contract and replica-set Mongo suite passed 49/49, including duplicate ingest, changed value/source rollback and older snapshot rejection.
- Backend: `npm test --prefix server` — 2,033 passed, 0 failed after this storage repair.
- Frontend baseline at `a39c0ca`: `npm test --prefix reactapp` — 630 passed, 0 failed; the focused exact ETF card suite passed 66/66 after its final assertion was added. This storage repair did not change frontend files.
- Lint and typecheck: both packages exited 0; lint reported existing warnings and no errors.
- Frontend production build: passed.
- Coverage register: `npm run post-tax:coverage --prefix server` matched the catalog and provider registry.
- Browser: two isolated market-storage Playwright cases passed using installed Chrome and the local Vite server, including fixture provider → disposable Mongo → authenticated API → React, restart recovery and rights recheck, plus responsive provider-native chart rendering. They do not prove the signed-in live provider path.

## Dependency-ordered remaining work

1. **Permissions:** obtain exact Upstox commercial storage/display and applicable other-provider rights before enabling durable/public data use. Keep defaults disabled meanwhile.
2. **Observation design:** specify a typed, immutable observation/revision contract for each source and product class; preserve legacy reads and historical provenance. Prove atomic publication and no mixed revisions before migrations.
3. **Tax authority:** independently check each fiscal-year and product rule against the current official text, including effective dates and transitional cases; add independently calculated boundary fixtures. Keep unsupported outcomes unavailable.
4. **Cross-feature binding:** bind recommendation, product facts, tax context and scenario results to explicit revisions; reject stale mixed-revision reads in Plan Review, Where-to-Invest and Post-Tax Analysis.
5. **End-to-end qualification:** run rights-authorized isolated Mongo and browser journeys, then separately verify any permitted provider calls. No production-ready conclusion follows from fixture tests alone.

Implementation order for the remaining observation design: add typed provider-specific economic fields and a stable normalized-content digest with a compatibility reader for existing rows; publish a revision pointer in the same transaction as its qualified observations; bind recommendation and tax API responses to the exact observation IDs and policy versions; have React reject a mismatched revision instead of merging screens opportunistically. Migrate with an additive index and a read compatibility period, compare old/new results before switching readers, and keep the prior revision selectable for rollback. An index migration must first inventory existing duplicates and must never delete historical rows automatically.

Rollback should retain all previous observation rows and switch readers to the prior verified revision; it must never rewrite a historical tax outcome or freshen an older market timestamp. No data migration or rights activation is performed in this change.
