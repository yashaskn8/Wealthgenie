# Production qualified equity history

This feature is independent of the localhost-only private demo path.

## Architecture

Qualified Upstox provider response -> identity/calendar/publication checks
-> provider/source-rights check -> transactional MongoDB persistence
-> authenticated retained-history API -> Where-to-Invest technical evidence panel.

The existing fetchQualifiedEquityHistory service is the sole ingestion source.
MongoDB MarketEquityDailyBar stores only already-qualified daily observations.

Unique identity: provider, exchange, ISIN, price basis and trading date.
New records use Upstox provider-native daily OHLC only. Existing historical
records from the retired provider are preserved in MongoDB for recovery but
are excluded from the active read path. Each record retains the actual
source request URL(s), all qualifying calendar/identity/publication URLs,
observation basis and fetch timestamp. A batch identity and coverage window
allow the read API to reject a partially committed or overwritten series.

## Operator rollout

Production-public data rights must cover every endpoint and applicable
access, extraction, storage, derived use, display and commercial/redistribution
scope. A working read-only key is NOT evidence of those grants.

1. Keep defaults: MARKET_EQUITY_HISTORY_STORE_ENABLED=false and
   MARKET_EQUITY_HISTORY_RETENTION_DAYS=0 until permissions/retention are confirmed.
2. With server/.env/secret manager configured for your transaction-capable MongoDB,
   run from server directory: node scripts/ensureQualifiedHistoryIndexes.js
   This additive migration never drops previous indexes or data.
3. Supply an approved retention period of 1-365 days and enable the store only
   after Upstox permits the exact storage and downstream-use scope. A read-only
   Analytics Token alone does not authorize durable storage or commercial use.
   Retention starts at the provider fetch time; replaying a snapshot cannot
   extend its deadline. MongoDB must support transactions.
4. Authenticated admins explicitly request ingestion via
   POST /api/market-data/admin/equity-history/ingest
   JSON body:
   {"exchange":"NSE","symbol":"RELIANCE","isin":"INE002A01018",
    "fromDate":"2026-10-08","toDate":"2026-10-09","basis":"RAW"}
   CSRF, auth, role and rate limits apply. Provider fetches have a 366-day cap.
5. Ordinary authenticated users query already-qualified authorized observations
   through GET /api/market-data/equity-history/persisted with the same query
   parameters; no GET triggers third-party ingestion or durable writes.
   A requested subset is returned only after the entire source batch is checked
   for completeness. Reads recheck every source URL used for qualification.
6. Where-to-Invest > Technical details > Verified prices and saved history
   shows retained benchmark observations and daily price tables. The quote
   panel uses authenticated `GET /api/market-data/quotes/persisted` and never
   fetches a provider as part of that GET.

Benchmark quote retention is independently disabled by default. Once the
exact quote endpoint has authorized storage/display rights, run
`npm run market:ensure-benchmark-quote-indexes --prefix server`, set
`MARKET_BENCHMARK_QUOTE_STORE_ENABLED=true`, and set
`MARKET_BENCHMARK_QUOTE_RETENTION_SECONDS` to an approved value from 1 to
86400. The additive migration creates a latest-quote read index and a TTL
index. Quote writes preserve their first observation and cannot silently
replace a different price under the same provider/observation identity.

Optional scheduled ingestion uses `MARKET_EQUITY_HISTORY_TARGETS`, a JSON array
of at most ten `{exchange,symbol,isin,basis}` objects. Only `basis: "RAW"` is
accepted; the stored basis is labeled `UPSTOX_PROVIDER_NATIVE`. It runs once daily at
23:00 IST under a Redis lease and ingests a bounded seven-calendar-day window
serially. It is inactive unless the store is enabled and a nonempty allowlist
is configured. Every scheduled fetch still passes the normal source-rights,
identity, calendar, publication, index and transaction gates. Failed runs
report bounded error codes and leave previously retained records untouched.

## Fail-closed behavior

- All source URL rights are re-evaluated for each read. Rights revocation hides
  records immediately even if TTL cleanup has not run.
- Reads filter out retainedUntil timestamps in the past. TTL removes expired
  rows afterward.
- Missing, malformed, incomplete or future-dated source responses are NOT saved.
- Source differences, price basis, dates and instrument identity are never
  silently conflated. A source change never invents a price.
- A MongoDB outage surfaces as unavailable; Redis is not a market-data authority.
- Production recommendations, suitability, post-tax calculations and portfolio
  allocations remain unchanged.
- The customer-facing UI never holds provider API credentials.

## Tests

From server directory:
node --test test/qualifiedEquityHistoryStore.test.js

Full backend, frontend and production-edge integration CI plus real authorized
provider/account E2E evidence are required before a production release.
This repository change does not claim licensing permission or live E2E success.
