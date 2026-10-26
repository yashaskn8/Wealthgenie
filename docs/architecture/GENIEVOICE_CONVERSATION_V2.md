# GenieVoice Conversation Mode (JARVIS-style V2) — draft rollout

## Delivered in this branch
- **Explicit opt-in** `Conversation mode` button in the already feature-flagged GenieChat UI. Starting it requires a visible click; no background or hidden microphone.
- Live interim speech captions. Only the **first final** result can issue a single interpreted intent; duplicate results cannot double-dispatch.
- Optional natural invocations such as “Hey Genie, open my goals” and “Genie, bring up profile”; authority remains in the server's finite navigation allowlist.
- Server rejects unknown navigation targets instead of silently treating “open ...” as an ordinary chat prompt.
- For `CHAT` intents **while Conversation mode is actively enabled only**, sends the spoken informational question through the existing authenticated GenieChat `sendMessage` path. Normal one-shot commands still populate the editable text field for review.
- GenieChat's chat session identity remains stable while a reply is loading; `chatBusy` suspends microphone/actions, and a changed grounded `PASS` reply with accepted evidence can be spoken automatically.
- Only after verified TTS finishes (or an authorized read-only navigation is requested) does the foreground conversation schedule another microphone turn. TTS itself must finish before rearming, preventing self-recognition.
- Microphone stop, local “goodbye genie”, denied microphone permission, navigation failure, session identity change, disable and component unmount cancel/stop requests, synthesis and queued rearming.
- Prefer regional English synthesis voices where available; fall back to the browser's installed voice.
- No transcription persistence, account-wide voice memory, unrestricted browser tools, trading, financial mutations, wake-word background listener, or autonomous app writes are added.

## Authorization / privacy boundaries
1. Voice recognition uses `SpeechRecognition`/`webkitSpeechRecognition`, if available. Browser speech recognition may use a provider; this is shown in the UI. There is no guaranteed on-device/private recognition.
2. A transcript is untrusted: raw control/invisible characters and >1000 characters are rejected *before trim*. Classify via authenticated `/api/voice/interpret` with server-side quota and strict typed intent.
3. Unsupported or rejected intents never invoke `onQuestion`. If classification fails, stop hands-free operation and return an editable text draft; **never automatically send unclassified input**.
4. Auto-ask is reserved for `CHAT` results during an explicitly active conversation; navigation and SIP panel access remain allowlisted. Existing authenticated chat applies its financial binding, idempotency and rate limits.
5. Verification is mandatory for automatic speech: `grounded === true`, `validation_status === 'PASS'` and at least one allowed evidence identifier. Changed answers immediately cancel stale speech.
6. The existing deployment kill switches remain **OFF** by default. This branch is not a production sign-off.

## Acceptance / manual device checklist
- In Chrome with mic permission, enable Conversation mode, say “Hey Genie, show goals”, verify canonical navigation and rearm. Try “open unknown route” and “transfer money” and confirm neither sends chat nor executes a task.
- Ask “Explain my SIP,” confirm one informational chat send, mic OFF during backend latency, spoken answer only if grounded verification passes, then rearm after speech finishes.
- Verify “goodbye genie” ends the session; Stop while checking blocks a late navigation; close chat, change profile, log out or clear chat to cancel mic/replies.
- Deny/revoke mic permission, test `no-speech`, browser without SpeechRecognition, speechSynthesis unavailable, tab background/foreground, Chrome Android, Edge and Safari if supported.
- Test screen reader, keyboard-only access, reduced motion, locale differences, TTS voice availability, and failure/stale-reply handling.
- Run React lint/typecheck/Vitest/build; Node backend lint/test, real-browser E2E, regression/supply-chain audits and privacy/security review at this PR HEAD. **Not run to certification from this editing session**.

## Still needed for a full personal-assistant experience
Native audio streaming/STT/VAD with explicit audio retention limits; faster server streaming of verified spoken answer chunks; interrupt-safe barge-in with hardware mic arbitration; multilingual intent parity; permissioned tools with separate approval per privileged action; durable session/task ledger; observability on p50/p95 recognition + response latency, abort and error rates; rigorous device and threat testing. Do not advertise these as implemented by this branch.
