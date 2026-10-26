# Obligation Firewall — staging integration contract (2026-10-25)

**Scope:** This document is a read-only compatibility analysis of the staging branch. No staging or main files were edited. This is not release approval.

- Feature PR: https://github.com/yashaskn8/Wealthgenie/pull/58
- Integration PR: https://github.com/yashaskn8/Wealthgenie/pull/63
- Merge base inspected: `f37662f4fe5b263eaa570b8e069e344b3cb281cc`
- Staging commit inspected: `f141418dc85d1c798cb886dda97ce6f37b5b37a1`
- Feature baseline inspected: `b2d4a2522d1433be975cca307753cd7a1b86c385`
- GitHub reported PR #63 as not mergeable. Do not interpret a successful feature-only CI run as combined readiness.

## Nine shared changed paths

These paths were edited on both sides of the merge base; **retain both feature implementations** when reconciling:

| File | Integration requirement |
| --- | --- |
| `reactapp/src/App.jsx` | Preserve the authenticated, keyed CashCheck route and production-off VITE_COVERAGE_ENABLED gate **and** Household Runway lazy route/VITE_RUNWAY_ENABLED gate. |
| `reactapp/src/components/Sidebar.jsx` | Preserve accessible cash-check navigation and Runway desktop/mobile navigation, both gated independently. |
| `reactapp/src/services/api.js` | Keep both coverage methods and runway/GenieVoice methods and exports. Do not replace one full API object with the other. |
| `reactapp/src/utils/navigationMap.js` | Preserve both `NAV_PAGES.CASH_CHECK` and `NAV_PAGES.RUNWAY` plus URL/deep-link resolution, guards and navigation tests. |
| `server/app.js` | Mount authenticated coverage routes only under the backend coverage feature gate; preserve Runway and GenieVoice registrations. Keep shared CSRF/rate/JSON middleware ordering. |
| `server/server.js` | Preserve coverage index/readiness checks and alert-worker lifecycle **and** Runway operational readiness and graceful shutdown. Failure must block an enabled financial worker. |
| `server/scripts/mongo-required-tests.json` | Union both manifest sets; expected 34 files at these pinned heads (33 common, coverageLedger and runwayMongo each unique). Recompute if other commits land. |
| `server/scripts/replica-set-required-tests.json` | Union both sets; expected 30 files at these pinned heads (28 common, coverageLedger and runwayMongo each unique). Recompute if other commits land. |
| `server/test/ciWorkflowSafety.test.js` | Retain the Runway-specific sixth CI job assertions and the coverage-specific mandatory replica-set suite checks. No hard-coded 33/29 totals or exact five-job invariant. |

### Verified manifest differences at inspected heads

- Feature-only suite: `test/coverageLedger.integration.test.js` (both manifests).
- Staging-only suite: `test/runwayMongo.integration.test.js` (both manifests).
- Feature manifest counts 33/29, staging manifest counts 33/29, union 34/30 **only for these inspected heads**.
- The dynamic `server/scripts/test-partition.js verify` check must pass for the merged manifest and registered test files.

### Safety gates for the integration operator

1. Resolve conflicts on a separate integration worktree/branch; do not force-update, merge into, or modify `main` or the feature branch during conflict resolution. This document alone does not resolve PR #63.
2. Recompute merge-base overlaps after any new commits; run full lint and tests, runtime auth/session/CSRF, Mongo 7 replica-set transaction and deletion tests, exact-paise oracle, Runway tests, CashCheck CSV import and mobile/desktop Chromium E2E.
3. Verify URL routing, active-account remounting and account isolation for both features. Confirm enabled-worker operational readiness, shutdown fencing, indexes/migrations and old-to-new snapshot compatibility in a disposable staging environment.
4. Keep `COVERAGE_ENABLED`, `VITE_COVERAGE_ENABLED` and any unapproved Runway/GenieVoice release flags disabled in production. Do not claim bank connectivity or actual payment verification.
5. Require a conflict-free validated integration commit **and reachability from main** before suggesting feature-branch deletion. Neither is established by this document.

## Separate feature hardening (no staging modifications)

The current feature branch adds a current-ledger revision/deletion fence to `GET /api/coverage/ledger`, preventing the normal application path from returning a superseded snapshot when the revision has changed between snapshot retrieval and response construction. A replica-set integration regression deliberately changes the persisted revision at that interleaving. This is defense in depth: a network response already in flight cannot be retroactively revoked.

Production rollout still requires environment-specific verification (replica-set failover, index/migration readiness, gateway cookie behavior, privacy/backup retention, operational SLOs, independent accessibility/regulatory review). Untested environments are **not verified**.
