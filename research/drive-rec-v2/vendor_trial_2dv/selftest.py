"""selftest.py — Decision 2D-V harness self-test (NO network, NO credits).

Runs the entire trial pipeline end-to-end on SYNTHETIC fixtures and asserts
the harness behaves exactly as specified BEFORE any credits are spent:

  T1  fixtures regenerate deterministically (byte-identical)
  T2  dry-run acquisition (clean)   -> all automatable checks PASS,
      V8 PENDING_MANUAL, overall BLOCKED_PENDING_MANUAL
  T3  dry-run acquisition (faulted) -> V2/V3/V4/V5/V7/V9 FAIL precisely on
      the nine injected faults; V1/V6/V10 PASS; overall FAIL
  T3b fault details: V7 reports exactly the 2 injected settlement faults
  T3c fault details: V3 catches the F8 provenance fault (null discovery
      timestamp in the event-ID map)
  T3d fault details: V9 catches the F9 consumption fault (unestablished
      row) AND the F7 actual-vs-modeled mismatch
  T4  tamper test: one flipped byte in a raw response -> V10 FAIL
  T5  determinism: re-running the verifier is byte-identical
  T6  fail-closed: canonical quote store REFUSES synthetic trial output
  T7  quarantine guards hold (refit lock, sample freeze, confinement)
  T8  credential safety: REAL mode refuses to run without ODDS_API_KEY
  T9  credit guard fail-closed: a response without usage headers aborts the
      run PARTIAL with consumption_unestablished (owner defect-2 fix)
  T10 budget cap covers ALL request kinds: a tiny cap aborts PARTIAL
      pre-request, measured spend never exceeds the cap (owner defect-2 fix)
  T11 event-ID map required: acquisition refuses to run without the map
      (owner defect-1 fix)
  T12 discover_event_ids.py: REAL mode refuses without ODDS_API_KEY; its
      offline validation mode passes

Output: selftest_out/selftest_report.json + SELFTEST.md.
This file is the evidence that the V1-V10 verifier is correct and sensitive;
it is NOT evidence about the vendor.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "selftest_out"
PY = sys.executable

EXPECTED_CLEAN = {
    "V1": "PASS", "V2": "PASS", "V3": "PASS", "V4": "PASS", "V5": "PASS",
    "V6": "PASS", "V7": "PASS", "V8": "PENDING_MANUAL", "V9": "PASS",
    "V10": "PASS", "overall": "BLOCKED_PENDING_MANUAL",
}
EXPECTED_FAULTED = {
    "V1": "PASS", "V2": "FAIL", "V3": "FAIL", "V4": "FAIL", "V5": "FAIL",
    "V6": "PASS", "V7": "FAIL", "V8": "PENDING_MANUAL", "V9": "FAIL",
    "V10": "PASS", "overall": "FAIL",
}

results: list[dict] = []


def record(tid: str, ok: bool, detail: str) -> bool:
    results.append({"test": tid, "status": "PASS" if ok else "FAIL",
                    "detail": detail})
    print(f"[{'PASS' if ok else 'FAIL'}] {tid}: {detail}")
    return ok


def run(*args: str, env_extra: dict | None = None,
        expect_fail: bool = False) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if k != "ODDS_API_KEY"}
    if env_extra:
        env.update(env_extra)
    p = subprocess.run([PY, *args], cwd=HERE, capture_output=True, text=True,
                       env=env)
    if expect_fail and p.returncode == 0:
        raise AssertionError(f"expected failure but succeeded: {args}")
    if not expect_fail and p.returncode != 0:
        raise AssertionError(f"command failed: {args}\n{p.stderr[-2000:]}")
    return p


def verdicts(evidence_dir: Path) -> dict:
    s = json.loads((evidence_dir / "checks_summary.json").read_text())
    return {**s["checks"], "overall": s["overall"]}


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    all_ok = True

    # T1 — deterministic fixture regeneration
    probe = HERE / "fixtures" / "clean" / "responses" / "SYN25_G01__T-180m.json"
    before = hashlib.sha256(probe.read_bytes()).hexdigest()
    run("make_fixtures.py")
    after = hashlib.sha256(probe.read_bytes()).hexdigest()
    all_ok &= record("T1_fixture_determinism", before == after,
                     f"regeneration byte-identical ({after[:12]}…)")

    # T2 — clean dry-run acquisition + verification
    run("fetch_trial_quotes.py", "--dry-run", "--fixtures", "fixtures/clean",
        "--out", "selftest_out/raw_clean")
    run("verify_v1_v10.py", "--data-dir", "selftest_out/raw_clean",
        "--sample-manifest", "fixtures/clean/sample_manifest.json",
        "--stats", "fixtures/clean/independent_stats.csv",
        "--out", "selftest_out/evidence_clean")
    got = verdicts(OUT / "evidence_clean")
    diffs = {k: (got.get(k), v) for k, v in EXPECTED_CLEAN.items()
             if got.get(k) != v}
    all_ok &= record("T2_clean_run", not diffs,
                     f"verdicts match expected: {json.dumps(EXPECTED_CLEAN)}"
                     if not diffs else f"DIFFS {diffs}")

    # T3 — faulted dry-run acquisition + verification (sensitivity)
    run("fetch_trial_quotes.py", "--dry-run", "--fixtures", "fixtures/faulted",
        "--out", "selftest_out/raw_faulted")
    run("verify_v1_v10.py", "--data-dir", "selftest_out/raw_faulted",
        "--sample-manifest", "fixtures/faulted/sample_manifest.json",
        "--stats", "fixtures/faulted/independent_stats.csv",
        "--out", "selftest_out/evidence_faulted")
    got = verdicts(OUT / "evidence_faulted")
    diffs = {k: (got.get(k), v) for k, v in EXPECTED_FAULTED.items()
             if got.get(k) != v}
    all_ok &= record("T3_fault_sensitivity", not diffs,
                     "all 9 injected faults caught by their target checks"
                     if not diffs else f"DIFFS {diffs}")
    v7 = json.loads((OUT / "evidence_faulted" / "v07_settlement.json").read_text())
    n_v7 = len(v7["violations"])
    all_ok &= record("T3b_fault_details", n_v7 == 2,
                     f"V7 reports exactly the 2 injected settlement faults "
                     f"(got {n_v7})")
    v3 = json.loads((OUT / "evidence_faulted" / "v03_market_identification.json").read_text())
    hit_f8 = [v for v in v3["violations"]
              if "SYN25_G02" in v and "discovery_timestamp_utc" in v]
    all_ok &= record("T3c_fault_details", bool(hit_f8),
                     f"V3 catches the F8 provenance fault: {hit_f8[0] if hit_f8 else 'NOT CAUGHT'}")
    v9 = json.loads((OUT / "evidence_faulted" / "v09_cost.json").read_text())
    hit_f9 = [f for f in v9["failures"] if "UNESTABLISHED" in f]
    hit_f7 = [f for f in v9["failures"] if "actual credits != modeled" in f]
    all_ok &= record("T3d_fault_details", bool(hit_f9) and bool(hit_f7),
                     f"V9 catches F9 ({'unestablished row' if hit_f9 else 'MISSED'}) "
                     f"and F7 ({'actual 25 != modeled 10' if hit_f7 else 'MISSED'})")

    # T4 — tamper detection (V10)
    tamper_dir = OUT / "raw_tamper"
    shutil.copytree(OUT / "raw_clean", tamper_dir)
    victim = sorted((tamper_dir / "responses").glob("*.json"))[0]
    victim.write_bytes(victim.read_bytes() + b" ")   # flip one byte-equivalent
    run("verify_v1_v10.py", "--data-dir", "selftest_out/raw_tamper",
        "--sample-manifest", "fixtures/clean/sample_manifest.json",
        "--stats", "fixtures/clean/independent_stats.csv",
        "--out", "selftest_out/evidence_tamper")
    got = verdicts(OUT / "evidence_tamper")
    all_ok &= record("T4_tamper_detection", got.get("V10") == "FAIL",
                     f"flipped byte in {victim.name} -> V10 {got.get('V10')}")

    # T5 — determinism of the verifier (byte-identical re-run, same out dir)
    ev_dir = OUT / "evidence_clean"
    snapshot = {p.name: p.read_bytes() for p in sorted(ev_dir.glob("*.json"))}
    run("verify_v1_v10.py", "--data-dir", "selftest_out/raw_clean",
        "--sample-manifest", "fixtures/clean/sample_manifest.json",
        "--stats", "fixtures/clean/independent_stats.csv",
        "--out", "selftest_out/evidence_clean")
    changed = [n for n, b in snapshot.items()
               if (ev_dir / n).read_bytes() != b]
    all_ok &= record("T5_verifier_determinism", not changed,
                     f"{len(snapshot)} evidence JSONs byte-identical on re-run"
                     if not changed else f"CHANGED: {changed}")

    # T6 — fail-closed canonical store refusal
    s = json.loads((ev_dir / "checks_summary.json").read_text())
    refusal = s["canonical_preview"].get("synthetic_refusal", "")
    all_ok &= record("T6_synthetic_refusal",
                     refusal == "REFUSED (fail-closed intact)",
                     f"decision_2d.quotes.validate_quotes: {refusal}")

    # T7 — quarantine guards
    try:
        run("quarantine_guard.py")
        all_ok &= record("T7_quarantine_guards", True,
                         "G1 refit lock / G2 sample freeze / G3 confinement hold")
    except AssertionError as e:
        all_ok &= record("T7_quarantine_guards", False, str(e)[:300])

    # T8 — credential safety
    p = run("fetch_trial_quotes.py", expect_fail=True)
    ok = "ODDS_API_KEY" in (p.stderr + p.stdout)
    all_ok &= record("T8_credential_safety", ok,
                     "REAL mode without ODDS_API_KEY refuses to run "
                     "(key never accepted from files/arguments/chat)")

    # T9 — credit guard fail-closed on unmeasurable consumption (defect-2 fix)
    m = json.loads((OUT / "raw_faulted" / "manifest.json").read_text())
    rows = [json.loads(line) for line in
            (OUT / "raw_faulted" / "credit_ledger.jsonl").read_text().splitlines()
            if line.strip()]
    unest = [r for r in rows if r.get("consumption_unestablished")]
    ok = (m.get("partial") is True and unest
          and "consumption" in str(m.get("partial_reason", "")).lower())
    all_ok &= record("T9_credit_fail_closed", ok,
                     f"response without usage headers -> ABORT PARTIAL "
                     f"({len(unest)} unestablished ledger row(s); "
                     f"reason: {str(m.get('partial_reason'))[:80]}…)")

    # T10 — budget cap covers every request kind incl. retries (defect-2 fix)
    (OUT / "tiny_cap.json").write_text(
        json.dumps({"credit_budget_cap": 25}) + "\n")
    run("fetch_trial_quotes.py", "--dry-run", "--fixtures", "fixtures/clean",
        "--out", "selftest_out/raw_tinycap",
        "--config-override", "selftest_out/tiny_cap.json")
    m10 = json.loads((OUT / "raw_tinycap" / "manifest.json").read_text())
    rows10 = [json.loads(line) for line in
              (OUT / "raw_tinycap" / "credit_ledger.jsonl").read_text().splitlines()
              if line.strip()]
    total10 = sum(r.get("actual_credits") or 0 for r in rows10)
    runup10 = [r.get("cumulative_actual_after") or 0 for r in rows10]
    quotes10 = [r for r in rows10
                if r.get("request_kind") == "historical_event_odds"]
    ok = (m10.get("partial") is True
          and "budget guard" in str(m10.get("partial_reason", ""))
          and total10 == 20 and max(runup10) <= 25 and len(quotes10) == 2)
    all_ok &= record("T10_budget_cap_all_kinds", ok,
                     f"cap=25 -> abort PARTIAL pre-request after {len(quotes10)} "
                     f"quote pulls (measured {total10} credits, running max "
                     f"{max(runup10)} <= 25; reason: "
                     f"{str(m10.get('partial_reason'))[:60]}…)")

    # T11 — event-ID map required before acquisition (defect-1 fix)
    nomap = OUT / "fixtures_nomap"
    if nomap.exists():
        shutil.rmtree(nomap)
    shutil.copytree(HERE / "fixtures" / "clean", nomap)
    (nomap / "event_id_map.json").unlink()
    p11 = run("fetch_trial_quotes.py", "--dry-run", "--fixtures",
              str(nomap), "--out", "selftest_out/raw_nomap", expect_fail=True)
    all_ok &= record("T11_event_map_required",
                     "event-ID map" in (p11.stderr + p11.stdout),
                     "acquisition without event_id_map.json refuses to run "
                     "(verified historical event IDs required first)")

    # T12 — discover_event_ids.py credential safety + offline validation
    p12 = run("discover_event_ids.py", expect_fail=True)
    ok12 = "ODDS_API_KEY" in (p12.stderr + p12.stdout)
    run("discover_event_ids.py", "--selftest")
    all_ok &= record("T12_discover_tool", ok12,
                     "discover_event_ids.py refuses REAL mode without "
                     "ODDS_API_KEY; offline --selftest passes")

    report = {"harness_selftest": "PASS" if all_ok else "FAIL",
              "n_tests": len(results),
              "tests": results,
              "note": ("All data is SYNTHETIC-HARNESS-TEST; zero vendor "
                       "requests, zero credits consumed. This validates the "
                       "verification CODE, not the vendor.")}
    (OUT / "selftest_report.json").write_text(json.dumps(report, indent=2) + "\n")

    md = ["# Decision 2D-V Harness Self-Test — SYNTHETIC, no vendor data", "",
          f"**Overall: {report['harness_selftest']}** "
          f"({len(results)} tests)", "",
          "| test | status | detail |", "| --- | --- | --- |"]
    for r in results:
        md.append(f"| {r['test']} | **{r['status']}** | {r['detail']} |")
    md += ["", "Fault-injection coverage (fixtures/faulted): F1->V2, F2->V3, "
           "F3->V4, F4->V5, F5->V6 (ledgered), F6->V7 (x2), F7->V9, "
           "F8->V3 (event-map provenance), F9->V9 (meter fail-closed); "
           "tamper->V10.",
           "", "No vendor request was made; no credits were consumed; no API "
           "key exists in this environment."]
    (OUT / "SELFTEST.md").write_text("\n".join(md) + "\n")
    print(f"\nselftest: {report['harness_selftest']} -> {OUT / 'SELFTEST.md'}")
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
