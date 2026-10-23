# GenieDecision V3 — First implemented slice (not production-certified)

**Branch:** `feature/geniedecision-v3-20261023`

## Scope

This initial slice implements a deterministic household money ledger and a
read-only, JWT-protected scenario preview. It does **not** implement persisted
scenario creation, decision runs, house-versus-rent, debt-versus-investment,
tax-aware projections, calibrated Monte Carlo probabilities, or free-provider AI.
There is no automatic transfer, portfolio mutation, market-data API call, or LLM
calculation authority.

### Already implemented

- `server/services/genieDecision/ledger.js`: exact-paisha INR accounting,
  bounded 1–360-month forecasts without returns, income-interruption what-if,
  a conservation invariant, savings reconciliation and goal budget reservations.
  Goal reservations are subdivisions of monthly investment transfers, not
  separate outgoing payments or double-counted assets.
- `server/routes/genieDecision.js`: `POST /api/decisions/preview`, mounted by
  `server/app.js` after existing global JSON, CSRF, operation and rate-limit
  middleware. It authenticates using the existing `verifyJWT`, resolves the
  canonical owner-scoped profile, checks the requested profile revision before
  and after computation, and marks the result `PARTIAL` and `previewOnly`.
- `server/test/genieDecisionLedger.test.js` and
  `server/test/genieDecisionPreview.test.js`: numerical guards, missing-data,
  stale-state and preview contract regressions.

### HTTP request example

```http
POST /api/decisions/preview
Authorization: Bearer <authenticated-session-token>
Content-Type: application/json

{
  "profileId": "<current-profile-id>",
  "expectedProfileStateRevision": 3,
  "horizonMonths": 6,
  "monthlyLivingExpenses": "50000.00",
  "monthlyDebtPayments": "20000.00",
  "monthlyInvestments": "20000.00",
  "goalReservations": [
    {"goalId": "house", "monthlyAllocation": "12000.00"},
    {"goalId": "retirement", "monthlyAllocation": "8000.00"}
  ],
  "incomeInterruption": {
    "startMonth": 2,
    "durationMonths": 3,
    "incomeLossPerMonth": "100000.00"
  }
}
```

Money inputs are **decimal INR strings** (up to two fractional digits). Income,
declared savings, and opening liquid savings are read from the canonical
financial profile, not accepted from the caller. Unknown liquid savings
return `422 REQUIRES_INPUTS`, never an invented zero.

The example is illustrative only; a real request must use the authenticated
user's current profile ID and state revision. The caller's living expenses and
debt must reconcile to the saved income minus saved savings, otherwise the
service returns `422 SAVINGS_RECONCILIATION_REQUIRED`.

### Safety boundaries

1. Preview data is not persisted, published or passed to an LLM.
2. Negative liquid cash is explicitly classified as an *unfunded requirement*;
   it is not a permitted bank overdraft or new loan.
3. Allocating the same monthly investment amount to multiple goals is rejected.
4. The model does not account for asset appreciation, investment returns,
   loan interest or amortization, taxes, inflation, or verified payment schedules.
5. A profile changed during evaluation causes `409 DECISION_STALE_PROFILE`.
6. Existing goals are **not yet verified** against hypothetical reservation IDs.
7. Provider availability, investment advice, live financial accuracy, full
   end-to-end reliability and a 95+/100 production score are **not verified**.

### Remaining release work

- Reconcile explicit household expenses, liabilities, investments and existing
  goals into a versioned household-facts model.
- Store immutable, owner-scoped scenario/report snapshots transactionally with
  idempotency and version-safe publication; handle deletion and retention.
- Add the remaining financial decision types with independent numerical tests.
- Add a complete OpenAPI contract for the preview and final scenario endpoints.
- Implement an accessible React decision workspace and end-to-end browser tests.
- Run the complete backend suite, API/concurrency/security tests and CI on the
  exact branch tip. **CI only triggers on pushes to `main`, pull requests
  targeting `main`, or explicit workflow dispatch; this branch alone does not
  certify anything.**
