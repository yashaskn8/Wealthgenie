# Plan Review startup and UI recovery

Plan Review is a queued, read-only financial review, not a browser-only feature.
Its frontend panel lives on **My Plan** (the canonical `?page=plan` route).
The review can assess a profile with an absent/stale recommendation and can
return REVIEW_PROFILE or RECOMPUTE_PLAN without inventing an allocation.

## Why the panel appeared broken

- The AllocationPlanner's plan-loading/error/empty early returns previously
  hid the entire review panel. The error and empty states now retain it.
  The loading state still waits rather than reviewing a changing calculation.
- The initial current-run lookup allowed only 1500 ms, too short for cold
  development MongoDB requests. It now allows 10000 ms; an indeterminate
  timeout still requires a status retry, never a blind duplicate POST.
- `scripts/start_local_demo.ps1` forcibly disabled Plan Review **and** its
  worker. The script now supports an explicit `-EnablePlanReview` switch
  and enables both the feature and the **embedded** worker together.
- That launcher also rejected the actual `yashaskn8/Wealthgenie` remote
  because it required the archived WealthGenie-AI-Powered... repository.
  Its canonical allowlist now covers only HTTPS/SSH for the active repository.

## Do not bypass infrastructure requirements

`-EnablePlanReview` is opt-in, not the default. The selected demo MongoDB
must be a verified replica set, support transactions, and have the required
agent run/checkpoint/event/index collections already migrated. The server
verifies required indexes read-only and **refuses to start** without them.

Plan Review requires **both** independently verified migrations:
Phase 4 review-run/checkpoint indexes and Phase 5 Agent Runtime capacity and
admission-fence state (including `AgentQueueAdmission._id = plan-review` and the
numeric queue-priority index). Only creating the Phase 4 indexes leaves
enqueue requests blocked by `AGENT_QUEUE_ADMISSION_UNAVAILABLE`.

Both migrations are explicit, state-changing administrator operations:
`server/scripts/migratePlanReviewIndexes.js` and
`server/scripts/migratePhase5AgentRuntimeIndexes.js`. They can replace
obsolete indexes or backfill persisted records. **Back up and inspect the
selected isolated demo database** first; never run against an unknown or
shared production database. They both require `MONGODB_MIGRATION_URI` in
an explicitly trusted local process. The launcher itself executes a
read-only Phase 4 + Phase 5 preflight and does not perform migrations.

After verifying the database is the existing isolated `wealthgenie-demo`
replica set, making a backup and explicitly approving its migration,
execute from the repository root in PowerShell:

    cd server
    $env:MONGODB_MIGRATION_URI = 'mongodb://127.0.0.1:27030/wealthgenie-demo?replicaSet=rs0'
    node scripts/migratePlanReviewIndexes.js
    node scripts/migratePhase5AgentRuntimeIndexes.js
    Remove-Item Env:MONGODB_MIGRATION_URI
    cd ..
    .\scripts\start_local_demo.ps1 -EnablePlanReview

Stop on the first migration error. Do not attempt automatic repairs to a
different MongoDB instance or reuse a production connection string.

For an existing validated demo database with provisioned indexes, launch
in PowerShell:

    .\scripts\start_local_demo.ps1 -EnablePlanReview

The default `start_local_demo.ps1` remains isolated and deterministic with
Plan Review disabled.

If Plan Review says FEATURE_UNAVAILABLE: check the effective server runtime
configuration, `AGENTIC_PLAN_REVIEW_ENABLED`, `AGENT_WORKER_ENABLED` and
`AGENT_WORKER_MODE`. If a run remains QUEUED, check the embedded/external
worker's health and lease processing. A successful GET /health/live is not
proof that the agent worker is processing queued reviews.

End-to-end acceptance: create a profile, visit My Plan, confirm the review
panel is visible even without a generated allocation, enqueue one review,
observe queue -> run -> terminal result, verify evidence ownership, reload,
confirm persisted history and no mutation of authoritative allocations.

No API keys, database credentials or signed-in account data are needed in
GitHub. Do not turn the feature on for production without its intended
deployment/runtime controls and required readiness checks.
