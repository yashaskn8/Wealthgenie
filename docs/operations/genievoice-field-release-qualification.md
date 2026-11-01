# GenieVoice field release qualification — evidence required

**Scope:** `yashaskn8/Wealthgenie` only. This is a release gate and
measurement protocol, **not a production-readiness certificate**.
All optional voice/task/receipt feature flags remain **off** until the real
evidence is independently reviewed, and a deployment-specific decision is made.

## Current automated evidence vs field evidence

The dedicated GitHub workflow exercises authenticated voice policy, safe
financial narration, React voice lifecycle, accessibility semantics, lint,
typecheck and build. Those checks cannot measure live browser speech quality,
actual audio-provider data retention, real-device screen-reader behavior,
network-dependent latency or deployment rollback.

A synthetic JSON test fixture exercises the release validator in CI. It is
**not** a user study, a live speech benchmark, or an accessibility approval.

## Field protocol (consented, aggregated, privacy-preserving)

1. Collect at least **200 consented labelled utterances per locale** for
   `en-IN`, `hi-IN`, and `kn-IN` across at least 10 distinct consenting
   speakers per locale. Include a minimum of 50 numeric/high-stakes questions
   and 50 audited financial slots for each locale. Include code-switching,
   lakh/crore amounts, negation, durations, interest rates, partial results,
   interruptions and noise. **Do not commit audio, account details or raw
   transcripts to this repository.**
2. Test at least 10 sessions each on Android Chrome, iOS Safari (including
   **unsupported-ASR text fallback**), and desktop Chrome. Record permissions,
   interruption, lifecycle, account change, keyboard, screen-reader, reduced
   motion and background-page behavior.
3. Calculate actual p95 speech-to-caption, end-of-turn-to-verified-answer and
   verified-answer-to-audio latencies. Initial launch-candidate budgets:
   **3000 ms, 8000 ms, and 2500 ms**, respectively. Confirm the product's
   latency objective with stakeholders before any broader rollout. Compare
   financial slots against human-labelled ground truth; at most 5% ASR slot
   mismatches can be considered for a *review-required* flow, but **zero**
   unreviewed numeric submissions are permitted.
4. Independently verify no voice-triggered financial mutations, unauthorized
   actions, wrong-account narration, unverified financial narration, or audio
   recording without consent. Obtain formal privacy approval for speech
   provider processing, residence/transfer, retention, access and deletion.
   Complete assistive-technology review on actual hardware.
5. Prove a fresh staged deployment, kill switch and rollback drill, alerts
   and on-call ownership. Review evidence links, reviewer identities and
   timestamps independently rather than trusting JSON booleans.

## Private aggregate manifest

The optional `server/scripts/qualifyGenieVoiceRelease.js` command accepts a
private JSON file matching `genievoice-release-evidence-v1`. Its **only**
supported fields are:

- `schemaVersion`, `commitSha`, `deploymentSha`
- `locales`: records containing `locale`, `samples`, `speakers`,
  `numericTurns`, `financialSlotErrors`, `financialSlotsAudited`
- `devices`: records with `device` and `sessions`
- `security`: zero-valued counters for unauthorized actions, wrong-account
  narration, unverified financial narration, unreviewed numeric submission,
  financial mutation and recording without consent
- `latencyP95Ms`: `speechToCaption`, `turnToVerifiedAnswer`,
  `verifiedAnswerToAudio`
- `reviews`: the twelve required independent consent, privacy,
  accessibility, security and deployment review flags listed in
  `server/services/genieVoiceReleaseEvidence.js`
- `artifacts`: approved HTTPS evidence pointers for consent, privacy,
  accessibility, latency and staged deployment

Unknown fields are rejected; the program does not upload, save or print any
raw microphone recordings, personal finances or transcripts.

From `server/`:

```sh
node scripts/qualifyGenieVoiceRelease.js /private/path/voice-release-aggregate.json <40-character-deployed-commit-sha>
```

Exit 0 means the local aggregate **meets specified shape and thresholds only**.
Exit 1 means a release gate failed; exit 2 means usage or parsing failed.
**Exit 0 alone does not certify a product**: independent reviewers must verify
that the linked results, consent and sign-offs are genuine, complete and
associated with the exact deployed SHA.

## Before enabling any production voice feature flag

A release owner must confirm the latest committed full CI and focused voice
workflow results, documented rollback/feature flags, actual staging smoke test,
measured field p95 and safe-stop behavior, provider privacy and retention,
independent security and accessibility review, and evidence provenance.
A failure or missing artifact is **BLOCKED**, never counted as a pass.
