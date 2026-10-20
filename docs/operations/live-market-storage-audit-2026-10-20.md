# Live market storage audit — 20 October 2026

This audit covers the current WealthGenie repository and the Upstox/TejHQ
market-data path. The source-rights register remains the authority for what
may be fetched, retained, calculated from, and publicly displayed. A working
API key does not change those decisions.

| Root cause | Evidence in code | Resolution or remaining limit |
| --- | --- | --- |
| Cached Upstox facts kept their original freshness label after time passed. | `UpstoxMarketDataProvider.getQuotes`, `UpstoxHistoricalCandleProvider.getDailyCandles`, and `requestCache` | Recompute freshness on each read using original observed/fetched times. Boundary fixtures test the transition to stale. |
| TejHQ raw/adjusted history ignored a caller's forced refresh. | `TejHqHistoricalDataProvider.getRawHistory/getAdjustedHistory` | Forward `forceRefresh` to the shared fetch path; cache-bypass fixtures cover both modes. |
| Equity history required an admin POST and had no scheduled ingestion owner. | `marketDataRefresh.js`, `marketDataAdmin.js` | Add a serial daily refresh behind an explicit bounded target allowlist, retention configuration, provider qualification, and distributed lease. Disabled by default. |
| Partial batch writes could be read as complete history. | `QualifiedEquityHistoryStore.persistQualifiedHistory/readQualifiedHistory` | Use a MongoDB transaction, batch identity and coverage metadata. Reads verify the complete batch before returning a subset. |
| Historical corrections could silently replace earlier bar values. | `QualifiedEquityHistoryStore.buildQualifiedHistoryWriteOperations` | Changed stored prices conflict with the unique identity and return a revision-conflict code; old evidence remains. |
| Read-time rights checks omitted calendar, symbol-history and publication-status sources. | `marketDataService.fetchQualifiedEquityHistory`, `QualifiedEquityHistoryStore` | Persist the complete qualification source chain and recheck every URL on read. |
| Unauthorized rows could fill the history query limit before filtering. | `QualifiedEquityHistoryStore.readQualifiedHistory` | Bound reads for both raw providers, then verify rights and batch completeness before returning rows. |
| The market evidence panel requested benchmark prices through a provider-fetch GET. | `QualifiedMarketEvidencePanel`, `market.js` | Use an authenticated, read-only persisted-quote API. The separate private local demo remains ephemeral. |
| The application-wide `/quotes` prefix gate also intercepted the new `/quotes/persisted` route before authentication. | `app.js`, `marketQuotes.js` | Match the direct quote GET exactly; retain its existing Upstox publication block and let the stored read reach authentication and read-time rights checks. |
| Quote and history UI requests could show old data after a failed or reordered response. | `QualifiedMarketEvidencePanel`, `PrivateMarketDataDemo` | Clear stale quote state, cancel superseded history requests and keep malformed values unavailable. |
| Real production retention and display permissions are not yet established for Upstox/TejHQ. | `postTaxSourceRights.js`, `marketDataRights.js` | Keep production provider calls and storage fail-closed. Fixture tests prove code behavior, not live entitlement or commercial authorization. |

## Operational status

- `server/.env` contains nonempty Upstox Analytics Token and TejHQ API key
  entries. Secret values were not read into logs or this document.
- Equity-history storage, target allowlist, and benchmark-quote storage are
  unset in that file, so the new durable paths remain disabled locally.
- No live provider request or production publication was performed for this
  audit. Provider connectivity and account entitlement need separate qualified
  verification under the exact applicable source terms.
- MongoDB integration and frontend rendering tests use deterministic fixtures
  that are labelled test-only; they must not be interpreted as provider data.

## Rollout

Run the additive history and benchmark-quote index migrations against the
transaction-capable MongoDB deployment before enabling storage. Set bounded
retention only after the source-specific authorization is recorded. Enable
allowlisted scheduled ingestion only for entitled instruments. Recheck the
rights register and CI after any provider, schema or retention-policy change.
