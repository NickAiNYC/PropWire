"""contract.py — load the frozen Decision 2D contract and enforce the refit lock.

The contract (artifacts/decision_2d_contract.json) was frozen BEFORE any quote
acquisition. Evaluation code MUST call `verify_contract()` first; it recomputes
the SHA-256 of every frozen artifact and aborts on any mismatch. This is the
mechanical enforcement of "prohibit model refitting during the pilot".
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

DRIVE = Path(__file__).resolve().parents[1]
ARTIFACTS = DRIVE / "artifacts"

REQUIRED_KEYS = (
    "contract_id", "version", "status", "frozen_at_utc",
    "models", "gates", "alert_thresholds", "settlement", "metrics",
)


class ContractViolation(RuntimeError):
    """Raised when the frozen contract is missing, altered, or incomplete."""


def contract_path() -> Path:
    return ARTIFACTS / "decision_2d_contract.json"


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_contract() -> dict:
    p = contract_path()
    if not p.exists():
        raise ContractViolation(
            f"frozen contract not found at {p}; run 11_freeze_decision_2d_contract.py "
            "BEFORE quote acquisition (precommitment ordering)")
    contract = json.loads(p.read_text())
    missing = [k for k in REQUIRED_KEYS if k not in contract]
    if missing:
        raise ContractViolation(f"contract missing keys: {missing}")
    if contract["status"] != "PRECOMMITTED_BEFORE_QUOTE_ACQUISITION":
        raise ContractViolation(
            f"unexpected contract status: {contract['status']!r}")
    return contract


def verify_contract(contract: dict | None = None) -> dict:
    """Recompute frozen-artifact hashes; abort on mismatch (refit lock)."""
    contract = contract or load_contract()
    frozen = contract["models"]["frozen_artifacts_sha256"]
    if not frozen:
        raise ContractViolation("contract lists no frozen artifacts")
    mismatches = []
    for name, expected in frozen.items():
        path = ARTIFACTS / name
        if not path.exists():
            mismatches.append(f"{name}: MISSING")
            continue
        actual = sha256_file(path)
        if actual != expected:
            mismatches.append(f"{name}: expected {expected[:16]}.. got {actual[:16]}..")
    if mismatches:
        raise ContractViolation(
            "REFIT LOCK ENGAGED — frozen artifacts altered since contract freeze: "
            + "; ".join(mismatches)
            + ". Evaluation is blocked; the pilot protocol forbids refitting.")
    return contract


def gate(contract: dict, name: str) -> str:
    """Fetch a precommitted gate rule (fails loudly on unknown gates)."""
    if name not in contract["gates"]:
        raise ContractViolation(f"unknown gate {name!r}; gates are precommitted")
    return contract["gates"][name]
