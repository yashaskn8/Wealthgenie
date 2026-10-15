"""
Tests for ML Service fail-closed configuration validation and security startup checks.
"""

import pytest
from fastapi import HTTPException
from security import (
    _verify_api_key_config,
    _verify_operator_key_config,
    validate_ml_service_config,
    validate_ml_operator_config,
)
from environment_policy import local_mode_explicitly_enabled


def test_production_missing_api_key_raises_runtime_error():
    env = {
        "ENVIRONMENT": "production",
        "ML_SERVICE_API_KEY": "",
    }
    with pytest.raises(RuntimeError, match="ML_SERVICE_API_KEY is required in production"):
        validate_ml_service_config(env)


def test_production_placeholder_api_key_raises_runtime_error():
    env = {
        "ENVIRONMENT": "production",
        "ML_SERVICE_API_KEY": "CHANGE_ME_ML_SERVICE_API_KEY",
    }
    with pytest.raises(RuntimeError, match="Insecure placeholder ML_SERVICE_API_KEY"):
        validate_ml_service_config(env)


@pytest.mark.parametrize("weak_key", ["change_me_secure_key_123456789012", "short-secret", "a" * 32, "ab" * 16])
def test_production_rejects_case_insensitive_placeholders_and_short_api_keys(weak_key):
    with pytest.raises(RuntimeError, match="at least 32 characters"):
        validate_ml_service_config({"ENVIRONMENT": "production", "ML_SERVICE_API_KEY": weak_key})


def test_production_valid_api_key_succeeds():
    env = {
        "ENVIRONMENT": "production",
        "ML_SERVICE_API_KEY": "secure_production_secret_key_2026",
    }
    # Should not raise
    validate_ml_service_config(env)


@pytest.mark.parametrize("environment", [None, "", "   ", "staging-typo"])
def test_missing_or_unsupported_environment_fails_closed(environment):
    env = {"ML_SERVICE_API_KEY": "secure_production_secret_key_2026"}
    if environment is not None:
        env["ENVIRONMENT"] = environment

    with pytest.raises(RuntimeError, match="ENVIRONMENT must be explicitly set"):
        validate_ml_service_config(env)


def test_missing_environment_does_not_enable_empty_api_key():
    with pytest.raises(RuntimeError, match="ENVIRONMENT must be explicitly set"):
        validate_ml_service_config({"ML_SERVICE_API_KEY": ""})


def test_local_dev_mode_permits_empty_api_key():
    env = {
        "ENVIRONMENT": "local",
        "ML_SERVICE_API_KEY": "",
    }
    # Should not raise in local dev mode
    validate_ml_service_config(env)


def test_production_missing_operator_key_raises_runtime_error():
    env = {
        "ENVIRONMENT": "production",
        "ML_OPERATOR_KEY": "",
    }
    with pytest.raises(RuntimeError, match="ML_OPERATOR_KEY is required in production"):
        validate_ml_operator_config(env)


def test_production_placeholder_operator_key_raises_runtime_error():
    env = {
        "ENVIRONMENT": "production",
        "ML_OPERATOR_KEY": "CHANGE_ME_OPERATOR_KEY_123",
    }
    with pytest.raises(RuntimeError, match="Insecure placeholder ML_OPERATOR_KEY"):
        validate_ml_operator_config(env)


@pytest.mark.parametrize("weak_key", ["change_me_secure_operator_123456", "short-secret", "a" * 32, "ab" * 16])
def test_production_rejects_case_insensitive_placeholders_and_short_operator_keys(weak_key):
    with pytest.raises(RuntimeError, match="at least 32 characters"):
        validate_ml_operator_config({"ENVIRONMENT": "production", "ML_OPERATOR_KEY": weak_key})


def test_production_valid_operator_key_succeeds():
    env = {
        "ENVIRONMENT": "production",
        "ML_OPERATOR_KEY": "secure_operator_secret_key_99999",
    }
    # Should not raise
    validate_ml_operator_config(env)


def test_local_dev_mode_permits_empty_operator_key():
    env = {
        "ENVIRONMENT": "local",
        "ML_OPERATOR_KEY": "",
    }
    # Should not raise in local dev mode
    validate_ml_operator_config(env)


def test_verify_api_key_rejects_placeholder_in_production():
    with pytest.raises(HTTPException) as exc_info:
        _verify_api_key_config("CHANGE_ME_ML_SERVICE_API_KEY", {
            "ENVIRONMENT": "production",
            "ML_SERVICE_API_KEY": "CHANGE_ME_ML_SERVICE_API_KEY",
        })

    assert exc_info.value.status_code == 500
    assert "Insecure placeholder" in exc_info.value.detail


def test_service_auth_rejects_short_production_key_at_request_time():
    with pytest.raises(HTTPException) as exc_info:
        _verify_api_key_config("short-secret", {
            "ENVIRONMENT": "production",
            "ML_SERVICE_API_KEY": "short-secret",
        })

    assert exc_info.value.status_code == 500
    assert "too short" in exc_info.value.detail


def test_service_auth_rejects_trivially_repetitive_production_key_at_request_time():
    with pytest.raises(HTTPException) as exc_info:
        _verify_api_key_config("a" * 32, {
            "ENVIRONMENT": "production",
            "ML_SERVICE_API_KEY": "a" * 32,
        })

    assert exc_info.value.status_code == 500
    assert "trivially repetitive" in exc_info.value.detail


def test_verify_operator_key_rejects_placeholder_in_production():
    with pytest.raises(HTTPException) as exc_info:
        _verify_operator_key_config("CHANGE_ME_OPERATOR_KEY", {
            "ENVIRONMENT": "production",
            "ML_OPERATOR_KEY": "CHANGE_ME_OPERATOR_KEY",
        })

    assert exc_info.value.status_code == 500
    assert "Insecure placeholder" in exc_info.value.detail


def test_operator_auth_rejects_short_production_key_at_request_time():
    with pytest.raises(HTTPException) as exc_info:
        _verify_operator_key_config("short-secret", {
            "ENVIRONMENT": "production",
            "ML_OPERATOR_KEY": "short-secret",
        })

    assert exc_info.value.status_code == 500
    assert "too short" in exc_info.value.detail


def test_operator_auth_rejects_trivially_repetitive_production_key_at_request_time():
    with pytest.raises(HTTPException) as exc_info:
        _verify_operator_key_config("a" * 32, {
            "ENVIRONMENT": "production",
            "ML_OPERATOR_KEY": "a" * 32,
        })

    assert exc_info.value.status_code == 500
    assert "trivially repetitive" in exc_info.value.detail


@pytest.mark.parametrize("environment", [None, "", "staging-typo"])
def test_service_auth_rejects_missing_blank_and_unknown_environment(environment):
    env = {"ML_SERVICE_API_KEY": "secure_production_secret_key_2026"}
    if environment is not None:
        env["ENVIRONMENT"] = environment

    with pytest.raises(HTTPException) as exc_info:
        _verify_api_key_config("secure_production_secret_key_2026", env)

    assert exc_info.value.status_code == 500
    assert "ENVIRONMENT is missing or unsupported" in exc_info.value.detail


@pytest.mark.parametrize("environment", [None, "", "staging-typo"])
def test_operator_auth_rejects_missing_blank_and_unknown_environment(environment):
    env = {"ML_OPERATOR_KEY": "secure_operator_secret_key_9999"}
    if environment is not None:
        env["ENVIRONMENT"] = environment

    with pytest.raises(HTTPException) as exc_info:
        _verify_operator_key_config("secure_operator_secret_key_9999", env)

    assert exc_info.value.status_code == 500
    assert "ENVIRONMENT is missing or unsupported" in exc_info.value.detail


def test_operator_configuration_rejects_missing_environment_even_with_a_key():
    with pytest.raises(RuntimeError, match="ENVIRONMENT must be explicitly set"):
        validate_ml_operator_config({"ML_OPERATOR_KEY": "secure_operator_secret_key_9999"})


@pytest.mark.parametrize("environment", [None, "", "staging-typo"])
def test_mock_provider_is_disabled_without_an_explicit_local_environment(environment):
    env = {} if environment is None else {"ENVIRONMENT": environment}
    assert local_mode_explicitly_enabled(env) is False


def test_mock_provider_requires_explicit_ml_service_local_mode():
    assert local_mode_explicitly_enabled({"ENVIRONMENT": "test"}) is True
