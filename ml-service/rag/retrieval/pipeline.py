"""
WealthGenie RAG Subsystem - Trust-Gated Extractive Retrieval Pipeline
Executes domain classification, scoped retrieval, trust/relevance gating, abstention, and citation formatting.
"""

import logging
import json
import re
import time
from datetime import date
from pathlib import Path
from typing import Dict, Any, List, Optional

from rag.citations.engine import CitationEngine
from rag.cache.manager import MultiLevelCacheManager
from rag.config import RAGConfig
from rag.corpus_manifest import (
    MANIFEST_FILENAME,
    CorpusManifestError,
    current_documents,
    load_corpus_manifest,
)
from rag.embeddings.base import BaseEmbeddingProvider
from rag.embeddings.dense_embedding import get_embedding_provider
from rag.prompts.builder import PromptBuilder
from rag.security.retrieval_guard import contains_retrieval_instruction_attack
from rag.observability.metrics_collector import RAGObservabilityCollector
from rag.query_understanding.pipeline import QueryUnderstandingPipeline
from rag.reranking.base import BaseReranker
from rag.reranking.noop_reranker import NoOpReranker
from rag.reranking.relevance_reranker import RelevanceScoreReranker
from rag.reranking.cross_encoder_reranker import CrossEncoderReranker
from rag.retrievers.base import BaseRetriever
from rag.retrievers.bm25_retriever import BM25KeywordRetriever
from rag.retrievers.dense_retriever import DenseRetriever
from rag.retrievers.hybrid_retriever import HybridRetriever
from rag.schema import RAGQueryRequest, RAGQueryResponse, RAG_ABSTENTION_MESSAGE, RetrievedChunk
from rag.vector_store.base import BaseVectorStore
from rag.vector_store.memory_vector_store import PersistentVectorStore

logger = logging.getLogger("wealthgenie.rag.retrieval")

TRUSTED_EVIDENCE_TIERS = {"government_official", "regulatory_circular"}
_RELEVANCE_STOP_WORDS = {
    "what", "which", "when", "where", "who", "why", "how", "does", "is", "are",
    "the", "this", "that", "with", "from", "under", "about", "into", "for", "and",
    "can", "could", "would", "should", "much", "limit", "allowed",
}
def _topic_terms(value: str) -> set[str]:
    """Normalize manifest topic labels for a conservative coverage check."""
    terms = {
        token for token in re.findall(r"[a-z0-9]+", value.lower())
        if len(token) > 2 and token not in _RELEVANCE_STOP_WORDS
    }
    return {term[:-1] if term.endswith("s") and len(term) > 4 else term for term in terms}

def _generation_snapshot(vector_store: BaseVectorStore) -> Dict[str, Any]:
    getter = getattr(vector_store, "get_generation_snapshot", None)
    return dict(getter()) if callable(getter) else {"generation_id": None, "revision": vector_store.get_corpus_revision()}

def _same_generation(before: Dict[str, Any], after: Dict[str, Any]) -> bool:
    return all(before.get(key) == after.get(key) for key in ("generation_id", "revision", "manifest_sha256", "membership_sha256"))

def _generation_metrics(snapshot: Dict[str, Any]) -> Dict[str, Any]:
    return {"corpus_generation_id": snapshot.get("generation_id"), "corpus_revision": snapshot.get("revision"), "corpus_generation_manifest_sha256": snapshot.get("manifest_sha256"), "corpus_generation_membership_sha256": snapshot.get("membership_sha256")}

# Registry of built-in reranker strategies
_RERANKER_REGISTRY: Dict[str, type] = {
    "no_op": NoOpReranker,
    "relevance_score": RelevanceScoreReranker,
    "cross_encoder": CrossEncoderReranker,
}


def get_reranker(strategy: str) -> BaseReranker:
    """Resolves a reranker instance from the strategy name."""
    cls = _RERANKER_REGISTRY.get(strategy)
    if cls is None:
        logger.warning(f"Unknown reranker strategy '{strategy}', falling back to no_op.")
        return NoOpReranker()
    return cls()


def get_retriever(
    strategy: str,
    embedder: BaseEmbeddingProvider,
    vector_store: BaseVectorStore,
    config: RAGConfig,
) -> BaseRetriever:
    """Resolves a retriever instance based on configured strategy (dense, keyword, hybrid)."""
    if strategy == "dense":
        return DenseRetriever(embedder=embedder, vector_store=vector_store)
    elif strategy == "keyword":
        return BM25KeywordRetriever(vector_store=vector_store)
    elif strategy == "hybrid":
        dense_ret = DenseRetriever(embedder=embedder, vector_store=vector_store)
        keyword_ret = BM25KeywordRetriever(vector_store=vector_store)
        return HybridRetriever(
            dense_retriever=dense_ret,
            keyword_retriever=keyword_ret,
            fusion_mode=config.fusion_mode,
            dense_weight=config.dense_weight,
            keyword_weight=config.keyword_weight,
        )
    else:
        logger.warning(f"Unknown retrieval strategy '{strategy}', falling back to dense.")
        return DenseRetriever(embedder=embedder, vector_store=vector_store)


class RAGPipeline:
    """Trust-gated extractive retrieval pipeline with explicit abstention."""

    def __init__(
        self,
        embedder: Optional[BaseEmbeddingProvider] = None,
        vector_store: Optional[BaseVectorStore] = None,
        retriever: Optional[BaseRetriever] = None,
        reranker: Optional[BaseReranker] = None,
        query_understanding: Optional[QueryUnderstandingPipeline] = None,
        cache_manager: Optional[MultiLevelCacheManager] = None,
        telemetry: Optional[RAGObservabilityCollector] = None,
        config: Optional[RAGConfig] = None,
    ):
        self.config = config or RAGConfig()
        self.embedder = embedder or get_embedding_provider(self.config)
        self.vector_store = vector_store or PersistentVectorStore()
        self.retriever = retriever or get_retriever(
            strategy=self.config.retrieval_strategy,
            embedder=self.embedder,
            vector_store=self.vector_store,
            config=self.config,
        )
        self.reranker = reranker or get_reranker(self.config.reranker_strategy)
        self.query_understanding = query_understanding or QueryUnderstandingPipeline()
        self.cache_manager = cache_manager or MultiLevelCacheManager()
        self.telemetry = telemetry or RAGObservabilityCollector()
        self.prompt_builder = PromptBuilder()
        self.citation_engine = CitationEngine()

    def query(self, request: RAGQueryRequest) -> RAGQueryResponse:
        """Return extractive evidence only when domain, trust, and relevance gates pass."""
        if request.jurisdiction != "IN":
            qu_result = self.query_understanding.process(request.question)
            return self._abstain("unsupported_jurisdiction", qu_result, 0.0)
        effective_scope = request.scope or (f"user:{request.user_id}" if request.user_id else request.tenant_id)
        top_k = request.top_k or self.config.top_k
        try:
            corpus_dir = Path(__file__).resolve().parents[1] / "data" / "corpus"
            manifest = load_corpus_manifest(corpus_dir / MANIFEST_FILENAME, corpus_dir)
            current_entries = {
                entry["document_key"]: {**entry, "_manifest_sha256": manifest["manifest_sha256"]}
                for entry in current_documents(manifest, as_of=date.today())
            }
        except (CorpusManifestError, OSError, ValueError) as exc:
            logger.error("RAG current corpus manifest is unavailable or invalid", extra={"error_type": type(exc).__name__})
            qu_result = self.query_understanding.process(request.question)
            return self._abstain("corpus_unavailable", qu_result, 0.0)
        embedding_identity = getattr(self.embedder, "embedding_identity", None)
        try:
            generation_snapshot = _generation_snapshot(self.vector_store)
        except Exception as exc:
            logger.error("RAG corpus generation could not be verified before retrieval", extra={"error_type": type(exc).__name__})
            qu_result = self.query_understanding.process(request.question)
            return self._abstain("corpus_unavailable", qu_result, 0.0)

        cache_identity = {
            "scope": effective_scope,
            "question": request.question,
            "jurisdiction": request.jurisdiction,
            "top_k": top_k,
            "citations": request.include_citations,
            "retrieval_strategy": self.config.retrieval_strategy,
            "fusion_mode": self.config.fusion_mode,
            "dense_weight": self.config.dense_weight,
            "keyword_weight": self.config.keyword_weight,
            "reranker_strategy": self.config.reranker_strategy,
            "similarity_threshold": self.config.similarity_threshold,
            "embedding_identity": embedding_identity or {"provider_class": type(self.embedder).__qualname__},
            "corpus_revision": generation_snapshot.get("revision"),
            "corpus_generation_id": generation_snapshot.get("generation_id"),
            "corpus_generation_manifest_sha256": generation_snapshot.get("manifest_sha256"),
            "corpus_generation_membership_sha256": generation_snapshot.get("membership_sha256"),
            "corpus_manifest_sha256": manifest["manifest_sha256"],
        }
        response_cache_key = json.dumps(cache_identity, sort_keys=True, separators=(",", ":"), default=str)
        # Check Response Cache
        cached_response = self.cache_manager.get_response(response_cache_key, tenant_id=effective_scope)
        if cached_response is not None:
            logger.info("Serving cached RAG query response (scope: %s)", effective_scope)
            return cached_response

        start_time = time.perf_counter()
        # 1. Query Understanding & Expansion
        t0 = time.perf_counter()
        qu_result = self.query_understanding.process(request.question)
        search_query = qu_result["search_query"]
        qu_latency = (time.perf_counter() - t0) * 1000.0

        if qu_result["intent"] == "out_of_domain":
            response = self._abstain("out_of_domain", qu_result, qu_latency)
            self.cache_manager.put_response(response_cache_key, response, tenant_id=effective_scope)
            return response

        # 2. Strategy Retrieval
        t1 = time.perf_counter()
        retrieval_top_k = top_k * 2 if self.reranker.reranker_name != "no_op" else top_k
        try:
            retrieved_chunks = self.retriever.retrieve(
                query=search_query,
                top_k=retrieval_top_k,
                threshold=self.config.similarity_threshold,
                tenant_id=request.tenant_id,
                user_id=request.user_id,
                scope=request.scope,
            )
        except Exception as exc:
            logger.error("RAG retrieval unavailable; returning abstention without citations", extra={"error_type": type(exc).__name__})
            return self._abstain("retrieval_unavailable", qu_result, qu_latency)
        retrieval_latency = (time.perf_counter() - t1) * 1000.0
        try:
            post_retrieval_generation = _generation_snapshot(self.vector_store)
        except Exception as exc:
            logger.error("RAG corpus generation could not be verified after retrieval", extra={"error_type": type(exc).__name__})
            return self._abstain("corpus_unavailable", qu_result, qu_latency, retrieval_latency)
        if not _same_generation(generation_snapshot, post_retrieval_generation):
            logger.warning("RAG corpus generation changed during retrieval; discarding unbound evidence")
            return self._abstain("corpus_changed_during_retrieval", qu_result, qu_latency, retrieval_latency, generation_snapshot=generation_snapshot)

        # 3. Rerank Retrieved Chunks
        t2 = time.perf_counter()
        reranked_chunks = self.reranker.rerank(request.question, retrieved_chunks)
        reranking_latency = (time.perf_counter() - t2) * 1000.0

        # Only verified regulatory evidence with a meaningful query match may
        # influence the extractive response.
        trustworthy_chunks = [
            chunk for chunk in reranked_chunks
            if self._is_trustworthy(chunk, current_entries)
            and self._has_sufficient_relevance(request.question, chunk)
        ]
        # Limit every response to a small, provenance-checked context. A high
        # caller-supplied top_k must not bypass the prompt-injection or context budget.
        final_chunks = self._sanitize_chunks(trustworthy_chunks)

        if not final_chunks:
            reason = (
                "unsafe_or_oversized_evidence" if trustworthy_chunks
                else "empty_evidence" if not retrieved_chunks
                else "insufficient_trust_or_relevance"
            )
            response = self._abstain(
                reason,
                qu_result,
                qu_latency,
                retrieval_latency,
                reranking_latency,
                chunks_retrieved=len(retrieved_chunks),
                top_score=retrieved_chunks[0].score if retrieved_chunks else 0.0,
            )
            self.cache_manager.put_response(response_cache_key, response, tenant_id=effective_scope)
            return response

        # Build a strictly extractive response. No LLM synthesis occurs here.
        t4 = time.perf_counter()
        answer = self._build_extractive_answer(final_chunks)
        answer_latency = (time.perf_counter() - t4) * 1000.0

        citations = self.citation_engine.generate_citations(final_chunks) if request.include_citations else []
        if citations:
            answer += self.citation_engine.format_citations_markdown(citations)

        total_latency = (time.perf_counter() - start_time) * 1000.0

        # Record Telemetry Trace
        context_char_len = sum(len(c.chunk.content) for c in final_chunks)
        top_score = final_chunks[0].score if final_chunks else 0.0
        cache_hits = getattr(self.embedder.cache, "hits", 0) if getattr(self.embedder, "cache", None) else 0
        cache_misses = getattr(self.embedder.cache, "misses", 0) if getattr(self.embedder, "cache", None) else 0

        self.telemetry.record_query_trace(
            retrieval_strategy=self.retriever.strategy_name,
            reranker_strategy=self.reranker.reranker_name,
            stage_latencies_ms={
                "query_understanding": qu_latency,
                "retrieval": retrieval_latency,
                "reranking": reranking_latency,
                "prompt_assembly": 0.0,
                "extractive_response": answer_latency,
            },
            chunks_retrieved=len(retrieved_chunks),
            chunks_after_rerank=len(final_chunks),
            context_char_count=context_char_len,
            citation_count=len(citations),
            top_score=top_score,
            cache_hits=cache_hits,
            cache_misses=cache_misses,
        )

        metrics = {
            "query_understanding_latency_ms": round(qu_latency, 2),
            "intent": qu_result["intent"],
            "retrieval_strategy": self.retriever.strategy_name,
            "retrieval_latency_ms": round(retrieval_latency, 2),
            "reranking_latency_ms": round(reranking_latency, 2),
            "response_mode": "extractive_retrieval",
            "abstention_reason": None,
            "extractive_response_latency_ms": round(answer_latency, 2),
            "total_latency_ms": round(total_latency, 2),
            "chunks_retrieved": len(retrieved_chunks),
            "chunks_after_reranking": len(final_chunks),
            "reranker": self.reranker.reranker_name,
            "top_score": top_score,
        }
        metrics.update(_generation_metrics(generation_snapshot))

        response = RAGQueryResponse(
            answer=answer,
            citations=citations,
            retrieved_chunks=final_chunks,
            metrics=metrics,
            grounded=True,
        )
        self.cache_manager.put_response(response_cache_key, response, tenant_id=effective_scope)
        return response

    def _build_extractive_answer(self, retrieved_chunks: List[RetrievedChunk]) -> str:
        """Format retrieved excerpts without claiming generative synthesis."""
        excerpts = []
        for idx, ret in enumerate(retrieved_chunks, start=1):
            excerpts.append(f"According to **{ret.chunk.metadata.title}** [{idx}]:\n{ret.chunk.content}")

        body = "\n\n".join(excerpts)
        return f"Extracts from verified financial or regulatory sources:\n\n{body}"

    def _is_trustworthy(
        self,
        retrieved: RetrievedChunk,
        current_entries: Optional[Dict[str, Dict[str, Any]]] = None,
    ) -> bool:
        metadata = retrieved.chunk.metadata
        scope = (retrieved.chunk.scope or metadata.scope or "").lower()
        tenant_id = (retrieved.chunk.tenant_id or metadata.tenant_id or "").lower()
        if not (
            metadata.source_trust_tier.lower() in TRUSTED_EVIDENCE_TIERS
            and scope in {"global", "public", "default"}
            and tenant_id in {"default", "global", ""}
        ):
            return False
        try:
            if current_entries is None:
                corpus_dir = Path(__file__).resolve().parents[1] / "data" / "corpus"
                manifest = load_corpus_manifest(corpus_dir / MANIFEST_FILENAME, corpus_dir)
                current_entries = {
                    entry["document_key"]: {**entry, "_manifest_sha256": manifest["manifest_sha256"]}
                    for entry in current_documents(manifest, as_of=date.today())
                }
            custom = metadata.custom_metadata
            entry = current_entries.get(custom.get("document_key"))
            return bool(
                entry
                and custom.get("corpus_manifest_sha256") == entry["_manifest_sha256"]
                and custom.get("content_sha256") == entry["content_sha256"]
                and metadata.source == entry["official_source_url"]
                and metadata.author == entry["publishing_authority"]
                and metadata.publication_date == entry["publication_date"]
                and metadata.effective_date == entry["effective_from"]
                and custom.get("effective_to") == entry["effective_to"]
                and custom.get("document_revision") == entry["document_version"]
                and custom.get("supported_topics") == entry["supported_topics"]
                and custom.get("excluded_topics") == entry["excluded_topics"]
            )
        except (CorpusManifestError, OSError, ValueError, TypeError):
            return False

    def _has_sufficient_relevance(self, question: str, retrieved: RetrievedChunk) -> bool:
        if retrieved.score < self.config.similarity_threshold:
            return False
        query_terms = _topic_terms(question)
        excluded_topics = retrieved.chunk.metadata.custom_metadata.get("excluded_topics", [])
        if any(_topic_terms(topic) and _topic_terms(topic).issubset(query_terms) for topic in excluded_topics):
            return False
        supported_topics = retrieved.chunk.metadata.custom_metadata.get("supported_topics", [])
        if supported_topics and not any(_topic_terms(topic).intersection(query_terms) for topic in supported_topics):
            return False
        if not query_terms:
            return False
        evidence_text = f"{retrieved.chunk.metadata.title} {retrieved.chunk.content}".lower()
        matches = query_terms.intersection(re.findall(r"[a-z0-9]+", evidence_text))
        required_matches = 1 if len(query_terms) <= 2 else 2
        return len(matches) >= required_matches

    def _sanitize_chunks(self, chunks: List[RetrievedChunk]) -> List[RetrievedChunk]:
        """Bound and isolate evidence before returning it to any downstream client.

        Skip suspicious or oversized passages rather than truncating a legal
        proposition into a potentially misleading partial statement. Always
        preserve the original stored chunk; only sanitized copies are returned.
        """
        max_chunks = 5
        max_total_chars = 12_000
        max_chunk_chars = 4_096
        sanitized = []
        total_chars = 0
        seen_ids = set()
        for retrieved in chunks:
            if len(sanitized) >= max_chunks:
                break
            chunk = retrieved.chunk
            content = chunk.content
            if chunk.chunk_id in seen_ids:
                continue
            seen_ids.add(chunk.chunk_id)
            if not content or len(content) > max_chunk_chars or contains_retrieval_instruction_attack(content):
                logger.warning("RAG excluded invalid or instruction-bearing retrieved evidence")
                continue
            safe = retrieved.model_copy(deep=True)
            safe.chunk.content = self.prompt_builder.sanitizer.sanitize_retrieved_context(content)
            if (not safe.chunk.content.strip()
                    or len(safe.chunk.content) > max_chunk_chars
                    or contains_retrieval_instruction_attack(safe.chunk.content)):
                logger.warning("RAG excluded unsafe sanitized evidence")
                continue
            if total_chars + len(safe.chunk.content) > max_total_chars:
                continue
            sanitized.append(safe)
            total_chars += len(safe.chunk.content)
        return sanitized

    def _abstain(
        self,
        reason: str,
        qu_result: Dict[str, Any],
        qu_latency: float,
        retrieval_latency: float = 0.0,
        reranking_latency: float = 0.0,
        chunks_retrieved: int = 0,
        top_score: float = 0.0,
        generation_snapshot: Optional[Dict[str, Any]] = None,
    ) -> RAGQueryResponse:
        self.telemetry.record_query_trace(
            retrieval_strategy=self.retriever.strategy_name,
            reranker_strategy=self.reranker.reranker_name,
            stage_latencies_ms={
                "query_understanding": qu_latency,
                "retrieval": retrieval_latency,
                "reranking": reranking_latency,
                "prompt_assembly": 0.0,
                "answer_synthesis": 0.0,
            },
            chunks_retrieved=chunks_retrieved,
            chunks_after_rerank=0,
            context_char_count=0,
            citation_count=0,
            top_score=top_score,
        )
        metrics = {
            "response_mode": "abstention",
            "abstention_reason": reason,
            "intent": qu_result["intent"],
            "query_understanding_latency_ms": round(qu_latency, 2),
            "retrieval_latency_ms": round(retrieval_latency, 2),
            "reranking_latency_ms": round(reranking_latency, 2),
            "chunks_retrieved": chunks_retrieved,
            "chunks_after_reranking": 0,
        }
        if generation_snapshot is not None:
            metrics.update(_generation_metrics(generation_snapshot))
        return RAGQueryResponse(
            answer=RAG_ABSTENTION_MESSAGE,
            citations=[],
            retrieved_chunks=[],
            metrics=metrics,
            grounded=False,
        )
