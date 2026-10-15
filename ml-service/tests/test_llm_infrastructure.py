"""
WealthGenie Production Open-Weight LLM Platform - Infrastructure Test Suite (Phase 3.1)
Tests LLMConfig, Providers (Mock, API, HF), Local Loader, Model Registry, and FastAPI endpoints.
"""

import os
import pytest
from fastapi.testclient import TestClient
from main import app
from llm.config import LLMConfig
from llm.providers.api_provider import APILLMProvider
from llm.providers.checkpoint_safety import validate_checkpoint_shard_indexes
from llm.providers.huggingface_provider import HuggingFaceLLMProvider
from llm.providers.local_loader import LocalLLMLoader
from llm.providers.mock_provider import MockLLMProvider
from llm.registry import LLMModelRegistry
from llm.schema import LLMGenerateRequest, LLMProviderType

@pytest.fixture
def client(monkeypatch):
    api_key = os.environ.get("ML_SERVICE_API_KEY", "wealthgenie_secret_api_key_2026")
    operator_key = os.environ.get("ML_OPERATOR_KEY", "wealthgenie_operator_secret_key_9999")
    monkeypatch.setenv("ML_SERVICE_API_KEY", api_key)
    monkeypatch.setenv("ML_OPERATOR_KEY", operator_key)
    with TestClient(app, headers={"X-API-Key": api_key, "X-Verified-User-Id": "test-user-id"}) as c:
        yield c


def test_llm_config_defaults_and_env(monkeypatch):
    config = LLMConfig()
    assert config.default_provider in ("mock", "huggingface", "api", "local")
    assert config.max_new_tokens == 512

    monkeypatch.setenv("LLM_DEFAULT_PROVIDER", "huggingface")
    monkeypatch.setenv("LLM_MAX_NEW_TOKENS", "1024")
    env_config = LLMConfig.from_env()
    assert env_config.default_provider == "huggingface"
    assert env_config.max_new_tokens == 1024


def test_mock_llm_provider(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    provider = MockLLMProvider(model_name="Test-Mock-0.5B")
    assert provider.is_healthy()

    meta = provider.get_metadata()
    assert meta.model_name == "Test-Mock-0.5B"
    assert meta.provider == LLMProviderType.MOCK

    req = LLMGenerateRequest(prompt="What is Section 87A rebate?")
    res = provider.generate(req)
    assert "Section 87A" in res.text
    assert res.completion_tokens > 0
    assert res.provider == "mock"

    stream_tokens = list(provider.generate_stream(req))
    assert len(stream_tokens) > 0


def test_production_mock_provider_cannot_emit_synthetic_financial_facts(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    config = LLMConfig(default_provider="mock")
    registry = LLMModelRegistry(config)
    provider = MockLLMProvider()
    request = LLMGenerateRequest(prompt="What is the Section 87A rebate?")

    assert not provider.is_healthy()
    assert all(not model["is_active"] for model in registry.list_models())
    with pytest.raises(RuntimeError, match="No healthy LLM provider is active"):
        registry.get_active_provider()
    with pytest.raises(RuntimeError, match="mock LLM provider is disabled"):
        provider.generate(request)
    with pytest.raises(RuntimeError, match="mock LLM provider is disabled"):
        list(provider.generate_stream(request))


@pytest.mark.parametrize("environment", [None, "", "staging-typo"])
def test_mock_provider_is_disabled_without_an_explicit_local_environment(monkeypatch, environment):
    from llm.providers.mock_provider import _mock_generation_allowed

    monkeypatch.delenv("ENVIRONMENT", raising=False)
    monkeypatch.delenv("NODE_ENV", raising=False)
    if environment is not None:
        monkeypatch.setenv("ENVIRONMENT", environment)

    assert _mock_generation_allowed() is False


def test_api_llm_provider():
    provider = APILLMProvider(model_name="Test-API-Model")
    assert not provider.is_healthy()

    req = LLMGenerateRequest(prompt="Portfolio allocation rules")
    with pytest.raises(RuntimeError, match="transport is not configured"):
        provider.generate(req)
    with pytest.raises(RuntimeError, match="transport is not configured"):
        provider.generate_stream(req)


def test_huggingface_llm_provider_fallback(monkeypatch, tmp_path):
    import sys
    import types

    # Unloaded instance should raise RuntimeError when calling generate (no fake fallback response)
    unloaded_provider = HuggingFaceLLMProvider(model_id="Qwen/Qwen2.5-0.5B-Instruct", device="cpu", load_weights=False)
    meta = unloaded_provider.get_metadata()
    assert meta.model_name == "Qwen/Qwen2.5-0.5B-Instruct"

    req = LLMGenerateRequest(prompt="Income tax slabs 2026")
    with pytest.raises(RuntimeError, match="is not loaded"):
        unloaded_provider.generate(req)

    class FakeInputBatch(dict):
        def __init__(self):
            super().__init__(input_ids=[[1, 2]])
            self.input_ids = types.SimpleNamespace(shape=(1, 2))

    class FakeTokenizer:
        @classmethod
        def from_pretrained(cls, *_args, **_kwargs):
            return cls()

        def __call__(self, _prompt, **_kwargs):
            return FakeInputBatch()

        @staticmethod
        def decode(_tokens, **_kwargs):
            return "local fake response"

    class FakeModel:
        @classmethod
        def from_pretrained(cls, *_args, **_kwargs):
            return cls()

        def to(self, _device):
            return self

        @staticmethod
        def generate(**_kwargs):
            return [[1, 2, 3, 4]]

    class NoGrad:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    fake_torch = types.ModuleType("torch")
    fake_torch.float32 = "float32"
    fake_torch.no_grad = NoGrad
    fake_transformers = types.ModuleType("transformers")
    fake_transformers.AutoTokenizer = FakeTokenizer
    fake_transformers.AutoModelForCausalLM = FakeModel
    fake_hub = types.ModuleType("huggingface_hub")
    fake_hub.snapshot_download = lambda **_kwargs: pytest.fail("existing local fixture must not download")
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setitem(sys.modules, "transformers", fake_transformers)
    monkeypatch.setitem(sys.modules, "huggingface_hub", fake_hub)

    # Exercise the real loader/provider wrapper against a local model-path fixture.
    loaded_provider = LocalLLMLoader.load_provider(provider_type="huggingface", model_id=str(tmp_path), device="cpu")
    assert loaded_provider.is_healthy()
    res = loaded_provider.generate(req)
    assert res.text == "local fake response"
    assert res.provider == "huggingface"


def test_huggingface_provider_disables_remote_code_execution(monkeypatch, tmp_path):
    """Model repositories must never execute arbitrary Python during loading."""
    import sys
    import types

    calls = {}

    class FakeTokenizer:
        @staticmethod
        def from_pretrained(_path, **kwargs):
            calls["tokenizer"] = kwargs
            return object()

    class FakeModelInstance:
        def to(self, _device):
            return self

    class FakeModel:
        @staticmethod
        def from_pretrained(_path, **kwargs):
            calls["model"] = kwargs
            return FakeModelInstance()

    fake_transformers = types.ModuleType("transformers")
    setattr(fake_transformers, "AutoTokenizer", FakeTokenizer)
    setattr(fake_transformers, "AutoModelForCausalLM", FakeModel)
    fake_hub = types.ModuleType("huggingface_hub")
    setattr(fake_hub, "snapshot_download", lambda **_kwargs: str(tmp_path))
    monkeypatch.setitem(sys.modules, "transformers", fake_transformers)
    monkeypatch.setitem(sys.modules, "huggingface_hub", fake_hub)

    provider = HuggingFaceLLMProvider(model_id=str(tmp_path), device="cpu", load_weights=True)

    assert provider.is_healthy()
    assert calls["tokenizer"]["trust_remote_code"] is False
    assert calls["model"]["trust_remote_code"] is False
    assert calls["model"]["use_safetensors"] is True
    assert calls["model"]["dtype"] is not None
    assert "torch_dtype" not in calls["model"]


def test_checkpoint_index_rejects_paths_outside_model_directory(tmp_path):
    import json

    checkpoint = tmp_path / "checkpoint"
    checkpoint.mkdir()
    (checkpoint / "model.safetensors.index.json").write_text(
        json.dumps({"weight_map": {"layer.weight": "../outside.safetensors"}}),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="escapes the checkpoint directory"):
        validate_checkpoint_shard_indexes(checkpoint)


def test_checkpoint_index_rejects_absolute_shard_paths(tmp_path):
    import json

    checkpoint = tmp_path / "checkpoint"
    checkpoint.mkdir()
    index = checkpoint / "model.safetensors.index.json"
    index.write_text(json.dumps({"weight_map": {"layer.weight": str(tmp_path / "outside.safetensors")}}), encoding="utf-8")
    with pytest.raises(ValueError, match="absolute shard path"):
        validate_checkpoint_shard_indexes(checkpoint)


def test_checkpoint_index_rejects_symlinked_parent_paths(tmp_path):
    import json

    checkpoint = tmp_path / "checkpoint"
    outside = tmp_path / "outside"
    checkpoint.mkdir()
    outside.mkdir()
    (outside / "weights.safetensors").write_bytes(b"test")
    try:
        (checkpoint / "linked-dir").symlink_to(outside, target_is_directory=True)
    except OSError as exc:
        pytest.skip(f"directory symlinks are unavailable: {exc}")

    index = checkpoint / "model.safetensors.index.json"
    index.write_text(json.dumps({"weight_map": {"layer.weight": "linked-dir/weights.safetensors"}}), encoding="utf-8")
    with pytest.raises(ValueError, match="symlinked directory"):
        validate_checkpoint_shard_indexes(checkpoint)


def test_checkpoint_index_rejects_index_symlinks_outside_checkpoint(tmp_path):
    import json

    checkpoint = tmp_path / "checkpoint"
    checkpoint.mkdir()
    external_index = tmp_path / "external.index.json"
    external_index.write_text(json.dumps({"weight_map": {"layer.weight": "weights.safetensors"}}), encoding="utf-8")
    try:
        (checkpoint / "model.safetensors.index.json").symlink_to(external_index)
    except OSError as exc:
        pytest.skip(f"file symlinks are unavailable: {exc}")

    with pytest.raises(ValueError, match="does not target the Hugging Face repository blob store"):
        validate_checkpoint_shard_indexes(checkpoint)


def test_checkpoint_index_allows_trusted_huggingface_blob_symlinks(tmp_path):
    import json

    repository = tmp_path / "models--wealthgenie--fixture"
    checkpoint = repository / "snapshots" / "fixture-revision"
    blob_directory = repository / "blobs"
    checkpoint.mkdir(parents=True)
    blob_directory.mkdir()
    (blob_directory / "index-blob").write_text(
        json.dumps({"weight_map": {"layer.weight": "weights.safetensors"}}),
        encoding="utf-8",
    )
    (blob_directory / "weights-blob").write_bytes(b"fixture")
    try:
        (checkpoint / "model.safetensors.index.json").symlink_to(blob_directory / "index-blob")
        (checkpoint / "weights.safetensors").symlink_to(blob_directory / "weights-blob")
    except OSError as exc:
        pytest.skip(f"file symlinks are unavailable: {exc}")

    validate_checkpoint_shard_indexes(checkpoint)


def test_checkpoint_index_rejects_non_regular_shards(tmp_path):
    import json
    import os

    if not hasattr(os, "mkfifo"):
        pytest.skip("FIFO creation is unavailable on this platform")
    checkpoint = tmp_path / "checkpoint"
    checkpoint.mkdir()
    os.mkfifo(checkpoint / "blocked-shard")
    (checkpoint / "model.safetensors.index.json").write_text(
        json.dumps({"weight_map": {"layer.weight": "blocked-shard"}}),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="not a regular file"):
        validate_checkpoint_shard_indexes(checkpoint)


def test_huggingface_provider_rejects_unsafe_index_before_model_loading(monkeypatch, tmp_path):
    import json
    import sys
    import types

    calls = []
    (tmp_path / "model.safetensors.index.json").write_text(
        json.dumps({"weight_map": {"layer.weight": "../../outside.safetensors"}}),
        encoding="utf-8",
    )
    fake_transformers = types.ModuleType("transformers")
    fake_transformers.AutoTokenizer = types.SimpleNamespace(
        from_pretrained=lambda *_args, **_kwargs: calls.append("tokenizer"),
    )
    fake_transformers.AutoModelForCausalLM = types.SimpleNamespace(
        from_pretrained=lambda *_args, **_kwargs: calls.append("model"),
    )
    fake_hub = types.ModuleType("huggingface_hub")
    fake_hub.snapshot_download = lambda **_kwargs: str(tmp_path)
    fake_torch = types.ModuleType("torch")
    fake_torch.float32 = "float32"
    monkeypatch.setitem(sys.modules, "transformers", fake_transformers)
    monkeypatch.setitem(sys.modules, "huggingface_hub", fake_hub)
    monkeypatch.setitem(sys.modules, "torch", fake_torch)

    provider = HuggingFaceLLMProvider(model_id=str(tmp_path), device="cpu", load_weights=True)

    assert not provider.is_healthy()
    assert calls == []


def test_local_llm_loader():
    provider = LocalLLMLoader.load_provider(provider_type="mock", model_id="Local-Mock-1B")
    assert provider.get_metadata().model_name == "Local-Mock-1B"

    with pytest.raises(ValueError, match="Unknown LLM provider"):
        LocalLLMLoader.load_provider(provider_type="typo-provider")
    with pytest.raises(ValueError, match="transport is configured"):
        LocalLLMLoader.load_provider(provider_type="api")


def test_llm_model_registry():
    registry = LLMModelRegistry()
    mock_p = MockLLMProvider(model_name="Reg-Mock")
    api_p = APILLMProvider(model_name="Reg-API")

    registry.register_provider("reg_mock", mock_p, make_active=True)
    registry.register_provider("reg_api", api_p)

    assert registry.get_active_provider().get_metadata().model_name == "Reg-Mock"

    assert not registry.set_active_provider("reg_api")
    assert registry.get_active_provider().get_metadata().model_name == "Reg-Mock"

    models_list = registry.list_models()
    assert len(models_list) >= 2


def test_fastapi_llm_endpoints(client):
    # Health endpoint
    res_health = client.get("/llm/health")
    assert res_health.status_code == 200
    assert res_health.json()["status"] in ("ok", "degraded")

    # Status endpoint
    res_status = client.get("/llm/status")
    assert res_status.status_code == 200
    assert "active_model_metadata" in res_status.json()

    # Models endpoint
    res_models = client.get("/llm/models")
    assert res_models.status_code == 200
    assert "models" in res_models.json()

    # Generate endpoint
    gen_payload = {
        "prompt": "Explain mutual fund expense ratios.",
        "max_new_tokens": 128,
        "temperature": 0.5,
    }
    res_gen = client.post("/llm/generate", json=gen_payload)
    assert res_gen.status_code == 200
    assert len(res_gen.json()["text"]) > 0
    assert res_gen.json()["completion_tokens"] > 0

    # Switch endpoint
    operator_key = os.environ.get("ML_OPERATOR_KEY", "wealthgenie_operator_secret_key_9999")
    res_switch = client.post("/llm/switch", json={"provider_key": "mock"}, headers={"X-Operator-Key": operator_key})
    assert res_switch.status_code == 200
    assert res_switch.json()["status"] == "success"

    invalid_switch = client.post(
        "/llm/switch",
        json={"provider_key": "typo-provider"},
        headers={"X-Operator-Key": operator_key},
    )
    assert invalid_switch.status_code == 400
