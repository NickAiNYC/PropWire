# Receiving Props Agent

Weekly NFL receptions and receiving-yards prop model with a distributional
core, walk-forward validation, and CLV logging.

**Read `docs/FINDINGS.md` before you deploy or sell anything.** The headline:
the model is well calibrated (ECE < 1.2%) and beats a form-only baseline, but
that is not the same as beating a sportsbook, and the repo does not yet contain
evidence that it does.

## Design

**Compound Negative-Binomial / Gamma**, not a point projection:

```
N ~ NegBin(mu_n, alpha)                          receptions
Y | N=n ~ Gamma(shape = n*k, scale = mu_ypr/k)   yards, given receptions
Y | N=0 = 0
```

This matters. Receiving yards has a point mass at zero, is strongly right
skewed, and its variance grows with the mean. A Gaussian model mis-prices every
tail — which is where alt lines and parlay legs live. The compound form gives a
correct P(over) at *any* line and lets receptions and yards be sampled jointly
with their real correlation (φ ≈ 0.65).

No LLM in the decision path. The language model writes reasoning *after* the
numbers are fixed, so it can never talk the model into a bet.

## Week 1 status

`src/week1.py` runs a live slate. 2026 Week 1 builds clean: 440 rostered
receivers, 136 projectable after exclusions.

```bash
cd src && python fetch_data.py
python week1.py --season 2026 --week 1            # projections + fair lines
python week1.py --season 2026 --week 1 --odds     # + picks (needs ODDS_API_KEY)
```

**Read `docs/WEEK1.md` first.** Week 1 calibration error is 3-5% even after
correction, versus 0.4-0.8% late season - larger than the edge the agent looks
for. The Week-1 gate is raised to 10% edge with a 0.5% stake cap accordingly,
and very few picks will clear it. That is the intended behaviour.

## Layout

```
src/features.py   leak-free features; assert_no_leakage() enforces it
src/slate.py      forward slate build, roster/injury feeds, Week-1 handling
src/week1.py      CLI runner for a live week
src/model.py      compound distribution, de-vig, Kelly
src/baseline.py   form-only line setter (the fair-line opponent)
src/backtest.py   walk-forward calibration + simulation
src/parlay.py     correlation-aware SGP and alt-line pricing
src/odds.py       The Odds API client + no-vig sharp consensus
src/agent.py      weekly picks, hard gates, CLV log
api/main.py       FastAPI service, Whop entitlement
```

## Run

```bash
pip install -r requirements.txt
cd src && python backtest.py          # ~4 min, reproduces docs/FINDINGS.md
```

Data downloads itself from nflverse GitHub releases. No key needed.

Live picks need `ODDS_API_KEY` (player props are a paid tier — there is no free
path) and `WHOP_API_KEY` for entitlement.

## Web App & Weekly Workflow

The project includes a polished, dependency-light web application (Vanilla JS + CSS frontend mounted directly on the FastAPI server).

### 1. Local Development

```bash
# 1. Create and activate virtual environment
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 2. Run the full web application & API
uvicorn api.main:app --reload --host 127.0.0.1 --port 8000
```

Open [http://localhost:8000](http://localhost:8000) in your browser:
- **Top Picks Card**: Volume-based top projections, median fair lines, and one-click slip copy.
- **Slate Browser & Comparison Tool**: Sortable/filterable table of all receivers with inline book line comparison, real-time edge calculation (green/yellow/red against the edge gate), EV per unit, and Kelly sizing.
- **Touchdown Props Panel**: Empirical Bayesian shrinkage TD model (pos mean regressed to 2025 rate, scaled by implied team total) with tiered probability groupings and fair American odds.
- **Prop Pricing Calculator**: Deep-dive interactive evaluator for alternate lines with full Compound NegBin/Gamma distribution inspection.
- **CLV Tracking Log**: Honest closing line value audit (mean CLV, 95% CI, % beating close, and closing line entry form).
- **Weekly Pipeline Runner**: Interactive "Run Week N" action that shells out to `src/week1.py`, streams live terminal progress via Server-Sent Events (SSE), and refreshes slate data automatically.

*(Optional)* You can also run the static frontend standalone without FastAPI:
```bash
cd viewer && python3 -m http.server 3000
```

---

### 2. Deployment (Railway)

Railway provides a persistent process and non-ephemeral filesystem required for running statsmodels GLM fits and persisting `picks_log.jsonl` without serverless execution ceilings.

- **Config**: Configured via [`railway.json`](railway.json) and [`Dockerfile`](Dockerfile).
- **Start Command**: `uvicorn api.main:app --host 0.0.0.0 --port $PORT`
- **Persistent Volume**: Mount a volume at `/data` in Railway settings to preserve audit logs across deploys.
- **Environment Variables**:
  - `PICKS_PATH`: Path to active picks file (defaults to `/data/current_picks.json` or `current_picks.json`).
  - `PICKS_LOG`: Path to CLV audit ledger (defaults to `/data/picks_log.jsonl` or `picks_log.jsonl`).
  - `SLATE_PATH`: Path to slate projections (defaults to `slate_projections.json`).
  - `ODDS_API_KEY`: *(Optional)* API key from The Odds API for live consensus player prop odds.
  - `WHOP_API_KEY`: *(Optional)* Enforces server-side subscription paywall on `/picks`. If omitted, local/web routes run in pass-through mode.

---

### 3. Weekly Operational Cadence

1. **Tuesday – Thursday (Ingest & Projection)**:
   - Schedule and depth charts finalize.
   - Run the weekly pipeline via the UI **Run Slate** button or terminal:
     ```bash
     python src/week1.py --season 2026 --week 1
     ```
   - Model fits in ~2 seconds, updates `slate_projections.json`, `current_picks.json`, and `top_picks.json`.
2. **Friday – Sunday Morning (Line Comparison & Execution)**:
   - Open the **Slate Browser**. In each receiver's row, type/paste your sportsbook's line into the **Book Line Comparison** tool.
   - The app instantly runs the compound distribution and flags qualifying plays:
     - 🟢 **Green (Edge &ge; 10% in W1 / &ge; 3% normal)**: Value play clearing the calibration gate. Shows EV per unit and suggested Kelly fraction.
     - 🟡 **Yellow**: Positive edge below strict risk gate (lean / watch).
     - 🔴 **Red**: Negative edge / book is sharp.
   - Click **Save Bet to CLV Tracking Log** in the Calculator to add any active play to `picks_log.jsonl`.
   - Click **Copy as Text for Slips** in the Top Picks Card for rapid slip entry.
3. **Sunday Night / Monday (Closing Line Value Audit)**:
   - Once games lock or settle, open the **CLV Tracking Log** tab.
   - Select your logged picks and input the closing devigged probability or closing odds.
   - The app computes `clv = model_prob - closing_prob` and updates the running 95% Confidence Interval.
   - If mean CLV is not positive after ~8 weeks, do not scale bet size.

---

## Disclaimer

Statistical estimates for research and entertainment. Not financial advice.
21+ where legal. If gambling is causing harm, call 1-800-GAMBLER.

