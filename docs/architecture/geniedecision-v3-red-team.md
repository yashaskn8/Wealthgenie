# GenieDecision V3: adversarial release assessment

This is a release-gate checklist, **not** a production certificate.

## Implemented scope
Authenticated, owner-scoped financial scenarios and a React Decision Lab; exact-paise household cash ledger; house-vs-rent, major-expense financing, income interruption, debt-prepay-vs-invest decisions; versioned MongoDB scenario revisions, bounded immutable calculation snapshots, idempotent mutations and report history. No market returns, APR quotes, tax facts or property appreciation are inferred. Missing profile inputs fail closed. Financial and scenario revision changes mark historical reports.

## Red-team concerns tested or defended in code
- Owner B requesting owner A's scenario, history or report: respond 404
- Reused idempotency key with altered payload: reject without creating new scenario or report
- Concurrent edit/evaluation: Mongo transaction plus compare-and-swap scenario revision and run-generation
- Read of persisted report with corrupted numerical result: reject with integrity-failure error
- Goal double funding, irreconcilable household budget and non-amortizing debt: reject
- Cash shortfalls: show the first unfunded month; never silently imply an approved overdraft
- After debt is paid off: stop redirecting additional investment money to the cleared loan
- Quotas: at most 50 saved scenarios per user, 200 revisions per scenario, 20 report snapshots per scenario
- Browser selection race: discard outdated scenario loading replies

## Production deployment and release blockers
1. All checks on the **latest** PR head must pass (financial/backend, integration/security, React tests/build, data rights/migrations). A green prior commit is not sufficient.
2. On the deployment's authorized MongoDB replica set, run `npm run decision:migrate-indexes --prefix server` with `MONGODB_MIGRATION_URI`. Verify unique owner/idempotency/slot/revision keys before enabling write traffic. Request handlers must never create indexes.
3. Independently verify end-to-end browser operation: create, edit, evaluate, stale financial state, report history, delete, cross-owner denial, quota, concurrent edit/evaluate, and failure/retry. Retain evidence.
4. Security review: cookie/CSRF handling, logging redaction, personally identifiable financial data, backup, retention, runtime bounds, disaster recovery and rollback.
5. Confirm tax rules, lending terms, product data sources, contractual rates, data display rights and property market facts **before** adding these to user-facing conclusions. Current numerical outcomes are labeled illustrative / PARTIAL.
6. Obtain independent numerical validation rather than relying only on the same implementation's own expected values.

## Safety and scope boundaries
No portfolio writes, transactions, API-key dependency, or unconsented disclosure of sensitive finances to free-tier LLM providers. No claim of verified future returns, asset valuation or regulated financial advice.


## Signed decision records (security hardening)
New scenario revisions and published reports carry domain-separated HMAC-SHA256 integrity receipts bound to owner, scenario, profile facts, source input fingerprint, revision, and report hash. Integrity verification is fail-closed on reads and replays. This prevents a database-only attacker from forging accepted financial values by recalculating the previous ordinary SHA-256 hash; it does **not** protect against compromise of the service signing key, malicious application code, or replay of an entirely valid older database snapshot.

**Mandatory production deployment secret:** Set `GENIEDECISION_INTEGRITY_KEYS` as a JSON object of key IDs mapped to cryptographically random, minimum 32-byte hex secrets, and set `GENIEDECISION_ACTIVE_KEY_ID` to one of the IDs. Generate each key in a trusted secrets manager, not in Git. Example environment *shape* only (do not paste literal dummy keys into production):
```
GENIEDECISION_INTEGRITY_KEYS='{"v1":"<64+ hexadecimal characters from a CSPRNG>"}'
GENIEDECISION_ACTIVE_KEY_ID=v1
```
The production API refuses to issue receipts if the dedicated key configuration is unavailable or invalid. Only local development/test may derive a domain-separated signing key from `JWT_SECRET`. The system does not automatically migrate existing unsigned records: determine whether any unsigned data exists before release; require migration/quarantine rather than silently trusting unsigned records.

**Rotation:** Add `v2` alongside `v1`, set `GENIEDECISION_ACTIVE_KEY_ID=v2` to sign new records, and continue retaining `v1` in the verification key ring until all v1-signed data reaches a verified retention endpoint. Deleting old keys makes old receipts unverifiable and the read path fails closed. Back up key versions and test restore procedures. Never disclose keys through client responses or logs.

**Additional release limitations:** The database can still be rolled back to a complete, previously authentic state without an externally anchored append-only audit chain. For regulated or high-assurance deployments, add a separate immutable receipt/audit service with version-fenced checkpoints. Strict secrets management, operational rotation rehearsals, and an independent penetration test remain outstanding.
