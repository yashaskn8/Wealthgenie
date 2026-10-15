"""Transaction-backed RAG document lifecycle and immutable corpus generations."""

from __future__ import annotations

import copy
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from pymongo.errors import DuplicateKeyError, OperationFailure

from rag.lifecycle.errors import DocumentOwnershipError
from rag.corpus_generation import (
    canonical_member,
    current_manifest_sha256,
    generation_digest,
    normalize_generation_identity,
)
from rag.embeddings.identity import EmbeddingIdentityError
from rag.schema import Document, TextChunk, is_scope_accessible


class MongoRAGLifecycleStore:
    """Own immutable generation manifests and document revisions transactionally."""

    is_shared = True
    STATE_ID = "active_corpus"
    GENERATION_SCHEMA_VERSION = 1

    def __init__(self, client: Any, database: Any, vector_collection: str = "vector_chunks"):
        self.client = client
        self.database = database
        self.revisions = database["rag_document_revisions"]
        self.chunks = database[vector_collection]
        self.generations = database["rag_corpus_generations"]
        self.members = database["rag_corpus_generation_members"]
        self.corpus_state = database["rag_corpus_state"]
        self._before_generation_record_insert = None

    def initialize_corpus_generation(self, embedding_identity: dict[str, Any]) -> dict[str, Any]:
        """Explicit one-shot bootstrap; never called as an application-startup repair."""
        identity = normalize_generation_identity(embedding_identity)
        current = self._read_pointer()
        if current:
            if current.get("embedding_identity") != identity:
                raise RuntimeError("active RAG generation uses a different embedding identity")
            return self._clean_generation(current)

        generation_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        try:
            with self.client.start_session() as session:
                with session.start_transaction():
                    if self._read_pointer(session=session):
                        raise RuntimeError("RAG corpus generation was initialized concurrently")
                    active_revision_ids = {
                        item["document_revision_id"]
                        for item in self.revisions.find({"lifecycle_state": "ACTIVE"}, session=session)
                    }
                    orphan_active = list(self.chunks.find(
                        {"lifecycle_state": "ACTIVE", "document_revision_id": {"$nin": list(active_revision_ids)}},
                        {"_id": 0, "chunk_id": 1}, session=session,
                    ))
                    if orphan_active:
                        raise RuntimeError("cannot bootstrap a corpus generation with orphan active chunks")
                    if active_revision_ids:
                        self.chunks.update_many(
                            {"lifecycle_state": "ACTIVE", "document_revision_id": {"$in": list(active_revision_ids)}},
                            {"$set": {"corpus_generation_id": generation_id}}, session=session,
                        )
                    self._publish_generation(session, generation_id, now, identity)
        except (DuplicateKeyError, OperationFailure) as exc:
            if isinstance(exc, DuplicateKeyError) or getattr(exc, "code", None) == 112:
                raise RuntimeError("RAG corpus bootstrap lost a concurrent state race") from exc
            raise
        return self._clean_generation(self._read_pointer() or {})

    def get_active_generation(self) -> Optional[dict[str, Any]]:
        pointer = self._read_pointer()
        if not pointer:
            return None
        pointer = self._clean_generation(pointer)
        generation = self.generations.find_one(
            {"generation_id": pointer.get("generation_id")}, {"_id": 0}
        )
        if not generation or any(
            pointer.get(field) != generation.get(field)
            for field in ("generation_id", "revision", "manifest_sha256", "membership_sha256", "embedding_identity")
        ):
            raise RuntimeError("active RAG generation pointer does not match its immutable generation")
        return generation

    def _read_pointer(self, session=None) -> Optional[dict[str, Any]]:
        options = {"session": session} if session is not None else {}
        pointer = self.corpus_state.find_one({"_id": self.STATE_ID}, **options)
        count = self.corpus_state.count_documents({}, **options)
        if count > (1 if pointer else 0):
            raise RuntimeError("RAG corpus state contains malformed or duplicate active-generation pointers")
        if count and pointer is None:
            raise RuntimeError("RAG corpus state contains no valid singleton active-generation pointer")
        return pointer

    def commit_document_revision(self, document: Document, chunks: list[TextChunk]) -> dict[str, Any]:
        scope = document.metadata.scope or "global"
        tenant_id = document.metadata.tenant_id or "default"
        owner = document.metadata.custom_metadata.get("owner_user_id")
        if not owner and scope.startswith("user:"):
            owner = scope[5:]
        revision_id = str(uuid.uuid4())
        generation_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        identity = self._identity_for_chunks(chunks)
        document_identity = {"document_id": document.document_id, "scope": scope}
        try:
            with self.client.start_session() as session:
                with session.start_transaction():
                    self._assert_identity_matches_current(identity, session)
                    previous = self.revisions.find_one(
                        {**document_identity, "lifecycle_state": "ACTIVE"}, session=session
                    )
                    latest = self.revisions.find_one(
                        document_identity, sort=[("version_number", -1)], session=session
                    )
                    version = int(latest.get("version_number", 0)) + 1 if latest else 1
                    self.revisions.insert_one(
                        self._revision_document(document, revision_id, version, len(chunks), owner, now, "PENDING"),
                        session=session,
                    )
                    documents = []
                    for position, chunk in enumerate(chunks):
                        payload = chunk.model_dump()
                        unique_chunk_id = f"{chunk.chunk_id}@{revision_id}"
                        payload["chunk_id"] = unique_chunk_id
                        payload["metadata"]["chunk_id"] = unique_chunk_id
                        payload.update({
                            "document_revision_id": revision_id,
                            "corpus_generation_id": generation_id,
                            "lifecycle_state": "PENDING",
                            "revision_chunk_index": position,
                            "scope": scope,
                            "tenant_id": tenant_id,
                            "embedding_identity": identity,
                        })
                        documents.append(payload)
                    if not documents:
                        raise ValueError("document revision has no complete chunk set")
                    self.chunks.insert_many(documents, ordered=True, session=session)
                    if self.chunks.count_documents({"document_revision_id": revision_id}, session=session) != len(chunks):
                        raise RuntimeError("document revision chunk set is incomplete")
                    if previous:
                        self._transition_revision(previous["document_revision_id"], "SUPERSEDED", now, session)
                    self._transition_revision(revision_id, "ACTIVE", now, session)
                    self._publish_generation(session, generation_id, now, identity)
        except (DuplicateKeyError, OperationFailure) as exc:
            if isinstance(exc, DuplicateKeyError) or getattr(exc, "code", None) == 112:
                raise RuntimeError("concurrent document revision activation conflict; retry ingestion") from exc
            raise
        return self.revisions.find_one({"document_revision_id": revision_id}, {"_id": 0})

    def list_documents(
        self,
        include_inactive: bool = False,
        requesting_user_id: Optional[str] = None,
        requesting_scope: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        query = {} if include_inactive else {"lifecycle_state": "ACTIVE"}
        revisions = list(self.revisions.find(query, {"_id": 0}).sort("version_number", -1))
        latest: dict[tuple[str, str], dict[str, Any]] = {}
        for revision in revisions:
            key = (revision["document_id"], revision.get("scope", "global"))
            if key in latest:
                continue
            if (requesting_user_id is not None or requesting_scope is not None) and not is_scope_accessible(
                revision.get("scope", "global"), revision.get("tenant_id", "default"),
                requesting_scope=requesting_scope, requesting_user_id=requesting_user_id, tenant_id="default",
            ):
                continue
            record = dict(revision)
            record["is_active"] = revision.get("lifecycle_state") == "ACTIVE"
            latest[key] = record
        return list(latest.values())

    def soft_delete_document(self, document_id: str, requesting_user_id: Optional[str] = None) -> bool:
        active = list(self.revisions.find({"document_id": document_id, "lifecycle_state": "ACTIVE"}))
        if not active:
            return False
        self._assert_owner(active, requesting_user_id)
        now, generation_id = datetime.now(timezone.utc).isoformat(), str(uuid.uuid4())
        with self.client.start_session() as session:
            with session.start_transaction():
                for revision in active:
                    self._transition_revision(revision["document_revision_id"], "SOFT_DELETED", now, session)
                self._publish_generation(session, generation_id, now)
        return True

    def hard_delete_document(self, document_id: str, requesting_user_id: Optional[str] = None) -> bool:
        revisions = list(self.revisions.find({"document_id": document_id}))
        if not revisions:
            return False
        self._assert_owner(revisions, requesting_user_id)
        now, generation_id = datetime.now(timezone.utc).isoformat(), str(uuid.uuid4())
        with self.client.start_session() as session:
            with session.start_transaction():
                self.chunks.delete_many({"document_id": document_id}, session=session)
                self.revisions.delete_many({"document_id": document_id}, session=session)
                self._publish_generation(session, generation_id, now)
        return True

    def update_metadata(
        self, document_id: str, title: Optional[str], author: Optional[str],
        requesting_user_id: Optional[str] = None,
    ) -> bool:
        active = list(self.revisions.find({"document_id": document_id, "lifecycle_state": "ACTIVE"}))
        if not active:
            return False
        self._assert_owner(active, requesting_user_id)
        now, generation_id = datetime.now(timezone.utc).isoformat(), str(uuid.uuid4())
        with self.client.start_session() as session:
            with session.start_transaction():
                for previous in active:
                    old_id = previous["document_revision_id"]
                    new_id = str(uuid.uuid4())
                    new_revision = copy.deepcopy(previous)
                    new_revision.pop("_id", None)
                    new_revision.update({
                        "document_revision_id": new_id,
                        "version_number": int(previous.get("version_number", 0)) + 1,
                        "lifecycle_state": "PENDING",
                        "created_at_utc": now,
                        "updated_at_utc": now,
                    })
                    if title:
                        new_revision["title"] = title
                    if author:
                        new_revision["author"] = author
                    self.revisions.insert_one(new_revision, session=session)
                    old_chunks = list(self.chunks.find({"document_revision_id": old_id}, {"_id": 0}, session=session))
                    if not old_chunks:
                        raise RuntimeError("active document revision has no chunks")
                    copies = []
                    for old_chunk in old_chunks:
                        new_chunk = copy.deepcopy(old_chunk)
                        new_chunk["chunk_id"] = f"{old_chunk['chunk_id']}@{new_id}"
                        new_chunk["metadata"]["chunk_id"] = new_chunk["chunk_id"]
                        new_chunk["metadata"]["title"] = new_revision.get("title")
                        new_chunk["metadata"]["author"] = new_revision.get("author")
                        new_chunk["document_revision_id"] = new_id
                        new_chunk["corpus_generation_id"] = generation_id
                        new_chunk["lifecycle_state"] = "PENDING"
                        copies.append(new_chunk)
                    self.chunks.insert_many(copies, ordered=True, session=session)
                    self._transition_revision(old_id, "SUPERSEDED", now, session)
                    self._transition_revision(new_id, "ACTIVE", now, session)
                self._publish_generation(session, generation_id, now)
        return True

    def reconcile(self, requesting_user_id: Optional[str] = None) -> dict[str, Any]:
        revisions = list(self.revisions.find({}, {"_id": 0}))
        chunks = list(self.chunks.find({}, {"_id": 0, "document_id": 1, "document_revision_id": 1, "scope": 1, "tenant_id": 1}))
        if requesting_user_id is not None:
            revisions = [row for row in revisions if is_scope_accessible(row.get("scope"), row.get("tenant_id"), requesting_user_id=requesting_user_id)]
            visible_ids = {row["document_revision_id"] for row in revisions}
            chunks = [row for row in chunks if row.get("document_revision_id") in visible_ids or (not row.get("document_revision_id") and row.get("scope") == "global")]
        revision_ids = {row["document_revision_id"] for row in revisions}
        chunk_revision_ids = {row.get("document_revision_id") for row in chunks}
        orphan_revision_ids = sorted(str(value) for value in chunk_revision_ids - revision_ids if value)
        active_without_chunks = sorted(
            row["document_revision_id"] for row in revisions
            if row.get("lifecycle_state") == "ACTIVE" and row["document_revision_id"] not in chunk_revision_ids
        )
        return {
            "status": "CLEAN" if not orphan_revision_ids and not active_without_chunks else "ANOMALIES_DETECTED",
            "document_revision_count": len(revisions), "chunk_count": len(chunks),
            "orphan_document_revision_ids": orphan_revision_ids,
            "active_revisions_without_chunks": active_without_chunks,
        }

    def _publish_generation(self, session, generation_id: str, now: str, expected_identity=None) -> dict[str, Any]:
        active_revisions = list(self.revisions.find({"lifecycle_state": "ACTIVE"}, {"_id": 0}, session=session))
        active_ids = {row["document_revision_id"] for row in active_revisions}
        active_chunks = list(self.chunks.find({"lifecycle_state": "ACTIVE"}, {"_id": 0}, session=session))
        if any(row.get("document_revision_id") not in active_ids for row in active_chunks):
            raise RuntimeError("cannot publish RAG generation with orphan active chunks")
        members = []
        identities = []
        for revision in active_revisions:
            revision_chunks = [row for row in active_chunks if row.get("document_revision_id") == revision["document_revision_id"]]
            if len(revision_chunks) != revision.get("chunk_count") or not revision_chunks:
                raise RuntimeError("cannot publish RAG generation with an incomplete active revision")
            try:
                identities.extend(normalize_generation_identity(row.get("embedding_identity")) for row in revision_chunks)
            except EmbeddingIdentityError as exc:
                raise RuntimeError("cannot publish RAG generation with invalid embedding identity") from exc
            members.append(canonical_member(revision, revision_chunks))
        pointer = self._read_pointer(session=session)
        identity = identities[0] if identities else (expected_identity or (pointer or {}).get("embedding_identity"))
        if identity is None:
            raise RuntimeError("RAG corpus generation requires an explicit embedding identity")
        identity = normalize_generation_identity(identity)
        if expected_identity is not None and normalize_generation_identity(expected_identity) != identity:
            raise RuntimeError("RAG corpus generation cannot mix embedding spaces")
        if any(item != identity for item in identities):
            raise RuntimeError("RAG corpus generation contains mixed embedding identities")
        legacy_state = self.database["rag_state"].find_one({"_id": self.STATE_ID}, session=session) or {}
        latest_generation = self.generations.find_one({}, {"revision": 1}, sort=[("revision", -1)], session=session) or {}
        revision_number = max(
            int((pointer or {}).get("revision", 0)),
            int(legacy_state.get("revision", 0)),
            int(latest_generation.get("revision", 0)),
        ) + 1
        manifest_hash = current_manifest_sha256()
        membership_hash = generation_digest(members)
        generation = {
            "generation_schema_version": self.GENERATION_SCHEMA_VERSION,
            "generation_id": generation_id,
            "revision": revision_number,
            "manifest_sha256": manifest_hash,
            "embedding_identity": identity,
            "membership_sha256": membership_hash,
            "document_count": len(members),
            "chunk_count": sum(member["chunk_count"] for member in members),
            "created_at_utc": now,
        }
        if members:
            self.members.insert_many(
                [{"generation_id": generation_id, **member} for member in members],
                ordered=True, session=session,
            )
        barrier = self._before_generation_record_insert
        if callable(barrier):
            barrier(generation_id)
        # PyMongo adds a generated _id to the inserted document in place. Never
        # let that mutate the canonical generation payload used for the pointer.
        self.generations.insert_one(copy.deepcopy(generation), session=session)
        new_pointer = {**generation, "_id": self.STATE_ID}
        if pointer:
            result = self.corpus_state.update_one(
                {"_id": self.STATE_ID, "generation_id": pointer.get("generation_id"), "revision": pointer.get("revision")},
                {"$set": {key: value for key, value in new_pointer.items() if key != "_id"}},
                session=session,
            )
            if result.matched_count != 1:
                raise RuntimeError("RAG corpus active generation changed concurrently")
        else:
            self.corpus_state.insert_one(new_pointer, session=session)
        return generation

    def _assert_identity_matches_current(self, identity: dict[str, Any], session) -> None:
        pointer = self._read_pointer(session=session)
        if pointer and pointer.get("embedding_identity") != identity:
            raise RuntimeError("RAG ingestion embedding identity differs from active corpus generation")

    def _transition_revision(self, revision_id: str, state: str, now: str, session) -> None:
        result = self.revisions.update_one(
            {"document_revision_id": revision_id, "lifecycle_state": {"$in": ["PENDING", "ACTIVE"]}},
            {"$set": {"lifecycle_state": state, "updated_at_utc": now}}, session=session,
        )
        if result.matched_count != 1:
            raise RuntimeError("document lifecycle state changed during transaction")
        self.chunks.update_many(
            {"document_revision_id": revision_id, "lifecycle_state": {"$in": ["PENDING", "ACTIVE"]}},
            {"$set": {"lifecycle_state": state}}, session=session,
        )

    @staticmethod
    def _identity_for_chunks(chunks: list[TextChunk]) -> dict[str, Any]:
        if not chunks:
            raise ValueError("document revision requires at least one chunk")
        identities = [normalize_generation_identity(chunk.embedding_identity) for chunk in chunks]
        if any(identity != identities[0] for identity in identities[1:]):
            raise ValueError("document revision contains mixed embedding identities")
        if any(chunk.embedding is None or len(chunk.embedding) != identities[0]["embedding_dimension"] for chunk in chunks):
            raise ValueError("document revision embedding does not match its identity")
        return identities[0]

    @staticmethod
    def _assert_owner(revisions: list[dict[str, Any]], requesting_user_id: Optional[str]) -> None:
        if requesting_user_id is None:
            return
        for revision in revisions:
            scope = revision.get("scope", "global")
            owner = revision.get("owner_user_id") or (scope[5:] if scope.startswith("user:") else None)
            if owner != requesting_user_id:
                raise DocumentOwnershipError("document is not owned by the verified user")

    @staticmethod
    def _revision_document(document, revision_id, version, chunk_count, owner, now, state):
        metadata = document.metadata.model_dump()
        return {
            "document_revision_id": revision_id, "document_id": document.document_id,
            "version_number": version, "lifecycle_state": state,
            "title": metadata.get("title"), "source": metadata.get("source"),
            "document_type": metadata.get("document_type"), "author": metadata.get("author"),
            "publication_date": metadata.get("publication_date"), "effective_date": metadata.get("effective_date"),
            "source_trust_tier": metadata.get("source_trust_tier"),
            "custom_metadata": metadata.get("custom_metadata", {}), "chunk_count": chunk_count,
            "scope": metadata.get("scope", "global"), "owner_user_id": owner,
            "tenant_id": metadata.get("tenant_id", "default"),
            "created_at_utc": now, "updated_at_utc": now,
        }

    @staticmethod
    def _clean_generation(record: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in record.items() if key != "_id"}
