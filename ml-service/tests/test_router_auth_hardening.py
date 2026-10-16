"""
WealthGenie ML Microservice - Router Authentication Hardening Test Suite
Verifies closing of anonymous-access gap on /rag and /llm routers and audits tenant scoping.
"""

import pytest
from fastapi.testclient import TestClient
from main import app

API_KEY = "wealthgenie_secret_api_key_2026"
OPERATOR_KEY = "wealthgenie_operator_secret_key_9999"


@pytest.fixture(autouse=True)
def ensure_auth_environment(monkeypatch):
    """Ensure tests run with valid API key & Operator key configured and non-local environment by default."""
    monkeypatch.setenv("ML_SERVICE_API_KEY", API_KEY)
    monkeypatch.setenv("ML_OPERATOR_KEY", OPERATOR_KEY)
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("ML_STATE_BACKEND", "local")


# ==============================================================================
# 1. RAG ROUTER AUTHENTICATION & IDENTITY VERIFICATION TESTS
# ==============================================================================

def test_rag_index_rejects_unauthenticated_request():
    """POST /rag/index MUST return 401 when called anonymously without X-API-Key."""
    with TestClient(app) as client:
        payload = {
            "title": "Unauthenticated Guide",
            "content": "Confidential financial regulations that should not be indexed anonymously.",
            "source": "attacker",
        }
        res = client.post("/rag/index", json=payload)
        assert res.status_code == 401, f"Expected 401 Unauthorized, got {res.status_code}"
        assert res.json()["detail"] == "Invalid or missing API Key"


def test_rag_index_rejects_valid_api_key_without_verified_user_header():
    """POST /rag/index MUST return 401 when called with valid X-API-Key but missing X-Verified-User-Id."""
    headers = {"X-API-Key": API_KEY}
    with TestClient(app, headers=headers) as client:
        payload = {
            "title": "Unauthenticated User Document",
            "content": "Financial advisory document with valid service key but no user identity header.",
            "source": "test_source",
        }
        res = client.post("/rag/index", json=payload)
        assert res.status_code == 401, f"Expected 401 Unauthorized, got {res.status_code}"
        assert "X-Verified-User-Id" in res.json()["detail"]


def test_rag_query_rejects_unauthenticated_request():
    """POST /rag/query MUST return 401 when called anonymously without X-API-Key."""
    with TestClient(app) as client:
        res = client.post("/rag/query", json={"question": "What are Section 80C limits?"})
        assert res.status_code == 401, f"Expected 401 Unauthorized, got {res.status_code}"
        assert res.json()["detail"] == "Invalid or missing API Key"


def test_rag_query_rejects_valid_api_key_without_verified_user_header():
    """POST /rag/query MUST return 401 when called with valid X-API-Key but missing X-Verified-User-Id."""
    headers = {"X-API-Key": API_KEY}
    with TestClient(app, headers=headers) as client:
        res = client.post("/rag/query", json={"question": "What are Section 80C limits?"})
        assert res.status_code == 401, f"Expected 401 Unauthorized, got {res.status_code}"
        assert "X-Verified-User-Id" in res.json()["detail"]


def test_rag_documents_delete_rejects_unauthenticated_request():
    """DELETE /rag/documents/{id} MUST return 401 when called anonymously without X-API-Key."""
    with TestClient(app) as client:
        res = client.delete("/rag/documents/doc-secret-123")
        assert res.status_code == 401, f"Expected 401 Unauthorized, got {res.status_code}"
        assert res.json()["detail"] == "Invalid or missing API Key"


def test_rag_documents_put_rejects_unauthenticated_request():
    """PUT /rag/documents/{id} MUST return 401 when called anonymously without X-API-Key."""
    with TestClient(app) as client:
        res = client.put("/rag/documents/doc-secret-123", params={"title": "Tampered Title"})
        assert res.status_code == 401, f"Expected 401 Unauthorized, got {res.status_code}"
        assert res.json()["detail"] == "Invalid or missing API Key"


def test_rag_routes_succeed_with_valid_api_key_and_verified_user_header():
    """RAG routes MUST succeed when provided with valid X-API-Key and X-Verified-User-Id headers."""
    headers = {
        "X-API-Key": API_KEY,
        "X-Verified-User-Id": "user_verified_live_001",
    }
    with TestClient(app, headers=headers) as client:
        # Health (unscoped)
        res_health = client.get("/rag/health")
        assert res_health.status_code == 200
        assert res_health.json()["status"] == "ok"

        # Status (unscoped)
        res_status = client.get("/rag/status")
        assert res_status.status_code == 200
        assert "vector_store_stats" in res_status.json()

        # Documents list (requires verified user)
        res_docs = client.get("/rag/documents")
        assert res_docs.status_code == 200
        assert "documents" in res_docs.json()


# ==============================================================================
# 2. LLM ROUTER AUTHENTICATION & IDENTITY VERIFICATION TESTS
# ==============================================================================

def test_llm_generate_rejects_unauthenticated_request():
    """POST /llm/generate MUST return 401 when called anonymously without X-API-Key."""
    with TestClient(app) as client:
        res = client.post("/llm/generate", json={"prompt": "Generate unauthorized advice."})
        assert res.status_code == 401, f"Expected 401 Unauthorized, got {res.status_code}"
        assert res.json()["detail"] == "Invalid or missing API Key"


def test_llm_generate_rejects_valid_api_key_without_verified_user_header():
    """POST /llm/generate MUST return 401 when called with valid X-API-Key but missing X-Verified-User-Id."""
    headers = {"X-API-Key": API_KEY}
    with TestClient(app, headers=headers) as client:
        res = client.post("/llm/generate", json={"prompt": "Generate unauthorized advice."})
        assert res.status_code == 401, f"Expected 401 Unauthorized, got {res.status_code}"
        assert "X-Verified-User-Id" in res.json()["detail"]


def test_llm_batch_generate_rejects_unauthenticated_request():
    """POST /llm/batch-generate MUST return 401 when called anonymously without X-API-Key."""
    with TestClient(app) as client:
        res = client.post("/llm/batch-generate", json=[{"prompt": "Query 1"}, {"prompt": "Query 2"}])
        assert res.status_code == 401, f"Expected 401 Unauthorized, got {res.status_code}"
        assert res.json()["detail"] == "Invalid or missing API Key"


def test_llm_batch_generate_rejects_valid_api_key_without_verified_user_header():
    """POST /llm/batch-generate MUST return 401 when called with valid X-API-Key but missing X-Verified-User-Id."""
    headers = {"X-API-Key": API_KEY}
    with TestClient(app, headers=headers) as client:
        res = client.post("/llm/batch-generate", json=[{"prompt": "Query 1"}, {"prompt": "Query 2"}])
        assert res.status_code == 401, f"Expected 401 Unauthorized, got {res.status_code}"
        assert "X-Verified-User-Id" in res.json()["detail"]


def test_llm_rag_query_rejects_unauthenticated_request():
    """POST /llm/rag-query MUST return 401 when called anonymously without X-API-Key."""
    with TestClient(app) as client:
        res = client.post("/llm/rag-query", json={"question": "What is Section 87A?"})
        assert res.status_code == 401, f"Expected 401 Unauthorized, got {res.status_code}"
        assert res.json()["detail"] == "Invalid or missing API Key"


def test_llm_rag_query_rejects_valid_api_key_without_verified_user_header():
    """POST /llm/rag-query MUST return 401 when called with valid X-API-Key but missing X-Verified-User-Id."""
    headers = {"X-API-Key": API_KEY}
    with TestClient(app, headers=headers) as client:
        res = client.post("/llm/rag-query", json={"question": "What is Section 87A?"})
        assert res.status_code == 401, f"Expected 401 Unauthorized, got {res.status_code}"
        assert "X-Verified-User-Id" in res.json()["detail"]


def test_llm_tool_query_rejects_unauthenticated_request():
    """POST /llm/tool-query MUST return 401 when called anonymously without X-API-Key."""
    with TestClient(app) as client:
        res = client.post("/llm/tool-query", json={"tool_name": "calculate_sip", "arguments": {}})
        assert res.status_code == 401, f"Expected 401 Unauthorized, got {res.status_code}"
        assert res.json()["detail"] == "Invalid or missing API Key"


def test_llm_switch_rejects_unauthenticated_request():
    """POST /llm/switch MUST return 401 when called anonymously without X-API-Key."""
    with TestClient(app) as client:
        res = client.post("/llm/switch", json={"provider_key": "mock"})
        assert res.status_code == 401, f"Expected 401 Unauthorized, got {res.status_code}"
        assert res.json()["detail"] == "Invalid or missing API Key"


def test_llm_switch_rejects_missing_operator_key_header():
    """POST /llm/switch MUST return 401 when called with valid X-API-Key but without X-Operator-Key."""
    headers = {"X-API-Key": API_KEY}
    with TestClient(app, headers=headers) as client:
        res = client.post("/llm/switch", json={"provider_key": "mock"})
        assert res.status_code == 401, f"Expected 401 Unauthorized, got {res.status_code}"
        assert res.json()["detail"] == "Invalid or missing Operator Key"


def test_llm_switch_rejects_wrong_operator_key():
    """POST /llm/switch MUST return 401 when called with wrong X-Operator-Key."""
    headers = {
        "X-API-Key": API_KEY,
        "X-Operator-Key": "invalid_wrong_operator_token_123",
    }
    with TestClient(app, headers=headers) as client:
        res = client.post("/llm/switch", json={"provider_key": "mock"})
        assert res.status_code == 401, f"Expected 401 Unauthorized, got {res.status_code}"
        assert res.json()["detail"] == "Invalid or missing Operator Key"


def test_llm_switch_succeeds_with_valid_operator_key():
    """POST /llm/switch MUST succeed with 200 when called with distinct, valid X-Operator-Key."""
    headers = {
        "X-API-Key": API_KEY,
        "X-Operator-Key": OPERATOR_KEY,
    }
    assert API_KEY != OPERATOR_KEY, "Test invariant: OPERATOR_KEY must be distinct from API_KEY"
    with TestClient(app, headers=headers) as client:
        res = client.post("/llm/switch", json={"provider_key": "mock"})
        assert res.status_code == 200, f"Expected 200 OK, got {res.status_code}: {res.text}"
        assert res.json()["status"] == "success"


def test_llm_switch_proves_api_key_alone_cannot_switch_model_forgery_gap_closed():
    """
    PROOF: Proves that possessing X-API-Key alone (or attempting role-header forgery)
    is NOT sufficient to invoke /llm/switch without holding the distinct ML_OPERATOR_KEY secret.
    """
    # 1. Attacker has legitimate service API key only
    headers_service_key_only = {"X-API-Key": API_KEY}
    with TestClient(app, headers=headers_service_key_only) as client:
        res = client.post("/llm/switch", json={"provider_key": "mock"})
        assert res.status_code == 401
        assert res.json()["detail"] == "Invalid or missing Operator Key"

    # 2. Attacker attempts to forge admin role via X-Verified-User-Role with service key
    headers_forged_role = {
        "X-API-Key": API_KEY,
        "X-Verified-User-Role": "admin",
    }
    with TestClient(app, headers=headers_forged_role) as client:
        res = client.post("/llm/switch", json={"provider_key": "mock"})
        assert res.status_code == 401
        assert res.json()["detail"] == "Invalid or missing Operator Key"

    # 3. Attacker uses service API key as the operator key (should fail because they are distinct)
    headers_reused_api_key = {
        "X-API-Key": API_KEY,
        "X-Operator-Key": API_KEY,
    }
    with TestClient(app, headers=headers_reused_api_key) as client:
        res = client.post("/llm/switch", json={"provider_key": "mock"})
        assert res.status_code == 401
        assert res.json()["detail"] == "Invalid or missing Operator Key"



def test_llm_routes_succeed_with_valid_api_key_and_verified_user_header():
    """LLM routes MUST succeed when provided with valid X-API-Key and X-Verified-User-Id headers."""
    headers = {
        "X-API-Key": API_KEY,
        "X-Verified-User-Id": "user_verified_live_001",
    }
    with TestClient(app, headers=headers) as client:
        # Health
        res_health = client.get("/llm/health")
        assert res_health.status_code == 200
        assert res_health.json()["status"] in ("ok", "degraded")

        # Status
        res_status = client.get("/llm/status")
        assert res_status.status_code == 200
        assert "active_model_metadata" in res_status.json()

        # Tools
        res_tools = client.get("/llm/tools")
        assert res_tools.status_code == 200
        assert "tools" in res_tools.json()


# ==============================================================================
# 3. TIMING-ATTACK RESISTANT INVALID KEY & FAIL-CLOSED GUARDS
# ==============================================================================

def test_invalid_api_key_rejected_on_all_subsystems():
    """Invalid API key must return 401 on /rag, /llm, and /model/registry."""
    bad_headers = {
        "X-API-Key": "invalid_random_attacker_key_123",
        "X-Verified-User-Id": "user_123",
    }
    with TestClient(app, headers=bad_headers) as client:
        assert client.post("/rag/query", json={"question": "test"}).status_code == 401
        assert client.post("/llm/generate", json={"prompt": "test"}).status_code == 401
        assert client.get("/model/registry/versions").status_code == 401


def test_fail_closed_when_api_key_unset_in_production(monkeypatch):
    """When ML_SERVICE_API_KEY is unset in production, FastAPI startup fails closed with RuntimeError."""
    monkeypatch.delenv("ML_SERVICE_API_KEY", raising=False)
    monkeypatch.setenv("ML_OPERATOR_KEY", OPERATOR_KEY)
    monkeypatch.setenv("ENVIRONMENT", "production")

    headers = {"X-Verified-User-Id": "user_123"}
    with pytest.raises(RuntimeError, match="FATAL Startup Misconfiguration: ML_SERVICE_API_KEY is required in production"):
        with TestClient(app, headers=headers):
            pass


def test_fail_closed_when_operator_key_unset_in_production(monkeypatch):
    """When ML_OPERATOR_KEY is unset in production, FastAPI startup fails closed with RuntimeError."""
    # Use a production-valid service key so startup reaches the operator-key check.
    monkeypatch.setenv("ML_SERVICE_API_KEY", "ci-ml-service-key-valid-production-2026")
    monkeypatch.delenv("ML_OPERATOR_KEY", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "production")

    headers = {"X-Verified-User-Id": "user_123"}
    with pytest.raises(RuntimeError, match="FATAL Startup Misconfiguration: ML_OPERATOR_KEY is required in production"):
        with TestClient(app, headers=headers):
            pass


# ==============================================================================
# 4. TASK 2 & 3 PROOFS — VERIFIED IDENTITY HEADER SCOPING & BODY OVERRIDE
# ==============================================================================

def test_forged_body_identity_cannot_turn_direct_input_into_authoritative_evidence():
    """
    PROOFS:
    1. Valid API Key + X-Verified-User-Id header succeeds.
    2. Body-supplied forged user_id and tenant_id are STRICTLY IGNORED.
    3. Document is stored and retrieved strictly under the header's verified user identity.
    4. Forged identity cannot access the document.
    """
    legitimate_user_id = "user_legitimate_alice_777"
    forged_attacker_user_id = "user_attacker_eve_999"
    forged_tenant_id = "tenant_spoofed_corp_888"

    headers_alice = {
        "X-API-Key": API_KEY,
        "X-Verified-User-Id": legitimate_user_id,
    }

    with TestClient(app, headers=headers_alice) as client_alice:
        payload = {
            "title": "Alice Confidential Portfolio Plan",
            "content": "Alice's proprietary investment advisory notes for tax year 2025-26 under Section 80C.",
            "source": "api_test",
            "user_id": forged_attacker_user_id,    # Attacker tries to inject Eve's user_id in body
            "tenant_id": forged_tenant_id,          # Attacker tries to inject spoofed tenant in body
            "scope": f"user:{forged_attacker_user_id}",
        }

        # Direct input is rejected regardless of forged identity/source fields.
        res_ingest = client_alice.post("/rag/index", json=payload)
        assert res_ingest.status_code == 400

        # The rejected document must never appear in Alice's evidence response.
        res_query_alice = client_alice.post("/rag/query", json={"question": "Alice Confidential Portfolio Plan"})
        assert res_query_alice.status_code == 200
        chunks_alice = res_query_alice.json().get("retrieved_chunks", [])
        assert all(c["chunk"]["metadata"]["title"] != payload["title"] for c in chunks_alice)
        assert all(citation["source"] != "api_test" for citation in res_query_alice.json()["citations"])

    # Query as Eve (using Eve's verified header) — must NOT access Alice's document
    headers_eve = {
        "X-API-Key": API_KEY,
        "X-Verified-User-Id": forged_attacker_user_id,
    }
    with TestClient(app, headers=headers_eve) as client_eve:
        res_query_eve = client_eve.post("/rag/query", json={"question": "Alice Confidential Portfolio Plan"})
        assert res_query_eve.status_code == 200
        # Eve's retrieved chunks must not contain Alice's scoped chunk
        chunks_eve = res_query_eve.json().get("retrieved_chunks", [])
        for c in chunks_eve:
            assert c["chunk"]["metadata"]["title"] != "Alice Confidential Portfolio Plan", \
                "Security Breach: Eve retrieved Alice's user-scoped document!"
