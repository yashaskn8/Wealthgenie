# GenieChat RAG production gate — 2026-10-25

## Scope and source provenance

The trust-rooted corpus contains precisely three curated **short factual summaries**: the Income-tax Rules 2026 commencement; the SEBI (Mutual Funds) Regulations 2026 commencement (official consolidated text amended through 10 October 2026); and the RBI Integrated Ombudsman Scheme 2026 commencement. The source URLs, publisher, version, effective date, publication date and content hash are pinned in `ml-service/rag/data/corpus/manifest.json`. No downloaded website, user-uploaded document, or LLM output becomes authoritative merely because it resembles an official source. New sources require human review of dates, scope, legality, content and copyright before changing the manifest.

These documents do **not** authorize portfolio allocation, current NAVs, product tax treatment, payment refunds, guaranteed returns or personalized legal advice. GenieChat's Node bridge applies an additional per-topic allowlist; FastAPI uses globally pinned source identity and explicit abstention.

## Research-backed controls

- OWASP RAG Security Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/RAG_Security_Cheat_Sheet.html
- OWASP 2025 LLM risks: https://genai.owasp.org/llm-top-10/
- Microsoft guidance on independent retrieval, grounding and completeness evaluation: https://learn.microsoft.com/en-in/azure/ai-foundry/concepts/evaluation-evaluators/rag-evaluators

## Release criteria

CI runs the full Python suite, pinned semantic-model tests, an isolated current-corpus replay, checksums and the strict `rag.evaluation.release_gate` on that actual replay. It requires all expected abstentions, manifest-bound evidence, complete labeled recall@4, citation identity, required factual support and an observed offline p95 of no more than 8 seconds. Missing metrics block release, rather than being cast as zero or passed. Reviewed source passages are chosen **before** retrieval and converted to portable chunk IDs only if they occur in the approved indexed text. A document-wide hit is not a substitute for chunk recall.

Run from `ml-service` after dependencies and the exact pinned model are ready:

```bash
python -m pytest -q tests/test_rag_retrieval_guard.py tests/test_rag_release_gate.py tests/test_rag_corpus_manifest.py
python -m rag.evaluation.paper_replay --output reports/paper_rag_current.json
python -m rag.evaluation.release_gate --report reports/paper_rag_current.json
```

## Operational acceptance

1. Apply migrations and the explicit shared Mongo RAG corpus bootstrap; verify `/rag/readyz` reports `READY` and matches manifest and embedding identities. A green `/health` alone does not establish readiness.
2. Exercise current supported and unsupported questions with authenticated requests, adverse text, concurrent queries and bounded latency. Verify 429, 503, timeout, stale generation and downstream outage behavior without inventing answers; inspect aggregate metrics without logging raw user queries.
3. Validate no tenant-scoped records or untrusted sources appear in the chat evidence packet. Test cache invalidation after a corpus generation change, a normal restart and a replica switch.
4. Check GitHub security dependency audits separately. Vulnerable runtime dependencies are deployment blockers even if RAG correctness passes. Do not suppress findings or merge solely because this narrowly scoped RAG gate is green.

This gate certifies only a **small allowlisted question surface**, not readiness as a general financial RAG advisor. The benchmark's sample size, source rights and production traffic SLOs must be expanded before a general release.

## Bounded operational probe

The read-only probe runs at most 32 authenticated queries and eight concurrent workers, half on the supported question and half on an unsupported tax detail. It verifies `/rag/readyz`, grounded/citation consistency, negative abstention and observed p95. The request identity is a designated test principal, never a real investor profile. It does not simulate a restart or assert real production SLOs without connecting to the deployed service.

```bash
cd ml-service
ML_SERVICE_API_KEY=... RAG_SMOKE_USER_ID=designated-test-user \
  python -m scripts.verify_rag_operational_slo \
  --base-url http://127.0.0.1:8000 --samples 12 --concurrency 4
```

For remote staging, use explicit `--allow-remote` with HTTPS, allowlisted internal access and permitted credentials. A mocked unit test or a local run is not evidence of a successfully tested production deployment.
