# Production qualified equity history

This feature is independent of the localhost-only private demo path.

## Architecture

Qualified Upstox / TejHQ provider response -> identity/calendar/publication checks
-> provider/source-rights check -> explicit MongoDB persistence
-> authenticated retained-history API -> Where-to-Invest technical evidence panel.

The existing fetchQualifiedEquityHistory service is the sole ingestion source.
MongoDB MarketEquityDailyBar stores only already-qualified daily observations.

Unique identity: provider, exchange, ISIN, price basis and trading date.
Raw and adjusted prices remain separate. TejHQ EOD retains a trading DATE and
never fabricates an intraday trade timestamp. Each record retains the actual
source request URL(s), observation basis and fetch timestamp.

## Operator rollout

Production-public data rights must cover every endpoint and applicable
access, extraction, storage, derived use, display and commercial/redistribution
scope. A working read-only key is NOT evidence of those grants.

1. Keep defaults: MARKET_EQUITY_HISTORY_STORE_ENABLED=false and
   MARKET_EQUITY_HISTORY_RETENTION_DAYS=0 until permissions/retention are confirmed.
2. With server/.env/secret manager configured for your transaction-capable MongoDB,
   run from server directory: node scripts/ensureQualifiedHistoryIndexes.js
   This additive migration never drops previous indexes or data.
3. Supply an approved retention period of 1-365 days and enable the store.
   Existing TejHQ and Upstox source permissions must also be enabled
   correctly; this feature does not alter the licensing source-rights registry.
4. Authenticated admins explicitly request ingestion via
   POST /api/market-data/admin/equity-history/ingest
   JSON body:
   {"exchange":"NSE","symbol":"RELIANCE","isin":"INE002A01018",
    "fromDate":"2026-10-08","toDate":"2026-10-09","basis":"RAW"}
   CSRF, auth, role and rate limits apply. Provider fetches have a 366-day cap.
5. Ordinary authenticated users query already-qualified authorized observations
   through GET /api/market-data/equity-history/persisted with the same query
   parameters; no GET triggers third-party ingestion or durable writes.
6. Where-to-Invest > Technical details > Verified prices and saved history
   shows provider-backed benchmark quotes and retained daily price tables.

## Fail-closed behavior

- All source URL rights are re-evaluated for each read. Rights revocation hides
  records immediately even if TTL cleanup has not run.
- Reads filter out retainedUntil timestamps in the past. TTL removes expired
  rows afterward.
- Missing, malformed, incomplete or future-dated source responses are NOT saved.
- Source differences, raw versus adjusted basis, dates and instrument identity
  are never silently conflated. A source change never invents a price.
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
