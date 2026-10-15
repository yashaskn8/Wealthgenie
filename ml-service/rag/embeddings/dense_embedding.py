"""
WealthGenie RAG Subsystem - Embedding Providers & Factory
Contains:
  - DenseVectorEmbeddingProvider: Lightweight lexical fallback (n-gram hashing, no semantic understanding)
  - SentenceTransformerEmbeddingProvider: Production semantic embedding using all-MiniLM-L6-v2
  - get_embedding_provider(): Factory function wired to RAGConfig.embedding_provider
"""

import logging
import hashlib
import json
import os
import time
from typing import List, Optional, cast

from rag.embeddings.base import BaseEmbeddingProvider
from rag.embeddings.cache import EmbeddingCache
from lexical_embedding import stable_lexical_embedding, tokenize_subwords
from environment_policy import configured_environment_mode

logger = logging.getLogger("wealthgenie.rag.embeddings")


class DenseVectorEmbeddingProvider(BaseEmbeddingProvider):
    """Lightweight lexical fallback embedding provider using subword n-gram hashing and TF-IDF scaling.

    WARNING: This provider has ZERO semantic understanding — it computes vectors via
    deterministic hash bucketing of character n-grams. Two sentences that mean the same
    thing but share no words will produce near-zero cosine similarity.

    Use this only in offline/no-download environments where a real model is unavailable.
    For production semantic retrieval, use SentenceTransformerEmbeddingProvider instead.
    """

    def __init__(self, dimension: int = 128, enable_cache: bool = True):
        self._dim = dimension
        self.enable_cache = enable_cache
        self.embedding_identity = {
            "provider": "wealthgenie_lexical",
            "model_id": "stable-hash-ngram",
            "model_revision": "lexical-v1",
            "dimension": dimension,
            "config_hash": hashlib.sha256(
                json.dumps({"dimension": dimension, "tokenizer": "word-prefix-suffix-v1"}, sort_keys=True).encode("utf-8")
            ).hexdigest(),
        }
        self.cache = EmbeddingCache(embedding_identity=self.embedding_identity) if enable_cache else None

    @property
    def embedding_dimension(self) -> int:
        return self._dim

    def _tokenize(self, text: str) -> List[str]:
        """Extracts lowercase word and subword n-grams."""
        return tokenize_subwords(text)

    def embed_text(self, text: str) -> List[float]:
        """Generates unit L2-normalized vector embedding for input text."""
        if self.cache and self.enable_cache:
            cached = self.cache.get(text)
            if cached is not None:
                return cached

        result = stable_lexical_embedding(text, self._dim)
        if self.cache and self.enable_cache:
            self.cache.put(text, result)

        return result

    def embed_batch(self, texts: List[str]) -> List[List[float]]:
        """Generates dense vector embeddings for a list of texts."""
        return [self.embed_text(t) for t in texts]


class SentenceTransformerEmbeddingProvider(BaseEmbeddingProvider):
    """Production semantic embedding provider using sentence-transformers/all-MiniLM-L6-v2.

    Produces 384-dimensional dense vector embeddings with genuine semantic understanding.
    Uses the model's native batch encode for efficient multi-text embedding.
    """

    DEFAULT_MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
    MODEL_REVISION = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41"
    _shared_models = {}
    _load_failures = {}
    _failure_retry_seconds = 60.0

    def __init__(self, model_name: Optional[str] = None, enable_cache: bool = True, batch_size: int = 32):
        self._model_name = model_name or self.DEFAULT_MODEL_NAME
        self._batch_size = batch_size
        self.enable_cache = enable_cache
        self._model = self._load_shared_model()
        dimension_getter = getattr(self._model, "get_embedding_dimension", None)
        if not callable(dimension_getter):
            dimension_getter = getattr(
                self._model,
                "get_sentence_embedding_dimension",
                lambda: 384,
            )
        dim = dimension_getter()
        self._dim: int = int(dim) if dim is not None else 384
        config = {"normalize_embeddings": False, "batch_size": batch_size, "max_seq_length": 256}
        self.embedding_identity = {
            "provider": "sentence_transformers",
            "model_id": self._model_name,
            "model_revision": self.MODEL_REVISION,
            "dimension": self._dim,
            "config_hash": hashlib.sha256(
                json.dumps(config, sort_keys=True, separators=(",", ":")).encode("utf-8")
            ).hexdigest(),
        }
        self.cache = EmbeddingCache(embedding_identity=self.embedding_identity) if enable_cache else None

        logger.info(
            f"Sentence-transformer model loaded: '{self._model_name}' "
            f"(dimension={self._dim}, batch_size={self._batch_size})"
        )

    def _load_shared_model(self):
        """Load one model per process, preferring an existing local snapshot.

        Loading by repository ID can trigger a Hugging Face metadata request even
        when the weights are already cached. Resolve the snapshot locally first so
        service startup and request handling remain deterministic when offline.
        """
        cached_model = self._shared_models.get(self._model_name)
        if cached_model is not None:
            return cached_model

        previous_failure = self._load_failures.get(self._model_name)
        if previous_failure is not None:
            failed_at, failure_message = previous_failure
            if time.monotonic() - failed_at < self._failure_retry_seconds:
                raise RuntimeError(failure_message)

        logger.info(f"Loading sentence-transformer model '{self._model_name}'...")
        from sentence_transformers import SentenceTransformer

        try:
            # Fast path for deployed images and developer machines with a warm cache.
            model = SentenceTransformer(
                self._model_name,
                revision=self.MODEL_REVISION,
                local_files_only=True,
                trust_remote_code=False,
            )
        except Exception as local_error:
            offline = os.environ.get("HF_HUB_OFFLINE", "").lower() in {"1", "true", "yes"}
            offline = offline or os.environ.get("TRANSFORMERS_OFFLINE", "").lower() in {"1", "true", "yes"}
            if offline or configured_environment_mode(os.environ) == "production":
                message = f"Local embedding model unavailable while offline: {local_error}"
                self._load_failures[self._model_name] = (time.monotonic(), message)
                raise RuntimeError(message) from local_error

            try:
                # Cold-start path: allow sentence-transformers to populate its cache once.
                model = SentenceTransformer(
                    self._model_name,
                    revision=self.MODEL_REVISION,
                    trust_remote_code=False,
                )
            except Exception as download_error:
                message = f"Embedding model load failed: {download_error}"
                self._load_failures[self._model_name] = (time.monotonic(), message)
                raise RuntimeError(message) from download_error

        self._shared_models[self._model_name] = model
        self._load_failures.pop(self._model_name, None)
        return model

    @property
    def embedding_dimension(self) -> int:
        """Returns the model's actual output dimension (read from the model, not hardcoded)."""
        return self._dim

    def embed_text(self, text: str) -> List[float]:
        """Generates a semantic embedding for a single text using the sentence-transformer model."""
        if self.cache and self.enable_cache:
            cached = self.cache.get(text)
            if cached is not None:
                return cached

        # Encode as single-item batch for consistency
        embedding = self._model.encode([text], batch_size=1, show_progress_bar=False)
        result = embedding[0].tolist()

        if self.cache and self.enable_cache:
            self.cache.put(text, result)

        return result

    def embed_batch(self, texts: List[str]) -> List[List[float]]:
        """Generates semantic embeddings for a batch of texts using native batch encode.

        This calls model.encode() ONCE with the full batch — not N individual calls.
        """
        if not texts:
            return []

        # Check cache for all texts first
        results: List[Optional[List[float]]] = [None] * len(texts)
        uncached_indices = []
        uncached_texts = []

        if self.cache and self.enable_cache:
            for i, text in enumerate(texts):
                cached = self.cache.get(text)
                if cached is not None:
                    results[i] = cached
                else:
                    uncached_indices.append(i)
                    uncached_texts.append(text)
        else:
            uncached_indices = list(range(len(texts)))
            uncached_texts = list(texts)

        # Batch encode all uncached texts in ONE model call
        if uncached_texts:
            embeddings = self._model.encode(
                uncached_texts,
                batch_size=self._batch_size,
                show_progress_bar=False,
            )
            for idx, emb in zip(uncached_indices, embeddings):
                vec = emb.tolist()
                results[idx] = vec
                if self.cache and self.enable_cache:
                    self.cache.put(texts[idx], vec)

        return cast(List[List[float]], results)


def get_embedding_provider(config=None) -> BaseEmbeddingProvider:
    """Factory function that resolves an embedding provider from RAGConfig.embedding_provider.

    Returns:
        - SentenceTransformerEmbeddingProvider for "sentence_transformer" (production default)
        - DenseVectorEmbeddingProvider for "tf_idf_dense" (lightweight lexical fallback)

    The lexical provider is a deliberate local/test option only. Production never
    silently changes embedding spaces when the pinned semantic model is unavailable.
    """
    if config is None:
        from rag.config import RAGConfig
        config = RAGConfig.from_env()

    provider_name = config.embedding_provider

    if provider_name == "sentence_transformer":
        try:
            return SentenceTransformerEmbeddingProvider()
        except Exception as e:
            if configured_environment_mode(os.environ) == "production":
                logger.error("Pinned semantic embedding provider unavailable in production: %s", e)
                return UnavailableEmbeddingProvider(config.embedding_dim, str(e))
            logger.warning(
                f"sentence-transformers model initialization unavailable ({e}). "
                "Falling back to DenseVectorEmbeddingProvider (lexical hashing)."
            )
            return DenseVectorEmbeddingProvider(dimension=config.embedding_dim, enable_cache=True)
    elif provider_name == "tf_idf_dense":
        if configured_environment_mode(os.environ) == "production":
            raise RuntimeError("production RAG requires the pinned semantic embedding provider")
        return DenseVectorEmbeddingProvider(dimension=config.embedding_dim, enable_cache=True)
    else:
        raise ValueError(
            f"Unknown embedding_provider '{provider_name}'. "
            f"Valid options: 'sentence_transformer', 'tf_idf_dense'."
        )


class UnavailableEmbeddingProvider(BaseEmbeddingProvider):
    """Explicit not-ready provider used to keep optional RAG from changing model serving readiness."""

    def __init__(self, dimension: int, reason: str):
        self._dimension = dimension
        self.reason = reason
        self.embedding_identity = {
            "provider": "unavailable",
            "model_id": "none",
            "model_revision": "none",
            "dimension": dimension,
            "config_hash": "none",
        }

    @property
    def embedding_dimension(self) -> int:
        return self._dimension

    @property
    def is_ready(self) -> bool:
        return False

    def embed_text(self, text: str) -> List[float]:
        raise RuntimeError(f"RAG_NOT_READY: pinned embedding model unavailable: {self.reason}")

    def embed_batch(self, texts: List[str]) -> List[List[float]]:
        raise RuntimeError(f"RAG_NOT_READY: pinned embedding model unavailable: {self.reason}")
