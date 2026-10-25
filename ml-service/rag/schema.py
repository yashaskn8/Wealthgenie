"""
WealthGenie RAG Subsystem - Data Models & Schemas
Defines Pydantic data contracts for documents, chunks, queries, citations, and metrics.
"""

import json
from typing import Dict, Any, List, Optional, Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator

RAG_ABSTENTION_MESSAGE = (
    "I cannot find sufficiently trustworthy, relevant evidence in the approved knowledge base. "
    "No financial or regulatory claim has been generated."
)


def is_scope_accessible(
    chunk_scope: Optional[str],
    chunk_tenant_id: Optional[str] = None,
    requesting_scope: Optional[str] = None,
    requesting_user_id: Optional[str] = None,
    tenant_id: Optional[str] = None,
) -> bool:
    """
    Evaluates whether a chunk with `chunk_scope` / `chunk_tenant_id` is accessible
    to the requesting query context.

    Rules:
    1. A chunk with scope "global", "default", "*", or "public" (AND tenant_id in ("default", "global", None))
       is accessible to all queries.
    2. A private chunk's tenant and scope restrictions BOTH require authorization.
       A mismatched user scope and tenant owner is rejected regardless of caller.
       Public scope with a private tenant remains private.
    3. Never returns another user/tenant's scoped content.
    """
    c_scope = (chunk_scope or "global").strip().lower()
    c_tenant = (chunk_tenant_id or "default").strip().lower()

    # If chunk is explicitly scoped to a non-default tenant
    if c_tenant not in ("default", "global", "") and c_scope in ("global", "default", ""):
        c_scope = c_tenant

    if c_scope in ("global", "default", "*", "public", "") and c_tenant in ("default", "global", ""):
        return True

    allowed_scopes = set()
    if requesting_user_id:
        uid = str(requesting_user_id).strip().lower()
        allowed_scopes.add(uid)
        allowed_scopes.add(f"user:{uid}")

    if requesting_scope:
        s = str(requesting_scope).strip().lower()
        allowed_scopes.add(s)
        if s.startswith("user:"):
            allowed_scopes.add(s[5:])
        else:
            allowed_scopes.add(f"user:{s}")

    if tenant_id and str(tenant_id).strip().lower() not in ("default", "global", ""):
        t = str(tenant_id).strip().lower()
        allowed_scopes.add(t)
        if t.startswith("user:"):
            allowed_scopes.add(t[5:])
        else:
            allowed_scopes.add(f"user:{t}")

    # A private chunk can carry both a scope owner and a tenant owner.
    # Treat these as independent restrictions, never alternatives.  The old
    # OR condition leaked a user:B-scoped chunk to tenant A when its tenant_id
    # was accidentally (or maliciously) set to A.
    public_scope = c_scope in ("global", "default", "*", "public", "")
    public_tenant = c_tenant in ("default", "global", "")
    if c_scope.startswith("user:") and not public_tenant:
        declared_owner = c_scope[5:]
        tenant_owner = c_tenant[5:] if c_tenant.startswith("user:") else c_tenant
        if declared_owner != tenant_owner:
            return False
    scope_allowed = public_scope or c_scope in allowed_scopes
    tenant_allowed = public_tenant or c_tenant in allowed_scopes or f"user:{c_tenant}" in allowed_scopes
    return scope_allowed and tenant_allowed


class DocumentMetadata(BaseModel):
    """Metadata retained for every ingested document."""
    title: str = Field(..., description="Document title")
    source: str = Field(..., description="File path, URL, or authoritative source name")
    publication_date: Optional[str] = Field(None, description="Verified publication date (YYYY-MM-DD); never inferred from ingestion time")
    document_type: str = Field("markdown", description="pdf, markdown, text, html, or csv")
    version: str = Field("1.0", description="Document schema version")
    author: Optional[str] = Field(None, description="Authoring authority (e.g. Income Tax Dept, AMFI)")
    effective_date: Optional[str] = Field(None, description="Verified legal effective date (YYYY-MM-DD); never inferred from ingestion time")
    source_trust_tier: str = Field(
        "unverified_user_input",
        description="Evidence provenance tier; direct input is unverified unless independently authorized and verified.",
    )
    tenant_id: str = Field("default", description="Tenant isolation scope identifier")
    scope: str = Field("global", description="Tenant isolation scope: 'global' for public corpus or 'user:{user_id}' for user-specific documents")
    custom_metadata: Dict[str, Any] = Field(default_factory=dict)


class Document(BaseModel):
    """Raw loaded document representation."""
    document_id: str = Field(..., description="Unique SHA256 or UUID document identifier")
    content: str = Field(..., description="Full text content of document")
    metadata: DocumentMetadata


class ChunkMetadata(DocumentMetadata):
    """Metadata retained for individual document text chunks."""
    chunk_id: str = Field(..., description="Unique chunk identifier document_id#idx")
    document_id: str = Field(..., description="Parent document identifier")
    chunk_index: int = Field(..., description="Ordinal index of chunk within parent document")
    page_number: Optional[int] = Field(None, description="Page number if applicable")
    token_count: int = Field(0, description="Character or token length of chunk")


class TextChunk(BaseModel):
    """Granular chunk used for vector embedding and retrieval."""
    chunk_id: str
    document_id: str
    content: str
    metadata: ChunkMetadata
    tenant_id: str = Field("default", description="Tenant isolation scope identifier")
    scope: str = Field("global", description="Tenant isolation scope: 'global' or 'user:{user_id}'")
    lifecycle_state: Literal["PENDING", "ACTIVE", "SUPERSEDED", "SOFT_DELETED", "DELETED", "QUARANTINED", "FAILED"] = "ACTIVE"
    document_revision_id: Optional[str] = None
    embedding: Optional[List[float]] = None
    embedding_identity: Optional[Dict[str, Any]] = None


class RetrievedChunk(BaseModel):
    """Chunk retrieved during vector search along with score and rank."""
    chunk: TextChunk
    score: float = Field(..., description="Cosine similarity score [0.0, 1.0]")
    rank: int = Field(..., description="Retrieval rank position (1-based)")


class Citation(BaseModel):
    """Structured reference citation attached to generated advisory responses."""
    citation_id: int = Field(..., description="Numerical reference index [1], [2], ...")
    document_title: str
    source: str
    chunk_id: str
    excerpt: str = Field(..., description="Relevant supporting text excerpt")
    relevance_score: float


class RAGQueryRequest(BaseModel):
    """Request payload for RAG query execution."""
    model_config = ConfigDict(extra="forbid")

    question: str = Field(..., min_length=3, max_length=2000, description="User advisory question")
    jurisdiction: str = Field("IN", min_length=2, max_length=2, pattern=r"^[A-Z]{2}$", description="ISO alpha-2 jurisdiction requested; only IN is currently supported")
    top_k: Optional[int] = Field(None, ge=1, le=20, description="Override default top-k retrieval count")
    tenant_id: str = Field("default", max_length=128, description="Tenant isolation scope identifier")
    user_id: Optional[str] = Field(None, max_length=128, description="Requesting user ID for scoped retrieval")
    scope: Optional[str] = Field(None, max_length=256, description="Explicit retrieval scope (e.g. 'global' or 'user:{user_id}')")
    user_profile: Optional[Dict[str, Any]] = Field(default_factory=dict, max_length=64, description="Contextual investor profile")

    @field_validator("user_profile")
    @classmethod
    def user_profile_payload_is_bounded(cls, value):
        if value is None:
            return {}
        try:
            serialized = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        except (TypeError, ValueError, RecursionError) as exc:
            raise ValueError("user_profile must be a bounded JSON object") from exc
        if len(serialized.encode("utf-8")) > 16_384:
            raise ValueError("user_profile exceeds the 16384-byte request limit")
        return value
    include_citations: bool = Field(True, description="Whether to format inline citations")


class RAGQueryResponse(BaseModel):
    """Extractive retrieval or explicit abstention returned by the RAG pipeline."""
    answer: str = Field(..., description="Extractive evidence response or explicit abstention")
    citations: List[Citation] = Field(default_factory=list)
    retrieved_chunks: List[RetrievedChunk] = Field(default_factory=list)
    metrics: Dict[str, Any] = Field(default_factory=dict, description="Retrieval and response-construction diagnostics")
    grounded: bool = Field(False, description="True only when trustworthy, sufficiently relevant evidence was returned")
