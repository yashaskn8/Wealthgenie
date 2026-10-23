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

## Ledger provenance red-team finding

- Immutable **ledger revisions** now also have server-held, purpose-separated HMAC-SHA256 seals binding owner ID, revision, original self-reported ledger, its input hash, and confirmation timestamp. The active ledger, historical export, mutation replay, and snapshot source all reject forged ledger seals.
- Saved-result listing metadata is checked against its HMAC seal before publication; no forged database row may be labeled as a current result.
- Any records created with pre-sealing experimental code lack required seals and need an explicitly approved migration or deletion before release; there is no silent unsigned compatibility mode.

## Full owner-controlled export

- `GET /api/runway/export/snapshots?page=0..4` exports at most 20 owner-scoped snapshots per page (maximum 100), with server-side HMAC validation, sealed original ledger provenance, and current-engine recomputation when possible. Recently issued authentication is required.
- The browser's private JSON export now includes **all retained ledger revisions and saved scenario snapshots**, not just ledger entries. It checks each response's format, total and bounds and refuses incomplete downloads.
- This is portability of application-held user declarations, not a bank-confirmed financial evidence archive; backup expiry, secure handling on the end-user device, and legal retention obligations require separate approvals.

## Replay after deletion and pointer-rollback red-team controls

- Individually deleted snapshots leave a tiny owner-scoped ID tombstone (hash ID, owner ID, deletion timestamp; no financial amounts). In-flight retries with a previously deleted `Idempotency-Key` return `RUNWAY_SNAPSHOT_DELETED`, not a recreated record. Creation and individual deletion both write the owner state inside MongoDB transactions to serialize races.
- A full Runway data deletion removes these tombstones as well. Preventing an authenticated client from deliberately re-entering old data after a full erasure would require a separately governed account-lifecycle generation policy; do **not** represent full erasure as revoking all future authenticated writes.
- Read paths check the current ledger pointer against the latest persisted immutable revision; rolling it back to a previously signed revision fails closed with `RUNWAY_REVISION_POINTER_INVALID`. This detects pointer rollback, but not a fully compromised signing key, deletion of the entire revision history, or a malicious system administrator.

### Bounded tombstone retention

- Individually deleted snapshot replay markers expire automatically after 45 days using a MongoDB TTL index (`runway_deleted_snapshot_ttl`), preventing unbounded accumulation. This TTL must be migrated before enabling Runway; writes fail closed if it is missing.
- Idempotency replay protection for an individually deleted snapshot is **45 days**, not forever; tokens and clients must not retry old mutation keys beyond that period. Account-wide deletion clears the markers immediately. This is metadata retention requiring sign-off under the product's privacy policy.
- The transaction-level ledger state and latest immutable revision reads are serialized on the Mongo session; running `Promise.all` on one transaction is prohibited.

## Idempotency provenance and listing integrity

- Ledger idempotency receipts are untrusted database pointers. A replay must verify the signed revision's input hash equals the **exact original request ledger**, and that its number is the expected predecessor plus one. Retargeting a receipt to a different valid signed revision fails with `RUNWAY_RECEIPT_INTEGRITY_INVALID`.
- The saved-result listing now invokes full result-source verification, including source-ledger seal and current-engine recomputation, before designating a snapshot `CURRENT`. A signed snapshot with a corrupted source ledger fails closed even on the metadata-only list.

## Fail-closed feature startup and health

- When `RUNWAY_ENABLED=true`, server startup verifies the server-side HMAC secret and the exact persisted revision-uniqueness, snapshot-query and deletion-TTL Mongo indexes **before binding the HTTP port**. It does not create indexes or substitute a signing key automatically.
- `/health/ready` repeats this independent check while Runway remains enabled; loss of a key or required index yields HTTP 503 instead of a falsely healthy deployment. Feature-disabled replicas bypass the Runway-specific gate without changing the rest of WealthGenie.
- CI has negative and positive readiness tests; operators must independently test rollout, key placement, automated rollback and database migration ordering under their real deployment environment.

## Final release acceptance matrix (independent evidence required)

A green unit test is **not** a production certificate. Do not promote or enable this feature until the responsible operator has recorded evidence for the exact release commit:

1. **Deterministic truth:** independent arithmetic oracle, leap/month-end, bounds, same-day uncertainty; never fabricate live bank balances
2. **Auth and privacy:** owner isolation, CSRF, Redis revocation, no-store, recent-session exports and deletion/replay tests against real Mongo and HTTPS
3. **Integrity and durability:** signing key in a dedicated secrets manager, encryption, secure backup/restore rehearsal, TTL migration, retention and key rotation compatibility
4. **Concurrency:** CAS, snapshot create/delete races, idempotency replay and tampering/rollback attack tests against a real replica set
5. **UX:** feature-enabled desktop/mobile browser E2E, accessibility, network failures, India midnight, large exports and clear financial uncertainty labels
6. **Operations:** feature-enabled health readiness, alerts, metrics, incident rollback/kill switch, load/soak tests and operational ownership
7. **Governance:** self-declared data, privacy/erasure/legal retention and financial-advice scope reviewed for target users

**Rollback:** retain disabled backend and frontend feature flags until all gates pass. Never remove the signing key to roll back because existing signed ledgers would become unreadable. Migrations must use scoped credentials against the intended Mongo database.

- Latest statement ordering uses the signed `importedAt` timestamp, **not** unsigned Mongo `createdAt` metadata, to prevent a database-only timestamp edit from silently changing which observation appears newest.

## User-controlled settlement reconciliation

Owner-only GET /api/runway/live/matches displays unique exact same-day one-time matching proposals. Ambiguous matches are rejected (including duplicated CSV rows, same-amount ledger entries and matching rows from multiple uploaded sources). POST /api/runway/live/settlements, with a recent session and an Idempotency-Key, requires explicit cash reconfirmation and writes a new signed immutable ledger revision, a signed audit receipt and an event atomically. It never derives the household balance from a single uploaded account. Recurring bills and future-dated entries cannot be auto-settled. GET /api/runway/live/settlements returns HMAC-verified, cross-checked, owner-scoped audit receipts. Full Runway data erasure also deletes settlement receipts. These records remain user-reported, not bank-verified, and require real bank consent/authorization for any future bank connector.

Settlement history is capped at 500 signed records per owner and exported in at most 20 pages of 25. The private export now includes this audit history. A 409 at this cap is a deliberate protection against unbounded personally sensitive audit records; administrators must establish an approved archival/export lifecycle before raising it.

## Red-team controls for repeated posted rows and missed events

- Every user-confirmed settlement row now has an independently migrated Mongo unique index on `(userId, statementId, rowIndex)` and is rejected before writes if already consumed, even after manually reintroducing the same bill in a later ledger revision. A deleted import does not remove the minimal signed settlement record. A different upload with altered content/label can still evade this identity; independently verified provider transaction identifiers are required for cross-import guarantees.
- Mongo event ObjectIds do **not** guarantee commit-order delivery across multiple writers. React performs a full source and forecast refresh at least every 60 seconds while visible and on focus, recovering from missed cursor events. This remains near-real-time best-effort polling, not a durable server alert worker.
- A successful settlement is acknowledged before optional UI refresh. Failed secondary reads must never cause the browser to claim that the financial write failed or generate a different idempotency key.
