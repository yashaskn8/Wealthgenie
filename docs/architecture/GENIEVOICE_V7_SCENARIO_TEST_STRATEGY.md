# GenieVoice V7 — Open-Ended Scenario Test Strategy

This suite is a **repeatable adversarial/quantitative regression harness**, not proof that every imaginable human question is supported. Endlessly many utterances require a **bounded reasoning policy**: determine whether the app has qualified evidence and a supported calculation; ask for missing facts; otherwise abstain and offer a safe tool.

## Included in this PR

- 240 pseudorandom but deterministic valid scenarios across monthly contributions, horizons, growth assumptions and inflation levels; assertions cover conservation of contributions, finite results, purchasing power, evidence classification, and non-personalized explanation.
- Metamorphic checks: doubling SIP contributions doubles nominal results (within rounding); increasing inflation reduces present-day buying power, without modifying the nominal forecast; a modeled market loss cannot boost calculated results.
- Cross-product market shocks at five severity levels and three possible years.
- Malformed and conflicting assumptions, unknown rates, unsupported time periods, invisible Unicode/control characters, negative/oversized rates and missing market-event timing.
- Hindi/Kannada finance questions remain in the evidence-grounded channel, and adversarial spoken requests cannot acquire navigation or financial transaction authority.
- Multi-feature requests must abstain from choosing a single destination.
- CI automatically runs the full scenario suite for the V7 feature branch.

## Scenario families to expand next

1. Life changes: income interruption, rising expenses, a dependent, late retirement, a changed goal date.
2. Market regimes: repeated crashes, a poor early return sequence, low returns, inflation shocks, liquidity freezes, no credible market quote.
3. Savings behavior: missed SIPs, irregular contributions, step-up and step-down, insufficient cash flow.
4. Cross-goal constraints: college + house + emergency fund + retirement conflicts.
5. Investment evidence: stale NAV, conflicting official sources, unsupported tax treatment, unknown instrument, price vs return confusion.
6. Linguistic complexity: pronouns, omitted units, corrections and "what about now" follow-ups, Hinglish/Kanglish, noisy ASR and mixed-digit words.
7. Security: injection in transcripts, bogus citations, authorization expiry, account switch mid-reply, repeated callbacks, cancelled/late providers, cross-account session mixups.
8. Accessibility/reliability: permission revocation, tab backgrounding, unavailable Hindi/Kannada voices, low bandwidth and slow requests.

## Release quality bar

For each new intent/category, add (a) an example of correct answer with evidence, (b) at least one missing-data abstention, (c) an adversarial ambiguous/unsafe prompt, (d) a cross-language example, and (e) independent numerical reference if a quantity is emitted.

The generator is intentionally seeded so failures reproduce. It does **not** discover new semantics by itself, train a language model, validate translation quality, perform live browser penetration testing or certify Indian investment advice compliance. No transaction execution is added.

### Running locally

From `server`:

```bash
node --test test/voiceScenarioFuzz.test.js
```

The entire `.github/workflows/genievoice-quality.yml` also runs this suite.
