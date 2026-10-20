# Market-data permission review

Status: **API capabilities documented; account entitlement and production-use qualification remain unverified**. This register supplements `postTaxSourceRights.js`. It does not grant access or change any runtime gate.

## Decision for each exact endpoint

The inactive second-provider adapter was removed from runtime code. Its historical review remains in Git history and the recovery ledger; it is not an active market-data source or fallback. The current endpoint decisions below concern Upstox only. A working Analytics Token establishes technical access, but does not by itself establish retention or commercial display rights.

| Provider | Endpoint represented in source register | Capability | Account tier / limits | Rights decision |
| --- | --- | --- | --- | --- |
| Upstox | `GET /v3/market-quote/quotes` | V3 quote snapshot for exact NIFTY 50, India VIX and Nifty 50 BeES ETF identities | Read-only Analytics Token has returned genuine responses in local development | Narrow authenticated loopback educational preview only; storage and commercial/public distribution remain unverified |
| Upstox | `GET /v3/historical-candle/{instrumentKey}/days/1/{toDate}/{fromDate}` | Daily historical candles | Actual account entitlement unverified | All use dimensions unverified |
| Upstox | `GET /v2/market/holidays` | Current-year holidays and special sessions | Actual account entitlement unverified | All use dimensions unverified |
| Upstox | `GET /v2/market/timings/{date}` | Session times for a date | Actual account entitlement unverified | All use dimensions unverified |
| Upstox | `GET /v2/market/status/NSE` | Current exchange phase | Actual account entitlement unverified | All use dimensions unverified |

Review the concrete URL and query scope in `marketDataSourceUrls.js` and the exact match decision in `postTaxSourceRights.js` for any proposed deployment. Provider reference documents: [Upstox V3 quotes](https://upstox.com/developer/api-documentation/get-full-market-quote-v3/) and [Upstox market status](https://upstox.com/developer/api-documentation/get-market-status/). Published capability and quota are not proof of downstream reuse rights.

## Three distinct operating scopes

1. **Synthetic fixtures:** `NODE_ENV=test` with the injected fixture capability. No provider network, credential, live data, or public production output. Ordinary CI belongs here.
2. **Private local educational preview:** the authenticated loopback development route can make bounded, uncached Upstox V3 quote reads under its exact narrow source-rights scope. The separate broad qualification scripts remain blocked by `assertMarketDataQualificationRights` pending their required endpoint permissions. No storage or redistribution is inferred.
3. **Public production display and derived use:** currently blocked by `evaluateMarketDataProductionRights` and the Upstox public-distribution gate. Requires affirmative documented rights for every dimension above, exact source URL, deployment environment, consumers, scope, effective date, authority, and account tier. Then review the source register and flags through a separate approved change.

Before any activation, the operator should attach written provider evidence for each endpoint, specify allowed data subjects and consumers, quota/reset/retention terms, and review the actual private provider response without copying credentials or user financial records into an issue. Keep all flags false while evidence is missing. No account subscription or terms acceptance is part of this review.

## Product boundary

The qualified Upstox quote registry contains NIFTY 50, India VIX and one exact-identity ETF. The ETF preview is last-traded price evidence and cannot become its expected return or change ranking. Equity history can be requested only with exact exchange/ISIN identity and qualified completed-session evidence. Mutual-fund NAV, official deposit/savings rates, and RBI bond facts retain their separate source authorities and permissions. Unsupported products remain unavailable.
