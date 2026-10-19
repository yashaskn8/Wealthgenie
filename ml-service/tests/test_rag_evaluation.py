"""
WealthGenie RAG Subsystem - Evaluation Framework Test Suite
Tests RAG metrics calculations (Recall, Precision, MRR, NDCG, Diversity, Grounding) and RAGEvaluator report persistence.
"""

import pytest
from datetime import date

from rag.evaluation.metrics import (
    compute_recall_at_k,
    compute_precision_at_k,
    compute_mrr,
    compute_hit_rate,
    compute_ndcg,
    compute_context_coverage,
    compute_chunk_diversity,
    compute_citation_accuracy,
    compute_grounding_score,
    summarize_metric_values,
    format_metric_value,
)
from rag.evaluation.evaluator import RAGEvaluator
from rag.schema import (
    RAGQueryResponse,
    RAG_ABSTENTION_MESSAGE,
    RetrievedChunk,
    TextChunk,
    ChunkMetadata,
    Citation,
)


def test_retrieval_ranking_metrics():
    retrieved_ids = ["c1", "c2", "c3", "c4"]
    ground_truth = {"c2", "c5"}

    # Recall@4: 1 of 2 ground truth items retrieved = 0.5
    recall = compute_recall_at_k(retrieved_ids, ground_truth, k=4)
    assert recall == 0.5

    # Precision@2: 1 of top 2 items is relevant = 0.5
    precision = compute_precision_at_k(retrieved_ids, ground_truth, k=2)
    assert precision == 0.5

    # MRR: First relevant item is at rank 2 -> 1/2 = 0.5
    mrr = compute_mrr(retrieved_ids, ground_truth)
    assert mrr == 0.5

    # Hit Rate@2: c2 is in top 2 -> 1.0
    hit_rate = compute_hit_rate(retrieved_ids, ground_truth, k=2)
    assert hit_rate == 1.0

    # NDCG@4: > 0.0
    ndcg = compute_ndcg(retrieved_ids, ground_truth, k=4)
    assert ndcg > 0.0


def test_empty_expected_list_never_awards_perfect_retrieval_scores():
    assert compute_recall_at_k(["c1"], set(), k=1) == 0.0
    assert compute_mrr(["c1"], set()) == 0.0
    assert compute_hit_rate(["c1"], set(), k=1) == 0.0
    assert compute_ndcg(["c1"], set(), k=1) == 0.0


def test_context_coverage_and_diversity():
    query = "What is Section 87A tax rebate for FY 2025-26?"
    retrieved_texts = [
        "Under Section 87A rebate for FY 2025-26, income up to 12 Lakhs incurs zero tax."
    ]
    coverage = compute_context_coverage(query, retrieved_texts)
    assert coverage > 0.4

    embeddings = [
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
    ]
    diversity = compute_chunk_diversity(embeddings)
    assert pytest.approx(diversity, 0.01) == 1.0


def test_citation_accuracy_and_grounding_score():
    meta = ChunkMetadata(
        chunk_id="doc1#0000",
        document_id="doc1",
        chunk_index=0,
        title="Tax Guide",
        source="tax_doc.md",
    )
    chunk = TextChunk(
        chunk_id="doc1#0000",
        document_id="doc1",
        content="Section 87A rebate gives zero tax for income under 12 Lakhs.",
        metadata=meta,
    )
    ret_chunk = RetrievedChunk(chunk=chunk, score=0.9, rank=1)

    citations = [
        Citation(
            citation_id=1,
            document_title="Tax Guide",
            source="tax_doc.md",
            chunk_id="doc1#0000",
            excerpt="Section 87A rebate gives zero tax",
            relevance_score=0.9,
        )
    ]

    accuracy = compute_citation_accuracy(citations, [ret_chunk])
    assert accuracy == 1.0

    answer = "Section 87A rebate gives zero tax for income under 12 Lakhs."
    grounding = compute_grounding_score(answer, [chunk.content])
    assert grounding == 1.0


def test_rag_evaluator_persistence(tmp_path):
    evaluator = RAGEvaluator(evals_dir=tmp_path)

    meta = ChunkMetadata(
        chunk_id="doc1#0000",
        document_id="doc1",
        chunk_index=0,
        title="Tax Guide",
        source="tax_doc.md",
    )
    chunk = TextChunk(
        chunk_id="doc1#0000",
        document_id="doc1",
        content="Section 87A rebate provides tax relief.",
        metadata=meta,
    )
    ret_chunk = RetrievedChunk(chunk=chunk, score=0.85, rank=1)

    response = RAGQueryResponse(
        answer="Section 87A rebate provides tax relief.",
        citations=[],
        retrieved_chunks=[ret_chunk],
        metrics={"total_latency_ms": 12.4},
        grounded=True,
    )

    eval_file = evaluator.evaluate_and_persist(
        query="PRIVATE_QUERY_SENTINEL What is Section 87A?",
        response=response,
        ground_truth_chunk_ids={"doc1#0000"},
        k=2,
    )

    assert eval_file.exists()
    reports = evaluator.list_evaluation_reports()
    assert len(reports) == 1
    assert "query" not in reports[0]
    assert "PRIVATE_QUERY_SENTINEL" not in eval_file.read_text(encoding="utf-8")


def test_evaluator_distinguishes_abstention_from_retrieval_metrics(tmp_path):
    evaluator = RAGEvaluator(evals_dir=tmp_path)
    response = RAGQueryResponse(
        answer=RAG_ABSTENTION_MESSAGE,
        citations=[],
        retrieved_chunks=[],
        metrics={"response_mode": "abstention"},
        grounded=False,
    )
    result = evaluator.evaluate_query_response(
        query="Who won a football match?",
        response=response,
        ground_truth_chunk_ids=set(),
    )
    assert result["metrics"]["abstention_correctness"] is True
    assert result["metrics"]["answerability_correctness"] is True
    assert result["metrics"]["citation_id_validity"] is None
    assert result["metrics"]["factual_support"] is None


def test_expected_abstention_does_not_accept_unverified_financial_claims():
    evaluator = RAGEvaluator()
    response = RAGQueryResponse(
        answer="You can claim a deduction of ₹1,50,000.",
        citations=[],
        retrieved_chunks=[],
        metrics={"response_mode": "abstention"},
        grounded=False,
    )

    result = evaluator.evaluate_query_response(
        query="Can I claim this deduction?",
        response=response,
        expected_abstention=True,
        forbidden_claims=["unsupported deduction"],
    )

    assert result["metrics"]["forbidden_claims_passed"] is False
    assert result["metrics"]["abstention_correctness"] is False
    assert result["metrics"]["answerability_correctness"] is False


def test_rag_evaluator_rejects_valid_citation_that_does_not_support_required_fact():
    content = "The commencement notice says the rule takes effect in 2025."
    metadata = ChunkMetadata(
        chunk_id="commencement#0", document_id="commencement", chunk_index=0,
        title="Commencement", source="official-notice",
    )
    retrieved = RetrievedChunk(chunk=TextChunk(
        chunk_id="commencement#0", document_id="commencement", content=content, metadata=metadata,
    ), score=0.95, rank=1)
    response = RAGQueryResponse(
        answer="The rule takes effect in 2026.",
        citations=[Citation(
            citation_id=1, document_title="Commencement", source="official-notice",
            chunk_id="commencement#0", excerpt=content, relevance_score=0.95,
        )],
        retrieved_chunks=[retrieved], grounded=True,
    )

    result = RAGEvaluator().evaluate_query_response(
        query="When does the rule take effect?", response=response,
        expected_abstention=False,
        required_facts=["The rule takes effect in 2026."],
    )
    assert result["metrics"]["citation_id_validity"] == 1.0
    assert result["metrics"]["factual_support"] == 0.0
    assert result["metrics"]["answerability_correctness"] is True


def test_negated_citation_and_source_do_not_support_a_positive_required_fact():
    content = "The official notice says the deduction is not allowed."
    metadata = ChunkMetadata(
        chunk_id="deduction#0", document_id="deduction", chunk_index=0,
        title="Official notice", source="official-notice",
    )
    retrieved = RetrievedChunk(chunk=TextChunk(
        chunk_id="deduction#0", document_id="deduction", content=content, metadata=metadata,
    ), score=0.95, rank=1)
    response = RAGQueryResponse(
        answer="The deduction is allowed [1].",
        citations=[Citation(
            citation_id=1, document_title="Official notice", source="official-notice",
            chunk_id="deduction#0", excerpt=content, relevance_score=0.95,
        )],
        retrieved_chunks=[retrieved],
        grounded=True,
    )

    result = RAGEvaluator().evaluate_query_response(
        query="Is the deduction allowed?",
        response=response,
        expected_abstention=False,
        required_facts=["allowed"],
    )

    assert result["metrics"]["citation_id_validity"] == 1.0
    assert result["metrics"]["factual_support"] == 0.0


def test_rag_evaluator_scores_supported_required_facts_forbidden_claims_and_answerable_abstention():
    content = "The rule takes effect on 1 April 2026."
    metadata = ChunkMetadata(
        chunk_id="commencement#0", document_id="commencement", chunk_index=0,
        title="Commencement", source="official-notice",
    )
    retrieved = RetrievedChunk(chunk=TextChunk(
        chunk_id="commencement#0", document_id="commencement", content=content, metadata=metadata,
    ), score=0.95, rank=1)
    response = RAGQueryResponse(
        answer=f"{content} [1]",
        citations=[Citation(
            citation_id=1, document_title="Commencement", source="official-notice",
            chunk_id="commencement#0", excerpt=content, relevance_score=0.95,
        )],
        retrieved_chunks=[retrieved], grounded=True,
    )
    result = RAGEvaluator().evaluate_query_response(
        query="When does the rule take effect?", response=response,
        expected_abstention=False,
        required_facts=[content],
        forbidden_claims=["The rule takes effect in 2025."],
    )
    assert result["metrics"]["factual_support"] == 1.0
    assert result["metrics"]["forbidden_claims_passed"] is True
    assert result["metrics"]["forbidden_claim_violation_count"] == 0
    assert result["metrics"]["answerability_correctness"] is True

    walk_backs = (
        ", but that date is false and the rule does not take effect then.",
        ". However, I retract that statement.",
        ". That claim is unsupported.",
        ". This date is disputed.",
        ". That date was incorrectly stated.",
    )
    denial_prefixes = (
        "It is not true that ",
        "It is false that ",
        "I do not agree that ",
        "I deny that ",
        "I dispute that ",
    )
    for answer in [f"{content}{walk_back} [1]" for walk_back in walk_backs] + [
        f"{prefix}{content} [1]" for prefix in denial_prefixes
    ]:
        contradicted_answer = RAGQueryResponse(
            answer=answer,
            citations=response.citations,
            retrieved_chunks=response.retrieved_chunks,
            grounded=True,
        )
        contradicted_result = RAGEvaluator().evaluate_query_response(
            query="When does the rule take effect?",
            response=contradicted_answer,
            expected_abstention=False,
            required_facts=[content],
        )
        assert contradicted_result["metrics"]["factual_support"] == 0.0

    false_abstention = RAGEvaluator().evaluate_query_response(
        query="When does the rule take effect?",
        response=RAGQueryResponse(answer="I cannot verify that.", grounded=False),
        expected_abstention=False,
        required_facts=[content],
    )
    assert false_abstention["metrics"]["abstention_correctness"] is False
    assert false_abstention["metrics"]["answerability_correctness"] is False


def test_required_fact_support_is_bound_to_the_inline_citation_reference():
    supported_content = "The rule takes effect on 1 April 2026."
    unrelated_content = "The notice was published by the Official Authority."
    unrelated_metadata = ChunkMetadata(
        chunk_id="publication#0", document_id="publication", chunk_index=0,
        title="Publication Notice", source="official-publication",
    )
    supported_metadata = ChunkMetadata(
        chunk_id="commencement#0", document_id="commencement", chunk_index=0,
        title="Commencement", source="official-commencement",
    )
    retrieved = [
        RetrievedChunk(chunk=TextChunk(
            chunk_id="publication#0", document_id="publication", content=unrelated_content,
            metadata=unrelated_metadata,
        ), score=0.9, rank=1),
        RetrievedChunk(chunk=TextChunk(
            chunk_id="commencement#0", document_id="commencement", content=supported_content,
            metadata=supported_metadata,
        ), score=0.85, rank=2),
    ]
    response = RAGQueryResponse(
        answer=f"{supported_content} [1]",
        citations=[
            Citation(
                citation_id=1, document_title="Publication Notice", source="official-publication",
                chunk_id="publication#0", excerpt=unrelated_content, relevance_score=0.9,
            ),
            Citation(
                citation_id=2, document_title="Commencement", source="official-commencement",
                chunk_id="commencement#0", excerpt=supported_content, relevance_score=0.85,
            ),
        ],
        retrieved_chunks=retrieved,
        grounded=True,
    )

    result = RAGEvaluator().evaluate_query_response(
        query="When does the rule take effect?", response=response,
        required_facts=[supported_content],
    )

    assert result["metrics"]["citation_reference_validity"] == 1.0
    assert result["metrics"]["citation_identity_correctness"] == 1.0
    assert result["metrics"]["factual_support"] == 0.0


def test_rag_evaluator_binds_source_identity_trust_freshness_period_and_jurisdiction():
    manifest_sha = "a" * 64
    content_sha = "b" * 64
    source = "https://authority.example/rules.pdf"
    content = "The rule takes effect on 1 April 2026."
    metadata = ChunkMetadata(
        chunk_id="commencement#0", document_id="commencement", chunk_index=0,
        title="Commencement", source=source, author="Official Authority",
        publication_date="2026-03-20", effective_date="2026-04-01",
        source_trust_tier="government_official",
        custom_metadata={
            "document_key": "commencement", "content_sha256": content_sha,
            "effective_to": None, "document_revision": "2026-03-20",
            "corpus_manifest_sha256": manifest_sha,
        },
    )
    retrieved = RetrievedChunk(chunk=TextChunk(
        chunk_id="commencement#0", document_id="commencement", content=content,
        metadata=metadata, lifecycle_state="ACTIVE",
    ), score=0.95, rank=1)
    response = RAGQueryResponse(
        answer=content,
        citations=[Citation(
            citation_id=1, document_title="Commencement", source=source,
            chunk_id="commencement#0", excerpt=content, relevance_score=0.95,
        )],
        retrieved_chunks=[retrieved], grounded=True,
    )
    expected = {
        "commencement": {
            "official_source_url": source, "publishing_authority": "Official Authority",
            "publication_date": "2026-03-20", "effective_from": "2026-04-01",
            "effective_to": None, "content_sha256": content_sha,
            "document_version": "2026-03-20", "trust_tier": "government_official",
            "jurisdiction": "IN", "_manifest_sha256": manifest_sha,
        }
    }
    result = RAGEvaluator().evaluate_query_response(
        query="When does the rule take effect?", response=response,
        expected_abstention=False, expected_provenance=expected,
        expected_manifest_sha256=manifest_sha, expected_jurisdiction="IN",
        as_of_date=date(2026, 10, 7),
    )
    for metric in ("source_trust", "source_identity", "manifest_binding_current", "effective_period", "jurisdiction"):
        assert result["metrics"][metric] == 1.0
    assert result["metrics"]["source_freshness"] is None

    wrong_jurisdiction = RAGEvaluator().evaluate_query_response(
        query="When does the rule take effect?", response=response,
        expected_abstention=False, expected_provenance=expected,
        expected_manifest_sha256=manifest_sha, expected_jurisdiction="US",
        as_of_date=date(2026, 10, 7),
    )
    assert wrong_jurisdiction["metrics"]["jurisdiction"] == 0.0



def test_benchmark_metric_aggregation_keeps_unverified_values_unavailable():
    mixed = summarize_metric_values([1.0, None, float("nan"), True])
    assert mixed == {
        "mean": 1.0,
        "min": 1.0,
        "max": 1.0,
        "valid_count": 2,
        "nan_count": 1,
        "unavailable_count": 1,
        "invalid_count": 0,
    }

    unavailable = summarize_metric_values([None, None])
    assert unavailable["mean"] is None
    assert unavailable["min"] is None
    assert unavailable["max"] is None
    assert unavailable["valid_count"] == 0
    assert unavailable["unavailable_count"] == 2



def test_forbidden_claim_categories_catch_assertions_but_allow_explicit_abstentions():
    deduction = RAGEvaluator().evaluate_query_response(
        query="Is a deduction available?",
        response=RAGQueryResponse(answer="You can claim a deduction of ₹1,50,000.", grounded=False),
        forbidden_claims=["unsupported deduction"],
    )
    assert deduction["metrics"]["forbidden_claims_passed"] is False
    assert deduction["metrics"]["forbidden_claim_violation_count"] == 1

    acquisition = RAGEvaluator().evaluate_query_response(
        query="Is this exempt for everyone?",
        response=RAGQueryResponse(
            answer="You are exempt if you acquired the bond before 1 April 2018.", grounded=False,
        ),
        forbidden_claims=["unsupported acquisition-condition claim"],
    )
    assert acquisition["metrics"]["forbidden_claims_passed"] is False

    abstention = RAGEvaluator().evaluate_query_response(
        query="Is a deduction available?",
        response=RAGQueryResponse(answer="I cannot verify whether a deduction is allowed.", grounded=False),
        forbidden_claims=["unsupported deduction"],
    )
    assert abstention["metrics"]["forbidden_claims_passed"] is True

    no_doubt = RAGEvaluator().evaluate_query_response(
        query="Is a deduction available?",
        response=RAGQueryResponse(
            answer="There is no doubt that you can claim a deduction of ₹1,50,000.", grounded=False,
        ),
        forbidden_claims=["unsupported deduction"],
    )
    assert no_doubt["metrics"]["forbidden_claims_passed"] is False


def test_numeric_tax_ranges_rebate_thresholds_and_bought_conditions_are_detected():
    numeric_slab = RAGEvaluator().evaluate_query_response(
        query="What tax slabs apply?",
        response=RAGQueryResponse(
            answer="0–4 lakh: 0%; 4–8 lakh: 5%; 8–12 lakh: 10%.", grounded=False,
        ),
        forbidden_claims=["any numeric slab"],
    )
    assert numeric_slab["metrics"]["forbidden_claims_passed"] is False

    prose_numeric_slab = RAGEvaluator().evaluate_query_response(
        query="What tax slabs apply?",
        response=RAGQueryResponse(
            answer="Income from 4 lakh to 8 lakh is taxed at 5%.", grounded=False,
        ),
        forbidden_claims=["any numeric slab"],
    )
    assert prose_numeric_slab["metrics"]["forbidden_claims_passed"] is False

    range_after_rate = RAGEvaluator().evaluate_query_response(
        query="What tax slabs apply?",
        response=RAGQueryResponse(
            answer="The tax rate is 5% between 4 lakh and 8 lakh.", grounded=False,
        ),
        forbidden_claims=["any numeric slab"],
    )
    assert range_after_rate["metrics"]["forbidden_claims_passed"] is False

    rebate_threshold = RAGEvaluator().evaluate_query_response(
        query="Is income below the rebate threshold tax free?",
        response=RAGQueryResponse(answer="Income up to ₹12 lakh is tax-free.", grounded=False),
        forbidden_claims=["any rebate threshold"],
    )
    assert rebate_threshold["metrics"]["forbidden_claims_passed"] is False

    for answer in (
        "No tax applies on income up to 12 lakh.",
        "Income below 12 lakh is not taxable.",
        "Up to 12 lakh income carries nil tax.",
    ):
        outcome_first_rebate_threshold = RAGEvaluator().evaluate_query_response(
            query="What tax applies?",
            response=RAGQueryResponse(answer=answer, grounded=False),
            forbidden_claims=["any rebate threshold"],
        )
        assert outcome_first_rebate_threshold["metrics"]["forbidden_claims_passed"] is False

    bought_condition = RAGEvaluator().evaluate_query_response(
        query="Does the acquisition date matter?",
        response=RAGQueryResponse(
            answer="You are exempt if you bought the bond before 1 April 2018.", grounded=False,
        ),
        forbidden_claims=["unsupported acquisition-condition claim"],
    )
    assert bought_condition["metrics"]["forbidden_claims_passed"] is False

    acquisition_noun = RAGEvaluator().evaluate_query_response(
        query="Does acquisition date matter?",
        response=RAGQueryResponse(
            answer="An acquisition before 1 April 2026 remains eligible.", grounded=False,
        ),
        forbidden_claims=["unsupported acquisition-condition claim"],
    )
    assert acquisition_noun["metrics"]["forbidden_claims_passed"] is False


def test_fabricated_citation_fails_identity_and_forbidden_citation_checks():
    content = "The rule takes effect on 1 April 2026."
    metadata = ChunkMetadata(
        chunk_id="commencement#0", document_id="commencement", chunk_index=0,
        title="Commencement", source="official-notice",
    )
    retrieved = RetrievedChunk(chunk=TextChunk(
        chunk_id="commencement#0", document_id="commencement", content=content, metadata=metadata,
    ), score=0.95, rank=1)
    response = RAGQueryResponse(
        answer="The rule takes effect on 1 April 2026.",
        citations=[Citation(
            citation_id=1, document_title="Fabricated title", source="https://fake.example/source",
            chunk_id="commencement#0", excerpt="the rule says something else", relevance_score=0.95,
        )],
        retrieved_chunks=[retrieved], grounded=True,
    )

    result = RAGEvaluator().evaluate_query_response(
        query="When does the rule take effect?", response=response,
        forbidden_claims=["fabricated citation"],
    )
    assert result["metrics"]["citation_id_validity"] == 1.0
    assert result["metrics"]["citation_identity_correctness"] == 0.0
    assert result["metrics"]["forbidden_claims_passed"] is False

    malformed_number = RAGQueryResponse(
        answer="The rule takes effect on 1 April 2026.",
        citations=[Citation(
            citation_id=999, document_title="Commencement", source="official-notice",
            chunk_id="commencement#0", excerpt=content, relevance_score=0.95,
        )],
        retrieved_chunks=[retrieved], grounded=True,
    )
    malformed_result = RAGEvaluator().evaluate_query_response(
        query="When does the rule take effect?", response=malformed_number,
        forbidden_claims=["fabricated citation"],
    )
    assert malformed_result["metrics"]["citation_id_validity"] == 0.0
    assert malformed_result["metrics"]["citation_identity_correctness"] == 0.0
    assert malformed_result["metrics"]["forbidden_claims_passed"] is False

    unmapped_reference = RAGQueryResponse(
        answer="The rule takes effect on 1 April 2026 [99].\n\n- **[1]** Commencement (official-notice)",
        citations=[Citation(
            citation_id=1, document_title="Commencement", source="official-notice",
            chunk_id="commencement#0", excerpt=content, relevance_score=0.95,
        )],
        retrieved_chunks=[retrieved], grounded=True,
    )
    unmapped_result = RAGEvaluator().evaluate_query_response(
        query="When does the rule take effect?", response=unmapped_reference,
        forbidden_claims=["fabricated citation"],
    )
    assert unmapped_result["metrics"]["citation_id_validity"] == 1.0
    assert unmapped_result["metrics"]["citation_reference_validity"] == 0.0
    assert unmapped_result["metrics"]["forbidden_claims_passed"] is False

    reference_without_citation = RAGEvaluator().evaluate_query_response(
        query="When does the rule take effect?",
        response=RAGQueryResponse(answer="The rule takes effect [99].", grounded=False),
        forbidden_claims=["fabricated citation"],
    )
    assert reference_without_citation["metrics"]["citation_reference_validity"] == 0.0
    assert reference_without_citation["metrics"]["forbidden_claims_passed"] is False

    long_reference = RAGQueryResponse(
        answer="The rule takes effect on 1 April 2026 [1000000].\n\n- **[1]** Commencement (official-notice)",
        citations=[Citation(
            citation_id=1, document_title="Commencement", source="official-notice",
            chunk_id="commencement#0", excerpt=content, relevance_score=0.95,
        )],
        retrieved_chunks=[retrieved], grounded=True,
    )
    long_reference_result = RAGEvaluator().evaluate_query_response(
        query="When does the rule take effect?", response=long_reference,
        forbidden_claims=["fabricated citation"],
    )
    assert long_reference_result["metrics"]["citation_reference_validity"] == 0.0
    assert long_reference_result["metrics"]["forbidden_claims_passed"] is False


def test_provenance_scores_are_not_failed_for_controls_without_expected_sources():
    no_expected_sources = RAGEvaluator().evaluate_query_response(
        query="A control question with no relevant source",
        response=RAGQueryResponse(answer="I cannot verify that.", grounded=False),
        expected_abstention=True,
        expected_provenance={},
    )
    for metric in (
        "source_trust", "source_identity", "source_freshness",
        "manifest_binding_current", "effective_period", "jurisdiction",
    ):
        assert no_expected_sources["metrics"][metric] is None

    missing_expected_source = RAGEvaluator().evaluate_query_response(
        query="A question with a required source",
        response=RAGQueryResponse(answer="I cannot verify that.", grounded=False),
        expected_abstention=True,
        expected_provenance={"official-source": None},
    )
    assert missing_expected_source["metrics"]["source_trust"] == 0.0
    assert missing_expected_source["metrics"]["source_identity"] == 0.0



def test_optional_metric_formatter_preserves_unavailable_values():
    assert format_metric_value(None) == "N/A"
    assert format_metric_value(float("nan")) == "N/A"
    assert format_metric_value([1, 2]) == "N/A"
    assert format_metric_value(0.5) == "0.5000"

def test_citation_preview_is_identity_valid_even_when_truncated_mid_word():
    """Cited complete evidence, not an arbitrary 200-char preview, bears the fact."""
    fact = "The Rules take effect on 1 April 2026."
    content = ("Official publication context for applicable rules. " * 6) + fact
    preview = content[:200] + "..."
    metadata = ChunkMetadata(
        chunk_id="regulatory#0", document_id="regulatory", chunk_index=0,
        title="Official Rules", source="https://official.example/rules",
    )
    retrieved = RetrievedChunk(
        chunk=TextChunk(
            chunk_id="regulatory#0", document_id="regulatory",
            content=content, metadata=metadata,
        ), score=0.9, rank=1,
    )
    response = RAGQueryResponse(
        answer=f"{fact} [1]",
        citations=[Citation(
            citation_id=1, document_title="Official Rules",
            source="https://official.example/rules",
            chunk_id="regulatory#0", excerpt=preview, relevance_score=0.9,
        )],
        retrieved_chunks=[retrieved],
        grounded=True,
    )
    results = RAGEvaluator().evaluate_query_response(
        query="When do the Rules take effect?",
        response=response,
        required_facts=[fact],
    )
    assert results["metrics"]["citation_identity_correctness"] == 1.0
    assert results["metrics"]["factual_support"] == 1.0

