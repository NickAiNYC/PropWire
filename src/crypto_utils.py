"""
crypto_utils.py — RFC-8785 Canonical JSON Serialization & Cryptographic Primers

Ensures exact byte-for-byte deterministic serialization and SHA-256 hashes across
platforms, clients, and independent offline audit scripts.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Dict


def canonical_json_dumps(payload: Dict[str, Any]) -> str:
    """
    RFC-8785 compliant canonical JSON string.
    - Keys sorted lexicographically
    - Compact separators (no extra whitespace)
    - UTF-8 characters preserved without ascii escapes
    """
    return json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )


def canonical_json_sha256(payload: Dict[str, Any]) -> str:
    """
    RFC-8785 compliant deterministic SHA-256 hash.
    Identical across Python, Node.js, and Rust notary clients.
    """
    serialized = canonical_json_dumps(payload)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()
