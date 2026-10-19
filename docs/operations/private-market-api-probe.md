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
