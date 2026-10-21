# Private market API probe and local demo

These commands provide bounded, local technical checks. They do not authorize
commercial use, public display, provider-data retention, or redistribution.
The endpoint-specific rights registry is checked before each real provider
request; a successful HTTP response never changes that registry.

## Current endpoint rights

- Upstox NIFTY 50, India VIX, and exact-identity Nifty 50 BeES ETF quotes have an explicit, narrow
  `PRIVATE_LOCAL_EDUCATIONAL_DEMO` scope. It can be requested only from the
  authenticated loopback development demo. The response is ephemeral and is
  not cached or persisted.
- Production/public market-data rights remain disabled unless the exact source
  record qualifies the requested production scopes.

## Run the bounded connectivity probe

Use Node 22 with the repository dependencies installed. Keep credentials in
the uncommitted `server/.env` or a private process environment.

PowerShell, from the repository root:

```powershell
$env:NODE_ENV = "development"
$env:PRIVATE_MARKET_READ_ONLY_PROBE_ENABLED = "true"
node server/scripts/probePrivateMarketAccess.js --i-accept-provider-terms
```

Bash:

```bash
NODE_ENV=development PRIVATE_MARKET_READ_ONLY_PROBE_ENABLED=true \
  node server/scripts/probePrivateMarketAccess.js --i-accept-provider-terms
```

The probe reports two fixed Upstox candidate operations. It sends a request only when
that exact endpoint has an approved private-demo scope; with the current
registry, only the Upstox quote operation qualifies. Results omit provider
payloads, prices, account data, credentials, and raw network error messages.
The acknowledgement flag is an operator confirmation, not a grant of rights.
The command exits successfully only if the qualified `BENCHMARK_QUOTES` request
returns HTTP 200 with the validated NIFTY/VIX response. The still-unqualified
`NSE_MARKET_STATUS` operation is reported as `SOURCE_RIGHTS_UNVERIFIED` and
is **never requested**; this expected skip is not a quote-connectivity failure.
The output reports `quoteConnectivity.status` separately. A successful
connectivity probe is not authorization for public use and does not prove that
the authenticated browser route, MongoDB or the overall demo is healthy.

Run the deterministic regression test:

```bash
node --test server/test/privateMarketAccessProbe.test.js
```

## Use the authenticated local React demo

Set the explicit backend opt-in in the private, uncommitted `server/.env`:

```dotenv
NODE_ENV=development
MARKET_DATA_PRIVATE_DEMO_ENABLED=true
```

Ensure `UPSTOX_ANALYTICS_TOKEN` is configured on the server. Do not copy it to
the frontend. The `/api/market-data/private-demo` route requires a valid
WealthGenie session, a loopback socket peer and Host, development mode, and the
explicit backend opt-in. A supplied browser Origin must also be a loopback
HTTP(S) origin (the development frontend can use a different local port).
CI and GitHub Actions explicitly disable this capability even if
`NODE_ENV=development`. It is rate limited. The React panel appears only in
a Vite development build and fetches on entry, with a manual refresh button.

The active Upstox request is uncached and not persisted. Its exact ETF quote
can appear as a last-traded educational preview beside the matching product;
the preview never changes ranking, tax, suitability, or recommendations.

Run focused regression tests:

```bash
node --test server/test/marketQuotes.test.js server/test/marketDataRights.test.js
npm test --prefix reactapp -- src/components/deepdive/PrivateMarketDataDemo.test.jsx
```

A fixture test verifies DTO mapping and fail-closed states only. To claim live
connectivity or browser integration, capture a permitted real provider
response through the authenticated local route and confirm the browser shows
the same source timestamps and provenance. Do not substitute fetch time for
the provider observation time.

## Production restrictions

Do not enable `UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED` or
`MARKET_DATA_QUALIFICATION_LIVE_ENABLED` based on these private checks. Keep
unknown rights unapproved in `server/services/postTaxSourceRights.js` and
`server/services/marketData/marketDataRights.js` until the source-specific
production permission is established.
