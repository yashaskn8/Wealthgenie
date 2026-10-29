"""
WealthGenie RAG Subsystem - Benchmarking Test Suite
Tests performance measurement, percentile calculations, ingestion throughput, and query QPS benchmarking.
"""

from rag.benchmark import RAGBenchmarkSuite, compute_percentiles


def test_percentile_calculation():
    latencies = [10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0, 100.0]
    stats = compute_percentiles(latencies)
    assert stats["count"] == 10
    assert stats["min_ms"] == 10.0
    assert stats["max_ms"] == 100.0
    assert stats["p50_ms"] == 55.0
    assert stats["mean_ms"] == 55.0


def test_rag_ingestion_benchmark(tmp_path):
    index_path = tmp_path / "benchmark_index.json"
    suite = RAGBenchmarkSuite(vector_store_path=index_path)

    ingest_results = suite.run_ingestion_benchmark(num_docs=5)
    assert ingest_results["num_documents"] == 5
    assert ingest_results["total_chunks_created"] > 0
    assert ingest_results["docs_per_second"] > 0.0
    assert ingest_results["chunks_per_second"] > 0.0


def test_rag_query_benchmark(tmp_path):
    index_path = tmp_path / "benchmark_index.json"
    suite = RAGBenchmarkSuite(vector_store_path=index_path)
    suite.run_ingestion_benchmark(num_docs=3)

    query_results = suite.run_query_benchmark(num_queries=6)
    assert "cold_cache" in query_results
    assert "warm_cache" in query_results
    assert query_results["cold_cache"]["stats"]["count"] == 6
    assert query_results["warm_cache"]["stats"]["count"] == 6

    # Sub-millisecond p50 comparisons fluctuate under concurrent CI load.
    # Verify genuine cache reuse instead of treating scheduler noise as a
    # functional regression; the benchmark still reports both raw latencies.
    cache_stats = query_results["cache_stats"]["stats"]
    assert cache_stats["response_misses"] >= 5  # Five distinct cold questions.
    assert cache_stats["response_hits"] >= 6    # Every warm question is cached.
    assert query_results["cold_cache"]["qps"] > 0
    assert query_results["warm_cache"]["qps"] > 0
