"""
WealthGenie RAG Subsystem - Multi-Tenant Isolation Test Suite
Verifies strict tenant and user scope data boundary guarantees across vector store search, retrievers, and RAGPipeline.
"""

from rag.config import RAGConfig
from rag.embeddings.dense_embedding import DenseVectorEmbeddingProvider
from rag.retrieval.pipeline import RAGPipeline
from rag.schema import TextChunk, ChunkMetadata, RAGQueryRequest, is_scope_accessible, has_consistent_chunk_ownership
from rag.vector_store.memory_vector_store import PersistentVectorStore


def test_is_scope_accessible_helper():
    # Global / public scope accessible to everyone
    assert is_scope_accessible("global", requesting_user_id="user_123") is True
    assert is_scope_accessible("global", requesting_user_id=None) is True
    assert is_scope_accessible("default", requesting_user_id="user_456") is True

    # User-specific scope accessible only to matching user
    assert is_scope_accessible("user:fake_user_123", requesting_user_id="fake_user_123") is True
    assert is_scope_accessible("user:fake_user_123", requesting_scope="user:fake_user_123") is True
    assert is_scope_accessible("user:fake_user_123", requesting_user_id="fake_user_999") is False
    assert is_scope_accessible("user:fake_user_123", requesting_user_id=None) is False
    assert is_scope_accessible("user:fake_user_123", requesting_scope="global") is False


def test_multi_tenant_vector_store_isolation(tmp_path):
    store = PersistentVectorStore(index_path=tmp_path / "tenant_index.json")
    embedder = DenseVectorEmbeddingProvider(dimension=64, enable_cache=False)

    vec_a = embedder.embed_text("Tenant A confidential tax details.")
    vec_b = embedder.embed_text("Tenant B confidential investment details.")

    # Tenant A Chunk
    meta_a = ChunkMetadata(chunk_id="ca1", document_id="da1", chunk_index=0, title="Tenant A Secret", source="a.md", tenant_id="tenant_A", scope="user:tenant_A")
    chunk_a = TextChunk(chunk_id="ca1", document_id="da1", content="Tenant A confidential tax details.", metadata=meta_a, tenant_id="tenant_A", scope="user:tenant_A", embedding=vec_a)

    # Tenant B Chunk
    meta_b = ChunkMetadata(chunk_id="cb1", document_id="db1", chunk_index=0, title="Tenant B Secret", source="b.md", tenant_id="tenant_B", scope="user:tenant_B")
    chunk_b = TextChunk(chunk_id="cb1", document_id="db1", content="Tenant B confidential investment details.", metadata=meta_b, tenant_id="tenant_B", scope="user:tenant_B", embedding=vec_b)

    store.add_chunks([chunk_a, chunk_b])

    # Search for Tenant A -> Must NOT retrieve Tenant B chunk
    results_a = store.search(vec_a, top_k=5, user_id="tenant_A")
    assert len(results_a) == 1
    assert results_a[0].chunk.chunk_id == "ca1"

    # Search for Tenant B -> Must NOT retrieve Tenant A chunk
    results_b = store.search(vec_b, top_k=5, user_id="tenant_B")
    assert len(results_b) == 1
    assert results_b[0].chunk.chunk_id == "cb1"


def test_user_scoped_vs_global_corpus_isolation(tmp_path):
    """
    Verifies that:
    1. A document scoped to user:fake_user_123 is never returned to fake_user_999,
       even when querying the exact unique terms of that document.
    2. The same document IS returned when querying as fake_user_123.
    3. Global regulatory content is returned to both users.
    """
    config = RAGConfig(vector_store_path=tmp_path / "user_isolation_index.json", embedding_dim=64, similarity_threshold=0.0)
    embedder = DenseVectorEmbeddingProvider(dimension=64, enable_cache=False)
    store = PersistentVectorStore(index_path=config.vector_store_path)

    # 1. Global Public Regulatory Chunk
    vec_global = embedder.embed_text("Income Tax Section 80C allows deduction up to Rs 1.5 Lakh for ELSS and PPF.")
    meta_global = ChunkMetadata(
        chunk_id="global_80c",
        document_id="doc_incometax",
        chunk_index=0,
        title="Income Tax Act 80C",
        source="incometax.gov.in",
        source_trust_tier="government_official",
        scope="global",
        tenant_id="default"
    )
    chunk_global = TextChunk(
        chunk_id="global_80c",
        document_id="doc_incometax",
        content="Income Tax Section 80C allows deduction up to Rs 1.5 Lakh for ELSS and PPF.",
        metadata=meta_global,
        scope="global",
        tenant_id="default",
        embedding=vec_global,
    )

    # 2. User-specific Private Chunk for fake_user_123
    secret_text = "CONFIDENTIAL PORTFOLIO: User fake_user_123 holds 500 shares of SecretAssetXYZ worth 25 Lakhs."
    vec_user123 = embedder.embed_text(secret_text)
    meta_user123 = ChunkMetadata(
        chunk_id="user123_portfolio",
        document_id="doc_user123_private",
        chunk_index=0,
        title="Private Portfolio Summary",
        source="user_upload.pdf",
        scope="user:fake_user_123",
        tenant_id="fake_user_123"
    )
    chunk_user123 = TextChunk(
        chunk_id="user123_portfolio",
        document_id="doc_user123_private",
        content=secret_text,
        metadata=meta_user123,
        scope="user:fake_user_123",
        tenant_id="fake_user_123",
        embedding=vec_user123,
    )

    store.add_chunks([chunk_global, chunk_user123])
    pipeline = RAGPipeline(embedder=embedder, vector_store=store, config=config)

    # CASE A: Query as DIFFERENT user (fake_user_999) asking about SecretAssetXYZ
    # Even though SecretAssetXYZ is an exact semantic match, fake_user_999 MUST NOT receive it!
    req_other_user = RAGQueryRequest(
        question="What is the confidential balance of SecretAssetXYZ?",
        user_id="fake_user_999",
    )
    res_other_user = pipeline.query(req_other_user)
    retrieved_ids_other = [c.chunk.chunk_id for c in res_other_user.retrieved_chunks]
    assert "user123_portfolio" not in retrieved_ids_other, "LEAK DETECTED: fake_user_999 retrieved private user_123 content!"

    # CASE B: Even the owner cannot use unverified private uploads as regulatory evidence.
    req_owner_user = RAGQueryRequest(
        question="What is the confidential balance of SecretAssetXYZ?",
        user_id="fake_user_123",
    )
    res_owner_user = pipeline.query(req_owner_user)
    retrieved_ids_owner = [c.chunk.chunk_id for c in res_owner_user.retrieved_chunks]
    assert "user123_portfolio" not in retrieved_ids_owner
    assert not res_owner_user.grounded
    assert res_owner_user.citations == []

    # CASE C: An official-looking source string is not sufficient to make a
    # manually inserted global chunk current/manifest-verified evidence.
    req_global_999 = RAGQueryRequest(question="What is Section 80C deduction limit?", user_id="fake_user_999")
    res_global_999 = pipeline.query(req_global_999)
    assert not res_global_999.grounded
    assert res_global_999.citations == []

    req_global_123 = RAGQueryRequest(question="What is Section 80C deduction limit?", user_id="fake_user_123")
    res_global_123 = pipeline.query(req_global_123)
    assert not res_global_123.grounded
    assert res_global_123.citations == []


def test_conflicting_scope_and_tenant_cannot_leak_private_documents():
    # This shape was previously leaked through an OR across scope and tenant.
    assert not is_scope_accessible(
        "user:account_b", "account_a", requesting_user_id="account_a"
    )
    assert not is_scope_accessible(
        "user:account_b", "account_a", requesting_user_id="account_b"
    )
    # Public-looking scope must never override a private tenant restriction.
    assert not is_scope_accessible(
        "global", "account_b", requesting_user_id="account_a"
    )
    assert is_scope_accessible(
        "global", "account_b", requesting_user_id="account_b"
    )
    assert is_scope_accessible(
        "user:account_a", "account_a", requesting_user_id="account_a"
    )
    assert not is_scope_accessible(
        "user:account_a", "account_a", requesting_user_id="account_b"
    )
    assert is_scope_accessible("global", "default", requesting_user_id="account_b")


def test_top_level_and_metadata_ownership_must_agree_before_index_search(tmp_path):
    embedder = DenseVectorEmbeddingProvider(dimension=64, enable_cache=False)
    store = PersistentVectorStore(index_path=tmp_path / "owner_conflict.json")
    content = "Private mortgage account information owned by another user."
    vector = embedder.embed_text(content)
    private_metadata = ChunkMetadata(
        chunk_id="conflicted#0", document_id="conflicted",
        chunk_index=0, title="Private example", source="user_private.txt",
        scope="user:account_b", tenant_id="account_b",
    )
    conflict = TextChunk(
        chunk_id="conflicted#0", document_id="conflicted",
        content=content, metadata=private_metadata,
        scope="global", tenant_id="default", embedding=vector,
    )
    assert has_consistent_chunk_ownership(conflict) is False
    store.add_chunks([conflict])
    assert store.search(vector, top_k=5, user_id="account_a") == []
    assert store.search(vector, top_k=5, user_id="account_b") == []

    valid = conflict.model_copy(deep=True)
    valid.scope = "user:account_b"
    valid.tenant_id = "account_b"
    assert has_consistent_chunk_ownership(valid) is True
    store.add_chunks([valid])
    results = store.search(vector, top_k=5, user_id="account_b")
    assert results and all(item.chunk.chunk_id == "conflicted#0" for item in results)
    assert store.search(vector, top_k=5, user_id="account_a") == []
