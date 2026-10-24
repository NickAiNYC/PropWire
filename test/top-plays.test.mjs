import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSandbox, loadApp } from './helpers/sandbox.mjs';

/**
 * TOP PLAYS RANKING — Phase 2, commit 4 (revised by the Phase 2 audit, H5).
 *
 * EV-ranked Top Plays mode (adapter-driven). Order contract (audit-revised):
 * EV per unit staked desc → probability edge desc → MODEL CONFIDENCE
 * (narrower adapter distribution interval first — receipt coverage is a
 * data-availability signal, not a quality signal, so "verified" no longer
 * ranks plays) → sample size (games_prior desc, neutral when absent) →
 * player name asc. Rows without a bookable quote in the active market, or
 * with incomplete projection inputs, are hidden.
 *
 * The fixture feed carries deterministic tie pairs exactly to pin the
 * tie-break chain: Player H and Player I share EV 0.101 and edge 0.055 with
 * different model interval widths (5 vs 2), so confidence decides.
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
  // points quotes: Player S .112, Player T .101, Player G .096, Player O .075,
  // Player U .072, Player P .066 — every other player lacks a points quote.
  assert.deepEqual(names, [
    'Player S',
    'Player T',
    'Player G',
    'Player O',
    'Player U',
    'Player P',
  ]);
});

test('Top Plays: model confidence (narrower interval) breaks EV and edge ties', async () => {
  const P = await loadNba();
  P.state.filters.market = 'rebounds';
  const names = P.filteredRows().map((r) => r.player_display_name);
  // rebounds quotes: Player H .101/.055 (mu 11.4/sd 2.6 → width 5),
  // Player I .101/.055 (mu 3.9/sd 1.4 → width 2) — full EV+edge tie, so the
  // tighter model interval ranks first even though "Player H" sorts earlier
  // by name; then Player L .077, Player K .068, Player W .061.
  assert.deepEqual(names, [
    'Player I', // width 2 beats width 5 on the confidence tie-break
    'Player H',
    'Player L',
    'Player K',
    'Player W',
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

test('Top Plays: sample size and name decide after confidence; verified flag is ignored', async () => {
  const P = await loadNba();
  P.state.filters.market = 'points';
  const sgaQuote = P.state.odds.quotes.find((q) => q.player_id === 'fx-nba-player-s');
  const pQuote = P.state.odds.quotes.find((q) => q.player_id === 'fx-nba-player-p');
  const sgaRow = P.state.slate.find((r) => r.player_id === 'fx-nba-player-s');
  const pRow = P.state.slate.find((r) => r.player_id === 'fx-nba-player-p');
  // Force a full EV+edge+confidence tie: Player P width 7 (mu 12.4/sd 3.5)
  // → widen sd to 6.1 so the interval width equals Player S's 11.
  pQuote.evaluation.expected_return = sgaQuote.evaluation.expected_return;
  pQuote.evaluation.prob_edge = sgaQuote.evaluation.prob_edge;
  pRow.sd_pts = 6.1;
  const pairOrder = () => P.filteredRows()
    .map((r) => r.player_display_name)
    .filter((n) => n === 'Player S' || n === 'Player P');

  // Equal confidence, no sample info → name decides (Player P < Player S).
  assert.deepEqual(pairOrder(), ['Player P', 'Player S']);

  // Sample size decides: more prior games ranks first.
  sgaRow.games_prior = 12;
  pRow.games_prior = 5;
  assert.deepEqual(pairOrder(), ['Player S', 'Player P']);

  // "verified" is a data-availability flag, not a quality signal: marking
  // the losing side verified must NOT reorder the ranking (audit H5).
  pQuote.verified = true;
  pQuote.receipt_id = 'deadbeefcafebabe';
  assert.deepEqual(pairOrder(), ['Player S', 'Player P'],
    'a verified receipt must never outrank an equally supported play');
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
