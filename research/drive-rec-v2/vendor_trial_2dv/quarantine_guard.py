"""quarantine_guard.py — enforce the Decision 2D-V experimental safeguards.

The Decision 2D review (2026-10-30) ordered: trial observations must NOT be
used to revise the frozen model or select a more favorable EV threshold; the
trial is for validating data quality and infrastructure. This guard verifies
mechanically:

  G1  REFIT LOCK: every frozen artifact listed in
      artifacts/decision_2d_contract.json still matches its frozen SHA-256
      (reuses decision_2d.contract.verify_contract — the same lock the pilot
      harness enforces).
  G2  SAMPLE FREEZE: artifacts/sample_manifest.json is byte-identical to the
      hash recorded in PRECOMMITMENT.md at precommitment time.
  G3  QUARANTINE: raw acquisition output (manifest.json + credit_ledger.jsonl
      directories) exists ONLY inside vendor_trial_2dv/ — trial observations
      cannot leak into model/calibration/criteria paths elsewhere in the
      research drive.
  G4  CODE BASELINE: every governing code file (decision_2d/*.py, the trial
      scripts, trial_config.json, PRECOMMITMENT.md) matches the committed
      hash baseline code_baseline.json — post-hoc edits to the verification
      code itself are detectable.

Exit code 0 = guards hold; 1 = violation (treat as a protocol breach).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DRIVE = HERE.parent
sys.path.insert(0, str(DRIVE / "decision_2d"))


def sha256_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def g1_refit_lock(report: list) -> bool:
    try:
        from contract import verify_contract
        verify_contract()
        report.append({"guard": "G1_refit_lock", "status": "PASS",
                       "detail": "all frozen artifact hashes match "
                                 "decision_2d_contract.json"})
        return True
    except Exception as e:
        report.append({"guard": "G1_refit_lock", "status": "FAIL",
                       "detail": str(e)[:300]})
        return False


def g2_sample_freeze(report: list) -> bool:
    pre = HERE / "PRECOMMITMENT.md"
    manifest = HERE / "artifacts" / "sample_manifest.json"
    if not pre.exists() or not manifest.exists():
        report.append({"guard": "G2_sample_freeze", "status": "FAIL",
                       "detail": "PRECOMMITMENT.md or sample manifest missing"})
        return False
    text = pre.read_text()
    m = re.search(r"sample_manifest\.json[\s\S]{0,200}?`([0-9a-f]{64})`", text)
    if not m:
        report.append({"guard": "G2_sample_freeze", "status": "FAIL",
                       "detail": "PRECOMMITMENT.md records no manifest hash"})
        return False
    actual = sha256_file(manifest)
    ok = actual == m.group(1)
    report.append({"guard": "G2_sample_freeze", "status": "PASS" if ok else "FAIL",
                   "detail": (f"recorded {m.group(1)[:16]}… vs actual "
                              f"{actual[:16]}…")})
    return ok


def g3_quarantine(report: list) -> bool:
    """Raw acquisition dirs (manifest.json + credit_ledger.jsonl) must exist
    only under vendor_trial_2dv/."""
    violators = []
    for cand in DRIVE.rglob("credit_ledger.jsonl"):
        rel = cand.relative_to(DRIVE)
        if not rel.parts[0] == HERE.name:
            violators.append(str(rel))
    ok = not violators
    report.append({"guard": "G3_quarantine", "status": "PASS" if ok else "FAIL",
                   "detail": (f"{len(list(HERE.rglob('credit_ledger.jsonl')))} "
                              "ledger(s) inside the trial quarantine"
                              + (f"; OUTSIDE: {violators}" if violators else ""))})
    return ok


def g4_code_baseline(report: list) -> bool:
    """Hash baseline over the governing code: decision_2d/*.py, the trial
    scripts, trial_config.json, and PRECOMMITMENT.md. First run CREATES the
    baseline (committed to git afterwards); later runs verify against it.
    mtime-based detection is deliberately avoided: sandbox restores touch
    every file, so hashes are the only trustworthy signal."""
    baseline_path = HERE / "code_baseline.json"
    targets = sorted((DRIVE / "decision_2d").glob("*.py")) + sorted(
        p for p in HERE.glob("*.py") if p.name != "quarantine_guard.py") + [
        HERE / "trial_config.json", HERE / "PRECOMMITMENT.md"]
    current = {str(p.relative_to(DRIVE)): sha256_file(p) for p in targets
               if p.exists()}
    if not baseline_path.exists():
        baseline_path.write_text(json.dumps(current, indent=2, sort_keys=True)
                                 + "\n")
        report.append({"guard": "G4_code_baseline", "status": "PASS",
                       "detail": f"baseline CREATED with {len(current)} files; "
                                 "commit it to git — subsequent runs verify "
                                 "against it"})
        return True
    baseline = json.loads(baseline_path.read_text())
    changed = [k for k, h in baseline.items()
               if current.get(k) != h]
    added = [k for k in current if k not in baseline]
    removed = [k for k in baseline if k not in current]
    ok = not (changed or added or removed)
    report.append({"guard": "G4_code_baseline", "status": "PASS" if ok else "FAIL",
                   "detail": (f"{len(baseline)} governing files match the committed "
                              "baseline" if ok else
                              f"changed: {changed}; added: {added}; removed: {removed}")})
    return ok


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path,
                    default=HERE / "selftest_out" / "guard_report.json")
    args = ap.parse_args()
    report: list = []
    ok = all([g1_refit_lock(report), g2_sample_freeze(report),
              g3_quarantine(report), g4_code_baseline(report)])
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({"guards_hold": ok, "guards": report},
                                   indent=2) + "\n")
    print(json.dumps({"guards_hold": ok, "guards": report}, indent=2))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
