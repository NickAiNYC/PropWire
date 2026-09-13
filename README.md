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

## Deploy

Railway, not Vercel — `railway.json` is configured. Vercel's execution ceiling
and ephemeral filesystem break the GLM fit and the CLV log respectively.

## Before you charge anyone

1. Run the agent weekly against live lines. Do not bet.
2. `log_picks()` + `record_closing()` every week.
3. After ~8 weeks, `clv_report()`.
4. If mean CLV minus 1.96 SE is above zero, you have something. If not, you
   don't, and no amount of frontend fixes it.

`docs/PAYMENTS.md` covers why "positive EV" as a marketing claim is a problem
with Stripe and with the FTC independently of Stripe.

## Disclaimer

Statistical estimates for research and entertainment. Not financial advice.
21+ where legal. If gambling is causing harm, call 1-800-GAMBLER.
