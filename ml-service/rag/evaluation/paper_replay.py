"""Isolated, auditable RAG evaluation for paper evidence.

Rebuilds an empty temporary index from the current hash-verified corpus; never
reuses developer state or legacy 75-question reports. Requires the pinned real
sentence-transformer model and fails instead of silently using lexical fallback.
The emitted report is *not* a claim of generalizable factual accuracy.
Run from ml-service: python -m rag.evaluation.paper_replay --output reports/paper_rag_current.json
"""
from __future__ import annotations

import argparse
import json
import math
import os
import tempfile
from datetime import date, timezone, datetime
from pathlib import Path

from rag.config import RAGConfig
from rag.corpus_manifest import MANIFEST_FILENAME, current_documents, load_corpus_manifest
from rag.embeddings.dense_embedding import get_embedding_provider
from rag.evaluation.run_benchmark import run_benchmark
from rag.ingestion.pipeline import IngestionPipeline
from rag.vector_store.memory_vector_store import PersistentVectorStore


def finite_json(value):
    """Represent unavailable numeric metrics as null, never NaN or invented zero."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {key: finite_json(item) for key, item in value.items()}
    if isinstance(value, list):
        return [finite_json(item) for item in value]
    return value


def replay() -> dict:
    corpus_dir = Path(__file__).resolve().parents[1] / "data" / "corpus"
    manifest = load_corpus_manifest(corpus_dir / MANIFEST_FILENAME, corpus_dir)
    current = current_documents(manifest, as_of=date.today())
    if not current:
        raise ValueError("No valid current corpus documents: cannot run a paper benchmark.")

    with tempfile.TemporaryDirectory(prefix="wealthgenie-paper-rag-") as temp:
        config = RAGConfig(vector_store_path=Path(temp) / "fresh-paper-index.json")
        embedder = get_embedding_provider(config)
        identity = getattr(embedder, "embedding_identity", {})
        if identity.get("provider") != "sentence_transformers":
            raise RuntimeError("Paper evidence requires pinned sentence-transformers; lexical fallback is forbidden.")
        if identity.get("model_revision") in (None, "none", ""):
            raise RuntimeError("Pinned semantic model revision cannot be verified.")

        store = PersistentVectorStore(index_path=config.vector_store_path)
        ingestor = IngestionPipeline(embedder=embedder, vector_store=store)
        for entry in current:
            outcome = ingestor.ingest_file(corpus_dir / entry["local_filename"])
            if outcome.get("chunks_added", 0) <= 0:
                raise RuntimeError("Current corpus document was not indexed: " + entry["document_key"])

        report = run_benchmark(
            config=config,
            vector_store=store,
            embedder=embedder,
            research_replay={
                "contract": "WEALTHGENIE_ISOLATED_PAPER_RAG_V1",
                "embedding_provider": identity["provider"],
                "model_id": identity.get("model_id"),
                "model_revision": identity.get("model_revision"),
                "embedding_config_hash": identity.get("config_hash"),
                "verified_current_document_count": len(current),
                "temporary_index": True,
                "no_legacy_index_reuse": True,
            },
        )
        binding = report["corpus_info"]["index_binding"]
        if binding.get("status") != "VERIFIED":
            raise RuntimeError("Benchmark index failed corpus manifest binding.")
        if len(report["per_question_results"]) != report["corpus_info"]["questions_evaluated"]:
            raise RuntimeError("Benchmark did not produce one result per current question.")
        return finite_json(report)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True, help="Output JSON (never overwrite historical report)")
    args = parser.parse_args()
    path = args.output.resolve()
    historic = Path(__file__).resolve().parents[2] / "reports" / "real_corpus_evaluation_report.json"
    if path == historic:
        raise ValueError("Historical corpus report is immutable; use a distinct paper evidence file.")
    result = replay()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({
        "status": "CURRENT_CORPUS_REPLAY_COMPLETED",
        "path": str(path),
        "questions": result["corpus_info"]["questions_evaluated"],
        "manifest_sha256": result["corpus_info"]["manifest_sha256"],
        "model_revision": result["research_replay"]["model_revision"],
        "observed_utc": datetime.now(timezone.utc).isoformat(),
    }, indent=2))


if __name__ == "__main__":
    main()
