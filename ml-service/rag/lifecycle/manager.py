"""
WealthGenie RAG Subsystem - Document Lifecycle Manager
Manages document version history, soft/hard deletion, incremental re-indexing, duplicate detection, and metadata updates.
Hardened with atomic writes, SHA-256 checksum validation, backup recovery, reconciliation, thread-safe synchronization,
and per-user tenant ownership isolation.
"""

import hashlib
import json
import logging
import os
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any, List, Optional, Set

from rag.config import RAGConfig
from rag.lifecycle.errors import DocumentOwnershipError
from rag.schema import Document, is_scope_accessible
from rag.vector_store.base import BaseVectorStore
from rag.vector_store.memory_vector_store import PersistentVectorStore

REGISTRY_PATH = RAGConfig().document_registry_path
logger = logging.getLogger("wealthgenie.rag.lifecycle")

# Process-wide registry lock pool keyed by canonical path
_REGISTRY_LOCKS: Dict[str, threading.RLock] = {}
_REGISTRY_GUARD = threading.Lock()


def _get_registry_lock(path: Path) -> threading.RLock:
    """Returns a shared process-wide re-entrant lock for a specific registry path."""
    try:
        resolved_key = str(path.resolve())
    except Exception:
        resolved_key = str(path)
    with _REGISTRY_GUARD:
        if resolved_key not in _REGISTRY_LOCKS:
            _REGISTRY_LOCKS[resolved_key] = threading.RLock()
        return _REGISTRY_LOCKS[resolved_key]


class DocumentLifecycleManager:
    """Manages document CRUD operations, version history, soft/hard deletion, and re-indexing."""

    VERSION = "2.0"

    def __init__(
        self,
        vector_store: Optional[BaseVectorStore] = None,
        registry_path: Path = REGISTRY_PATH,
    ):
        self.vector_store = vector_store or PersistentVectorStore()
        self._shared_store = getattr(self.vector_store, "lifecycle_store", None)
        self.is_shared = self._shared_store is not None
        self.registry_path = Path(registry_path)
        self.backup_path = self.registry_path.with_suffix(".json.bak")
        self._lock = _get_registry_lock(self.registry_path)
        self._registry: Dict[str, Dict[str, Any]] = {}
        if not self.is_shared:
            self.load_registry()
            self.reconcile_registry_and_vector_store()

    def _sync_registry_unlocked(self) -> None:
        """Reloads registry from disk if file exists with checksum validation and backup recovery under lock."""
        self._load_registry_unlocked()

    def register_document(
        self,
        document: Document,
        chunk_count: int,
        owner_user_id: Optional[str] = None,
    ) -> None:
        """Registers or updates document entry in the document registry with scope and owner tracking."""
        if self.is_shared:
            raise RuntimeError("Mongo lifecycle records must commit with their complete chunk set")
        with self._lock:
            self._sync_registry_unlocked()
            doc_id = document.document_id
            is_existing = doc_id in self._registry

            version = int(self._registry[doc_id].get("version_number", 1)) + 1 if is_existing else 1

            doc_scope = getattr(document.metadata, "scope", "global") or "global"
            resolved_owner = owner_user_id
            if not resolved_owner:
                resolved_owner = getattr(document.metadata, "custom_metadata", {}).get("owner_user_id")
            if not resolved_owner and doc_scope.startswith("user:"):
                resolved_owner = doc_scope[5:]

            self._registry[doc_id] = {
                "document_id": doc_id,
                "title": document.metadata.title,
                "source": document.metadata.source,
                "document_type": document.metadata.document_type,
                "author": document.metadata.author,
                "chunk_count": chunk_count,
                "scope": doc_scope,
                "owner_user_id": resolved_owner,
                "tenant_id": getattr(document.metadata, "tenant_id", "default") or "default",
                "is_active": True,
                "version_number": version,
                "created_at_utc": self._registry[doc_id].get("created_at_utc") if is_existing else datetime.now(timezone.utc).isoformat(),
                "updated_at_utc": datetime.now(timezone.utc).isoformat(),
            }
            self._save_registry_unlocked()
            # Pending chunks become retrievable only after the document record is durable.
            self.vector_store.set_document_state(doc_id, "ACTIVE")
            logger.info(
                f"Registered document '{document.metadata.title}' (v{version}, scope={doc_scope}, owner={resolved_owner}) in DocumentRegistry."
            )

    def soft_delete_document(self, document_id: str, requesting_user_id: Optional[str] = None) -> bool:
        """Soft deletes document by marking it inactive in registry with ownership check."""
        if self.is_shared:
            return self._shared_store.soft_delete_document(document_id, requesting_user_id)
        with self._lock:
            self._sync_registry_unlocked()
            if document_id not in self._registry:
                return False

            doc_entry = self._registry[document_id]
            doc_scope = doc_entry.get("scope", "global")
            owner = doc_entry.get("owner_user_id")
            if not owner and doc_scope.startswith("user:"):
                owner = doc_scope[5:]

            if requesting_user_id is not None:
                if doc_scope.startswith("user:") or owner is not None:
                    if owner != requesting_user_id:
                        raise DocumentOwnershipError(
                            f"Forbidden: User '{requesting_user_id}' does not own document '{document_id}'"
                        )
                else:
                    raise DocumentOwnershipError(
                        "Forbidden: Global documents cannot be modified or deleted by standard users"
                    )

            self.vector_store.set_document_state(document_id, "SOFT_DELETED")
            doc_entry["is_active"] = False
            doc_entry["updated_at_utc"] = datetime.now(timezone.utc).isoformat()
            self._save_registry_unlocked()
            logger.info(f"Soft-deleted document '{document_id}' in DocumentRegistry.")
            return True

    def hard_delete_document(self, document_id: str, requesting_user_id: Optional[str] = None) -> bool:
        """
        Hard deletes document from vector store chunks FIRST, then from registry SECOND.
        Enforces caller ownership when requesting_user_id is provided.
        
        ORDERING JUSTIFICATION:
        In a financial advisory RAG system, having content indexed in the vector store without
        a registry entry allows outdated, inaccurate, or legally revoked advice to be retrieved
        and cited by the LLM (compliance/security violation). Conversely, if content is purged
        from the vector store first, a crash before registry deletion leaves a harmless stale
        metadata entry (search fails safely with 0 results and is flagged by reconciliation).
        Thus, vector store purging MUST always precede registry deletion.
        """
        if self.is_shared:
            return self._shared_store.hard_delete_document(document_id, requesting_user_id)
        with self._lock:
            self._sync_registry_unlocked()
            found_in_registry = document_id in self._registry
            chunks = self.vector_store.get_chunks(document_id)
            has_matching_chunks = bool(chunks)

            if not found_in_registry and not has_matching_chunks:
                return False

            # Determine document scope and ownership
            doc_scope = "global"
            owner = None
            if found_in_registry:
                doc_entry = self._registry[document_id]
                doc_scope = doc_entry.get("scope", "global")
                owner = doc_entry.get("owner_user_id")
                if not owner and doc_scope.startswith("user:"):
                    owner = doc_scope[5:]
            elif has_matching_chunks:
                matching_c = [c for c in chunks if c.document_id == document_id][0]
                doc_scope = getattr(matching_c, "scope", getattr(matching_c.metadata, "scope", "global"))
                if doc_scope.startswith("user:"):
                    owner = doc_scope[5:]

            # Enforce ownership check
            if requesting_user_id is not None:
                if doc_scope.startswith("user:") or owner is not None:
                    if owner != requesting_user_id:
                        raise DocumentOwnershipError(
                            f"Forbidden: User '{requesting_user_id}' does not own document '{document_id}'"
                        )
                else:
                    raise DocumentOwnershipError(
                        "Forbidden: Global documents cannot be modified or deleted by standard users"
                    )

            # 1. Purge chunks and embeddings from vector store FIRST
            purged_chunks_count = self.vector_store.delete_document(document_id)
            if purged_chunks_count:
                logger.info("Hard-deleted %s chunks for document '%s' from vector store.", purged_chunks_count, document_id)

            # 2. Remove document record from registry SECOND
            if found_in_registry:
                del self._registry[document_id]
                self._save_registry_unlocked()
                logger.info(f"Removed document '{document_id}' from DocumentRegistry.")

            return True

    def update_metadata(
        self,
        document_id: str,
        new_title: Optional[str] = None,
        new_author: Optional[str] = None,
        requesting_user_id: Optional[str] = None,
    ) -> bool:
        """
        Updates metadata in vector store chunks FIRST, then in document registry SECOND.
        Enforces caller ownership when requesting_user_id is provided.
        
        ORDERING JUSTIFICATION:
        Vector store chunks provide the citation titles and authors directly returned to users
        and fed to the LLM during RAG generation. Updating and persisting vector chunks first
        guarantees that active queries immediately reflect accurate attribution. If a crash
        occurs before the registry save, retrieval citations remain correct while registry
        reconciliation flags the drift.
        """
        if self.is_shared:
            return self._shared_store.update_metadata(document_id, new_title, new_author, requesting_user_id)
        with self._lock:
            self._sync_registry_unlocked()
            found_in_reg = document_id in self._registry
            chunks = self.vector_store.get_chunks(document_id)
            has_matching_chunks = bool(chunks)

            if not found_in_reg and not has_matching_chunks:
                return False

            # Determine document scope and ownership
            doc_scope = "global"
            owner = None
            if found_in_reg:
                doc_entry = self._registry[document_id]
                doc_scope = doc_entry.get("scope", "global")
                owner = doc_entry.get("owner_user_id")
                if not owner and doc_scope.startswith("user:"):
                    owner = doc_scope[5:]
            elif has_matching_chunks:
                matching_c = [c for c in chunks if c.document_id == document_id][0]
                doc_scope = getattr(matching_c, "scope", getattr(matching_c.metadata, "scope", "global"))
                if doc_scope.startswith("user:"):
                    owner = doc_scope[5:]

            # Enforce ownership check
            if requesting_user_id is not None:
                if doc_scope.startswith("user:") or owner is not None:
                    if owner != requesting_user_id:
                        raise DocumentOwnershipError(
                            f"Forbidden: User '{requesting_user_id}' does not own document '{document_id}'"
                        )
                else:
                    raise DocumentOwnershipError(
                        "Forbidden: Global documents cannot be modified or deleted by standard users"
                    )

            # 1. Update metadata in vector store chunks FIRST
            chunks_modified = self.vector_store.update_document_metadata(
                document_id, title=new_title, author=new_author
            )

            if chunks_modified:
                logger.info(f"Updated chunk metadata for document '{document_id}' in vector store.")

            # 2. Update registry metadata SECOND
            if found_in_reg:
                if new_title:
                    self._registry[document_id]["title"] = new_title
                if new_author:
                    self._registry[document_id]["author"] = new_author
                self._registry[document_id]["updated_at_utc"] = datetime.now(timezone.utc).isoformat()
                self._save_registry_unlocked()
                logger.info(f"Updated metadata for document '{document_id}' in DocumentRegistry.")

            return True

    def list_documents(
        self,
        include_inactive: bool = False,
        requesting_user_id: Optional[str] = None,
        requesting_scope: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        Returns list of registered documents filtered by tenant/user scope.
        Uses is_scope_accessible() to guarantee users only see global documents + their own user-scoped documents.
        """
        if self.is_shared:
            return self._shared_store.list_documents(include_inactive, requesting_user_id, requesting_scope)
        with self._lock:
            self._sync_registry_unlocked()
            docs = list(self._registry.values())
            if not include_inactive:
                docs = [d for d in docs if d.get("is_active", True)]

            if requesting_user_id is not None or requesting_scope is not None:
                docs = [
                    d for d in docs
                    if is_scope_accessible(
                        chunk_scope=d.get("scope", "global"),
                        chunk_tenant_id=d.get("tenant_id", "default"),
                        requesting_scope=requesting_scope,
                        requesting_user_id=requesting_user_id,
                        tenant_id="default",
                    )
                ]
            return docs

    def save_registry(self) -> None:
        """Persists registry to JSON file atomically with SHA256 checksum and backup snapshot."""
        if self.is_shared:
            return
        with self._lock:
            self._save_registry_unlocked()

    def _save_registry_unlocked(self) -> None:
        """Internal helper for saving registry while lock is already held."""
        self.registry_path.parent.mkdir(parents=True, exist_ok=True)

        payload_str = json.dumps(self._registry, sort_keys=True)
        checksum = hashlib.sha256(payload_str.encode("utf-8")).hexdigest()

        wrapped_registry = {
            "version": self.VERSION,
            "sha256": checksum,
            "total_documents": len(self._registry),
            "documents": self._registry,
        }

        # 1. Atomic Write to Temporary File
        tmp_path = self.registry_path.with_suffix(".tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(wrapped_registry, f, indent=2)

        # 2. Backup Snapshot Creation
        if self.registry_path.exists():
            try:
                shutil.copy2(self.registry_path, self.backup_path)
            except Exception as exc:
                logger.warning(
                    "Could not create registry backup snapshot",
                    extra={"error_type": type(exc).__name__},
                )

        # 3. Replace Atomic Move
        os.replace(tmp_path, self.registry_path)
        logger.info(
            "Safely persisted document registry (v%s, checksum: %s)", self.VERSION, checksum[:8]
        )

    def load_registry(self) -> None:
        """Loads registry from JSON file with checksum verification and backup snapshot recovery."""
        if self.is_shared:
            return
        with self._lock:
            self._load_registry_unlocked()

    def _load_registry_unlocked(self) -> None:
        """Internal helper to load/resync registry with checksum validation and backup recovery while lock is held."""
        if not self.registry_path.exists() and not self.backup_path.exists():
            return

        try:
            if self.registry_path.exists():
                self._load_from_path(self.registry_path)
                logger.info("Loaded %s document records into DocumentLifecycleManager", len(self._registry))
                return
            else:
                raise FileNotFoundError(f"Primary registry file missing: {self.registry_path}")
        except Exception as exc:
            logger.error(
                "Failed to load primary document registry",
                extra={"error_type": type(exc).__name__},
            )
            if self.backup_path.exists():
                logger.warning("Attempting document registry recovery from backup")
                try:
                    self._load_from_path(self.backup_path)
                    logger.info("Successfully recovered %s document records from backup snapshot", len(self._registry))
                    try:
                        self._save_registry_unlocked()
                    except Exception as restore_err:
                        logger.warning(
                            "Could not restore primary registry from backup",
                            extra={"error_type": type(restore_err).__name__},
                        )
                    return
                except Exception as backup_err:
                    logger.critical(
                        "Fatal: document registry backup recovery also failed",
                        extra={"error_type": type(backup_err).__name__},
                    )
                    raise RuntimeError(
                        "Corrupted document registry and backup recovery failed."
                    ) from None
            else:
                logger.critical(
                    "Fatal: no backup snapshot available for document registry recovery",
                    extra={"error_type": type(exc).__name__},
                )
                raise RuntimeError(
                    "Corrupted document registry and no backup is available."
                ) from None

    def _load_from_path(self, file_path: Path) -> None:
        """Helper to parse and validate registry file format (v1.0 raw dict vs v2.0 wrapped dict), with backward compatibility migration."""
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        if isinstance(data, dict) and "documents" in data:
            # Format v2.0
            docs = data["documents"]
            if not isinstance(docs, dict):
                raise ValueError("Registry 'documents' field must be a dictionary.")
            expected_hash = data.get("sha256")
            if expected_hash:
                actual_hash = hashlib.sha256(json.dumps(docs, sort_keys=True).encode("utf-8")).hexdigest()
                if actual_hash != expected_hash:
                    raise ValueError(
                        f"Document registry checksum mismatch! Expected {expected_hash[:8]}, got {actual_hash[:8]}"
                    )
            raw_docs = docs
        elif isinstance(data, dict):
            # Format v1.0 (backward compatibility for raw dict of document_id -> metadata)
            raw_docs = data
        else:
            raise ValueError(f"Invalid document registry structure in {file_path}")

        # Migration: Ensure all loaded documents have scope, owner_user_id, and tenant_id
        for doc_id, doc_data in raw_docs.items():
            if isinstance(doc_data, dict):
                if "scope" not in doc_data or not doc_data["scope"]:
                    doc_data["scope"] = "global"
                if "owner_user_id" not in doc_data:
                    if doc_data["scope"].startswith("user:"):
                        doc_data["owner_user_id"] = doc_data["scope"][5:]
                    else:
                        doc_data["owner_user_id"] = None
                if "tenant_id" not in doc_data:
                    doc_data["tenant_id"] = "default"

        self._registry.clear()
        self._registry.update(raw_docs)

    def reconcile_registry_and_vector_store(
        self,
        requesting_user_id: Optional[str] = None,
        requesting_scope: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Reconciles registry documents with vector store chunks to detect orphan chunks and stale registry entries.
        When requesting_user_id is provided, scopes the reconciliation view strictly to accessible documents
        (caller's user:{user_id} scope + global documents) to prevent cross-tenant enumeration.
        """
        if self.is_shared:
            return self._shared_store.reconcile(requesting_user_id)
        with self._lock:
            self._sync_registry_unlocked()
            # Filter registry documents accessible to requesting identity
            accessible_registry = self._registry
            if requesting_user_id is not None or requesting_scope is not None:
                accessible_registry = {
                    doc_id: d for doc_id, d in self._registry.items()
                    if is_scope_accessible(
                        chunk_scope=d.get("scope", "global"),
                        chunk_tenant_id=d.get("tenant_id", "default"),
                        requesting_scope=requesting_scope,
                        requesting_user_id=requesting_user_id,
                        tenant_id="default",
                    )
                }
            registry_doc_ids: Set[str] = set(accessible_registry.keys())

            # Filter vector store chunks accessible to requesting identity
            all_chunks = self.vector_store.get_chunks()
            accessible_chunks = all_chunks
            if requesting_user_id is not None or requesting_scope is not None:
                accessible_chunks = [
                    c for c in all_chunks
                    if is_scope_accessible(
                        chunk_scope=getattr(c, "scope", getattr(c.metadata, "scope", "global")),
                        chunk_tenant_id=getattr(c, "tenant_id", getattr(c.metadata, "tenant_id", "default")),
                        requesting_scope=requesting_scope,
                        requesting_user_id=requesting_user_id,
                        tenant_id="default",
                    )
                ]
            vector_doc_ids: Set[str] = {c.document_id for c in accessible_chunks if c.document_id}

            # 1. Stale registry entries: document in registry but 0 chunks in vector store
            stale_registry_docs = sorted(list(registry_doc_ids - vector_doc_ids))

            # 2. Orphaned vector chunks: chunks exist in vector store but document_id not in registry
            orphaned_vector_docs = sorted(list(vector_doc_ids - registry_doc_ids))

            reconciliation_result = {
                "status": "CLEAN" if not stale_registry_docs and not orphaned_vector_docs else "ANOMALIES_DETECTED",
                "registry_document_count": len(registry_doc_ids),
                "vector_unique_document_count": len(vector_doc_ids),
                "total_chunks": len(accessible_chunks),
                "stale_registry_documents": stale_registry_docs,
                "stale_registry_count": len(stale_registry_docs),
                "orphaned_vector_documents": orphaned_vector_docs,
                "orphaned_vector_count": len(orphaned_vector_docs),
            }

            if stale_registry_docs:
                logger.warning(
                    f"[Reconciliation] Detected {len(stale_registry_docs)} stale registry entries with no index chunks: {stale_registry_docs}"
                )
            if orphaned_vector_docs:
                logger.warning(
                    f"[Reconciliation] Detected {len(orphaned_vector_docs)} orphaned document IDs in vector store without registry entries: {orphaned_vector_docs}"
                )

            return reconciliation_result
