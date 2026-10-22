# WealthGenie: verified reference corrections and realistic top-three product comparisons

Reviewed: 22 October 2026. Scope: **95 additional discovery families**, not independently qualified purchasable products. All 250 catalog IDs remain intact (155 legacy + 95 extensions).

## Result

- Reviewed and corrected **28 family reference/name rows** against issuer/index/regulator source pages; **4 name refinements** to precisely identify benchmarks. The remaining references were not comprehensively validated, and individual products were not certified.
- Corrected references prove the **family, benchmark or regulatory framework exists**, never that WealthGenie has licensed the associated price stream, identified three purchasable offerings, checked investor suitability or obtained authority to provide regulated investment advice.
- Every one of the 95 remains `ARCHETYPE`, `UNVERIFIED`, `recommendationEligible:false`; source permission and actual product facts remain unverified. Do not upgrade the flags when a web URL resolves.
- PostgreSQL seeding has an explicit old-value-to-reviewed-value allowlist so already-seeded data can accept only these identity/reference corrections transactionally, without changing canonical IDs or silently altering recommendation eligibility. Unrecognized modifications fail closed.

## High-confidence corrections

| Canonical ID | Correction | Verified source | Actual-product caveat |
|---|---|---|---|
| `catalog_2026_index_nifty_lowvol` | Specify **Nifty100 Low Volatility 30** index | https://www.niftyindices.com/indices/equity/strategy-indices/nifty-100-low-volatility | Index is not the AMC fund; this page lists multiple index-fund issuers |
| `catalog_2026_index_nifty500_momentum` | Specify **Nifty500 Momentum 50** | https://niftyindices.com/indices/equity/strategy-indices/nifty500-momentum-50 | Multiple domestic fund issuers shown; verify individual active schemes and direct/growth option |
| `catalog_2026_etf_nifty500_lowvol` | Specify **Nifty500 Low Volatility 50** | https://www.niftyindices.com/indices/equity/strategy-indices/nifty500-low-volatility-50 | ETF-issuer count not confirmed; candidate for replacement only after issuer/ISIN audit |
| `catalog_2026_etf_nifty500_momentum` | Specify **Nifty500 Momentum 50** | https://niftyindices.com/indices/equity/strategy-indices/nifty500-momentum-50 | NSE shows **one ETF issuer**. Cannot promise three ETFs without unrelated substitution |
| `catalog_2026_index_nifty500_equal` | Link exact Nifty500 Equal Weight index | https://www.niftyindices.com/indices/equity/strategy-indices/nifty500--equal--weight | Index existence does not establish multiple funds |
| `catalog_2026_etf_nifty200_quality` | Link exact Nifty200 Quality 30 index | https://www.niftyindices.com/indices/equity/strategy-indices/nifty200-quality-30 | Index page shows **three ETF issuers**, still requires actual scheme/ISIN, fees, spreads |
| `catalog_2026_aif1_vc` (and six related AIF entries) | Replace 2012 launch press release with July 2026 consolidated AIF regulations | https://www.sebi.gov.in/legal/regulations/jul-2026/securities-and-exchange-board-of-india-alternative-investment-funds-regulations-2012-last-amended-on-july-14-2026-_102975.html | Also review **15 Oct 2026 third amendment** https://www.sebi.gov.in/legal/regulations/oct-2026/securities-and-exchange-board-of-india-alternative-investment-funds-third-amendment-regulations-2026_105331.html; high minimums |
| `catalog_2026_sm_reit_scheme` | Replace outdated 2024 rule page with April 2026 REIT rule text | https://www.sebi.gov.in/legal/regulations/apr-2026/securities-and-exchange-board-of-india-real-estate-investment-trusts-regulations-2014-last-amended-on-april-18-2026-_101013.html | Actual listed REIT scheme is separately required |
| `catalog_2026_nbfc_fd_cumulative` (and payout) | Use RBI deposit-taking NBFC master direction instead of generic FAQ | https://rbi.org.in/scripts/NotificationUser.aspx?Id=10563 | NBFC public deposits are not DICGC-insured like covered bank deposits |
| `catalog_2026_pms_discretionary` (and nondiscretionary) | Use SEBI registered manager registry | https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=33 | Registration does not establish a particular active PMS strategy's returns or investor eligibility |
| `catalog_2026_sif_hybrid_longshort` | Use SEBI Mar 2026 mutual-fund master circular | https://www.sebi.gov.in/legal/master-circulars/mar-2026/master-circular-for-mutual-funds_100491.html | SIF is a restricted strategy, not an ordinary retail equity MF |
| `catalog_2026_tbill_91` (also 182/364 days) | Replace one dated auction press release with official RBI Retail Direct guidance | https://www.rbi.org.in/Scripts/FAQView.aspx?Id=145 | Current auction identifier and price/yield still necessary |

Index thematic references for India Defence, India Digital and India Consumption were replaced with their own published NSE index pages. Their issuer counts vary, e.g., India Digital's official page shows one domestic index-fund issuer and one ETF issuer: https://www.niftyindices.com/indices/equity/thematic-indices/nifty-india-digital .

## Top three is a ceiling, never a quota

Display **up to three** distinct, currently qualified actual products for a catalog family; zero is a valid honest result. Three is not always possible: one-off government saving accounts have a single designated scheme, Nifty500 Momentum 50 only one issuer in the official ETF list, institutional AIF/private/unlisted/CP and NPS alternatives are not necessarily open or suitable for a retail customer.

For a product to count in the top three, record all of:
1. Parent discovery-family **ID** separate from immutable **actual-product identity** (ISIN, AMC scheme+plan+option, dated G-Sec issue, bank specific offer/term, pension fund scheme, etc.).
2. Issuer / regulator and current offer evidence, active subscription status, amount thresholds, lock-in/exit, settlement, fees, riskometer/credit risk, as-of/expiry and independently checked issuer restrictions.
3. Explicit commercial storage, derivation and redistribution rights **per field/source**, or no public market values. Source website accessibility is not permission.
4. Strict deterministic **per-investor** eligibility/risk capacity/horizon/minimum ticket, mandate / approvals where applicable, no conflicting identity nor marketing promises of returns.
5. Rank with a **documented within-family objective**, do not rank simply by nominal yield: equity index tracking difference/TER/volume, bank FD effective payout + DICGC aggregate cap, bonds price/YTM/credit/secondary liquidity, funds riskometer/TER/liquidity, NPS exit restrictions. Deduplicate the same product across provider feeds. Treat stale values as unavailable.
6. Present reasons, limitations and source timestamps. If less than 3 pass, show less, never fill using another family and never silently replace an existing saved investment ID.

## Replace-or-keep decisions requiring further investigation

- **Keep as discovery, not recommended:** AIF I/II/III, PMS services, SIF strategy, private/unlisted debt, physical bullion, NPS Vatsalya (requires qualifying child subscriber). These can remain visible as educational categories, but not automatic retail top-three recommendations.
- **Review for future new-ID replacement:** `catalog_2026_etf_nifty500_lowvol` and thin/thematic ETF categories if no current exact listed ETF. Use a **new ID plus explicit deprecation/mapping**, never redefine an old ID's investment meaning. Potential replacement theme supported by official evidence: **Nifty100 Low Volatility 30 ETFs** with multiple official index-page issuers (HDFC, ICICI Prudential, Kotak, Mirae); identity and suitability still unverified.
- **Review ambiguous FoFs:** `catalog_2026_fof_income_arbitrage` and other bespoke FoF names are strategies, not established regulated named product categories. Never claim these names are active SEBI-defined schemes without actual AMCs and offers.
- **Fix later schema classification:** `catalog_2026_gsec_debt_etf` is a debt **ETF strategy** but currently grouped under Debt Mutual Funds. Moving categories requires controlled migration/compatibility checks.
- **Top-three cannot be enabled solely by this source review**: `server/postgres/registerActualProduct.js` presently inserts verified source-identified actual product with `recommendationEligible=false`; the existing family ranker reads the 155 legacy items, not a family-linked, active, qualifying Postgres product queue. A family→actual-product qualification and eligibility/ranking pipeline, along with licensed feeds, is still required.

## Gates to verify next

- Unit: 250 unique IDs, 95 discovery rows, corrected source map and no role/rights flips.
- Persistence: apply reviewed revisions to already seeded PostgreSQL and re-run without conflicts; verify flags remain false.
- End-to-end: genuine product identity/provider/permission, source revoked, stale facts, missing tax/model, unsuitable profile, 0/1/2/3/4 eligible products, equal rank, deduplication, saved plan identities, mobile UI. This end-to-end top-three flow **is not implemented or validated by this source audit**.
