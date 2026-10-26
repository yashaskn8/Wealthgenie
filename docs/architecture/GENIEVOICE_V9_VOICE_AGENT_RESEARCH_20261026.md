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
