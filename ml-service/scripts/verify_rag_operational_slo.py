"""Bounded, read-only load/safety probe for an explicitly deployed RAG service.

Run only with an intentionally supplied service API key against a trusted
internal endpoint. No document ingestion, financial profiles or writes.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import math
import os
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

APPROVED_QUERY = "When did the Income-tax Rules 2026 take effect?"
CONTROL_QUERY = "What is the exact tax rebate for every individual in 2026?"


def check_answer_contract(data: dict, expect_grounded: bool) -> bool:
    if not isinstance(data, dict) or data.get("grounded") is not expect_grounded:
        return False
    chunks = data.get("retrieved_chunks")
    citations = data.get("citations")
    if not isinstance(chunks, list) or not isinstance(citations, list):
        return False
    if not expect_grounded:
        return not chunks and not citations
    if not chunks or len(chunks) != len(citations):
        return False
    indexed = {}
    for item in chunks:
        chunk = item.get("chunk", {}) if isinstance(item, dict) else {}
        cid = chunk.get("chunk_id")
        if not cid or cid in indexed or chunk.get("lifecycle_state") != "ACTIVE":
            return False
        indexed[cid] = chunk
    return all(
        c.get("chunk_id") in indexed
        and c.get("source") == indexed[c["chunk_id"]].get("metadata", {}).get("source")
        and c.get("document_title") == indexed[c["chunk_id"]].get("metadata", {}).get("title")
        for c in citations
    )


def make_request(url: str, api_key: str, user_id: str, question: str, timeout: float) -> dict:
    payload = json.dumps({"question": question, "top_k": 2, "jurisdiction": "IN"}).encode()
    req = Request(
        url + "/rag/query", data=payload, method="POST",
        headers={
            "Content-Type": "application/json",
            "X-API-Key": api_key,
            "X-Verified-User-Id": user_id,
        },
    )
    with urlopen(req, timeout=timeout) as response:
        if response.status != 200:
            raise RuntimeError(f"query HTTP {response.status}")
        return json.loads(response.read(128_000).decode("utf-8"))


def sample_outcome(url: str, api_key: str, user_id: str, question: str, timeout: float) -> dict:
    started = time.monotonic()
    try:
        response = make_request(url, api_key, user_id, question, timeout)
        ok = check_answer_contract(response, expect_grounded=question == APPROVED_QUERY)
        return {"ok": ok, "elapsed_ms": round((time.monotonic() - started) * 1000, 2),
                "error_type": None if ok else "CONTRACT_FAILURE"}
    except (HTTPError, URLError, TimeoutError, OSError, ValueError, RuntimeError) as exc:
        # Never log the query, URL headers, user identity or response bodies.
        return {"ok": False, "elapsed_ms": round((time.monotonic() - started) * 1000, 2),
                "error_type": type(exc).__name__}


def summarize(samples: list[dict], max_p95_ms: float = 8_000) -> dict:
    if not samples:
        return {"status": "FAIL", "count": 0, "failures": ["NO_SAMPLES"]}
    times = [r.get("elapsed_ms") for r in samples]
    if any(not isinstance(t, (int, float)) or not math.isfinite(t) or t < 0 for t in times):
        return {"status": "FAIL", "count": len(samples), "failures": ["INVALID_LATENCY"]}
    ordered = sorted(times)
    p95 = ordered[max(0, math.ceil(len(ordered) * 0.95) - 1)]
    bad = sum(not x.get("ok") for x in samples)
    reasons = []
    if bad:
        reasons.append("FAILED_OR_UNGROUNDED_RESPONSES")
    if p95 > max_p95_ms:
        reasons.append("P95_SLO_EXCEEDED")
    return {"status": "PASS" if not reasons else "FAIL", "count": len(samples),
            "failures": reasons, "failed_count": bad, "p95_ms": p95,
            "max_allowed_p95_ms": max_p95_ms}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--samples", type=int, default=12)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--timeout-seconds", type=float, default=8)
    parser.add_argument("--allow-remote", action="store_true")
    args = parser.parse_args()
    parsed = urlsplit(args.base_url)
    local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        parser.error("invalid trusted service URL")
    if not local and (not args.allow_remote or parsed.scheme != "https"):
        parser.error("remote probes require --allow-remote and HTTPS")
    if not (2 <= args.samples <= 32 and 1 <= args.concurrency <= 8 and 0 < args.timeout_seconds <= 20):
        parser.error("samples, concurrency or timeout outside safe probe bounds")
    api_key = os.getenv("ML_SERVICE_API_KEY", "")
    user_id = os.getenv("RAG_SMOKE_USER_ID", "rag-smoke-test-principal")
    if not api_key:
        parser.error("ML_SERVICE_API_KEY is required")
    origin = args.base_url.rstrip("/")
    readiness = Request(origin + "/rag/readyz", headers={"X-API-Key": api_key})
    try:
        with urlopen(readiness, timeout=args.timeout_seconds) as res:
            payload = json.loads(res.read(32_000).decode("utf-8"))
            if res.status != 200 or payload.get("status") != "READY":
                raise RuntimeError("RAG not READY")
    except (HTTPError, URLError, OSError, ValueError, RuntimeError) as exc:
        print(json.dumps({"status": "FAIL", "reason": "READINESS_FAILED", "error_type": type(exc).__name__}))
        return 2
    questions = [APPROVED_QUERY if i % 2 == 0 else CONTROL_QUERY for i in range(args.samples)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = [pool.submit(sample_outcome, origin, api_key, user_id, question, args.timeout_seconds)
                   for question in questions]
        observations = [future.result() for future in futures]
    result = summarize(observations)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
