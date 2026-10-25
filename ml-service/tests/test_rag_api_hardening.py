"""
WealthGenie RAG Subsystem - API Hardening Test Suite
Tests security headers, sliding window rate limiting, input validation rules, and error payloads.
"""

import os
import json
import logging
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from main import app
from rag.router import (
    MAX_TRACKED_RATE_LIMIT_BUCKETS,
    MAX_INGEST_TEXT_CHARS,
    _GLOBAL_RATE_LIMIT_TIMESTAMPS,
    _RATE_LIMIT_STORE,
    clear_rate_limit_state,
    check_rate_limit,
)
from rag.request_size_limit import RAG_INDEX_MAX_BODY_BYTES

@pytest.fixture
def client():
    clear_rate_limit_state()
    api_key = os.environ.get("ML_SERVICE_API_KEY", "wealthgenie_secret_api_key_2026")
    with TestClient(app, headers={"X-API-Key": api_key, "X-Verified-User-Id": "test-user-id"}) as c:
        yield c
    clear_rate_limit_state()


def test_api_security_headers(client):
    response = client.get("/rag/health")
    assert response.status_code == 200
    assert response.headers.get("X-Content-Type-Options") == "nosniff"
    assert response.headers.get("X-Frame-Options") == "DENY"
    assert response.headers.get("X-XSS-Protection") == "1; mode=block"


def test_short_content_input_validation(client):
    payload = {
        "title": "Short Doc",
        "content": "too short",  # <10 chars
        "source": "api",
    }
    response = client.post("/rag/index", json=payload)
    assert response.status_code == 422  # Unprocessable Entity Pydantic validation


def test_rate_limiting_enforcement(client):
    clear_rate_limit_state()

    # Make 60 rate-limited query requests -> should succeed
    for i in range(60):
        res = client.post("/rag/query", json={"question": f"Test Question {i}"})
        assert res.status_code == 200

    # 61st request from same IP -> Rate limit HTTP 429
    res_overflow = client.post("/rag/query", json={"question": "Overflow question"})
    assert res_overflow.status_code == 429
    assert "Rate limit exceeded" in res_overflow.json()["detail"]

    clear_rate_limit_state()


def test_query_rejects_questions_over_the_documented_bound(client):
    response = client.post("/rag/query", json={"question": "x" * 2001})
    assert response.status_code == 422


def test_authenticated_malformed_and_invalid_schema_requests_consume_rate_quota(client, monkeypatch):
    import rag.router as router

    clear_rate_limit_state()
    monkeypatch.setattr(router, "MAX_REQUESTS_PER_MINUTE", 2)
    malformed_json = client.post(
        "/rag/query", content=b'{"question":', headers={"Content-Type": "application/json"},
    )
    invalid_schema = client.post("/rag/query", json={"question": 42})
    over_quota = client.post(
        "/rag/query", content=b'{"question":', headers={"Content-Type": "application/json"},
    )

    assert malformed_json.status_code == 422
    assert invalid_schema.status_code == 422
    assert over_quota.status_code == 429
    clear_rate_limit_state()


def test_unauthenticated_malformed_requests_consume_only_the_per_ip_quota(monkeypatch):
    import rag.router as router

    clear_rate_limit_state()
    monkeypatch.setenv("ENVIRONMENT", "local")
    monkeypatch.setenv("ML_SERVICE_API_KEY", "required-test-key")
    monkeypatch.setattr(router, "MAX_REQUESTS_PER_MINUTE", 2)
    with TestClient(app) as unauthenticated_client:
        first = unauthenticated_client.post(
            "/rag/query", content=b'{"question":', headers={"Content-Type": "application/json"},
        )
        second = unauthenticated_client.post(
            "/rag/query", content=b'{"question":', headers={"Content-Type": "application/json"},
        )
        third = unauthenticated_client.post(
            "/rag/query", content=b'{"question":', headers={"Content-Type": "application/json"},
        )

    assert first.status_code == 422
    assert second.status_code == 422
    assert third.status_code == 429
    assert len(router._RATE_LIMIT_STORE["testclient"]) == 2
    assert _GLOBAL_RATE_LIMIT_TIMESTAMPS == []
    clear_rate_limit_state()


@pytest.mark.parametrize(
    ("path", "payload", "operation", "public_message"),
    [
        ("/rag/query", {"question": "How does PPF work?"}, "query", "RAG query could not be completed."),
        ("/rag/index", {"title": "Test", "content": "A sufficiently long test document.", "source": "test"}, "index", "Document ingestion could not be completed."),
    ],
)
def test_rag_backend_errors_are_redacted_from_responses_and_logs(
    path, payload, operation, public_message, monkeypatch, caplog,
):
    import rag.router as router_module
    from fastapi import HTTPException
    from starlette.requests import Request

    secret_canary = "PAN-987654321012 redis://user:private-password@internal:6379"

    def fail(*_args, **_kwargs):
        raise RuntimeError(secret_canary)

    if operation == "query":
        monkeypatch.setattr(router_module.query_pipeline, "query", fail)
    else:
        monkeypatch.setattr(router_module.ingestion_pipeline, "ingest_text", fail)

    clear_rate_limit_state()
    request = Request({
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": [],
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
        "state": {"correlation_id": "phase13-rag-error-redaction"},
    })
    caplog.set_level(logging.ERROR)
    with pytest.raises(HTTPException) as error:
        if operation == "query":
            router_module.query_rag(
                router_module.RAGQueryRequest(**payload),
                request,
                "phase13-test-user",
            )
        else:
            router_module.index_document(
                router_module.IngestTextRequest(**payload),
                request,
                "phase13-test-user",
            )

    assert error.value.status_code == 500
    assert public_message in error.value.detail
    assert secret_canary not in error.value.detail
    assert secret_canary not in caplog.text
    assert "error_type=RuntimeError" in caplog.text
    assert "correlation_id=phase13-rag-error-redaction" in caplog.text
    clear_rate_limit_state()


def test_real_rag_pipeline_retrieval_failure_is_abstained_and_redacted(tmp_path, caplog):
    from rag.cache.manager import MultiLevelCacheManager
    from rag.config import RAGConfig
    from rag.retrieval.pipeline import RAGPipeline
    from rag.retrievers.dense_retriever import DenseRetriever
    from rag.schema import RAGQueryRequest

    secret_canary = "PAN-987654321012 redis://user:private-password@internal:6379"
    embedding_identity = {
        "embedding_provider": "test-provider",
        "embedding_model_id": "test-embedding",
        "embedding_model_revision": "test-revision",
        "embedding_dimension": 4,
        "embedding_config_hash": "a" * 64,
    }

    class FixedEmbedder:
        def __init__(self, identity):
            self.embedding_identity = identity

        def embed_text(self, _query):
            return [1.0, 0.0, 0.0, 0.0]

    class ExplodingVectorStore:
        def get_generation_snapshot(self):
            return {
                "generation_id": "test-generation",
                "revision": 1,
                "manifest_sha256": "b" * 64,
                "membership_sha256": "c" * 64,
            }

        def search(self, **_kwargs):
            raise RuntimeError(secret_canary)

    class FixedQueryUnderstanding:
        def process(self, question):
            return {"search_query": question, "intent": "financial"}

    embedder = FixedEmbedder(embedding_identity)
    vector_store = ExplodingVectorStore()
    pipeline = RAGPipeline(
        embedder=embedder,
        vector_store=vector_store,
        retriever=DenseRetriever(embedder=embedder, vector_store=vector_store),
        query_understanding=FixedQueryUnderstanding(),
        cache_manager=MultiLevelCacheManager(cache_dir=tmp_path / "rag-cache"),
        config=RAGConfig(retrieval_strategy="dense"),
    )

    caplog.set_level(logging.ERROR, logger="wealthgenie.rag.retrieval")
    response = pipeline.query(RAGQueryRequest(question="When do the Income-tax Rules 2026 take effect?"))

    assert response.metrics["abstention_reason"] == "retrieval_unavailable"
    assert secret_canary not in caplog.text
    assert "RAG retrieval unavailable" in caplog.text
    assert any(getattr(record, "error_type", None) == "RuntimeError" for record in caplog.records)


def test_vector_store_faiss_fallback_redacts_backend_exception(tmp_path, monkeypatch, caplog):
    from rag.embeddings.dense_embedding import DenseVectorEmbeddingProvider
    from rag.chunking.fixed_chunker import FixedSizeChunker
    from rag.ingestion.loaders import DocumentLoader
    from rag.vector_store import memory_vector_store
    from rag.vector_store.memory_vector_store import PersistentVectorStore

    secret_canary = "PAN-987654321012 redis://user:private-password@internal:6379"
    embedder = DenseVectorEmbeddingProvider(dimension=16, enable_cache=False)
    store = PersistentVectorStore(index_path=tmp_path / "faiss-fallback.json", force_numpy=False)
    document = DocumentLoader().load_text(
        "Income tax rules describe the section 80C deduction for eligible investments.",
        title="Tax rules",
    )
    chunk = FixedSizeChunker(chunk_size=256, chunk_overlap=0).chunk_document(document)[0]
    chunk.embedding = embedder.embed_text(chunk.content)
    chunk.embedding_identity = embedder.embedding_identity
    store._chunks = [chunk]
    store._embeddings = [chunk.embedding]
    store._faiss_dirty = True

    monkeypatch.setattr(memory_vector_store, "FAISS_AVAILABLE", True)
    monkeypatch.setattr(
        store,
        "_search_faiss",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError(secret_canary)),
    )
    caplog.set_level(logging.WARNING, logger="wealthgenie.rag.vector_store")

    results = store.search(
        query_vector=embedder.embed_text("section 80C income tax"),
        top_k=1,
        threshold=0.0,
        embedding_identity=embedder.embedding_identity,
    )

    assert len(results) == 1
    assert secret_canary not in caplog.text
    assert "FAISS search failed, falling back to NumPy search" in caplog.text
    assert any(getattr(record, "error_type", None) == "RuntimeError" for record in caplog.records)


@pytest.mark.parametrize(
    ("operation", "public_message"),
    [
        ("list", "Document listing could not be completed."),
        ("delete", "Document deletion could not be completed."),
        ("update", "Document metadata could not be updated."),
        ("reconcile", "Document reconciliation could not be completed."),
    ],
)
def test_document_lifecycle_routes_redact_unexpected_backend_errors(operation, public_message, monkeypatch, caplog):
    import rag.router as router_module
    from fastapi import HTTPException
    from starlette.requests import Request

    secret_canary = "PAN-987654321012 redis://user:private-password@internal:6379"
    method_names = {
        "list": "list_documents",
        "delete": "hard_delete_document",
        "update": "update_metadata",
        "reconcile": "reconcile_registry_and_vector_store",
    }

    def fail(*_args, **_kwargs):
        raise RuntimeError(secret_canary)

    monkeypatch.setattr(router_module.lifecycle_manager, method_names[operation], fail)
    request = Request({
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/rag/documents",
        "raw_path": b"/rag/documents",
        "query_string": b"",
        "headers": [],
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
        "state": {"correlation_id": "phase13-lifecycle-error-redaction"},
    })
    caplog.set_level(logging.ERROR, logger="wealthgenie.rag.router")

    with pytest.raises(HTTPException) as error:
        if operation == "list":
            router_module.list_documents(request, verified_user_id="test-user")
        elif operation == "delete":
            router_module.delete_document("doc-id", request, verified_user_id="test-user")
        elif operation == "update":
            router_module.update_document("doc-id", request, verified_user_id="test-user")
        else:
            router_module.reconcile_documents(request, verified_user_id="test-user")

    assert error.value.status_code == 500
    assert public_message in error.value.detail
    assert secret_canary not in error.value.detail
    assert secret_canary not in caplog.text
    assert "error_type=RuntimeError" in caplog.text
    assert "correlation_id=phase13-lifecycle-error-redaction" in caplog.text


@pytest.mark.parametrize("operation", ["delete", "update"])
def test_document_mutation_routes_hide_os_permission_error_details(operation, monkeypatch, caplog):
    import rag.router as router_module
    from fastapi import HTTPException
    from starlette.requests import Request

    secret_canary = "PAN-987654321012 redis://user:private-password@internal:6379"
    method_name = "hard_delete_document" if operation == "delete" else "update_metadata"

    def fail(*_args, **_kwargs):
        raise PermissionError(secret_canary)

    monkeypatch.setattr(router_module.lifecycle_manager, method_name, fail)
    request = Request({
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "DELETE" if operation == "delete" else "PUT",
        "scheme": "http",
        "path": "/rag/documents/doc-id",
        "raw_path": b"/rag/documents/doc-id",
        "query_string": b"",
        "headers": [],
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
        "state": {"correlation_id": "phase13-os-permission-redaction"},
    })
    caplog.set_level(logging.ERROR, logger="wealthgenie.rag.router")

    with pytest.raises(HTTPException) as error:
        if operation == "delete":
            router_module.delete_document("doc-id", request, verified_user_id="test-user")
        else:
            router_module.update_document("doc-id", request, verified_user_id="test-user")

    assert error.value.status_code == 500
    assert secret_canary not in error.value.detail
    assert secret_canary not in caplog.text
    assert "error_type=PermissionError" in caplog.text


@pytest.mark.parametrize("operation", ["delete", "update"])
def test_document_mutation_routes_return_safe_403_for_ownership_denial(operation, monkeypatch):
    import rag.router as router_module
    from fastapi import HTTPException
    from starlette.requests import Request
    from rag.lifecycle.errors import DocumentOwnershipError

    secret_canary = "PAN-987654321012 redis://user:private-password@internal:6379"
    method_name = "hard_delete_document" if operation == "delete" else "update_metadata"

    def deny(*_args, **_kwargs):
        raise DocumentOwnershipError(secret_canary)

    monkeypatch.setattr(router_module.lifecycle_manager, method_name, deny)
    request = Request({
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "DELETE" if operation == "delete" else "PUT",
        "scheme": "http",
        "path": "/rag/documents/doc-id",
        "raw_path": b"/rag/documents/doc-id",
        "query_string": b"",
        "headers": [],
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
        "state": {},
    })

    with pytest.raises(HTTPException) as error:
        if operation == "delete":
            router_module.delete_document("doc-id", request, verified_user_id="test-user")
        else:
            router_module.update_document("doc-id", request, verified_user_id="test-user")

    assert error.value.status_code == 403
    assert error.value.detail == "You are not authorized to modify this document."
    assert secret_canary not in error.value.detail


def test_unauthenticated_oversized_requests_do_not_consume_shared_quotas(monkeypatch):
    import rag.router as router

    clear_rate_limit_state()
    monkeypatch.setenv("ENVIRONMENT", "local")
    monkeypatch.setenv("ML_SERVICE_API_KEY", "required-test-key")
    monkeypatch.setattr(router, "MAX_REQUESTS_PER_MINUTE", 1)
    payload = b"x" * (RAG_INDEX_MAX_BODY_BYTES + 1)
    with TestClient(app) as unauthenticated_client:
        first = unauthenticated_client.post("/rag/index", content=payload)
        second = unauthenticated_client.post("/rag/index", content=payload)

    assert first.status_code == 413
    assert second.status_code == 429
    assert len(router._RATE_LIMIT_STORE["testclient"]) == 1
    assert _GLOBAL_RATE_LIMIT_TIMESTAMPS == []
    clear_rate_limit_state()


def test_rate_limit_binds_verified_principal_across_client_ips(monkeypatch):
    import rag.router as router

    clear_rate_limit_state()
    monkeypatch.setattr(router, "MAX_REQUESTS_PER_MINUTE", 2)
    check_rate_limit("192.0.2.1", "verified-user")
    check_rate_limit("198.51.100.2", "verified-user")
    with pytest.raises(HTTPException) as exc_info:
        check_rate_limit("203.0.113.3", "verified-user")
    assert exc_info.value.status_code == 429
    clear_rate_limit_state()


def test_global_rate_limit_applies_across_distinct_ips_and_principals(monkeypatch):
    import rag.router as router

    clear_rate_limit_state()
    monkeypatch.setattr(router, "MAX_GLOBAL_REQUESTS_PER_MINUTE", 2)
    check_rate_limit("192.0.2.1", "verified-user-1")
    check_rate_limit("198.51.100.2", "verified-user-2")
    with pytest.raises(HTTPException) as exc_info:
        check_rate_limit("203.0.113.3", "verified-user-3")
    assert exc_info.value.status_code == 429
    clear_rate_limit_state()


def test_rate_limit_bucket_storage_stays_bounded(monkeypatch):
    clear_rate_limit_state()
    import rag.router as router
    monkeypatch.setattr(router, "MAX_GLOBAL_REQUESTS_PER_MINUTE", MAX_TRACKED_RATE_LIMIT_BUCKETS + 32)
    for index in range(MAX_TRACKED_RATE_LIMIT_BUCKETS + 32):
        check_rate_limit(f"192.0.2.{index}", f"verified-user-{index}")
    assert len(_RATE_LIMIT_STORE) == MAX_TRACKED_RATE_LIMIT_BUCKETS
    clear_rate_limit_state()



def test_index_rejects_oversized_content_before_ingestion(client):
    response = client.post("/rag/index", json={
        "title": "Oversized document",
        "content": "x" * (MAX_INGEST_TEXT_CHARS + 1),
        "source": "test",
    })
    assert response.status_code == 413


def test_index_rejects_unknown_fields(client):
    response = client.post("/rag/index", json={
        "title": "Valid document",
        "content": "This is enough valid document text.",
        "source": "test",
        "unexpected": "small extra field",
    })
    assert response.status_code == 422


def test_index_body_limit_rejects_oversized_unrecognized_json_before_validation(client):
    payload = json.dumps({
        "title": "Valid document",
        "content": "This is enough valid document text.",
        "source": "test",
        "unexpected": "x" * RAG_INDEX_MAX_BODY_BYTES,
    }).encode("utf-8")
    response = client.post(
        "/rag/index",
        content=payload,
        headers={"Content-Type": "application/json"},
    )
    assert len(payload) > RAG_INDEX_MAX_BODY_BYTES
    assert response.status_code == 413


def test_index_has_a_stricter_verified_principal_rate_limit(monkeypatch):
    import rag.router as router

    clear_rate_limit_state()
    monkeypatch.setattr(router, "MAX_INDEX_REQUESTS_PER_MINUTE", 2)
    check_rate_limit("192.0.2.1", "verified-index-user", request_kind="index")
    check_rate_limit("198.51.100.2", "verified-index-user", request_kind="index")
    with pytest.raises(HTTPException) as exc_info:
        check_rate_limit("203.0.113.3", "verified-index-user", request_kind="index")
    assert exc_info.value.status_code == 429
    clear_rate_limit_state()



def test_index_rejects_oversized_ignored_identity_metadata(client):
    response = client.post("/rag/index", json={
        "title": "Bounded metadata",
        "content": "This text is long enough to pass the minimum length.",
        "source": "test",
        "tenant_id": "x" * 129,
    })
    assert response.status_code == 422


def test_query_rejects_oversized_unused_profile_payload(client):
    response = client.post("/rag/query", json={
        "question": "Explain my profile",
        "user_profile": {"notes": "x" * 16_385},
    })
    assert response.status_code == 422
