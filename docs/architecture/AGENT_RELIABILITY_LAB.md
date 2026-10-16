# Agent Reliability Lab

Status: additive evaluation-only lab. It is not enabled by application startup, does not write to MongoDB, and does not change financial authority.

## Purpose

The lab evaluates long-horizon behavior around the existing Plan Review, A2A, worker, plan-health, authorization-recovery, and evolution contracts. It consumes production-shaped event snapshots through adapters, but runs scenarios against an in-memory synthetic environment.

## Boundaries

- The lab has no Express route, MCP tool, A2A tool, model-gateway hook, or production worker hook.
- `FaultInjector` rejects production mode and requires an explicit test/evaluation environment.
- Scenario definitions are strict JSON-like data validated with Joi. Unknown fields and executable keys such as `script`, `code`, `eval`, and `command` are rejected.
- The synthetic environment never accepts a financial profile, recommendation allocation, tax result, credential, JWT, or user identifier.
- Every scenario and promotion scorecard requires `financialAuthorityDelta === 0`.
- RealClock exists for contract completeness; default tests use VirtualClock, so multi-year scenarios do not sleep.

## Trajectory IR

`trajectoryIR.js` normalizes `AgentRunEvent`, `AgentRun`, A2A task, authorization, and plan-health-shaped events into a bounded, hash-addressed IR. Private-looking fields are omitted and object payloads are hashed rather than copied. The IR is immutable by convention and replay creates a new object/hash.

## Scenarios and graders

The fixture corpus covers healthy execution, provider outage/retry, worker crash/resume, stale worker fencing, duplicate queue delivery, A2A duplicate/cancel, stale evidence, regulatory update, contradictory evidence, approval delay/expiry, crash-after-commit recovery, cancellation races, delayed prompt injection, and multi-year idle monitoring.

The process grader checks lifecycle ordering, cancellation safety, bounded trajectories, authority invariance, and registered constraints. The outcome grader checks the scenario's declared observable result. Failures are localized into provider, worker, protocol, evidence, authorization, cancellation, duplication, safety, budget, or unknown categories with recoverability metadata.

## Holdout and evolution

The holdout API returns aggregate pass/fail, hard-failure count, and authority delta only. It rejects answer-key-shaped input. `buildReliabilityPromotionEvaluation` produces an evaluation object compatible with the existing offline evolution promotion boundary, but always marks `appliedToProduction: false`; existing human authorization remains required for promotion.

## Metrics

`renderReliabilityPrometheus` emits bounded lab-only metrics for scenario count, failed scenarios, and authority delta. The lab does not add high-cardinality user labels.

The benchmark groups scenarios into short, medium, and long virtual-duration buckets and reports mean/P95 provider calls and model calls. Repeated deterministic runs must have identical trajectory hashes and pass/fail results.

## CI

The complete backend test partition in `.github/workflows/ci.yml` runs `server/test/reliabilityLab.test.js` on pull requests targeting `main` and pushes to `main`. Run `npm run test:reliability --prefix server` for an isolated deterministic replay. It uses Node only. Docker, Kubernetes, live providers, live models, and production data are not required or invoked.

## Limitations

This lab does not claim production chaos validation, A2A TCK compliance, live provider reliability, or a replacement for the existing Mongo-backed worker/authorization integration suites. Those remain separate validation surfaces. The current benchmark is deterministic and synthetic; optional stochastic experiments are intentionally not part of default CI.

Financial authority changes: NONE.
