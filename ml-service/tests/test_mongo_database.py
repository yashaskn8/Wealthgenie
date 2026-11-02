from __future__ import annotations

import pytest

from mongo_database import MongoDatabaseConfigurationError, resolve_mongo_database_name


def test_database_name_is_resolved_from_uri_path_and_decoded():
    assert resolve_mongo_database_name("mongodb://user:pass@db.example:27017/wealthgenie_e2e?replicaSet=rs0") == "wealthgenie_e2e"
    assert resolve_mongo_database_name("mongodb+srv://db.example/%77ealthgenie") == "wealthgenie"


def test_explicit_database_must_match_uri_database(monkeypatch):
    monkeypatch.setenv("MONGODB_DATABASE", "wealthgenie")
    with pytest.raises(MongoDatabaseConfigurationError, match="must match"):
        resolve_mongo_database_name("mongodb://localhost:27017/wealthgenie_e2e")


def test_database_override_is_used_when_uri_has_no_database(monkeypatch):
    monkeypatch.setenv("MONGODB_DATABASE", "wealthgenie_test")
    assert resolve_mongo_database_name("mongodb://localhost:27017/?replicaSet=rs0") == "wealthgenie_test"


def test_empty_uri_is_rejected():
    with pytest.raises(MongoDatabaseConfigurationError, match="MONGODB_URI is required"):
        resolve_mongo_database_name("")


def test_expected_database_pin_rejects_cross_service_database_split(monkeypatch):
    monkeypatch.setenv("MONGODB_EXPECTED_DATABASE", "wealthgenie")
    assert resolve_mongo_database_name("mongodb://localhost:27017/wealthgenie?replicaSet=rs0") == "wealthgenie"
    with pytest.raises(MongoDatabaseConfigurationError, match="MONGODB_EXPECTED_DATABASE"):
        resolve_mongo_database_name("mongodb://localhost:27017/other?replicaSet=rs0")
