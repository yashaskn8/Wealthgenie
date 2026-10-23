# Obligation Firewall — guarded 90-day cash check

The sole authoritative calculation is arithmetic on bounded, self-declared financial commitments in safe integer paise. It neither verifies bank balances nor guarantees affordability. No broker, bank, market or LLM API is needed.

## V1 contract

- User declares accessible cash with an as-of date (today in India) and a source label. Money already spent must not be declared available and already-paid bills must not be re-entered.
- At most 100 one-off, weekly or monthly entries are accepted. Monthly dates clamp independently from the original anchor. Intraday debits precede expected credits.
- Results are conditional on listed entries; future income is uncertain and the income-absent stress scenario is shown separately. Savings-profile aggregates, investment holdings and recommended SIPs are never implicit cash flows.
- No automatic financial action, product recommendation, scheduler, Redis cache, background notification or LLM-generated explanation.
- Revisions are immutable while retained. Authenticated reads and writes are user-scoped; writes need a quoted If-Match revision and Idempotency-Key. Preview writes nothing.
- Deleting saved data atomically wipes cash-plan contents and historical results, retaining only a nonfinancial monotonic revision tombstone and minimal hashed operation/deletion evidence to block stale replay. Backups are outside this API's direct erasure scope.

## Deployment

- Apply existing Phase-2 Mongo index migration using a transaction-capable replica set and MONGODB_MIGRATION_URI; the migration installs coverage-ledger, coverage-result and deletion-receipt unique indexes. Requests do not auto-create indexes.
- In production, set COVERAGE_ENABLED=true for the backend **and** VITE_COVERAGE_ENABLED=true when building the frontend. Both default off in production until operational and legal signoff. Nonproduction can disable with COVERAGE_ENABLED=false.
- Existing cookie session authentication, CSRF, rate limiting and no-store response headers must remain enabled.
- Endpoints: GET /api/coverage/ledger; PUT /api/coverage/ledger; POST /api/coverage/scenarios/preview; GET /api/coverage/revisions/:revision; DELETE /api/coverage/ledger.
- A new ledger starts with If-Match "0". After deletion, use the returned nextRevision rather than zero. The saved immutable result and ledger revision commit in one Mongo transaction.

## Release gates

Verify independent balance/date oracle, Mongo replica-set concurrency and transaction rollback, complete idempotency replay, cross-user isolation, cookie CSRF, mobile/browser usability, performance, retention/backup expiry, authorized data export/erasure, and the applicable Indian regulatory and privacy requirements. Do not claim a 95+ score, professional financial advice or production availability without external verification. Keep the launch flags off until all checks and legal/product review are complete.

## Bounded history and private export

At most 256 full saved coverage snapshots per owner are retained until intentional deletion. After the limit, a new save fails closed and users must download their history and explicitly delete/restart their plan; deletion does not reset the monotonic revision fence. GET /api/coverage/export supports owned JSON pages of at most 20 records with an afterRevision cursor. The workspace offers a full saved-history JSON download. This is a bounded storage policy, **not** a verified backup expiry or final jurisdiction-specific retention assessment.

### Exact currency rendering red-team check
Frontend rupee formatting must separate whole rupees and integer paise, never convert a potentially large exact-paise aggregate to floating-point rupees before rendering. For example, 9007199254740991 paise must display a `.91` suffix rather than `.90`; negative dated deficits must preserve their sign.

### Multi-device revision conflicts
A stale update never silently overwrites concurrent changes. The UI fetches the latest saved ledger and shows both the local and saved commitments. The user may discard local changes or must explicitly attest that they reviewed both versions before moving their unsaved draft onto the new revision. A ledger deleted on another device cannot be automatically resurrected; restarting requires loading the deletion tombstone and entering new cash data.
