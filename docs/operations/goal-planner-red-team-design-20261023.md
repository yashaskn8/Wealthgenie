# WealthGenie Goals — red-team audit and implementation contract (2026-10-23)

Status: DESIGN / AUDIT ONLY. No application behavior changed by this document.
Source snapshot: main at `6f20c74c5a5765ce054bb8f80ba94be644d78671`.
Repository: `yashaskn8/Wealthgenie`.
Testing status: NOT VERIFIED — remote source inspected through GitHub; no local dependencies/database or CI executed.

## Verified implementation facts

- `server/routes/goals.js` creates/simulates/updates goals; each goal gets up to the entire `profile.monthlySavings` amount in `calculateGoalPlan`, regardless of other active goal commitments (lines 571–605). The what-if route only checks the single contribution against `profile.monthlySavings` (lines 767–832). **P0: shared savings can be overcommitted.**
- `GoalPlanner.jsx` sums independent required SIPs and averages goal success probabilities (lines 517–529). The average is **not** a joint probability that every goal is achieved. **P0: misleading aggregate risk display.**
- `server/routes/goals.js` requires an existing, fresh authoritative investment recommendation to calculate a goal (lines 94–149); users without an investment portfolio cannot use the existing complete goal creation path. **P1: budgeting/affordability coupled to investment product state.**
- Every goal uses a single 5% goal-inflation planning assumption (line 45 and calculateGoalPlan); no goal-category-specific price growth, ownership costs or explicitly sourced cost quotes. **P1: non-specific planning assumptions.**
- Goal types exist in `reactapp/src/config/goalCatalog.js` as *presentation-only* names; `server/models/Goal.js` has `goal_name`, amount/date/savings, but no typed vehicle/home/education/retirement schema. **P1: missing typed goal inputs.**
- FinancialProfile persists monthly take-home, declared monthly savings, optional EMI burden percentage (not amortization inputs), but not monthly expense transaction history (`server/models/FinancialProfile.js`). **P1: no auditable actual-spend affordability.**
- The observed code has freshness, source-profile binding, goal versioning, auth, idempotent create, and relevant unit/frontend tests. Do not regress these controls.

## Financial calculation invariants

1. All user finances are private and keyed by authenticated `userId`; business API failures or stale source snapshots cannot create a spend/debt recommendation.
2. **Budget invariants:** net cash available each month = verified net recurring income - essential spend - discretionary spend - already committed recurring debt payments - recurring insurance - other protected obligations. Never subtract the same EMI or savings commitment twice. Savings goals consume **one shared** available-capacity envelope, not an envelope per goal.
3. A `monthlySavings` assertion without categorized spend history is an **unverified capacity estimate**, not proven disposable cash.
4. Missing rate, vehicle quote, fee, expense, insurance, loan duration, tax or return means `null` + explicit reason code. Zero is not equivalent to missing.
5. EMI for a reducing-balance loan uses `P*r*(1+r)^n/((1+r)^n-1)` with `r=annual_decimal_rate/12` and zero-rate branch `P/n`. Display rate type, APR comparison limitations, upfront charges, insurance, residual/balloon terms, full repayment and interest, no loan approval promise.
6. Vehicle cash outflow = down payment + registration/road tax + insurance + mandatory fees + recurring fuel/energy, service, parking, loan EMI and annual renewal assumptions. Keep ex-showroom and actual on-road quotes separate.
7. Investment horizon, time-to-goal, inflation assumptions, sensitivity ranges, gross/pre-tax vs post-tax, liquidity constraints and downside are explicit; never substitute 250-item investment universe catalog breadth for product suitability or data qualification.
8. No named stock tips in Goals. Gold is educational suitability/asset-class discussion (liquidity, custody, taxation, spread, price volatility); never unconditional instruction to buy, nor model-generated portfolio weights.
9. LLM is explanation-only: all affordability, cash-flow, scenario rankings, constraints and numbers are from a versioned deterministic server engine.
10. External pricing records require `sourceUrl, provider, capturedAt, amount, amountType, exactModel, variant, location, year, terms, rightsStatus, expiresAt`; unknown/stale/unlicensed records cannot be called “live” or used in automated cheapest-vehicle rankings.

## Proposed domain boundaries (new, additive versioned contracts)

- `BudgetMonth`: user, YYYY-MM, currency, typed line items, categorized expenses, income, recurring payments, import/manual provenance, revision, createdAt/updatedAt. Unique per user/month/revision as appropriate.
- `DebtObligation`: user-owned existing EMI principal/rate/remaining term if known, minimum monthly payment, rate type, due date, version. For loans with unknown details, preserve unknown.
- `GoalSpecification`: typed kind (`vehicle|home|education|emergency|retirement|general`), chosen user-specific parameters, expected cost, target date, priority, funds **allocated uniquely** to goal, inflation policy/fact source, revision; migration path for existing goals without guessing type from `goal_name`.
- `GoalFundingPlan`: all-goal monthly shared-capacity allocation with sum of commitments <= verified free cash, goal priority and target horizon, lock/version, deterministic diagnostics; no phantom duplicate capital.
- `AffordabilityScenario`: rate/term/down payment/ongoing cost assumptions, loan alternative, original budget/goal versions, snapshot date, deterministic outcome: `AFFORDABLE_WITH_BUFFER|BUDGET_SHORTFALL|DATA_INSUFFICIENT|RISK_WARNING`.
- `VehicleQuoteEvidence`: approved, permitted and normalized price snapshots, not a fallback web snippet; source/provider/usage rights/quote validity.

Keep private budget/debt data in authenticated private storage; do not mix with PostgreSQL public investment-universe facts. Externally-sourced shopping prices are a distinct, licensed dataset from market prices/NAVs.

## Proposed API/flow

Existing `/api/goals` creation/update remains backwards compatible; introduce versioned endpoints:
- `GET/PUT /api/goals/budget/months/:period` (idempotent and version-fenced);
- `GET/POST/PATCH /api/goals/specifications` (typed specifications; no guessing on migration);
- `POST /api/goals/plan` (pure deterministic shared-savings allocation);
- `POST /api/goals/affordability/scenarios` (explicit loan and total ownership costs; never lender eligibility guarantee);
- `GET /api/goals/vehicle-quotes` (available only through permitted sourced evidence; explicit unavailable state otherwise).

Ensure static route ordering before dynamic `/:goalId` routes; all endpoints use JWT, strict numeric and date validation, consistent error codes, owner isolation, optimistic concurrency, and request limits.

## Implementation sequence / merge gates

**P0 — Truthfulness and shared capacity.** Add multi-goal allocation evaluator, sum-of-contributions invariant, separate individual vs portfolio-wide outcome; remove/rename average “overall success” metric. Tests cover two simultaneous goals, overlapping claims on same current savings, zero and missing input, fully-funded goals, priority changes, profile-stale races, and budget versions.

**P1 — Transaction/expense budget.** Add monthly budget capture, recurring vs one-off expenses, bank/CSV import as opt-in later, duplicates and reversal reconciliation, budget-history summaries and months with missing observations, inflation/cost versioning. Never treat financial profile `monthlySavings` as independently verified actual spending.

**P1 — Debt and purchase engine.** Deterministic reducing-balance EMI/total-interest/fees; remaining surplus after EMI and upkeep; emergency floor; what-if buy now vs wait vs cheaper vs cash vs used vehicle, stress scenarios for pay cut, major repair, interest changes. Display assumptions and reasons, never “loan rejected”.

**P1 — Typed goal specifications.** Vehicle, home, education, retirement, emergency fund, general, each with input requirements, different horizons, cost and liquidity treatment, and backwards compatible untyped records. Budget-only goals must work without an existing investment recommendation; simulations remain conditional.

**P2 — Evidence qualified alternatives.** Manufacturer official ex-showroom quotes or documented, licensed aggregators; exact model/variant/year/location/on-road comparability; freshness and rights gates; manual user-quoted fallback clearly marked. No scraping without rights, no price guesses, no Google search snippets as authoritative quotes.

**P2 — Gold and financial learning.** Beginner-friendly finance education: EMI, principal/interest, opportunity cost, inflation, budget buffers, gold type risk, liquidity, time horizon, savings/asset-class scenarios. LLM may word explanations only, constrained to server fact bundle + safe source citations.

**P2 — Product readiness.** Migrations/backfills without inferred types; integration tests, property-based math, partial/outage paths, multi-user auth isolation, idempotency/race tests, accessibility/mobile checks, source license audit, reproducible scenario snapshots, monitoring, roll-out and rollback.

## Release blockers / required verification

- **Not verified:** current CI status, e2e UI working state, live MongoDB/Redis/Postgres behavior, existing unresolved runtime bugs, authorized vehicle quote API, precise regulatory classification. Do not claim these passed.
- Budget-plus-EMI projected spending never exceeds net recurring income without explicit `BUDGET_SHORTFALL`; no goal can double-use budget/savings.
- Boundary test rate=0 and variable dates; invalid APR and loan terms rejected; one rupee rounding/precision verified; goal projection nominal/inflation computed exactly once.
- Source access rights checked independently; expired or conflicting vehicle quotes rendered `UNAVAILABLE`; unknown never converted to zero/“best”.
- Stress test concurrency for budgets + goal updates + profile refresh; preserving current goal provenance and idempotent-create protections.
- Review financial advice classification under applicable SEBI Investment Advisers requirements before launching personalized asset allocation or investment recommendations.

## External public references (design guidance, not provider integration proof)

- SEBI budgeting and goals: https://investor.sebi.gov.in/moneymatters-budandfinangoal.html
- SEBI income/expenses and emergency fund: https://investor.sebi.gov.in/moneymatters-inc-exp.html
- SEBI investments/suitability: https://investor.sebi.gov.in/investment-thingsbeforeinv.html
- RBI general home-loan disposable-income guidance: https://rbi.org.in/CommonPerson/english/scripts/FAQs.aspx?Id=701
- Hyundai official model/city ex-showroom quotes (no API/redistribution rights presumed): https://www.hyundai.com/in/en/click-to-buy/prices
- Google Custom Search JSON API closed for new customers: https://developers.google.com/custom-search/v1/overview
