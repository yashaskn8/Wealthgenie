# GenieVoice V5 — Hindi/Kannada + Scenario Red-Team Hardening

**Status: feature-branch implementation; not deployed or production certified.** Builds upon stacked draft PRs #60, #67, #68 and #70. Keep existing `VITE_GENIEVOICE_TASKS_ENABLED` and `GENIEVOICE_TASKS_ENABLED` opt-in switches off until full end-to-end, user/privacy and legal release gates have passed.

## Implemented

### Voice locale
- Explicit speech recognition selection `en-IN`, `hi-IN`, `kn-IN`. Selection is **not** autonomous language detection: it binds the browser `SpeechRecognition.lang` and stops old recognition first.
- Hindi and Kannada local stop phrases; no backend or chat request for recognized stop words.
- Exact Hindi and Kannada phrases for known app navigation and SIP comparison; never interpret or execute an unrecognized translated tool action.
- Language-dependent verified TTS: inspect the script of the **validated response**. Kannada text is assigned Kannada speech locale, Hindi text Hindi, English text English. A user choosing Kannada input does not turn an English answer into a Kannada answer.
- Speech provider support, microphone permissions and installed voices remain browser/OS-dependent. No offline or always-on Kannada wake-word engine.

### Bounded finance and scenario knowledge
- Added read-only, deterministic SIP + inflation + optionally one-time shock evidence sourced **only from explicitly provided amounts and percentage assumptions**. Accepts Devanagari/Kannada numerals and narrow spoken phrases.
- Requires explicit monthly INR amount, 1–30-year horizon, user-supplied 0–30% effective annual gross growth, 0–20% annual inflation. One-time market fall also requires a 0–90% assumption and explicit year in horizon. Ambiguity returns an input-needed receipt instead of a guessed projection.
- Monthly contributions arrive at month-end; modeled constant annual growth is translated to equivalent monthly growth; shock is applied once to modeled balance at the specified end of year, not treated as an empirical forecast. Compare nominal amount and purchasing power in today's rupees. Before fees, taxes and irregular markets. Does not assess profile affordability/suitability or recommend an investment.
- Verified account-bound financial chat also has this evidence. Users without a saved profile can ask a self-contained hypothetical in authenticated chat. Prior turns never silently supply rates.
- Expanded reviewed Indian-language public investing education for the concepts **SIP, compounding, diversification, inflation**. These translations are WealthGenie-authored interpretations, not quotations from the linked public source and not a claim of comprehensive tax/product coverage.
- Hindi and Kannada financial topics must not route to the uncited general-chat LLM.

### Adversarial coverage
- Partial/conflicting/oversized transcripts, Unicode invisible controls, mixed-script route impersonation, unsupported and compound commands, direct transaction requests, time-of-market-shock ambiguity, oversized/negative returns, user-visible response matching, late answers, backgrounded tab, locale switch and local stop phrases.
- Frontend verification keeps source-grounded speech, browser visibility and account fencing from V3. Backend still has **zero** financial mutation privileges in the voice command allowlist.
- Reuse the existing typed feature suggestion buttons for question-based navigation; an ambiguous multi-feature question produces no arbitrary navigation.

## What is *not* implemented or independently proven
- Comprehensive professional-quality coverage of all Indian finance, regulations and investment products.
- Truly natural multilingual dialogue, unlimited code switching, independent verification of machine translation, offline speech recognition, or consistent Kannada voices across mobile browsers.
- Full end-to-end multi-tool scenario solver, individualized post-tax outputs, actual portfolio data risk shock modeling or certified suitability advice.
- Realtime streaming/VAD/echo cancellation, always-listening wake word, hands-free barge-in, realtime device benchmarks or autonomous computer control.
- External financial transactions, order placement, money transfers or writes; these remain prohibited.

## Release gates (mandatory)

- [ ] All V5 focused GitHub CI checks green on **last commit**; legacy base branch CI and full service suites green at merge SHA.
- [ ] Android Chrome, Windows Chrome/Edge, Safari/macOS/iOS and real Kannada/Hindi-speaking devices tested. Handle unsupported browser ASR/TTS, permission denial/revocation, voice-packs absent, OS focus/audio loss, noise and accent/code switching.
- [ ] At least 200 labeled prompts per language across direct questions, contexts, mixed languages, numbers, spoken commands, rejected commands, adversarial prompts and navigation ambiguities; publish per-language false action and hallucination rates.
- [ ] Independently re-derive SIP/inflation and drawdown figures in paise using a separate reference and fuzz/property testing at extremes.
- [ ] Verify that every English/Hindi/Kannada financial claim is supported by qualified evidence with links and lifecycle review. Legal review against currently effective Indian SEBI rules; no regulated personalized advice without authorization.
- [ ] Confirm microphone and transcript privacy notices with third-party browser ASR provider terms and real recordings on devices. No private audio/transcripts in analytics; kill switch and data retention controls.
- [ ] Canary + rollback; product telemetry of ASR request success, intent false positives, scenario abstentions, p50/p95 answer/speech latency by language without recording private prompts.

## Manual demo prompts

English: "What if I invest ₹15000 monthly SIP for 10 years at 8% annual return, 6% inflation and 20% market crash after year 5?"

Hindi: "अगर मैं ₹१५००० मासिक निवेश एसआईपी १० साल, ८% वार्षिक रिटर्न, ६% महंगाई और २०% गिरावट ५ साल में देखूं तो क्या होगा?"

Kannada: "ಒಂದು ವೇಳೆ ₹೧೫೦೦೦ ತಿಂಗಳ ಹೂಡಿಕೆ ಸಿಪ್ ೧೦ ವರ್ಷ, ೮% ವಾರ್ಷಿಕ ರಿಟರ್ನ್, ೬% ಹಣದುಬ್ಬರ ಮತ್ತು ೨೦% ಕುಸಿತ ೫ ವರ್ಷ ನಂತರ ಏನಾಗುತ್ತದೆ?"

Local stop: "सुनना बंद करो" / "ಸಂಭಾಷಣೆ ನಿಲ್ಲಿಸು"

Allowed commands: "लक्ष्य खोलो" / "ಗುರಿಗಳನ್ನು ತೆರೆ"

Forbidden requests: transfer money, execute a stock trade, visit an arbitrary external website, multi-step shell/browser tasks. All must be rejected or remain ordinary non-executing informational chat.

**Investment results are illustrative. Never imply historical market decline, hypothetical return or inflation input is a current fact.**
