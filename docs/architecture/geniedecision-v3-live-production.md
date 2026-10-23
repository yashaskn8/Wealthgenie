# GenieDecision V3 — near-real-time decision layer and release contract

## Implemented on feature/geniedecision-v3-20261023

**Scope is explicitly bounded.** The system now supports an authenticated owner-scoped live decision feed and ephemeral hypothetical cash-flow simulation. It does **not** claim a live brokerage-account connection, tick-by-tick personal net worth, live mutual-fund NAVs, bank aggregation, automated transactions, investment advice, or a licensed redistributable equity-price stream.

1. **Transactional owner events.** Create, edit, evaluate and delete commit an immutable minimal event envelope in the *same* MongoDB replica-set transaction as the financial mutation. Per-user atomic event sequences establish replay order. Idempotent HTTP replays do not create duplicate events. A 14-day TTL index bounds retention. Expired replay cursors produce an explicit RESET requiring a fresh owner-scoped read.
2. **Client push over SSE.** `GET /api/decisions/events/stream?after=0` checks the normal JWT/session cookie and streams `connected`, `decision`, `reset`, `profile-changed`, `heartbeat`, or `unavailable` notifications. All event bodies intentionally omit holdings, rupee values, names, PII and provider credentials. Per-pod limits: maximum 200 streams total, 2 streams per owner. A response is recycled after 30 seconds and credentials/account state are rechecked during its lifetime. Mongo-backed polling is 2.5 seconds and financial-profile fingerprint checking is 10 seconds: **near-real-time, not zero-latency trading infrastructure**.
3. **Browser update contract.** The React workspace uses authenticated fetch streaming (same-origin HttpOnly cookie in production), reconnects using persisted monotonically ordered cursors, detects stale or lost notifications, and revalidates account/profile/report state on reconnect. It must never overwrite a form with unsaved changes merely because another browser publishes an event. HTTP streams have a 15-second idle watchdog; the UI stops streams on unmount.
4. **Ephemeral preview.** `POST /api/decisions/simulate` reuses the same exact-paise deterministic core as a published run for all four decision types; it verifies both owner and canonical financial state before and after computing. Draft edits debounce for 650 milliseconds. Preview is clearly labeled `previewOnly` and **does not create a DecisionRun or a scenario, nor mutate investments**. Official versioned/signed reports still require Save then Evaluate.
5. **No third-party financial facts fabricated.** Market-data adapters and rights gates already present in the repository remain independently enforced. No new provider URL, rate, benchmark, tax premise or unsupported future return was introduced. The websocket trading feed (if licensed and available) is not synonymous with live financial advice.

### Durable event contract
```
GET /api/decisions/events?after=0
-> { events: [{sequence, type, scenarioId, scenarioRevision, createdAt}], latestSequence, resetRequired }

GET /api/decisions/events/stream?after=0
Accept: text/event-stream
Authorization: Bearer <private development token> OR production HttpOnly session cookie
event: connected      data: { latestSequence, updateMode, pollMilliseconds, profileCurrentness }
event: decision       id: 12 data: { sequence: 12, type: 'RUN_PUBLISHED', ... }
event: profile-changed data: { requiresRefresh: true }
event: reset          data: { reason: 'CURSOR_EXPIRED_OR_INVALID', latestSequence }
```
Clients must not trust these notifications as financial evidence. On receiving one, re-read the authenticated canonical API and verify the signed report status. The event feed guarantees eventual notification for committed decision mutations retained in the owner event log; profile-change notifications are detected by state-fingerprint polling and are **not** durable change-log records.

### Deployment prerequisites and red-team release gates

- Run the explicit Mongo index migration `npm run decision:migrate-indexes --prefix server` against the authorized replica set before accepting writes. Verify both new collections' indexes, including `uniq_decision_event_owner_sequence`, `uniq_decision_event_owner_order` and `decision_event_expiration` TTL. No request-time index creation.
- Supply production `GENIEDECISION_INTEGRITY_KEYS` and `GENIEDECISION_ACTIVE_KEY_ID` through a proper secret manager. Rotate without dropping verification keys still needed for retained reports. Never put credentials in the repo.
- All five GitHub CI jobs must pass on the *exact final feature-branch SHA*, including backend coverage and the dedicated Mongo transactional SSE test, React and integration checks.
- Test a staging deployment over the production reverse proxy/CDN: verify SSE isn't buffered, cookies work, session renewal and logout close/deny feeds, max concurrent connections, 100+ users, reconnection after network drop, Mongo failover, expired event retention, data deletion, and restoration from backup.
- Add operational observability for event outbox depth, commit-to-publish delay p50/p95/p99, heartbeat gaps, stream connection counts, failed replay count, profile change detection latency, and signed report integrity failures. Set alerts and measure SLOs; no unmeasured latency promise.
- **Multi-user live brokerage access is not implemented here.** To enable it, independently onboard a provider-approved app and per-user OAuth account connections with encrypted token vault, revocation, provider scopes, expiry handling, rate limits, audit logs, consent UX, and legally approved data display/storage/derived-use rights. An operator's personal Upstox token can never stand in for customers' consent.
- AMFI NAV updates are periodic and not intraday stock ticks; bank/account aggregator data depends on eligible consented integration. Unknown/failure states remain unavailable; never fill missing provider data with zero or fabricated returns.
- Before financial-production classification, perform an independent mathematical oracle comparison and specialist financial/compliance review. Unmodeled inflation, taxes, investment gains and product eligibility stay conspicuously disclosed.

### Online design references
- MongoDB change streams and replica-set requirements: https://www.mongodb.com/docs/v7.0/changestreams/
- Redis streams and recovery alternative for future worker scaling: https://redis.io/docs/latest/commands/xreadgroup/
- EventSource and SSE semantics: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
- Upstox customer OAuth 2.0: https://upstox.com/developer/api-documentation/authentication/
- Upstox market data V3 documentation: https://upstox.com/developer/api-documentation/v3/get-market-data-feed/
- AMFI published NAV download: https://www.amfiindia.com/net-asset-value/nav-download

The implemented version deliberately avoids a Redis dependency for event durability. Mongo's transactionally stored events and periodic indexed queries are simpler to audit for modest event volumes. If traffic grows enough to make polling expensive, migrate delivery to one **resumable, leased, checkpointed change-stream consumer per service pool** or to Redis Streams with the durable Mongo outbox as the authority; never use ephemeral Redis Pub/Sub as the only ledger of decision changes.
