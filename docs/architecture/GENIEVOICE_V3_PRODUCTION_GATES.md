# GenieVoice V3 — Production Readiness and Release Gates (Draft)

> This branch is **not** a production certification. Keep the existing feature flags OFF until full CI, security review and human real-device testing have passed. It layers on top of PRs #60 and #67; their independent release blockers remain open.

## What V3 changes from the previous voice prototype
1. **Turn provenance**: GenieChat returns the response from the exact authenticated `sendMessage` call. The voice controller waits for that matching response to appear in the current UI and rechecks `grounded: true`, `validation_status: PASS` and allowed `E_...` evidence IDs before TTS. Any mismatch stops voice within a 2-second display deadline.
2. **Session security**: Each microphone turn receives an epoch token. Stop, account change, disable, visibility loss, unmount, error and timeout fence all callbacks. No late command or unrelated prior reply can navigate, speak or restart the microphone.
3. **Explicit interaction**: Conversation mode requires a foreground user click. Only the first final ASR result dispatches a backend-authenticated allowlisted intent; interim recognition produces a visible caption only. The user can end while chat is still loading, or interrupt playback by pressing **Speak now**.
4. **Bounded resource use**: 20-second speech-capture deadline, 10-second intent deadline, 45-second voice reply deadline, 2-second display-matching deadline, and 180-second TTS watchdog. Even an upstream request that ignores cancellation cannot leave voice controls permanently spinning. A stopped voice turn may not cancel an already-submitted chat request; its response still appears in chat but will **not** be narrated.
5. **Foreground privacy**: Closing/leaving/backgrounding the page turns off voice. No background microphone capture, hidden wake-word recording, persisted transcript, arbitrary browsing, or autonomous financial mutation is enabled.
6. **Output validity**: Oversized spoken answers are declined, never selectively truncated into potentially misleading financial claims. Regional English TTS is preferred when installed and standard browser speech remains a fallback. Verified text remains available in chat.
7. **Focused CI**: Standalone `genievoice-quality.yml` runs frontend lint, typecheck, voice policy and component tests, existing chat state tests, frontend build, backend lint and voice authorization/API tests.

## Threat model / fail closed
| Threat | Handling |
|---|---|
| Multiple final ASR events | After first final event, detach/abort recognition; remaining events fail token + identity checks |
| Raw control characters or invisible text | Reject before trimming/normalization; same backend rule |
| Unauthorized money action / external website | Backend classifier denies; frontend independent canonical route allowlist |
| Forged speech intent | Exact protocol version + action + canonical destination checked; no model-generated tool execution |
| Slow, cancelled, or out-of-order requests | Epoch fencing, abort, deadlines, and response-to-chat identity match |
| Account switch or new chat session | Invalidate in-flight operations, hide prior account's SIP draft |
| Unverified AI/finance claim | No voice playback without server grounding verification and evidence IDs |
| Background tab/privacy interruption | Stop recognition and synthesis; clear timers; require new foreground gesture |
| Audio feedback from Genie into mic | Microphone off for checking, reasoning and spoken playback |
| Denied microphone, unsupported API, speech error | Voice ends; text chat remains available |
| Stalled browser TTS | 180-second watchdog; voice ends without rearming |

## Test and launch checklist
- [ ] New V3 voice-specific CI workflow green at the **latest** SHA.
- [ ] Existing PR #60 and PR #67 full regression and security gates green at the actual merge SHA.
- [ ] Threat-oriented browser E2E with mocked recognition result duplication, tab hide, auth revocation, slow chat, stale answer and TTS failure.
- [ ] Chrome desktop, Chrome Android, Edge and supported Safari device testing, with permissions denied/revoked and OS media device interruptions.
- [ ] Accessibility test: keyboard-only, focus order, aria-label and screen reader, caption readability, reduced motion.
- [ ] Verify speech provider's data retention/processing terms, privacy notice, consent records and India-facing legal/compliance scope.
- [ ] Instrument anonymous latency histograms: mic start latency, ASR completion, intent p95, verified chat p95, TTS first audio, cancellation outcome, device error rates. **No raw audio or transcript contents in telemetry.**
- [ ] Load and rate-limit tests, dependency audits, staging canary, incident alarms, 0% rollback via existing frontend + backend kill switches.
- [ ] Product/legal sign-off before any money movement, real trade, persistent account memory or external browser action.

## Suggested targets for human acceptance (not measured results)
- No wrong-account narration or unauthorized action in cancellation/identity regression corpus.
- No auto-submit when server classification fails; no ungrounded spoken financial advice.
- Explicit stop/hide tears down microphone and speech promptly on every supported device.
- Voice capture start and response/first-audio latency measured at p50/p95 on real mobile/desktop environments before any SLO is declared.

## Not shipped yet
Native duplex realtime WebRTC audio; robust streaming VAD / echo cancellation and truly voice-barged-in interruptions; reliable offline/on-device STT; multilingual verified speech; multi-step external computer operation; persistent voice personalization with informed consent; signed external browser grants; transactional financial actions. These need distinct security, infrastructure, privacy, human-device and load-test work. Calling this a fully autonomous JARVIS or a production-proven release would be inaccurate.
