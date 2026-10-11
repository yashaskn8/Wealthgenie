"""Guard fail-closed mutation handling and the shared RAG lifecycle contract."""

from pathlib import Path

import mongomock
import pytest

from model.migrations.phase3_state import (
    MIGRATION_ID,
    MIGRATION_VERSION,
    migrate_phase3_state,
    verify_phase3_state,
)


ROOT = Path(__file__).resolve().parents[2]


def test_idempotency_runtime_and_regression_test_preserve_fail_closed_behavior():
    middleware = (ROOT / "server" / "middleware" / "idempotency.js").read_text(encoding="utf-8")
    behavior_test = (ROOT / "server" / "test" / "idempotencyFailClosed.test.js").read_text(encoding="utf-8")

    assert "IDEMPOTENCY_UNAVAILABLE" in middleware
    assert "Durable mutation idempotency is temporarily unavailable." in middleware
    assert "durable idempotency dependency failure returns canonical 503 before mutation" in behavior_test
    assert "assert.equal(response.status, 503)" in behavior_test
    assert "assert.equal(body.code, 'IDEMPOTENCY_UNAVAILABLE')" in behavior_test
    assert "mutationExecutions, 0" in behavior_test


def test_rag_bootstrap_requires_opt_in_and_phase3_migration_verifies_generation_schema(monkeypatch):
    from scripts.bootstrap_rag_corpus import bootstrap

    monkeypatch.delenv("WEALTHGENIE_RAG_BOOTSTRAP", raising=False)
    with pytest.raises(RuntimeError, match="set WEALTHGENIE_RAG_BOOTSTRAP=1"):
        bootstrap()

    database = mongomock.MongoClient()["phase23_remediation_contract"]
    migrate_phase3_state(database)
    verify_phase3_state(database)

    migration = database["ml_schema_migrations"].find_one({"_id": MIGRATION_ID})
    generation_member_indexes = database["rag_corpus_generation_members"].index_information()
    assert migration["version"] == MIGRATION_VERSION
    assert generation_member_indexes["uniq_generation_document_revision"]["unique"] is True
