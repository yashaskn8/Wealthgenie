"""Stable domain errors raised by RAG document lifecycle operations."""


class DocumentOwnershipError(PermissionError):
    """Raised when a verified caller does not own a document mutation target."""
