"""
WealthGenie RAG Subsystem - MongoDB-backed Vector Store

Stores document chunks and embeddings in MongoDB for cross-replica shared state.
Vector search is performed in-memory using FAISS/NumPy after loading embeddings
from MongoDB — MongoDB 7.0 Community Edition does not support Atlas Vector Search.

Known limitation: Each replica loads the full embedding set into RAM on startup.
For very large corpora this will not scale well memory-wise per replica.
"""

import logging
import math
import os
from typing import Dict, List, Any, Optional
import numpy as np

try:
    import faiss
    FAISS_AVAILABLE = True
except ImportError:
    faiss = None
    FAISS_AVAILABLE = False

from pymongo import MongoClient

from rag.schema import TextChunk, RetrievedChunk, ChunkMetadata, is_scope_accessible, has_consistent_chunk_ownership
from rag.embeddings.identity import EmbeddingIdentityError, normalize_embedding_identity
from rag.corpus_generation import canonical_member, generation_digest
from rag.vector_store.base import BaseVectorStore
from model.migrations.phase3_state import verify_phase3_state
from mongo_database import resolve_mongo_database_name

logger = logging.getLogger("wealthgenie.rag.vector_store.mongo")


class MongoVectorStore(BaseVectorStore):
    """
    MongoDB-backed vector store with in-memory FAISS/NumPy search.

    Chunks and embeddings are persisted in MongoDB for cross-replica access.
    On load(), all embeddings are pulled into memory and a FAISS IndexFlatIP
    is built for cosine similarity search. This is the same search strategy
    as PersistentVectorStore, but with MongoDB replacing JSON files.
    """

    VERSION = "3.1"

    def __init__(
        self,
        mongo_uri: str,
        db_name: Optional[str] = None,
        collection_name: str = "vector_chunks",
        force_numpy: bool = False,
    ):
        self._client = MongoClient(mongo_uri, serverSelectionTimeoutMS=5000)
        self._db = self._client[db_name or resolve_mongo_database_name(mongo_uri)]
        self._collection = self._db[collection_name]
        self._revision_collection = self._db["rag_state"]
        self._corpus_state = self._db["rag_corpus_state"]
        from rag.lifecycle.mongo_store import MongoRAGLifecycleStore
        self.lifecycle_store = MongoRAGLifecycleStore(
            self._client, self._db, vector_collection=collection_name
        )
        self._loaded_corpus_revision: Optional[int] = None
        self._loaded_generation_id: Optional[str] = None
        self.force_numpy = force_numpy

        # In-memory search state
        self._chunks: List[TextChunk] = []
        self._embeddings: List[List[float]] = []
        self._stored_embedding_dim: int = 0
        self._stored_embedding_identity: Optional[Dict[str, Any]] = None
        self._faiss_index: Any = None
        self._faiss_dirty: bool = True

        try:
            verify_phase3_state(self._db, vector_collection=collection_name)
        except Exception:
            self._client.close()
            raise
        self.load()

    @property
    def is_using_faiss(self) -> bool:
        return FAISS_AVAILABLE and not self.force_numpy

    def add_chunks(self, chunks: List[TextChunk]) -> int:
        """Adds embedded text chunks to MongoDB, avoiding duplicate chunk_ids."""
        if os.environ.get("ENVIRONMENT", "local").strip().lower() in {"production", "prod"}:
            raise RuntimeError("Production Mongo chunks must be written through atomic commit_document_revision")
        embedded_chunks = [chunk for chunk in chunks if chunk.embedding is not None]
        incoming = [chunk.embedding for chunk in embedded_chunks]
        if any(
            not isinstance(vector, list)
            or not vector
            or any(not isinstance(value, (int, float)) or not math.isfinite(value) for value in vector)
            for vector in incoming
        ):
            raise ValueError("Cannot persist malformed or non-finite embeddings.")
        dimensions = {len(vector) for vector in incoming}
        if len(dimensions) > 1 or (self._stored_embedding_dim and dimensions and dimensions != {self._stored_embedding_dim}):
            raise ValueError("Cannot mix embedding dimensions in a Mongo vector-store generation.")
        identities = [
            normalize_embedding_identity(chunk.embedding_identity)
            for chunk in embedded_chunks
        ]
        if any(identity["embedding_dimension"] != len(chunk.embedding) for identity, chunk in zip(identities, embedded_chunks)):
            raise ValueError("Persisted vector dimension does not match its embedding identity.")
        if identities and any(identity != identities[0] for identity in identities[1:]):
            raise ValueError("Cannot mix embedding identities in a Mongo vector-store generation.")
        incoming_identity = identities[0] if identities else None
        if (
            incoming_identity is not None
            and self._stored_embedding_identity is not None
            and incoming_identity != self._stored_embedding_identity
        ):
            raise ValueError("Cannot write a different embedding identity into the active Mongo vector-store generation.")
        added_count = 0
        for chunk in chunks:
            if chunk.embedding is None:
                continue

            identity = normalize_embedding_identity(chunk.embedding_identity)

            scope = getattr(chunk, "scope", None) or getattr(chunk.metadata, "scope", "global")
            doc = {
                "chunk_id": chunk.chunk_id,
                "document_id": chunk.document_id,
                "content": chunk.content,
                "metadata": chunk.metadata.model_dump(),
                "tenant_id": chunk.tenant_id,
                "scope": scope,
                "lifecycle_state": chunk.lifecycle_state,
                "embedding": chunk.embedding,
                "embedding_identity": identity,
            }

            # Upsert: update if exists, insert if new
            result = self._collection.update_one(
                {"chunk_id": chunk.chunk_id},
                {"$set": doc},
                upsert=True,
            )
            if result.upserted_id is not None:
                added_count += 1

        if incoming:
            self._advance_corpus_revision()
            self._reload_in_memory()
        logger.info(
            f"Added {added_count} new chunks to MongoVectorStore. "
            f"Total: {self._collection.count_documents({})}"
        )
        return added_count

    def commit_document_revision(self, document, chunks: List[TextChunk]) -> int:
        """Persist the complete document revision and activate it atomically."""
        revision = self.lifecycle_store.commit_document_revision(document, chunks)
        if not revision or revision.get("lifecycle_state") != "ACTIVE":
            raise RuntimeError("Mongo document revision did not become active")
        self._reload_in_memory()
        return len(chunks)

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
        Executes tenant/scope-isolated similarity vector search.
        Filters chunks to scope=='global' OR scope=='user:{requesting_user_id}',
        never returning another user's scoped content.
        """
        self._refresh_if_changed()
        if not self._chunks or not self._embeddings:
            return []

        query_identity = normalize_embedding_identity(embedding_identity)
        if query_identity != self._stored_embedding_identity:
            raise ValueError("Query embedding identity does not match the active Mongo vector-store generation.")

        q_vec = np.array(query_vector, dtype=np.float32)
        if q_vec.ndim != 1 or not np.isfinite(q_vec).all():
            raise ValueError("Query embedding must be a finite one-dimensional vector.")
        if len(q_vec) != query_identity["embedding_dimension"]:
            raise ValueError("Query vector dimension does not match its declared embedding identity.")
        q_norm = np.linalg.norm(q_vec)
        if q_norm == 0:
            return []
        q_vec = q_vec / q_norm

        # Scope & Tenant filtering: global content or matching user's private content
        valid_indices = [
            i for i, c in enumerate(self._chunks)
            if c.lifecycle_state == "ACTIVE" and has_consistent_chunk_ownership(c) and is_scope_accessible(
                chunk_scope=getattr(c, "scope", getattr(c.metadata, "scope", "global")),
                chunk_tenant_id=getattr(c, "tenant_id", getattr(c.metadata, "tenant_id", "default")),
                requesting_scope=scope,
                requesting_user_id=user_id,
                tenant_id=tenant_id,
            )
        ]
        if not valid_indices:
            return []

        stored_dim = self._stored_embedding_dim
        if len(q_vec) != stored_dim:
            logger.warning(
                f"Query dim {len(q_vec)} != stored dim {stored_dim}. Skipping search."
            )
            return []

        if self.is_using_faiss:
            return self._search_faiss(q_vec, valid_indices, top_k, threshold, stored_dim)
        else:
            return self._search_numpy(q_vec, valid_indices, top_k, threshold)

    def _rebuild_faiss_index(self) -> None:
        """Rebuilds the in-memory FAISS IndexFlatIP from normalized embeddings."""
        if not self.is_using_faiss or not self._embeddings:
            self._faiss_index = None
            self._faiss_dirty = False
            return

        matrix = np.array(self._embeddings, dtype=np.float32)
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        matrix_normed = np.ascontiguousarray(matrix / norms, dtype=np.float32)

        dim = matrix_normed.shape[1]
        self._faiss_index = faiss.IndexFlatIP(dim)
        self._faiss_index.add(matrix_normed)
        self._faiss_dirty = False
        logger.info(f"Rebuilt FAISS index with {matrix_normed.shape[0]} vectors (dim={dim})")

    def _search_faiss(
        self,
        q_vec: np.ndarray,
        valid_indices: List[int],
        top_k: int,
        threshold: float,
        stored_dim: int,
    ) -> List[RetrievedChunk]:
        """Executes vector search using FAISS IndexFlatIP."""
        all_tenant_matched = len(valid_indices) == len(self._chunks)

        if all_tenant_matched:
            if self._faiss_dirty or self._faiss_index is None:
                self._rebuild_faiss_index()

            q_matrix = np.ascontiguousarray(q_vec.reshape(1, -1), dtype=np.float32)
            search_k = min(top_k, self._faiss_index.ntotal)
            scores, indices = self._faiss_index.search(q_matrix, search_k)

            results: List[RetrievedChunk] = []
            for rank, (score_val, idx_val) in enumerate(
                zip(scores[0], indices[0]), start=1
            ):
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
            # Sub-index for filtered tenant subset
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
            for rank, (score_val, sub_idx) in enumerate(
                zip(scores[0], indices[0]), start=1
            ):
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
        """Pure-Python / NumPy fallback path for cosine similarity search."""
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

    def get_stats(self) -> Dict[str, Any]:
        """Returns metadata stats for the vector store."""
        total = self._collection.count_documents({})
        unique_docs = len(self._collection.distinct("document_id"))
        dimension = self._stored_embedding_dim
        return {
            "version": self.VERSION,
            "total_chunks": total,
            "total_chunks_in_memory": len(self._chunks),
            "unique_documents": unique_docs,
            "embedding_dimension": dimension,
            "embedding_identity": self._stored_embedding_identity,
            "backend": "mongodb",
            "faiss_available": FAISS_AVAILABLE,
            "is_using_faiss": self.is_using_faiss,
        }

    def save(self) -> None:
        """
        No-op for MongoDB store — data is already persisted on every add_chunks().
        Exists to satisfy the BaseVectorStore interface.
        """
        pass

    def load(self) -> None:
        """
        Loads all chunks and embeddings from MongoDB into memory for search.
        Rebuilds the FAISS index after loading.
        """
        self._reload_in_memory()

    def get_chunks(self, document_id: Optional[str] = None) -> List[TextChunk]:
        query = {"document_id": document_id} if document_id is not None else {}
        return [self._chunk_from_document(doc) for doc in self._collection.find(query, {"_id": 0})]

    def delete_document(self, document_id: str) -> int:
        if os.environ.get("ENVIRONMENT", "local").strip().lower() in {"production", "prod"}:
            raise RuntimeError("Production document deletion must use the shared lifecycle transaction")
        result = self._collection.delete_many({"document_id": document_id})
        if result.deleted_count:
            self._advance_corpus_revision()
            self._reload_in_memory()
        return result.deleted_count

    def set_document_state(self, document_id: str, state: str) -> int:
        if os.environ.get("ENVIRONMENT", "local").strip().lower() in {"production", "prod"}:
            raise RuntimeError("Production lifecycle transitions must use the shared lifecycle transaction")
        allowed = {"PENDING", "ACTIVE", "SUPERSEDED", "SOFT_DELETED", "DELETED", "QUARANTINED", "FAILED"}
        if state not in allowed:
            raise ValueError("Unsupported document lifecycle state.")
        result = self._collection.update_many(
            {"document_id": document_id}, {"$set": {"lifecycle_state": state}}
        )
        if result.modified_count:
            self._advance_corpus_revision()
            self._reload_in_memory()
        return result.modified_count

    def update_document_metadata(
        self,
        document_id: str,
        title: Optional[str] = None,
        author: Optional[str] = None,
    ) -> int:
        if os.environ.get("ENVIRONMENT", "local").strip().lower() in {"production", "prod"}:
            raise RuntimeError("Production metadata revisions must use the shared lifecycle transaction")
        updates = {}
        if title is not None:
            updates["metadata.title"] = title
        if author is not None:
            updates["metadata.author"] = author
        if not updates:
            return 0
        result = self._collection.update_many({"document_id": document_id}, {"$set": updates})
        if result.modified_count:
            self._advance_corpus_revision()
            self._reload_in_memory()
        return result.modified_count

    def get_corpus_revision(self) -> str:
        pointer = self._corpus_state.find_one({"_id": "active_corpus"})
        if pointer:
            return str(pointer.get("revision", 0))
        record = self._revision_collection.find_one({"_id": "active_corpus"}) or {}
        return str(record.get("revision", 0))

    def get_active_generation(self) -> Optional[Dict[str, Any]]:
        return self.lifecycle_store.get_active_generation()

    def get_loaded_generation_id(self) -> Optional[str]:
        return self._loaded_generation_id

    def get_generation_snapshot(self) -> Dict[str, Any]:
        self._refresh_if_changed()
        active = self.get_active_generation()
        if active is None:
            return {"generation_id": None, "revision": int(self.get_corpus_revision())}
        return {
            "generation_id": active["generation_id"],
            "revision": active["revision"],
            "manifest_sha256": active["manifest_sha256"],
            "embedding_identity": active["embedding_identity"],
            "membership_sha256": active["membership_sha256"],
        }

    def _advance_corpus_revision(self) -> None:
        self._revision_collection.update_one(
            {"_id": "active_corpus"}, {"$inc": {"revision": 1}}, upsert=True
        )

    def _refresh_if_changed(self) -> None:
        pointer = self._corpus_state.find_one({"_id": "active_corpus"})
        current = int((pointer or {}).get("revision", self.get_corpus_revision()))
        generation_id = (pointer or {}).get("generation_id")
        if self._loaded_corpus_revision != current or self._loaded_generation_id != generation_id:
            self._reload_in_memory()

    @staticmethod
    def _chunk_from_document(doc: Dict[str, Any]) -> TextChunk:
        embedding = doc.get("embedding")
        if not isinstance(embedding, list) or not embedding:
            raise ValueError(f"Chunk {doc.get('chunk_id')} has no valid embedding.")
        if any(not isinstance(value, (int, float)) or not math.isfinite(value) for value in embedding):
            raise ValueError(f"Chunk {doc.get('chunk_id')} has non-finite embedding values.")
        try:
            embedding_identity = normalize_embedding_identity(doc.get("embedding_identity"))
        except EmbeddingIdentityError as exc:
            raise ValueError(f"Chunk {doc.get('chunk_id')} has missing or invalid embedding identity.") from exc
        if len(embedding) != embedding_identity["embedding_dimension"]:
            raise ValueError(f"Chunk {doc.get('chunk_id')} embedding dimension does not match its identity.")
        metadata = dict(doc.get("metadata", {}))
        scope = doc.get("scope", metadata.get("scope", "global"))
        metadata["scope"] = scope
        return TextChunk(
            chunk_id=doc["chunk_id"],
            document_id=doc["document_id"],
            content=doc["content"],
            metadata=ChunkMetadata(**metadata),
            tenant_id=doc.get("tenant_id", "default"),
            scope=scope,
            lifecycle_state=doc.get("lifecycle_state", "QUARANTINED"),
            document_revision_id=doc.get("document_revision_id"),
            embedding=embedding,
            embedding_identity=embedding_identity,
        )

    def _reload_in_memory(self) -> None:
        """Pull all chunks from MongoDB into in-memory arrays for search."""
        # Clear the old generation first: corruption must never leave a stale
        # index available after a failed reload.
        self._chunks = []
        self._embeddings = []
        self._stored_embedding_dim = 0
        self._stored_embedding_identity = None
        self._loaded_generation_id = None
        self._faiss_index = None
        self._faiss_dirty = True
        revision_before = int(self.get_corpus_revision())
        pointer = self._corpus_state.find_one({"_id": "active_corpus"})
        generation = self.get_active_generation() if pointer else None
        if pointer and generation is None:
            raise RuntimeError("active RAG corpus pointer has no immutable generation")
        if not pointer and os.environ.get("ENVIRONMENT", "local").strip().lower() in {"production", "prod"}:
            raise RuntimeError("production RAG corpus has not completed explicit generation bootstrap")
        active_revisions = list(self._db["rag_document_revisions"].find(
            {"lifecycle_state": "ACTIVE"}, {"_id": 0}
        ))
        if any(not item.get("document_revision_id") for item in active_revisions):
            raise RuntimeError("Active RAG lifecycle record has no immutable revision identity.")
        active_revision_by_id = {
            item["document_revision_id"]: item for item in active_revisions
        }
        if len(active_revision_by_id) != len(active_revisions):
            raise RuntimeError("RAG lifecycle contains duplicate active revision identities.")
        active_revision_ids = list(active_revision_by_id)
        generation_members = {}
        if generation:
            members = list(self._db["rag_corpus_generation_members"].find(
                {"generation_id": generation["generation_id"]}, {"_id": 0}
            ))
            generation_members = {row.get("document_revision_id"): row for row in members}
            if len(generation_members) != len(members) or set(generation_members) != set(active_revision_ids):
                raise RuntimeError("active RAG generation membership differs from active document revisions")
            active_query = {"lifecycle_state": "ACTIVE"}
        elif active_revision_ids:
            active_query = {
                "lifecycle_state": "ACTIVE",
                "document_revision_id": {"$in": active_revision_ids},
            }
        elif os.environ.get("ENVIRONMENT", "local").strip().lower() in {"production", "prod"}:
            active_query = {"document_revision_id": {"$in": []}}
        else:
            # Legacy direct-store fixtures are tolerated only outside production.
            active_query = {
                "lifecycle_state": "ACTIVE",
                "document_revision_id": {"$exists": False},
            }
        cursor = self._collection.find(active_query, {"_id": 0})
        chunks: List[TextChunk] = []
        embeddings: List[List[float]] = []
        expected_dimension: Optional[int] = None
        expected_identity: Optional[Dict[str, Any]] = None
        revision_chunk_counts: Dict[str, int] = {}
        member_chunks: Dict[str, list[dict[str, Any]]] = {}
        creator_generation_ids: set[str] = set()
        for doc in cursor:
            revision_id = doc.get("document_revision_id")
            revision = active_revision_by_id.get(revision_id)
            if generation and (revision is None or revision_id not in generation_members):
                raise RuntimeError("active RAG chunk is not a member of the canonical corpus generation")
            if revision is not None and (
                doc.get("document_id") != revision.get("document_id")
                or doc.get("scope", "global") != revision.get("scope", "global")
                or doc.get("tenant_id", "default") != revision.get("tenant_id", "default")
                or doc.get("lifecycle_state") != "ACTIVE"
            ):
                raise RuntimeError("Active RAG chunk identity does not match its document revision pointer.")
            if generation and not doc.get("corpus_generation_id"):
                raise RuntimeError("active RAG chunk has no immutable creator generation identity")
            if generation:
                creator_generation_ids.add(doc["corpus_generation_id"])
            chunk = self._chunk_from_document(doc)
            embedding = chunk.embedding
            if embedding is None:
                raise ValueError(f"Chunk {chunk.chunk_id} has no embedding.")
            if expected_dimension is None:
                expected_dimension = len(embedding)
            elif len(embedding) != expected_dimension:
                raise ValueError("Mongo vector store contains mixed embedding dimensions.")
            if expected_identity is None:
                expected_identity = chunk.embedding_identity
            elif chunk.embedding_identity != expected_identity:
                raise ValueError("Mongo vector store contains mixed embedding identities.")
            if generation and chunk.embedding_identity != generation.get("embedding_identity"):
                raise RuntimeError("active RAG generation mixes incompatible embedding identities")
            chunks.append(chunk)
            embeddings.append(embedding)
            if revision is not None:
                revision_chunk_counts[revision_id] = revision_chunk_counts.get(revision_id, 0) + 1
                member_chunks.setdefault(revision_id, []).append(doc)

        for revision_id, revision in active_revision_by_id.items():
            expected_count = revision.get("chunk_count")
            if not isinstance(expected_count, int) or expected_count <= 0:
                raise RuntimeError("Active RAG lifecycle revision has an invalid expected chunk count.")
            if revision_chunk_counts.get(revision_id, 0) != expected_count:
                raise RuntimeError("Active RAG revision chunk set is incomplete or inconsistent.")
            if generation:
                recomputed = canonical_member(revision, member_chunks.get(revision_id, []))
                stored = generation_members[revision_id]
                if any(stored.get(field) != recomputed.get(field) for field in recomputed):
                    raise RuntimeError("active RAG generation member digest does not match stored chunks")

        if generation:
            recomputed_members = [generation_members[key] for key in sorted(generation_members)]
            if generation_digest(recomputed_members) != generation.get("membership_sha256"):
                raise RuntimeError("active RAG generation membership digest is invalid")
            if len(chunks) != generation.get("chunk_count") or len(active_revisions) != generation.get("document_count"):
                raise RuntimeError("active RAG generation counts do not match its membership")
            known_creators = {
                row.get("generation_id") for row in self._db["rag_corpus_generations"].find(
                    {"generation_id": {"$in": list(creator_generation_ids)}},
                    {"_id": 0, "generation_id": 1},
                )
            }
            if creator_generation_ids != known_creators:
                raise RuntimeError("active RAG chunk references an unknown creator generation")

        # Publish only a fully validated generation: chunk/vector positions stay aligned.
        self._chunks = chunks
        self._embeddings = embeddings
        self._stored_embedding_dim = expected_dimension or 0
        self._stored_embedding_identity = expected_identity
        self._loaded_corpus_revision = int(self.get_corpus_revision())
        self._loaded_generation_id = generation.get("generation_id") if generation else None
        if self._loaded_corpus_revision != revision_before:
            self._loaded_corpus_revision = None
            raise RuntimeError("RAG corpus changed during vector index reload; retry required.")
        self._faiss_dirty = True

        logger.info(
            f"Loaded {len(self._chunks)} chunks (dim={self._stored_embedding_dim}) "
            f"from MongoDB into MongoVectorStore"
        )

    def close(self) -> None:
        """Close the MongoDB connection."""
        if self._client:
            self._client.close()
