# Household Runway — gated development implementation

**Authority:** deterministic user-declared dated cash-flow only. The engine does not fetch bank balances, holdings, investments, tax information or LLM replies. It cannot establish solvency.

**Flags:** Backend \`RUNWAY_ENABLED=true\`; frontend build \`VITE_RUNWAY_ENABLED=true\`. Both default to off. Keep them off in production until the release blockers are closed.

**Preflight:** Run \`MONGODB_MIGRATION_URI=<replica-set-uri> npm run runway:migrate-indexes --prefix server\` against the target database. Never run it against an unknown or production database without reviewing the URI and deployment plan. The backend rejects ledger and snapshot writes if the unique revision index is missing.

**Input:** User explicitly confirms accessible cash for today's Asia/Kolkata civil date. Money is canonical integer paise in API/DB. Never implicitly import profile \`liquidSavings\`. A declared future receipt is expected only. Calendar months require explicit CLAMP or SKIP behavior for nonexistent dates.

**Ledger:** \`PUT /api/runway/ledger\` requires \`If-Match: "0"\` for initial creation or the current revision, plus \`Idempotency-Key\`. Revisions are immutable. \`GET /current\` is owner-scoped. \`POST /simulations\` does not persist results and requires the current revision. \`POST /snapshots\` recomputes the engine in a Mongo transaction and saves owner-scoped results. An owned \`GET /snapshots/:id\` reports HISTORICAL when the current ledger differs. \`POST /explanations\` is local-only. \`DELETE /data\` needs a token issued within five minutes and typed confirmation.

**Limits:** 395-day horizon, 256 source entries, at most three shocks, 512 expanded baseline events, up to 100 saved snapshots per user. Incompatible or unknown inputs fail closed.

**Release NO-GO:** Independent arithmetic oracle, Mongo replica-set concurrency/idempotency/recovery tests, privacy tracing and backup-retention approval, staging latency measurements, user-comprehension testing, Indian legal review, and security verification remain **NOT VERIFIED**. The UI must never imply a 95% probability or guaranteed ability to pay.

**Test commands:** \`node --test server/test/runwayEngine.test.js\`, \`node --test server/test/runwayRoutes.test.js\` (with dependencies installed), \`npm test --prefix reactapp -- --run\`, and the normal full CI. Repository tests have not been verified as passing merely because this branch was committed.
