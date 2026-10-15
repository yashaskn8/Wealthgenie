"""
WealthGenie Open-Weight LLM Platform - Production Inference Test Suite (Phase 3.5)
Tests conversation management, financial tool calling, batch inference, and RAG+LLM endpoints.
"""

import pytest
from fastapi.testclient import TestClient

from llm.inference.conversation import ConversationHistory
from llm.inference.tools import ToolCallingEngine
from llm.schema import LLMGenerateRequest
from rag.schema import RAGQueryRequest


def test_conversation_history_management():
    conv = ConversationHistory(session_id="session-001")
    assert conv.session_id == "session-001"
    assert len(conv.messages) == 0

    conv.add_message("user", "What is Section 87A?")
    conv.add_message("assistant", "Section 87A provides a tax rebate.")
    assert len(conv.messages) == 2

    payload = conv.get_messages_payload()
    assert payload[0]["role"] == "user"
    assert payload[1]["content"] == "Section 87A provides a tax rebate."

    conv.clear()
    assert len(conv.messages) == 0


def test_conversation_sliding_window_truncation():
    conv = ConversationHistory(session_id="session-002", max_history_turns=3)
    for i in range(10):
        conv.add_message("user", f"Question {i}")
        conv.add_message("assistant", f"Answer {i}")
    # Should retain only the last max_history_turns * 2 = 6 messages
    assert len(conv.messages) <= 6


def test_tool_calling_engine_sip():
    engine = ToolCallingEngine()
    result = engine.execute_tool("calculate_sip", {
        "monthly_investment": 10000, "rate_pct": 12.0, "years": 10,
    })
    assert result.success
    assert result.result["estimated_future_value"] > 0
    assert result.result["total_invested"] == 1200000.0


def test_tool_calling_engine_cagr():
    engine = ToolCallingEngine()
    result = engine.execute_tool("calculate_cagr", {
        "initial_value": 100000, "final_value": 200000, "years": 5,
    })
    assert result.success
    assert 14.0 <= result.result["cagr_percent"] <= 15.0


def test_tax_tool_is_not_available_outside_the_canonical_backend():
    engine = ToolCallingEngine()
    result = engine.execute_tool("calculate_tax_rebate", {
        "annual_income": 600000,
        "regime": "old",
        "income_source": "salary",
        "deductions": {"other": 600000},
    })
    assert result.success is False
    assert "Unknown tool name" in result.result["error"]
    assert "calculate_tax_rebate" not in {tool["name"] for tool in engine.list_tools()}


def test_tool_calling_engine_unknown_tool():
    engine = ToolCallingEngine()
    result = engine.execute_tool("nonexistent_tool", {})
    assert not result.success
    assert "error" in result.result


def test_tool_calling_engine_list_tools():
    engine = ToolCallingEngine()
    tools = engine.list_tools()
    assert len(tools) == 2
    names = [t["name"] for t in tools]
    assert "calculate_sip" in names
    assert "calculate_cagr" in names
    assert "calculate_tax_rebate" not in names


def test_llm_router_batch_generate_and_tool_endpoints():
    import os
    from main import app
    api_key = os.environ.get("ML_SERVICE_API_KEY", "wealthgenie_secret_api_key_2026")
    client = TestClient(app, headers={"X-API-Key": api_key, "X-Verified-User-Id": "test-user-id"})

    # Batch generate
    batch_res = client.post("/llm/batch-generate", json=[
        {"prompt": "What is ELSS?"},
        {"prompt": "Explain PPF."},
    ])
    assert batch_res.status_code == 200
    data = batch_res.json()
    assert data["batch_count"] == 2
    assert len(data["responses"]) == 2

    # Tool query
    tool_res = client.post("/llm/tool-query", json={
        "tool_name": "calculate_sip",
        "arguments": {"monthly_investment": 5000, "rate_pct": 10.0, "years": 5},
    })
    assert tool_res.status_code == 200
    assert tool_res.json()["success"]

    # List tools
    tools_res = client.get("/llm/tools")
    assert tools_res.status_code == 200
    assert len(tools_res.json()["tools"]) == 2

    tax_res = client.post("/llm/tool-query", json={
        "tool_name": "calculate_tax_rebate",
        "arguments": {"annual_income": 600000, "regime": "old", "income_source": "salary", "deductions": {"other": 600000}},
    })
    assert tax_res.status_code == 400


@pytest.mark.parametrize(
    ("operation", "failure_target", "public_message"),
    [
        ("generate", "registry", "Text generation could not be completed."),
        ("batch", "registry", "Batch generation could not be completed."),
        ("rag", "rag", "RAG-assisted generation could not be completed."),
    ],
)
def test_llm_backend_errors_are_redacted_from_responses_and_logs(
    operation, failure_target, public_message, monkeypatch, caplog,
):
    import logging
    from llm import router as router_module
    from starlette.requests import Request

    secret_canary = "PAN-987654321012 redis://user:private-password@internal:6379"

    class FailingProvider:
        def generate(self, _request):
            raise RuntimeError(secret_canary)

    def fail_query(_request):
        raise RuntimeError(secret_canary)

    if failure_target == "registry":
        monkeypatch.setattr(router_module.llm_registry, "get_active_provider", lambda: FailingProvider())
    else:
        monkeypatch.setattr(router_module.rag_llm_pipeline, "query", fail_query)

    http_request = Request({
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/test",
        "raw_path": b"/test",
        "query_string": b"",
        "headers": [],
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
        "state": {"correlation_id": "phase13-error-redaction"},
    })
    caplog.set_level(logging.ERROR)
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as error:
        if operation == "generate":
            router_module.generate_text(LLMGenerateRequest(prompt="Explain PPF."), http_request, "phase13-test-user")
        elif operation == "batch":
            router_module.batch_generate(
                [LLMGenerateRequest(prompt="Explain PPF.")],
                http_request,
                "phase13-test-user",
            )
        else:
            router_module.rag_llm_query(
                RAGQueryRequest(question="Explain PPF."),
                http_request,
                "phase13-test-user",
            )

    assert error.value.status_code == 500
    assert public_message in error.value.detail
    assert secret_canary not in error.value.detail
    assert secret_canary not in caplog.text
    assert "error_type=RuntimeError" in caplog.text
    assert "correlation_id=phase13-error-redaction" in caplog.text


def test_llm_health_and_status_remain_available_without_a_healthy_provider(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("LLM_DEFAULT_PROVIDER", "mock")

    from llm import router as router_module
    from llm.config import LLMConfig
    from llm.registry import LLMModelRegistry

    registry = LLMModelRegistry(LLMConfig(default_provider="mock"))
    monkeypatch.setattr(router_module, "llm_registry", registry)

    health = router_module.llm_health()
    status = router_module.llm_status()

    assert health == {
        "status": "degraded",
        "service": "WealthGenie Open-Weight LLM Platform",
        "active_model": None,
        "provider": None,
        "device": None,
    }
    assert status["active_model_metadata"] is None
    assert status["registered_models_count"] == 1
    assert status["configured_device"] == router_module.llm_config.device
    assert status["configured_quantization"] == router_module.llm_config.quantization
    assert status["default_max_new_tokens"] == router_module.llm_config.max_new_tokens
    assert all(not model["is_active"] for model in registry.list_models())
