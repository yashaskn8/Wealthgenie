# Upstox / TejHQ market-data mode

Status: **implemented with synthetic fixtures; live production qualification NOT VERIFIED**. This document describes the code at the time of this change, not a provider entitlement or a production launch approval.

## Selection and authority

Set `MARKET_DATA_MODE=UPSTOX_TEJHQ` to select the bounded market-data ingestion path. `LEGACY` remains the default. In the selected mode, `MARKET_DATA_PRIMARY_PROVIDER` cannot redirect live market data to NSE.

| Capability | Selected source | Server path | Qualified result |
| --- | --- | --- | --- |
| NIFTY 50 and India VIX quote | Upstox V3 full quote | `fetchBenchmarkQuotes`, `fetchQualifiedMarketContextSnapshots` | The actual `last_trade_time`, price, instrument key and source URL are retained. A response received now does not refresh the trade timestamp. |
| Exchange session | Upstox V2 annual holidays, date timings, exchange status | `UpstoxTradingCalendarProvider.getCurrentSession` | Calendar and status must agree; only a `NORMAL_OPEN` observation no older than five minutes within the per-date session window is `MARKET_OPEN`. Cached observations retain their source time. Pre-open, closing auction and conflicting evidence remain `UNKNOWN`; CAS status is checked separately. |
| NIFTY benchmark history | Upstox V3 daily candles | `fetchQualifiedMarketContextSnapshots` | Current-year sessions must exactly match Upstox's qualified NSE calendar, including documented special Saturday sessions. Missing days, early-year fewer than 50 sessions and unsupported calendar ranges fail closed. |
| NSE equity raw history | Upstox V3 daily candles; TejHQ raw EOD fallback | `fetchQualifiedEquityHistory` | Requires exact ISIN, ordered daily candles and the Upstox calendar. TejHQ additionally requires symbol intervals and publication through the last expected session. |
| NSE equity adjusted history | TejHQ adjusted EOD | `fetchQualifiedEquityHistory` | Raw OHLC and adjusted close remain distinct. Symbol history, publication and session completeness are required. |
| Corporate actions and publication status | TejHQ | Admin market-data routes | Evidence only; not a live quote or recommendation authority. |
| BSE expected-session history | None qualified | `fetchQualifiedEquityHistory` | Unavailable. No NSE calendar is used as a BSE substitute. |
| Mutual-fund NAV and official fixed-income rates | Their existing official source adapters | AMFI, India Post, SBI, RBI services | Independently rights-gated. Upstox/TejHQ prices never fill a missing NAV, coupon or official rate. |

The selected market-context path attempts one Upstox quote/history pair only when source rights and public distribution are qualified. If it fails, it does not call the NSE website or mix TejHQ EOD equity prices into NIFTY context. An existing NSE last-known-good context is rejected after mode selection. When permission is absent, core profile and recommendation routes remain reachable and market facts are unavailable; direct Upstox quotes remain blocked. A previously applied market tilt is not served if its source is no longer qualified. Unqualified market context cannot adjust suitability or allocation.

## Endpoint and permission matrix

These exact endpoints are represented by `postTaxSourceRights.js` and enforced by `marketDataRights.js`. Every listed market-data right is currently `LICENSE_UNVERIFIED`; no account tier, contract, permitted environment, license document or redistribution authorization has been established in the repository. A token, free key, successful GET or operator Boolean is not approval.

| Provider | Endpoint family | Documented capability | Authentication / quota evidence | Rights status |
| --- | --- | --- | --- | --- |
| Upstox | `GET /v3/market-quote/quotes?instrument_key=...` | Full market quote; stable instrument key | Server-side Analytics or access token; Upstox standard API limits | Unverified for extraction, storage, derived use, public display, commercial use and redistribution |
| Upstox | `GET /v3/historical-candle/{instrumentKey}/days/1/{toDate}/{fromDate}` | Daily candles where supported | Server-side token; same standard limits | Unverified for all production market-data rights |
| Upstox | `GET /v2/market/holidays` | Current-year holiday and special timing list | Server-side token; same standard limits | Unverified for all production market-data rights |
| Upstox | `GET /v2/market/timings/{date}` | Per-date exchange session times | Server-side token; same standard limits | Unverified for all production market-data rights |
| Upstox | `GET /v2/market/status/NSE` | Exchange phase and last update | Server-side token; same standard limits | Unverified for all production market-data rights |
| TejHQ | `GET /v1/ohlcv/{exchange}/{symbol}` | Raw EOD OHLCV | Keyless access is described publicly; runtime capability NOT VERIFIED | Unverified for all production market-data rights |
| TejHQ | `GET /v1/adjusted/{exchange}/{symbol}` | Adjusted EOD | Published free-key limits; actual entitlement NOT VERIFIED | Unverified for all production market-data rights |
| TejHQ | `GET /v1/symbols/{exchange}?isin=...` | Historical ISIN/symbol intervals | Published free-key limits; actual entitlement NOT VERIFIED | Unverified for all production market-data rights |
| TejHQ | `GET /v1/actions/{symbol}` | Corporate-action evidence | Public access is described; actual entitlement NOT VERIFIED | Unverified for all production market-data rights |
| TejHQ | `GET /v1/status` | Dataset publication date | Public access is described; actual entitlement NOT VERIFIED | Unverified for all production market-data rights |

Production requires operator evidence for **every** right dimension (`access`, `extraction`, `derivedCalculation`, `storage`, `publicDisplay`, `commercialUse`, `redistribution`), the approved production scope, exact endpoints, account tier and permitted use case. The existing Upstox public-distribution and TejHQ enablement flags are additional gates; they cannot approve missing rights. Ordinary CI uses injected synthetic transports only.

## Source and execution inventory

| Source | Current code status | Selected-mode behavior |
| --- | --- | --- |
| Upstox quote/history/session/calendar | Adapters implemented; live access NOT VERIFIED | Sole live market-context provider, subject to rights and credentials |
| TejHQ EOD/adjusted/actions/symbol/status | Adapter implemented; live access NOT VERIFIED | Rights-gated equity-history fallback and admin historical workflows, subject to flags and publication checks |
| NSE website quote/history/holiday JSON | Legacy adapters implemented; rights unverified | Dormant in selected facade paths; NSE qualification and market-regime export scripts stop before a network call |
| AMFI NAV/history | Implemented; independent rights gate | No equity quote substitution |
| India Post, SBI, RBI facts | Implemented; independent rights gate | No equity quote substitution |
| HMM regime model | Shadow diagnostic | No allocation authority |
| Frontend market context | Backend API consumer | Receives source, observed time, display status and unavailable states; no direct provider calls |

The current-year holiday endpoint cannot prove a complete previous-year calendar. The selected mode abstains for cross-year equity-history qualification and for benchmark context until enough exact current-year sessions are available. Closing-auction/pre-open phase is carried as a provider phase with `UNKNOWN` recommendation session authority. Upstox documents `last_updated` as a status-update time but does not promise a heartbeat. The five-minute session age rule intentionally abstains when a phase remains unchanged beyond that limit; ordinary-session live availability is therefore unverified. BSE history remains unavailable without a BSE calendar. These are deliberate bounds, not missing-value zeroes.

## Verified and unverified evidence

- **VERIFIED from code and isolated tests:** selected mode disables NSE market-data failover; Upstox calendar parsing includes NSE special sessions; TejHQ fallback preserves its own EOD source; rights denial prevents provider calls; an NSE last-known-good snapshot cannot be reused in selected mode.
- **VERIFIED from provider documentation:** [Upstox quotes](https://upstox.com/developer/api-documentation/get-full-market-quote-v3/), [historical candles](https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/), [annual holidays](https://upstox.com/developer/api-documentation/get-market-holidays/), [timings](https://upstox.com/developer/api-documentation/get-market-timings/), [exchange status](https://upstox.com/developer/api-documentation/get-market-status/), [Analytics Token](https://upstox.com/developer/api-documentation/analytics-token/), [rate limits](https://upstox.com/developer/api-documentation/rate-limiting/), [TejHQ documentation](https://tejhq.dev/docs) and [TejHQ keys](https://tejhq.dev/keys).
- **UNKNOWN:** exact live endpoint responses for this account, TejHQ publication latency and account tier, redistribution/commercial permission, provider uptime, production cache/quota behavior across replicas, and production browser behavior. None was inferred from synthetic fixtures.
