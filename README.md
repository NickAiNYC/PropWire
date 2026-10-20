# PROP·WIRE

Trust-first NFL player-prop research. The production interface shows model baselines, role changes, and market quotes while fail-closing qualification and stake sizing unless every quote has a fresh, auditable provider receipt.

## Local verification

```bash
npm test
node --check app.js
python3 -m http.server 4173
```

## Production

- App: https://receiving-props-agent.vercel.app
- Receipt contract: [`docs/ODDS_RECEIPTS.md`](docs/ODDS_RECEIPTS.md)

The bundled `live_odds_feed.json` is demonstration data. It contains no verified provider receipts and can never qualify or receive a stake.
