# GenieChat: 250-option investment education and goal scenario handling

## Do not fine-tune on unqualified investment claims

The repository contains 155 legacy instrument catalog entries and 95 newer **discovery archetypes**, not 250 licensed, verified, currently purchasable securities. Discovery category membership may be explained, but **availability, NAV/price, returns, fees, lock-in, tax treatment, eligibility and personalized suitability are unknown until live official/qualified sources and investor profile are checked**. Static catalog expected-return values must never be shown as verified provider quotes or used to imply a guarantee.

- Educational retrieval: \`server/services/chatInvestmentUniverseEducation.js\` indexes all 250 catalog IDs/names and returns a maximum of two relevant, non-purchasable educational entries. Catalogue provenance is **internal WealthGenie**, not misattributed to SEBI.
- Goal route: \`server/services/chatGoalPlanning.js\` derives exact deterministic funding-only mathematics from explicit rupee targets, earmarked savings, and deadline. \`retrieveGoalHorizonEducation\` adds SEBI/NISM-aligned liquidity/risk education; it never manufactures fund recommendations or percentage weights.
- Public requests without a financial profile may get standalone educational or goal planning answers; profile-bound recommendations must still use state-bound authoritative suitability, rights and current market data checks.
- Both no-profile and account-bound GenieChat now retrieve catalogue/goal education; generic unsourced LLM route is rejected for named catalogue entries. The verified regulatory RAG pipeline remains narrow for law-specific assertions.
- Never claim that collecting 250 names = training a model on 250 products. This is **deterministic retrieval and evaluated grounding**, not fine-tuning. To make factual product comparisons, separately qualify issuer/scheme identity, product-specific source permission, eligibility, current facts and tax year.

## Example of a hard question

> Suppose a man has to invest ₹2 crore for his daughter's marriage. What should he do?

A strong answer first distinguishes two meanings: **₹2 crore already available** versus **₹2 crore needed by the wedding date**. It asks the wedding date, today's earmarked capital, future deposits, ability to absorb a decline, other goals and access needs. It then explains that money needed soon calls for capital preservation and liquidity, whereas a long runway may permit diversified growth assets with explicit volatility and a glidepath toward accessible assets. If the corpus is a target and years/savings are supplied, the deterministic model can show the no-growth monthly contribution baseline; optional return/inflation illustrations require **user-provided assumptions**, not a claimed market forecast.

Do not assert that investing ₹2 crore in a specific named fund, FD or equity mix will meet a wedding obligation. Verify any claimed DICGC deposit insurance (limit applies per depositor per bank in the same right/capacity) before representing deposits as protected.

## Tests and acceptance

\`node --test server/test/chatInvestmentUniverseEducation.test.js\` exhaustively checks every one of the 250 names and adversarial product-claim phrasing; included difficult wedding, housing, medical, education and retirement scenarios exercise response routing and evidence. The existing backend, profile-binding, regulatory RAG and financial integrity tests remain mandatory.

### Sources for investment principles (not specific securities)
- <https://investor.sebi.gov.in/investment-thingsbeforeinv.html>
- <https://www.nism.ac.in/how-to-manage-investment-risks-2/>
- <https://www.amfiindia.com/investor/knowledge-center-info?zoneName=riskInMutualFunds>
- <https://www.dicgc.org.in/FAQs>

### Future work

A full 250-**actual-product** assistant requires permissioned live product identity/evidence, issuer-specific risks, market freshness, tax/legal review, traceable comparisons and realistic anonymized gold evaluation scenarios. A curated discovery catalogue is not a substitute. Maintain explicit "unknown" for unverifiable facts.
