"""Environment-mode policy shared by ML authentication and synthetic providers."""

from typing import Mapping


LOCAL_ENVIRONMENTS = frozenset({"local", "test", "development"})
SUPPORTED_ENVIRONMENTS = LOCAL_ENVIRONMENTS | {"production", "prod"}


def configured_environment_mode(environ: Mapping[str, str]) -> str:
    """Return the explicit canonical mode; missing and blank remain unavailable."""
    mode = (environ.get("ENVIRONMENT") or "").strip().lower()
    return "production" if mode == "prod" else mode


def local_mode_explicitly_enabled(environ: Mapping[str, str]) -> bool:
    """Return whether synthetic/local-only behavior was explicitly opted into."""
    return configured_environment_mode(environ) in LOCAL_ENVIRONMENTS
