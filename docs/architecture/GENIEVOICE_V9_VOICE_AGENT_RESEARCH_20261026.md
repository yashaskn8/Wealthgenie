# GenieVoice V9 — production voice agent patterns and safe adaptation

Reviewed: 26 October 2026. This document is a design review and a narrowly scoped
implementation change, **not** a voice-provider performance benchmark, legal
approval or production deployment certification.

## What strong voice platforms do

| Platform | Publicly documented production pattern | WealthGenie decision |
| --- | --- | --- |
| OpenAI Realtime / server sideband | WebRTC conversational audio, barge-in and conversation truncation; server-controlled tools and output gating | Keep financial authorization and response verification server-side. Native generated speech must not bypass the verified-text gate. |
| LiveKit Agents | Turn detection vs speech activity, configurable interruption/false-interruption recovery, latency observability | Adopt explicit turn/session fences; evaluate real-device interruption and p50/p95 turn latencies before any streaming migration. |
| Google Gemini Live | Multilingual voice, server interruption events, audio-buffer discard and session resumption | Preserve language-aware fallback and discard stale playback. Do not treat audio language fluency as sourced financial truth. |
| Deepgram Flux / Nova | Integrated turn-end events and transcription keyterms; feature/locale coverage differs by model | Benchmark turn detection only where the exact locale is supported. Flux Multilingual's documented languages include Hindi, **not Kannada**. |
| ElevenLabs Agents | Maximum conversation duration, timeout handling and interruption settings | Adopt a bounded, opt-in session with explicit renewal; keep browser-native TTS of verified text as the default. |

References (first-party documentation checked 2026-10-26):

- https://developers.openai.com/api/docs/guides/realtime
- https://developers.openai.com/api/docs/guides/voice-server-controls
- https://docs.livekit.io/agents/logic/turns/tuning/
- https://ai.google.dev/gemini-api/docs/live-api/best-practices
- https://developers.deepgram.com/docs/models-languages-overview
- https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow

## Inventory of already implemented WealthGenie safeguards

The existing browser-based GenieVoice already:
- uses an explicit opt-in microphone gesture and foreground-only browser speech recognition;
- supports manual English (India), Hindi and Kannada speech locale selection;
- stops on logout, account rebind, page hide, recognized local stop phrase and a user interruption;
- classifies voice navigation with the server-side allowlist (no voice financial mutations);
- requires a visible user confirmation before sending high-stakes recognized numbers;
- speaks only the exact verified, displayed financial answer; it does not speak an unverified LLM response.

These are **browser speech services**, not a qualified live WebRTC, low-latency native voice provider. See
`GENIEVOICE_V8_PRODUCTION_VOICE_PLATFORM_SYNTHESIS.md` for the broader architecture.

## Changes implemented in V9

### 1. Correctable financial speech transcripts

The financial transcript review displays the original ASR transcript **and** a
labelled, editable, 1,000-character correction field. Users can fix a misheard
amount, interest percentage or duration before submitting the question.

- Reuse the original strict raw transcript validation; control characters, empty
  or oversized corrections never reach chat or the voice interpreter.
- A changed transcript is sent through the **same authenticated, rate-limited,
  server-side voice intent classifier again** before it can be submitted as chat.
- Only a `CHAT` action and exact `VOICE_INTENT_VERSION` may proceed. A new
  navigation instruction or rejected financial action cannot become executable
  through editing.
- A pending classification is cancellable and time bounded. Account rebind,
  page hide, stop, disable or stale turn ID discards late classification results.
- No corrected transcript is stored in localStorage, analytics or new telemetry.

### 2. Five-minute maximum opt-in conversation

Hands-free microphone/reply cycles are capped at **five minutes per explicit
start**. The deadline does not reset as the microphone restarts between turns;
after expiration the app stops the microphone, pending requests and TTS and
requires a new user gesture. A separate conversation epoch ensures an old
timer cannot end a newer session. One-shot manual voice/navigation remains
available. This is an operational/privacy limit, not a guarantee about
browser/platform speech-provider retention.

## Tests added

The focused React suite covers corrected financial amounts, mandatory
reclassification, forbidden edited commands, raw-control rejection,
post-account-change late results, session expiry and stale deadline callbacks.

Run in `reactapp`:
```sh
npm ci
npm run lint
npm run typecheck
npm test -- src/components/__tests__/SovereignVoiceControl.test.jsx
npm run build
```

## Production gates still open

- GitHub CI must be green at the merge commit; verify the browser integration and
  continuous-deployment Kind smoke checks separately.
- Real Hindi and Kannada speakers should test numeric confusions, code switching,
  noisy environments and accessibility on supported devices.
- Realtime audio transport, acoustic barge-in/false-interruption recovery, provider
  handoffs, device-specific latency evaluation, and session cost instrumentation
  remain future work, not features claimed by this patch.
- Before connecting another audio provider, review where raw microphone audio
  goes, consent and retention terms, Indian privacy/regulatory implications, and
  how unverified live output is withheld before any playback.
- Keep `GENIEVOICE_TASKS_ENABLED` and `VITE_GENIEVOICE_TASKS_ENABLED`
  disabled by default until all release gates are met.

## Additional provider research, checked 26 October 2026

These are **documented capabilities**, not evidence that any provider meets
WealthGenie's real-user quality, India processing, accuracy or privacy gates.
Avoid inferring a global quality ranking from vendor benchmarks.

| Candidate | Particularly relevant capability | Caveat / proposed treatment |
| --- | --- | --- |
| **Meta Muse Voice Transcribe 1.0** | September 2026 streaming ASR, in-model endpointing, vocabulary hints and code switching; official API lists English, Hindi and Kannada among 25 validated languages | Transcription only (no TTS or conversation model). No word-level timestamps or confidence scores: never turn its output directly into an approved financial amount; benchmark using actual speakers and explicit review. |
| **Sarvam Saaras v4** | India-focused ASR with documented `hi-IN`, `kn-IN`, `en-IN`, WebSocket streaming, and codemix/transliteration output choices | Version-specific features vary across REST and WebSocket. Marketing claims on language quality, residency or retention require contractual validation before integrating raw account-related audio. |
| **Sarvam Bulbul v3** | Indian-language synthesis including Kannada and Hindi | Candidate for narrating **only** already-verified WealthGenie text. Evaluate mixed-script numbers and acronyms against the actual rendered transcript; never let TTS rewrite financial facts. |
| **Pipecat** | An open-source orchestration/pipeline that coordinates interruption and cancellation of in-flight output | Consider only when full-duplex streaming is justified; it is not financial authority, a speech provider, or an automatic privacy guarantee. |
| **Retell AI / Vapi** | Phone-first interruption sensitivity, latency diagnostics, call/webhook observability | Learn from operational patterns, but telephony and hosted call logs are not a priority for WealthGenie's opt-in web microphone interface. |

First-party research references:

- https://research.meta.ai/blog/introducing-muse-voice-transcribe (2026-09-01)
- https://dev.meta.ai/docs/speech-to-text (realtime modes, supported languages, keyword biasing, limitations)
- https://docs.sarvam.ai/api/getting-started/models (current model/language matrix)
- https://docs.sarvam.ai/api-reference/speech-to-text/transcribe/ws (Saaras streaming)
- https://docs.pipecat.ai/pipecat/fundamentals/interruptions
- https://docs.retellai.com/reliability/check-estimated-latency
- https://docs.vapi.ai/debugging

### Privacy pitfall in hosted voice-agent observability

Do not assume application logs are the *only* place raw transcripts live.
LiveKit Agent insights may include transcripts, audio, logs and traces; its
`AgentSession.start(record=...)` configuration can opt out of recording or
turn off individual categories. In any future migration, explicitly assess
provider-side defaults, storage region, transcript/redaction behavior,
retention, security access, deletion and user consent. Do not enable default
conversation recordings to collect debugging metrics. Prefer an independently
redacted, content-free stage latency summary to any transcript-bearing trace.

References:
- https://docs.livekit.io/reference/agents/session-recording-options/
- https://docs.livekit.io/reference/agents/session-traces/
- https://docs.livekit.io/testing/observability/insights/

### Evaluation protocol — evidence required before selecting speech vendor

1. **Gold data**: obtain *consented*, human-transcribed recordings and
   authoritatively labelled expected amounts/rates for English India, Hindi,
   Kannada, and English-code-mixed examples. Cover digits and words, lakh/crore,
   years vs months, negative returns, rupees vs percentages, false starts,
   corrections, negation, ambiguous instructions and local navigation phrases.
   Honor the established V5 minimum of 200 labelled prompts **per language**.
2. **Scenarios**: representative Android browsers, iOS Safari where supported,
   wired/microphone headsets, midrange phones, noisy rooms, low-bandwidth links,
   drop/reconnect and no-provider fallback; stratify by user-approved accent/
   speaking style instead of extrapolating from a leaderboard.
3. **Metrics**: exact financial-slot error rate (currency, amount, duration,
   rates, negation), unsafe auto-submit rate, unintended action rate,
   transcription coverage, rejected/uncertain rate, p50/p95 input-to-captions,
   end-of-turn-to-verified-text, verified-text-to-audio and whole-turn latency,
   interruptions, token/microphone termination and cost per **successful**
   verified session. General word error rate alone is insufficient.
4. **Release blockers**: no accidental money movement (voice policy remains
   read-only); no wrong-account playback, no unverified spoken finance answer,
   no silent numeric assumption; no raw voice stored in diagnostic telemetry;
   independent privacy/regulatory review, user-visible fallback, kill switch,
   rollback and canary measurements.
5. **Trial design**: first use a **shadow/offline transcription comparison**
   on consented examples, not direct microphone streaming or new API keys in
   production. Pick a candidate only after an auditable test report; add a
   provider adapter and opt-in streaming rollout as a separate reviewed change.

### Practical next architecture decision

Keep the existing `Browser ASR -> authenticated intent policy -> verified
financial backend -> verified text -> TTS` separation. The biggest near-term
production gain is better *measured* Hindi/Kannada numeric transcription, not
the ability to let a realtime audio model improvise finance dialogue. If later
adding semantic endpointing or full duplex, treat interruption, transcript,
tool authorization and speech-release as separate stateful trust boundaries.
See also:
- https://developers.openai.com/api/docs/guides/realtime-vad
- https://docs.livekit.io/agents/logic/turns/tuning/
