"""
WealthGenie Open-Weight LLM Platform - FastAPI Router
Exposes dedicated endpoints (/llm/generate, /llm/rag-query, /llm/batch-generate, /llm/tool-query, /llm/models, /llm/switch, /llm/status, /llm/health).
"""

import logging
from typing import Dict, Any, List
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from llm.config import LLMConfig
from llm.inference.rag_integration import RAGLLMPipeline
from llm.inference.tools import ToolCallingEngine
from llm.registry import llm_registry
from llm.schema import LLMGenerateRequest, LLMGenerateResponse
from rag.schema import RAGQueryRequest, RAGQueryResponse
from security import verify_api_key, verify_verified_user_id, verify_operator_key

logger = logging.getLogger("wealthgenie.llm.router")

llm_router = APIRouter(prefix="/llm", tags=["Open-Weight LLM Platform"], dependencies=[Depends(verify_api_key)])
llm_config = LLMConfig.from_env()
tool_engine = ToolCallingEngine()
rag_llm_pipeline = RAGLLMPipeline(model_registry=llm_registry)


class SwitchModelRequest(BaseModel):
    provider_key: str = Field(..., description="Provider key to activate (e.g. mock, huggingface, api, local)")


class ToolQueryRequest(BaseModel):
    tool_name: str = Field(..., description="Name of a non-authoritative calculator to execute (calculate_sip, calculate_cagr)")
    arguments: Dict[str, Any] = Field(..., description="Tool input parameters")


@llm_router.get("/health")
def llm_health():
    """Health check endpoint for the LLM infrastructure."""
    try:
        active_provider = llm_registry.get_active_provider()
    except RuntimeError:
        return {
            "status": "degraded",
            "service": "WealthGenie Open-Weight LLM Platform",
            "active_model": None,
            "provider": None,
            "device": None,
        }
    is_healthy = active_provider.is_healthy()
    meta = active_provider.get_metadata()
    return {
        "status": "ok" if is_healthy else "degraded",
        "service": "WealthGenie Open-Weight LLM Platform",
        "active_model": meta.model_name,
        "provider": meta.provider.value,
        "device": meta.device,
    }


@llm_router.get("/status")
def llm_status():
    """Returns runtime execution metrics, device bindings, and quantization options."""
    try:
        active_provider = llm_registry.get_active_provider()
    except RuntimeError:
        active_metadata = None
    else:
        active_metadata = active_provider.get_metadata().model_dump()
    return {
        "active_model_metadata": active_metadata,
        "registered_models_count": len(llm_registry.list_models()),
        "configured_device": llm_config.device,
        "configured_quantization": llm_config.quantization,
        "default_max_new_tokens": llm_config.max_new_tokens,
    }


@llm_router.get("/models")
def list_models():
    """Lists all registered LLM providers and their metadata summaries."""
    return {"models": llm_registry.list_models()}


@llm_router.post("/generate", response_model=LLMGenerateResponse)
def generate_text(
    request: LLMGenerateRequest,
    http_request: Request,
    verified_user_id: str = Depends(verify_verified_user_id),
):
    """
    Generates text using the currently active Open-Weight LLM provider.
    Scoped strictly to the verified_user_id from X-Verified-User-Id header.
    """
    request.tenant_id = verified_user_id
    try:
        provider = llm_registry.get_active_provider()
        return provider.generate(request)
    except Exception as e:
        correlation_id = getattr(http_request.state, "correlation_id", "unavailable")
        logger.error(
            "LLM generation failed (error_type=%s correlation_id=%s)",
            type(e).__name__,
            correlation_id,
        )
        raise HTTPException(
            status_code=500,
            detail="Text generation could not be completed. Please try again later.",
        ) from None


@llm_router.post("/batch-generate")
def batch_generate(
    requests: List[LLMGenerateRequest],
    http_request: Request,
    verified_user_id: str = Depends(verify_verified_user_id),
):
    """Runs batch inference generation across multiple LLM requests."""
    try:
        provider = llm_registry.get_active_provider()
        for req in requests:
            req.tenant_id = verified_user_id
        responses = [provider.generate(req) for req in requests]
        return {"batch_count": len(responses), "responses": [r.model_dump() for r in responses]}
    except Exception as e:
        correlation_id = getattr(http_request.state, "correlation_id", "unavailable")
        logger.error(
            "Batch generation failed (error_type=%s correlation_id=%s)",
            type(e).__name__,
            correlation_id,
        )
        raise HTTPException(
            status_code=500,
            detail="Batch generation could not be completed. Please try again later.",
        ) from None


@llm_router.post("/rag-query", response_model=RAGQueryResponse)
def rag_llm_query(
    request: RAGQueryRequest,
    http_request: Request,
    verified_user_id: str = Depends(verify_verified_user_id),
):
    """Returns trust-gated extractive RAG evidence or explicit abstention."""
    request.user_id = verified_user_id
    request.scope = f"user:{verified_user_id}"
    request.tenant_id = "default"
    try:
        return rag_llm_pipeline.query(request)
    except Exception as e:
        correlation_id = getattr(http_request.state, "correlation_id", "unavailable")
        logger.error(
            "RAG LLM query failed (error_type=%s correlation_id=%s)",
            type(e).__name__,
            correlation_id,
        )
        raise HTTPException(
            status_code=500,
            detail="RAG-assisted generation could not be completed. Please try again later.",
        ) from None


@llm_router.post("/tool-query")
def tool_query(
    request: ToolQueryRequest,
    verified_user_id: str = Depends(verify_verified_user_id),
):
    """Executes non-authoritative SIP or historical CAGR calculations."""
    res = tool_engine.execute_tool(request.tool_name, request.arguments)
    if not res.success:
        raise HTTPException(status_code=400, detail=res.result.get("error", "Tool execution failed"))
    return res.model_dump()


@llm_router.get("/tools")
def list_financial_tools():
    """Lists registered financial calculator tools."""
    return {"tools": tool_engine.list_tools()}


@llm_router.post("/switch", dependencies=[Depends(verify_operator_key)])
def switch_model(request: SwitchModelRequest):
    """Switches the active LLM provider dynamically at runtime."""
    success = llm_registry.set_active_provider(request.provider_key)
    if not success:
        raise HTTPException(status_code=400, detail=f"Failed to activate provider '{request.provider_key}'.")
    active_meta = llm_registry.get_active_provider().get_metadata()
    return {
        "status": "success",
        "message": f"Active LLM provider switched to '{request.provider_key}'.",
        "active_model": active_meta.model_name,
    }
