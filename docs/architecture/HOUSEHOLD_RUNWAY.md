# Household Runway — gated development implementation

**Authority:** deterministic user-declared dated cash-flow only. The engine does not fetch bank balances, holdings, investments, tax information or LLM replies. It cannot establish solvency.

**Flags:** Backend `RUNWAY_ENABLED=true`; frontend build `VITE_RUNWAY_ENABLED=true`. Both default to off. Keep them off in production until the release blockers are closed.

**Preflight:** Run `MONGODB_MIGRATION_URI=<replica-set-uri> npm run runway:migrate-indexes --prefix server` against the target database. Never run it against an unknown or production database without reviewing the URI and deployment plan. The backend rejects ledger and snapshot writes if the unique revision index is missing.

**Input:** User explicitly confirms accessible cash for today's Asia/Kolkata civil date. Money is canonical integer paise in API/DB. Never implicitly import profile `liquidSavings`. A declared future receipt is expected only. Calendar months require explicit CLAMP or SKIP behavior for nonexistent dates.

**Ledger:** `PUT /api/runway/ledger` requires `If-Match: "0"` for initial creation or the current revision, plus `Idempotency-Key`. Revisions are immutable. `GET /current` is owner-scoped. `POST /simulations` does not persist results and requires the current revision. `POST /snapshots` recomputes the engine in a Mongo transaction and saves owner-scoped results. An owned `GET /snapshots/:id` reports HISTORICAL when the current ledger differs. `POST /explanations` is local-only. `DELETE /data` needs a token issued within five minutes and typed confirmation.

**Limits:** 395-day horizon, 256 source entries, at most three shocks, 512 expanded baseline events, up to 100 saved snapshots per user. Incompatible or unknown inputs fail closed.

**Release NO-GO:** Independent arithmetic oracle, Mongo replica-set concurrency/idempotency/recovery tests, privacy tracing and backup-retention approval, staging latency measurements, user-comprehension testing, Indian legal review, and security verification remain **NOT VERIFIED**. The UI must never imply a 95% probability or guaranteed ability to pay.

**Test commands:** `node --test server/test/runwayEngine.test.js`, `node --test server/test/runwayRoutes.test.js` (with dependencies installed), `npm test --prefix reactapp -- --run`, and the normal full CI. Repository tests have not been verified as passing merely because this branch was committed.

## Integrity, retry and roll-out requirements

- Browser writes carry a stable idempotency key while a request is uncertain; an edit creates a fresh key. Mutating the ledger requires a quoted revision precondition. Read-your-own-write replay does not increment revisions.
- Only ledger cash **confirmed for the current India civil date** may be simulated or snapshotted. Historical revisions and snapshots remain owner-readable; recent cash is never inferred from them.
- Opening cash is self-reported and must be explicitly acknowledged as accessible and not double-counted. If there are no listed obligations, simulation is INSUFFICIENT_INPUT; zero listed shortfalls is **not** proof that there are no real expenses.
- Daily debits are grouped: within-day order is unknown. The engine reports total same-day deficits rather than attributing them to an arbitrarily sorted bill. Future credits and their settlement time are not confirmed.
- Every stored snapshot has an independent canonical result hash. On retrieval, input and result hashes are checked, and the result is recomputed against its original immutable revision. An engine upgrade changing calculations requires a versioned historical engine or an explicit migration; do not silently rewrite older results.
- The test suite includes a seeded arithmetic oracle independent from the production engine, plus a transaction-capable Mongo isolation/CAS/idempotency suite. Run these against isolated fixtures, and retain CI evidence for each release.
- Prior to enabling flags in production, independently verify point-in-time backup/restore, retention and erasure policy, edge security, incident rollback, and performance under realistic traffic. Do not claim these are validated by unit tests or by GitHub Actions alone.

## Saved results

- `GET /api/runway/snapshots?page=0..4` returns owner-only 20-item paginated metadata, never another user's data. `GET /snapshots/:id` verifies both ledger and deterministic result before returning a saved result.
- `DELETE /api/runway/snapshots/:id` removes exactly one owner-scoped result. Deleting the entire Runway area continues to require recent session issuance and explicit `DELETE_RUNWAY_DATA` confirmation.
- Snapshot creation increments a shared owner-state generation under the same Mongo transaction as its insert, serializing concurrent creators so the 100-item cap cannot suffer concurrent read/write skew.

- The same persisted-result verification runs before serving **either** snapshot details or natural-language explanation. A corrupted result must never be interpreted as valid by bypassing the detail endpoint.

- The UI must display both possible debit-first and definite shortfalls whenever their dates or deficit bounds differ, rather than concealing earlier conditional risk behind a later certain deficit.

## Adversarial release hardening

- An existing idempotency-key replay for a snapshot runs the same content-verification gate as a direct snapshot read. Previously a corrupt stored result could still yield a success acknowledgement.
- Snapshot rendering distinguishes `RECOMPUTED_CURRENT_ENGINE` (the stored result was recalculated with the same engine version) from `STORED_HASH_ONLY` (an older/unknown engine version cannot be safely re-run). A stored SHA-256 hash is a consistency check, **not a signed attestation against a malicious database administrator**. Historical engine results may remain viewable with explicit warnings, never silently promoted to current.
- Both declared ledger revisions and engine requests are capped at 2,048 immutable revisions per account; snapshot count is capped at 100. No silent pruning of historical evidence. A reviewable retention/export policy is needed before unrestricted production rollout.
- Runtime migration readiness now verifies the snapshot-owner query index as well as the unique ledger revision index.

- A ledger that contains payments only **after** the selected horizon returns \`INSUFFICIENT_INPUT\` (not \`NO_LISTED_SHORTFALL\`) for that period. Saving a misleading snapshot is rejected. This is tested at both numerical-engine and authenticated Mongo API levels.
