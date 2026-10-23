# WealthGenie — no-key financial-source demo and boundaries (23 Oct 2026)

## What the demo can actually show

Open **Taxes → Real Returns on Investments → Open free-source research**.

1. **Mutual fund NAV research:** Search by AMFI scheme name with mfnav.in (no key). Choose an actual scheme code. The backend obtains up to 250 current historical NAV observations and validates exact scheme identity, unique dates, numeric precision, age, gap lengths and suspicious jumps. It computes **historical NAV-change annualized volatility**, not a return promise. A second free API (MFapi.in, `/mf/{scheme_code}/latest`) checks the latest published scheme code, ISIN, NAV date and NAV value. If the two available feeds disagree materially, do not simulate. If MFapi is offline or from a slightly different reporting date, label the result **single-source unverified** and do not imply independent verification.
2. **Monte Carlo:** Enter monthly investment, expected annual return (declared assumption) and horizon. A CPU-isolated backend worker performs seeded pre-tax Monte Carlo with volatility derived from the accepted NAV. The output remains a **hypothetical pre-tax scenario**. Its post-tax fields stay null; zero products are automatically certified for recommendation or commercial distribution.
3. **Government savings:** Use the separately verified **2026-10-01 through 2026-12-31** reference rates for 12 post-office schemes from the official Department of Economic Affairs, National Savings Institute, India Post and Indian Bank reference pages. Only five products (1y, 2y, 3y, 5y time deposits, and NSC) have bounded gross cash-flow models. Other products display their dated rates but do not produce invented maturity numbers. Ledger arithmetic is reconciled in integer paise.
4. **Coverage:** The **See all supported and candidate free sources** control shows **19** source candidates and current rights limitations. A source catalogue entry is NOT an integrated live feed, a verified issuer, or licensed public redistribution permission.

## External source evidence

- mfnav.in API docs: https://mfnav.in/api-docs ; terms https://mfnav.in/terms
- MFapi.in API docs: https://www.mfapi.in/docs/
- AMFI terms: https://www.amfiindia.com/terms-of-use ; no blanket commercial data reuse
- Department of Economic Affairs quarterly notices: https://dea.gov.in/budget-division/475
- National Savings Institute rates: https://www.nsiindia.gov.in/InternalPage.aspx?Id_Pk=132
- India Post savings schemes: https://www.indiapost.gov.in/banking-services/savings
- Indian Bank published Q3 2026-27 rates: https://indianbank.bank.in/en/interest-rates-for-small-savings-schemes
- Indian Open Government Data License: https://data.gov.in/Godl ; applies to datasets published under that license, not all government websites.

## What this does NOT certify

- No source is promoted into `finance.provider_rights`, and no PostgreSQL production qualification, source storage, tax classification, recommendations or existing portfolio state is modified by the free-source endpoints.
- These external endpoints are **user-triggered research-only**. API responses are `private, no-store` and not persisted to Redis/Mongo/PostgreSQL. Public/commercial third-party reuse and underlying AMFI rights are NOT independently cleared.
- Two mirrors of the **same AMFI underlying NAV publication** are not independent price authorities. Their comparison checks transport and identity consistency only.
- Mutual-fund NAV change volatility omits reinvested distributions, corporate actions and scheme fees not reflected in NAV. Never substitute NAV returns for actual total returns, future expected returns, or post-tax results.
- Government savings rate effective period is the quoted quarter, not the complete future horizon of PPF/SSY/renewals. Personal eligibility, contribution rules, tax slab, account facts and actual payment dates are not established.
- NSE, BSE, Upstox, RBI, PFRDA, SBI and other candidates have distinct access and reuse conditions. A candidate URL is not permission to scrape or display protected feeds.
- The preexisting 250 investment catalogue entries are not 250 source-verified investable products.

## Quick smoke paths

Authenticated GET `/api/free-financial-sources/coverage` returns the rights-labelled source directory.

Authenticated GET `/api/free-financial-sources/mutual-funds/search?q=SBI` returns research-only schemes.

Authenticated POST `/api/free-financial-sources/mutual-funds/simulate` takes:
```json
{"schemeCode":"100641","monthlyInvestment":10000,"currentSavings":0,"annualExpectedReturn":0.08,"years":5,"simulations":400,"inflationRate":0.05,"seed":20261023,"targetAmount":null}
```
The provider may be offline or stale. Do not guarantee this scenario produces results without verifying both adapters' responses.

Authenticated GET `/api/free-financial-sources/small-savings` lists dated public rates.

Authenticated POST `/api/free-financial-sources/small-savings/calculate`:
```json
{"productId":"government:india-post:nsc","principal":10000}
```
For source period 2026-Q4 it should return a **gross** cash-flow ledger and explicit **unavailable** post-tax results.

Use CI for tests and a real logged-in browser session for final demo validation. Do not claim production readiness or live rate qualification solely from merged code.
