from rag.evaluation.release_gate import evaluate_release_gate


def fixture():
    rows = []
    for i in range(1, 13):
        answerable = i <= 6
        rows.append({
            "question_index": i, "answerability": answerable,
            "expected_abstention": not answerable,
            "grounded": answerable,
            "source_hit": answerable,
            "abstention_correct": True,
            "citations_count": 1 if answerable else 0,
            "query_latency_ms": 55.0,
            "metrics": {
                "recall_at_4": 1.0 if answerable else None,
                "citation_id_validity": 1.0 if answerable else None,
                "factual_support": 1.0 if answerable else None,
                "forbidden_claims_passed": True,
            },
        })
    return {
        "research_replay": {
            "contract": "WEALTHGENIE_ISOLATED_PAPER_RAG_V1",
            "embedding_provider": "sentence_transformers", "model_revision": "pinned",
        },
        "corpus_info": {
            "index_binding": {"status": "VERIFIED"},
            "current_document_keys": ["tax", "sebi", "rbi"],
            "questions_with_chunk_relevance_gold": 6,
        },
        "per_question_results": rows,
    }


def test_verified_scoped_evidence_passes_not_broad_production():
    outcome = evaluate_release_gate(fixture())
    assert outcome["status"] == "PASS_NARROW_VERIFIED_CORPUS"
    assert "not generalized" in outcome["scope"]


def test_bad_abstention_fails_even_if_all_other_samples_pass():
    case = fixture()
    case["per_question_results"][-1]["grounded"] = True
    assert evaluate_release_gate(case)["status"] == "BLOCK_RELEASE"


def test_missing_passage_recall_or_faithfulness_fails_closed():
    for key in ("recall_at_4", "factual_support", "citation_id_validity"):
        case = fixture()
        case["per_question_results"][0]["metrics"][key] = None
        result = evaluate_release_gate(case)
        assert result["status"] == "BLOCK_RELEASE"
        assert result["failures"]


def test_absent_lineage_labels_and_latency_cannot_pass():
    case = fixture()
    case["corpus_info"]["questions_with_chunk_relevance_gold"] = 0
    case["per_question_results"][0]["query_latency_ms"] = float("nan")
    case["research_replay"]["embedding_provider"] = "tf_idf_dense"
    result = evaluate_release_gate(case)
    assert result["status"] == "BLOCK_RELEASE"
    assert len(result["failures"]) >= 3
