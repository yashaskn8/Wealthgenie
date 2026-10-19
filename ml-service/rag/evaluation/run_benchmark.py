"""
WealthGenie RAG Subsystem - Step 3 Evaluation Benchmark Runner
Loads natural-language user questions from eval_questions_v2.json,
runs each through the real RAG pipeline, and produces a structured
evaluation report with per-question and aggregate metrics.

Usage:
    cd ml-service && python -m rag.evaluation.run_benchmark
"""

import json
import math
import os
import hashlib
import logging
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

# Ensure the ml-service root is on PYTHONPATH
_script_dir = Path(__file__).resolve().parent
_ml_service_root = _script_dir.parent.parent
if str(_ml_service_root) not in sys.path:
    sys.path.insert(0, str(_ml_service_root))

from model.config import BASE_DIR
from rag.chunking.fixed_chunker import FixedSizeChunker
from rag.config import RAGConfig
from rag.corpus_manifest import MANIFEST_FILENAME, current_documents, load_corpus_manifest
from rag.embeddings.dense_embedding import get_embedding_provider
from rag.ingestion.cleaner import clean_text
from rag.ingestion.loaders import DocumentLoader
from rag.evaluation.evaluator import RAGEvaluator
from rag.evaluation.corpus_binding import validate_benchmark_index_binding
from rag.evaluation.metrics import format_metric_value, summarize_metric_values
from rag.retrieval.pipeline import RAGPipeline
from rag.schema import RAGQueryRequest
from rag.vector_store.memory_vector_store import PersistentVectorStore

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("wealthgenie.rag.benchmark_v2")

QUESTIONS_FILE = _script_dir / "eval_questions_v2.json"
REPORT_DIR = BASE_DIR / "reports"
REPORT_DIR.mkdir(parents=True, exist_ok=True)
REPORT_FILE = REPORT_DIR / "real_corpus_evaluation_report.json"


def load_questions(path: Path) -> List[Dict[str, Any]]:
    """Load and validate the answerability-aware canonical evaluation set."""
    with open(path, "r", encoding="utf-8") as f:
        questions = json.load(f)
    if not isinstance(questions, list) or not questions:
        raise ValueError("RAG evaluation set must be a non-empty JSON array")
    seen = set()
    for index, item in enumerate(questions):
        if not isinstance(item, dict):
            raise ValueError(f"RAG evaluation item {index} must be an object")
        required = {"query", "category", "answerability", "expected_abstention", "relevant_document_keys", "required_facts", "forbidden_claims"}
        missing = required.difference(item)
        if missing:
            raise ValueError(f"RAG evaluation item {index} is missing {sorted(missing)}")
        key = item["query"]
        if not isinstance(key, str) or not key.strip() or key in seen:
            raise ValueError(f"RAG evaluation item {index} has an empty or duplicate query")
        seen.add(key)
        if not isinstance(item["answerability"], bool) or item["expected_abstention"] is not (not item["answerability"]):
            raise ValueError(f"RAG evaluation item {index} has inconsistent answerability")
        if not isinstance(item["relevant_document_keys"], list) or not all(isinstance(value, str) for value in item["relevant_document_keys"]):
            raise ValueError(f"RAG evaluation item {index} has invalid relevant_document_keys")
        if item["expected_abstention"] and item["relevant_document_keys"]:
            raise ValueError(f"Abstention control {index} must not claim relevant evidence")
        if item["answerability"] and not item["relevant_document_keys"]:
            raise ValueError(f"Answerable item {index} must identify relevant documents")
    logger.info(f"Loaded {len(questions)} evaluation questions from {path.name}")
    return questions


def build_ground_truth_chunk_ids(
    vector_store,
    relevant_document_keys: List[str],
    manifest_sha256: str,
) -> set:
    """Resolve ground truth by manifest document identity, never by filename/title guesses."""
    if not relevant_document_keys:
        return set()
    chunks = vector_store.get_chunks()
    return {
        chunk.chunk_id
        for chunk in chunks
        if chunk.metadata.custom_metadata.get("document_key") in relevant_document_keys
        and chunk.lifecycle_state == "ACTIVE"
        and chunk.metadata.custom_metadata.get("corpus_manifest_sha256") == manifest_sha256
    }


def source_match(retrieved_chunks, relevant_document_keys: List[str], manifest_sha256: str) -> bool:
    """Checks provenance by canonical manifest key; abstention controls never earn a hit."""
    return bool(relevant_document_keys) and any(
        rc.chunk.metadata.custom_metadata.get("document_key") in relevant_document_keys
        and rc.chunk.lifecycle_state == "ACTIVE"
        and rc.chunk.metadata.custom_metadata.get("corpus_manifest_sha256") == manifest_sha256
        for rc in retrieved_chunks
    )


def run_benchmark(*, config=None, vector_store=None, embedder=None, research_replay=None) -> Dict[str, Any]:
    """Run benchmark using a verified corpus; optional dependencies enable isolated research replay."""
    questions = load_questions(QUESTIONS_FILE)
    corpus_dir = _ml_service_root / "rag" / "data" / "corpus"
    manifest = load_corpus_manifest(corpus_dir / MANIFEST_FILENAME, corpus_dir)
    evaluation_date = date.today()
    current_entries = current_documents(manifest, as_of=evaluation_date)
    current_keys = {item["document_key"] for item in current_entries}
    unknown_keys = {
        key for item in questions for key in item["relevant_document_keys"]
        if key not in current_keys
    }
    if unknown_keys:
        raise ValueError(f"Evaluation set references documents not current in the verified corpus: {sorted(unknown_keys)}")

    # Initialize pipeline with real corpus vector store
    config = config if config is not None else RAGConfig()
    embedder = embedder if embedder is not None else get_embedding_provider(config)
    vector_store = vector_store if vector_store is not None else PersistentVectorStore(index_path=config.vector_store_path)
    loader = DocumentLoader()
    chunker = FixedSizeChunker()
    expected_chunk_ids_by_document = {}
    for entry in current_entries:
        document = loader.load_file(corpus_dir / entry["local_filename"])
        document.content = clean_text(document.content)
        expected_chunk_ids_by_document[entry["document_key"]] = {
            chunk.chunk_id for chunk in chunker.chunk_document(document)
        }
    index_binding = validate_benchmark_index_binding(
        vector_store, manifest, expected_chunk_ids_by_document, as_of=evaluation_date,
    )
    pipeline = RAGPipeline(
        embedder=embedder,
        vector_store=vector_store,
        config=config,
    )
    evaluator = RAGEvaluator()

    logger.info(
        f"Pipeline initialized: {index_binding['active_chunk_count']} verified active chunks, "
        f"strategy={config.retrieval_strategy}, reranker={config.reranker_strategy}"
    )

    per_question_results: List[Dict[str, Any]] = []
    category_metrics: Dict[str, List[Dict[str, float]]] = {}
    total_source_hits = 0
    total_queries = len(questions)
    all_latencies: List[float] = []
    provenance_by_key = {
        entry["document_key"]: {**entry, "_manifest_sha256": manifest["manifest_sha256"]}
        for entry in manifest["documents"]
    }

    for idx, q_item in enumerate(questions, start=1):
        question = q_item["query"]
        relevant_document_keys = q_item["relevant_document_keys"]
        category = q_item.get("category", "unknown")

        logger.info(f"[{idx}/{total_queries}] Evaluating: {question[:60]}...")

        t0 = time.perf_counter()
        request = RAGQueryRequest(question=question, include_citations=True)
        response = pipeline.query(request)
        query_time_ms = (time.perf_counter() - t0) * 1000.0
        all_latencies.append(query_time_ms)

        # Invalidate cache so each question gets fresh retrieval
        pipeline.cache_manager.invalidate_all()

        # Build ground truth chunk IDs from expected source document
        gt_chunk_ids = build_ground_truth_chunk_ids(
            vector_store, relevant_document_keys, manifest["manifest_sha256"]
        )

        # Evaluate retrieval quality against real ground truth
        eval_result = evaluator.evaluate_query_response(
            query=question,
            response=response,
            ground_truth_chunk_ids=gt_chunk_ids,
            expected_abstention=q_item["expected_abstention"],
            required_facts=q_item["required_facts"],
            forbidden_claims=q_item["forbidden_claims"],
            expected_provenance={
                key: provenance_by_key.get(key)
                for key in relevant_document_keys
            },
            expected_manifest_sha256=manifest["manifest_sha256"],
            expected_jurisdiction="IN",
            as_of_date=evaluation_date,
            k=4,
        )

        # Source provenance check: did we retrieve from the expected document?
        hit = source_match(
            response.retrieved_chunks, relevant_document_keys, manifest["manifest_sha256"]
        )
        if hit:
            total_source_hits += 1

        # Gather top-3 retrieved chunk sources for transparency
        top_sources = []
        for rc in response.retrieved_chunks[:3]:
            top_sources.append({
                "title": rc.chunk.metadata.title,
                "source": rc.chunk.metadata.source,
                "score": round(rc.score, 4),
            })

        question_result = {
            "question_index": idx,
            "question": question,
            "category": category,
            "answerability": q_item["answerability"],
            "expected_abstention": q_item["expected_abstention"],
            "relevant_document_keys": relevant_document_keys,
            "required_facts": q_item["required_facts"],
            "forbidden_claims": q_item["forbidden_claims"],
            "source_hit": hit,
            "abstention_correct": eval_result["metrics"]["abstention_correctness"],
            "grounded": response.grounded,
            "metrics": eval_result["metrics"],
            "query_latency_ms": round(query_time_ms, 2),
            "chunks_retrieved": eval_result["retrieved_chunk_count"],
            "citations_count": eval_result["citations_count"],
            "top_retrieved_sources": top_sources,
        }
        per_question_results.append(question_result)

        # Accumulate category-level metrics
        if category not in category_metrics:
            category_metrics[category] = []
        category_metrics[category].append(eval_result["metrics"])

    # Aggregate only finite numeric observations. None means unverified/unavailable
    # evidence and must remain null rather than crashing or becoming a false zero.
    all_metrics_keys = list(per_question_results[0]["metrics"].keys()) if per_question_results else []
    aggregate_metrics = {}
    for key in all_metrics_keys:
        raw_values = [r["metrics"][key] for r in per_question_results if key in r["metrics"]]
        aggregate_metrics[key] = summarize_metric_values(raw_values)

    # Category breakdowns preserve the same unavailable semantics as the overall report.
    category_summaries = {}
    for cat, metrics_list in category_metrics.items():
        cat_summary = {}
        for key in all_metrics_keys:
            raw = [m[key] for m in metrics_list if key in m]
            cat_summary[key] = summarize_metric_values(raw)["mean"]
        cat_count = len(metrics_list)
        cat_source_hits = sum(1 for r in per_question_results if r["category"] == cat and r["source_hit"])
        cat_summary["question_count"] = cat_count
        cat_summary["source_hit_rate"] = round(cat_source_hits / cat_count, 4) if cat_count else 0.0
        category_summaries[cat] = cat_summary

    # Latency summary
    import numpy as np
    latency_arr = np.array(all_latencies)
    latency_summary = {
        "mean_ms": round(float(np.mean(latency_arr)), 2),
        "p50_ms": round(float(np.percentile(latency_arr, 50)), 2),
        "p90_ms": round(float(np.percentile(latency_arr, 90)), 2),
        "p99_ms": round(float(np.percentile(latency_arr, 99)), 2),
        "min_ms": round(float(np.min(latency_arr)), 2),
        "max_ms": round(float(np.max(latency_arr)), 2),
    }

    report = {
        "report_id": f"rag_eval_v4_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}",
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "research_replay": research_replay,
        "code_git_sha": os.getenv("GITHUB_SHA") or None,
        "corpus_info": {
            "total_chunks_in_store": len(vector_store.get_chunks()),
            "questions_evaluated": total_queries,
            "questions_file": str(QUESTIONS_FILE.name),
            "questions_sha256": hashlib.sha256(QUESTIONS_FILE.read_bytes()).hexdigest(),
            "manifest_sha256": manifest["manifest_sha256"],
            "current_document_keys": sorted(current_keys),
            "index_binding": index_binding,
        },
        "pipeline_config": {
            "retrieval_strategy": config.retrieval_strategy,
            "reranker_strategy": config.reranker_strategy,
            "top_k": config.top_k,
            "similarity_threshold": config.similarity_threshold,
            "embedding_dim": config.embedding_dim,
        },
        "aggregate_metrics": aggregate_metrics,
        "source_provenance": {
            "source_hit_count": total_source_hits,
            "total_questions": total_queries,
            "source_hit_rate": round(total_source_hits / total_queries, 4) if total_queries else 0.0,
        },
        "abstention_controls": {
            "expected_count": sum(item["expected_abstention"] for item in per_question_results),
            "correct_count": sum(
                bool(item["abstention_correct"])
                for item in per_question_results
                if item["expected_abstention"]
            ),
            "unexpectedly_grounded_count": sum(
                bool(item["grounded"])
                for item in per_question_results
                if item["expected_abstention"]
            ),
        },
        "latency_summary": latency_summary,
        "category_breakdowns": category_summaries,
        "per_question_results": per_question_results,
    }

    return report


def main():
    """Entry point for benchmark execution."""
    logger.info("=" * 60)
    logger.info("WealthGenie RAG Evaluation Benchmark v2 — Real Corpus")
    logger.info("=" * 60)

    report = run_benchmark()

    # Persist report
    # Replace NaN with None for JSON serialization
    def sanitize_nan(obj):
        if isinstance(obj, float) and math.isnan(obj):
            return None
        if isinstance(obj, dict):
            return {k: sanitize_nan(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [sanitize_nan(v) for v in obj]
        return obj

    report = sanitize_nan(report)
    with open(REPORT_FILE, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    logger.info(f"Evaluation report saved to {REPORT_FILE}")

    # Print summary
    agg = report["aggregate_metrics"]
    prov = report["source_provenance"]
    lat = report["latency_summary"]

    print("\n" + "=" * 60)
    print("EVALUATION SUMMARY")
    print("=" * 60)
    print(f"Questions evaluated:  {report['corpus_info']['questions_evaluated']}")
    print(f"Chunks in store:      {report['corpus_info']['total_chunks_in_store']}")
    print(f"Source hit rate:       {prov['source_hit_rate']:.1%} ({prov['source_hit_count']}/{prov['total_questions']})")
    print("")
    print("Aggregate Retrieval Metrics (mean):")
    for key, vals in agg.items():
        print(
            f"  {key:32s}: {format_metric_value(vals['mean'])}  "
            f"(min={format_metric_value(vals['min'])}, max={format_metric_value(vals['max'])})"
        )
    print("")
    print("Latency:")
    print(f"  Mean:  {lat['mean_ms']:.1f}ms | P50: {lat['p50_ms']:.1f}ms | P90: {lat['p90_ms']:.1f}ms | P99: {lat['p99_ms']:.1f}ms")
    print("")
    print("Category Breakdowns:")
    for cat, summary in report["category_breakdowns"].items():
        print(f"  {cat}: {summary['question_count']} questions, source_hit_rate={summary['source_hit_rate']:.1%}")
    print("=" * 60)


if __name__ == "__main__":
    main()
