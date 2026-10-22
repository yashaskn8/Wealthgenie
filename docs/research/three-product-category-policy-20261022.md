# Three real products per displayed investment choice

As of 22 October 2026, WealthGenie should **not** show any investment family as
a supported three-product comparison unless the backend can produce three
distinct currently licensed, source-identified, qualified offers.

## Production rule

- 250 immutable original family identifiers remain in the database for saved-plan
  compatibility and research. They **do not** imply 250 usable recommendation families.
- `GET /api/financial-universe/three-product-families` returns only families with
  at least three *preliminarily* qualified distinct issuer products, current
  provider permissions and publishable observations.
- The personalized comparison endpoint must return **exactly three independently
  suitable** products or **none**, with `INSUFFICIENT_VERIFIED_PRODUCTS`. If a
  price expires or permissions are revoked during ranking, the response goes to
  none. The qualified-families lookup is a prefilter, not personalized advice.
- The UI must default to currently three-product qualified choices. The 250-family
  research archive may remain available separately with explicit unsupported
  status, but must never call individual discovery archetypes investable.
- Future substitutions use new category IDs and explicit deprecated-ID mappings.
  Do not silently overwrite the economic meaning of an existing plan or category.

## Official research examples — NOT APPROVED PRODUCTS

- Nifty100 Low Volatility 30: NSE Indices currently lists four domestic ETF
  issuers (HDFC, ICICI Prudential, Kotak, Mirae). Candidate for real-product
  qualification; index listing alone does not establish TER, exchange
  liquidity, actual ISIN, allowed commercial display, or investor suitability.
  https://niftyindices.com/indices/equity/strategy-indices/nifty-100-low-volatility
- Nifty500 Momentum 50 ETFs: only Motilal Oswal appears in the official
  ETF issuer list, hence **do not present a three-ETF comparison**. NSE's
  index fund list is separate and must not be substituted for an ETF category.
  https://www.niftyindices.com/indices/equity/strategy-indices/nifty500--momentum--50
- Post Office savings / single government scheme: it is a unique scheme,
  not three competing issuers. Keep for education or broader strategy grouping,
  not three artificially duplicated products.
- Multiple issuer funds in one broad SEBI strategy type can be compared only
  after reviewing each exact scheme, costs, risk class, subscription terms and
  entitled facts. SEBI category circular of 26 February 2026:
  https://www.sebi.gov.in/legal/circulars/feb-2026/categorization-and-rationalization-of-mutual-fund-schemes_99983.html

## Live gating & rollout

Without three manually/independently approved issuer products per family in
PostgreSQL, the eligible-family list is empty. This is an **honest empty result**,
not a production outage. Do not fill with empty 750-slot review queue records.
The business must obtain appropriate investment-advice authority and actual
provider-data rights independently; API key or web scraping alone is not a licence.
