# WealthGenie — feature activation and blockers

Verified configuration audit: 2026-10-20. This file records code-level flags,
not a claim that any cloud deployment, provider credentials or source permissions
have been exercised. See GitHub Actions for current test status.

## Enabled where prerequisites are present

| Capability | Effective selected configuration | Verification and constraints |
| --- | --- | --- |
| Read-only Plan Review | Local environment templates and `deploy/production/config-patch.yaml`: `AGENTIC_PLAN_REVIEW_ENABLED=true` | Requires MongoDB Phase 4/5 indexes, running worker and Redis in production. Startup/persistence checks fail closed. |
| Plan Review event streaming | Local templates and production overlay: `AGENT_STREAM_ENABLED=true` | Authenticated, run-owned SSE; route is unavailable unless Plan Review itself is enabled. |
| Plan Health scheduler | Dedicated Kubernetes worker overrides `PLAN_HEALTH_SCHEDULER_ENABLED=true` | API base ConfigMap remains false; worker owns schedules and verifies indexes. |
| Agent worker | Dedicated Kubernetes worker overrides `AGENT_WORKER_ENABLED=true` | API replicas correctly remain false in external mode; this is not a disabled user feature. |
| Primary model gateway | Production API override uses `LLM_DEFAULT_PROVIDER=api`, `LLM_PRIMARY_PROVIDER=GROQ` | Requires provisioned server-side credentials; mock stays scoped to Kind/ML. |
| Gemini failover | Production overlay opts into `LLM_GEMINI_FALLBACK_ENABLED=true` | Only classified transient Groq outages, durable budget reservation, max two attempts; no fallback for authentication, rate-limits, grounding/policy rejections, or absent primary credentials. |
| GenieProof claim preview | Server-authorized unsaved candidate extraction | Does not require signing keys, external-source rights or verified financial claims. |

## Blocked or intentionally opt-in (DO NOT flip to true without evidence)

| Capability / flag | Blocker / required next action |
| --- | --- |
| GenieProof signed passports | Ed25519 private/public signing key pair, key ID and authorized development/test workflow; production evidence-rights and signing review outstanding. |
| `UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED` | Provider-specific rights to publish/redistribute exact market observations must be verified. A flag or API token is not proof. |
| `MARKET_EQUITY_HISTORY_STORE_ENABLED` | Licensed retention scope, identity-qualified ingestion and retention policy; never persist unauthorized provider responses. |
| `MARKET_DATA_MODE=LEGACY` | Do not silently force UPSTOX_ONLY for all products: not all investment products have matching Upstox instruments or qualified sources. |
| `MARKET_DATA_PRIVATE_DEMO_ENABLED`, `PRIVATE_MARKET_READ_ONLY_PROBE_ENABLED` | Deliberate loopback-only opt-in, authenticated read-only provider token, and isolated environment. |
| ResearchMesh A2A, deep/adaptive/live research | Authenticated research server, signed agent card, accepted search provider and live tool permissions; the configured `fixture` provider is not production search. |
| WebAuthn verifiable financial actions | Approved production identity, passkey challenge/receipts, recent authentication and key management. |
| Remote MCP production | Dedicated MCP JWT issuer, audience, scope, strong isolated secret, trusted TLS proxy/origins and Redis-backed capacity control. |
| Agent self-evolution and automatic promotion | Runtime self-evolution/automatic promotion prohibited by security policy; offline, manually approved evaluation only. |
| `MCP_LEGACY_SSE_ENABLED` | The legacy transport is removed and must stay disabled. |
| `MCP_DIRECT_TLS` | Keep false when TLS terminates at a trusted ingress rather than Node itself. |
| `AGENT_EVOLUTION_ENABLED`, `AGENT_RESEARCH_ENABLED` | Runtime exposes these general flags, but no end-to-end activation is established just by changing them; subordinate identity, A2A and worker requirements still apply. |

## Scope / status

- This register is **configuration evidence**, not real provider/production verification.
- The root/local environment examples are templates and do not overwrite deployed secrets.
- Keep failing functionality blocked with the actual code and dependency reason; do not
  substitute fake data, weaken tests, or mark the whole application production-ready.
- Pending work: qualify licensed market data and per-product sources; verify a real
  model provider and bounded fallback calls; exercise Plan Review through a live external
  worker; complete documented identity/signing prerequisites; green integration and security CI.
