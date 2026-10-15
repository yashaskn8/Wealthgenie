"""
WealthGenie RAG/ML State - Store Factory

Creates MongoDB-backed or local-disk stores depending on the MONGODB_URI
environment variable. This centralizes the store selection logic so that
IngestionPipeline, RAGPipeline, router, and seed_knowledge all use the
same backend without each needing their own conditional import.

When MONGODB_URI is set:
  - Vector store -> MongoVectorStore (chunks in MongoDB, FAISS search in-memory)
  - Model registry -> MongoModelRegistry (versions in MongoDB)

When MONGODB_URI is absent (local dev):
  - Vector store -> PersistentVectorStore (JSON files on disk)
  - Model registry -> ModelRegistry (SQLite)
"""

import logging
import os
from environment_policy import configured_environment_mode

logger = logging.getLogger("wealthgenie.store_factory")


class SharedStateInitializationError(RuntimeError):
    """Raised when required production shared state cannot be initialized."""


def _environment() -> str:
    return configured_environment_mode(os.environ) or "local"


def _state_backend() -> str:
    configured = os.environ.get("ML_STATE_BACKEND", "auto").strip().lower()
    if configured not in {"auto", "mongodb", "local"}:
        raise ValueError("ML_STATE_BACKEND must be one of: auto, mongodb, local")
    if configured == "auto":
        return "mongodb" if _environment() == "production" or os.environ.get("MONGODB_URI", "").strip() else "local"
    if _environment() == "production" and configured != "mongodb":
        raise SharedStateInitializationError(
            "Production requires ML_STATE_BACKEND=mongodb; local JSON/SQLite state is forbidden."
        )
    return configured


def _required_mongo_uri() -> str:
    uri = os.environ.get("MONGODB_URI", "").strip()
    if not uri:
        raise SharedStateInitializationError(
            "MongoDB shared state was selected but MONGODB_URI is missing."
        )
    return uri


def get_vector_store(force_numpy: bool = False):
    """
    Returns the appropriate BaseVectorStore implementation.
    Uses MongoVectorStore when MONGODB_URI is set, else PersistentVectorStore.
    """
    backend = _state_backend()
    if backend == "mongodb":
        mongo_uri = _required_mongo_uri()
        from mongo_database import resolve_mongo_database_name
        try:
            from rag.vector_store.mongo_vector_store import MongoVectorStore
            store = MongoVectorStore(
                mongo_uri=mongo_uri,
                db_name=resolve_mongo_database_name(mongo_uri),
                collection_name="vector_chunks",
                force_numpy=force_numpy,
            )
            logger.info("Using MongoVectorStore (backend=mongodb)")
            return store
        except Exception as e:
            logger.exception("Failed to initialize required MongoVectorStore")
            raise SharedStateInitializationError(
                f"Required MongoVectorStore initialization failed: {e}"
            ) from e

    from rag.vector_store.memory_vector_store import PersistentVectorStore
    store = PersistentVectorStore(force_numpy=force_numpy)
    logger.info("Using PersistentVectorStore (backend=local_disk)")
    return store


def get_model_registry(db_path=None):
    """
    Returns the appropriate model registry implementation.
    Uses MongoModelRegistry when MONGODB_URI is set, else SQLite ModelRegistry.
    """
    backend = _state_backend()
    if backend == "mongodb":
        mongo_uri = _required_mongo_uri()
        from mongo_database import resolve_mongo_database_name
        try:
            from model.registry.mongo_registry_store import MongoModelRegistry
            registry = MongoModelRegistry(
                mongo_uri=mongo_uri,
                db_name=resolve_mongo_database_name(mongo_uri),
            )
            registry.artifact_store = get_artifact_store_for_registry(registry)
            logger.info("Using MongoModelRegistry (backend=mongodb)")
            return registry
        except Exception as e:
            logger.exception("Failed to initialize required MongoModelRegistry")
            raise SharedStateInitializationError(
                f"Required MongoModelRegistry initialization failed: {e}"
            ) from e

    from model.registry.registry_store import ModelRegistry
    configured_local_path = os.environ.get("ML_REGISTRY_DB_PATH", "").strip()
    resolved_db_path = db_path or (configured_local_path if configured_local_path else None)
    registry = ModelRegistry(db_path=resolved_db_path)
    registry.artifact_store = get_artifact_store_for_registry(registry)
    logger.info("Using SQLite ModelRegistry (backend=local_disk)")
    return registry


def get_artifact_store_for_registry(model_registry):
    """Return the artifact store paired with the selected registry backend.

    Mongo-backed registry state must use the same shared database for GridFS;
    it is never allowed to fall back to a pod-local directory.
    """
    from model.artifacts.store import get_artifact_store

    database = getattr(model_registry, "database", None)
    backend = "mongodb" if database is not None else "local"
    return get_artifact_store(
        _environment(),
        database=database,
        state_backend=backend,
    )
