"""
WealthGenie RAG Subsystem - Observability Test Suite
Tests telemetry trace recording, JSON file persistence, summary statistics, and RAGPipeline integration.
"""

from rag.config import RAGConfig
from rag.embeddings.dense_embedding import DenseVectorEmbeddingProvider
from rag.vector_store.memory_vector_store import PersistentVectorStore
from rag.observability.metrics_collector import RAGObservabilityCollector
from rag.retrieval.pipeline import RAGPipeline
from rag.schema import RAGQueryRequest


def test_observability_trace_recording(tmp_path):
    collector = RAGObservabilityCollector(telemetry_dir=tmp_path)

    trace = collector.record_query_trace(
        retrieval_strategy="hybrid_rrf",
        reranker_strategy="no_op",
        stage_latencies_ms={
            "query_understanding": 0.5,
            "retrieval": 4.2,
            "reranking": 0.1,
            "prompt_assembly": 0.3,
            "answer_synthesis": 1.0,
        },
        chunks_retrieved=4,
        chunks_after_rerank=4,
        context_char_count=850,
        citation_count=1,
        top_score=0.92,
        cache_hits=2,
        cache_misses=1,
    )

    assert trace["retrieval_strategy"] == "hybrid_rrf"
    assert "query" not in trace
    assert "search_query" not in trace
    assert trace["latencies_ms"]["total"] == 6.1
    assert trace["cache"]["hit_rate"] == round(2 / 3, 4)

    stats = collector.get_summary_stats()
    assert stats["total_queries"] == 1
    assert stats["max_latency_ms"] == 6.1


def test_telemetry_snapshot_persistence(tmp_path):
    collector = RAGObservabilityCollector(telemetry_dir=tmp_path)

    collector.record_query_trace(
        retrieval_strategy="dense",
        reranker_strategy="no_op",
        stage_latencies_ms={"retrieval": 2.0},
        chunks_retrieved=2,
        chunks_after_rerank=2,
        context_char_count=300,
        citation_count=1,
        top_score=0.8,
    )

    snapshot_file = collector.persist_telemetry_snapshot()
    assert snapshot_file.exists()
    assert "telemetry_" in snapshot_file.name
    assert "Test query" not in snapshot_file.read_text(encoding="utf-8")


def test_rag_pipeline_telemetry_integration(tmp_path, caplog):
    config = RAGConfig(vector_store_path=tmp_path / "obs_index.json", embedding_dim=64)
    embedder = DenseVectorEmbeddingProvider(dimension=64, enable_cache=False)
    vector_store = PersistentVectorStore(index_path=tmp_path / "obs_index.json")
    collector = RAGObservabilityCollector(telemetry_dir=tmp_path)

    pipeline = RAGPipeline(embedder=embedder, vector_store=vector_store, telemetry=collector, config=config)
    request = RAGQueryRequest(question="PRIVATE_QUERY_SENTINEL When do the Income-tax Rules 2026 take effect?")
    res = pipeline.query(request)
    pipeline.query(request)

    assert res.metrics["response_mode"] == "abstention"
    assert res.metrics["abstention_reason"] == "empty_evidence"
    assert len(collector._trace_records) == 1
    assert "question" not in collector._trace_records[0]
    assert "search_query" not in collector._trace_records[0]
    assert "PRIVATE_QUERY_SENTINEL" not in caplog.text
