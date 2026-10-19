# Market-data permission review

Status: **API capabilities documented; account entitlement and production-use qualification remain unverified**. This register supplements `postTaxSourceRights.js`. It does not grant access or change any runtime gate.

## Decision for each exact endpoint

The supplied TejHQ OpenAPI specification documents keyless access for `/v1/ohlcv`, `/v1/snapshot`, and `/v1/actions`; a free key adds `/v1/adjusted` and `/v1/symbols` with stated limits of 1,000 calls/day and 300/minute. It describes EOD datasets and a 18:30 IST refresh with a 21:30 IST retry, so these endpoints do not establish intraday live-quote coverage. The same specification labels Retail as personal use and Pro as commercial use (500,000 calls/day, 3,000/minute). The configured key's account tier is not inferable from its presence in `.env` and remains unverified.

The supplied spec does not establish this account's tier, endpoint-specific retention and derived-use permissions, public-display/redistribution terms, permitted deployment environment, or the exact authorization boundary for the proposed WealthGenie consumers. Its top-level OpenAPI `info.license: MIT` is metadata on the API description; it is not treated here as a license for the underlying market records. Accordingly, the runtime's exact endpoint rights gate remains fail-closed until its required scope is established. This is a release-rights status, not evidence that the documented API adapter is technically broken.

| Provider | Endpoint represented in source register | Capability | Account tier / limits | Rights decision |
| --- | --- | --- | --- | --- |
| Upstox | `GET /v3/market-quote/quotes` | V3 quote snapshot | Actual account entitlement unverified | All use dimensions unverified |
| Upstox | `GET /v3/historical-candle/{instrumentKey}/days/1/{toDate}/{fromDate}` | Daily historical candles | Actual account entitlement unverified | All use dimensions unverified |
| Upstox | `GET /v2/market/holidays` | Current-year holidays and special sessions | Actual account entitlement unverified | All use dimensions unverified |
| Upstox | `GET /v2/market/timings/{date}` | Session times for a date | Actual account entitlement unverified | All use dimensions unverified |
| Upstox | `GET /v2/market/status/NSE` | Current exchange phase | Actual account entitlement unverified | All use dimensions unverified |
| TejHQ | `GET /v1/ohlcv/{exchange}/{symbol}` | Raw EOD; documented keyless | API capability documented; account/use scope unverified | Keyless availability documented; retention, derived use, and public distribution not established |
| TejHQ | `GET /v1/adjusted/{exchange}/{symbol}` | Adjusted EOD; documented free-key endpoint | Free-key capability documented; configured account tier unverified | Tier-specific account and downstream use scope unverified |
| TejHQ | `GET /v1/symbols/{exchange}?isin=...` | Symbol history; documented free-key endpoint | Free-key capability documented; configured account tier unverified | Tier-specific account and downstream use scope unverified |
| TejHQ | `GET /v1/actions/{symbol}` | Corporate actions; documented keyless | API capability documented; account/use scope unverified | Keyless availability documented; retention, derived use, and public distribution not established |
| TejHQ | `GET /v1/status` | Pipeline publication freshness; documented keyless and edge-cached 60 seconds | API capability documented | Account-independent endpoint capability documented; downstream scope unverified |

The table lists exact endpoint families known to the code. Review the concrete URL and query scope in `marketDataSourceUrls.js` and the exact match decision in `postTaxSourceRights.js` for any proposed deployment. Provider reference documents: [Upstox V3 quotes](https://upstox.com/developer/api-documentation/get-full-market-quote-v3/), [Upstox market status](https://upstox.com/developer/api-documentation/get-market-status/), [TejHQ API](https://tejhq.dev/docs), [TejHQ keys and tiers](https://tejhq.dev/keys), [TejHQ upgrade tiers](https://tejhq.dev/upgrade). Published capability and quota are not proof of the configured account's tier or downstream reuse rights.

## Three distinct operating scopes

1. **Synthetic fixtures:** `NODE_ENV=test` with the injected fixture capability. No provider network, credential, live data, or public production output. Ordinary CI belongs here.
2. **Private read-only qualification:** currently blocked by `assertMarketDataQualificationRights`. Enable only after written endpoint-specific permission confirms internal access, automated extraction, environment, account tier, retention, and intended derived use. A public display grant is not implied by private access.
3. **Public production display and derived use:** currently blocked by `evaluateMarketDataProductionRights` and the Upstox public-distribution gate. Requires affirmative documented rights for every dimension above, exact source URL, deployment environment, consumers, scope, effective date, authority, and account tier. Then review the source register and flags through a separate approved change.

Before any activation, the operator should attach written provider evidence for each endpoint, specify allowed data subjects and consumers, quota/reset/retention terms, and review the actual private provider response without copying credentials or user financial records into an issue. Keep all flags false while evidence is missing. No account subscription or terms acceptance is part of this review.

## Product boundary

The qualified Upstox registry currently contains only NIFTY 50 and India VIX. Equity history can be requested only with exact exchange/ISIN identity and qualified completed-session evidence. TejHQ EOD does not become a live quote. Mutual-fund NAV, official deposit/savings rates, and RBI bond facts retain their separate source authorities and permissions. Unsupported products remain unavailable.
