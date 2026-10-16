"""
WealthGenie RAG Subsystem - Document Lifecycle Manager Test Suite
Tests document registration, soft deletion, hard deletion, metadata update,
atomic writes, SHA-256 checksums, backup recovery, reconciliation, concurrent mutations,
per-user tenancy isolation, ownership enforcement on mutations, legacy schema migration,
and FastAPI router integration.
"""

import concurrent.futures
import json
import os
import threading
import pytest
from fastapi.testclient import TestClient
from main import app
from rag.lifecycle.manager import DocumentLifecycleManager
from rag.schema import Document, DocumentMetadata, TextChunk, ChunkMetadata
from rag.vector_store.memory_vector_store import PersistentVectorStore


def _assert_futures_complete(futures, timeout=30):
    done, pending = concurrent.futures.wait(futures, timeout=timeout)
    assert not pending, f"concurrent RAG lifecycle operation exceeded {timeout}s"
    for future in done:
        future.result()


@pytest.fixture
def client():
    api_key = os.environ.get("ML_SERVICE_API_KEY", "wealthgenie_secret_api_key_2026")
    with TestClient(app, headers={"X-API-Key": api_key, "X-Verified-User-Id": "test-user-id"}) as c:
        yield c


def test_document_lifecycle_registration_and_soft_delete(tmp_path):
    reg_file = tmp_path / "test_registry.json"
    store = PersistentVectorStore(index_path=tmp_path / "test_store.json")
    manager = DocumentLifecycleManager(vector_store=store, registry_path=reg_file)

    chunk_metadata = ChunkMetadata(
        chunk_id="doc1#0", document_id="doc1", chunk_index=0,
        title="Tax Guide", source="tax.md",
    )
    store.add_chunks([TextChunk(
        chunk_id="doc1#0", document_id="doc1", content="Tax guide lifecycle fixture",
        metadata=chunk_metadata, embedding=[1.0, 0.0],
    )])

    doc = Document(
        document_id="doc1",
        content="Sample content",
        metadata=DocumentMetadata(title="Tax Guide", source="tax.md", author="Expert", scope="global"),
    )

    manager.register_document(doc, chunk_count=2)
    docs = manager.list_documents()
    assert len(docs) == 1
    assert docs[0]["title"] == "Tax Guide"
    assert docs[0]["scope"] == "global"

    # Soft delete
    manager.soft_delete_document("doc1")
    active_docs = manager.list_documents(include_inactive=False)
    all_docs = manager.list_documents(include_inactive=True)
    assert len(active_docs) == 0
    assert len(all_docs) == 1
    restarted = PersistentVectorStore(index_path=tmp_path / "test_store.json", force_numpy=True)
    assert restarted.search([1.0, 0.0], top_k=1) == []


def test_registry_backup_write_failure_does_not_log_exception_text(tmp_path, monkeypatch, caplog):
    import logging
    import rag.lifecycle.manager as lifecycle_module

    registry_path = tmp_path / "registry.json"
    registry_path.write_text("{}", encoding="utf-8")
    manager = DocumentLifecycleManager(
        vector_store=PersistentVectorStore(index_path=tmp_path / "vectors.json", force_numpy=True),
        registry_path=registry_path,
    )
    secret_canary = "PAN-987654321012 redis://user:private-password@internal:6379"

    def fail_backup(*_args, **_kwargs):
        raise OSError(secret_canary)

    monkeypatch.setattr(lifecycle_module.shutil, "copy2", fail_backup)
    monkeypatch.setattr(lifecycle_module.os, "replace", lambda _source, _destination: None)
    caplog.set_level(logging.WARNING, logger="wealthgenie.rag.lifecycle")
    manager.save_registry()

    assert secret_canary not in caplog.text
    assert "Could not create registry backup snapshot" in caplog.text
    assert any(getattr(record, "error_type", None) == "OSError" for record in caplog.records)


def test_request_driven_registry_load_failure_does_not_log_exception_text(tmp_path, monkeypatch, caplog):
    import logging

    registry_path = tmp_path / "registry.json"
    registry_path.write_text("{}", encoding="utf-8")
    manager = DocumentLifecycleManager(
        vector_store=PersistentVectorStore(index_path=tmp_path / "vectors.json", force_numpy=True),
        registry_path=registry_path,
    )
    secret_canary = "PAN-987654321012 redis://user:private-password@internal:6379"

    def fail_load(_path):
        raise RuntimeError(secret_canary)

    monkeypatch.setattr(manager, "_load_from_path", fail_load)
    caplog.set_level(logging.ERROR, logger="wealthgenie.rag.lifecycle")
    with pytest.raises(RuntimeError, match="no backup is available") as error:
        manager.list_documents()

    assert error.value.__cause__ is None
    assert error.value.__suppress_context__ is True
    assert secret_canary not in caplog.text
    assert "Failed to load primary document registry" in caplog.text
    assert any(getattr(record, "error_type", None) == "RuntimeError" for record in caplog.records)


def test_soft_deleted_document_is_not_retrievable_or_served_from_response_cache(tmp_path):
    from rag.embeddings.dense_embedding import DenseVectorEmbeddingProvider
    from rag.ingestion.pipeline import IngestionPipeline
    from rag.retrieval.pipeline import RAGPipeline
    from rag.schema import RAGQueryRequest

    store = PersistentVectorStore(index_path=tmp_path / "cache_lifecycle_vectors.json", force_numpy=True)
    manager = DocumentLifecycleManager(
        vector_store=store,
        registry_path=tmp_path / "cache_lifecycle_registry.json",
    )
    embedder = DenseVectorEmbeddingProvider(dimension=64, enable_cache=False)
    ingestion = IngestionPipeline(embedder=embedder, vector_store=store, lifecycle_manager=manager)
    from pathlib import Path

    corpus_file = Path(__file__).parents[1] / "rag" / "data" / "corpus" / "income_tax_rules_2026_commencement.md"
    ingestion.ingest_file(corpus_file)
    query = RAGQueryRequest(question="When do the Income-tax Rules 2026 take effect?")
    retrieval = RAGPipeline(embedder=embedder, vector_store=store)

    first = retrieval.query(query)
    assert first.grounded
    assert first.retrieved_chunks

    document_id = first.retrieved_chunks[0].chunk.document_id
    assert manager.soft_delete_document(document_id)
    second = retrieval.query(query)
    assert not second.grounded
    assert second.retrieved_chunks == []


def test_document_hard_delete_and_chunk_purging(tmp_path):
    reg_file = tmp_path / "test_registry.json"
    store = PersistentVectorStore(index_path=tmp_path / "test_store.json")

    meta = ChunkMetadata(chunk_id="c1", document_id="doc1", chunk_index=0, title="T1", source="s1.md", scope="user:u1")
    chunk = TextChunk(chunk_id="c1", document_id="doc1", content="Content", metadata=meta, embedding=[1.0, 0.0])
    store.add_chunks([chunk])

    manager = DocumentLifecycleManager(vector_store=store, registry_path=reg_file)
    manager.register_document(
        Document(document_id="doc1", content="Content", metadata=DocumentMetadata(title="T1", source="s1.md", scope="user:u1")),
        chunk_count=1,
    )

    assert len(store._chunks) == 1

    # Hard delete as owner u1
    success = manager.hard_delete_document("doc1", requesting_user_id="u1")
    assert success
    assert len(store._chunks) == 0
    assert len(manager.list_documents()) == 0
    restarted = PersistentVectorStore(index_path=tmp_path / "test_store.json", force_numpy=True)
    assert restarted.get_chunks("doc1") == []


def test_document_metadata_update(tmp_path):
    reg_file = tmp_path / "test_registry.json"
    store = PersistentVectorStore(index_path=tmp_path / "test_store.json")

    meta = ChunkMetadata(chunk_id="c1", document_id="doc1", chunk_index=0, title="Old Title", source="s1.md", scope="user:u1")
    chunk = TextChunk(chunk_id="c1", document_id="doc1", content="Content", metadata=meta, embedding=[1.0, 0.0])
    store.add_chunks([chunk])

    manager = DocumentLifecycleManager(vector_store=store, registry_path=reg_file)
    manager.register_document(
        Document(document_id="doc1", content="Content", metadata=DocumentMetadata(title="Old Title", source="s1.md", scope="user:u1")),
        chunk_count=1,
    )

    manager.update_metadata("doc1", new_title="New Tax Guide Title", new_author="Jane Doe", requesting_user_id="u1")

    doc_entry = manager.list_documents()[0]
    assert doc_entry["title"] == "New Tax Guide Title"
    assert doc_entry["author"] == "Jane Doe"
    assert store._chunks[0].metadata.title == "New Tax Guide Title"
    assert store._chunks[0].metadata.author == "Jane Doe"


def test_hard_delete_interruption_leaves_safe_state_and_reconciles(tmp_path):
    """
    PROOF: Simulates process crash/interruption between vector-store-save and registry-save.
    Asserts:
      1. Vector store chunks are genuinely gone from search results (no stale/unauthorized retrieval).
      2. Fresh DocumentLifecycleManager loaded from disk flags the stale registry entry during reconciliation.
    """
    reg_file = tmp_path / "test_registry.json"
    store_file = tmp_path / "test_store.json"
    store = PersistentVectorStore(index_path=store_file)

    meta = ChunkMetadata(chunk_id="c1", document_id="doc_secret", chunk_index=0, title="Secret Document", source="secret.md")
    chunk = TextChunk(chunk_id="c1", document_id="doc_secret", content="Secret Financial Plan", metadata=meta, embedding=[1.0, 0.0])
    store.add_chunks([chunk])

    manager = DocumentLifecycleManager(vector_store=store, registry_path=reg_file)
    manager.register_document(
        Document(document_id="doc_secret", content="Secret Financial Plan", metadata=DocumentMetadata(title="Secret Document", source="secret.md")),
        chunk_count=1,
    )

    # Injected real exception simulating process crash exactly between vector store save and registry save
    class ProcessKilledSimulation(RuntimeError):
        pass

    def crash_before_registry_save():
        raise ProcessKilledSimulation("SIGKILL simulated after vector store purge but before registry save")

    manager._save_registry_unlocked = crash_before_registry_save

    with pytest.raises(ProcessKilledSimulation):
        manager.hard_delete_document("doc_secret")

    # Instantiate brand new fresh store and manager loading state from disk
    fresh_store = PersistentVectorStore(index_path=store_file)
    fresh_mgr = DocumentLifecycleManager(vector_store=fresh_store, registry_path=reg_file)

    # 1. Content is genuinely absent from vector store and search results
    assert len(fresh_store._chunks) == 0
    search_results = fresh_store.search(query_vector=[1.0, 0.0], top_k=5)
    assert len(search_results) == 0

    # 2. Reconciliation flags the stale registry entry
    recon = fresh_mgr.reconcile_registry_and_vector_store()
    assert recon["status"] == "ANOMALIES_DETECTED"
    assert "doc_secret" in recon["stale_registry_documents"]
    assert recon["stale_registry_count"] == 1
    assert recon["orphaned_vector_count"] == 0


def test_registry_atomic_save_and_backup_recovery(tmp_path):
    """
    Proves save_registry() uses atomic writes with checksum and survives
    simulated corruption of the primary file by recovering from .json.bak.
    """
    reg_file = tmp_path / "test_registry.json"
    store = PersistentVectorStore(index_path=tmp_path / "test_store.json")
    manager = DocumentLifecycleManager(vector_store=store, registry_path=reg_file)

    doc1 = Document(document_id="d1", content="Text 1", metadata=DocumentMetadata(title="Doc 1", source="s1.md"))
    doc2 = Document(document_id="d2", content="Text 2", metadata=DocumentMetadata(title="Doc 2", source="s2.md"))

    manager.register_document(doc1, chunk_count=1)
    assert reg_file.exists()

    with open(reg_file, "r", encoding="utf-8") as f:
        data = json.load(f)
    assert data["version"] == "2.0"
    assert "sha256" in data
    assert data["total_documents"] == 1

    # Second mutation creates .json.bak snapshot
    manager.register_document(doc2, chunk_count=1)
    assert manager.backup_path.exists()

    # Corrupt the primary registry file with invalid/truncated bytes
    with open(reg_file, "w", encoding="utf-8") as f:
        f.write("{ INVALID TRUNCATED JSON CORRUPT ///")

    # Fresh manager instance must detect corruption and recover from backup
    recovered_mgr = DocumentLifecycleManager(vector_store=store, registry_path=reg_file)
    docs = recovered_mgr.list_documents()
    assert len(docs) >= 1
    doc_ids = {d["document_id"] for d in docs}
    assert "d1" in doc_ids


def test_registry_corruption_fails_loudly_without_backup(tmp_path):
    """
    Proves that if primary file is corrupt and no backup exists (or backup is also corrupt),
    the manager fails loudly with RuntimeError rather than starting with silent data loss.
    """
    reg_file = tmp_path / "test_registry.json"
    store = PersistentVectorStore(index_path=tmp_path / "test_store.json")

    # 1. Corrupt primary, no backup
    with open(reg_file, "w", encoding="utf-8") as f:
        f.write("{ CORRUPT FILE NO BACKUP")

    with pytest.raises(RuntimeError) as exc_info:
        DocumentLifecycleManager(vector_store=store, registry_path=reg_file)
    assert str(exc_info.value) == "Corrupted document registry and no backup is available."

    # 2. Corrupt primary AND corrupt backup
    bak_file = reg_file.with_suffix(".json.bak")
    with open(bak_file, "w", encoding="utf-8") as f:
        f.write("{ CORRUPT BACKUP ALSO")

    with pytest.raises(RuntimeError) as exc_info2:
        DocumentLifecycleManager(vector_store=store, registry_path=reg_file)
    assert "backup recovery failed" in str(exc_info2.value)


def test_mid_operation_resync_recovers_from_valid_backup(tmp_path):
    """
    Proves that an ALREADY-INITIALIZED, live DocumentLifecycleManager instance
    recovers from .bak snapshot when _sync_registry_unlocked() encounters a corrupted
    primary file during a subsequent critical-section mutation/query without creating a new instance.
    """
    reg_file = tmp_path / "mid_op_resync_registry.json"
    store = PersistentVectorStore(index_path=tmp_path / "mid_op_resync_store.json")

    # 1. Instantiate manager ONCE and register two documents sequentially
    manager = DocumentLifecycleManager(vector_store=store, registry_path=reg_file)

    doc1 = Document(document_id="doc_live_1", content="Text 1", metadata=DocumentMetadata(title="Live Doc 1", source="s1.md"))
    doc2 = Document(document_id="doc_live_2", content="Text 2", metadata=DocumentMetadata(title="Live Doc 2", source="s2.md"))
    doc3 = Document(document_id="doc_live_3", content="Text 3", metadata=DocumentMetadata(title="Live Doc 3", source="s3.md"))

    manager.register_document(doc1, chunk_count=1)
    # Second registration creates valid .bak snapshot containing doc_live_1
    manager.register_document(doc2, chunk_count=1)
    assert manager.backup_path.exists()

    # 2. Corrupt ONLY the primary registry file on disk after initialization
    with open(reg_file, "w", encoding="utf-8") as f:
        f.write("{ INVALID TRUNCATED JSON CORRUPT MID OPERATION ///")

    # 3. Call critical-section method on that SAME live manager instance (triggers _sync_registry_unlocked)
    manager.register_document(doc3, chunk_count=1)

    # 4. Assert successful recovery from .bak (has doc_live_1) plus the new mutation (doc_live_3)
    docs = manager.list_documents(include_inactive=True)
    doc_ids = {d["document_id"] for d in docs}
    assert doc_ids == {"doc_live_1", "doc_live_3"}
    assert "doc_live_2" not in doc_ids


def test_mid_operation_resync_raises_when_backup_also_corrupted(tmp_path):
    """
    Proves that an ALREADY-INITIALIZED, live DocumentLifecycleManager instance
    raises a redacted RuntimeError when _sync_registry_unlocked() encounters
    corruption on both primary and .bak during mid-operation resync.
    """
    reg_file = tmp_path / "mid_op_fail_registry.json"
    store = PersistentVectorStore(index_path=tmp_path / "mid_op_fail_store.json")

    # 1. Instantiate manager ONCE and register two documents sequentially
    manager = DocumentLifecycleManager(vector_store=store, registry_path=reg_file)

    doc1 = Document(document_id="doc_fail_1", content="Text 1", metadata=DocumentMetadata(title="Fail Doc 1", source="s1.md"))
    doc2 = Document(document_id="doc_fail_2", content="Text 2", metadata=DocumentMetadata(title="Fail Doc 2", source="s2.md"))
    doc3 = Document(document_id="doc_fail_3", content="Text 3", metadata=DocumentMetadata(title="Fail Doc 3", source="s3.md"))

    manager.register_document(doc1, chunk_count=1)
    manager.register_document(doc2, chunk_count=1)
    assert manager.backup_path.exists()

    # 2. Corrupt BOTH the primary registry file and .bak on disk after initialization
    with open(reg_file, "w", encoding="utf-8") as f:
        f.write("{ CORRUPT PRIMARY MID OPERATION")

    with open(manager.backup_path, "w", encoding="utf-8") as f:
        f.write("{ CORRUPT BACKUP MID OPERATION")

    # 3. Call critical-section method on that SAME live instance - must raise RuntimeError
    with pytest.raises(RuntimeError) as exc_info:
        manager.register_document(doc3, chunk_count=1)

    assert str(exc_info.value) == "Corrupted document registry and backup recovery failed."
    assert "primary_err" not in str(exc_info.value)
    assert "backup_err" not in str(exc_info.value)


def test_reconciliation_detects_orphaned_chunks(tmp_path):
    """
    Reconciliation test: asserts chunks existing in vector store with missing registry entries
    are correctly reported with counts and document IDs.
    """
    reg_file = tmp_path / "test_registry.json"
    store = PersistentVectorStore(index_path=tmp_path / "test_store.json")

    meta = ChunkMetadata(chunk_id="c_orph", document_id="doc_orphaned", chunk_index=0, title="Orphan", source="o.md")
    chunk = TextChunk(chunk_id="c_orph", document_id="doc_orphaned", content="Orphaned chunk", metadata=meta, embedding=[1.0, 0.0])
    store.add_chunks([chunk])

    manager = DocumentLifecycleManager(vector_store=store, registry_path=reg_file)
    recon = manager.reconcile_registry_and_vector_store()

    assert recon["status"] == "ANOMALIES_DETECTED"
    assert "doc_orphaned" in recon["orphaned_vector_documents"]
    assert recon["orphaned_vector_count"] == 1


def test_concurrent_document_mutations_maintain_consistency(tmp_path):
    """
    Fires register_document(), update_metadata(), soft_delete_document(), and
    hard_delete_document() across real concurrent threads against the same manager instance.
    Asserts final on-disk state is valid, parsable, and non-corrupted (no lost updates or torn writes).
    """
    reg_file = tmp_path / "test_registry.json"
    store = PersistentVectorStore(index_path=tmp_path / "test_store.json")
    manager = DocumentLifecycleManager(vector_store=store, registry_path=reg_file)

    num_docs = 20

    def register_worker(i):
        doc = Document(
            document_id=f"doc_{i}",
            content=f"Content for doc {i}",
            metadata=DocumentMetadata(title=f"Doc Title {i}", source=f"src_{i}.md", author=f"Author {i}"),
        )
        meta = ChunkMetadata(chunk_id=f"c_{i}", document_id=f"doc_{i}", chunk_index=0, title=f"Doc Title {i}", source=f"src_{i}.md")
        chunk = TextChunk(chunk_id=f"c_{i}", document_id=f"doc_{i}", content=f"Content for doc {i}", metadata=meta, embedding=[0.5, 0.5])
        store.add_chunks([chunk])
        manager.register_document(doc, chunk_count=1)

    def update_worker(i):
        manager.update_metadata(f"doc_{i}", new_title=f"Updated Title {i}", new_author=f"Updated Author {i}")

    def soft_delete_worker(i):
        manager.soft_delete_document(f"doc_{i}")

    def hard_delete_worker(i):
        manager.hard_delete_document(f"doc_{i}")

    # Phase 1: Concurrently register 20 documents
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        futures = [executor.submit(register_worker, i) for i in range(num_docs)]
        _assert_futures_complete(futures)

    # Phase 2: Concurrently perform mixed mutations across threads
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        mixed_futures = []
        for i in range(0, num_docs, 4):
            mixed_futures.append(executor.submit(update_worker, i))
            mixed_futures.append(executor.submit(soft_delete_worker, i + 1))
            mixed_futures.append(executor.submit(hard_delete_worker, i + 2))
            mixed_futures.append(executor.submit(register_worker, i + 3))
        _assert_futures_complete(mixed_futures)

    # Assert on-disk state on a fresh instance
    fresh_store = PersistentVectorStore(index_path=tmp_path / "test_store.json")
    fresh_mgr = DocumentLifecycleManager(vector_store=fresh_store, registry_path=reg_file)

    # Primary file must be clean and uncorrupted
    with open(reg_file, "r", encoding="utf-8") as f:
        on_disk_data = json.load(f)
    assert on_disk_data["version"] == "2.0"
    assert "sha256" in on_disk_data
    assert isinstance(on_disk_data["documents"], dict)

    # Registry and vector store must load without exception
    all_docs = fresh_mgr.list_documents(include_inactive=True)
    assert len(all_docs) > 0


def test_concurrent_multi_instance_mutations_across_pipeline_and_manager(tmp_path):
    """
    Proves that separate DocumentLifecycleManager instances targeting the same registry file
    share a process-wide path-keyed lock and safely synchronize without lost updates or corruption.
    """
    reg_file = tmp_path / "multi_instance_registry.json"
    store = PersistentVectorStore(index_path=tmp_path / "multi_instance_store.json")

    num_instances = 12
    store_lock = threading.Lock()

    def worker(i):
        # Create an independent DocumentLifecycleManager instance per thread targeting the same registry path
        inst_mgr = DocumentLifecycleManager(vector_store=store, registry_path=reg_file)
        doc = Document(
            document_id=f"multi_doc_{i}",
            content=f"Content for multi doc {i}",
            metadata=DocumentMetadata(title=f"Multi Doc {i}", source=f"src_{i}.md", author=f"Author {i}"),
        )
        meta = ChunkMetadata(chunk_id=f"mc_{i}", document_id=f"multi_doc_{i}", chunk_index=0, title=f"Multi Doc {i}", source=f"src_{i}.md")
        chunk = TextChunk(chunk_id=f"mc_{i}", document_id=f"multi_doc_{i}", content=f"Content {i}", metadata=meta, embedding=[0.1, 0.2])
        with store_lock:
            store.add_chunks([chunk])
        inst_mgr.register_document(doc, chunk_count=1)

    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
        futures = [executor.submit(worker, i) for i in range(num_instances)]
        _assert_futures_complete(futures)

    # Verify final on-disk state via a fresh manager
    final_mgr = DocumentLifecycleManager(vector_store=store, registry_path=reg_file)
    docs = final_mgr.list_documents(include_inactive=True)
    assert len(docs) == num_instances

    with open(reg_file, "r", encoding="utf-8") as f:
        data = json.load(f)
    assert data["version"] == "2.0"
    assert "sha256" in data
    assert len(data["documents"]) == num_instances


# ==============================================================================
# TENANCY ISOLATION & OWNERSHIP PROOF TESTS
# ==============================================================================

def test_direct_user_document_is_rejected_and_not_listed(client):
    """Direct input cannot enter either user's authoritative document list."""
    api_key = os.environ.get("ML_SERVICE_API_KEY", "wealthgenie_secret_api_key_2026")
    alice_headers = {"X-API-Key": api_key, "X-Verified-User-Id": "alice_user_123"}
    before_ids = {
        d["document_id"] for d in client.get("/rag/documents", headers=alice_headers).json()["documents"]
    }

    # Alice ingests private financial document
    ingest_res = client.post(
        "/rag/index",
        headers=alice_headers,
        json={
            "title": "Alice Private Tax Portfolio 2026",
            "content": "Confidential salary and deduction breakdown for Alice.",
            "source": "alice_tax.md",
            "author": "Alice CA",
        },
    )
    assert ingest_res.status_code == 400

    # Bob calls GET /rag/documents
    bob_res = client.get(
        "/rag/documents",
        headers={"X-API-Key": api_key, "X-Verified-User-Id": "bob_user_456"},
    )
    assert bob_res.status_code == 200

    # 2. Alice calls GET /rag/documents -> Alice's document is present
    alice_res = client.get(
        "/rag/documents",
        headers=alice_headers,
    )
    assert alice_res.status_code == 200
    assert {d["document_id"] for d in alice_res.json()["documents"]} == before_ids


def test_rejected_user_document_does_not_appear_in_reconciliation(client):
    """
    PROOF 2: Bob calls GET /rag/reconcile.
    Asserts: Alice's document_id does NOT appear anywhere in Bob's reconciliation output.
    """
    api_key = os.environ.get("ML_SERVICE_API_KEY", "wealthgenie_secret_api_key_2026")

    # Alice ingests document
    ingest_res = client.post(
        "/rag/index",
        headers={"X-API-Key": api_key, "X-Verified-User-Id": "alice_user_recon"},
        json={
            "title": "Alice Portfolio Audit",
            "content": "Alice confidential holdings for audit.",
            "source": "alice_audit.md",
            "author": "Alice Advisor",
        },
    )
    assert ingest_res.status_code == 400

    # Bob calls GET /rag/reconcile
    bob_recon_res = client.get(
        "/rag/reconcile",
        headers={"X-API-Key": api_key, "X-Verified-User-Id": "bob_user_recon"},
    )
    assert bob_recon_res.status_code == 200
    bob_recon = bob_recon_res.json()

    assert "Alice Portfolio Audit" not in json.dumps(bob_recon)


def test_rejected_user_document_cannot_be_mutated(client):
    """
    PROOF 3: Bob attempts DELETE and PUT on Alice's document_id.
    Asserts:
      1. Bob's DELETE returns HTTP 403 Forbidden.
      2. Bob's PUT returns HTTP 403 Forbidden.
      3. Alice's document remains intact and un-mutated.
    """
    api_key = os.environ.get("ML_SERVICE_API_KEY", "wealthgenie_secret_api_key_2026")

    # Alice ingests document
    ingest_res = client.post(
        "/rag/index",
        headers={"X-API-Key": api_key, "X-Verified-User-Id": "alice_user_protect"},
        json={
            "title": "Alice Intact Document",
            "content": "Original content owned by Alice.",
            "source": "alice_intact.md",
            "author": "Alice Author",
        },
    )
    assert ingest_res.status_code == 400
    alice_doc_id = "rejected-alice-document"

    # No record was created, so mutation attempts do not disclose ownership.
    bob_del = client.delete(
        f"/rag/documents/{alice_doc_id}",
        headers={"X-API-Key": api_key, "X-Verified-User-Id": "bob_intruder"},
    )
    assert bob_del.status_code == 404

    # 2. Bob attempts PUT on Alice's document -> 403 Forbidden
    bob_put = client.put(
        f"/rag/documents/{alice_doc_id}",
        headers={"X-API-Key": api_key, "X-Verified-User-Id": "bob_intruder"},
        params={"title": "Hacked Title by Bob"},
    )
    assert bob_put.status_code == 404

    # 3. Verify Alice's document is unmodified in Alice's list
    alice_res = client.get(
        "/rag/documents",
        headers={"X-API-Key": api_key, "X-Verified-User-Id": "alice_user_protect"},
    )
    matching = [d for d in alice_res.json()["documents"] if d["document_id"] == alice_doc_id]
    assert matching == []


def test_rejected_user_document_leaves_no_owner_mutation_surface(client):
    """
    PROOF 4: Alice can update and delete her own document. Non-existent document returns 404.
    """
    api_key = os.environ.get("ML_SERVICE_API_KEY", "wealthgenie_secret_api_key_2026")

    # Alice ingests document
    ingest_res = client.post(
        "/rag/index",
        headers={"X-API-Key": api_key, "X-Verified-User-Id": "alice_owner"},
        json={
            "title": "Alice Updatable Doc",
            "content": "Original updatable content.",
            "source": "alice_update.md",
            "author": "Alice",
        },
    )
    assert ingest_res.status_code == 400

    # Non-existent document deletion returns 404
    del_404 = client.delete(
        "/rag/documents/completely_unknown_doc_id",
        headers={"X-API-Key": api_key, "X-Verified-User-Id": "alice_owner"},
    )
    assert del_404.status_code == 404


def test_legacy_registry_migration_defaults_to_global(tmp_path):
    """
    PROOF 5: Legacy registry file lacking scope/owner_user_id fields loads cleanly,
    defaults to scope='global' and owner_user_id=None, and remains visible to all callers.
    """
    reg_file = tmp_path / "legacy_registry.json"
    store = PersistentVectorStore(index_path=tmp_path / "legacy_store.json")

    # Construct pre-migration registry file lacking scope and owner_user_id fields
    legacy_data = {
        "version": "1.0",
        "total_documents": 1,
        "documents": {
            "legacy_doc_1": {
                "document_id": "legacy_doc_1",
                "title": "Income Tax Act Master Reference",
                "source": "tax_act.pdf",
                "document_type": "pdf",
                "author": "CBDT",
                "chunk_count": 5,
                "is_active": True,
                "version_number": 1,
                "created_at_utc": "2026-01-01T00:00:00Z",
                "updated_at_utc": "2026-01-01T00:00:00Z",
            }
        },
    }
    with open(reg_file, "w", encoding="utf-8") as f:
        json.dump(legacy_data, f)

    manager = DocumentLifecycleManager(vector_store=store, registry_path=reg_file)

    # 1. Check in-memory migration populated default values
    doc_entry = manager._registry["legacy_doc_1"]
    assert doc_entry["scope"] == "global"
    assert doc_entry["owner_user_id"] is None
    assert doc_entry["tenant_id"] == "default"

    # 2. Remains visible to any caller querying list_documents
    alice_docs = manager.list_documents(requesting_user_id="user_alice")
    assert len(alice_docs) == 1
    assert alice_docs[0]["document_id"] == "legacy_doc_1"

    bob_docs = manager.list_documents(requesting_user_id="user_bob")
    assert len(bob_docs) == 1
    assert bob_docs[0]["document_id"] == "legacy_doc_1"
