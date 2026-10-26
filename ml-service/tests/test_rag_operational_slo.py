from scripts.verify_rag_operational_slo import check_answer_contract, summarize


def test_grounded_contract_requires_citations_to_real_active_chunks():
    response = {"grounded": True,
                "retrieved_chunks": [{"chunk": {"chunk_id": "x#0",
                    "lifecycle_state": "ACTIVE",
                    "metadata": {"source": "s", "title": "t"}}}],
                "citations": [{"chunk_id": "x#0", "source": "s", "document_title": "t"}]}
    assert check_answer_contract(response, True)
    response["citations"][0]["chunk_id"] = "fake#0"
    assert not check_answer_contract(response, True)


def test_abstention_never_carries_fake_evidence():
    safe = {"grounded": False, "retrieved_chunks": [], "citations": []}
    assert check_answer_contract(safe, False)
    safe["citations"] = [{"chunk_id": "forged"}]
    assert not check_answer_contract(safe, False)


def test_latency_and_flaky_backend_fail_closed_without_user_data():
    assert summarize([{"ok": True, "elapsed_ms": 5}])["status"] == "PASS"
    failure = summarize([{"ok": True, "elapsed_ms": 5},
                         {"ok": False, "elapsed_ms": 3000, "error_type": "TimeoutError"}],
                        max_p95_ms=1000)
    assert failure["status"] == "FAIL"
    assert failure["failed_count"] == 1
    assert "FAILED_OR_UNGROUNDED_RESPONSES" in failure["failures"]
    assert "P95_SLO_EXCEEDED" in failure["failures"]
