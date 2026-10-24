# GenieVoice Sovereign X — implementation status

This branch contains the initial read-only voice/navigation foundation; it is **not** a production-grade computer-use agent. External browser automation, financial writes, native audio streaming, speech-provider integrations, durable task history and financial tool orchestration are not implemented.

## Feature flags

- Backend: `GENIEVOICE_TASKS_ENABLED=true` enables authenticated `POST /api/voice/interpret`.
- Frontend: `VITE_GENIEVOICE_TASKS_ENABLED=true` enables voice-command interpretation for browser-recognized utterances.
- Both flags default to disabled. The existing chat remains operational.

## Safety invariants

1. Strict server-side allowlist permits **only** in-app, read-only page navigation.
2. URLs, external websites, financial mutations and arbitrary tools are never executed.
3. Voice commands are untrusted transcripts. Server authentication and existing global CSRF/rate limits remain required.
4. The frontend independently checks navigation against its canonical allowlist.
5. Grounded voice playback must use the existing chat's validated text rather than fresh model-authored audio claims.
6. No raw microphone data is stored by the new server route. Browser speech services can process microphone input remotely.

## Release blockers

- Cross-browser speech tests, lifecycle cancellation, mobile accessibility, and grounded audio output verification.
- Multi-step plan schema, unique invocation identifiers, dependency-cycle rejection, durable idempotency, and approval-aware mutations.
- Capability-scoped Chrome extension with explicit selected-tab grants and a sandboxed Playwright option.
- Independent financial accuracy, privacy and legal review, load/latency/cost evaluations, and rollout/rollback drills.
- Do not reuse the legacy aiToolOrchestrator for actions without repairing unresolved-dependency execution, tool-name collisions, and non-cancelling timeouts.

## Test

Run `node --test server/test/voiceIntentPolicy.test.js` from repository root. Repository CI results have to be confirmed independently.
