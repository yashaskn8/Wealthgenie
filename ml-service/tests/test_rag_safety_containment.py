from typing import List

from rag.config import RAGConfig
from rag.embeddings.dense_embedding import DenseVectorEmbeddingProvider
from rag.retrieval.pipeline import RAGPipeline
from rag.retrievers.base import BaseRetriever
from rag.schema import ChunkMetadata, RAGQueryRequest, RetrievedChunk, TextChunk


def _chunk(chunk_id: str, content: str, *, score: float = 0.9, tier: str = "government_official"):
    metadata = ChunkMetadata(
        chunk_id=chunk_id,
        document_id=f"doc-{chunk_id}",
        chunk_index=0,
        title="Income Tax Authority Guidance",
        source="https://www.incometaxindia.gov.in/official/guidance",
        source_trust_tier=tier,
    )
    chunk = TextChunk(
        chunk_id=chunk_id,
        document_id=metadata.document_id,
        content=content,
        metadata=metadata,
    )
    return RetrievedChunk(chunk=chunk, score=score, rank=1)


class StaticRetriever(BaseRetriever):
    def __init__(self, chunks: List[RetrievedChunk]):
        self.chunks = chunks

    @property
    def strategy_name(self) -> str:
        return "static_test"

    def retrieve(self, *args, **kwargs) -> List[RetrievedChunk]:
        return self.chunks


class UnavailableRetriever(StaticRetriever):
    def retrieve(self, *args, **kwargs):
        raise RuntimeError("vector store unavailable")


def _pipeline(retriever: BaseRetriever) -> RAGPipeline:
    return RAGPipeline(
        embedder=DenseVectorEmbeddingProvider(dimension=64, enable_cache=False),
        retriever=retriever,
        config=RAGConfig(similarity_threshold=0.1),
    )


def test_unmanifested_official_looking_evidence_is_rejected():
    evidence = _chunk("tax-1", "Section 80C permits eligible deductions up to the statutory limit.")
    response = _pipeline(StaticRetriever([evidence])).query(
        RAGQueryRequest(question="What deduction is available under Section 80C?")
    )
    assert response.grounded is False
    assert response.retrieved_chunks == []
    assert response.citations == []


def test_out_of_domain_query_abstains_without_retrieval_or_citations():
    evidence = _chunk("tax-1", "Section 80C permits eligible deductions.")
    response = _pipeline(StaticRetriever([evidence])).query(
        RAGQueryRequest(question="Who won yesterday's cricket match?")
    )
    assert response.grounded is False
    assert response.retrieved_chunks == []
    assert response.citations == []
    assert response.metrics["abstention_reason"] == "out_of_domain"


def test_unsupported_jurisdiction_abstains_before_retrieval():
    response = _pipeline(UnavailableRetriever([])).query(
        RAGQueryRequest(
            question="What tax rules apply in the United States?",
            jurisdiction="US",
        )
    )
    assert response.grounded is False
    assert response.retrieved_chunks == []
    assert response.citations == []
    assert response.metrics["abstention_reason"] == "unsupported_jurisdiction"


def test_empty_low_confidence_and_untrusted_evidence_abstain():
    request = RAGQueryRequest(question="What deduction is available under Section 80C?")
    cases = [
        StaticRetriever([]),
        StaticRetriever([_chunk("low", "Section 80C deduction.", score=0.01)]),
        StaticRetriever([_chunk("untrusted", "Section 80C deduction.", tier="unverified_user_input")]),
    ]
    for retriever in cases:
        response = _pipeline(retriever).query(request)
        assert response.grounded is False
        assert response.retrieved_chunks == []
        assert response.citations == []


def test_rag_unavailable_returns_explicit_abstention_without_fake_citations():
    response = _pipeline(UnavailableRetriever([])).query(
        RAGQueryRequest(question="When do the Income-tax Rules 2026 take effect?")
    )
    assert response.grounded is False
    assert response.citations == []
    assert response.metrics["abstention_reason"] == "retrieval_unavailable"
