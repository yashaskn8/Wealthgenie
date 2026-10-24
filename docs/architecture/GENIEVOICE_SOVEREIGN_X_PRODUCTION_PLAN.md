# GenieVoice Sovereign X — Production Engineering Plan

This file defines testable release gates, not a certification claim. Feature branch only; do not merge until PR checks and independent deployment verification pass.

## Capability matrix

| Capability | Implemented on this branch | Production gate |
|---|---|---|
| Push-to-talk browser speech recognition | Browser API, opt-in | Test real devices, permissions, STT false positives, disclosures |
| Internal route navigation | Strict backend + frontend canonical page allowlists | Test user/account revocation, stale callbacks, supported browsers |
| Speak grounded existing chat answer | Validation PASS and evidence ID guard | Test chat response freshness and financial-claim rendering |
| Read-only SIP comparison | Authenticated, canonical-profile-bound engine; two explicit return assumptions | Verify numeric equivalence across engine reference corpus and end-to-end |
| Read-only task proposal validator | Bounded DAG with cycle and unknown-tool rejection | Connect only after durable task state and execution receipts exist |
| LLM autonomous tool planning | NO | Add provider output validation, tool contracts and bounded policy |
| General browser navigation/extension | NO | Tab grants, origin binding, sandbox and adversarial page testing |
| Financial writes, investment execution | NO | Separate legal/financial authorization, approval, receipts and rollback |
| Native streaming, bilingual voice | NO | Cross-device performance, privacy, cost and accessibility gates |

## Security architecture
Untrusted audio/transcripts, model output, retrieved websites and browser observations may propose **no privileges**.
Authenticated backend policy alone grants action scopes. Provider choice cannot change policy. Browser
commands must be tied to extension-issued tab grants and never access other tabs or credentials.
Financial information must always come from canonical profile state and qualified evidence or
explicitly hypothetical deterministic calculations. Browser TTS may speak only verified prior answers.

## Deployment phases
1. **Bounded read-only prototype**: Current voice + SIP comparison; feature flags default off.
2. **Reliable voice runtime**: Speech lifecycle, interruption, device fallbacks, clear disclosure,
   state fencing and optional on-device transcription. Real-device E2E required.
3. **Task engine**: Identity-bound ledger, immutable plan version, per-step idempotency, DAG cycle
   validation, independent receipt observer, time/step budgets and auditable cancellation.
4. **Browser companion**: MV3 extension with user-picked active tab; deterministic DOM action
   allowlists, blocked password/banking domains; Playwright only in separately isolated contexts.
5. **Security and compliance**: Red-team prompt injection, SSRF, browser permissions, zero-data
   exfiltration; regulator/privacy review for product scope and user data retention.
6. **Canary**: Small percentage behind kill switch; observe accuracy, p95 response latency,
   cost, error budgets, abort behavior; stop rollout on any P0.

## Verification matrix
- Unit: malformed schemas, money-unit ambiguity, unrelated sites, cycle/missing dependency,
  duplicate tool call IDs, excessive task budgets, unavailable product data, unsupported rates.
- Integration: authentication, CSRF, rate limits, profile and recommendation binding, account
  logout mid-turn, profile mutation before financial response, idempotency semantics.
- Browser: Chrome speech recognition, disabled microphone, close during recognition/ASR/TTS,
  account switch, accessibility, keyboard and screen reader.
- Financial: deterministic engine parity, no fabricated rate, nominal vs post-tax distinction,
  risk disclosure, profile capacity constraints, source-rights evidence.
- Reliability: provider outages and budget exhaustion; no infinite retries or stale narration.
- Supply chain: baseline npm audit vulnerabilities and Python dependency auditing must pass
  without suppression; verify lockfiles and rerun complete integration tests.

## Critical incomplete items
The existing general aiToolOrchestrator still needs a separate hardening patch before exposure.
The current browser integration is **not** ChatGPT desktop-style computer use.
Do not call this branch production-ready even if ordinary CI becomes green.

## Hardening iteration — October 24, 2026
- SIP UI: editing any assumption aborts/invalidate the pending request and prevents stale results.
- SIP response: check every submitted amount, horizon, rate, total invested, difference, and nominal classification before display.
- SIP backend: cross-check monthly contribution * years * 12, integer result parity, and additional capacity-affecting profile fields even when revision does not change.
- Voice routes: separate authenticated per-user quotas, production distributed-store fail-closed behavior; financial comparison 12/min, interpretation 40/min.
- This is a bounded, read-only slice. Full browser task execution, native streaming, independent speech evaluation, privacy/legal review and supply-chain audit are still release blockers.

## Compressed body parser mitigation
GHSA-27r3-jxmh-p828 affects vulnerable body-parser versions used by Express.
WealthGenie's main JSON parser now rejects compressed request bodies with HTTP 415
(`inflate:false`), removing that vulnerable decompression path at this entry point.
This is an interim defense, **not** an npm audit resolution. Transitive parsers,
MCP transports, other middleware and external packages require independent inventory.
Update dependency versions and lockfiles through a reproducible npm install, rerun
npm audit, unit and full E2E/security checks before signing off.

## Read-only task preview integration
`POST /api/voice/task-preview` now accepts a **user-submitted** bounded DAG of
APP_NAVIGATE and at most one SIP_COMPARE_DRAFT. The endpoint validates all steps
with SovereignTaskPlanPolicy, runs verified read-only SIP calculations in
dependency order and returns navigation *proposals*, not applied actions.
It is JWT-authenticated, separately rate-limited to 6 requests per minute,
bounded to 12 seconds with cancellation fencing, and controlled by the
existing GENIEVOICE_TASKS_ENABLED kill switch. No model or browser executor is
connected; no financial state is modified, and no persistent ledger exists.
This remains a preview foundation, not production-ready automation.
