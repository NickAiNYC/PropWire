import test from 'node:test';
import assert from 'node:assert/strict';

/* ─── CORRELATED EXPOSURE ENGINE IMPLEMENTATION (PURE LOGIC) ─── */
function checkCorrelatedRisk(row, evaluation, state) {
  if (!row) return null;
  const market = state.filters?.market || 'receiving_yards';
  const correlationKey = `${row.team}::${market}`;
  if (state.dismissedCorrelations && state.dismissedCorrelations.has(correlationKey)) {
    return null;
  }

  const portfolio = state.portfolio || [];
  const competing = portfolio.find(
    (b) => b.team === row.team && b.player_id !== row.player_id && b.market === market
  );
  if (!competing) return null;

  const rowSide = evaluation?.side || 'OVER';
  const compSide = competing.side || 'OVER';

  if (rowSide === 'OVER' && compSide === 'OVER') {
    return {
      type: 'SAME_TEAM_EXPOSURE',
      isHedge: false,
      competingPlayer: competing.player_name,
      competingSide: compSide,
      team: row.team,
      market,
      badgeText: `⚠️ Same-Team (${competing.player_name.split(' ').pop()})`,
      badgeClass: 'corr-risk',
      message: `Same-team exposure: results may be correlated (target distribution & game script with ${competing.player_name} on ${row.team})`,
      dismissKey: correlationKey
    };
  } else if ((rowSide === 'OVER' && compSide === 'UNDER') || (rowSide === 'UNDER' && compSide === 'OVER')) {
    return {
      type: 'DISTRIBUTION_HEDGE',
      isHedge: true,
      competingPlayer: competing.player_name,
      competingSide: compSide,
      team: row.team,
      market,
      badgeText: `⚡ Hedge (${competing.player_name.split(' ').pop()})`,
      badgeClass: 'corr-hedge',
      message: `Offensive distribution hedge: Active ${compSide} on ${competing.player_name} (${row.team})`,
      dismissKey: correlationKey
    };
  } else {
    return {
      type: 'SCRIPT_CORRELATION',
      isHedge: true,
      competingPlayer: competing.player_name,
      competingSide: compSide,
      team: row.team,
      market,
      badgeText: `⚡ Script (${competing.player_name.split(' ').pop()})`,
      badgeClass: 'corr-hedge',
      message: `Correlated game script: Dual ${compSide} on ${row.team} receivers (${competing.player_name})`,
      dismissKey: correlationKey
    };
  }
}

function getPortfolioCorrelations(portfolio, dismissedSet = new Set()) {
  const byTeamAndMarket = {};
  portfolio.forEach((b) => {
    const k = `${b.team}::${b.market}`;
    if (!byTeamAndMarket[k]) byTeamAndMarket[k] = [];
    byTeamAndMarket[k].push(b);
  });
  const conflicts = [];
  Object.entries(byTeamAndMarket).forEach(([key, bets]) => {
    if (bets.length > 1 && !dismissedSet.has(key)) {
      const [team, market] = key.split('::');
      const hasOver = bets.some((b) => (b.side || 'OVER') === 'OVER');
      const hasUnder = bets.some((b) => (b.side || 'OVER') === 'UNDER');
      const isHedge = hasOver && hasUnder;

      conflicts.push({
        key,
        team,
        market,
        isHedge,
        title: isHedge ? 'Distribution Hedge' : 'Concentrated Volume Risk',
        description: isHedge
          ? `Offensive distribution hedge on <strong>${team}</strong>: Active opposing positions on <em>${bets.map((b) => b.player_name).join(' & ')}</em>.`
          : `Same-team exposure on <strong>${team}</strong>: Multiple receiver positions on <em>${bets.map((b) => b.player_name).join(' & ')}</em>. Results may be correlated by game script and target distribution.`,
        players: bets.map((b) => b.player_name),
        bets
      });
    }
  });
  return conflicts;
}

/* ─── SNIPER RULES & RATE-LIMITING ENGINE ─── */
function evaluateSniperTrigger(quote, sniperConfig, cooldownsNow, nowMs = Date.now()) {
  if (!sniperConfig || !sniperConfig.enabled) return { trigger: false, reason: 'disabled' };
  const minEdge = Number(sniperConfig.minEdge) || 0.15;
  const gateMetOnly = sniperConfig.gateMetOnly !== false;

  const ev = quote.evaluation || {};
  const edge = Number(ev.prob_edge || 0);
  const expectedReturn = Number(ev.expected_return || 0);
  const qualified = !gateMetOnly || (ev.is_qualified && expectedReturn > 0);

  if (edge < minEdge) return { trigger: false, reason: 'edge_below_threshold' };
  if (!qualified) return { trigger: false, reason: 'unqualified_or_negative_ev' };

  const k = `${quote.player_id}::${quote.market}`;
  const lastAlertTime = cooldownsNow[k] || 0;
  if (nowMs - lastAlertTime < 15 * 60 * 1000) {
    return { trigger: false, reason: 'rate_limited_cooldown' };
  }

  // Record cooldown
  cooldownsNow[k] = nowMs;

  return {
    trigger: true,
    alertPayload: {
      playerId: quote.player_id,
      player: quote.player_name,
      team: quote.team,
      side: ev.best_side || 'OVER',
      line: quote.line,
      edge,
      expectedReturn
    }
  };
}

/* ─── TICK DELTA DETECTION ENGINE ─── */
function evaluateTickMove(prev, curQuote, curEv, curEdge) {
  if (!prev) return null;
  const evDelta = curEv - prev.ev;
  const edgeDelta = curEdge - prev.edge;
  const lineDelta = Math.abs(curQuote.line - prev.line);
  const oddsDelta = Math.abs((curQuote.over_odds || 0) - (prev.odds || 0));

  // Filter noisy flicker: must cross meaningful threshold
  const isSignificant = lineDelta >= 0.5 || oddsDelta >= 10 || Math.abs(evDelta) >= 0.015 || Math.abs(edgeDelta) >= 0.015;
  if (!isSignificant) return null;

  if (evDelta > 0.005 || edgeDelta > 0.005) {
    return { dir: 'up', glyph: '▲', evDelta, edgeDelta, lineDelta, oddsDelta };
  } else if (evDelta < -0.005 || edgeDelta < -0.005) {
    return { dir: 'down', glyph: '▼', evDelta, edgeDelta, lineDelta, oddsDelta };
  }
  return null;
}

/* ─── SETTLED-RESULTS EVALUATOR ─── */
function evaluateSettledRowPure(row, side = 'OVER', isYards = true) {
  const actual = Number(isYards ? row.receiving_yards : row.receptions) || 0;
  const line = Number(isYards ? row.fair_line_yards : row.fair_line_rec) || 0;
  const delta = side === 'UNDER' ? +(line - actual).toFixed(1) : +(actual - line).toFixed(1);
  const won = side === 'UNDER' ? (actual < line) : (actual > line);
  const lost = side === 'UNDER' ? (actual > line) : (actual < line);
  const push = actual === line;
  const outcome = won ? 'WON' : lost ? 'LOST' : 'PUSH';
  const outcomeClass = won ? 'settled-won' : lost ? 'settled-lost' : 'settled-push';
  return { actual, line, delta, outcome, outcomeClass, isYards, side };
}

/* ─── SPARKLINE FORMATTING ─── */
function formatSparklineLabel(openVal, curVal) {
  const delta = +(curVal - openVal).toFixed(1);
  const deltaStr = `${delta > 0 ? '+' : ''}${delta.toFixed(1)}`;
  const ariaLabel = `Line trajectory: opened ${openVal.toFixed(1)}, current ${curVal.toFixed(1)} (${deltaStr} steam)`;
  return { delta, deltaStr, ariaLabel };
}


/* ═══════════════════════════════════════════════════════════════════════════ */
/*                            UNIT TEST CASES                                 */
/* ═══════════════════════════════════════════════════════════════════════════ */

test('correlation engine: Over + Over on same team identifies concentrated exposure risk', () => {
  const state = {
    filters: { market: 'receiving_yards' },
    portfolio: [
      { player_id: 'p1', player_name: 'Khalil Shakir', team: 'BUF', market: 'receiving_yards', side: 'OVER', line: 45.5 }
    ],
    dismissedCorrelations: new Set()
  };

  const incomingRow = { player_id: 'p2', player_display_name: 'Keon Coleman', team: 'BUF' };
  const incomingEval = { side: 'OVER', edge: 0.14 };

  const risk = checkCorrelatedRisk(incomingRow, incomingEval, state);
  assert.ok(risk !== null);
  assert.equal(risk.type, 'SAME_TEAM_EXPOSURE');
  assert.equal(risk.isHedge, false);
  assert.equal(risk.competingPlayer, 'Khalil Shakir');
  assert.equal(risk.badgeText, '⚠️ Same-Team (Shakir)');
  assert.match(risk.message, /Same-team exposure: results may be correlated/);
  // Verify it does NOT claim "cannibalizes reception volume" as absolute fact
  assert.doesNotMatch(risk.message, /cannibalizes/i);
});

test('correlation engine: Over + Under on same team identifies distribution hedge', () => {
  const state = {
    filters: { market: 'receiving_yards' },
    portfolio: [
      { player_id: 'p1', player_name: 'Khalil Shakir', team: 'BUF', market: 'receiving_yards', side: 'OVER', line: 45.5 }
    ],
    dismissedCorrelations: new Set()
  };

  const incomingRow = { player_id: 'p2', player_display_name: 'Keon Coleman', team: 'BUF' };
  const incomingEval = { side: 'UNDER', edge: 0.12 };

  const risk = checkCorrelatedRisk(incomingRow, incomingEval, state);
  assert.ok(risk !== null);
  assert.equal(risk.type, 'DISTRIBUTION_HEDGE');
  assert.equal(risk.isHedge, true);
  assert.equal(risk.badgeText, '⚡ Hedge (Shakir)');
  assert.match(risk.message, /Offensive distribution hedge/);
});

test('correlation engine: players on different teams have zero correlation risk', () => {
  const state = {
    filters: { market: 'receiving_yards' },
    portfolio: [
      { player_id: 'p1', player_name: 'Khalil Shakir', team: 'BUF', market: 'receiving_yards', side: 'OVER', line: 45.5 }
    ],
    dismissedCorrelations: new Set()
  };

  const incomingRow = { player_id: 'p3', player_display_name: 'Travis Kelce', team: 'KC' };
  const incomingEval = { side: 'OVER', edge: 0.15 };

  const risk = checkCorrelatedRisk(incomingRow, incomingEval, state);
  assert.equal(risk, null);
});

test('correlation engine: user dismissals are honored and suppress warning', () => {
  const state = {
    filters: { market: 'receiving_yards' },
    portfolio: [
      { player_id: 'p1', player_name: 'Khalil Shakir', team: 'BUF', market: 'receiving_yards', side: 'OVER', line: 45.5 }
    ],
    dismissedCorrelations: new Set(['BUF::receiving_yards'])
  };

  const incomingRow = { player_id: 'p2', player_display_name: 'Keon Coleman', team: 'BUF' };
  const incomingEval = { side: 'OVER', edge: 0.14 };

  const risk = checkCorrelatedRisk(incomingRow, incomingEval, state);
  assert.equal(risk, null);
});

test('correlation engine: getPortfolioCorrelations separates hedges from concentrated volume risk', () => {
  const portfolio = [
    { player_id: 'p1', player_name: 'Tyreek Hill', team: 'MIA', market: 'receiving_yards', side: 'OVER' },
    { player_id: 'p2', player_name: 'Jaylen Waddle', team: 'MIA', market: 'receiving_yards', side: 'OVER' },
    { player_id: 'p3', player_name: 'A.J. Brown', team: 'PHI', market: 'receiving_yards', side: 'OVER' },
    { player_id: 'p4', player_name: 'DeVonta Smith', team: 'PHI', market: 'receiving_yards', side: 'UNDER' },
  ];

  const conflicts = getPortfolioCorrelations(portfolio);
  assert.equal(conflicts.length, 2);

  const miaConflict = conflicts.find((c) => c.team === 'MIA');
  assert.equal(miaConflict.isHedge, false);
  assert.equal(miaConflict.title, 'Concentrated Volume Risk');

  const phiConflict = conflicts.find((c) => c.team === 'PHI');
  assert.equal(phiConflict.isHedge, true);
  assert.equal(phiConflict.title, 'Distribution Hedge');
});

test('sniper rules: respects edge hurdle thresholds', () => {
  const sniperConfig = { enabled: true, minEdge: 0.15, gateMetOnly: true };
  const cooldowns = {};

  const quoteSub15 = {
    player_id: 'p1', player_name: 'Player 1', market: 'receiving_yards', team: 'BUF', line: 50.5,
    evaluation: { prob_edge: 0.13, expected_return: 0.08, is_qualified: true }
  };
  const res1 = evaluateSniperTrigger(quoteSub15, sniperConfig, cooldowns);
  assert.equal(res1.trigger, false);
  assert.equal(res1.reason, 'edge_below_threshold');

  const quoteOver15 = {
    player_id: 'p2', player_name: 'Player 2', market: 'receiving_yards', team: 'BUF', line: 50.5,
    evaluation: { prob_edge: 0.16, expected_return: 0.10, is_qualified: true, best_side: 'OVER' }
  };
  const res2 = evaluateSniperTrigger(quoteOver15, sniperConfig, cooldowns);
  assert.equal(res2.trigger, true);
  assert.equal(res2.alertPayload.player, 'Player 2');
});

test('sniper rules: gate requirement rejects unverified or negative-EV quotes', () => {
  const sniperConfig = { enabled: true, minEdge: 0.15, gateMetOnly: true };
  const cooldowns = {};

  const quoteUnqualified = {
    player_id: 'p3', player_name: 'Player 3', market: 'receiving_yards', team: 'MIA', line: 40.5,
    evaluation: { prob_edge: 0.18, expected_return: 0.12, is_qualified: false }
  };
  const res = evaluateSniperTrigger(quoteUnqualified, sniperConfig, cooldowns);
  assert.equal(res.trigger, false);
  assert.equal(res.reason, 'unqualified_or_negative_ev');
});

test('sniper rate-limiting: 15-minute cooldown prevents alert flooding on noisy lines', () => {
  const sniperConfig = { enabled: true, minEdge: 0.12, gateMetOnly: false };
  const cooldowns = {};
  const t0 = 10000000;

  const quote = {
    player_id: 'p4', player_name: 'Player 4', market: 'receiving_yards', team: 'DET', line: 62.5,
    evaluation: { prob_edge: 0.14, expected_return: 0.09, is_qualified: true }
  };

  // First tick fires
  const first = evaluateSniperTrigger(quote, sniperConfig, cooldowns, t0);
  assert.equal(first.trigger, true);

  // Second tick at t0 + 5 minutes is blocked
  const second = evaluateSniperTrigger(quote, sniperConfig, cooldowns, t0 + 5 * 60 * 1000);
  assert.equal(second.trigger, false);
  assert.equal(second.reason, 'rate_limited_cooldown');

  // Third tick at t0 + 14.9 minutes is blocked
  const third = evaluateSniperTrigger(quote, sniperConfig, cooldowns, t0 + 14.9 * 60 * 1000);
  assert.equal(third.trigger, false);
  assert.equal(third.reason, 'rate_limited_cooldown');

  // Fourth tick at t0 + 15.1 minutes triggers
  const fourth = evaluateSniperTrigger(quote, sniperConfig, cooldowns, t0 + 15.1 * 60 * 1000);
  assert.equal(fourth.trigger, true);
});

test('tick-delta detection: filters noisy sub-threshold moves and captures meaningful shifts', () => {
  const prev = { line: 55.5, odds: -110, ev: 0.05, edge: 0.08 };

  // Sub-threshold move: 0.1 yd line change, 2 cents odds, 0.002 ev delta -> ignored
  const curSub = { line: 55.6, over_odds: -112 };
  const subResult = evaluateTickMove(prev, curSub, 0.052, 0.082);
  assert.equal(subResult, null, 'Noisy tick flicker should be ignored');

  // Meaningful line move: 0.5 yds with positive EV gain -> up tick
  const curLineShift = { line: 56.0, over_odds: -110 };
  const shiftResult = evaluateTickMove(prev, curLineShift, 0.07, 0.10);
  assert.ok(shiftResult !== null);
  assert.equal(shiftResult.dir, 'up');
  assert.equal(shiftResult.glyph, '▲');

  // Meaningful adverse move: odds drift with negative EV delta -> down tick
  const curAdverse = { line: 55.5, over_odds: -125 };
  const adverseResult = evaluateTickMove(prev, curAdverse, 0.03, 0.06);
  assert.ok(adverseResult !== null);
  assert.equal(adverseResult.dir, 'down');
  assert.equal(adverseResult.glyph, '▼');
});

test('sparklines: formats accessible trajectory labels and standalone steam delta tags', () => {
  const sparkUp = formatSparklineLabel(75.5, 78.5);
  assert.equal(sparkUp.delta, 3.0);
  assert.equal(sparkUp.deltaStr, '+3.0');
  assert.equal(sparkUp.ariaLabel, 'Line trajectory: opened 75.5, current 78.5 (+3.0 steam)');

  const sparkDown = formatSparklineLabel(50.0, 48.5);
  assert.equal(sparkDown.delta, -1.5);
  assert.equal(sparkDown.deltaStr, '-1.5');
  assert.equal(sparkDown.ariaLabel, 'Line trajectory: opened 50.0, current 48.5 (-1.5 steam)');
});

test('settled results evaluator: correctly grades OVER, UNDER, and PUSH with signed deltas', () => {
  // Over bet: actual 72 yds, line 55.5 yds -> WON, delta +16.5 yds
  const overWon = evaluateSettledRowPure({ receiving_yards: 72, fair_line_yards: 55.5 }, 'OVER', true);
  assert.equal(overWon.outcome, 'WON');
  assert.equal(overWon.outcomeClass, 'settled-won');
  assert.equal(overWon.delta, 16.5);

  // Over bet: actual 42 yds, line 55.5 yds -> LOST, delta -13.5 yds
  const overLost = evaluateSettledRowPure({ receiving_yards: 42, fair_line_yards: 55.5 }, 'OVER', true);
  assert.equal(overLost.outcome, 'LOST');
  assert.equal(overLost.outcomeClass, 'settled-lost');
  assert.equal(overLost.delta, -13.5);

  // Under bet: actual 42 yds, line 55.5 yds -> WON, delta +13.5 yds
  const underWon = evaluateSettledRowPure({ receiving_yards: 42, fair_line_yards: 55.5 }, 'UNDER', true);
  assert.equal(underWon.outcome, 'WON');
  assert.equal(underWon.outcomeClass, 'settled-won');
  assert.equal(underWon.delta, 13.5);

  // Under bet: actual 72 yds, line 55.5 yds -> LOST, delta -16.5 yds
  const underLost = evaluateSettledRowPure({ receiving_yards: 72, fair_line_yards: 55.5 }, 'UNDER', true);
  assert.equal(underLost.outcome, 'LOST');
  assert.equal(underLost.outcomeClass, 'settled-lost');
  assert.equal(underLost.delta, -16.5);

  // Push: actual 4.0 rec, line 4.0 rec -> PUSH, delta 0.0
  const pushRec = evaluateSettledRowPure({ receptions: 4, fair_line_rec: 4.0 }, 'OVER', false);
  assert.equal(pushRec.outcome, 'PUSH');
  assert.equal(pushRec.outcomeClass, 'settled-push');
  assert.equal(pushRec.delta, 0.0);
});
