"""Canonical Mongo database selection shared by ML migrations and stores."""

from __future__ import annotations

import os
from urllib.parse import unquote, urlsplit


class MongoDatabaseConfigurationError(ValueError):
    """The configured Mongo URI and optional database override disagree."""


def resolve_mongo_database_name(mongo_uri: str | None = None) -> str:
    uri = (mongo_uri if mongo_uri is not None else os.environ.get("MONGODB_URI", "")).strip()
    if not uri:
        raise MongoDatabaseConfigurationError("MONGODB_URI is required to resolve the shared database")
    parsed = urlsplit(uri)
    uri_database = unquote(parsed.path.lstrip("/").split("/", 1)[0]).strip()
    configured_database = os.environ.get("MONGODB_DATABASE", "").strip()
    expected_database = os.environ.get("MONGODB_EXPECTED_DATABASE", "").strip()
    if uri_database and configured_database and uri_database != configured_database:
        raise MongoDatabaseConfigurationError(
            "MONGODB_DATABASE must match the database encoded in MONGODB_URI"
        )
    database = configured_database or uri_database or "wealthgenie"
    if not database or "/" in database or "\\" in database or "\x00" in database:
        raise MongoDatabaseConfigurationError("Mongo database name is invalid")
    if expected_database and database != expected_database:
        raise MongoDatabaseConfigurationError(
            "Mongo database does not match MONGODB_EXPECTED_DATABASE"
        )
    return database
