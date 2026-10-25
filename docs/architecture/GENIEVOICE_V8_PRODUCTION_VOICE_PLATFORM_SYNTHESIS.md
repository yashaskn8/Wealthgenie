# GenieVoice V8 — Production voice platform synthesis
Research date: 26 October 2026. This is a **design comparison**, not a vendor benchmark or certification. Existing voice is browser ASR/TTS, not WebRTC streaming.

## 1. Current documented strengths (verified from first-party sources)

| Platform | Reusable strength | Practical limitation |
|---|---|---|
| OpenAI Realtime / server-controlled GPT-Live | WebRTC low-latency voice, semantic VAD, tool handoffs, server sideband control, response interruption/truncation, gate audio before playing | Audio generated directly by a conversational model must **not** bypass WealthGenie finance verification |
| Google Gemini Live | Multilingual real-time audio, VAD interruptions, asynchronous tool returns and natural turn-taking | Audio playback must be cleared on interruption, session lifecycle/cost need explicit bounds |
| LiveKit Agents | TURN/EOT tuning, false-interruption recovery, WebRTC coordination, stage-level latency tracing | Framework, not a qualified financial evidence source or proof of Kannada quality |
| Deepgram Flux/Nova | Agent-native transcription and turn detection; Nova family provides more multilingual/code-switching controls | Flux Multilingual currently lists Hindi but **not Kannada**. Do not choose it as the sole Indic ASR |
| Google Cloud Speech-to-Text | Provider-documented Hindi (hi-IN) and Kannada (kn-IN) model options | Model availability/feature support vary by region, model and API variant |
| ElevenLabs Agents | Silence timeout, turn-eagerness and barge-in settings | Speech naturalness must not determine finance answer authority |

Authoritative references:
- https://developers.openai.com/api/docs/guides/realtime
- https://developers.openai.com/api/docs/guides/realtime-vad
- https://developers.openai.com/api/docs/guides/realtime-conversations
- https://developers.openai.com/api/docs/guides/voice-server-controls
- https://ai.google.dev/gemini-api/docs/live-api/capabilities
- https://ai.google.dev/gemini-api/docs/live-api/best-practices
- https://docs.livekit.io/agents/logic/turns/tuning/
- https://docs.livekit.io/reference/agents/session-traces/
- https://developers.deepgram.com/docs/models-languages-overview/
- https://docs.cloud.google.com/speech-to-text/docs/speech-to-text-supported-languages
- https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow

## 2. Recommended combined design

**Layer 1: opt-in audio transport** — WebRTC via a transport abstraction; provider interface supports realtime model or cascaded transcription/response synthesis. Credentials and tool secrets stay on the server. Session-bound ephemeral credentials only. Keep a reliable push-to-talk/text fallback. Explicit locale or provider-tested auto-language selection, not blind language guessing.

**Layer 2: interruption-aware coordinator** — Single authority per user turn. Assign monotonically increasing turn epochs and unique IDs to audio chunks, transcripts, tool outputs and playback receipts. On barge-in/logout/account change/tab hide: stop microphone where appropriate, cancel pending calls, clear playback, reject late results; never replay prior-account audio. Implement false-interruption recovery only if the cleared prior response was verified and still bound to the same session.

**Layer 3: financial intent and parameter confirmation** — classify approved navigation, unsupported actions, educational questions and scenario calculations *on the server*. Financial amounts, durations and rates need user confirmation when recognized by ASR. On ambiguity, ask which number was intended. No ASR/model response can directly authorize external URLs, money movement or investment orders.

**Layer 4: deterministic tools and financial knowledge** — prefer account-bound fresh snapshots, versioned qualified sources with retrieval dates and scopes, and numerical calculators. Never present assumptions as observed market facts, direct user-specific investment allocation decisions, or unsupported personal post-tax outcomes. Support open-world questions by decomposing them into known tool operations; abstain or clarify when no qualified calculation exists.

**Layer 5: financial response verification and speech release** — only approved answer IDs and matched evidence produce speech. Reject uncited unverified financial claims. A native audio model's unverified financial speech cannot be played first and checked later. For initial launch, use TTS *of the already verified text*. In future audio-stream mode, implement the documented server-check-and-release segment gate, including playback queue cancellation and transcript consistency checks.

**Layer 6: context-sensitive product navigation** — only typed canonical WealthGenie page suggestions, shown as explicit opt-in controls; never model-generated paths or silent feature opening.

**Layer 7: observability with privacy** — latency breakdown (ASR, end-of-turn, routing, finance tool, verification, TTS, total), dropped-turn rate, refusal/abstention rate, false interruption rate, per-language number error rate, privacy/account-fence violations. Store only aggregate or redacted operational metadata, never raw microphone audio or sensitive transcript contents in telemetry.

## 3. Changes in V8 branch

- **Implemented**: numeric-financial hands-free transcript confirmation gate. A recognized SIP amount, return, currency or duration must be shown and explicitly approved before a chat question is sent. Cancellation, language switching, new microphone capture, session rebind and unmount clear pending review. Ordinary educational questions continue without the extra step. Existing read-only intent authorization and verified TTS remain mandatory.
- **Not implemented**: streaming WebRTC provider connection, remote ASR selection, provider paid keys, acoustic barge-in, cross-vendor fallback, vendor-side session tracing, realtime audio segment buffering/verification. This document specifies those as future gated integrations.

## 4. Engineering acceptance criteria for a streaming migration

1. Evaluate *actual* Kannada/Hindi speakers and accents, code switching, noisy rooms, numeric confusions (₹15,000 vs ₹50,000), names and financial abbreviations, accessibility, and provider-outage flows.
2. Unit tests enforce user review before financial ASR dispatch, stop/unmount/session invalidation, never speaking before answer verification, immutable intent restrictions.
3. P50/P95 end-to-end and stage latency targets must be chosen after a baseline on representative Indian mobile networks; no invented vendor speed ranking.
4. Independent arithmetic checks, evidence freshness gates and adversarial financial prompts; zero unauthorized side-effectful voice actions in safety tests.
5. Privacy/security review for which provider processes raw audio, transcript retention, data regions, revoke/expiry behavior, permissions and account isolation.
6. Canary rollout with kill switches, recoverable text fallback and rollback plan. Nothing here authorizes deployment.

## Why combine rather than choose one agent?

Natural speech is a *transport/conversation property*, not a source of investment truth. Pair the strongest interchangeable audio service with WealthGenie's already restricted finance backend. If provider quality, languages or pricing change, replace the audio edge—not the financial authorization architecture.
