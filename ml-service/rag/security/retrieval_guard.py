"""Deterministic defense-in-depth for untrusted RAG excerpts.

Source provenance checks remain mandatory. This guard is deliberately narrow:
content inspection is not a replacement for authorization or corpus integrity.
"""

from __future__ import annotations

import base64
import re
import unicodedata

_ROLE_MARKER = re.compile(
    r"(?im)^\s*(?:#{1,6}\s*)?(?:system|developer|assistant)\s*:"
    r"|^\s*(?:\[(?:system|developer|assistant)(?:\s+instruction)?\]"
    r"|<\s*(?:system|developer|assistant)\s*>"
    r"|===\s*(?:system|developer|assistant)\b"
    r"|\[im_start\]\s*(?:system|developer))",
)
_INSTRUCTION_PATTERNS = (
    re.compile(
        r"\b(?:ignore|disregard|override|forget)\s+(?:all\s+|any\s+)?"
        r"(?:previous|prior|above|system|developer)\s+"
        r"(?:instructions?|prompts?|rules?|directions?)\b", re.I
    ),
    re.compile(
        r"\b(?:you\s+are\s+now|act\s+as)\s+(?:an?\s+)?"
        r"(?:unrestricted|jailbroken|system|developer)\b", re.I
    ),
    re.compile(
        r"\b(?:reveal|dump|print|expose|disclose)\s+(?:the\s+|your\s+)?"
        r"(?:hidden\s+)?(?:system\s+prompt|developer\s+prompt|"
        r"api\s+keys?|secret\s+keys?|credentials?)\b", re.I
    ),
)
_BASE64_CANDIDATE = re.compile(r"(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{20,}={0,2}(?![A-Za-z0-9+/])")
_ZERO_WIDTH = re.compile("[\u200b-\u200f\u2060\ufeff]")


def _contains_directive(text: str) -> bool:
    return bool(_ROLE_MARKER.search(text) or any(pattern.search(text) for pattern in _INSTRUCTION_PATTERNS))


def contains_retrieval_instruction_attack(content: str) -> bool:
    """Detect obvious direct and encoded instructions in a bounded excerpt.

    Returns True on non-text or suspicious text. A negative result is not a
    guarantee of safety; the authenticated, manifest-pinned trust gate is still
    the primary control.
    """
    if not isinstance(content, str):
        return True
    normalized = _ZERO_WIDTH.sub("", unicodedata.normalize("NFKC", content))
    if _contains_directive(normalized):
        return True
    # This catches common indirect-injection encoding without requiring an
    # embedding provider or logging private source content. Bound decoding work.
    for match in list(_BASE64_CANDIDATE.finditer(normalized[:4_096]))[:8]:
        token = match.group()
        if len(token) > 4_096:
            continue
        try:
            padded = token + "=" * ((-len(token)) % 4)
            decoded = base64.b64decode(padded, validate=True).decode("utf-8", errors="ignore")
        except (ValueError, UnicodeError):
            continue
        if _contains_directive(_ZERO_WIDTH.sub("", unicodedata.normalize("NFKC", decoded))):
            return True
    return False
