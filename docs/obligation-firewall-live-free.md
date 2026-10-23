# Obligation Firewall — free responsive cash monitoring (CSV-first)

## Scope and truthful claim

This design uses the existing React frontend, Express API and MongoDB. It does **not** connect to banks, scrape internet banking, acquire live financial data, buy a data feed, send paid notifications or depend on LLM APIs. "Responsive" means saved ledger changes propagate between open browser tabs and visible sessions recheck periodically (about 45 seconds). It is not bank streaming or guaranteed background delivery.

The authoritative calculation is the existing 90-day exact integer-paise backend engine. A locally uploaded CSV never directly mutates the ledger.

## End-to-end data path

1. A user explicitly selects a .csv in their browser (at most 512 KiB); PDFs/Excel are unsupported. There is no CSV upload endpoint.
2. The client validates CSV quoting, at most 1,500 rows, exact INR decimals, unique column meaning, day-first India or ISO calendar dates and non-future transactions.
3. The UI shows a bounded report: the first and last transaction dates, source freshness, optional file-reported balance, a maximum of 20 recent same-day debits for double-count review, and up to 20 candidate recurring future payments. A file-reported balance is never called verified live bank cash.
4. Recurrence candidates require at least three consecutive monthly debits (with a consistent description, exact amount and day) or four exact weekly debits. Only recent observations are considered. Credits do not become guaranteed future income.
5. The user explicitly classifies each proposal, clicks to add an unsaved draft entry, checks for duplicates, and reconfirms the complete obligations declaration. Historical debits are not silently copied as future bills; no payment, transfer, SIP cancellation or investment order is performed.
6. An explicit save goes through the existing authenticated, CSRF-protected PUT /api/coverage/ledger API, using revision If-Match and a stable idempotency key. Only the backend calculates and atomically persists the ledger/result.
7. Successful saves or deletions publish only a nonsensitive revision-changed signal through BroadcastChannel. Tabs refetch their own authenticated records and preserve unsaved edits with a conflict review. Other visible sessions poll every 45 seconds and check on tab refocus. No identities, balances, narrations or raw CSV rows are published in messages.
8. Existing private history export, delete, historical policy and no-store protections remain in force. Discarding an import review or leaving the component disposes its suggestions; the full raw transaction list is not retained in application state.

## Supported sample file

Date,Description,Debit,Credit,Balance
2026-08-15,Apartment rent,18000.00,,82000.00
2026-09-15,Apartment rent,18000.00,,64000.00
2026-10-15,Apartment rent,18000.00,,46000.00

Dates use YYYY-MM-DD or DD/MM/YYYY only (slash dates always day-first). Each row has exactly one positive debit or credit; absent direction is blank. Exact decimal rupees accept at most two fractional digits and correctly grouped thousands. Quoted descriptions and CRLF are supported. Ambiguous formats, invalid dates, duplicate transaction references, future completed movements and overlong content fail closed.

An on-date debit may already be reflected in the opening cash. The UI warns the user about possible double counting but cannot reliably infer bank settlement order, so it never automatically adjusts balances or removes future entries.

## Free dependencies and honest limits

- The parser and browser notification signal need no paid external API. Domain, cloud, Mongo/Redis hosting, backups and operational resources may still have costs.
- There is no Account Aggregator or FIU integration. Free AA sandboxes are not licenses to retrieve real customer financial data.
- The app does not observe a transfer that happens while the user is offline and cannot promise instant bank data, bill-fetch integration, SMS alerts, mobile push, or 24-hour automatic monitoring.
- Three matching debits are evidence of past activity, not proof of future liability. Users must still confirm next due date, type, and affordability assumptions.
- Raw CSV rows are parsed in browser memory only. A bounded selection of narration/amount suggestions may remain in React state during an active review; no raw file or transaction history is uploaded or sent to an LLM.
- Deleting saved entries does not certify that separately managed backups are erased immediately. Validate deployment retention/backup policies and applicable privacy regulations before any public launch.

## Required release gates

- Strict malformed-data, date, decimal, duplicate and resource-cap tests.
- React tests that import never writes to the server before an explicit user save, proposal classification is required, and all future amounts remain exact paise.
- Desktop and narrow-mobile Chromium browser tests for local import, review, save, export, deletion and layout.
- Backend Mongo replica-set CAS, idempotency, ownership, rollback and policy upgrade tests.
- Run all three targeted coverage CI jobs plus the complete five-job repository CI on the final commit.
- Perform an independent privacy, accessibility, security, operational performance, backup and legal review before enabling production feature flags.

## Later qualified live data (not included)

Future permitted AA/FIU integration requires a separate verified onboarding, purpose-specific consent and revocation, refresh-frequency contract, evidence timestamps, signed callbacks, deduplication, source reconciliation, rights qualification and retention controls. Do not substitute an LLM or a scraped banking website for regulated access.

## Red-team safety rules for statement balances and session expiry

The unverified file-reported balance may only be displayed when all rows include numeric balances and chronological row-to-row debit/credit deltas reconcile (or there is only one row). Both ascending and descending date order are supported, but ambiguous or inconsistent files suppress any balance number. Duplicated same-signature debits on the same date cannot establish recurrence. Possible bank references (runs of six or more digits) and email addresses are redacted from candidate labels before they can be saved. The 20 earliest prospective due dates are selected after globally ranking all proposals, rather than from statement row order. Session loss (401/403) during refresh clears private saved values, imported review, and calculated outcomes. Other network errors hide positive cash results until revalidation.

Strict due-date derivation requires an original calendar-day anchor that is exactly consistent across historical observations, permitting actual month-end clamping only. A payment processed two days late is not reliable evidence that its contract is due two days later. During refresh, a changed saved input hash causes a reload even when the revision number matches, reducing the risk of showing prior-account data after a session/account change; imported review material is discarded on changed source identity. This fingerprint is from the authenticated ledger, never from CSV narration.

An in-flight local CSV read is explicitly invalidated on logout, a changed saved-account input hash, deletion or component unmount; its late promise may not repopulate a later account's import review. This prevents stale asynchronous file content from leaking across authentication changes even though the CSV is browser-local.

The Cash Check component is also keyed to the authenticated user ID in the dashboard shell, so React forcibly unmounts it (clearing private draft/import state and cancelling pending CSV reads) when the connected account changes—even if both users happen to have the same saved ledger revision and input hash. Server-side ownership checks remain the authoritative security boundary.


## Durable in-app cash risk alerts and one-time commitment settlement

The browser-independent implementation adds \`CoverageRiskAlert\`, \`CoverageSettlement\`,
\`coverageRiskPolicy\`, and an opt-in \`coverageRiskAlerts\` worker.

**Cash-risk event correctness**
- A confirmed saved ledger produces a new in-app alert only when a possible shortfall first appears, its earliest date or exact minimum balance changes, or the prior shortfall is resolved. A normal no-shortfall forecast does not create a reassuring "guaranteed safe" notification.
- The minimal alert record holds owner, unique event identity, revision, policy kind, cash-as-of day and optional risk date. It never stores bank account numbers, statement narrations, passwords or external push payloads.
- \`GET /api/coverage/alerts?limit=20\` returns only the authenticated owner's **current-revision** alerts, with \`Cache-Control: no-store\`; \`PATCH /api/coverage/alerts/:id/ack\` is owner-scoped and naturally idempotent. Acknowledgement never initiates payments or changes financial inputs.
- All risk records are transactionally written/superseded with the cash snapshot and idempotency receipt. Injected event-storage failures must roll back the entire ledger revision. Explicit cash deletion atomically removes risk alerts and settlement history.
- Old cash is never used by a background worker to calculate a new financial forecast. Instead, its only duty is to notify the user that the opening cash declaration must be reconfirmed. Multiple instances are protected by unique alert identities, optimistic ledger revision fencing and transactional writes.
- \`COVERAGE_ALERT_WORKER_ENABLED=true\` is an **opt-in** server setting and is active only with \`COVERAGE_ENABLED=true\`. It scans up to 100 candidate ledgers per bounded iteration (default 60 seconds), using an index and cursor; it does not require Redis, third-party queues, an LLM or external messaging providers. Its current implementation is an **in-app** durable notifier, NOT push/email/SMS. Worker shutdown drains its in-flight Mongo operation before closing connections.

**One-time settlement correctness**
- A one-off commitment can be marked settled only through explicit user attestation, its saved entry ID, quoted If-Match revision, durable Idempotency-Key, a freshly declared **post-payment** accessible cash balance, and confirmation of remaining obligations.
- The server rejects automatic settlement of recurring obligations or expected income. It removes the single confirmed settled obligation from the **new revision** while retaining the original immutable prior snapshot, and writes an owner-only \`CoverageSettlement\` event with the attestation. This is user-declared, **not bank verified**, and cannot be used as a claim that a bank transfer succeeded.
- \`GET /api/coverage/settlements\` shows up to the latest 20 audit entries. Settlements are deleted when the underlying user's cash plan is erased. Network retries reuse the same operation identity, avoiding duplicate settlement revisions.
- For manual/CSV reconciliation, a matching settled debit is a *suggestion for review*, never automatic bank evidence. Removing one-off planned outflows without reconfirming post-payment cash is prohibited because it would double count available money.

**Explicit index migration / launch sequence**
1. Keep production flags off. Run the standard \`migrate:phase2-indexes\` one-shot deployment migration using an authorised \`MONGODB_MIGRATION_URI\`, followed by read-only index verification and backup-restore preflight. This provisions unique owner/event identities and the staleness-scan index.
2. Run the targeted coverage safety GitHub Actions workflow (engine, real Mongo transactions, React, Chromium desktop/mobile) and the entire repository CI on the **same exact commit**.
3. Validate authenticated cookie-CSRF sessions and cross-user isolation, API latency/availability, Mongo majority writes and replica-set failover on production-like infrastructure. Test rollback for missing event and settlement storage plus duplicate worker execution.
4. Privately enable \`COVERAGE_ENABLED=true\` and \`VITE_COVERAGE_ENABLED=true\` for a controlled test environment only, with logs excluding financial details.
5. After separate review, enable \`COVERAGE_ALERT_WORKER_ENABLED=true\` on an authorised backend process. The unique index makes concurrent workers safe, but additional worker instances raise database load.
6. Launch only after establishing encryption/key management, retention/deletion and backup policy, user-support procedures, accessibility, measurable SLOs, load and disaster-recovery evidence, and applicable Indian privacy/financial-law approval.

**Remaining intentional product limits**
- The current saved-snapshot capacity is 256 revisions per account. An approved privacy-sensitive archival/retention strategy is required before advertising indefinite use; do not silently delete historical financial records to bypass the cap.
- There is no production AA/FIU banking integration, externally verified transactions, UPI payments, credit-card/BBPS bill retrieval, push notifications or investment execution. Making claims about these features without authorised providers would be misleading.
- A browser-only CSV comparison cannot establish that a payment actually settled; the attestation is user-provided, and the updated balance must be reconfirmed.
- "Production grade" additionally requires measured deployment, security, backup and regulator-dependent evidence—not solely passing source-code tests.

## Red-team refinement: midnight, stale alerts and committed safety

Committed one-off settlement retries retain their bank-unverified settlement semantics and owner-scoped immutable attestation; date freshness is enforced only for new mutations *after* idempotent replay. Risk alerts based on a cash declaration older than the current India date are withheld, leaving only reconfirmation messages. Cash revision and deletion transactions explicitly use snapshot reads and majority writes. The live OpenAPI contract harness must mount the protected coverage routes so that authentication coverage is actually exercised.

## Policy upgrades and persistent alerts

When the active 90-day calculation policy changes, the in-app alert endpoint no longer presents shortfall warnings generated under a retired policy as if they were current. It signals `requiresPolicyReconfirmation` and only permits dated cash-reconfirmation notifications. Attempts to acknowledge historical shortfall warnings while their underlying model is retired are rejected; the signed-in user must reconfirm cash and save a new active-policy result first. Historical result exports remain available without silently rewriting financial conclusions.

### Stale notices and model upgrades: alert matrix
A dated cash-reconfirmation event remains durable after its original creation, but the inbox must not present it after today's opening cash has been explicitly reconfirmed. The inbox mutually excludes unverified-risk warnings while cash is stale, suppresses *all* policy-derived events while a current-day plan's policy is retired, and allows only current risk transitions for a fresh current-policy plan. Alert acknowledgements must use exactly the same eligibility predicates, so a hidden stale warning cannot be acknowledged through a guessed URL.

### User-reviewed reconciliation from a statement
When a browser-local debit dated today has exactly one match among already saved one-off cash obligations by exact date and paise amount, the interface offers to open the existing settlement confirmation form. It does not assert this bank line is verified, does not mark a recurring obligation paid, does not auto-select when there are duplicate matches, and never posts a settlement until the user separately attests the payment and enters current accessible cash after it. This is a workflow aid, not automatic reconciliation with a bank.

### Historical data deletion/revision race fencing

Owner-scoped export and individual historical revision reads first verify an existing, non-deleted current cash ledger; they cannot disclose orphaned financial snapshots after a deleted/nonexistent ledger. Pagination only includes revisions at or below the initially observed current revision. A second exact owner/revision/deleted-state check prevents returning a mixed result after a concurrent save or deletion. A stale request fails as a conflict rather than presenting possibly erased records as current. This does not replace encrypted backup-retention and production privacy validation.

### Startup index-readiness gate

When `COVERAGE_ENABLED=true`, the backend now checks the exact required unique indexes for the current cash ledger, immutable results, deletion receipts, owner-scoped risk alerts, settlement receipts and idempotency operations **before** reporting startup readiness. When `COVERAGE_ALERT_WORKER_ENABLED=true`, it additionally checks the `{ 'input.asOfDate': 1, _id: 1 }` scan index by name and refuses worker-only misconfiguration without the underlying feature. All checks are read-only; apply the documented one-shot MongoDB migration first. A missing index causes startup failure rather than a deployed but broken cash feature. In the default disabled mode the new checks are skipped.

### Low-cost background sweep cadence
The Mongo alert worker processes at most 100 stale declarations per pass and resumes unfinished cursor pages on successive scheduler ticks. After it finishes the day's complete scan, later ticks on the *same India calendar date* do not re-read the entire user population; the next India day starts a new scan. Failed batches are retried without marking the day complete. Deploy the opt-in worker only on a designated worker process (not every API replica), with a monitored index and bounded Mongo capacity. App ledger mutations still write their new risk events transactionally and do not depend on the sweep.

### Mutation-derived personal data after cash deletion
A cash-data deletion now atomically purges prior `coverage.ledger.replace` and `coverage.commitment.settle` idempotency records, whose request hashes can be derived from private amounts, alongside the ledger snapshots, risk alerts and settlement history. The anonymous ledger revision tombstone still prevents an old write replay from resurrecting the deleted cash plan. The minimal `coverage.ledger.delete` operation and nonfinancial deletion receipt must survive to support a lost-response delete retry. Backups and external log retention remain subject to separate operational deletion policy.
