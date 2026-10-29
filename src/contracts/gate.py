"""
PropStein Ingestion Gate — Atomic Fail-Closed Contract Publishing & Provenance Manifests
"""

from __future__ import annotations
import hashlib
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Type, Union

from pydantic import BaseModel, ValidationError


def compute_sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def compute_sha256_str(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def validate_and_publish(
    schema_cls: Type[BaseModel],
    raw_data: Union[List[Dict[str, Any]], Dict[str, Any]],
    target_path: Union[str, Path],
    source_feed: str = "upstream",
    config_hash: Optional[str] = None,
    allow_partial: bool = False,
    min_rows: int = 1,
) -> Tuple[bool, Dict[str, Any]]:
    """
    Validate raw payload against Pydantic contract before touching production files.
    - If valid: writes atomically (.tmp -> os.replace) and emits a provenance .manifest.json.
    - If invalid: leaves production artifact completely untouched, writes structured failure
      to data/quarantine/{stem}_invalid_{ts}.json, and returns (False, error_manifest).
    """
    target_path = Path(target_path).resolve()
    base_dir = target_path.parent
    base_dir.mkdir(parents=True, exist_ok=True)

    quarantine_dir = base_dir.parent / "data" / "quarantine"
    quarantine_dir.mkdir(parents=True, exist_ok=True)

    run_id = f"run_{uuid.uuid4().hex[:12]}"
    now_utc = datetime.now(timezone.utc).isoformat()
    ts_compact = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")

    # Determine rows seen
    if isinstance(raw_data, list):
        rows_seen = len(raw_data)
    elif isinstance(raw_data, dict):
        if "quotes" in raw_data and isinstance(raw_data["quotes"], list):
            rows_seen = len(raw_data["quotes"])
        elif "rows" in raw_data and isinstance(raw_data["rows"], list):
            rows_seen = len(raw_data["rows"])
        elif "injuries" in raw_data and isinstance(raw_data["injuries"], list):
            rows_seen = len(raw_data["injuries"])
        else:
            rows_seen = 1
    else:
        rows_seen = 0

    if rows_seen < min_rows:
        error_msg = f"Zero or insufficient rows in payload (seen {rows_seen}, min required {min_rows})"
        return _fail_closed(
            target_path=target_path,
            quarantine_dir=quarantine_dir,
            run_id=run_id,
            now_utc=now_utc,
            ts_compact=ts_compact,
            source_feed=source_feed,
            config_hash=config_hash,
            rows_seen=rows_seen,
            raw_data=raw_data,
            error_details={"type": "SanityFloorError", "message": error_msg},
        )

    # Validate
    try:
        # Pydantic validation
        if isinstance(raw_data, list) and not issubclass(schema_cls, list):
            # If schema expects a container or we're validating list of items
            validated_obj = [schema_cls.model_validate(item) for item in raw_data]
            serialized_json = json.dumps([item.model_dump(mode="json", by_alias=True) for item in validated_obj], indent=2, ensure_ascii=False)
            rows_valid = len(validated_obj)
        else:
            validated_obj = schema_cls.model_validate(raw_data)
            serialized_json = validated_obj.model_dump_json(indent=2, by_alias=True)
            rows_valid = rows_seen

        rows_rejected = 0

    except (ValidationError, Exception) as val_err:
        errors = val_err.errors() if isinstance(val_err, ValidationError) else [{"msg": str(val_err)}]
        return _fail_closed(
            target_path=target_path,
            quarantine_dir=quarantine_dir,
            run_id=run_id,
            now_utc=now_utc,
            ts_compact=ts_compact,
            source_feed=source_feed,
            config_hash=config_hash,
            rows_seen=rows_seen,
            raw_data=raw_data,
            error_details={"type": type(val_err).__name__, "errors": errors},
        )

    # ATOMIC WRITE: Write to .tmp and rename
    content_bytes = serialized_json.encode("utf-8")
    content_sha256 = compute_sha256_bytes(content_bytes)
    temp_file = target_path.with_suffix(f".tmp_{run_id}")

    with open(temp_file, "wb") as f:
        f.write(content_bytes)

    os.replace(temp_file, target_path)

    # PROVENANCE MANIFEST
    manifest = {
        "run_id": run_id,
        "schema_version": "propstein_contract_v1",
        "schema_class": schema_cls.__name__,
        "source_feed": source_feed,
        "timestamp": now_utc,
        "status": "PASS_ATOMIC_PUBLISHED",
        "target_file": str(target_path.relative_to(base_dir.parent) if base_dir.parent in target_path.parents else target_path.name),
        "rows_seen": rows_seen,
        "rows_valid": rows_valid,
        "rows_rejected": rows_rejected,
        "quarantine_path": None,
        "config_hash": config_hash or compute_sha256_str("default_config"),
        "sha256": content_sha256,
    }

    manifest_file = target_path.with_name(f"{target_path.stem}.manifest.json")
    with open(manifest_file, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    print(f"✅ [DataContract PASS] Published {target_path.name} ({rows_valid} valid rows) · Run {run_id}")
    return True, manifest


def _fail_closed(
    target_path: Path,
    quarantine_dir: Path,
    run_id: str,
    now_utc: str,
    ts_compact: str,
    source_feed: str,
    config_hash: Optional[str],
    rows_seen: int,
    raw_data: Any,
    error_details: Dict[str, Any],
) -> Tuple[bool, Dict[str, Any]]:
    """Record quarantine log and fail closed without touching target production file."""
    quarantine_file = quarantine_dir / f"{target_path.stem}_invalid_{ts_compact}_{run_id}.json"

    # Preview up to 5000 chars of raw payload
    raw_str = json.dumps(raw_data) if isinstance(raw_data, (dict, list)) else str(raw_data)
    preview = raw_str[:5000]

    failure_manifest = {
        "run_id": run_id,
        "schema_version": "propstein_contract_v1",
        "source_feed": source_feed,
        "timestamp": now_utc,
        "status": "FAIL_CLOSED_QUARANTINED",
        "target_file": str(target_path.name),
        "rows_seen": rows_seen,
        "rows_valid": 0,
        "rows_rejected": rows_seen,
        "quarantine_path": str(quarantine_file),
        "config_hash": config_hash,
        "error": error_details,
        "payload_preview": preview,
    }

    with open(quarantine_file, "w", encoding="utf-8") as f:
        json.dump(failure_manifest, f, indent=2)

    print(
        f"🚨 [DataContract FAIL-CLOSED] Blocked invalid payload for {target_path.name}! "
        f"Quarantined to: {quarantine_file.name}",
        file=sys.stderr,
    )
    return False, failure_manifest
