# GenieVoice V11 — final defensive attack / regression record

Date: 2026-10-26. This report documents **source-based defensive simulations** and
test-driven mitigations. It does not certify that the platform is invulnerable.

## Baseline

PR #78 passed full CI and GenieVoice checks and was squashed into main at
`082a43d1d93c51ca235c47adbd2005232f945322` before this review.
Prior controls remain: authenticated read-only voice intent, source-grounded
backend replies, transcript amount confirmation, session/visibility epochs,
separate rate-limited financial tools and disabled-by-default flags.

## Final red-team matrix

| Scenario | Threat | Mitigation / evidence |
| --- | --- | --- |
| 25+ browser ASR result segments | Memory/processing flood or dropped terminal amount | Single shared result collector bounds chunks and aggregate text to 24/1,000; regression on malicious arrays |
| Split ASR utterance: salary followed by amount | Legacy UI silently drops latter speech segments | Both microphone entry points preserve all final segments; legacy integration test confirms full text |
| Control/invisible/surrogate in speech (including trailing newline) | Transcript can change meaning if sanitized before policy | Raw per-chunk disallowed-character rejection **before trimming**, direct transcript validation and matching HTTP Joi schema |
| Voice question about salary, insurance premium, rent or expenses with spoken number | Keyword-limited financial topic parser misses material money figures | Wider English/Hindi/Kannada finance vocabulary plus unconditional currency/monetary-unit review |
| Covert delegated remittance, disclosure, or order commands | Unrecognized mutations fall through to hands-free chat | Server voice policy rejects new action families, including indirect actor phrasing; read-only actions only |
| Grounded-looking reply that is marked fallback, has unavailable facts or carries table/image/code markup | Browser TTS can omit structural qualifications or speak an unsupported financial claim | Deny narrator playback even if response text was otherwise verified; preserve reading in chat |
| Valid page name containing action word ("show where to invest") | Overblocking legitimate navigation | Exact allowlisted pages still authorize; no compound action permitted |
| Stale turns, wrong evidence, background sessions | Leakage from earlier audio/financial account | Retains PR #78 epoch, origin turn key, displayed evidence match and audio stop guards |

## Release evidence and scope boundaries

This PR must not be merged until the **latest head commit** passes the full
GitHub CI and dedicated GenieVoice voice suites. Merged-main CI and actual
deployment verification are separate from PR checks. Browser-provider privacy
and consent, audio replay from nearby speakers, voice performance on low-end
Android/iOS devices, accented Hindi/Kannada ASR quality, accessibility and
human adversarial audio testing are still unverified and require consented
real-device testing. No keys, third-party provider, background listener or
autonomous financial transaction capability were introduced.

## Final uncategorized-numeric attack (fail-closed policy)

Keyword-only financial-topic detection cannot classify every spoken salary,
loan, pension or money phrase across India’s languages. In the opt-in hands-free
interface, **any recognized numerical word, digit, financial currency unit,
percentage, fraction or multiplier requires the visible transcript confirmation**
even if a recognizer does not label the question as financial. This is an
intentional small usability cost to prevent a silently misheard material value
from being submitted. Unrecognized numbers and word-error rates still require
consented real-device multilingual benchmarking.
