"""
WealthGenie RAG Subsystem - Hardened FastAPI Router
Exposes enterprise RAG endpoints with rate-limiting, error handling, security headers, and document lifecycle control.
"""

import logging
import os
import threading
import time
from datetime import date
from pathlib import Path
from collections import OrderedDict
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from rag.config import RAGConfig
from rag.chunking.fixed_chunker import FixedSizeChunker
from rag.corpus_manifest import MANIFEST_FILENAME, current_documents, load_corpus_manifest
from rag.embeddings.identity import EmbeddingIdentityError, normalize_embedding_identity
from rag.ingestion.pipeline import IngestionPipeline, UntrustedSourceError
from rag.embeddings.dense_embedding import get_embedding_provider
from rag.lifecycle.errors import DocumentOwnershipError
from rag.lifecycle.manager import DocumentLifecycleManager
from rag.retrieval.pipeline import RAGPipeline
from rag.schema import RAGQueryRequest, RAGQueryResponse
from security import verify_api_key, verify_verified_user_id
from store_factory import get_vector_store

logger = logging.getLogger("wealthgenie.rag.router")

rag_router = APIRouter(prefix="/rag", tags=["Retrieval-Augmented Generation"], dependencies=[Depends(verify_api_key)])

# Instantiate RAG Subsystem instances with shared singleton lifecycle_manager
rag_config = RAGConfig.from_env()
vector_store = get_vector_store()
lifecycle_manager = DocumentLifecycleManager(vector_store=vector_store)
ingestion_pipeline = IngestionPipeline(
    chunker=FixedSizeChunker(chunk_size=rag_config.chunk_size, chunk_overlap=rag_config.chunk_overlap),
    embedder=get_embedding_provider(rag_config),
    vector_store=vector_store,
    lifecycle_manager=lifecycle_manager,
)
query_pipeline = RAGPipeline(
    embedder=ingestion_pipeline.embedder,
    vector_store=vector_store,
    config=rag_config,
)

# Process-local rate limiting uses verified principals and bounded per-process
# state. The deployment edge remains responsible for limits shared across workers.
_RATE_LIMIT_STORE: OrderedDict[str, List[float]] = OrderedDict()
_PRINCIPAL_RATE_LIMIT_STORE: OrderedDict[str, List[float]] = OrderedDict()
_GLOBAL_RATE_LIMIT_TIMESTAMPS: List[float] = []
_INDEX_RATE_LIMIT_STORE: OrderedDict[str, List[float]] = OrderedDict()
_GLOBAL_INDEX_RATE_LIMIT_TIMESTAMPS: List[float] = []
_RATE_LIMIT_LOCK = threading.Lock()
MAX_REQUESTS_PER_MINUTE = 60
MAX_GLOBAL_REQUESTS_PER_MINUTE = 600
MAX_TRACKED_RATE_LIMIT_BUCKETS = 4096
MAX_INDEX_REQUESTS_PER_MINUTE = 10
MAX_GLOBAL_INDEX_REQUESTS_PER_MINUTE = 100
MAX_INGEST_TEXT_CHARS = 100_000


def _recent_bucket(store: OrderedDict, key: str, now: float) -> List[float]:
    timestamps = [timestamp for timestamp in store.get(key, []) if now - timestamp < 60.0]
    if key not in store and len(store) >= MAX_TRACKED_RATE_LIMIT_BUCKETS:
        store.popitem(last=False)
    store[key] = timestamps
    store.move_to_end(key)
    return timestamps


def clear_rate_limit_state() -> None:
    """Clear bounded process-local counters for deterministic tests and shutdown hooks."""
    with _RATE_LIMIT_LOCK:
        _RATE_LIMIT_STORE.clear()
        _PRINCIPAL_RATE_LIMIT_STORE.clear()
        _GLOBAL_RATE_LIMIT_TIMESTAMPS.clear()
        _INDEX_RATE_LIMIT_STORE.clear()
        _GLOBAL_INDEX_RATE_LIMIT_TIMESTAMPS.clear()


def check_rate_limit(
    client_ip: str,
    verified_principal: str = "default",
    request_kind: str = "query",
) -> None:
    """Enforce bounded IP/principal/global limits, with a stricter index quota."""
    if request_kind not in {"query", "index"}:
        raise ValueError("Unsupported RAG request kind.")
    now = time.monotonic()
    with _RATE_LIMIT_LOCK:
        global_recent = [timestamp for timestamp in _GLOBAL_RATE_LIMIT_TIMESTAMPS if now - timestamp < 60.0]
        _GLOBAL_RATE_LIMIT_TIMESTAMPS[:] = global_recent
        ip_recent = _recent_bucket(_RATE_LIMIT_STORE, client_ip, now)
        principal_recent = _recent_bucket(_PRINCIPAL_RATE_LIMIT_STORE, verified_principal, now)
        index_recent = None
        global_index_recent = None
        if request_kind == "index":
            global_index_recent = [
                timestamp for timestamp in _GLOBAL_INDEX_RATE_LIMIT_TIMESTAMPS
                if now - timestamp < 60.0
            ]
            _GLOBAL_INDEX_RATE_LIMIT_TIMESTAMPS[:] = global_index_recent
            index_recent = _recent_bucket(_INDEX_RATE_LIMIT_STORE, verified_principal, now)

        if (len(ip_recent) >= MAX_REQUESTS_PER_MINUTE
                or len(principal_recent) >= MAX_REQUESTS_PER_MINUTE
                or len(global_recent) >= MAX_GLOBAL_REQUESTS_PER_MINUTE
                or (index_recent is not None and len(index_recent) >= MAX_INDEX_REQUESTS_PER_MINUTE)
                or (global_index_recent is not None
                    and len(global_index_recent) >= MAX_GLOBAL_INDEX_REQUESTS_PER_MINUTE)):
            logger.warning("RAG request rate limit exceeded.")
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Rate limit exceeded. Try again later.",
            )

        ip_recent.append(now)
        principal_recent.append(now)
        _GLOBAL_RATE_LIMIT_TIMESTAMPS.append(now)
        if index_recent is not None and global_index_recent is not None:
            index_recent.append(now)
            _GLOBAL_INDEX_RATE_LIMIT_TIMESTAMPS.append(now)


def check_prevalidation_ip_rate_limit(client_ip: str, request_kind: str = "query") -> None:
    """Bound unauthenticated parse/validation failures without spending shared quota."""
    if request_kind not in {"query", "index"}:
        raise ValueError("Unsupported RAG request kind.")
    now = time.monotonic()
    with _RATE_LIMIT_LOCK:
        ip_recent = _recent_bucket(_RATE_LIMIT_STORE, client_ip, now)
        limit = min(MAX_REQUESTS_PER_MINUTE, MAX_INDEX_REQUESTS_PER_MINUTE) if request_kind == "index" else MAX_REQUESTS_PER_MINUTE
        if len(ip_recent) >= limit:
            logger.warning("RAG prevalidation IP rate limit exceeded.")
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Rate limit exceeded. Try again later.",
            )
        ip_recent.append(now)



class IngestTextRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(..., min_length=1, max_length=256, description="Document title")
    content: str = Field(..., min_length=10, max_length=MAX_INGEST_TEXT_CHARS, description="Raw text content to ingest")
    source: str = Field("api_input", min_length=1, max_length=512, description="Source identifier")
    author: Optional[str] = Field("Financial Authority", max_length=256, description="Author")
    tenant_id: Optional[str] = Field(None, max_length=128, description="Deprecated/Ignored - Tenant scope derived from verified header")
    scope: Optional[str] = Field(None, max_length=256, description="Deprecated/Ignored - Scope derived from verified header")
    user_id: Optional[str] = Field(None, max_length=128, description="Deprecated/Ignored - User ID derived from verified header")


@rag_router.get("/health")
def rag_health():
    """Health check for RAG subsystem."""
    stats = ingestion_pipeline.vector_store.get_stats()
    return {
        "status": "ok",
        "service": "WealthGenie RAG Platform",
        "chunks_indexed": stats["total_chunks"],
        "documents_indexed": stats["unique_documents"],
    }


def rag_readiness_snapshot() -> dict:
    """Report only checks the current process can actually establish."""
    checks = {
        "corpus_manifest": False,
        "current_documents": False,
        "active_corpus_chunks": False,
        "embedding_provider": False,
        "vector_embedding_identity": False,
        "corpus_generation": False,
        "generation_manifest_current": False,
        "lifecycle_reconciliation": False,
        "shared_production_state": True,
    }
    manifest_hash = None
    active_generation_id = None
    loaded_generation_id = None
    corpus_revision = None
    try:
        corpus_dir = Path(__file__).resolve().parent / "data" / "corpus"
        manifest = load_corpus_manifest(corpus_dir / MANIFEST_FILENAME, corpus_dir)
        manifest_hash = manifest["manifest_sha256"]
        entries = current_documents(manifest, as_of=date.today())
        checks["corpus_manifest"] = True
        checks["current_documents"] = bool(entries)
        expected_keys = {entry["document_key"] for entry in entries}
        active_keys = {
            chunk.metadata.custom_metadata.get("document_key")
            for chunk in ingestion_pipeline.vector_store.get_chunks()
            if chunk.lifecycle_state == "ACTIVE"
            and chunk.metadata.custom_metadata.get("corpus_manifest_sha256") == manifest_hash
            and chunk.metadata.source_trust_tier == "government_official"
        }
        checks["active_corpus_chunks"] = bool(expected_keys) and expected_keys.issubset(active_keys)
        store = ingestion_pipeline.vector_store
        get_snapshot = getattr(store, "get_generation_snapshot", None)
        get_active = getattr(store, "get_active_generation", None)
        if callable(get_snapshot) and callable(get_active):
            snapshot = get_snapshot()
            generation = get_active()
            active_generation_id = generation.get("generation_id") if generation else None
            loaded_generation_id = getattr(store, "get_loaded_generation_id", lambda: None)()
            corpus_revision = snapshot.get("revision")
            checks["corpus_generation"] = bool(
                generation
                and snapshot.get("generation_id") == generation.get("generation_id")
                and loaded_generation_id == generation.get("generation_id")
            )
            checks["generation_manifest_current"] = bool(
                generation and generation.get("manifest_sha256") == manifest_hash
            )
            lifecycle_store = getattr(store, "lifecycle_store", None)
            reconcile = getattr(lifecycle_store, "reconcile", None)
            checks["lifecycle_reconciliation"] = bool(
                callable(reconcile) and reconcile().get("status") == "CLEAN"
            )
        elif os.environ.get("ENVIRONMENT", "local").strip().lower() in {"production", "prod"}:
            checks["corpus_generation"] = False
            checks["generation_manifest_current"] = False
            checks["lifecycle_reconciliation"] = False
        else:
            # Local memory/file stores do not use the Mongo generation pointer.
            checks["corpus_generation"] = True
            checks["generation_manifest_current"] = True
            checks["lifecycle_reconciliation"] = True
    except Exception:
        checks["corpus_manifest"] = False

    identity = getattr(ingestion_pipeline.embedder, "embedding_identity", {})
    is_ready = getattr(ingestion_pipeline.embedder, "is_ready", True)
    if callable(is_ready):
        is_ready = is_ready()
    checks["embedding_provider"] = bool(
        is_ready
        and identity.get("provider") not in {None, "unavailable"}
        and identity.get("model_id")
        and identity.get("model_revision")
        and identity.get("dimension") == ingestion_pipeline.embedder.embedding_dimension
        and identity.get("config_hash")
    )
    try:
        vector_identity = normalize_embedding_identity(
            ingestion_pipeline.vector_store.get_stats().get("embedding_identity")
        )
        checks["vector_embedding_identity"] = (
            vector_identity == normalize_embedding_identity(identity)
        )
    except (EmbeddingIdentityError, TypeError, ValueError):
        checks["vector_embedding_identity"] = False

    environment = os.environ.get("ENVIRONMENT", "local").strip().lower()
    if environment in {"production", "prod"}:
        vector_is_shared = type(ingestion_pipeline.vector_store).__name__ == "MongoVectorStore"
        lifecycle_is_shared = bool(getattr(lifecycle_manager, "is_shared", False))
        checks["shared_production_state"] = vector_is_shared and lifecycle_is_shared
        checks["embedding_provider"] = checks["embedding_provider"] and identity.get("provider") == "sentence_transformers"

    ready = all(checks.values())
    return {
        "status": "READY" if ready else "NOT_READY",
        "manifest_sha256": manifest_hash,
        "active_generation_id": active_generation_id,
        "loaded_generation_id": loaded_generation_id,
        "corpus_revision": corpus_revision,
        "embedding_identity": identity,
        "checks": checks,
    }


@rag_router.get("/readyz")
def rag_readyz():
    snapshot = rag_readiness_snapshot()
    return JSONResponse(status_code=200 if snapshot["status"] == "READY" else 503, content=snapshot)


@rag_router.get("/status")
def rag_status():
    """Returns vector store index metrics and embedding parameters."""
    stats = ingestion_pipeline.vector_store.get_stats()
    return {
        "vector_store_stats": stats,
        "embedding_provider": rag_config.embedding_provider,
        "embedding_dimension": rag_config.embedding_dim,
        "chunk_size": rag_config.chunk_size,
        "chunk_overlap": rag_config.chunk_overlap,
        "retrieval_strategy": rag_config.retrieval_strategy,
        "reranker_strategy": rag_config.reranker_strategy,
    }


@rag_router.post("/query", response_model=RAGQueryResponse)
def query_rag(
    request: RAGQueryRequest,
    req: Request,
    verified_user_id: str = Depends(verify_verified_user_id),
):
    """
    Executes grounded RAG query search over authoritative knowledge base.
    Scoped strictly to the verified_user_id extracted from X-Verified-User-Id header.
    Any user_id or tenant_id provided in the request body is strictly ignored.
    """
    client_ip = req.client.host if req.client else "127.0.0.1"
    check_rate_limit(client_ip, verified_user_id)

    # SECURITY: Overwrite any client-supplied identity with verified header identity
    request.user_id = verified_user_id
    request.scope = f"user:{verified_user_id}"
    request.tenant_id = "default"

    try:
        return query_pipeline.query(request)
    except Exception as e:
        correlation_id = getattr(req.state, "correlation_id", "unavailable")
        logger.error(
            "RAG query execution failed (error_type=%s correlation_id=%s)",
            type(e).__name__,
            correlation_id,
        )
        raise HTTPException(
            status_code=500,
            detail="RAG query could not be completed. Please try again later.",
        ) from None


@rag_router.post("/index")
def index_document(
    request: IngestTextRequest,
    req: Request,
    verified_user_id: str = Depends(verify_verified_user_id),
):
    """
    Ingests text document into vector store index incrementally.
    Scoped strictly to the verified_user_id extracted from X-Verified-User-Id header.
    Any user_id or tenant_id provided in the request body is strictly ignored.
    """
    client_ip = req.client.host if req.client else "127.0.0.1"
    check_rate_limit(client_ip, verified_user_id, request_kind="index")

    try:
        # Direct user content is deliberately unverified. Claimed source/author fields
        # cannot elevate it into the authoritative regulatory corpus.
        res = ingestion_pipeline.ingest_text(
            text=request.content,
            title=request.title,
            source=f"user_supplied:{verified_user_id}",
            author=None,
            source_trust_tier="unverified_user_input",
            tenant_id="default",
            user_id=verified_user_id,
            scope=f"user:{verified_user_id}",
        )
        # Sync the router's lifecycle_manager with disk state written by the pipeline's
        # ephemeral DocumentLifecycleManager during ingest_document().
        lifecycle_manager.load_registry()
        return {"status": "success", "ingestion_result": res}
    except UntrustedSourceError:
        correlation_id = getattr(req.state, "correlation_id", "unavailable")
        logger.warning("Rejected untrusted direct RAG ingestion (correlation_id=%s)", correlation_id)
        raise HTTPException(status_code=400, detail="Direct user content is not accepted as authoritative advisory evidence.")
    except Exception as e:
        correlation_id = getattr(req.state, "correlation_id", "unavailable")
        logger.error(
            "Document ingestion failed (error_type=%s correlation_id=%s)",
            type(e).__name__,
            correlation_id,
        )
        raise HTTPException(
            status_code=500,
            detail="Document ingestion could not be completed. Please try again later.",
        ) from None


@rag_router.get("/documents")
def list_documents(
    request: Request,
    include_inactive: bool = False,
    verified_user_id: str = Depends(verify_verified_user_id),
):
    """Lists registered documents accessible to the verified user (global + user:{verified_user_id})."""
    try:
        return {"documents": lifecycle_manager.list_documents(
            include_inactive=include_inactive,
            requesting_user_id=verified_user_id,
        )}
    except Exception as exc:
        correlation_id = getattr(request.state, "correlation_id", "unavailable")
        logger.error(
            "Document listing failed (error_type=%s correlation_id=%s)",
            type(exc).__name__,
            correlation_id,
        )
        raise HTTPException(
            status_code=500,
            detail="Document listing could not be completed. Please try again later.",
        ) from None


@rag_router.delete("/documents/{doc_id}")
def delete_document(
    doc_id: str,
    request: Request,
    hard_delete: bool = True,
    verified_user_id: str = Depends(verify_verified_user_id),
):
    """Deletes or soft-deletes a document and purges vector index chunks with caller ownership enforcement."""
    try:
        if hard_delete:
            success = lifecycle_manager.hard_delete_document(doc_id, requesting_user_id=verified_user_id)
        else:
            success = lifecycle_manager.soft_delete_document(doc_id, requesting_user_id=verified_user_id)

        if not success:
            raise HTTPException(status_code=404, detail=f"Document '{doc_id}' not found.")
        return {"status": "success", "message": f"Document '{doc_id}' deleted successfully."}
    except HTTPException:
        raise
    except DocumentOwnershipError:
        raise HTTPException(status_code=403, detail="You are not authorized to modify this document.") from None
    except Exception as exc:
        correlation_id = getattr(request.state, "correlation_id", "unavailable")
        logger.error(
            "Document deletion failed (error_type=%s correlation_id=%s)",
            type(exc).__name__,
            correlation_id,
        )
        raise HTTPException(
            status_code=500,
            detail="Document deletion could not be completed. Please try again later.",
        ) from None


@rag_router.put("/documents/{doc_id}")
def update_document(
    doc_id: str,
    request: Request,
    title: Optional[str] = None,
    author: Optional[str] = None,
    verified_user_id: str = Depends(verify_verified_user_id),
):
    """Updates metadata across document registry and vector store chunks with caller ownership enforcement."""
    try:
        success = lifecycle_manager.update_metadata(
            doc_id,
            new_title=title,
            new_author=author,
            requesting_user_id=verified_user_id,
        )
        if not success:
            raise HTTPException(status_code=404, detail=f"Document '{doc_id}' not found.")
        return {"status": "success", "message": f"Metadata updated for document '{doc_id}'."}
    except HTTPException:
        raise
    except DocumentOwnershipError:
        raise HTTPException(status_code=403, detail="You are not authorized to modify this document.") from None
    except Exception as exc:
        correlation_id = getattr(request.state, "correlation_id", "unavailable")
        logger.error(
            "Document metadata update failed (error_type=%s correlation_id=%s)",
            type(exc).__name__,
            correlation_id,
        )
        raise HTTPException(
            status_code=500,
            detail="Document metadata could not be updated. Please try again later.",
        ) from None


@rag_router.get("/reconcile")
def reconcile_documents(
    request: Request,
    verified_user_id: str = Depends(verify_verified_user_id),
):
    """Reconciles document registry entries against vector store chunks within verified user's scope."""
    try:
        return lifecycle_manager.reconcile_registry_and_vector_store(
            requesting_user_id=verified_user_id
        )
    except Exception as exc:
        correlation_id = getattr(request.state, "correlation_id", "unavailable")
        logger.error(
            "Document reconciliation failed (error_type=%s correlation_id=%s)",
            type(exc).__name__,
            correlation_id,
        )
        raise HTTPException(
            status_code=500,
            detail="Document reconciliation could not be completed. Please try again later.",
        ) from None
