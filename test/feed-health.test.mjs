import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildSandbox, loadApp, VIEWER } from './helpers/sandbox.mjs';

/**
 * FEED HEALTH / FAILURE-MODE UI — Phase 2, commit 5.
 *
 * A feed outage must never masquerade as "the market is efficient". These
 * tests pin: fixture labeling, transport-failure banners (slate/odds),
 * staleness thresholds from the per-sport breaker config, and the ledger
 * data_provenance stamp (fixture entries stamped; NFL live entries carry
 * NO field — ledger schema stays byte-identical for NFL).
 *
 * The shared parity sandbox has no getElementById (by design — that is what
 * keeps Phase 2 chrome outside the golden snapshots). These tests attach a
 * LOCAL getElementById to their own sandbox instances to assert banner copy.
 */

function attachLocalDom(sandbox) {
  const els = new Map();
  sandbox.document.getElementById = (id) => {
    if (!els.has(id)) {
      els.set(id, {
        id, innerHTML: '', textContent: '', hidden: true, className: '',
        dataset: {}, style: { cssText: '' },
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener() {}, removeEventListener() {},
      });
    }
    return els.get(id);
  };
  return els;
}

/** Local file-backed fetch mirroring the sandbox impl, with per-path overrides. */
function localFetcher(overrides = {}) {
  return async (rawPath) => {
    const clean = String(rawPath).split('?')[0];
    const override = overrides[clean];
    if (override) return override();
    const file = path.join(VIEWER, clean.replace(/^\/+/, ''));
    if (!fs.existsSync(file)) return { ok: false, status: 404, json: async () => { throw new Error('not found'); } };
    const text = fs.readFileSync(file, 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(text) };
  };
}

test('fixture dataset surfaces the RESEARCH FIXTURES banner (NBA)', async () => {
  const { sandbox } = buildSandbox({ seedLocalStorage: { propwire_active_sport: 'nba' } });
  const els = attachLocalDom(sandbox);
  const P = loadApp(sandbox);
  await P.loadSlate(P.defaultBootSlate());
  P.updateFeedHealthUI?.();
  const banner = els.get('dataQualityBanner');
  assert.ok(banner, 'banner element resolved');
  assert.equal(banner.hidden, false, 'fixture banner visible');
  assert.ok(banner.className.includes('fixture'), 'fixture tone class');
  assert.match(banner.innerHTML, /RESEARCH FIXTURES/);
  // Banner must SAY what it means (audit M15): sample data, not actionable,
  // not a research record — never just a bare "FIXTURE" label.
  assert.match(banner.innerHTML, /not actionable/i);
  assert.match(banner.innerHTML, /not a research record/i);
  assert.match(banner.innerHTML, /not sportsbook quotes/i);
  assert.equal(P.state.feedHealth.dataKind, 'fixture');
  // Fixture timestamps sit in the future relative to the frozen test clock → fresh.
  assert.equal(P.feedHealthStates().oddsFreshness, 'ok');
});

test('odds feed outage shows ODDS FEED OFFLINE, never the anti-tout state', async () => {
  const { sandbox } = buildSandbox({ seedLocalStorage: { propwire_active_sport: 'nba' } });
  const els = attachLocalDom(sandbox);
  const P = loadApp(sandbox);
  sandbox.fetch = localFetcher({
    'nba_odds_2026-10-22.json': () => ({ ok: false, status: 404, json: async () => { throw new Error('nf'); } }),
  });
  await P.loadSlate(P.defaultBootSlate());
  assert.equal(P.state.feedHealth.odds, 'error');
  const banner = els.get('dataQualityBanner');
  assert.match(banner.innerHTML, /ODDS FEED OFFLINE/);
  assert.match(banner.innerHTML, /no actionable classification is possible/i);
  assert.ok(banner.className.includes('error'));
});

test('slate feed outage shows SLATE FEED OFFLINE with an honest empty-board explanation', async () => {
  const { sandbox } = buildSandbox({ seedLocalStorage: { propwire_active_sport: 'nba' } });
  const els = attachLocalDom(sandbox);
  const P = loadApp(sandbox);
  sandbox.fetch = localFetcher({
    'nba_slate_2026-10-22.json': () => ({ ok: false, status: 500, json: async () => { throw new Error('nf'); } }),
  });
  await P.loadSlate(P.defaultBootSlate());
  assert.equal(P.state.feedHealth.slate, 'error');
  assert.equal(P.state.slate.length, 0);
  const banner = els.get('dataQualityBanner');
  assert.match(banner.innerHTML, /SLATE FEED OFFLINE/);
  assert.match(banner.innerHTML, /empty because data is missing, not because the market is efficient/i);
});

test('stale odds breach the per-sport threshold and downgrade the banner to warn (NFL live)', async () => {
  const { sandbox } = buildSandbox();
  const els = attachLocalDom(sandbox);
  const P = loadApp(sandbox);
  // Frozen clock = 2026-10-22T12:00Z; the W7 live feed was updated 03:32Z →
  // ~8.5h old vs the 6h per-sport limit. NFL is live data, so staleness
  // semantics apply (fixtures suppress staleness by design).
  await P.loadSlate('2026_w7');
  const states = P.feedHealthStates();
  assert.equal(states.dataKind, 'live');
  assert.equal(states.oddsFreshness, 'stale');
  assert.equal(states.thresholds.oddsStaleSeconds, 21600);
  const banner = els.get('dataQualityBanner');
  assert.match(banner.innerHTML, /ODDS STALE/);
  assert.match(banner.innerHTML, /treat prices as historical/i);
  assert.ok(banner.className.includes('warn'));
});

test('stale news watcher mirrors the dead-man switch semantics (NFL live)', async () => {
  const { sandbox } = buildSandbox();
  const els = attachLocalDom(sandbox);
  const P = loadApp(sandbox);
  sandbox.fetch = localFetcher({
    'news_watcher_state.json': () => ({
      ok: true, status: 200,
      json: async () => ({ version: '1.1.0', last_polled_at: '2026-10-21T12:00:00Z', poll_count: 1, is_alive: false, teams_locked: {}, players_pending: {} }),
    }),
  });
  await P.loadSlate('2026_w7');
  const states = P.feedHealthStates();
  assert.equal(states.newsFreshness, 'stale');
  assert.equal(states.thresholds.newsStaleSeconds, 300);
  const banner = els.get('dataQualityBanner');
  assert.match(banner.innerHTML, /NEWS FEED STALE/);
  assert.match(banner.innerHTML, /sniper dispatch is suppressed/i);
});

test('fixture datasets suppress staleness signals (static by design)', async () => {
  const { sandbox } = buildSandbox({ seedLocalStorage: { propwire_active_sport: 'nba' } });
  attachLocalDom(sandbox);
  const P = loadApp(sandbox);
  // Fixture updated_at is fixed in the past relative to any real clock —
  // staleness must stay 'ok' for fixture data while transport errors would
  // still surface.
  await P.loadSlate(P.defaultBootSlate());
  const states = P.feedHealthStates();
  assert.equal(states.dataKind, 'fixture');
  assert.equal(states.oddsFreshness, 'ok');
});

test('ledger provenance: fixture entries stamped, NFL live entries carry no field', async () => {
  // NBA: every entry from fixture quotes is stamped.
  const nba = buildSandbox({ seedLocalStorage: { propwire_active_sport: 'nba' } });
  const NP = loadApp(nba.sandbox);
  await NP.loadSlate(NP.defaultBootSlate());
  const fixtureQuote = NP.state.odds.quotes.find((q) => q.market === 'points');
  NP.state.filters.market = 'points';
  NP.state.portfolio = [];
  NP.logBet(fixtureQuote.player_id);
  assert.equal(NP.state.portfolio.length, 1);
  assert.equal(NP.state.portfolio[0].data_provenance, 'fixture');
  assert.equal(NP.state.portfolio[0].sport, 'nba');

  // NFL: the ledger schema must remain byte-identical — no provenance key.
  const nfl = buildSandbox();
  const FP = loadApp(nfl.sandbox);
  await FP.loadSlate('2026_w7');
  const liveQuote = FP.state.odds.quotes.find((q) => q.market === 'receiving_yards');
  FP.state.filters.market = 'receiving_yards';
  FP.state.portfolio = [];
  FP.logBet(liveQuote.player_id);
  assert.equal(FP.state.portfolio.length, 1);
  assert.equal('data_provenance' in FP.state.portfolio[0], false, 'NFL live entries must NOT gain the field (parity)');
  assert.equal(FP.state.portfolio[0].sport, 'nfl');
});
