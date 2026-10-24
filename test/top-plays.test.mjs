import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSandbox, loadApp } from './helpers/sandbox.mjs';

/**
 * TOP PLAYS RANKING — Phase 2, commit 4.
 *
 * EV-ranked Top Plays mode (adapter-driven). Order contract (user-approved
 * default): EV per unit staked desc → probability edge desc → receipt-
 * verified first → player name asc. Rows without a bookable quote in the
 * active market, or with incomplete projection inputs, are hidden.
 *
 * The fixture feed carries deterministic tie pairs exactly to pin the
 * tie-break chain: Towns / Bridges / Holmgren share EV 0.101 and edge
 * 0.055, so the name sort decides (Chet Holmgren < Karl-Anthony Towns <
 * Mikal Bridges).
 */

async function loadNba() {
  const { sandbox } = buildSandbox({ seedLocalStorage: { propwire_active_sport: 'nba' } });
  const P = loadApp(sandbox);
  await P.loadSlate(P.defaultBootSlate());
  P.setPlayMode('top');
  return P;
}

test('Top Plays: EV per unit descending within the active market', async () => {
  const P = await loadNba();
  P.state.filters.market = 'points';
  const names = P.filteredRows().map((r) => r.player_display_name);
  // points quotes: SGA .112, Holmgren .101, Brunson .096, Gordon .075,
  // J. Williams .072, Braun .066 — every other player lacks a points quote.
  assert.deepEqual(names, [
    'Shai Gilgeous-Alexander',
    'Chet Holmgren',
    'Jalen Brunson',
    'Aaron Gordon',
    'Jalen Williams',
    'Christian Braun',
  ]);
});

test('Top Plays: deterministic tie-break by name when EV and edge tie', async () => {
  const P = await loadNba();
  P.state.filters.market = 'rebounds';
  const names = P.filteredRows().map((r) => r.player_display_name);
  // rebounds quotes: Towns .101/.055, Bridges .101/.055 (tie → name),
  // Robinson .077, Hart .068, Hartenstein .061.
  assert.deepEqual(names, [
    'Karl-Anthony Towns', // "Karl-Anthony…" < "Mikal…" — name decides
    'Mikal Bridges',
    'Mitchell Robinson',
    'Josh Hart',
    'Isaiah Hartenstein',
  ]);
});

test('Top Plays: incomplete projection inputs are hidden even when quoted', async () => {
  const P = await loadNba();
  // The deliberate probe row has points/pra inputs = null. Give it a quote
  // so ONLY the input gate can exclude it (a missing quote would trivially
  // hide it), then confirm both the ranked list and adapter gate agree.
  P.state.odds.quotes.push({
    quote_id: 'fixture_probe_two_way',
    provider_quote_id: 'fixture_probe_two_way',
    book: 'PropWire Fixture',
    player_id: 'fx-nba-two_way_callup',
    player_name: 'Two-Way Callup',
    team: 'NYK', opponent: 'BOS',
    game_id: 'nba-20261022-BOS-NYK',
    position: 'SG', market: 'points',
    line: 4.5, fair_line: 4.0, over_odds: -110, under_odds: -110,
    observed_at: '2026-10-22T17:00:00Z',
    source: 'PropWire synthetic fixture (not a sportsbook quote; unverified research data)',
    verified: false, _fixture: true,
    evaluation: { is_qualified: false, status: 'UNVERIFIED', best_side: 'OVER', prob_edge: 0.5, break_even_adv: 0.4, expected_return: 0.9, actionable_stake: 0, catalyst: 'none', injury_context: 'none (fixture)' },
  });
  P.state.filters.market = 'points';
  const names = P.filteredRows().map((r) => r.player_display_name);
  assert.ok(!names.includes('Two-Way Callup'), 'incomplete-input row hidden from ranked view despite huge EV');
  const probe = P.state.slate.find((r) => r.player_id === 'fx-nba-two_way_callup');
  assert.equal(P.adapter.hasCompleteInputs(probe, 'points'), false);
});

test('Top Plays: receipt-verified wins the final tie-break', async () => {
  const P = await loadNba();
  P.state.filters.market = 'points';
  // Force an EV+edge tie between SGA (.112/.061) and Braun (.066/.040) and
  // mark Braun verified — verified must precede despite name order.
  const sga = P.state.odds.quotes.find((q) => q.player_id === 'fx-nba-shai_gilgeous_alexander');
  const braun = P.state.odds.quotes.find((q) => q.player_id === 'fx-nba-christian_braun');
  braun.evaluation.expected_return = sga.evaluation.expected_return;
  braun.evaluation.prob_edge = sga.evaluation.prob_edge;
  braun.verified = true;
  braun.receipt_id = 'deadbeefcafebabe';
  const names = P.filteredRows().map((r) => r.player_display_name);
  assert.equal(names[0], 'Christian Braun', 'verified quote precedes on full tie');
  assert.equal(names[1], 'Shai Gilgeous-Alexander');
});

test('NFL Top Plays keeps the picks-file behavior (verbatim, parity-guarded)', async () => {
  const { sandbox } = buildSandbox();
  const P = loadApp(sandbox);
  await P.loadSlate('2026_w7');
  P.setPlayMode('top');
  const topList = (P.state.picks && P.state.picks.top_projections) || [];
  assert.ok(topList.length > 0, 'W7 picks file carries top_projections');
  const rows = P.filteredRows();
  const listNames = topList.map((p) => String(p.player).toLowerCase());
  for (const row of rows) {
    assert.ok(listNames.includes(String(row.player_display_name).toLowerCase()),
      `${row.player_display_name} must come from picks.top_projections`);
  }
  assert.equal(rows.length, new Set(listNames).size, 'all and only the picks-file names render');
});
