# Local private market-API probe (not production authorization)

This command checks that the owner's own Upstox and TejHQ credentials work for
read-only connectivity within applicable provider terms. It does not modify
production rights, public routes, caches, or financial calculations.

## Sources to review

- Upstox read-only Analytics Token: https://upstox.com/developer/api-documentation/analytics-token/
- Upstox private noncommercial research: https://community.upstox.com/t/can-upstox-historical-api-data-be-retained-locally-for-private-ml-backtesting-research/17302
- Upstox educational public display vs commercial use: https://community.upstox.com/t/request-api-licensing-for-public-website-paper-trading-display-of-upstox-data/17752
- TejHQ API terms/capability/tier information: https://tejhq.dev/docs
- TejHQ account/key management: https://tejhq.dev/keys

These sources document access and limited use cases, not every intended public
distribution, storage, retention, or commercial WealthGenie right.

## Running locally (Node 22; Docker not required)

Keep secrets in uncommitted server/.env or private process environment.
Install the repository's normal backend dependencies first.

PowerShell, from repository root:

    $env:NODE_ENV="development"
    $env:PRIVATE_MARKET_READ_ONLY_PROBE_ENABLED="true"
    node server/scripts/probePrivateMarketAccess.js --i-accept-provider-terms

Bash, from repository root:

    NODE_ENV=development PRIVATE_MARKET_READ_ONLY_PROBE_ENABLED=true \
      node server/scripts/probePrivateMarketAccess.js --i-accept-provider-terms

The acknowledgement means you reviewed the provider terms for the private
read-only operations; it does not certify commercial redistribution rights.

The CLI reads server/.env without overriding existing environment variables.
It refuses production, CI, and runs without explicit opt-in. It does not
change MARKET_DATA_MODE, public routes, or production deployment settings.

## Checks performed: five fixed GET operations, no retries

1. Upstox V3 NIFTY 50 and India VIX quotes (token authenticated)
2. Upstox V2 NSE status (token authenticated)
3. TejHQ status (keyless)
4. TejHQ RELIANCE bounded recent raw EOD data (keyless)
5. TejHQ GET /v1/me (authenticated, does not prove downstream rights)

No data is persisted or returned to WealthGenie users. Output consists only
of provider, operation, sanitized verdict and HTTP status, not raw provider
responses, financial prices, account numbers, tokens or keys. Network exception
messages are not printed. A successful 200 establishes only this narrow
technical check, not storage/display/redistribution permission.

Run targeted regression tests:

    node --test server/test/privateMarketAccessProbe.test.js

## Production remains restricted

Do NOT flip the following booleans based on probe output:

- UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED
- TEJHQ_LICENSE_CONFIRMED
- MARKET_DATA_QUALIFICATION_LIVE_ENABLED

Do not mark UNKNOWN rights approved in server/services/postTaxSourceRights.js.
Existing marketDataRights.js and upstoxDistributionPolicy.js gates continue
to protect public users until applicable source-specific permissions exist.


## Integrated local React preview (private only)

A separate *optional* local-only backend route and Where-to-Invest panel now
display real validated Upstox NIFTY 50 / India VIX quotes and a bounded TejHQ
RELIANCE raw EOD history if those private retrieval/display uses are allowed
under the actual provider terms.

The new backend route is GET /api/market-data/private-demo. It:
- Is absent unless NODE_ENV=development, PRIVATE_MARKET_DEMO_ENABLED=true,
  PRIVATE_MARKET_DEMO_TERMS_ACKNOWLEDGED=true, and no CI environment is set.
- Rejects non-loopback TCP peers, non-loopback Host and Origin values.
- Requires an authenticated current WealthGenie session using verifyJWT.
- Has a per-IP limit of six requests per minute, with secret-free failure codes.
- Uses a 60-second Upstox in-process snapshot cache and a 15-minute TejHQ EOD
  in-process snapshot cache; failed snapshots are revalidated after 30 seconds.
- Fetches at most two upstream requests on a cold panel load, no retries.
- Never stores raw provider response bodies, sends keys to the browser,
  or writes fetched observations to MongoDB/Redis.
- Never updates authoritative recommendations, suitability or public market
  context; production routes and source rights ledgers are unchanged.

Edit ONLY the private server/.env with the following lines, after reviewing
the provider terms for your personal/private demo:

    NODE_ENV=development
    PRIVATE_MARKET_DEMO_ENABLED=true
    PRIVATE_MARKET_DEMO_TERMS_ACKNOWLEDGED=true
    PRIVATE_MARKET_DEMO_TEJHQ_ENABLED=true

Ensure UPSTOX_ANALYTICS_TOKEN is present and valid. TejHQ's raw EOD
endpoint is documented keyless; the backend does not send a TejHQ API key
for that endpoint. Leave PRIVATE_MARKET_DEMO_TEJHQ_ENABLED=false if the
actual TejHQ access terms do not permit the intended demonstration.

Do not duplicate existing environment keys. Start the backend using the
normal documented commands and sign into WealthGenie locally. Navigate to
Where-to-Invest: a panel labeled "Read-only market API verification"
appears only in a development Vite build opened on localhost/127.0.0.1.

The preview is separate from the main Market Today policy context.
A successful quote-only preview does not establish a sufficiently complete
quote/history/session pair for investment-policy adjustments.

Supported provider breadth is deliberately small:
- Two fixed benchmark Upstox quote identities.
- One bounded, date-checked NSE RELIANCE raw TejHQ EOD history window.

No full-market scraping, uncontrolled backfills or claims of long-term
retention rights have been added. Expansion and MongoDB persistence need
separate endpoint/account/retention authorization and must use verified
source identities.

Regression tests:

    node --test server/test/privateMarketDemo.test.js
    node --test server/test/privateMarketAccessProbe.test.js

Browser acceptance requires actual permitted provider responses reaching the
signed-in local browser; synthetic tests and successful 200 diagnostics are
not proof of that outcome. Check the original observed timestamps rather than
substituting fetch time for last-trade time.
