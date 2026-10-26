# Finance JARVIS V4 — Evidence-Grounded Scenario Copilot Design

**Status:** Architectural acceptance plan, not implementation certification. This branch implements only **typed, read-only contextual feature suggestions** on top of the existing authenticated/grounded chat and V3 voice runtime. The complete finance-knowledge and scenario orchestration platform described below is future work.

## User experience contract

User: "If I increase my SIP by 15% and inflation rises to 6%, can I still fund a college goal in eight years?"

A complete finance-copilot turn should:
1. Classify **goal feasibility with SIP and inflation sensitivity**, never assume this is a request to trade or change an account.
2. Extract and show named input assumptions, treating ambiguous percentage bases and periods as missing.
3. Ask one concise missing-input question if needed; never guess missing goal amount, return rate, timing or starting balance.
4. Retrieve the account's current consented financial profile and relevant source provenance, subject to session revision fences.
5. Call deterministic, versioned scenario engines with typed validated inputs. Show baseline and specified hypothetical alternatives side-by-side, incorporating modeled inflation/fees/taxes only when supported.
6. Deliver a concise voice summary and an expanded on-screen explanation with numbers, assumptions, reliability and citations.
7. Suggest **Goal Planner** and **SIP Growth Planner** as a *choice*, or abstain if routing ambiguous. Do not launch either page without a visible user confirmation.
8. Never present hypothetical rates as guaranteed, mistake modeled historical shocks for actual predictions, or silently perform financial writes.

## Architecture layers

| Layer | Goal | Required production control |
|---|---|---|
| Voice I/O | Streaming speech, VAD, speaker echo cancellation, natural interruption, transcript confirmation | Explicit foreground consent; language/device benchmarks |
| Intent and task modeling | Typed FINANCE_EDUCATION, SCENARIO, REVIEW_PROFILE, FEATURE_DISCOVERY intents | Semantic schema validation, finite operation allowlists, no instruction-from-transcript privilege |
| Knowledge | Official SEBI/RBI/AMFI/CBDT/NSE material, product facts where appropriately licensed, canonical user profile | Source provenance, publication/effective dates, access rights, freshness and claim-level citations |
| Finance calculators | SIP, goal-funding, inflation, drawdown, rebalancing sensitivity, tax assumptions | Deterministic engines, independent numerical oracles, revision-bound user inputs |
| Explanation | Short speech + detailed in-app evidence view | No invented numbers, no unverified spoken facts, financial risk/uncertainty explanation |
| Feature router | Match a question to an existing WealthGenie page | Explicit-click-only, finite canonical destinations, abstain on ambiguity |
| Operations | Audit, rate limits, cancellation, cost & latency, kill switches | Staged canary, rollback, retention minimization, incident playbook |

## Finance-domain competence required

1. Foundations: compounding, inflation, nominal versus real returns, risk versus return, liquidity, fees and taxes.
2. Investment categories: funds, ETFs, Indian equities, fixed income, government savings, retirement products and portfolio diversification.
3. Planning: emergency reserve, time horizons, affordability, savings capacity, goal uncertainty and cash-flow constraints.
4. Scenario reasoning: changed SIP amount, missed contributions, step-up, market downturn, inflation shock, interest-rate shock, tax assumptions, time-to-goal sensitivity, sequence risk.
5. Confidence and limits: distinguish verified official facts, qualified historical market observations, user-supplied hypotheticals, model assumptions and unavailable data; abstain when unsupported.
6. Market data: do not describe end-of-day mutual fund NAVs as real-time tradeable prices, and never show licensed/private quotes without distribution rights.

## Policy on financial advice

An educational copilot can describe general financial concepts and explore user-directed hypothetical calculations. Personalized security recommendations or regulated investment advice require a separate legal/compliance review against current SEBI investment adviser requirements. A disclosure alone is **not** proof that personalized advice is permitted. No transaction is authorized by this voice workflow.

## Typed feature suggestion contract shipped in this branch

A single server-reviewed question may produce:
```json
{
  "version": "genie-feature-card-v1",
  "kind": "FEATURE_NAVIGATION_SUGGESTION",
  "page": "grow-my-sip",
  "tab": null,
  "label": "Explore SIP Growth Planner",
  "description": "Review monthly-contribution and hypothetical growth scenarios.",
  "requiresUserClick": true
}
```
- Source is the user's validated **financial question**, not a model completion, retrieved webpage, ASR instruction about action privileges or arbitrary URL.
- When multiple feature classifications match, return no card rather than silently choosing one.
- The frontend re-derives a local canonical label and validates page/permissions before offering a clickable action. The existing backend voice allowlist remains independent.
- These cards are exploratory navigation suggestions, **not** trade recommendations, authorizations or evidence of a completed financial calculation.
- Account-bound chat history may persist the typed card metadata; it does not persist microphone audio.

## Release evaluation gates

- **Question understanding**: labeled corpus of at least 200 question/intent pairs covering SIP, goals, allocation, investment discovery, taxation, ambiguity and adversarial content; report macro-F1 and abstention/confusion rates by class.
- **Feature routing**: no unauthorized page IDs or auto-clicks in the adversarial corpus; >=95% correct route suggestions on unambiguous test prompts as a target, measured not assumed.
- **Scenario quality**: reference results for each engine against independent calculations; enforce rupee rounding, period/rate convention and tax/fee basis.
- **Grounding**: every financial factual statement cites permitted, dated evidence; no source rights violations or invented market freshness.
- **Latency**: measure recognition-to-first-useful-audio p50/p95 on tested real devices; a hypothetical target is not a verified SLO.
- **Audio robustness**: mic permissions, pagehide, phone calls, noisy environments, interruptions, failed network, stale browser voices, profile switching.
- **Security and privacy**: session identity/permission isolation, no raw-audio telemetry, zero financial writes, dedicated red-team review.
- **Legal**: India investment-advice boundary assessed against applicable SEBI regulations and current circulars before personalization.

## Open roadmap

- Expanded authoritative finance corpus with ingestion, evidence lifecycle, version diffing and scheduled freshness review.
- Scenario planner with typed input slots and safe clarifying questions; no free-form LLM tool execution.
- Integrate stress/goal/SIP/calculator outputs into the grounded chat and voice explanation with receipt-backed quantitative references.
- Native low-latency speech transport and voice interruption evaluation, separate from financial authorization.
- Multi-feature recommendation decision dialog: "Open SIP Growth Planner or Goal Planner?" with explicit user choice, not ambiguous automatic navigation.
