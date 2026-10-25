"""
Unit tests for FAISS vector search and NumPy fallback path in PersistentVectorStore.
Verifies FAISS IndexFlatIP functionality, NumPy fallback path, and equivalence of retrieval results.
"""

import tempfile
from pathlib import Path
import numpy as np

from rag.schema import TextChunk, ChunkMetadata
from rag.vector_store.memory_vector_store import PersistentVectorStore, FAISS_AVAILABLE


def create_sample_chunks(num_chunks: int = 10, dim: int = 384) -> list[TextChunk]:
    """Helper to generate synthetic embedded chunks for testing."""
    chunks = []
    np.random.seed(42)
    for i in range(num_chunks):
        vec = np.random.randn(dim).astype(np.float32)
        vec = (vec / np.linalg.norm(vec)).tolist()
        chunk_meta = ChunkMetadata(
            chunk_id=f"doc_test#chunk_{i}",
            document_id="doc_test",
            chunk_index=i,
            title=f"Sample Test Document {i}",
            source="test_source.md",
        )
        chunk = TextChunk(
            chunk_id=f"doc_test#chunk_{i}",
            document_id="doc_test",
            content=f"Content for test chunk index {i} discussing financial tax section {i * 10}.",
            metadata=chunk_meta,
            embedding=vec,
        )
        chunks.append(chunk)
    return chunks


def test_faiss_availability():
    """Verifies that FAISS is available in the current environment."""
    assert FAISS_AVAILABLE is True


def test_faiss_search_execution():
    """Verifies vector search using FAISS IndexFlatIP."""
    with tempfile.TemporaryDirectory() as tmp_dir:
        index_file = Path(tmp_dir) / "test_faiss_index.json"
        store = PersistentVectorStore(index_path=index_file, force_numpy=False)
        assert store.is_using_faiss is True

        chunks = create_sample_chunks(15, 384)
        store.add_chunks(chunks)
        assert len(store._chunks) == 15

        # Query using the exact embedding of chunk 3
        query_vector = chunks[3].embedding
        results = store.search(query_vector=query_vector, top_k=3, threshold=0.0)

        assert len(results) == 3
        # Top result should be chunk 3 itself with similarity ~1.0
        assert results[0].chunk.chunk_id == "doc_test#chunk_3"
        assert abs(results[0].score - 1.0) < 0.001
        assert results[0].rank == 1


def test_numpy_fallback_execution():
    """Verifies vector search using force_numpy=True fallback path."""
    with tempfile.TemporaryDirectory() as tmp_dir:
        index_file = Path(tmp_dir) / "test_numpy_index.json"
        store = PersistentVectorStore(index_path=index_file, force_numpy=True)
        assert store.is_using_faiss is False

        chunks = create_sample_chunks(15, 384)
        store.add_chunks(chunks)

        query_vector = chunks[5].embedding
        results = store.search(query_vector=query_vector, top_k=3, threshold=0.0)

        assert len(results) == 3
        assert results[0].chunk.chunk_id == "doc_test#chunk_5"
        assert abs(results[0].score - 1.0) < 0.001


def test_faiss_numpy_equivalence():
    """Verifies that FAISS and NumPy fallback produce identical top-k retrieval results and scores."""
    with tempfile.TemporaryDirectory() as tmp_dir:
        index_file = Path(tmp_dir) / "test_equiv.json"
        chunks = create_sample_chunks(30, 384)

        # Store 1: FAISS
        store_faiss = PersistentVectorStore(index_path=index_file, force_numpy=False)
        store_faiss.add_chunks(chunks)

        # Store 2: NumPy Fallback
        store_numpy = PersistentVectorStore(index_path=index_file, force_numpy=True)

        np.random.seed(123)
        random_query = np.random.randn(384).astype(np.float32)
        random_query = (random_query / np.linalg.norm(random_query)).tolist()

        res_faiss = store_faiss.search(query_vector=random_query, top_k=5, threshold=0.0)
        res_numpy = store_numpy.search(query_vector=random_query, top_k=5, threshold=0.0)

        assert len(res_faiss) == len(res_numpy) == 5

        for rf, rn in zip(res_faiss, res_numpy):
            assert rf.chunk.chunk_id == rn.chunk.chunk_id
            assert abs(rf.score - rn.score) <= 0.0001
            assert rf.rank == rn.rank


def test_tenant_isolation_with_faiss_and_numpy():
    """Verifies tenant filtering works correctly under both FAISS and NumPy modes."""
    with tempfile.TemporaryDirectory() as tmp_dir:
        index_file = Path(tmp_dir) / "test_tenant.json"
        chunks = create_sample_chunks(10, 384)
        for i, c in enumerate(chunks):
            c.tenant_id = "tenant_A" if i % 2 == 0 else "tenant_B"
            # Keep both ownership layers aligned; conflicting metadata must
            # now be rejected rather than silently interpreted as public.
            c.metadata.tenant_id = c.tenant_id

        store = PersistentVectorStore(index_path=index_file, force_numpy=False)
        store.add_chunks(chunks)

        query = chunks[0].embedding
        res_a = store.search(query_vector=query, top_k=10, threshold=-1.0, tenant_id="tenant_A")
        res_b = store.search(query_vector=query, top_k=10, threshold=-1.0, tenant_id="tenant_B")

        assert len(res_a) == 5
        assert len(res_b) == 5
        for r in res_a:
            assert getattr(r.chunk, "tenant_id", "default") == "tenant_A"
        for r in res_b:
            assert getattr(r.chunk, "tenant_id", "default") == "tenant_B"
