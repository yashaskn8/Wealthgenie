"""
WealthGenie Open-Weight LLM Platform - Provider & Model Registry
Manages registration, runtime switching, versioning, and lifecycle management for LLM backends.
"""

import logging
from typing import Dict, Any, List, Optional
from llm.config import LLMConfig
from llm.providers.base import BaseLLMProvider
from llm.providers.local_loader import LocalLLMLoader

logger = logging.getLogger("wealthgenie.llm.registry")


class LLMModelRegistry:
    """Enterprise registry for managing LLM providers, model versions, and active model targets."""

    def __init__(self, config: Optional[LLMConfig] = None):
        self.config = config or LLMConfig.from_env()
        self._providers: Dict[str, BaseLLMProvider] = {}
        self._active_provider_key: Optional[str] = None

        # Auto-initialize default provider
        self._initialize_default_provider()

    def _initialize_default_provider(self) -> None:
        """Initializes default active LLM provider from configuration."""
        provider = LocalLLMLoader.load_provider(
            provider_type=self.config.default_provider,
            model_id=self.config.model_id,
            device=self.config.device,
            quantization=self.config.quantization,
            cache_dir=self.config.cache_dir,
        )
        self.register_provider(
            self.config.default_provider,
            provider,
            make_active=provider.is_healthy(),
        )

        if not provider.is_healthy():
            # Keep the configured provider visible as degraded. A mock provider is
            # disabled in production, so do not activate it as a fallback there.
            from llm.providers.mock_provider import MockLLMProvider

            fallback = MockLLMProvider()
            if fallback.is_healthy():
                logger.warning(
                    "Configured LLM provider '%s' is unhealthy; activating the local "
                    "deterministic fallback provider.",
                    self.config.default_provider,
                )
                self.register_provider("mock", fallback, make_active=True)
            else:
                logger.error(
                    "Configured LLM provider '%s' is unhealthy and mock fallback is disabled "
                    "outside local and test environments.",
                    self.config.default_provider,
                )

    def register_provider(self, key: str, provider: BaseLLMProvider, make_active: bool = False) -> None:
        """Registers an LLM provider backend under a unique key."""
        self._providers[key] = provider
        logger.info(f"Registered LLM provider '{key}' (Model: {provider.get_metadata().model_name}).")
        if make_active:
            if provider.is_healthy():
                self._active_provider_key = key
            else:
                if self._active_provider_key == key:
                    self._active_provider_key = None
                logger.warning("Refusing to activate unhealthy LLM provider '%s'.", key)
        elif self._active_provider_key == key and not provider.is_healthy():
            self._active_provider_key = None

    def get_active_provider(self) -> BaseLLMProvider:
        """Returns the currently active LLM provider."""
        provider = self._providers.get(self._active_provider_key) if self._active_provider_key else None
        if provider is None or not provider.is_healthy():
            self._active_provider_key = None
            raise RuntimeError("No healthy LLM provider is active.")
        return provider

    def set_active_provider(self, key: str) -> bool:
        """Switches the active LLM provider dynamically at runtime."""
        if key not in self._providers:
            logger.warning(f"Provider key '{key}' not found in registry. Loading on demand...")
            try:
                provider = LocalLLMLoader.load_provider(provider_type=key, model_id=self.config.model_id)
            except ValueError as exc:
                logger.warning("Rejected unknown provider '%s': %s", key, exc)
                return False
            self.register_provider(key, provider)

        provider = self._providers[key]
        if not provider.is_healthy():
            logger.warning("Refusing to activate unhealthy LLM provider '%s'.", key)
            return False

        self._active_provider_key = key
        logger.info(f"Active LLM provider switched to '{key}'.")
        return True

    def list_models(self) -> List[Dict[str, Any]]:
        """Returns a list of all registered LLM providers and their metadata summaries."""
        results = []
        for key, p in self._providers.items():
            meta = p.get_metadata()
            results.append({
                "key": key,
                "model_name": meta.model_name,
                "provider": meta.provider.value,
                "device": meta.device,
                "quantization": meta.quantization.value,
                "version": meta.version,
                "is_active": (key == self._active_provider_key),
            })
        return results


# Global singleton LLM Model Registry instance
llm_registry = LLMModelRegistry()
