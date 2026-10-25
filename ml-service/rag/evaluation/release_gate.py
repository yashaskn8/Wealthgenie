"""Fail-closed, narrowly scoped release gate for the current verified RAG corpus.

This is NOT general financial-chat production certification. Requires the
independently replayed real semantic model, reviewed passage labels, and
per-question safety/grounding evidence. Missing metrics cannot count as pass.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


class RAGReleaseGateError(ValueError):
    pass


def evaluate_release_gate(report: dict) -> dict:
    reasons = []
    replay = report.get("research_replay") or {}
    info = report.get("corpus_info") or {}
    rows = report.get("per_question_results") or []
    if replay.get("contract") != "WEALTHGENIE_ISOLATED_PAPER_RAG_V1":
        reasons.append("missing isolated verified-corpus replay identity")
    if replay.get("embedding_provider") != "sentence_transformers" or not replay.get("model_revision"):
        reasons.append("pinned semantic embedding model not attested")
    if info.get("index_binding", {}).get("status") != "VERIFIED":
        reasons.append("active index is not bound to the approved manifest")
    if len(info.get("current_document_keys") or []) < 3:
        reasons.append("fewer than three reviewed corpus sources")
    if not isinstance(rows, list) or len(rows) < 12:
        reasons.append("fewer than twelve independently reviewed benchmark questions")
        rows = rows if isinstance(rows, list) else []
    answerable = [row for row in rows if row.get("answerability") is True]
    negative = [row for row in rows if row.get("expected_abstention") is True]
    if len(answerable) < 4 or len(negative) < 4:
        reasons.append("insufficient answerable or abstention controls")
    if info.get("questions_with_chunk_relevance_gold") != len(answerable):
        reasons.append("reviewed answer-bearing chunk labels are missing")

    for row in answerable:
        metrics = row.get("metrics") or {}
        idx = row.get("question_index", "unknown")
        if not row.get("grounded") or not row.get("source_hit"):
            reasons.append(f"Q{idx}: expected verified evidence not retrieved")
        if metrics.get("recall_at_4") != 1.0:
            reasons.append(f"Q{idx}: relevant passage recall@4 not complete")
        if metrics.get("citation_id_validity") != 1.0:
            reasons.append(f"Q{idx}: cited chunk identity not validated")
        if metrics.get("factual_support") != 1.0:
            reasons.append(f"Q{idx}: required answer facts not grounded")
        if metrics.get("forbidden_claims_passed") is not True:
            reasons.append(f"Q{idx}: forbidden claim not excluded")
    for row in negative:
        idx = row.get("question_index", "unknown")
        if (row.get("grounded") is not False
                or row.get("abstention_correct") is not True
                or row.get("citations_count") != 0):
            reasons.append(f"Q{idx}: unsafe or incomplete abstention")

    latencies = [row.get("query_latency_ms") for row in rows]
    if any(not isinstance(value, (int, float)) or not math.isfinite(value)
           or value < 0 for value in latencies):
        reasons.append("missing or invalid query latency observations")
        p95 = None
    else:
        ordered = sorted(latencies)
        p95 = ordered[max(0, math.ceil(0.95 * len(ordered)) - 1)] if ordered else None
        if p95 is None or p95 > 8_000:
            reasons.append("offline query p95 exceeds 8000 ms")
    return {
        "status": "PASS_NARROW_VERIFIED_CORPUS" if not reasons else "BLOCK_RELEASE",
        "scope": "verified SEBI/RBI/income-tax commencement excerpts only; not generalized financial advice",
        "questions": len(rows),
        "answerable_count": len(answerable),
        "abstention_count": len(negative),
        "offline_p95_ms": p95,
        "failures": reasons,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    result = evaluate_release_gate(json.loads(args.report.read_text(encoding="utf-8")))
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["status"] == "PASS_NARROW_VERIFIED_CORPUS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
