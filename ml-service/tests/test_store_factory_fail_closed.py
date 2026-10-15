import sys
import types

import pytest

import store_factory


class BrokenMongoStore:
    def __init__(self, **_kwargs):
        raise ConnectionError("shared MongoDB unavailable")


def install_broken_module(monkeypatch, module_name, class_name):
    module = types.ModuleType(module_name)
    setattr(module, class_name, BrokenMongoStore)
    monkeypatch.setitem(sys.modules, module_name, module)


def production_environment(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("ML_STATE_BACKEND", "mongodb")
    monkeypatch.setenv("MONGODB_URI", "mongodb://unavailable/wealthgenie")


def test_production_vector_store_failure_never_falls_back_to_json(monkeypatch):
    production_environment(monkeypatch)
    install_broken_module(
        monkeypatch,
        "rag.vector_store.mongo_vector_store",
        "MongoVectorStore",
    )

    with pytest.raises(store_factory.SharedStateInitializationError, match="MongoVectorStore"):
        store_factory.get_vector_store()


def test_production_registry_failure_never_falls_back_to_sqlite(monkeypatch):
    production_environment(monkeypatch)
    install_broken_module(
        monkeypatch,
        "model.registry.mongo_registry_store",
        "MongoModelRegistry",
    )

    with pytest.raises(store_factory.SharedStateInitializationError, match="MongoModelRegistry"):
        store_factory.get_model_registry()


def test_production_rejects_explicit_local_state(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("ML_STATE_BACKEND", "local")
    monkeypatch.delenv("MONGODB_URI", raising=False)

    with pytest.raises(store_factory.SharedStateInitializationError, match="local JSON/SQLite"):
        store_factory.get_model_registry()


def test_prod_alias_requires_shared_mongodb_state(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "prod")
    monkeypatch.delenv("ML_STATE_BACKEND", raising=False)
    monkeypatch.delenv("MONGODB_URI", raising=False)

    with pytest.raises(store_factory.SharedStateInitializationError, match="MONGODB_URI is missing"):
        store_factory.get_model_registry()


def test_prod_alias_rejects_explicit_local_state(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "prod")
    monkeypatch.setenv("ML_STATE_BACKEND", "local")
    monkeypatch.delenv("MONGODB_URI", raising=False)

    with pytest.raises(store_factory.SharedStateInitializationError, match="local JSON/SQLite"):
        store_factory.get_model_registry()


def test_local_environment_can_explicitly_use_local_state(monkeypatch, tmp_path):
    monkeypatch.setenv("ENVIRONMENT", "local")
    monkeypatch.setenv("ML_STATE_BACKEND", "local")
    monkeypatch.delenv("MONGODB_URI", raising=False)

    registry = store_factory.get_model_registry(db_path=tmp_path / "registry.db")
    assert type(registry).__name__ == "ModelRegistry"
