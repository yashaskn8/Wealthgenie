# Market runtime configuration: server-only, fail-closed

The server’s Upstox and TejHQ adapters accept their own runtime environment; in a deployed stack those settings must actually reach the API container. This configuration forwards optional credentials and explicit market-mode flags in Compose, and uses an opt-in secret reference on the Kubernetes API server.

**No credentials are committed.** Never put provider keys in Vite variables, frontend source, the ML service, or the AI worker. Use a private secrets manager, Kubernetes Secret, or local environment. Do not log access tokens.

The default configuration remains `MARKET_DATA_MODE=LEGACY`, `MARKET_DATA_PRIMARY_PROVIDER=NSE`, `UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED=false`, `TEJHQ_ENABLED=false`, and `TEJHQ_LICENSE_CONFIRMED=false`. `UPSTOX_ANALYTICS_TOKEN`, `UPSTOX_ACCESS_TOKEN`, and `TEJHQ_API_KEY` are optional; merely setting them does **not** establish source rights, entitlements, historical retention permission, public-display permission or production readiness.

To inspect prerequisites locally, run `npm run market:doctor` from `server/`. Its output is a configuration-only assessment, not proof that an external provider call works. A genuine live-provider test requires valid authorized credentials and source-use permissions. The read-only private demo continues to be separate from any public recommendation or market publication.

These Kubernetes defaults also deliberately retain `LLM_DEFAULT_PROVIDER=mock` for the Kind demo. This change does not switch models, activate production AI, or deploy a live site. GitHub CI and the ephemeral Kind workflow validate behavior independently.
