# Investment scenario response coverage and truthfulness contract

## User-visible behavior

The assistant must not stop at "no information" for broad investing
hypotheticals. It should retrieve reviewed educational decision steps from
\`server/services/chatInvestmentScenarioEducation.js\`, explain the tradeoffs
and ask for only the missing parameter that changes the answer.

Examples:
- A parent saving for a wedding: distinguish capital already available from a
  future target, establish date, tolerance for losses and funds earmarked.
- An inheritance or one-off cash receipt: distinguish immediate commitments
  from long-horizon capital and concentration risk.
- Market decline: review goal deadline, liquidity, allocation drift and the
  possibility that recovery may not precede the financial goal.
- Retirement income: assess expenses, income floor, possible longevity,
  volatility and withdrawal needs.
- Loan versus investing: distinguish contractual borrowing costs from
  uncertain investment outcomes.
- Emergency savings: prioritize immediate access over uncertain returns.
- FD / fund / ETF comparisons: compare risks, liquidity, fees and issuer
  documents without inventing current prices, tax or product availability.

The generic case gives the same source-backed planning framework instead of
fabricating figures. Results have citations and use a **deterministic** path
to prevent open-ended model hallucinations. Scenario education can be answered
without a profile; it never inspects or infers a user's actual holdings.

## Hard safety boundary

"Never says I don't have information" is a conversational goal, **not**
permission to hide uncertainty. Exact current NAVs, dated yields, individualized
eligibility, taxes, insurance protection, specific product recommendations,
account holdings, or guaranteed results require verified evidence. If such
evidence is missing, explain the evaluation method and which specific current
fact must be checked. Do not invent that fact.

Private profile queries continue to require account-bound state and are
**excluded** from stateless public scenario retrieval. Tax-specific queries
continue to follow the qualified tax policy/boundary, not generalized investor
education. Ambiguous rupee sums cannot be treated as known future targets.

## Sources reviewed

- SEBI financial goals and budgeting:
  https://investor.sebi.gov.in/moneymatters-budandfinangoal.html
- SEBI factors before investing:
  https://investor.sebi.gov.in/investment-thingsbeforeinv.html
- SEBI market and liquidity risks:
  https://investor.sebi.gov.in/securities-risks_trade_derivatives.html
- NISM objectives, suitability and rebalancing:
  https://www.nism.ac.in/revamp-nism/things-to-consider-before-investing/
- AMFI mutual fund standard risk disclosures:
  https://www.amfiindia.com/investor/knowledge-center-info?zoneName=riskInMutualFunds

Review the explanatory claims and source permissions periodically, especially
when regulatory investor guidance changes. These sources support *principles*,
not a 250-product current-data index.

## Tests and release bar

\`\`\`bash
cd server && node --test test/chatInvestmentScenarioEducation.test.js \
  test/chatGoalPlanning.test.js test/chatInvestmentUniverseEducation.test.js \
  test/generalChatService.test.js
cd ../ml-service && python -m pytest -q \
  tests/test_vector_store_faiss.py tests/test_rag_multi_tenant.py
\`\`\`

GitHub Actions validates the full regression suite. Failures, published
dependency advisories and qualified-product evidence gaps remain release
blockers even when the scenario-answering test suite passes.
