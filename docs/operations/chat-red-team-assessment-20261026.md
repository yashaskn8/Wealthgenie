# GenieChat red-team security assessment — October 2026

## Scope
All payloads use synthetic inputs, mock profiles and repository unit tests. No live customer data or secrets were accessed. This is an application-level defensive red-team exercise, not a certified external penetration test.

Guidance:
- https://genai.owasp.org/llm-top-10/
- https://owasp.github.io/DevSecOpsGuideline/2-Process/2-4-Test/2-4-6-AI-LLM-Application-Security-Testing/
- https://cheatsheetseries.owasp.org/cheatsheets/RAG_Security_Cheat_Sheet.html

## Confirmed risks and patches

1. Public and signed-in chatbot paths did not consistently screen instruction attacks. A single bounded, shared detector checks original text, Unicode and common encoded wrappers before retrieval or model access.
2. Some deterministic goal/scenario branches executed before injection handling. The first grounded response branch now returns a fixed backend-owned security answer without account data, model calls, or tool activity.
3. Previously saved injected user/model turns could be forwarded as history. Such turns are now excluded; persisted trusted history ends at a poisoned pair.
4. Python retrieved-context filtering did not normalize HTML entities, percent escapes, extended role tokens and bidi controls. These are now inspected before a passage can reach the answer.
5. The Node regulatory bridge allowed ownership disagreement between chunk and metadata. It now requires matching public scope and tenant in both layers.
6. Ellipsis-only citations could pass as an empty-string prefix. They now require substantive literal support.
7. Tests exercise innocent security-education questions and ordinary financial questions to limit false positives.

## Test corpus
Direct system/developer spoofing, Markdown/JSON/XML role markers, Unicode width and zero-width obfuscation, HTML and URL encoding, base64, fake administrative tool commands, requests for mock account data, financial goal contamination, misleading citation excerpts, contradictory tenant metadata, long malformed input and benign controls.

These are deterministic unit/integration probes. Unknown paraphrases, new providers and multi-turn stochastic model bypasses still need repeatable human-reviewed staging tests; lexical filters alone are never sufficient. The primary defenses remain permission boundaries, verified sources, profile-state binding, output validation, and a strict no-tool model policy.

## Reproduction commands

    cd server
    node --test test/chatAdversarialBoundary.test.js test/chatRegulatoryRetrieval.test.js test/geminiChatService.test.js

    cd ../ml-service
    python -m pytest -q tests/test_rag_retrieval_guard.py tests/test_rag_multi_tenant.py

## Release blockers
- Full CI must pass on final head.
- Dependency advisories in issue #69 must be remediated with verified lockfile hashes and an audit rerun.
- Authenticated staging needs repeated tests for prompt/tool/model changes, tenant isolation, and protected data flow.
- Red-team regression tests and static heuristics do not constitute certification of overall financial advice readiness.
