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
