# GenieVoice V10 — targeted adversarial trust-boundary review

Reviewed: 26 October 2026. Changes are proposed on a protected review branch,
not a completed security certification or a production deployment.

## Attacker model and test scope

Voice recognition and its transcripts are **untrusted**: transcription may
mishear quantities, arrive after a session closes, contain invalid controls,
or be replayed by delayed browser/provider callbacks. Authenticated chat
responses can also arrive out of order. Treat ASR events, intent classifications,
financial values, tool results, and text-to-speech as separately authorized
boundaries. This is source-code and regression-test assessment, **not** live
service penetration testing or permission to execute transactions.

| Defensive simulation | Original gap | Fix and regression coverage |
| --- | --- | --- |
| Finish cancelled classification after next microphone capture started | Old interpreter `finally` cleared the *new* intent timer; a stuck request could escape deadline enforcement | Clear only a timeout owned by the exact active abort controller; test old/new turn ordering |
| Finish cancelled chat answer after second conversation starts | Old answer `finally` cleared the second conversation's reply watchdog | Only clear answer deadline while current epoch still owns it; test two unresolved conversations |
| Activate a corrected financial confirmation repeatedly | Corrected text could be reclassified and dispatched in parallel | Synchronous per-review confirmation lock; assert only one reclassification and one chat call |
| Show the same spoken sentence from a different evidence set | The authenticated reply and last displayed answer were matched principally by text | Require verified provenance and exact evidence ID list as well as answer text on both sides; test same text/different evidence |
| Dictate an unanticipated amount spelling or numeric phrase | Finite English finance-number dictionary omitted quantities and finance-free numeric phrasing | Expand English/Indic number lexicon; always require review on explicit digits, currency or percentage; test amount and language variants |
| Deliver legacy microphone result after closing chat / switching account / hiding tab | Older GenieChat microphone lacked the session and browser-visibility fences used by newer GenieVoice | Per-capture generation and financial binding checks, abort on closure/rebind/background/unmount, deadline, raw controls rejection and length guard; integration tests |

## Existing constraints retained

- Server voice routes remain authenticated, rate limited and opt-in.
- Only allowlisted in-app navigation may be performed by spoken commands.
- Browser transcripts and user-corrected amounts never directly authorize
  transfers, trades, account changes or external navigation.
- Numeric questions are still reviewable/editable before chat dispatch.
- Only a verified, displayed, source-bound financial answer may be narrated.
- Browser microphone recordings are **not** added to application telemetry.
- WebRTC streaming, third-party credentials, hands-free wake-word mode, and
  payment/order actions are **not** introduced.

## How to reproduce the checks

From `reactapp`:

```sh
npm ci
npm run lint
npm run typecheck
npm test -- src/components/__tests__/SovereignVoiceControl.test.jsx src/components/__tests__/GenieChatState.test.jsx src/utils/__tests__/voiceRuntimePolicy.test.js src/utils/__tests__/voiceFinancialTranscriptReview.test.js
npm run build
```

GitHub CI checks must be reviewed at the final commit and **again at the
merged `main` SHA** before claiming a complete release. The repository CD
workflow may report success while its deployment job is skipped.

## Remaining risks (not fixed or certified by code-only review)

1. **Speech-language quality**: actual Hindi/Kannada speakers, code switching,
   accented speech, ambient noise and misheard currency/negation require
   consented datasets and real-device measurement. Dictionary rules cannot
   prove universal ASR correctness; always allow edited text and cancellation.
2. **Provider privacy**: browser speech services may transmit audio to
   OS/browser providers. Consent notice, device permission lifecycle, provider
   retention and data-region guarantees need external privacy review.
3. **Threat-model limits**: malicious extensions, browser compromise, audio
   injection from a nearby speaker, and device-level microphone permission
   misconfiguration cannot be neutralized solely by UI React guards.
4. **Evidence authority**: the voice client cannot independently validate all
   financial source truth; authoritative backend provenance, suitability,
   arithmetic verification and publisher freshness gates must stay enforced.
5. **End-to-end validation**: privacy/security audit, accessibility,
   real-device reliability, rollout kill switch, rollback, and non-skipped
   deployment smoke tests remain release conditions.

## Red-team cycles 2–3: attack, regression, hardening

After the first timer, session and numeric review fixes, another review
identified additional unsafe state equivalences and voice-control gaps.

### Round 2 — identity and authority substitution

- A previously rendered answer can have identical words and evidence IDs to
  the answer returned by a **different** chat request. New authenticated voice
  replies now carry the originating client-side idempotency `_turnKey` already
  assigned to the stored/rendered message. When either side carries a key,
  narration requires both keys to match. This is a UI correlation safeguard,
  not a user-controlled backend authorization token.
- Replacing an answer while audio is speaking must cancel playback even if the
  new answer has identical words. Narration is now invalidated by mismatched
  verified answer/evidence/turn provenance, not merely a string inequality.
- Indirect imperatives such as requests for Genie to move money, redeem funds
  or set account risk were incorrectly routed into ordinary hands-free chat by
  educational-question heuristics. The server voice interpreter now rejects
  delegated action formulations and additional mutating verbs. Questions
  about what a user may do continue to be classified as educational.

### Round 3 — legacy microphone / chat send overlap

- The push-to-talk microphone must stop before closing a chat; the close
  gesture now invalidates the current recognition epoch synchronously.
- Starting or continuing legacy microphone capture while a chat send, clear or
  rate-limit restriction is active is prohibited. Stale callbacks cannot
  append dictated text to a new request while an earlier request is pending.
- Tests simulate a delayed browser ASR callback delivered after an authenticated
  chat request begins and verify it is ignored.

Release checks required: Vitest voice and GenieChat suites, server voice-intent
policy tests, frontend lint/typecheck/build, full GitHub CI, post-merge main
checks, and separately verified cluster smoke tests. This record lists test
scenarios; it does not certify absence of other attack paths.
