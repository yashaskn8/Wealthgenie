"""
WealthGenie ML Microservice - Security & Authentication Layer
Provides API key extraction, validation, and constant-time authentication dependencies.
"""

import hmac
import logging
import os
from typing import Mapping, Optional
from fastapi import HTTPException, Security, status
from fastapi.security.api_key import APIKeyHeader
from environment_policy import LOCAL_ENVIRONMENTS, SUPPORTED_ENVIRONMENTS, configured_environment_mode

logger = logging.getLogger("wealthgenie.security")

def _environment_mode(environ: Mapping[str, str]) -> str:
    """Return the configured mode without turning missing configuration into local mode."""
    return configured_environment_mode(environ)


def _require_supported_environment(env_mode: str) -> None:
    if env_mode not in SUPPORTED_ENVIRONMENTS:
        allowed = ", ".join(sorted(SUPPORTED_ENVIRONMENTS))
        raise RuntimeError(f"FATAL Startup Misconfiguration: ENVIRONMENT must be explicitly set to one of: {allowed}.")


def _is_insecure_production_key(value: str) -> bool:
    normalized = value.strip().casefold()
    # Length alone accepts obvious values such as 32 repeated characters.
    # This is a cheap rejection of trivially low-diversity keys, not an entropy
    # estimator; production secrets must still be generated randomly.
    return len(normalized) < 32 or len(set(normalized)) < 12 or normalized.startswith("change_me") or normalized in {
        "changeme", "password", "secret", "default", "example",
    }

API_KEY_NAME = "X-API-Key"
api_key_header = APIKeyHeader(name=API_KEY_NAME, auto_error=False)

VERIFIED_USER_HEADER = "X-Verified-User-Id"
verified_user_header = APIKeyHeader(name=VERIFIED_USER_HEADER, auto_error=False)


def validate_ml_service_config(environ: Optional[Mapping[str, str]] = None) -> None:
    """Validate ML service security configuration at startup.

    Raises RuntimeError if required credentials are missing or set to
    insecure placeholder values in non-local environments.
    """
    env_dict = environ if environ is not None else os.environ
    env_mode = _environment_mode(env_dict)
    _require_supported_environment(env_mode)
    api_key = env_dict.get("ML_SERVICE_API_KEY", "").strip()

    if env_mode not in LOCAL_ENVIRONMENTS:
        if not api_key:
            raise RuntimeError(
                "FATAL Startup Misconfiguration: ML_SERVICE_API_KEY is required in production environments. "
                "Set ENVIRONMENT=local to permit dev-mode bypass."
            )
        if _is_insecure_production_key(api_key):
            raise RuntimeError(
                "FATAL Startup Misconfiguration: Insecure placeholder ML_SERVICE_API_KEY, key too short (must be at least 32 characters), or trivially repetitive value in production."
            )


def _verify_api_key_config(api_key: Optional[str], environ: Mapping[str, str]) -> str:
    expected_key = (environ.get("ML_SERVICE_API_KEY") or "").strip()
    env_mode = _environment_mode(environ)
    if env_mode not in SUPPORTED_ENVIRONMENTS:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Server Misconfiguration: ENVIRONMENT is missing or unsupported.",
        )

    if not expected_key:
        if env_mode in LOCAL_ENVIRONMENTS:
            return api_key or "dev-mode"
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Server Misconfiguration: ML_SERVICE_API_KEY is not set. Set ENVIRONMENT=local to permit dev-mode bypass."
        )
    if _is_insecure_production_key(expected_key) and env_mode not in LOCAL_ENVIRONMENTS:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Server Misconfiguration: Insecure placeholder ML_SERVICE_API_KEY, key too short (must be at least 32 characters), or trivially repetitive value in production."
        )
    if not api_key or not hmac.compare_digest(api_key, expected_key):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing API Key"
        )
    return api_key


async def verify_api_key(api_key: str = Security(api_key_header)) -> str:
    """Authenticate requests via constant-time API key comparison."""
    return _verify_api_key_config(api_key, os.environ)


async def verify_verified_user_id(
    user_id: Optional[str] = Security(verified_user_header)
) -> str:
    """Extract and validate the trusted X-Verified-User-Id downstream header.

    Rejects requests missing the header with 401 Unauthorized to ensure
    all user-scoped operations are bound to a verified identity propagated
    by the upstream gateway/Express backend.
    """
    if not user_id or not user_id.strip():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or empty X-Verified-User-Id header"
        )
    return user_id.strip()


def validate_ml_operator_config(environ: Optional[Mapping[str, str]] = None) -> None:
    """Validate ML operator security configuration at startup.

    Raises RuntimeError if ML_OPERATOR_KEY is missing or set to
    insecure placeholder values in non-local environments.
    """
    env_dict = environ if environ is not None else os.environ
    env_mode = _environment_mode(env_dict)
    _require_supported_environment(env_mode)
    operator_key = env_dict.get("ML_OPERATOR_KEY", "").strip()

    if env_mode not in LOCAL_ENVIRONMENTS:
        if not operator_key:
            raise RuntimeError(
                "FATAL Startup Misconfiguration: ML_OPERATOR_KEY is required in production environments. "
                "Set ENVIRONMENT=local to permit dev-mode bypass."
            )
        if _is_insecure_production_key(operator_key):
            raise RuntimeError(
                "FATAL Startup Misconfiguration: Insecure placeholder ML_OPERATOR_KEY, key too short (must be at least 32 characters), or trivially repetitive value in production."
            )


OPERATOR_KEY_NAME = "X-Operator-Key"
operator_key_header = APIKeyHeader(name=OPERATOR_KEY_NAME, auto_error=False)


async def verify_operator_key(operator_key: str = Security(operator_key_header)) -> str:
    """Authenticate operator-only administrative requests via constant-time key comparison.

    Uses hmac.compare_digest for timing-attack-resistant string equality checks
    against the ML_OPERATOR_KEY environment variable.

    OPERATIONAL NOTE:
    ML_OPERATOR_KEY is an out-of-band credential intended exclusively for direct
    operational management (deploy scripts, CI/CD promotion pipelines, infrastructure
    runbooks, or authorized human operators via curl/CLI). It is NOT held, known, or
    forwarded by the Express backend or any customer-facing application services.
    """
    return _verify_operator_key_config(operator_key, os.environ)


def _verify_operator_key_config(operator_key: Optional[str], environ: Mapping[str, str]) -> str:
    expected_key = (environ.get("ML_OPERATOR_KEY") or "").strip()
    env_mode = _environment_mode(environ)
    if env_mode not in SUPPORTED_ENVIRONMENTS:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Server Misconfiguration: ENVIRONMENT is missing or unsupported.",
        )

    if not expected_key:
        if env_mode in LOCAL_ENVIRONMENTS:
            return operator_key or "dev-mode-operator"
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Server Misconfiguration: ML_OPERATOR_KEY is not set. Set ENVIRONMENT=local to permit dev-mode bypass."
        )
    if _is_insecure_production_key(expected_key) and env_mode not in LOCAL_ENVIRONMENTS:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Server Misconfiguration: Insecure placeholder ML_OPERATOR_KEY, key too short (must be at least 32 characters), or trivially repetitive value in production."
        )
    if not operator_key or not hmac.compare_digest(operator_key, expected_key):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing Operator Key"
        )
    return operator_key


VERIFIED_USER_ROLE_HEADER = "X-Verified-User-Role"
verified_user_role_header = APIKeyHeader(name=VERIFIED_USER_ROLE_HEADER, auto_error=False)


async def verify_admin_role(
    user_role: Optional[str] = Security(verified_user_role_header),
) -> str:
    """Verify that the caller possesses the 'admin' role via X-Verified-User-Role.

    Returns 403 Forbidden if the header is missing or contains any value
    other than 'admin'.  This dependency is additive — it does NOT replace
    verify_api_key, which must still gate the router.
    """
    if not user_role or user_role.strip().lower() != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied. Requires admin role.",
        )
    return user_role.strip()
