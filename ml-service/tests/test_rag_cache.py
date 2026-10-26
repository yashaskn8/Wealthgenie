"""
WealthGenie RAG Subsystem - Multi-Level Cache Test Suite
Tests response caching, retrieval caching, TTL expiration, invalidation, and pipeline cache integration.
"""

import time
from rag.cache.manager import MultiLevelCacheManager, CacheItem
from rag.config import RAGConfig
from rag.embeddings.dense_embedding import DenseVectorEmbeddingProvider
from rag.vector_store.memory_vector_store import PersistentVectorStore
from rag.retrieval.pipeline import RAGPipeline
from rag.schema import RAGQueryRequest, RAGQueryResponse


def test_cache_item_ttl_expiration():
    item = CacheItem("test_value", ttl_seconds=0.1)
    assert not item.is_expired()
    time.sleep(0.15)
    assert item.is_expired()


def test_response_cache_hit_and_miss():
    manager = MultiLevelCacheManager(response_ttl=10.0)

    query = "What is Section 87A rebate?"
    assert manager.get_response(query) is None
    assert manager.stats["response_misses"] == 1

    dummy_response = RAGQueryResponse(
        answer="Section 87A rebate gives zero tax for income up to 12 Lakhs.",
        citations=[],
        retrieved_chunks=[],
        metrics={"total_latency_ms": 1.5},
        grounded=True,
    )

    manager.put_response(query, dummy_response)

    cached = manager.get_response(query)
    assert cached is not None
    assert cached.answer == dummy_response.answer
    assert manager.stats["response_hits"] == 1


def test_cache_invalidation_and_stats():
    manager = MultiLevelCacheManager()
    manager.put_response("query1", RAGQueryResponse(answer="a1", citations=[], retrieved_chunks=[], metrics={}, grounded=True))

    stats_before = manager.get_cache_stats()
    assert stats_before["response_cache_size"] == 1

    manager.invalidate_all()
    stats_after = manager.get_cache_stats()
    assert stats_after["response_cache_size"] == 0


def test_rag_pipeline_response_caching_integration(tmp_path):
    config = RAGConfig(vector_store_path=tmp_path / "cache_index.json", embedding_dim=64)
    embedder = DenseVectorEmbeddingProvider(dimension=64, enable_cache=False)
    vector_store = PersistentVectorStore(index_path=tmp_path / "cache_index.json")
    cache_mgr = MultiLevelCacheManager()

    pipeline = RAGPipeline(embedder=embedder, vector_store=vector_store, cache_manager=cache_mgr, config=config)
    req = RAGQueryRequest(question="How much deduction is allowed under 80C?")

    # First query -> Miss
    res1 = pipeline.query(req)
    assert cache_mgr.stats["response_misses"] == 1

    # Second query -> Hit
    res2 = pipeline.query(req)
    assert cache_mgr.stats["response_hits"] == 1
    assert res1.answer == res2.answer


def test_response_cache_is_partitioned_by_shared_corpus_generation(tmp_path):
    class GenerationStore:
        generation = "generation-a"

        def get_generation_snapshot(self):
            return {
                "generation_id": self.generation,
                "revision": 1 if self.generation == "generation-a" else 2,
                "manifest_sha256": "a" * 64,
                "membership_sha256": ("b" if self.generation == "generation-a" else "c") * 64,
            }

        def get_corpus_revision(self):
            return "1"

    config = RAGConfig(embedding_dim=64)
    embedder = DenseVectorEmbeddingProvider(dimension=64, enable_cache=False)
    store = GenerationStore()
    cache = MultiLevelCacheManager(cache_dir=tmp_path / "cache")
    pipeline = RAGPipeline(embedder=embedder, vector_store=store, cache_manager=cache, config=config)
    request = RAGQueryRequest(question="Tell me a recipe for chocolate cake.")

    first = pipeline.query(request)
    assert first.metrics["response_mode"] == "abstention"
    assert cache.stats["response_misses"] == 1
    store.generation = "generation-b"
    pipeline.query(request)

    assert cache.stats["response_misses"] == 2
    assert cache.stats["response_hits"] == 0
    assert len(cache._response_cache) == 2

def test_rag_discards_evidence_when_generation_changes_during_retrieval(tmp_path):
    class FlappingGenerationStore:
        def __init__(self):
            self.calls = 0

        def get_generation_snapshot(self):
            self.calls += 1
            generation = "generation-a" if self.calls == 1 else "generation-b"
            return {"generation_id": generation, "revision": 1 if generation == "generation-a" else 2, "manifest_sha256": ("a" if generation == "generation-a" else "b") * 64, "membership_sha256": ("c" if generation == "generation-a" else "d") * 64}

        def get_corpus_revision(self):
            return "1"

    class EmptyRetriever:
        strategy_name = "test"

        def retrieve(self, **_kwargs):
            return []

    pipeline = RAGPipeline(
        embedder=DenseVectorEmbeddingProvider(dimension=64, enable_cache=False),
        vector_store=FlappingGenerationStore(),
        retriever=EmptyRetriever(),
        cache_manager=MultiLevelCacheManager(cache_dir=tmp_path / "cache"),
        config=RAGConfig(embedding_dim=64),
    )
    response = pipeline.query(RAGQueryRequest(question="When do the Income-tax Rules 2026 take effect?"))
    assert response.grounded is False
    assert response.metrics["abstention_reason"] == "corpus_changed_during_retrieval"
    assert response.metrics["corpus_generation_id"] == "generation-a"
    assert pipeline.cache_manager.stats["response_misses"] == 1
    assert len(pipeline.cache_manager._response_cache) == 0
