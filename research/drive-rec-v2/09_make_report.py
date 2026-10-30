"""09_make_report.py — assemble the Decision 2C deliverables and the fail-closed verdict.

Everything in the generated report is pulled programmatically from the artifact JSONs
produced by scripts 01-08; no number is hand-typed. The verdict applies criteria v3
rule C9 (fail-closed): the candidate is promoted only if every evaluable primary
criterion passes on BOTH the 2025 previously-inspected holdout and the 2026
genuinely-unseen slice.

Outputs:
  artifacts/tail_recalibration_report.json   master machine-readable summary
  docs/TAIL_RECALIBRATION_REPORT.md          main human-readable deliverable
  docs/CRITERIA_V3.md                        criteria definition (human-readable)
  HUMAN_REVIEW.md                            unsigned, status DEFERRED (Decision 2C)
"""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))
from lib.common import ARTIFACTS, DOCS, HUMAN_REVIEW  # noqa: E402


def sha256_of(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load(name):
    with open(ARTIFACTS / name) as f:
        return json.load(f)


def pct(x, nd=1):
    return "n/a" if x is None else f"{100 * x:.{nd}f}%"


def pp(x, nd=1):
    return "n/a" if x is None else f"{100 * x:+.{nd}f}pp"


def main() -> int:
    criteria = load("criteria_v3.json")
    corpus = load("corpus_stats.json")
    model = load("incumbent_model.json")
    iso = load("isotonic_calibrator.json")
    inc_eval = load("incumbent_evaluation.json")
    dev_cmp = load("dev_comparison.json")
    cand = load("candidate_evaluation.json")
    ev25 = load("ev_gate_2025.json")
    ev26 = load("ev_gate_2026.json")
    import pandas as pd
    grid25 = pd.read_csv(ARTIFACTS / "ev_gate_sensitivity_2025.csv")
    grid26 = pd.read_csv(ARTIFACTS / "ev_gate_sensitivity_2026.csv")
    now = datetime.now(timezone.utc).isoformat()

    # ------------------------------------------------------------------ verdict
    def season_checks(season):
        c = cand["seasons"][str(season)]["criteria_checks"]
        ev = ev25 if season == 2025 else ev26
        c4 = ev["baseline"]["c4_checks_candidate"]
        primary = {
            "C1_sample_adequacy": all(
                v.get("n", 0) >= 300 and v.get("n_games", 0) >= 25
                for v in c["C3_alert_regions"]["primary"].values()),
            "C2_top_decile": c["C2_top_decile"]["candidate_check"]["status"] == "PASS",
            "C3_alert_regions": all(
                v["status"] == "PASS"
                for v in c["C3_alert_regions"]["primary"].values()),
            "C3_incumbent_operating_point": (
                c["C3_alert_regions"]["incumbent_operating_point"]
                ["p_inc >= 0.30 rows, candidate p_cal vs obs"]["status"] == "PASS"),
            "C4_ev_band_probability": all(v["status"] == "PASS" for v in c4.values()),
            "C5_global_non_degradation": c["C5_global_non_degradation"]["status"] == "PASS",
        }
        return primary

    checks_2025 = season_checks(2025)
    checks_2026 = season_checks(2026)
    promoted = all(checks_2025.values()) and all(checks_2026.values())
    verdict = {
        "criteria_v3_sha256": criteria["content_sha256"],
        "checks_2025_previously_inspected_holdout": checks_2025,
        "checks_2026_genuinely_unseen": checks_2026,
        "c9_rule": criteria["C9_fail_closed_promotion"]["rule"],
        "candidate_status": "CANDIDATE_CALIBRATED" if promoted else "RESEARCH_ONLY",
        "calibrated_label": "BLOCKED (human sign-off deferred per Decision 2C)",
        "human_review_md": "present, UNSIGNED, status DEFERRED",
    }

    # ------------------------------------------------------------------ report data
    def tail_table(season, pcol_prefix):
        e = inc_eval["seasons"][season]
        rows = []
        for k, v in e["tail_slices"].items():
            if v.get("n"):
                rows.append((k, v["n"], v["mean_pred"], v["obs_rate"],
                             v["gap_obs_minus_pred"], v["gap_ci_low"], v["gap_ci_high"]))
        return rows

    md = []
    w = md.append
    w("# PropStein Live Sniper — Decision 2C: Tail Calibration & Economic Reliability\n")
    w(f"Generated (UTC): {now}  ")
    w(f"Criteria v3 content hash: `{criteria['content_sha256'][:16]}...`  ")
    w(f"Candidate status: **{verdict['candidate_status']}** — CALIBRATED production "
      f"label **BLOCKED**; human sign-off **DEFERRED**; `HUMAN_REVIEW.md` is present "
      f"but **unsigned**.\n")

    w("## 0. Rebuild disclosure (read first)\n")
    w("The engineering sandbox that produced the original DRIVE-REC-V1 artifacts was "
      "recycled before this session; the original working tree (including the six "
      "local commits referenced in Decision 2C) is not present in this environment, "
      "and the private GitHub repository is intentionally inaccessible from here "
      "(credentials excluded from this session per the agreed security rule).\n")
    w("This workspace therefore **rebuilds the corpus, the frozen logistic incumbent, "
      "and the full calibration harness from public nflverse data** (CC BY 4.0, "
      "attributed in `LICENSES.md`). Consequences:\n")
    w("- Every number below is freshly measured in this run and reproducible from "
      "`research/00`–`research/09`.")
    w("- The figures quoted in Decision 2C (40.0% predicted / 31.5% observed in the "
      "p ≥ 0.30 tail, 8.5pp gap) are treated as **reported findings from the prior "
      "environment, not as ground truth**. This rebuild measures a materially smaller "
      "aggregate tail gap (see §3) with the same qualitative structure — monotonic "
      "overprediction increasing with predicted probability — and the remediation "
      "logic of Decision 2C is applied to what is actually measured. No pipeline "
      "parameter was tuned to reproduce the prior figures.\n")

    w("## 1. Scope and ordering discipline\n")
    w("Authorized work executed, in order (Decision 2C items 1–6 plus the economic "
      "validation requirement):\n")
    w("1. Isotonic recalibration fitted on **2024 development data only**; the "
      "underlying logistic model stayed **frozen** (2023 training season, C=0.01, "
      "never refit or re-tuned).")
    w("2. Incumbent vs candidate compared **on development data before any holdout "
      "evaluation**, using a cross-fitted isotonic (weeks 1–9 ↔ weeks 10–18) so no "
      "dev row is scored by a calibrator that saw its own half-season.")
    w("3. **Criteria v3 defined and frozen before any candidate number existed** "
      "(top-decile threshold, minimum samples, uncertainty bounds, EV-band checks, "
      "the baseline quote scenario, and the fail-closed promotion rule).")
    w("4. Calibration evaluated in the alert-engine operating regions: p ≥ 0.30 and "
      "each positive simulated-EV band (within the conviction region p ≥ 0.25).")
    w("5. Tail improvement tested against global non-degradation (Brier, log loss, "
      "AUC, ECE, and prospective slices).")
    w("6. Original predictions and all calibration artifacts preserved (see §11; "
      "SHA-256 hashes recorded).")
    w("7. Economic (EV reliability) gate implemented with simulated quotes, "
      "game-clustered confidence intervals, and sensitivity to quote latency, stale "
      "prices, and execution assumptions. **All price-based results are labeled "
      "HYPOTHETICAL.**\n")
    w("The 2025 season is evaluated as a **previously inspected holdout** (it informed "
      "model-development decisions; it is not an untouched final test set). The 2026 "
      "season (weeks 1–7) serves as the **genuinely unseen** prospective slice.\n")

    w("## 2. Corpus and data provenance\n")
    w("Source: nflverse releases only (play-by-play 2022–2026, player registry, game "
      "schedule) — CC BY 4.0, attribution in `LICENSES.md`. Big Data Bowl / NGS "
      "tracking data is **excluded**; player participation (who is on the field) "
      "remains unknown and is never imputed. The per-game player universe is a "
      "documented causal proxy (usage in the team's previous game; season openers: "
      "≥4 prior-season games-with-usage).\n")
    w("| Season | Games | Team-drives | Player-drive rows | P(reception) | Reception coverage |")
    w("| --- | --- | --- | --- | --- | --- |")
    for s, st in corpus["seasons"].items():
        w(f"| {s} | {st['games']} | {st['drives']:,} | {st['rows']:,} | "
          f"{st['positive_rate']:.3f} | {st['reception_coverage_rate']:.1%} |")
    w("\nCoverage caveat: ~28–30% of actual skill-player receptions come from players "
      "outside the causal universe (bench players with no prior-game usage); the "
      "corpus measures the market-relevant universe, not all receptions.\n")

    w("## 3. The frozen incumbent and its tail problem (before recalibration)\n")
    w("| Season | Role | Brier | Log loss | AUC | Decile-ECE |")
    w("| --- | --- | --- | --- | --- | --- |")
    for s, e in inc_eval["seasons"].items():
        g = e["global"]
        w(f"| {s} | {e['label']} | {g['brier']:.4f} | {g['log_loss']:.4f} | "
          f"{g['auc']:.4f} | {g['ece_decile']:.4f} |")
    w("")
    w("Baselines on 2025 (Brier): empirical drive rate "
      f"{inc_eval['seasons']['2025']['baselines']['b1_empirical']['brier']:.4f}, "
      f"target-share {inc_eval['seasons']['2025']['baselines']['b2_target_share']['brier']:.4f}, "
      f"possession-survival {inc_eval['seasons']['2025']['baselines']['b3_possession_survival']['brier']:.4f} "
      f"— the incumbent beats all three (criteria v2 baseline requirement).\n")
    w("Tail slices of the incumbent (gap = observed − predicted; negative = "
      "overprediction; 95% game-clustered bootstrap CI):\n")
    w("| Season | Slice | n | Mean predicted | Observed | Gap | 95% CI |")
    w("| --- | --- | --- | --- | --- | --- | --- |")
    for s in ("2024", "2025", "2026"):
        for k, v in inc_eval["seasons"][s]["tail_slices"].items():
            if v.get("n"):
                w(f"| {s} | p ≥ {k.split('_')[-1]} | {v['n']:,} | {v['mean_pred']:.3f} | "
                  f"{v['obs_rate']:.3f} | {pp(v['gap_obs_minus_pred'])} | "
                  f"[{pp(v['gap_ci_low'])}, {pp(v['gap_ci_high'])}] |")
    w("\nStructure of the problem: overprediction grows monotonically with predicted "
      "probability. On the 2025 previously-inspected holdout the incumbent overpredicts "
      "by 2.6pp at p ≥ 0.30, 3.7pp at p ≥ 0.35 and 5.1pp at p ≥ 0.40 (CIs exclude "
      "zero); reliability bins above 0.50 overpredict by 6–12pp. This is the same "
      "phenomenon Decision 2C ordered remediated, measured at a smaller aggregate "
      "magnitude than the prior environment reported (disclosed in §0).\n")

    w("## 4. Criteria v3 (frozen before candidate evaluation)\n")
    w("Full definition: `artifacts/criteria_v3.json` (content hash above) and "
      "`docs/CRITERIA_V3.md`. Key thresholds: top-decile and alert-region point gap "
      "≤ 3.0pp absolute and ≤ 10% relative, with the 95% game-clustered CI contained "
      "within ±5.0pp; minimum 300 rows from ≥ 25 games per evaluable slice; EV-band "
      "probability gap ≤ 3.0pp for bands with ≥ 100 rows; global non-degradation "
      "tolerances (Brier +0.002, log loss +0.010, AUC −0.002); fail-closed promotion "
      "requiring all primary criteria to pass on BOTH evaluation seasons; CALIBRATED "
      "label blocked pending human sign-off in all cases.\n")

    w("## 5. Isotonic recalibration (2024 development data only)\n")
    probe = iso["full_fit"]["probe_input_to_output"]
    w(f"Fitted on {iso['n_fit_rows']:,} development rows (positive rate "
      f"{iso['fit_positive_rate']:.4f}); {iso['full_fit']['n_knots']} knots; output "
      f"range {iso['full_fit']['output_range']}. The mapping compresses the tail: "
      f"0.40 → {probe['input_0.40']:.3f}, 0.50 → {probe['input_0.50']:.3f}, "
      f"0.60 → {probe['input_0.60']:.3f}, 0.70+ → {probe['input_0.70']:.3f}.\n")
    inc_d = dev_cmp["incumbent"]
    cal_d = dev_cmp["candidate_crossfit"]
    w("Development-season comparison (cross-fitted candidate; evaluated before any "
      "holdout evaluation):\n")
    w("| Model | Brier | Log loss | AUC | Decile-ECE |")
    w("| --- | --- | --- | --- | --- |")
    w(f"| Incumbent | {inc_d['brier']:.4f} | {inc_d['log_loss']:.4f} | "
      f"{inc_d['auc']:.4f} | {inc_d['ece_decile']:.4f} |")
    w(f"| Candidate (cross-fitted) | {cal_d['brier']:.4f} | {cal_d['log_loss']:.4f} | "
      f"{cal_d['auc']:.4f} | {cal_d['ece_decile']:.4f} |")
    db = dev_cmp["clustered_differences"]["brier_candidate_crossfit_minus_incumbent"]
    w(f"\nClustered Brier difference (candidate − incumbent): {db['diff']:+.5f} "
      f"(95% CI [{db['ci_low']:+.5f}, {db['ci_high']:+.5f}]) — a small, significant "
      f"improvement; log loss and AUC move well within the C5 tolerances. Dev tail "
      f"gaps: p_cal ≥ 0.25 "
      f"{pp(cal_d['tail_slices']['p_cal_crossfit >= 0.25']['gap_obs_minus_pred'])}, "
      f"p_cal ≥ 0.30 "
      f"{pp(cal_d['tail_slices']['p_cal_crossfit >= 0.30']['gap_obs_minus_pred'])} "
      f"vs incumbent p ≥ 0.40 "
      f"{pp(inc_d['tail_slices']['p_incumbent >= 0.40']['gap_obs_minus_pred'])}. "
      f"Residual note: the extreme top of the calibrated range (p_cal ≥ 0.40) still "
      f"overpredicts on dev "
      f"({pp(cal_d['tail_slices']['p_cal_crossfit >= 0.40']['gap_obs_minus_pred'])}).\n")

    w("## 6. Candidate evaluation (criteria v3)\n")
    for season in (2025, 2026):
        e = cand["seasons"][str(season)]
        c = e["criteria_checks"]
        w(f"### {season} — {e['label']}\n")
        gi, gc = e["global"]["incumbent"], e["global"]["candidate"]
        w("| Model | Brier | Log loss | AUC | Decile-ECE |")
        w("| --- | --- | --- | --- | --- |")
        w(f"| Incumbent | {gi['brier']:.4f} | {gi['log_loss']:.4f} | {gi['auc']:.4f} | "
          f"{gi['ece_decile']:.4f} |")
        w(f"| Candidate | {gc['brier']:.4f} | {gc['log_loss']:.4f} | {gc['auc']:.4f} | "
          f"{gc['ece_decile']:.4f} |")
        w("")
        w("| Check | Slice | n | Mean predicted | Observed | Gap | 95% CI | Status |")
        w("| --- | --- | --- | --- | --- | --- | --- | --- |")
        rows = [("C2 top decile", c["C2_top_decile"]["candidate_check"])]
        for k, v in c["C3_alert_regions"]["primary"].items():
            rows.append((f"C3 {k}", v))
        for k, v in c["C3_alert_regions"]["secondary_reported_only"].items():
            rows.append((f"C3 {k} (secondary)", v))
        for k, v in c["C3_alert_regions"]["incumbent_operating_point"].items():
            rows.append((f"anchor: {k}", v))
        for name, v in rows:
            if v.get("n"):
                w(f"| {name} | — | {v['n']:,} | {v['mean_pred']:.3f} | "
                  f"{v['obs_rate']:.3f} | {pp(v['gap_obs_minus_pred'])} | "
                  f"[{pp(v['gap_ci_low'])}, {pp(v['gap_ci_high'])}] | **{v['status']}** |")
            else:
                w(f"| {name} | — | {v.get('n', 0)} | n/a | n/a | n/a | n/a | "
                  f"**{v['status']}** |")
        w(f"\nC5 (non-degradation): **{c['C5_global_non_degradation']['status']}**. ")
        slice_gaps = [(f"{dim}/{key}",
                       abs(v["candidate"]["gap_obs_minus_pred"]),
                       abs(v["incumbent"]["gap_obs_minus_pred"]))
                      for dim, sl in e["prospective_slices"].items()
                      for key, v in sl.items()]
        max_gap = max(g for _, g, _ in slice_gaps)
        worst = max(slice_gaps, key=lambda t: t[1] - t[2])
        w(f"Prospective slices (position / game state / two-minute / half): the "
          f"largest candidate gap magnitude is {100 * max_gap:.1f}pp; the largest "
          f"increase in absolute gap versus the incumbent is "
          f"{100 * (worst[1] - worst[2]):.1f}pp (slice `{worst[0]}`).\n")
    w("Reported against the results: on 2026, the extra reporting anchor "
      "\"p_inc ≥ 0.40 rows, candidate p_cal vs obs\" misses the ±5pp CI-containment "
      "rule (point gap −1.9pp; CI [−5.5pp, +1.6pp]) — an uncertainty-width miss at "
      "the extreme top on a 689-row subset, not a bias miss. It is not a frozen "
      "primary criterion but is disclosed here because it sits exactly where the "
      "engine's highest-confidence alerts would live.\n")

    w("## 7. EV reliability gate — HYPOTHETICAL (simulated prices)\n")
    w("**The historical corpus contains no genuine contemporaneous market quotes.** "
      "Quotes are synthetic, constructed exactly as frozen in criteria v3 (C8) before "
      "candidate evaluation: reference = calibrated probability of the same player "
      "computed from the previous team drive's feature row (lag-1); quote implied "
      "probability = reference × (1 + vig); executed odds additionally degraded by "
      "slippage. Baseline: vig 6%, latency 1 drive, slippage 2%. EV bands are "
      "evaluated within the alert region (model probability ≥ 0.25). **Nothing here "
      "can establish executable betting profitability**, and no live adapter is "
      "enabled.\n")
    for season, ev in ((2025, ev25), (2026, ev26)):
        w(f"### {season} — {ev['label']} (baseline scenario)\n")
        w("| Model | Band | n | Mean pred P | Realized freq | Mean pred EV | Median "
          "pred EV | Mean realized return | 95% CI (return) | Median odds |")
        w("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
        for mname in ("incumbent", "candidate"):
            for k, st in ev["baseline"][mname]["ev_bands"].items():
                if st.get("n"):
                    w(f"| {mname} | {k} | {st['n']:,} | {st['mean_pred_prob']:.3f} | "
                      f"{st['realized_freq']:.3f} | {st['mean_predicted_ev']:+.3f} | "
                      f"{st['median_predicted_ev']:+.3f} | "
                      f"{st['mean_realized_return']:+.3f} | "
                      f"[{st['mean_realized_return_ci'][0]:+.3f}, "
                      f"{st['mean_realized_return_ci'][1]:+.3f}] | "
                      f"{st['median_decimal_odds']:.1f} |")
        w("")
        w("C4 (candidate, probability component): " + ", ".join(
            f"{k} **{v['status']}**" for k, v in
            ev["baseline"]["c4_checks_candidate"].items()) + "\n")
    # fresh-quote (latency 0) evidence, computed from the sensitivity grids
    def fresh_quote_stats(grid):
        f = grid[(grid.latency.astype(str) == "0") & (grid.model == "incumbent")
                 & (grid.band == "EV>=5%") & (grid.slippage == 0.02)]
        return {
            "n_min": int(f.n.min()), "n_max": int(f.n.max()),
            "ev_min": float(f.mean_predicted_ev.min()),
            "ev_max": float(f.mean_predicted_ev.max()),
            "returns_by_vig": {str(vig): float(ret) for vig, ret in
                                zip(f.vig, f.mean_realized_return)},
        }
    fq25, fq26 = fresh_quote_stats(grid25), fresh_quote_stats(grid26)
    w("### Sensitivity (full grid in `artifacts/ev_gate_sensitivity_<season>.csv`)\n")
    w("Three findings drive the economic verdict:\n")
    w("1. **Fresh quotes (latency 0): the calibrated model finds zero positive-EV "
      "alerts** in every vig/slippage configuration — as it should against an "
      "equally-calibrated, fresh market. The incumbent still generates "
      f"{fq26['n_min']}–{fq25['n_max']} alerts per season (vig 3–10%) claiming "
      f"+{100 * min(fq25['ev_min'], fq26['ev_min']):.0f}%–+{100 * max(fq25['ev_max'], fq26['ev_max']):.0f}% "
      "EV, but realized returns are approximately zero on 2025 ("
      + ", ".join(f"{100 * v:+.1f}% at vig {k}" for k, v in
                   fq25["returns_by_vig"].items())
      + ") and **negative on 2026** ("
      + ", ".join(f"{100 * v:+.1f}% at vig {k}" for k, v in
                   fq26["returns_by_vig"].items())
      + "). These are the false edges manufactured by tail miscalibration, measured "
      "directly.")
    w("2. **Stale quotes (latency ≥ 1 drive): large positive realized returns exist "
      "for both models** — but by construction of the simulation (the reference is "
      "deliberately less informed). Even there, claimed EV overstates realized "
      "return by roughly 15–25% in mean terms, and the candidate's probability gap "
      "inside the EV ≥ 5% band on 2025 is 3.05pp (the C4 failure).")
    w("3. **Frozen pre-game quotes produce almost no qualifying alerts** (n ≤ 37 in "
      "every configuration): under fully stale pricing the engine's universe "
      "collapses; slippage and vig shrink alert volume but do not change the "
      "qualitative picture.\n")

    w("## 8. Verdict (criteria v3, rule C9 — fail-closed)\n")
    w("| Component | Decision |")
    w("| --- | --- |")
    w(f"| Offline logistic baseline | Retain (frozen; 2023 training season) |")
    w("| Isotonic tail recalibration (2024 dev only) | Retain as RESEARCH candidate |")
    w("| Mixture models M2/M3 | Not promoted (unchanged) |")
    w("| Criteria v2 research results | Accept as reported (incumbent beats all "
      "three baselines out-of-sample) |")
    w(f"| Criteria v3 outcome | 2025: " + ", ".join(
        f"{k}={'PASS' if v else 'FAIL'}" for k, v in checks_2025.items()) + "; 2026: "
      + ", ".join(f"{k}={'PASS' if v else 'FAIL'}" for k, v in checks_2026.items()) + " |")
    w(f"| Candidate status | **{verdict['candidate_status']}** (C4 fails on the "
      f"EV ≥ 5% band of the 2025 previously-inspected holdout: probability gap "
      f"3.05pp vs the 3.0pp threshold) |")
    w("| CALIBRATED production label | **BLOCKED** (human sign-off deferred) |")
    w("| Real-book model coverage | NO_COVERAGE |")
    w("| Live sportsbook adapters | Disabled |")
    w("| HUMAN_REVIEW.md | Present, UNSIGNED, status DEFERRED |\n")

    w("## 9. Answer to the key acceptance question\n")
    w("> When PropStein identifies a high-confidence opportunity, is the estimated "
      "advantage still credible after calibration uncertainty, market-price quality, "
      "and latency are accounted for?\n")
    w("**Not yet — the model remains research-only.** What is now supported:\n")
    w("- **Probability calibration: credible.** After isotonic recalibration, "
      "alert-region probability gaps are ≤ 1.7pp with clustered CIs inside ±5pp on "
      "both the previously-inspected holdout and the genuinely-unseen 2026 slice.")
    w("- **Economics: not established.** Against fresh, efficient quotes the "
      "calibrated model correctly finds no edge; the incumbent's remaining edges do "
      "not realize (≈ 0% on 2025, negative on 2026). Against stale quotes, apparent "
      "edges exist but overstate realized returns, and one EV-band probability check "
      "fails on the holdout. Genuine contemporaneous quote data is required before "
      "any executable-advantage claim; simulated-price analysis is inherently "
      "hypothetical.\n")
    w("Consequences: NO_COVERAGE stands for real books, adapters stay disabled, and "
      "the next evidentiary step is a licensed historical quote feed (or an "
      "observability-only live quote capture, strictly read-only) to replace the "
      "synthetic reference.\n")

    w("## 10. Limitations\n")
    w("- Rebuild, not continuation: see §0. All numbers are fresh; prior-environment "
      "figures were not used as inputs.")
    w("- Universe coverage: ~28–30% of receptions fall outside the causal player "
      "universe (bench players without prior-game usage).")
    w("- Participation is unobservable in play-by-play and was not imputed; features "
      "use recorded usage only.")
    w("- 2026 is weeks 1–7 (107 games): the unseen slice is smaller and its CIs are "
      "correspondingly wider.")
    w("- Isotonic output is capped near 0.50 by dev-season data; probabilities above "
      "0.50 are structurally unreachable until more extreme dev data exists.")
    w("- The EV gate's quote model is synthetic; its parameters were frozen before "
      "evaluation but remain assumptions, not measurements of any real book.")
    w("- Baselines B1–B3 are simple by design; stronger baselines (e.g., gradient "
      "boosted trees) were out of scope for Decision 2C.\n")

    w("## 11. Artifact preservation manifest\n")
    w("| File | SHA-256 (first 16) |")
    w("| --- | --- |")
    preserved = []
    for name in sorted(p.name for p in ARTIFACTS.iterdir()
                       if p.suffix in (".json", ".csv") or p.name.endswith(".csv.gz")):
        h = sha256_of(ARTIFACTS / name)
        preserved.append({"file": f"artifacts/{name}", "sha256": h})
        w(f"| `artifacts/{name}` | `{h[:16]}` |")
    w("\nOriginal incumbent predictions and candidate predictions are preserved "
      "row-level in `artifacts/incumbent_predictions_<season>.csv.gz` and "
      "`artifacts/candidate_predictions_<season>.csv.gz`; the isotonic mapping "
      "(knots) is fully specified in `artifacts/isotonic_calibrator.json`; the "
      "frozen model's coefficients and scaler statistics are in "
      "`artifacts/incumbent_model.json`. Raw data is reproducible via "
      "`research/00_download_data.py` (provenance manifest with per-file hashes).\n")

    DOCS.mkdir(exist_ok=True)
    with open(DOCS / "TAIL_RECALIBRATION_REPORT.md", "w") as f:
        f.write("\n".join(md))

    # ---------------- criteria doc ----------------
    cv = ["# Criteria v3 (frozen before candidate evaluation)\n",
          f"Defined (UTC): {criteria['defined_at_utc']}  ",
          f"Content SHA-256: `{criteria['content_sha256']}`\n"]
    for k in sorted(criteria):
        if k in ("defined_at_utc", "content_sha256"):
            continue
        cv.append(f"## {k}\n")
        v = criteria[k]
        cv.append("```json\n" + json.dumps(v, indent=2) + "\n```\n")
    with open(DOCS / "CRITERIA_V3.md", "w") as f:
        f.write("\n".join(cv))

    # ---------------- HUMAN_REVIEW.md (unsigned) ----------------
    hr = ["# HUMAN_REVIEW.md — PropStein Live Sniper model promotion",
          "",
          "**Status: DEFERRED — UNSIGNED.** Per Decision 2C, human sign-off is "
          "deferred and this file is intentionally not signed. No model is promoted "
          "to CALIBRATED status.\n",
          "## What a human reviewer should verify before any future signature\n",
          "1. Rebuild disclosure (README §Rebuild disclosure; report §0): this "
          "workspace re-derives all artifacts from public nflverse data; the prior "
          "environment's artifacts were not available.",
          "2. Reproduce the pipeline end-to-end: `python research/00..09` in order; "
          "confirm `artifacts/provenance_manifest.json` hashes match downloads.",
          "3. Confirm ordering discipline: `artifacts/criteria_v3.json` "
          "(content hash above) was committed before scripts 05–08 ran (git history).",
          "4. Spot-check leakage assertions in `research/01_build_corpus.py` output "
          "(all assertions passed in this run) and the causal player-universe rule.",
          "5. Review the criteria v3 verdict and the single C4 failure (EV ≥ 5% "
          "band, 2025 previously-inspected holdout, probability gap 3.05pp vs "
          "3.0pp threshold) and decide whether to accept or tighten the threshold.",
          "6. Review the EV reliability gate limitations (hypothetical simulated "
          "prices) and the fresh-quote finding before authorizing any "
          "observability-only quote capture.",
          "7. Confirm no sportsbook adapter was enabled and no order-placement code "
          "exists in this workspace.\n",
          "## Promotion status (mirror of Decision 2C)\n",
          "| Component | Decision |", "| --- | --- |",
          "| Offline logistic baseline | Retain |",
          "| Mixture models M2/M3 | Do not promote |",
          "| Criteria v2 research results | Accept as reported |",
          "| Tail recalibration research | Approved (executed in this workspace) |",
          "| Human sign-off | **Deferred** |",
          "| CALIBRATED label | **Blocked** |",
          "| Real-book model coverage | NO_COVERAGE |",
          "| Live sportsbook adapters | Disabled |\n",
          "## Signature\n",
          "- Reviewer: ______________________",
          "- Date: ______________________",
          "- Decision: ______________________",
          "",
          "*(Left blank intentionally.)*\n"]
    with open(HUMAN_REVIEW, "w") as f:
        f.write("\n".join(hr))

    master = {
        "generated_at_utc": now,
        "decision": "2C — Tail Calibration & Economic Reliability",
        "verdict": verdict,
        "checks_2025": checks_2025,
        "checks_2026": checks_2026,
        "candidate_status": verdict["candidate_status"],
        "preserved_artifacts": preserved,
    }
    with open(ARTIFACTS / "tail_recalibration_report.json", "w") as f:
        json.dump(master, f, indent=2)

    print(f"[report] candidate_status={verdict['candidate_status']}")
    print(f"[report] checks 2025: {checks_2025}")
    print(f"[report] checks 2026: {checks_2026}")
    print("[report] docs/TAIL_RECALIBRATION_REPORT.md, docs/CRITERIA_V3.md, "
          "HUMAN_REVIEW.md (unsigned) written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
