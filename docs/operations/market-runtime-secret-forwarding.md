# Market runtime configuration: server-only, fail-closed

The server’s optional Upstox adapter reads server-only runtime credentials. In a deployed stack those settings must reach the API container. Compose forwards optional credentials and market-mode flags; Kubernetes uses an opt-in secret reference on the API server.

**No credentials are committed.** Keep all provider and LLM API keys scoped to the API server. Never pass them to Vite variables, frontend source, the ML service, or the agent worker. This does not enable any LLM route while the deployment default remains `LLM_DEFAULT_PROVIDER=mock`. Supply secrets only through a private secrets manager, Kubernetes Secret, or local environment. Do not log access tokens.

The default configuration remains `MARKET_DATA_MODE=LEGACY`, `MARKET_DATA_PRIMARY_PROVIDER=NSE`, and `UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED=false`. `UPSTOX_ANALYTICS_TOKEN` and `UPSTOX_ACCESS_TOKEN` are optional; merely setting them does **not** establish source rights, entitlements, historical retention permission, public-display permission or production readiness.

To inspect prerequisites locally, run `npm run market:doctor` from `server/`. Its output is a configuration-only assessment, not proof that an external provider call works. A genuine live-provider test requires valid authorized credentials and source-use permissions. The read-only private demo continues to be separate from any public recommendation or market publication.

These Kubernetes defaults also deliberately retain `LLM_DEFAULT_PROVIDER=mock` for the Kind demo. This change does not switch models, activate production AI, or deploy a live site. GitHub CI and the ephemeral Kind workflow validate behavior independently.
