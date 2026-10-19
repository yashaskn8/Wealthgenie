# Market-data permission review

Status: **operator evidence required; no live production qualification**. This register supplements `postTaxSourceRights.js`. It does not grant access or change any runtime gate.

## Decision for each exact endpoint

For every row below, the repository has **no approved record** for access, private/internal analysis, automated extraction, retention/cache, derived calculations, public display, commercial use, or redistribution. Account tier, approval authority, effective date, permitted environment, permitted consumers, and a signed evidence document are also **unverified**. The runtime's `LICENSE_UNVERIFIED` status is therefore correct. An API response, token, documentation page, or feature flag cannot change this decision.

| Provider | Endpoint represented in source register | Capability | Account tier / limits | Rights decision |
| --- | --- | --- | --- | --- |
| Upstox | `GET /v3/market-quote/quotes` | V3 quote snapshot | Actual account entitlement unverified | All use dimensions unverified |
| Upstox | `GET /v3/historical-candle/{instrumentKey}/days/1/{toDate}/{fromDate}` | Daily historical candles | Actual account entitlement unverified | All use dimensions unverified |
| Upstox | `GET /v2/market/holidays` | Current-year holidays and special sessions | Actual account entitlement unverified | All use dimensions unverified |
| Upstox | `GET /v2/market/timings/{date}` | Session times for a date | Actual account entitlement unverified | All use dimensions unverified |
| Upstox | `GET /v2/market/status/NSE` | Current exchange phase | Actual account entitlement unverified | All use dimensions unverified |
| TejHQ | `GET /v1/ohlcv/{exchange}/{symbol}` | Raw EOD | Actual account entitlement unverified | All use dimensions unverified |
| TejHQ | `GET /v1/adjusted/{exchange}/{symbol}` | Adjusted EOD | Actual account entitlement unverified | All use dimensions unverified |
| TejHQ | `GET /v1/symbols/{exchange}?isin=...` | Symbol history | Actual account entitlement unverified | All use dimensions unverified |
| TejHQ | `GET /v1/actions/{symbol}` | Corporate actions | Actual account entitlement unverified | All use dimensions unverified |
| TejHQ | `GET /v1/status` | Publication status | Actual account entitlement unverified | All use dimensions unverified |

The table lists exact endpoint families known to the code. Review the concrete URL and query scope in `marketDataSourceUrls.js` and the exact match decision in `postTaxSourceRights.js` for any proposed deployment. Provider reference documents: [Upstox V3 quotes](https://upstox.com/developer/api-documentation/get-full-market-quote-v3/), [Upstox market status](https://upstox.com/developer/api-documentation/get-market-status/), [TejHQ API](https://tejhq.dev/docs), [TejHQ keys](https://tejhq.dev/keys). Published capability and published quota are not proof of the account's rights.

## Three distinct operating scopes

1. **Synthetic fixtures:** `NODE_ENV=test` with the injected fixture capability. No provider network, credential, live data, or public production output. Ordinary CI belongs here.
2. **Private read-only qualification:** currently blocked by `assertMarketDataQualificationRights`. Enable only after written endpoint-specific permission confirms internal access, automated extraction, environment, account tier, retention, and intended derived use. A public display grant is not implied by private access.
3. **Public production display and derived use:** currently blocked by `evaluateMarketDataProductionRights` and the Upstox public-distribution gate. Requires affirmative documented rights for every dimension above, exact source URL, deployment environment, consumers, scope, effective date, authority, and account tier. Then review the source register and flags through a separate approved change.

Before any activation, the operator should attach written provider evidence for each endpoint, specify allowed data subjects and consumers, quota/reset/retention terms, and review the actual private provider response without copying credentials or user financial records into an issue. Keep all flags false while evidence is missing. No account subscription or terms acceptance is part of this review.

## Product boundary

The qualified Upstox registry currently contains only NIFTY 50 and India VIX. Equity history can be requested only with exact exchange/ISIN identity and qualified completed-session evidence. TejHQ EOD does not become a live quote. Mutual-fund NAV, official deposit/savings rates, and RBI bond facts retain their separate source authorities and permissions. Unsupported products remain unavailable.
