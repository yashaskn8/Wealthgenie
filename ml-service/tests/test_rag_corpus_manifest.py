from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest

from rag.corpus_manifest import (
    MANIFEST_FILENAME,
    CorpusManifestError,
    canonical_json,
    canonical_text_sha256,
    current_documents,
    load_corpus_manifest,
)
from rag.corpus_generation import current_manifest_sha256, generation_digest
from rag.ingestion.loaders import DocumentLoader
from rag.ingestion.pipeline import IngestionPipeline
from rag.evaluation.run_benchmark import build_ground_truth_chunk_ids, load_questions


CORPUS_DIR = Path(__file__).parents[1] / "rag" / "data" / "corpus"


def test_committed_corpus_manifest_and_content_hash_are_valid():
    manifest = load_corpus_manifest(CORPUS_DIR / MANIFEST_FILENAME, CORPUS_DIR)
    assert manifest["documents"]
    assert all(canonical_text_sha256(CORPUS_DIR / item["local_filename"]) == item["content_sha256"]
               for item in manifest["documents"])
    assert manifest["manifest_sha256"] == current_manifest_sha256()


def test_generation_digest_is_stable_across_mongo_storage_envelope():
    member = {
        "document_revision_id": "revision-a",
        "document_id": "doc-a",
        "version_number": 1,
        "scope": "global",
        "tenant_id": "default",
        "chunk_count": 1,
        "chunk_set_sha256": "a" * 64,
    }
    stored = {**member, "generation_id": "generation-a", "_id": "mongo-generated"}
    assert generation_digest([member]) == generation_digest([stored])


def test_current_documents_use_legal_effective_period_not_retrieval_date():
    manifest = load_corpus_manifest(CORPUS_DIR / MANIFEST_FILENAME, CORPUS_DIR)
    keys_before = {item["document_key"] for item in current_documents(manifest, date(2026, 3, 31))}
    keys_after = {item["document_key"] for item in current_documents(manifest, date(2026, 4, 1))}
    expected = manifest["documents"][0]["document_key"]
    assert expected not in keys_before
    assert expected in keys_after


def test_filename_or_claimed_official_authority_does_not_establish_trust():
    pipeline = IngestionPipeline()
    document = DocumentLoader().load_file(CORPUS_DIR / "income_tax_rules_2026_commencement.md")
    document.metadata.source = "https://www.incometax.gov.in/some/official-looking-path"
    document.metadata.source_trust_tier = "government_official"
    document.metadata.publication_date = "2026-03-20"
    document.metadata.effective_date = "2026-04-01"
    document.metadata.author = "Central Board of Direct Taxes"
    assert pipeline.is_source_trusted(document) is False


def test_manifest_rejects_missing_legal_effective_date(tmp_path):
    manifest = load_corpus_manifest(CORPUS_DIR / MANIFEST_FILENAME, CORPUS_DIR)
    broken = json.loads(json.dumps(manifest))
    broken["documents"][0]["effective_from"] = ""
    payload = {key: value for key, value in broken.items() if key != "manifest_sha256"}
    broken["manifest_sha256"] = __import__("hashlib").sha256(canonical_json(payload)).hexdigest()
    target = tmp_path / MANIFEST_FILENAME
    target.write_text(json.dumps(broken), encoding="utf-8")
    with pytest.raises(CorpusManifestError, match="legal dates"):
        load_corpus_manifest(target)


def test_manifest_rejects_changed_corpus_bytes(tmp_path):
    import shutil

    copied = tmp_path / "corpus"
    copied.mkdir()
    for path in CORPUS_DIR.iterdir():
        if path.is_file():
            shutil.copy2(path, copied / path.name)
    target = copied / "income_tax_rules_2026_commencement.md"
    target.write_text(target.read_text(encoding="utf-8") + "tampered", encoding="utf-8")
    with pytest.raises(CorpusManifestError, match="content hash mismatch"):
        load_corpus_manifest(copied / MANIFEST_FILENAME, copied)


def test_evaluation_corpus_uses_explicit_answerability_and_abstention_controls():
    questions = load_questions(Path(__file__).parents[1] / "rag" / "evaluation" / "eval_questions_v2.json")
    assert len(questions) >= 13
    assert all("expected_source" not in item for item in questions)
    assert all(item["expected_abstention"] == (not item["answerability"]) for item in questions)
    assert all(not item["relevant_document_keys"] for item in questions if item["expected_abstention"])


def test_abstention_control_cannot_earn_source_hit_or_ground_truth():
    assert build_ground_truth_chunk_ids(object(), [], "a" * 64) == set()
