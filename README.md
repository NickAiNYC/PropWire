# PropStein

<img src="viewer/propstein-logo.svg" alt="PropStein logo" width="420" />

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
---

### 4. Vercel Deployment (Edge Web App)

The viewer frontend and pre-computed slate data are deployed to Vercel at global edge:

- **Live Production URL**: [https://propstein.vercel.app](https://propstein.vercel.app)
- **Vercel Project**: [`propstein`](https://vercel.com/nicks-projects-ec56abd4/propstein)
- **Deployment root**: repository root (`.`). The root [`vercel.json`](vercel.json) publishes `viewer/`; do not deploy from inside `viewer/`.
- **Configuration**: Service workers are never cached, HTML/data use short edge caching, and versioned static assets use immutable caching.

#### Deploying Slate Updates to Vercel
Whenever the weekly pipeline runs (`python src/week1.py`), updated projections and picks are automatically synced to `viewer/slate_projections.json` and `viewer/current_picks.json`. To push the new weekly build live:

```bash
vercel --prod
```
The edge deployment builds and propagates globally in ~4 seconds.

---

## Disclaimer

Statistical estimates for research and entertainment. Not financial advice.
21+ where legal. If gambling is causing harm, call 1-800-GAMBLER.
