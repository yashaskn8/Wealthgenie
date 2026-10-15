"""
WealthGenie RAG Subsystem - Persistent Vector Store Implementation
High-performance Cosine Similarity vector store using FAISS IndexFlatIP with pure-Python/NumPy fallback, atomic writes, checksum verification, backup snapshots, and corruption recovery.
"""

import hashlib
import json
import logging
import os
import shutil
import threading
from functools import wraps
from pathlib import Path
from typing import Dict, List, Any, Optional
import numpy as np

try:
    import faiss
    FAISS_AVAILABLE = True
except ImportError:
    faiss = None
    FAISS_AVAILABLE = False

from rag.config import RAGConfig
from rag.embeddings.identity import EmbeddingIdentityError, normalize_embedding_identity
from rag.schema import TextChunk, RetrievedChunk, is_scope_accessible
from rag.vector_store.base import BaseVectorStore

logger = logging.getLogger("wealthgenie.rag.vector_store")


def _synchronized_store_access(method):
    """Serialize access to one persistent store instance, including atomic saves."""
    @wraps(method)
    def synchronized(self, *args, **kwargs):
        with self._lock:
            return method(self, *args, **kwargs)

    return synchronized


class PersistentVectorStore(BaseVectorStore):
    """
    Hardened vector database supporting FAISS IndexFlatIP vector search with NumPy fallback,
    atomic writes, and corruption recovery.
    """

    VERSION = "2.1"

    def __init__(self, index_path: Optional[Path] = None, force_numpy: bool = False):
        self.index_path = index_path or RAGConfig().vector_store_path
        self.backup_path = self.index_path.with_suffix(".json.bak")
        self._lock = threading.RLock()
        self.force_numpy = force_numpy
        self._chunks: List[TextChunk] = []
        self._embeddings: List[List[float]] = []
        self._stored_embedding_dim: int = 0
        self._faiss_index: Any = None
        self._faiss_dirty: bool = True
        self.load()

    @property
    def is_using_faiss(self) -> bool:
        """Returns True if FAISS is active and available for vector search."""
        return FAISS_AVAILABLE and not self.force_numpy

    @_synchronized_store_access
    def add_chunks(self, chunks: List[TextChunk]) -> int:
        """Adds embedded text chunks to store, avoiding duplicate chunk_ids."""
        incoming = [chunk.embedding for chunk in chunks if chunk.embedding]
        if any(not np.isfinite(np.asarray(vector, dtype=np.float64)).all() for vector in incoming):
            raise ValueError("Cannot persist non-finite embedding values.")
        incoming_dimensions = {len(vector) for vector in incoming}
        current_dimension = len(self._embeddings[0]) if self._embeddings else 0
        if len(incoming_dimensions) > 1 or (
            current_dimension and incoming_dimensions and incoming_dimensions != {current_dimension}
        ):
            raise ValueError("Cannot mix embedding dimensions in a persistent vector-store generation.")
        existing_ids = {c.chunk_id for c in self._chunks}
        added_count = 0

        for chunk in chunks:
            if not chunk.embedding:
                continue
            if chunk.chunk_id in existing_ids:
                # Update existing chunk
                idx = [i for i, c in enumerate(self._chunks) if c.chunk_id == chunk.chunk_id][0]
                self._chunks[idx] = chunk
                self._embeddings[idx] = chunk.embedding
            else:
                self._chunks.append(chunk)
                self._embeddings.append(chunk.embedding)
                existing_ids.add(chunk.chunk_id)
                added_count += 1

        self._faiss_dirty = True
        self.save()
        logger.info(f"Added {added_count} new chunks to PersistentVectorStore. Total: {len(self._chunks)}")
        return added_count

    def _rebuild_faiss_index(self) -> None:
        """Rebuilds the in-memory FAISS IndexFlatIP from normalized embeddings."""
        if not self.is_using_faiss or not self._embeddings:
            self._faiss_index = None
            self._faiss_dirty = False
            return

        dim = len(self._embeddings[0])
        matrix = np.array(self._embeddings, dtype=np.float32)
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        matrix_normed = np.ascontiguousarray(matrix / norms, dtype=np.float32)

        index = faiss.IndexFlatIP(dim)
        index.add(matrix_normed)
        self._faiss_index = index
        self._faiss_dirty = False
        logger.debug(f"Rebuilt FAISS IndexFlatIP ({index.ntotal} vectors, dim={dim})")

    @_synchronized_store_access
    def search(
        self,
        query_vector: List[float],
        top_k: int = 4,
        threshold: float = 0.0,
        tenant_id: str = "default",
        user_id: Optional[str] = None,
        scope: Optional[str] = None,
        embedding_identity: Optional[Dict[str, Any]] = None,
    ) -> List[RetrievedChunk]:
        """
        Executes tenant/scope-isolated similarity search using FAISS or NumPy fallback.
        Filters chunks to scope=='global' OR scope=='user:{requesting_user_id}',
        never returning another user's scoped content.
        """
        if not self._chunks or not self._embeddings:
            return []

        # Filter indices by scope & tenant_id
        valid_indices = [
            i for i, c in enumerate(self._chunks)
            if c.lifecycle_state == "ACTIVE" and is_scope_accessible(
                chunk_scope=getattr(c, "scope", getattr(c.metadata, "scope", "global")),
                chunk_tenant_id=getattr(c, "tenant_id", getattr(c.metadata, "tenant_id", "default")),
                requesting_scope=scope,
                requesting_user_id=user_id,
                tenant_id=tenant_id,
            )
        ]
        if not valid_indices:
            return []

        q_vec = np.array(query_vector, dtype=np.float32)
        if q_vec.ndim != 1 or not np.isfinite(q_vec).all():
            raise ValueError("Query embedding must be a finite one-dimensional vector.")

        # Dimension mismatch guard
        stored_dim = len(self._embeddings[0])
        query_dim = len(query_vector)
        if query_dim != stored_dim:
            raise ValueError(
                f"Embedding dimension mismatch: query vector is {query_dim}-dim "
                f"but stored index is {stored_dim}-dim. "
                f"Re-ingest documents with the current embedding provider."
            )

        q_norm = np.linalg.norm(q_vec)
        if q_norm == 0:
            return []
        q_vec = (q_vec / q_norm).astype(np.float32)

        # Attempt FAISS search if available and applicable
        if self.is_using_faiss:
            try:
                return self._search_faiss(q_vec, valid_indices, top_k, threshold, stored_dim)
            except Exception as exc:
                logger.warning(
                    "FAISS search failed, falling back to NumPy search",
                    extra={"error_type": type(exc).__name__},
                )

        # NumPy Fallback Path
        return self._search_numpy(q_vec, valid_indices, top_k, threshold)

    def _search_faiss(
        self,
        q_vec: np.ndarray,
        valid_indices: List[int],
        top_k: int,
        threshold: float,
        stored_dim: int,
    ) -> List[RetrievedChunk]:
        """Executes vector search using FAISS IndexFlatIP."""
        all_tenant_matched = (len(valid_indices) == len(self._chunks))

        if all_tenant_matched:
            if self._faiss_dirty or self._faiss_index is None:
                self._rebuild_faiss_index()

            q_matrix = np.ascontiguousarray(q_vec.reshape(1, -1), dtype=np.float32)
            search_k = min(top_k, self._faiss_index.ntotal)
            scores, indices = self._faiss_index.search(q_matrix, search_k)

            results: List[RetrievedChunk] = []
            for rank, (score_val, idx_val) in enumerate(zip(scores[0], indices[0]), start=1):
                if idx_val < 0 or idx_val >= len(self._chunks):
                    continue
                score = float(score_val)
                if score >= threshold:
                    results.append(
                        RetrievedChunk(
                            chunk=self._chunks[idx_val],
                            score=round(score, 4),
                            rank=rank,
                        )
                    )
            return results
        else:
            # Sub-index FAISS for filtered tenant subset
            sub_embeddings = [self._embeddings[i] for i in valid_indices]
            matrix = np.array(sub_embeddings, dtype=np.float32)
            norms = np.linalg.norm(matrix, axis=1, keepdims=True)
            norms[norms == 0] = 1.0
            matrix_normed = np.ascontiguousarray(matrix / norms, dtype=np.float32)

            sub_index = faiss.IndexFlatIP(stored_dim)
            sub_index.add(matrix_normed)

            q_matrix = np.ascontiguousarray(q_vec.reshape(1, -1), dtype=np.float32)
            search_k = min(top_k, len(valid_indices))
            scores, indices = sub_index.search(q_matrix, search_k)

            results = []
            for rank, (score_val, sub_idx) in enumerate(zip(scores[0], indices[0]), start=1):
                if sub_idx < 0 or sub_idx >= len(valid_indices):
                    continue
                score = float(score_val)
                if score >= threshold:
                    original_idx = valid_indices[sub_idx]
                    results.append(
                        RetrievedChunk(
                            chunk=self._chunks[original_idx],
                            score=round(score, 4),
                            rank=rank,
                        )
                    )
            return results

    def _search_numpy(
        self,
        q_vec: np.ndarray,
        valid_indices: List[int],
        top_k: int,
        threshold: float,
    ) -> List[RetrievedChunk]:
        """Pure-Python / NumPy fallback path for Cosine Similarity search."""
        sub_embeddings = [self._embeddings[i] for i in valid_indices]
        matrix = np.array(sub_embeddings, dtype=np.float32)
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        matrix_normed = matrix / norms

        similarities = np.dot(matrix_normed, q_vec)
        top_sub_indices = np.argsort(similarities)[::-1][:top_k]

        results: List[RetrievedChunk] = []
        for rank, sub_idx in enumerate(top_sub_indices, start=1):
            score = float(similarities[sub_idx])
            if score >= threshold:
                original_idx = valid_indices[sub_idx]
                results.append(
                    RetrievedChunk(
                        chunk=self._chunks[original_idx],
                        score=round(score, 4),
                        rank=rank,
                    )
                )
        return results

    @_synchronized_store_access
    def get_stats(self) -> Dict[str, Any]:
        """Returns metadata stats for the vector store."""
        unique_docs = len({c.document_id for c in self._chunks})
        dimension = len(self._embeddings[0]) if self._embeddings else 0
        embedding_identity = None
        embedded_chunks = [chunk for chunk in self._chunks if chunk.embedding is not None]
        if embedded_chunks:
            try:
                identities = [normalize_embedding_identity(chunk.embedding_identity) for chunk in embedded_chunks]
                if all(identity == identities[0] for identity in identities[1:]):
                    embedding_identity = identities[0]
            except EmbeddingIdentityError:
                pass
        return {
            "version": self.VERSION,
            "total_chunks": len(self._chunks),
            "unique_documents": unique_docs,
            "embedding_dimension": dimension,
            "embedding_identity": embedding_identity,
            "index_path": str(self.index_path),
            "backup_exists": self.backup_path.exists(),
            "faiss_available": FAISS_AVAILABLE,
            "is_using_faiss": self.is_using_faiss,
        }

    @_synchronized_store_access
    def get_chunks(self, document_id: Optional[str] = None) -> List[TextChunk]:
        return [chunk for chunk in self._chunks if document_id is None or chunk.document_id == document_id]

    @_synchronized_store_access
    def get_corpus_revision(self) -> str:
        payload = json.dumps(
            [chunk.model_dump() for chunk in self._chunks], sort_keys=True, separators=(",", ":")
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    @_synchronized_store_access
    def delete_document(self, document_id: str) -> int:
        keep_indices = [i for i, chunk in enumerate(self._chunks) if chunk.document_id != document_id]
        removed = len(self._chunks) - len(keep_indices)
        if removed:
            self._chunks = [self._chunks[i] for i in keep_indices]
            self._embeddings = [self._embeddings[i] for i in keep_indices]
            self._faiss_dirty = True
            self.save()
        return removed

    @_synchronized_store_access
    def set_document_state(self, document_id: str, state: str) -> int:
        allowed = {"PENDING", "ACTIVE", "SUPERSEDED", "SOFT_DELETED", "DELETED", "QUARANTINED", "FAILED"}
        if state not in allowed:
            raise ValueError("Unsupported document lifecycle state.")
        changed = 0
        for chunk in self._chunks:
            if chunk.document_id == document_id and chunk.lifecycle_state != state:
                chunk.lifecycle_state = state
                changed += 1
        if changed:
            self._faiss_dirty = True
            self.save()
        return changed

    @_synchronized_store_access
    def update_document_metadata(
        self,
        document_id: str,
        title: Optional[str] = None,
        author: Optional[str] = None,
    ) -> int:
        changed = 0
        for chunk in self._chunks:
            if chunk.document_id != document_id:
                continue
            if title is not None:
                chunk.metadata.title = title
            if author is not None:
                chunk.metadata.author = author
            changed += 1
        if changed:
            self.save()
        return changed

    @_synchronized_store_access
    def save(self) -> None:
        """
        Persists chunks and vector embeddings to disk using atomic write and backup snapshot creation.
        """
        self.index_path.parent.mkdir(parents=True, exist_ok=True)

        serialized_chunks = [chunk.model_dump() for chunk in self._chunks]
        payload_str = json.dumps(serialized_chunks)
        checksum = hashlib.sha256(payload_str.encode("utf-8")).hexdigest()

        wrapped_index = {
            "version": self.VERSION,
            "sha256": checksum,
            "total_chunks": len(serialized_chunks),
            "embedding_dimension": len(self._embeddings[0]) if self._embeddings else 0,
            "chunks": serialized_chunks,
        }

        # 1. Atomic Write to Temporary File
        tmp_path = self.index_path.with_suffix(".tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(wrapped_index, f, indent=2)

        # 2. Backup Snapshot Creation
        if self.index_path.exists():
            try:
                shutil.copy2(self.index_path, self.backup_path)
            except Exception as e:
                logger.warning(f"Could not create backup snapshot: {e}")

        # 3. Replace Atomic Move
        os.replace(tmp_path, self.index_path)
        logger.info(f"Safely persisted vector index (v{self.VERSION}, checksum: {checksum[:8]}) to {self.index_path}")

    @_synchronized_store_access
    def load(self) -> None:
        """Loads index from disk with corruption detection and backup recovery."""
        self._chunks = []
        self._embeddings = []
        self._stored_embedding_dim = 0
        self._faiss_index = None
        self._faiss_dirty = True
        if not self.index_path.exists():
            return

        try:
            self._load_from_path(self.index_path)
        except Exception as e:
            logger.error(f"Failed to load primary vector index from {self.index_path}: {e}")
            if self.backup_path.exists():
                logger.warning(f"Attempting corruption recovery from backup: {self.backup_path}")
                try:
                    self._load_from_path(self.backup_path)
                    logger.info("Successfully recovered vector store index from backup!")
                except Exception as backup_err:
                    logger.error(f"Backup recovery also failed: {backup_err}")
            else:
                logger.error("No backup snapshot available for recovery.")

    def _load_from_path(self, file_path: Path) -> None:
        """Helper to parse and validate index file format (v1.0 list vs v2.0 wrapped dict)."""
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        if isinstance(data, dict) and "chunks" in data:
            # Format v2.0
            chunks_list = data["chunks"]
            expected_hash = data.get("sha256")
            if expected_hash:
                actual_hash = hashlib.sha256(json.dumps(chunks_list).encode("utf-8")).hexdigest()
                if actual_hash != expected_hash:
                    raise ValueError(f"Vector index checksum mismatch! Expected {expected_hash[:8]}, got {actual_hash[:8]}")
        elif isinstance(data, list):
            # Format v1.0 (backward compatibility)
            chunks_list = data
        else:
            raise ValueError("Invalid vector index structure.")

        normalized_items = [
            item if "lifecycle_state" in item else {**item, "lifecycle_state": "QUARANTINED"}
            for item in chunks_list
        ]
        loaded_chunks = [TextChunk(**item) for item in normalized_items]
        loaded_embeddings = [chunk.embedding for chunk in loaded_chunks]
        if any(not embedding for embedding in loaded_embeddings):
            raise ValueError("Persisted vector index contains a chunk without an embedding.")
        if any(not np.isfinite(np.asarray(embedding, dtype=np.float64)).all() for embedding in loaded_embeddings):
            raise ValueError("Persisted vector index contains non-finite embedding values.")
        dimensions = {len(embedding) for embedding in loaded_embeddings}
        if len(dimensions) > 1:
            raise ValueError("Persisted vector index contains mixed embedding dimensions.")
        self._chunks = loaded_chunks
        self._embeddings = loaded_embeddings
        self._stored_embedding_dim = len(self._embeddings[0]) if self._embeddings else 0
        self._faiss_dirty = True
        logger.info(f"Loaded {len(self._chunks)} chunks (dim={self._stored_embedding_dim}) into PersistentVectorStore from {file_path}")
