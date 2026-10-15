"""
WealthGenie Open-Weight LLM Platform - Mock Provider Implementation
Provides high-speed, domain-aware synthetic LLM generation for testing and offline fallback.
"""

import os
import time
from datetime import datetime, timezone
from typing import Generator
from llm.providers.base import BaseLLMProvider
from environment_policy import local_mode_explicitly_enabled
from llm.schema import (
    LLMGenerateRequest,
    LLMGenerateResponse,
    LLMMetadata,
    LLMProviderType,
    QuantizationType,
)

def _mock_generation_allowed() -> bool:
    # The synthetic provider may only run when the ML service explicitly opts
    # into a local/test mode. An absent ENVIRONMENT must never enable it.
    return local_mode_explicitly_enabled(os.environ)


class MockLLMProvider(BaseLLMProvider):
    """Mock LLM Provider for rapid offline testing and seamless fallback."""

    def __init__(self, model_name: str = "WealthGenie-Synthetic-LLM-0.5B"):
        self.model_name = model_name
        self.loaded_at = datetime.now(timezone.utc).isoformat()

    def generate(self, request: LLMGenerateRequest) -> LLMGenerateResponse:
        if not _mock_generation_allowed():
            raise RuntimeError("The mock LLM provider is disabled outside local and test environments.")
        t0 = time.perf_counter()

        # Domain-aware response synthesis
        prompt_lower = request.prompt.lower()
        if "87a" in prompt_lower or "tax" in prompt_lower:
            body = (
                "Under the Indian Income Tax Act (Section 87A), resident individuals with a net taxable income "
                "up to ₹7,00,000 under the New Tax Regime are eligible for a maximum tax rebate of ₹25,000, "
                "effectively reducing their income tax liability to zero."
            )
        elif "invest" in prompt_lower or "portfolio" in prompt_lower:
            body = (
                "A balanced wealth management portfolio should allocate assets across diversified equity mutual funds, "
                "fixed-income instruments, emergency liquidity buffers, and tax-saving avenues based on risk appetite."
            )
        else:
            body = (
                f"As an AI financial advisor, here is guidance regarding your request: '{request.prompt[:60]}...'. "
                "Please review official regulatory documentation or consult a SEBI-registered advisor."
            )

        latency_ms = (time.perf_counter() - t0) * 1000.0
        prompt_tokens = len(request.prompt.split()) + 10
        completion_tokens = len(body.split())

        return LLMGenerateResponse(
            text=body,
            finish_reason="stop",
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            latency_ms=round(latency_ms, 2),
            model_name=self.model_name,
            provider="mock",
        )

    def generate_stream(self, request: LLMGenerateRequest) -> Generator[str, None, None]:
        res = self.generate(request)
        words = res.text.split()
        for w in words:
            yield w + " "
            time.sleep(0.01)

    def get_metadata(self) -> LLMMetadata:
        return LLMMetadata(
            model_name=self.model_name,
            provider=LLMProviderType.MOCK,
            quantization=QuantizationType.FP16,
            device="cpu",
            context_window=2048,
            version="1.0.0-mock",
            loaded_at=self.loaded_at,
            parameters_count="0.5B",
        )

    def is_healthy(self) -> bool:
        return _mock_generation_allowed()
