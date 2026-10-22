# WealthGenie financial-universe qualification research — 22 October 2026

## Evidence-based verdict

The 95 additional repository entries are **archetypes/strategies**, not 95 established investable products. This status is directly verified in `server/data/investmentUniverseExtensions2026.json`: 95 of 95 have absent actual-product identifiers, `recommendationEligible=false`, unavailable market/product tax facts and unverified commercial data rights.

The actual qualified count for these 95 is **zero on current repository evidence**, *not* proof that no corresponding security or scheme exists in the Indian market. Do not flip any recommendation flag on that basis.

## Portfolio and identity distinctions

- 250 reference entries = 155 legacy families + 95 new archetypes. This is **not** 250 separately investable securities.
- A family can map to **zero, one or many** actual products. Example: an index-tracking *strategy* needs an issued AMC fund or listed ETF with an actual scheme identity; the index itself is not purchasable.
- A registered actual product is not automatically eligible for an investor, and a risk score is not an approval for regulated advisory services.
- A valid top-ten shortlist may have fewer than ten selections. Duplicate exposure and overlapping funds require portfolio-level risk controls.

## Category-by-category qualification queue

| Family group | Entries | Queue | Evidence needed |
|---|---:|---|---|
| Government | 14 | P1 | Scheme notification or dated RBI auction issue terms; effective rates, eligibility, maturity, liquidity and early-exit rules |
| Bank Deposits | 7 | P1 | Specific bank/NBFC issuer and scheme, current public rate sheet, tenure, premature closure, limits, DICGC applicability, NBFC credit risk |
| Debt Mutual Funds | 9 | P1 | Current exact AMC scheme, direct/growth plan, scheme code/ISIN, SID/KIM, riskometer, expense ratio, NAV rights and liquidity |
| Equity Mutual Funds | 14 | P1 | Exact AMC index-fund scheme, benchmark identity, direct/growth option, SID/KIM, riskometer, TER, NAV and availability |
| ETFs | 10 | P1 | Exact exchange-listed ETF ISIN/symbol, issuer factsheet, tracking difference, TER, bid-ask liquidity, market-data rights |
| Retirement | 9 | P2 | Current NPS scheme and fund manager, valid choice/tier and age rules, contribution restrictions, vesting/exit, charges and scheme NAV |
| Bonds & Debentures | 12 | P2 | Current legally issued bond with ISIN, issuer financials/rating, coupon versus YTM, covenants, redemption, tax and trading venue |
| Regulated Alternatives | 10 | P3 | Registered manager/current AIF-PMS-SIF offering, investor thresholds/exemptions, specific risk and liquidity disclosures, accreditation/commitment and restrictions |
| Other | 10 | P2 | For REIT/FoF exact listed/scheme identity, disclosures and price/NAV; for bullion verified seller/refiner fineness, buy/sell spread, storage and custody |
| **Total** | **95** | | |

See `financial-universe-95-qualification-tracker.csv` in this directory for **each canonical ID**, its actual category, reference URL, source candidates and missing evidence. All rows deliberately remain `BLOCKED_ACTUAL_PRODUCT_UNVERIFIED` pending actual source review.

## Verified external research starting points

1. SEBI, **Master Circular for Investment Advisers**, 6 February 2026, and Investment Advisers Regulations last consolidated 25 November 2025: https://www.sebi.gov.in/legal/master-circulars/feb-2026/master-circular-for-investment-advisers_99569.html ; https://www.sebi.gov.in/legal/regulations/nov-2025/securities-and-exchange-board-of-india-investment-advisers-regulations-2013-and-securities-last-amended-on-november-25-2025-_98246.html. Risk profiling, advice records, conflicts, and legal authority to provide personalised advice are business-wide obligations.
2. SEBI, **Mutual Fund Categorization**, 26 February 2026, and **Master Circular**, 20 March 2026: https://www.sebi.gov.in/legal/circulars/feb-2026/categorization-and-rationalization-of-mutual-fund-schemes_99983.html ; https://www.sebi.gov.in/legal/master-circulars/mar-2026/master-circular-for-mutual-funds_100491.html. Category names do not identify actual active schemes.
3. AMFI, NAV Download: https://www.amfiindia.com/net-asset-value/nav-download. Public NAV access establishes neither complete plan identity nor commercial storage, redistribution or display rights. Check permitted current report format.
4. India Post, savings schemes: https://www.indiapost.gov.in/banking-services/savings. Actual savings accounts/term-deposit tenures can be researched directly. Bind to applicable issue/rate periods and restrictions rather than describing these as live equities.
5. RBI Retail Direct FAQ: https://www.rbi.org.in/Scripts/FAQView.aspx?Id=145. Tie G-Secs, SDLs and T-bills to **specific issues**, auction terms and available investor channels.
6. PFRDA, NPS All Citizen: https://pfrda.org.in/en/schemes/national-pension-system/nps-for-all-citizen-models. Different NPS choices, Tier-I/Tier-II and multiple-scheme pathways have distinct availability, minimums, exit and risk rules.
7. SEBI, **AIF Third Amendment**, 15 October 2026, and the **AIF Regulations** listed through July 2026: https://www.sebi.gov.in/legal/regulations/oct-2026/securities-and-exchange-board-of-india-alternative-investment-funds-third-amendment-regulations-2026_105331.html. Investment minimums, special-case exceptions, professional-investor requirements and lock-ins require product-level compliance review.
8. SEBI, **SIF distributor certification**, 21 July 2026: https://www.sebi.gov.in/legal/circulars/jul-2026/certification-requirements-for-distribution-of-specialized-investment-funds-sifs-_102986.html . SIF strategies are not interchangeable with retail index funds.
9. NSE, **Market Data Sharing & Usage Policy**: https://www.nseindia.com/static/market-data/nse-data-policy. A downloaded price or web page is **not** blanket permission for commercial redistribution or derivatives.
10. DICGC, deposit insurance: https://www.dicgc.org.in/guide-to-deposit-insurance. Bank coverage (up to INR 5 lakh per depositor per bank, subject to terms) must not be applied to nonbank deposit products.
11. BIS, bullion/refinery rules: https://www.bis.gov.in/hallmarking-jewellers/?lang=en . Physical bullion purchase is different from a market security and requires verified seller/weight/fineness/custody/spread, not an inferred market quote.

## Root cause: the 95 still cannot enter today's top-ten ranking

**VERIFIED:** `server/services/RecommendationPipeline.js` only feeds `investmentDatabase` (155 original families) into `filterEligible` and `rankInstruments`; it explicitly screens out each discovery extension.

**VERIFIED:** `server/postgres/registerActualProduct.js` only registers distinct `ACTUAL_PRODUCT` records; it does **not** turn an archetype into a purchasable instrument and returns `recommendationEligible:false`.

**VERIFIED:** `server/postgres/connection.js` treats an archetype marked recommendable as a readiness failure. Do not weaken that invariant.

**VERIFIED:** `server/postgres/financialStore.js` demands source rights, product identity and freshness for publishable market observations. NSE explicitly requires relevant permission to redistribute market data.

**IMPLEMENTATION DESIGN (NOT IMPLEMENTED):**
1. Maintain canonical **family→actual-product** relations in Postgres; immutable archetype ID and distinct actual product IDs. Product-specific legal/issuer evidence and per-field data rights.
2. Introduce a reviewed attestation state `IDENTITY_VERIFIED → RIGHTS_VERIFIED → PRODUCT_TERMS_VERIFIED → SUITABILITY_ADAPTER_VERIFIED → ACTIVE` plus `SUSPENDED`. Verify expiry, revision and issuer/source fingerprints. Only ACTIVE actual products enter selection.
3. Add qualification adapters per instrument: post-office contracts, bank/NBFC deposits, fund/ETF schemes, dated debt, retirement choices, restricted funds/services, and bullion. Never map an unfamiliar product to FD/MF by name alone.
4. Extend profile facts where necessary, with validated declared eligibility for KYC/demat, tax status, NPS account/tier, accreditation, residency, age, product minimum, risk knowledge and capacity. Missing facts block only the product that needs them, not the whole catalog. Obtain them with consent; do not infer.
5. Extend `runPipeline` to query **approved actual products** with source provenance and deterministic evidence-based scoring. Preserve existing controls, budget/concentration, user goal, liquidity, return-model and tax distinctions; never delegate allocation authority to LLMs.
6. On source revocation, outdated offering terms, stale market observations, risk downgrade or lost approval, suspend from new recommendation scoring immediately. Ensure saved plan consistency/freshness and explain required review rather than silent replacement.
7. Test end-to-end real publisher state in PostgreSQL, MongoDB recommendation binding and React: market data rights denied, unqualified identity, stale source, new category rules, private investor not accredited, short horizon, insufficient funds, low liquidity, conflicting product classes, name collisions, and no product qualified.

## Evidence and approval gates

To move one tracker row from blocked to qualified, an auditor needs:
- actual product ID(s) and relevant issuer/AMC/ISIN/scheme identifier, sourced and date stamped;
- explicit confirmed eligibility and purchasability, min contribution, lock-in, redemption, risk and fees;
- evidence for the calculation class and optional tax assumptions;
- documented data rights and retention permission for **WealthGenie's actual intended commercial/educational display use**;
- independently reviewed deterministic product adapter and tests, and decision owner;
- review of whether WealthGenie's activity is regulated personalized investment advice (SEBI IA rules).

**Not verified:** live database rows; individual qualified products; live source rights agreements; issuer data pipeline; investor registrations/SEBI authorizations; CI success and deployment at the time this document was drafted.

## Priority strategy

**P1:** government, bank deposits, mutual funds and ETFs — source identities and issuer documents typically easier to establish first, although qualification is not assured.

**P2:** retirement, specific bonds, REIT/physical commodities and miscellaneous FoFs — needs more specialized product terms, tax, maturity and liquidity adapters.

**P3:** AIF, PMS, SIF — restricted/high-minimum/complex exposures, potential accreditation conditions and elevated legal review. Do not recommend to ordinary salaried profiles automatically.

**Stop condition:** Never promote all 95 merely to satisfy the target count. Some strategies will have zero current exact products; those should remain explainable discovery options.
