"""
WealthGenie Open-Weight LLM Platform - Hugging Face Provider Implementation
Executes open-weight LLMs (Qwen, Llama, Mistral) via Transformers with auto-device selection and quantization support.
"""

import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Generator, Optional, Any

from llm.providers.base import BaseLLMProvider
from llm.providers.checkpoint_safety import validate_checkpoint_shard_indexes
from llm.schema import (
    LLMGenerateRequest,
    LLMGenerateResponse,
    LLMMetadata,
    LLMProviderType,
    QuantizationType,
)

logger = logging.getLogger("wealthgenie.llm.huggingface")


class HuggingFaceLLMProvider(BaseLLMProvider):
    """Hugging Face Transformers provider for loading and serving open-weight LLMs."""

    def __init__(
        self,
        model_id: str = "Qwen/Qwen2.5-0.5B-Instruct",
        device: str = "cpu",
        quantization: str = "float16",
        cache_dir: Optional[Any] = None,
        load_weights: bool = False,
    ):
        self.model_id = model_id
        self.device = device
        self.quantization = quantization
        self.cache_dir = cache_dir
        self.load_weights = load_weights
        self.loaded_at = datetime.now(timezone.utc).isoformat()

        self.tokenizer = None
        self.model = None
        self.pipeline = None
        self._is_loaded = False

        if self.load_weights:
            self._load_model()

    def _load_model(self) -> None:
        """Loads model weights and tokenizer from Hugging Face hub or local cache."""
        try:
            import torch
            from huggingface_hub import snapshot_download
            from transformers import AutoTokenizer, AutoModelForCausalLM

            logger.info(f"Loading Hugging Face model '{self.model_id}' on device '{self.device}'...")

            model_dtype = torch.float32
            if self.device == "cpu":
                if self.quantization in ("float16", "fp16", "bfloat16", "bf16"):
                    logger.info(
                        f"CPU device detected — overriding float16/quantization '{self.quantization}' to float32 for generation stability."
                    )
                model_dtype = torch.float32
            else:
                if self.quantization in ("float16", "fp16"):
                    model_dtype = torch.float16
                elif self.quantization in ("bfloat16", "bf16") and hasattr(torch, "bfloat16"):
                    model_dtype = torch.bfloat16

            model_path = Path(self.model_id)
            if model_path.exists():
                resolved_model_path = str(model_path.resolve())
            else:
                snapshot_kwargs = {
                    "repo_id": self.model_id,
                    "cache_dir": str(self.cache_dir) if self.cache_dir else None,
                }
                try:
                    resolved_model_path = snapshot_download(
                        **snapshot_kwargs,
                        local_files_only=True,
                    )
                except Exception as local_error:
                    offline = os.environ.get("HF_HUB_OFFLINE", "").lower() in {"1", "true", "yes"}
                    offline = offline or os.environ.get("TRANSFORMERS_OFFLINE", "").lower() in {"1", "true", "yes"}
                    if offline:
                        raise RuntimeError(
                            f"Local model snapshot is unavailable while offline: {local_error}"
                        ) from local_error
                    resolved_model_path = snapshot_download(**snapshot_kwargs)

            # Passing the resolved directory (rather than a repository ID) avoids
            # tokenizer metadata network calls after a snapshot is already cached.
            # Transformers may delegate sharded checkpoint loading to Accelerate;
            # validate index-supplied paths before either tokenizer or model loads.
            validate_checkpoint_shard_indexes(resolved_model_path)
            self.tokenizer = AutoTokenizer.from_pretrained(
                resolved_model_path,
                local_files_only=True,
                trust_remote_code=False,
            )

            # Auto model loading
            self.model = AutoModelForCausalLM.from_pretrained(
                resolved_model_path,
                dtype=model_dtype,
                device_map="auto" if self.device != "cpu" else None,
                local_files_only=True,
                trust_remote_code=False,
                use_safetensors=True,
            )

            if self.device == "cpu" and hasattr(self.model, "to"):
                self.model = self.model.to("cpu")

            self._is_loaded = True
            logger.info(f"Hugging Face model '{self.model_id}' loaded successfully.")

        except Exception as e:
            logger.warning(
                "Could not load native weights for model '%s' (error_type=%s).",
                self.model_id,
                type(e).__name__,
            )
            self._is_loaded = False

    def generate(self, request: LLMGenerateRequest) -> LLMGenerateResponse:
        t0 = time.perf_counter()

        if not self._is_loaded or self.model is None or self.tokenizer is None:
            raise RuntimeError(
                f"Hugging Face model '{self.model_id}' is not loaded. "
                "Ensure weights are downloaded and loaded successfully."
            )

        try:
            import torch
            full_prompt = f"{request.system_prompt}\nUser: {request.prompt}\nAssistant:"
            inputs = self.tokenizer(full_prompt, return_tensors="pt")
            if self.device != "cpu" and hasattr(inputs, "to"):
                inputs = inputs.to(self.device)

            with torch.no_grad():
                outputs = self.model.generate(
                    **inputs,
                    max_new_tokens=request.max_new_tokens,
                    temperature=request.temperature,
                    top_p=request.top_p,
                    do_sample=request.temperature > 0.0,
                )

            generated_ids = outputs[0][inputs.input_ids.shape[1]:]
            text = self.tokenizer.decode(generated_ids, skip_special_tokens=True)
            latency_ms = (time.perf_counter() - t0) * 1000.0

            return LLMGenerateResponse(
                text=text.strip(),
                finish_reason="stop",
                prompt_tokens=inputs.input_ids.shape[1],
                completion_tokens=len(generated_ids),
                latency_ms=round(latency_ms, 2),
                model_name=self.model_id,
                provider="huggingface",
            )
        except Exception as e:
            logger.error(
                "Hugging Face generation failed for model '%s' (error_type=%s).",
                self.model_id,
                type(e).__name__,
            )
            raise RuntimeError("Hugging Face generation failed.") from None

    def generate_stream(self, request: LLMGenerateRequest) -> Generator[str, None, None]:
        res = self.generate(request)
        for chunk in res.text.split():
            yield chunk + " "

    def get_metadata(self) -> LLMMetadata:
        return LLMMetadata(
            model_name=self.model_id,
            provider=LLMProviderType.HUGGINGFACE,
            quantization=QuantizationType(self.quantization) if self.quantization in QuantizationType.__members__.values() else QuantizationType.FP16,
            device=self.device,
            context_window=2048,
            version="2.5.0-hf",
            loaded_at=self.loaded_at,
            parameters_count="0.5B",
        )

    def is_healthy(self) -> bool:
        if self.load_weights:
            return self._is_loaded
        return True
