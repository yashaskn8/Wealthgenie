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

- Financial-result algorithm version was bumped to \`runway-cashflow-1.1.0\`. An older snapshot can be viewed as archival data after hash verification, but generating a current explanation from an unrecomputed historical version returns \`RUNWAY_HISTORICAL_ENGINE_UNSUPPORTED\`. The saved-results list also labels engine-obsolete rows historical.

- A result is marked CURRENT only if the current ledger revision matches **and** the engine version matches **and** cash was declared for today's India civil date. Results turn HISTORICAL across midnight until new cash is confirmed.
- Database integration red-team case seeds 99 owner-scoped saved results, races two independent creators and asserts exactly one success and 100 total records. A separate owner-state fixture verifies new immutable revisions cannot exceed the 2,048 cap.

- \`SKIP_RECEIPTS\` cannot quietly do nothing: the chosen income ID and time window must remove at least one actually expanded receipt inside the requested horizon, or the API returns a validation error instead of a misleadingly unchanged stress-test comparison.

## Adversarial client-load invariants

- A delayed authenticated ledger response must never overwrite active unsaved input. If a user starts editing before loading completes, preserve their typed figures and fail closed with an explicit refresh request instead of silently replacing them.
- The no-future-income track must not claim any hypothetical same-day income credit. Conditional receipt timing warnings and their exact labels belong only to the income-including track.

## Dedicated adversarial CI gate

The pull request runs the fast-failing `Household Runway Adversarial Gate` independently from the long-running backend suite. It provisions isolated MongoDB 7 in replica-set mode, executes the deterministic engine and independent numerical oracle tests, and then the real authenticated owner-isolation/CAS/idempotency/tamper/recovery integration suite. A pass in this gate is necessary but not sufficient for production approval; full CI, staging and privacy requirements remain separately required.

## Off-by-one financial window defense

- `horizonDays` counts calendar dates **including** the confirmed `asOfDate`: `1` means today only; `395` ends at `asOfDate + 394 days`. Never reinterpret this as an exclusive offset.
- Version `runway-cashflow-1.2.0` is deliberately different from earlier engine versions because the previous end-boundary included an extra day. Historical snapshots retain their older engine version and are not silently recomputed as if calculated under the new calendar rule.

## Server-keyed snapshot integrity (red-team requirement)

- A raw SHA256 digest cannot establish snapshot authenticity when a database writer can change both result and checksum. Snapshots now include an HMAC-SHA256 seal binding owner, ID, ledger revision, input hash, request, output, output hash, and creation timestamp.
- The HMAC key is a **server-only secret** outside MongoDB: configure \`RUNWAY_INTEGRITY_SECRET\` to 64 or more hexadecimal characters produced by \`openssl rand -hex 32\` (32-byte minimum). This is not an LLM or paid external API key. Store it in the deployment secret manager; never expose it in Vite or commit it.
- Missing key, missing seal, or mismatched seal fails closed (503), including for explanations and idempotency replays. There is no checksum-only "verified" fallback.
- This is only tamper evidence against a *database-only* writer; it is not a substitute for access control, backup immutability, HSM-backed key custody, verified audit logging, or compromise recovery.
- **Deployment NO-GO** until key custody, rotation, rollback, and existing-snapshot sealing/migration have documented procedures. Rotating the key without a migration makes old snapshots unreadable; do not rotate casually.

## Owner-controlled data portability

- `GET /api/runway/ledger/revisions?page=0..20` returns at most 100 verified, owner-scoped ledger revisions per request (2048 total per account). It requires a recently issued valid session and returns `Cache-Control: no-store`. Corrupt historical revision hashes fail closed.
- The browser provides an explicit, warning-confirmed JSON export that checks the page count and refuses partial/stale downloads. The file is sensitive and stays on the user's device; no external exporter or paid API is involved.
- This exports **ledger revisions only**, not saved simulation snapshots, and is not a regulatory audit package. Snapshot detail retrieval is separately supported. Full account portability and backup-retention guarantees require a broader product review.
