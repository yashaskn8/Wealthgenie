# CI/CD coverage and manual qualification

This inventory records the consolidation baseline at `90d10c7e7e52cd9a6ef3ea50162ca80fde4af6a2`. The current workflow files remain the executable contract. CI uses synthetic credentials and deterministic model providers; it does not use a saved financial profile or call a live external LLM.

## Baseline and retained coverage

Before consolidation, `.github/workflows/` contained seven workflows and 17 declared jobs. `ci.yml` declared ten jobs that expanded to 13 executions on a push through MongoDB, OS, and Python matrices. The other workflows declared seven jobs: one Kind deployment, two reliability jobs, and one each for agent-evolution contracts, live evolution, A2A TCK, and NSE qualification. `cd.yml` also launched Kind on every push.

| Former execution | Actual command or check | New owner |
| --- | --- | --- |
| Linux backend on MongoDB 6 and 7 | `node server/scripts/test-partition.js verify`; `npm run test:coverage --prefix server` executes every `server/test/**/*.test.js`, including financial, tax, suitability, profile, goal, transaction, authorization, worker, reliability, A2A, and governed-evolution contracts | Backend & Financial Integrity on MongoDB 7 |
| Separate agent-runtime job | Six named worker/Plan Review suites, worker syntax, action pins, deployment configuration | Full backend partition; configuration gates in Integration & Security |
| Windows no-Mongo and standalone-Mongo jobs | Subsets of the same Node test partition; Linux already runs the full partition with transaction-capable MongoDB | Backend & Financial Integrity; partition manifests and their tests remain |
| Redis MCP job | `node server/scripts/testMcpRedisCapacity.js` against real Redis | Integration & Security |
| Linux and Windows frontend matrix | Complete `npm test --prefix reactapp` Vitest suite, lint, typecheck, production build | Frontend Quality on Ubuntu/Node 22 |
| Python Linux and Windows matrix | Hash-locked requirements, serving-artifact verification, `python -m pytest -q`, dependency audit | AI/ML & RAG Safety on Python 3.12; audit in Integration & Security |
| Separate semantic-model job | Exact pinned model revision download and `-m model_integration` tests offline | AI/ML & RAG Safety, after the ordinary Python suite |
| Browser lifecycle job | MongoDB 7 replica set, Redis, Phase 2/3/4/5/7 migrations, shared RAG bootstrap, transactional ML/RAG checks, model registration, profile completion, Playwright | Integration & Security |
| Production-edge job | Compose/Nginx stack, ordered migrations, production-image RAG/model bootstrap, production-edge Playwright | Integration & Security, before native browser services to avoid port conflicts |
| Reliability lab jobs | `server/test/reliabilityLab.test.js` twice on some refs | Full backend partition once |
| Agent-evolution contract job | Full backend suite again plus `ml-service/tests/test_agent_evolution.py` | Full backend and Python suites once |
| A2A TCK job | Pinned upstream HTTP+JSON MUST suite and exact known-blocker policy | Manual `scripts/run_a2a_tck.sh`; deterministic policy-validator tests remain in AI/ML & RAG Safety |
| Live evolution job | Governed experiment with signed holdout, E2B and model credentials | Manual experiment only, with the existing fail-closed runner |
| NSE canary | Live `npm run qualify:nse --prefix server` every two hours on weekdays | Manual provider qualification only |

After consolidation, only `ci.yml` and `cd.yml` remain. CI runs automatically for pull requests targeting `main` and pushes to `main`, with optional manual dispatch. Its four jobs are Backend & Financial Integrity, Frontend Quality, AI/ML & RAG Safety, and Integration & Security. CD has one Kind verification job and is dispatch-only. It is an isolated deployment check, not an AWS production release.

The full backend partition includes every `.test.js` file and validates its MongoDB manifests before execution. The Python `pytest.ini` excludes `model_integration` from the ordinary suite; the AI/ML job executes that marker separately with the pinned model offline. Browser transactional tests need a real replica set and are explicit in Integration & Security. The two Playwright paths exercise different boundaries: native Vite/Express/FastAPI lifecycle and built Nginx/Compose edge. Their migration/bootstrap sequences repeat because each stack starts with an independent database. This is the only intentional repeated integration setup.

CI uses the pinned MongoDB 7 and Redis images already used in the repository. The Integration & Security job tears down the Compose edge stack before starting the native MongoDB/Redis lane, so ports 27017, 6379, 5000, and 8000 do not collide. The job audits server and frontend npm dependencies and retains the existing two exact Python vulnerability exceptions and their comments. The backend coverage artifact and browser failure evidence remain available. External A2A TCK, live-evolution, and NSE reports are no longer Actions artifacts because those jobs are manual.

No GitHub repository secret is required for ordinary CI or Kind verification. CI generates a disposable backend JWT and uses clearly synthetic browser/edge keys. The live evolution command below requires separately supplied credentials and a signed holdout bundle. The optional live-market preflight in CD is disabled by default and requires explicit manual selection.

## Direct manual commands

Run these from the repository root only when the corresponding external-source access and credentials are approved:

```bash
# Deterministic reliability replay; this also runs in the full backend suite.
npm run test:reliability --prefix server

# Pinned official A2A HTTP+JSON MUST checks. Requires Node 22, Python 3.12,
# uv 0.12.10, git, curl, and network access. The runner preserves its report path.
bash scripts/run_a2a_tck.sh

# Live NSE source qualification; never substitute its result for CI.
npm ci --prefix server
npm run qualify:nse --prefix server
```

For a governed live evolution experiment, validate and install the existing hash-locked dependencies, then supply `E2B_API_KEY`, `NVIDIA_API_KEY`, model API credentials/model names, `AGENT_HOLDOUT_BUNDLE_PATH`, and `AGENT_HOLDOUT_TRUSTED_PUBLIC_KEY` through a private environment. Set `AGENT_SELF_EVOLUTION_ENABLED=true`, `AGENT_SELF_EVOLUTION_GEPA_ENABLED=true`, `AGENT_SELF_EVOLUTION_LIVE_ENABLED=true`, `AGENT_SELF_EVOLUTION_E2B_ENABLED=true`, and `AGENT_SELF_EVOLUTION_AUTO_PROMOTION_ENABLED=false`. Run:

```bash
node ml-service/scripts/validate_dependency_lock.js
python -m pip install --require-hashes -r ml-service/requirements.txt
node server/scripts/run_evolution_experiment.js --gepa-provider dspy --sandbox-mode e2b --output-dir evolution-report --require-qualified-live-evidence
```

The runner fails closed without those inputs and cannot auto-promote a candidate. Do not put credentials or the signed holdout bundle in the repository or command arguments.

Dispatch `cd.yml` only after the four CI jobs pass for the exact intended SHA. Confirm the dispatched run's `headSha` matches that SHA. Kind checks Terraform, production manifests, image identity, migrations, worker/services, RAG bootstrap, smoke behavior, and HPA. The optional strict live-market preflight remains separately gated and disabled by default.
