// NFL Receiving Props Agent — Weekly Web App Logic
// Compound NegBin / Gamma Distributional Model Engine & Correlation-Aware SGP Pricer

const MODEL_ALPHA = 0.1097; // NegBin dispersion for receptions
const MODEL_K = 1.555;      // Gamma shape per reception
const W1_BIAS_REC = 0.057;  // Out-of-sample Week 1 bias on P(over)
const W1_BIAS_YDS = 0.088;  // Out-of-sample Week 1 bias on P(over)
const W1_MIN_EDGE = 0.10;   // 10% minimum edge gate for Week 1
const W1_KELLY_CAP = 0.005; // 0.5% max bankroll stake for Week 1

let slateData = [];
let picksData = { picks: [] };
let clvLogData = [];
let currentPosFilter = 'ALL';
let currentTeamFilter = 'ALL';
let currentProjectableOnly = true;
let currentSortCol = 'proj_yards';
let currentSortAsc = false;
let selectedPlayer = null;
let inlinePlayerLines = {}; // Store inline entered lines: { playerId: { market, line, odds } }

// --------------------------------------------------------------------------
// Initialization
// --------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  loadSavedLines();
  await loadData();
  populateTeamFilter();
  renderPicksSection();
  renderSlateTable();
  renderTdPanel();
  populateCalculator();
  loadClvData();
});

// Resilient fetch helper: handles Railway API routes and static Vercel edge deployment cleanly
async function fetchWithFallback(apiPath, staticFallback) {
  try {
    const res = await fetch(apiPath);
    if (res.ok) {
      return await res.json();
    }
  } catch (_) {}
  const fallbackRes = await fetch(staticFallback);
  return await fallbackRes.json();
}

async function loadData() {
  try {
    slateData = await fetchWithFallback('/api/slate', 'slate_projections.json');
  } catch (err) {
    console.error('Failed to load slate data:', err);
    slateData = [];
  }

  // Augment each player with TD probability model
  augmentPlayersWithTdModel();

  try {
    picksData = await fetchWithFallback('/api/picks', 'current_picks.json');
  } catch (err) {
    console.error('Failed to load picks data:', err);
    picksData = { picks: [] };
  }

  updateSummaryStats();
}

function loadSavedLines() {
  try {
    const saved = localStorage.getItem('inline_lines');
    if (saved) inlinePlayerLines = JSON.parse(saved);
  } catch (_) {}
}

function saveLocalLines() {
  try {
    localStorage.setItem('inline_lines', JSON.stringify(inlinePlayerLines));
  } catch (_) {}
}

// --------------------------------------------------------------------------
// Touchdown Side-Model (Empirical Bayesian Shrinkage)
// --------------------------------------------------------------------------

function augmentPlayersWithTdModel() {
  const posMeans = { 'WR': 0.052, 'TE': 0.076, 'RB': 0.038 };
  const M = 25.0; // Shrinkage prior weight
  const avgTotal = 22.0;

  slateData.forEach(p => {
    const pos = p.position || 'WR';
    const posMean = posMeans[pos] || 0.052;
    const tgts = Number(p.targets) || 0;
    const tds = Number(p.receiving_tds) || 0;
    const obsRate = tgts > 0 ? (tds / tgts) : posMean;
    const w = tgts / (tgts + M);
    const regRate = w * obsRate + (1 - w) * posMean;
    const teamTotal = Number(p.implied_team_total) || 22.0;
    const scaledRate = regRate * (teamTotal / avgTotal);
    
    // Projected targets
    const catchRate = Number(p.f_catch_rate) || 0.67;
    const expTgts = Number(p.f_targets) || (Number(p.proj_rec) / Math.max(0.4, catchRate));
    const lambdaTd = expTgts * scaledRate;
    const pTd = 1.0 - Math.exp(-Math.max(0, lambdaTd));

    p.p_td = Math.max(0.01, Math.min(0.95, pTd));
    p.td_tier = p.p_td >= 0.35 ? 1 : (p.p_td >= 0.20 ? 2 : 3);
    p.td_reg_rate = regRate;
    p.td_exp_tgts = expTgts;
    p.td_fair_odds = probToAmerican(p.p_td);
  });
}

function updateSummaryStats() {
  const badge = document.getElementById('picksCountBadge');
  if (badge) badge.textContent = picksData.picks ? picksData.picks.length : 25;

  const projectableCount = slateData.filter(d => !d.excl_reason).length;
  const slateBadge = document.getElementById('slateCountBadge');
  if (slateBadge) slateBadge.textContent = projectableCount || slateData.length;

  const tdBadge = document.getElementById('tdCountBadge');
  if (tdBadge) tdBadge.textContent = projectableCount || slateData.length;

  const showing = document.getElementById('showingCount');
  if (showing) showing.textContent = projectableCount;

  if (slateData.length > 0) {
    const projectable = slateData.filter(d => !d.excl_reason);
    const topYards = [...projectable].sort((a, b) => b.proj_yards - a.proj_yards)[0];
    const topRec = [...projectable].sort((a, b) => b.proj_rec - a.proj_rec)[0];
    const q = projectable.filter(d => d.questionable === 1).length;
    const t1 = projectable.filter(d => d.td_tier === 1).length;

    const tyEl = document.getElementById('topProjYards');
    if (tyEl && topYards) tyEl.textContent = `${topYards.proj_yards.toFixed(1)} (${topYards.player_display_name})`;

    const trEl = document.getElementById('topProjRec');
    if (trEl && topRec) trEl.textContent = `${topRec.proj_rec.toFixed(1)} (${topRec.player_display_name})`;

    const qEl = document.getElementById('qCount');
    if (qEl) qEl.textContent = q;

    const t1El = document.getElementById('tdTier1Count');
    if (t1El) t1El.textContent = t1;
  }
}

function populateTeamFilter() {
  const sel = document.getElementById('teamFilter');
  if (!sel) return;
  const teams = [...new Set(slateData.map(p => p.team).filter(Boolean))].sort();
  sel.innerHTML = `<option value="ALL">All Teams (${teams.length})</option>` +
    teams.map(t => `<option value="${t}">${t}</option>`).join('');
}

// --------------------------------------------------------------------------
// Navigation & Tab Switcher
// --------------------------------------------------------------------------

function setTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.content-section').forEach(sec => sec.classList.remove('active'));

  const tabBtn = document.getElementById(`tab${tabId.charAt(0).toUpperCase() + tabId.slice(1)}`);
  const sec = document.getElementById(`${tabId}Section`);

  if (tabBtn) tabBtn.classList.add('active');
  if (sec) sec.classList.add('active');

  if (tabId === 'clv') {
    loadClvData();
  }
}

function toggleDetails() {
  const details = document.getElementById('warningDetails');
  const btn = document.getElementById('toggleDetailsBtn');
  if (!details) return;
  if (details.style.display === 'block') {
    details.style.display = 'none';
    if (btn) btn.textContent = 'Details';
  } else {
    details.style.display = 'block';
    if (btn) btn.textContent = 'Hide';
  }
}

// --------------------------------------------------------------------------
// TAB 1: Top Picks Card & Slip Copy
// --------------------------------------------------------------------------

function renderPicksSection() {
  const container = document.getElementById('picksContainer');
  if (!container) return;

  const picks = (picksData && picksData.picks && picksData.picks.length > 0)
    ? picksData.picks
    : slateData.filter(d => !d.excl_reason).slice(0, 25).map((p, idx) => ({
        rank: idx + 1,
        player: p.player_display_name,
        team: p.team,
        opponent: p.opponent_team,
        position: p.position,
        proj_rec: p.proj_rec,
        fair_line_rec: p.fair_line_rec,
        p_rec_at_fair_line: p.p_rec_at_fair_line || 0.5,
        proj_yards: p.proj_yards,
        fair_line_yards: p.fair_line_yards,
        implied_total: p.implied_team_total,
        spread: p.team_spread,
        questionable: p.questionable
      }));

  if (picks.length === 0) {
    container.innerHTML = `<div style="padding:32px; text-align:center; color:var(--text-dim);">No projections available yet. Run the weekly pipeline.</div>`;
    return;
  }

  container.innerHTML = `
    <div style="margin-bottom:16px; background:rgba(18,24,36,0.6); padding:14px; border-radius:8px; border:1px solid var(--border-color); font-size:12px; color:var(--text-muted); line-height:1.6;">
      <strong>Week 1 Market Discipline:</strong> Median fair lines represent 50/50 modeled lines after Week 1 bias adjustment. If your sportsbook offers a receiving yards line <em>below</em> the fair line, it leans <strong>Over</strong>; <em>above</em> leans <strong>Under</strong>. Compare lines in the table below or click <strong>Price</strong> to evaluate live book odds.
    </div>

    <div class="table-container">
      <table class="slate-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Player</th>
            <th>Pos</th>
            <th>Matchup</th>
            <th class="num-col">Fair Line Yds</th>
            <th class="num-col">Proj Yds</th>
            <th class="num-col">Fair Line Rec <span style="font-size:10px; opacity:0.8;">[P(Over)]</span></th>
            <th class="num-col">Proj Rec</th>
            <th class="num-col">Anytime TD</th>
            <th>Implied Total</th>
            <th class="action-col">Action</th>
          </tr>
        </thead>
        <tbody>
          ${picks.map(p => {
            const homeStr = p.is_home === 0 ? '@' : 'vs';
            const recProb = p.p_rec_at_fair_line !== undefined ? ` <span style="font-size:11px; color:var(--text-dim);">(${Math.round(p.p_rec_at_fair_line * 100)}%)</span>` : '';
            const playerObj = slateData.find(x => x.player_display_name === p.player);
            const tdProb = playerObj ? `${Math.round(playerObj.p_td * 100)}%` : '—';
            const tdTierClass = playerObj ? `tier-${playerObj.td_tier}-pill` : 'tier-3-pill';
            const qBadge = p.questionable ? '<span class="q-badge">Q</span>' : '';

            return `
              <tr>
                <td style="font-family:var(--font-mono); color:var(--text-dim); font-weight:700;">#${p.rank}</td>
                <td class="player-name-cell" onclick="openPlayerModalByName('${escape(p.player)}')">
                  <span>${p.player}</span>
                  ${qBadge}
                </td>
                <td><span class="pos-tag pos-${p.position}">${p.position}</span></td>
                <td><span class="matchup-tag">${p.team} <span class="home-indicator">${homeStr}</span> ${p.opponent || 'OPP'}</span></td>
                <td class="num-col fair-val">${Number(p.fair_line_yards).toFixed(1)}</td>
                <td class="num-col highlight-val">${Number(p.proj_yards).toFixed(1)}</td>
                <td class="num-col fair-val">${Number(p.fair_line_rec).toFixed(1)}${recProb}</td>
                <td class="num-col highlight-val">${Number(p.proj_rec).toFixed(1)}</td>
                <td class="num-col"><span class="tier-pill ${tdTierClass}" title="Anytime TD Probability">${tdProb}</span></td>
                <td class="game-context-cell">${p.implied_total !== undefined ? Number(p.implied_total).toFixed(1) + ' pts' : '—'}</td>
                <td class="action-col">
                  <button class="action-btn" onclick="openCalculatorForName('${escape(p.player)}')">Price</button>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function copyPicksAsText() {
  const picks = (picksData && picksData.picks && picksData.picks.length > 0)
    ? picksData.picks
    : slateData.filter(d => !d.excl_reason).slice(0, 25);

  if (picks.length === 0) {
    showToast('No picks available to copy.');
    return;
  }

  let text = `🏈 NFL Week 1 Top Receiving Props & Fair Lines\n`;
  text += `========================================================\n`;
  picks.slice(0, 25).forEach((p, i) => {
    const rank = p.rank || (i + 1);
    const player = p.player || p.player_display_name;
    const team = p.team;
    const opp = p.opponent || p.opponent_team;
    const fairYds = Number(p.fair_line_yards).toFixed(1);
    const projYds = Number(p.proj_yards).toFixed(1);
    const fairRec = Number(p.fair_line_rec).toFixed(1);
    const projRec = Number(p.proj_rec).toFixed(1);
    const q = p.questionable ? ' [Q]' : '';

    text += `#${rank} ${player} (${p.position}, ${team} vs ${opp})${q}\n`;
    text += `   Yards Fair Line: ${fairYds} (Proj: ${projYds}) | Rec Fair Line: ${fairRec} (Proj: ${projRec})\n`;
  });
  text += `========================================================\n`;
  text += `Model: Compound NegBin/Gamma | W1 Gate: 10.0% | Max Kelly: 0.50%\n`;
  text += `Disclaimer: Statistical estimates for research. Not financial advice. 21+\n`;

  navigator.clipboard.writeText(text).then(() => {
    showToast(`✓ Copied ${picks.length} picks formatted for betting slips!`);
  }).catch(() => {
    showToast('Failed to copy to clipboard.');
  });
}

// --------------------------------------------------------------------------
// TAB 2: Slate Browser & Inline Fair-Line Comparison Tool
// --------------------------------------------------------------------------

function setPosFilter(pos) {
  currentPosFilter = pos;
  document.querySelectorAll('.pos-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.pos === pos);
  });
  renderSlateTable();
}

function filterData() {
  const q = (document.getElementById('searchInput').value || '').trim();
  const clearBtn = document.getElementById('clearSearchBtn');
  if (clearBtn) clearBtn.style.display = q.length > 0 ? 'block' : 'none';

  const teamSel = document.getElementById('teamFilter');
  if (teamSel) currentTeamFilter = teamSel.value;

  const pToggle = document.getElementById('projectableToggle');
  if (pToggle) currentProjectableOnly = pToggle.checked;

  renderSlateTable();
}

function clearSearch() {
  const input = document.getElementById('searchInput');
  if (input) input.value = '';
  document.getElementById('clearSearchBtn').style.display = 'none';
  renderSlateTable();
}

function sortBy(col) {
  if (currentSortCol === col) {
    currentSortAsc = !currentSortAsc;
  } else {
    currentSortCol = col;
    currentSortAsc = (col === 'player_display_name' || col === 'team');
  }
  updateSortArrows();
  renderSlateTable();
}

function updateSortArrows() {
  const cols = ['player_display_name', 'proj_rec', 'fair_line_rec', 'proj_yards', 'fair_line_yards', 'p_td'];
  cols.forEach(c => {
    const el = document.getElementById(`sort-${c}`);
    if (el) {
      el.textContent = (c === currentSortCol) ? (currentSortAsc ? '▲' : '▼') : '';
    }
  });
}

function renderSlateTable() {
  const tbody = document.getElementById('slateTbody');
  if (!tbody) return;

  const q = (document.getElementById('searchInput').value || '').toLowerCase().trim();

  let filtered = slateData.filter(row => {
    // Projectable only filter
    if (currentProjectableOnly && row.excl_reason) return false;

    // Team filter
    if (currentTeamFilter !== 'ALL' && row.team !== currentTeamFilter) return false;

    // Position filter
    if (currentPosFilter === 'TOP25') {
      const top25Ids = new Set([...slateData]
        .filter(x => !x.excl_reason)
        .sort((a, b) => b.proj_yards - a.proj_yards)
        .slice(0, 25)
        .map(x => x.player_id));
      if (!top25Ids.has(row.player_id)) return false;
    } else if (currentPosFilter !== 'ALL' && row.position !== currentPosFilter) {
      return false;
    }

    // Search query
    if (q) {
      const p = (row.player_display_name || '').toLowerCase();
      const t = (row.team || '').toLowerCase();
      const opp = (row.opponent_team || '').toLowerCase();
      if (!p.includes(q) && !t.includes(q) && !opp.includes(q)) return false;
    }
    return true;
  });

  // Sort
  filtered.sort((a, b) => {
    let vA = a[currentSortCol];
    let vB = b[currentSortCol];
    if (typeof vA === 'string') {
      return currentSortAsc ? vA.localeCompare(vB) : vB.localeCompare(vA);
    }
    vA = Number(vA) || 0;
    vB = Number(vB) || 0;
    return currentSortAsc ? (vA - vB) : (vB - vA);
  });

  const showingEl = document.getElementById('showingCount');
  if (showingEl) showingEl.textContent = filtered.length;

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="10" style="text-align:center; padding:36px; color:var(--text-dim);">
          No receivers found matching active filters.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map(row => {
    const qBadge = row.questionable ? `<span class="q-badge" title="Questionable">Q</span>` : '';
    const exclBadge = row.excl_reason ? `<span class="excl-badge" title="${row.excl_reason}">${row.excl_reason}</span>` : '';
    const posTag = `<span class="pos-tag pos-${row.position}">${row.position}</span>`;
    const homeStr = row.is_home === 0 ? '@' : 'vs';
    const matchup = `<span class="matchup-tag">${row.team} <span class="home-indicator">${homeStr}</span> ${row.opponent_team}</span>`;
    
    // TD pill
    const tdProb = Math.round((row.p_td || 0) * 100);
    const tdTierClass = `tier-${row.td_tier || 3}-pill`;

    // Inline line comparison values
    const playerKey = row.player_id;
    const storedComp = inlinePlayerLines[playerKey] || {
      market: 'yards',
      line: row.fair_line_yards,
      odds: -115
    };

    const compResult = evaluateInlineEdge(row, storedComp.market, storedComp.line, storedComp.odds);

    return `
      <tr id="row-${row.player_id}">
        <td class="player-name-cell" onclick="openPlayerModal('${escape(row.player_id)}')">
          <span>${row.player_display_name}</span>
          ${qBadge}
          ${exclBadge}
        </td>
        <td>${posTag}</td>
        <td>${matchup}</td>
        <td class="num-col highlight-val">${Number(row.proj_rec).toFixed(1)}</td>
        <td class="num-col fair-val">
          ${Number(row.fair_line_rec).toFixed(1)}
          <span style="font-size:10px; color:var(--text-dim);">(${Math.round((row.p_rec_at_fair_line || 0.5) * 100)}%)</span>
        </td>
        <td class="num-col highlight-val">${Number(row.proj_yards).toFixed(1)}</td>
        <td class="num-col fair-val">${Number(row.fair_line_yards).toFixed(1)}</td>
        <td class="num-col">
          <span class="tier-pill ${tdTierClass}" title="Anytime TD Probability">${tdProb}%</span>
        </td>
        <td class="comparison-col">
          <div class="inline-comp-tool">
            <div class="comp-input-group">
              <select class="comp-market-sel" onchange="onInlineMarketChange('${escape(row.player_id)}', this.value)">
                <option value="yards" ${storedComp.market === 'yards' ? 'selected' : ''}>Yds</option>
                <option value="rec" ${storedComp.market === 'rec' ? 'selected' : ''}>Rec</option>
              </select>
              <input type="number" step="0.5" class="comp-line-input" value="${storedComp.line}" 
                     title="Enter Book Line" 
                     oninput="onInlineLineInput('${escape(row.player_id)}', this.value)">
            </div>
            <div id="comp-badge-${row.player_id}">
              ${renderInlineBadgeHtml(compResult)}
            </div>
          </div>
          <div class="quick-adjust-bar">
            <button class="quick-chip" onclick="applyQuickAdjust('${escape(row.player_id)}', -5)">-5</button>
            <button class="quick-chip" onclick="applyQuickAdjust('${escape(row.player_id)}', -2.5)">-2.5</button>
            <button class="quick-chip quick-chip-fair" onclick="applyQuickAdjust('${escape(row.player_id)}', 0)">Fair</button>
            <button class="quick-chip" onclick="applyQuickAdjust('${escape(row.player_id)}', 2.5)">+2.5</button>
            <button class="quick-chip" onclick="applyQuickAdjust('${escape(row.player_id)}', 5)">+5</button>
          </div>
        </td>
        <td class="action-col">
          <button class="action-btn" onclick="openPlayerModal('${escape(row.player_id)}')">Detail</button>
        </td>
      </tr>
    `;
  }).join('');
}

function applyQuickAdjust(escapedId, offset) {
  const id = unescape(escapedId);
  const player = slateData.find(p => p.player_id === id);
  if (!player) return;

  const current = inlinePlayerLines[id] || { market: 'yards', line: player.fair_line_yards, odds: -115 };
  const baseFair = current.market === 'rec' ? player.fair_line_rec : player.fair_line_yards;
  current.line = offset === 0 ? baseFair : Math.max(0.5, baseFair + offset);
  inlinePlayerLines[id] = current;
  saveLocalLines();
  renderSlateTable();
}

// Inline line comparison evaluator
function evaluateInlineEdge(player, market, lineVal, oddsVal = -115) {
  const line = parseFloat(lineVal);
  if (isNaN(line) || line <= 0) return { status: 'neutral', label: 'Enter Line' };

  let rawPOver = 0;
  let bias = 0;
  if (market === 'rec') {
    rawPOver = pRecOver(player.mu_rec, line);
    bias = W1_BIAS_REC;
  } else {
    rawPOver = pYardsOver(player.mu_rec, player.mu_ypr, line);
    bias = W1_BIAS_YDS;
  }

  const modelPOver = Math.max(0.01, Math.min(0.99, rawPOver - bias));
  const modelPUnder = 1.0 - modelPOver;

  // De-vig market prob assuming standard line juice
  const dec = americanToDecimal(oddsVal);
  const mktP = (1 / dec) / (2 * (1 / dec)); // ~50%
  
  const edgeOver = modelPOver - mktP;
  const edgeUnder = modelPUnder - mktP;

  const bestSide = edgeOver >= edgeUnder ? 'OVER' : 'UNDER';
  const bestEdge = Math.max(edgeOver, edgeUnder);
  const bestModelP = bestSide === 'OVER' ? modelPOver : modelPUnder;

  const b = dec - 1;
  const ev = bestModelP * b - (1 - bestModelP);
  const kelly = ev > 0 ? Math.min(W1_KELLY_CAP, (b * bestModelP - (1 - bestModelP)) / b) : 0;

  if (bestEdge >= W1_MIN_EDGE && ev > 0) {
    return {
      status: 'green',
      side: bestSide,
      edge: bestEdge,
      ev: ev,
      kelly: kelly,
      p: bestModelP
    };
  } else if (bestEdge > 0) {
    return {
      status: 'amber',
      side: bestSide,
      edge: bestEdge,
      ev: ev,
      kelly: kelly,
      p: bestModelP
    };
  } else {
    return {
      status: 'red',
      side: bestSide,
      edge: bestEdge,
      ev: ev,
      kelly: 0,
      p: bestModelP
    };
  }
}

function renderInlineBadgeHtml(res) {
  if (res.status === 'neutral') {
    return `<div class="comp-edge-badge comp-badge-neutral"><span>Fair Line</span></div>`;
  }
  if (res.status === 'green') {
    return `
      <div class="comp-edge-badge comp-badge-green" title="Model probability: ${(res.p * 100).toFixed(1)}% | Edge clears Week 1 gate">
        <span>${res.side} +${(res.edge * 100).toFixed(1)}%</span>
        <span class="comp-ev-sub">EV +${(res.ev * 100).toFixed(1)}% &bull; ${(res.kelly * 100).toFixed(2)}% Kelly</span>
      </div>
    `;
  }
  if (res.status === 'amber') {
    return `
      <div class="comp-edge-badge comp-badge-amber" title="Positive edge but below 10% Week 1 gate">
        <span>${res.side} +${(res.edge * 100).toFixed(1)}%</span>
        <span class="comp-ev-sub">Below Gate &bull; Lean</span>
      </div>
    `;
  }
  return `
    <div class="comp-edge-badge comp-badge-red" title="No edge vs market">
      <span>Sharp (${(res.edge * 100).toFixed(1)}%)</span>
      <span class="comp-ev-sub">No Play</span>
    </div>
  `;
}

function onInlineMarketChange(escapedId, market) {
  const id = unescape(escapedId);
  const player = slateData.find(p => p.player_id === id);
  if (!player) return;

  const current = inlinePlayerLines[id] || {};
  current.market = market;
  current.line = market === 'rec' ? player.fair_line_rec : player.fair_line_yards;
  inlinePlayerLines[id] = current;
  saveLocalLines();
  renderSlateTable();
}

function onInlineLineInput(escapedId, lineVal) {
  const id = unescape(escapedId);
  const player = slateData.find(p => p.player_id === id);
  if (!player) return;

  const current = inlinePlayerLines[id] || { market: 'yards', line: player.fair_line_yards, odds: -115 };
  current.line = parseFloat(lineVal) || 0;
  inlinePlayerLines[id] = current;
  saveLocalLines();

  const badgeEl = document.getElementById(`comp-badge-${id}`);
  if (badgeEl) {
    const res = evaluateInlineEdge(player, current.market, current.line, current.odds);
    badgeEl.innerHTML = renderInlineBadgeHtml(res);
  }
}

// --------------------------------------------------------------------------
// TAB 3: Touchdown Props Panel
// --------------------------------------------------------------------------

function renderTdPanel() {
  const summaryEl = document.getElementById('tdTierSummary');
  const tbody = document.getElementById('tdTbody');
  if (!summaryEl || !tbody) return;

  const projectable = slateData.filter(d => !d.excl_reason);
  const sorted = [...projectable].sort((a, b) => b.p_td - a.p_td);

  const t1 = sorted.filter(p => p.td_tier === 1);
  const t2 = sorted.filter(p => p.td_tier === 2);
  const t3 = sorted.filter(p => p.td_tier === 3);

  summaryEl.innerHTML = `
    <div class="td-tier-card">
      <div class="td-tier-title">
        <span class="tier-pill tier-1-pill">Tier 1 &bull; High Probability (&ge;35%)</span>
        <span style="font-weight:800; color:var(--accent-green); font-family:var(--font-mono);">${t1.length} Plays</span>
      </div>
      <p style="font-size:12px; color:var(--text-muted); line-height:1.5;">
        Red-zone primary targets in elevated implied team totals (Avg Total: ${(t1.reduce((s, x) => s + (x.implied_team_total || 22), 0) / Math.max(1, t1.length)).toFixed(1)} pts).
      </p>
    </div>
    <div class="td-tier-card">
      <div class="td-tier-title">
        <span class="tier-pill tier-2-pill">Tier 2 &bull; Moderate Value (20&ndash;35%)</span>
        <span style="font-weight:800; color:var(--accent-purple); font-family:var(--font-mono);">${t2.length} Plays</span>
      </div>
      <p style="font-size:12px; color:var(--text-muted); line-height:1.5;">
        Secondary WRs &amp; starting TEs with consistent end-zone share.
      </p>
    </div>
    <div class="td-tier-card">
      <div class="td-tier-title">
        <span class="tier-pill tier-3-pill">Tier 3 &bull; Longshots (&lt;20%)</span>
        <span style="font-weight:800; color:var(--text-dim); font-family:var(--font-mono);">${t3.length} Plays</span>
      </div>
      <p style="font-size:12px; color:var(--text-muted); line-height:1.5;">
        Deep rotational depth requiring big-play scores or multi-touchdown game script.
      </p>
    </div>
  `;

  tbody.innerHTML = sorted.map((p, idx) => {
    const homeStr = p.is_home === 0 ? '@' : 'vs';
    const tierPill = `<span class="tier-pill tier-${p.td_tier}-pill">Tier ${p.td_tier}</span>`;
    const tdProb = (p.p_td * 100).toFixed(1) + '%';
    const fairOdds = p.td_fair_odds > 0 ? `+${p.td_fair_odds}` : `${p.td_fair_odds}`;

    return `
      <tr>
        <td style="font-family:var(--font-mono); color:var(--text-dim); font-weight:700;">#${idx + 1}</td>
        <td class="player-name-cell" onclick="openPlayerModal('${escape(p.player_id)}')">
          <span>${p.player_display_name}</span>
          ${p.questionable ? '<span class="q-badge">Q</span>' : ''}
        </td>
        <td><span class="pos-tag pos-${p.position}">${p.position}</span></td>
        <td><span class="matchup-tag">${p.team} <span class="home-indicator">${homeStr}</span> ${p.opponent_team}</span></td>
        <td class="num-col">${Number(p.implied_team_total).toFixed(1)}</td>
        <td class="num-col">${Number(p.td_exp_tgts).toFixed(1)}</td>
        <td class="num-col">${p.receiving_tds || 0} (${p.targets || 0})</td>
        <td class="num-col">${(p.td_reg_rate * 100).toFixed(1)}%</td>
        <td class="num-col highlight-val" style="color:var(--accent-green);">${tdProb}</td>
        <td class="num-col fair-val">${fairOdds}</td>
        <td>${tierPill}</td>
        <td class="action-col">
          <button class="action-btn" onclick="openPlayerModal('${escape(p.player_id)}')">Detail</button>
        </td>
      </tr>
    `;
  }).join('');
}

// --------------------------------------------------------------------------
// TAB 4: Prop Pricing Calculator, Distribution Visualizer, & SGP
// --------------------------------------------------------------------------

function populateCalculator() {
  const select = document.getElementById('calcPlayerSelect');
  if (!select || slateData.length === 0) return;

  const projectable = slateData.filter(d => !d.excl_reason);
  select.innerHTML = projectable.map(p => `
    <option value="${p.player_id}">${p.player_display_name} (${p.position} - ${p.team})</option>
  `).join('');

  if (projectable.length > 0) {
    select.value = projectable[0].player_id;
    selectedPlayer = projectable[0];
    updatePlayerContext();
    calculateEdge();
  }
}

function openCalculatorFor(escapedPlayerId) {
  const playerId = unescape(escapedPlayerId);
  const player = slateData.find(p => p.player_id === playerId);
  if (!player) return;

  setTab('calc');
  const select = document.getElementById('calcPlayerSelect');
  if (select) {
    select.value = playerId;
    selectedPlayer = player;
    const lineInput = document.getElementById('calcLine');
    const marketSelect = document.getElementById('calcMarket');
    if (marketSelect.value === 'receptions') {
      lineInput.value = player.fair_line_rec;
    } else {
      lineInput.value = player.fair_line_yards;
    }
    updatePlayerContext();
    calculateEdge();
  }
}

function openCalculatorForName(escapedName) {
  const name = unescape(escapedName);
  const player = slateData.find(p => p.player_display_name === name);
  if (player) openCalculatorFor(escape(player.player_id));
}

function onPlayerSelectChange() {
  const select = document.getElementById('calcPlayerSelect');
  selectedPlayer = slateData.find(p => p.player_id === select.value);
  const lineInput = document.getElementById('calcLine');
  const marketSelect = document.getElementById('calcMarket');
  if (selectedPlayer && lineInput && marketSelect) {
    if (marketSelect.value === 'receptions') {
      lineInput.value = selectedPlayer.fair_line_rec;
    } else {
      lineInput.value = selectedPlayer.fair_line_yards;
    }
  }
  updatePlayerContext();
  calculateEdge();
}

function updatePlayerContext() {
  const ctxBox = document.getElementById('calcPlayerContext');
  if (!ctxBox || !selectedPlayer) return;

  const qWarning = selectedPlayer.questionable ? `
    <div style="margin-top:8px; padding:6px 10px; background:rgba(245,158,11,0.15); border:1px solid rgba(245,158,11,0.4); border-radius:6px; color:#f59e0b; font-size:11px; font-weight:600;">
      ⚠️ QUESTIONABLE INJURY STATUS: In-game reinjury or snap truncation risk cannot be priced by the model. Apply manual discount or reduce stake.
    </div>
  ` : '';

  ctxBox.innerHTML = `
    <strong>${selectedPlayer.player_display_name}</strong> &bull; ${selectedPlayer.position} &bull; ${selectedPlayer.team} vs ${selectedPlayer.opponent_team}<br>
    Model Mu (Rec): <strong>${Number(selectedPlayer.mu_rec).toFixed(2)}</strong> &bull; Mu (YPR): <strong>${Number(selectedPlayer.mu_ypr).toFixed(2)}</strong><br>
    Projection: <strong>${Number(selectedPlayer.proj_rec).toFixed(1)} rec</strong> / <strong>${Number(selectedPlayer.proj_yards).toFixed(1)} yds</strong><br>
    Model Fair Line (50/50): <strong>${Number(selectedPlayer.fair_line_rec).toFixed(1)} rec</strong> / <strong>${Number(selectedPlayer.fair_line_yards).toFixed(1)} yds</strong><br>
    Implied Team Total: <strong>${Number(selectedPlayer.implied_team_total).toFixed(1)}</strong> &bull; Anytime TD Prob: <strong>${Math.round(selectedPlayer.p_td * 100)}%</strong>
    ${qWarning}
  `;
}

function calculateEdge() {
  if (!selectedPlayer) return;
  const market = document.getElementById('calcMarket').value;
  const line = parseFloat(document.getElementById('calcLine').value) || 0;
  const overOdds = parseFloat(document.getElementById('calcOverOdds').value) || -110;
  const underOdds = parseFloat(document.getElementById('calcUnderOdds').value) || -110;

  let rawPOver = 0;
  let bias = 0;
  if (market === 'receptions') {
    rawPOver = pRecOver(selectedPlayer.mu_rec, line);
    bias = W1_BIAS_REC;
  } else {
    rawPOver = pYardsOver(selectedPlayer.mu_rec, selectedPlayer.mu_ypr, line);
    bias = W1_BIAS_YDS;
  }

  const modelPOver = Math.max(0.01, Math.min(0.99, rawPOver - bias));
  const modelPUnder = 1.0 - modelPOver;

  const decOver = americanToDecimal(overOdds);
  const decUnder = americanToDecimal(underOdds);
  const rawMktOver = 1 / decOver;
  const rawMktUnder = 1 / decUnder;
  const vigSum = rawMktOver + rawMktUnder;
  const devigMktOver = rawMktOver / vigSum;
  const devigMktUnder = rawMktUnder / vigSum;

  const edgeOver = modelPOver - devigMktOver;
  const evOver = modelPOver * (decOver - 1) - (1 - modelPOver);
  let kellyOver = 0;
  if (evOver > 0) {
    const b = decOver - 1;
    kellyOver = Math.min(W1_KELLY_CAP, (b * modelPOver - (1 - modelPOver)) / b);
  }

  const edgeUnder = modelPUnder - devigMktUnder;
  const evUnder = modelPUnder * (decUnder - 1) - (1 - modelPUnder);
  let kellyUnder = 0;
  if (evUnder > 0) {
    const b = decUnder - 1;
    kellyUnder = Math.min(W1_KELLY_CAP, (b * modelPUnder - (1 - modelPUnder)) / b);
  }

  let bestSide = 'OVER';
  let bestEdge = edgeOver;
  let bestEv = evOver;
  let bestKelly = kellyOver;
  let bestModelP = modelPOver;
  let bestMktP = devigMktOver;
  let bestOdds = overOdds;

  if (edgeUnder > edgeOver) {
    bestSide = 'UNDER';
    bestEdge = edgeUnder;
    bestEv = evUnder;
    bestKelly = kellyUnder;
    bestModelP = modelPUnder;
    bestMktP = devigMktUnder;
    bestOdds = underOdds;
  }

  const clearsGate = bestEdge >= W1_MIN_EDGE && bestEv > 0;
  renderCalcResults({
    market,
    line,
    rawPOver,
    bias,
    modelPOver,
    modelPUnder,
    devigMktOver,
    devigMktUnder,
    bestSide,
    bestEdge,
    bestEv,
    bestKelly,
    bestModelP,
    bestMktP,
    bestOdds,
    clearsGate
  });

  drawDistributionSvg(selectedPlayer, market, line);
}

function renderCalcResults(res) {
  const resContainer = document.getElementById('calcResults');
  if (!resContainer) return;

  const verdictClass = res.clearsGate ? 'verdict-bet' : 'verdict-pass';
  const verdictText = res.clearsGate
    ? `BET ${res.bestSide} &bull; +${(res.bestEdge * 100).toFixed(1)}% EDGE`
    : `PASS &bull; EDGE UNDER 10% GATE`;

  resContainer.innerHTML = `
    <div class="result-card">
      <div class="result-verdict">
        <div>
          <span style="font-size:11px; font-family:var(--font-mono); color:var(--text-dim);">WEEK 1 VERDICT</span>
          <h4 style="font-size:16px; margin-top:2px;">${selectedPlayer.player_display_name} ${res.line} ${res.market.replace('_', ' ')}</h4>
        </div>
        <span class="verdict-badge ${verdictClass}">${verdictText}</span>
      </div>

      <div class="stat-grid-2">
        <div class="metric-box">
          <div class="metric-label">MODEL PROB (${res.bestSide})</div>
          <div class="metric-value">${(res.bestModelP * 100).toFixed(1)}%</div>
          <div style="font-size:10px; color:var(--text-dim); margin-top:2px;">Raw: ${(res.bestSide === 'OVER' ? res.rawPOver : 1 - res.rawPOver) * 100 | 0}% &bull; Bias: -${(res.bias * 100).toFixed(1)}%</div>
        </div>

        <div class="metric-box">
          <div class="metric-label">DE-VIG MARKET PROB</div>
          <div class="metric-value">${(res.bestMktP * 100).toFixed(1)}%</div>
          <div style="font-size:10px; color:var(--text-dim); margin-top:2px;">At line ${res.line} (${res.bestOdds > 0 ? '+' : ''}${res.bestOdds})</div>
        </div>

        <div class="metric-box">
          <div class="metric-label">MODEL EDGE</div>
          <div class="metric-value ${res.bestEdge >= W1_MIN_EDGE ? 'val-green' : (res.bestEdge > 0 ? 'val-amber' : 'val-red')}">
            ${res.bestEdge > 0 ? '+' : ''}${(res.bestEdge * 100).toFixed(1)}%
          </div>
          <div style="font-size:10px; color:var(--text-dim); margin-top:2px;">Gate: 10.0%</div>
        </div>

        <div class="metric-box">
          <div class="metric-label">KELLY STAKE</div>
          <div class="metric-value ${res.bestKelly > 0 ? 'val-green' : ''}">
            ${res.bestKelly > 0 ? (res.bestKelly * 100).toFixed(2) + '%' : '0.00%'}
          </div>
          <div style="font-size:10px; color:var(--text-dim); margin-top:2px;">Week 1 Cap: 0.50%</div>
        </div>
      </div>

      <div class="ev-note">
        <strong>Distribution Breakdown:</strong> The compound NegBin/Gamma assigns <strong>${(res.modelPOver * 100).toFixed(1)}%</strong> to the OVER and <strong>${(res.modelPUnder * 100).toFixed(1)}%</strong> to the UNDER after subtracting the <strong>${(res.bias * 100).toFixed(1)}pp</strong> empirical Week 1 bias correction.
        ${!res.clearsGate ? `<br><br><span style="color:var(--accent-amber);">⚠️ Note: Week 1 calibration error is 3–5%. A ${res.bestEdge > 0 ? '+' + (res.bestEdge * 100).toFixed(1) + '%' : (res.bestEdge * 100).toFixed(1) + '%'} edge does not clear the 10% threshold required to exceed model noise.</span>` : ''}
      </div>
    </div>
  `;
}

// Visual Probability Density SVG Generator
function drawDistributionSvg(player, market, bookLine) {
  const container = document.getElementById('distChartContainer');
  if (!container) return;

  const w = container.clientWidth || 600;
  const h = 200;
  const pad = { left: 40, right: 30, top: 20, bottom: 30 };

  const fairLine = market === 'receptions' ? player.fair_line_rec : player.fair_line_yards;
  const maxVal = market === 'receptions' ? Math.max(14, fairLine * 2.2) : Math.max(160, fairLine * 2.4);

  // Generate density points
  const points = [];
  const steps = 120;
  let maxDensity = 0;

  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * maxVal;
    let d = 0;
    if (market === 'receptions') {
      // NegBin PMF approximation
      const r = 1.0 / MODEL_ALPHA;
      const p = r / (r + player.mu_rec);
      const k = Math.round(x);
      d = Math.pow(p, r) * Math.pow(1 - p, k) * (gammaRatio(k + r, r) / factorial(k));
    } else {
      // Compound Gamma density approximation
      const k = MODEL_K * (player.mu_rec || 4.0);
      const theta = (player.mu_ypr || 12.0) / MODEL_K;
      if (x > 0 && k > 0) {
        d = (1 / (Math.exp(logGamma(k)) * Math.pow(theta, k))) * Math.pow(x, k - 1) * Math.exp(-x / theta);
      }
    }
    if (isNaN(d) || !isFinite(d)) d = 0;
    maxDensity = Math.max(maxDensity, d);
    points.push({ x, y: d });
  }

  if (maxDensity <= 0) maxDensity = 1.0;

  // Scale functions
  const scaleX = val => pad.left + (val / maxVal) * (w - pad.left - pad.right);
  const scaleY = val => h - pad.bottom - (val / maxDensity) * (h - pad.top - pad.bottom);

  // Build SVG path
  let pathD = `M ${scaleX(points[0].x)} ${scaleY(points[0].y)}`;
  for (let i = 1; i < points.length; i++) {
    pathD += ` L ${scaleX(points[i].x)} ${scaleY(points[i].y)}`;
  }

  // Shaded tail area for x >= bookLine
  const tailPoints = points.filter(pt => pt.x >= bookLine);
  let tailPathD = '';
  if (tailPoints.length > 0) {
    tailPathD = `M ${scaleX(bookLine)} ${scaleY(0)}`;
    tailPathD += ` L ${scaleX(bookLine)} ${scaleY(tailPoints[0].y)}`;
    tailPoints.forEach(pt => {
      tailPathD += ` L ${scaleX(pt.x)} ${scaleY(pt.y)}`;
    });
    tailPathD += ` L ${scaleX(maxVal)} ${scaleY(0)} Z`;
  }

  const fairLineX = scaleX(fairLine);
  const bookLineX = scaleX(bookLine);

  container.innerHTML = `
    <svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="tailGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.45"/>
          <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.05"/>
        </linearGradient>
      </defs>
      <!-- Base Axis -->
      <line x1="${pad.left}" y1="${h - pad.bottom}" x2="${w - pad.right}" y2="${h - pad.bottom}" stroke="#222d42" stroke-width="1"/>
      
      <!-- Shaded Over Tail -->
      ${tailPathD ? `<path d="${tailPathD}" fill="url(#tailGrad)"/>` : ''}

      <!-- Main Density Curve -->
      <path d="${pathD}" fill="none" stroke="#38bdf8" stroke-width="2.2" stroke-linecap="round"/>

      <!-- Fair Line (Median) -->
      <line x1="${fairLineX}" y1="${pad.top}" x2="${fairLineX}" y2="${h - pad.bottom}" stroke="#38bdf8" stroke-width="2" stroke-dasharray="4,4"/>
      <text x="${fairLineX}" y="${pad.top - 4}" fill="#38bdf8" font-size="10" font-family="monospace" text-anchor="middle" font-weight="700">Fair: ${fairLine}</text>

      <!-- Book Line -->
      <line x1="${bookLineX}" y1="${pad.top + 10}" x2="${bookLineX}" y2="${h - pad.bottom}" stroke="#ef4444" stroke-width="2"/>
      <text x="${bookLineX}" y="${h - pad.bottom + 18}" fill="#ef4444" font-size="10" font-family="monospace" text-anchor="middle" font-weight="700">Book: ${bookLine}</text>
    </svg>
  `;
}

function gammaRatio(a, b) {
  return Math.exp(logGamma(a) - logGamma(b));
}

function factorial(n) {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}

// Correlation-Aware Same-Game Parlay (SGP) Simulator (src/parlay.py)
function evaluateCurrentPlayerSgp() {
  if (!selectedPlayer) return;
  const container = document.getElementById('sgpResultsContainer');
  if (!container) return;

  const muRec = selectedPlayer.mu_rec;
  const muYpr = selectedPlayer.mu_ypr;
  const fairRec = selectedPlayer.fair_line_rec;
  const fairYds = selectedPlayer.fair_line_yards;

  const nSims = 40000;
  const r = 1.0 / MODEL_ALPHA;
  const p = r / (r + muRec);
  const scale = muYpr / MODEL_K;

  let overRecCount = 0;
  let overYdsCount = 0;
  let jointOverCount = 0;

  for (let i = 0; i < nSims; i++) {
    // NegBin random draw
    const lambda = sampleGamma(r, (1 - p) / p);
    const n = samplePoisson(lambda);
    let y = 0;
    if (n > 0) {
      y = sampleGamma(n * MODEL_K, scale);
    }

    const isOverRec = n > fairRec;
    const isOverYds = y > fairYds;

    if (isOverRec) overRecCount++;
    if (isOverYds) overYdsCount++;
    if (isOverRec && isOverYds) jointOverCount++;
  }

  const pRec = overRecCount / nSims;
  const pYds = overYdsCount / nSims;
  const pJoint = jointOverCount / nSims;
  const pIndep = pRec * pYds;
  const correlationLift = pIndep > 0 ? (pJoint / pIndep - 1.0) : 0;
  const fairAmerican = probToAmerican(pJoint);

  container.innerHTML = `
    <div style="background:var(--bg-card); border:1px solid var(--border-color); border-radius:8px; padding:16px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
        <h5 style="color:#fff; font-size:14px;">${selectedPlayer.player_display_name} SGP: Over ${fairRec} Rec + Over ${fairYds} Yds</h5>
        <span class="sgp-lift-badge">+${(correlationLift * 100).toFixed(1)}% CORRELATION LIFT</span>
      </div>
      <table class="sgp-table">
        <thead>
          <tr>
            <th>Leg 1 P(Over)</th>
            <th>Leg 2 P(Over)</th>
            <th>Naive Independent Prob</th>
            <th style="color:var(--accent-purple);">True Joint Model Prob</th>
            <th>Fair SGP Odds</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>${(pRec * 100).toFixed(1)}%</td>
            <td>${(pYds * 100).toFixed(1)}%</td>
            <td style="color:var(--text-dim);">${(pIndep * 100).toFixed(1)}%</td>
            <td style="color:var(--accent-purple); font-weight:700;">${(pJoint * 100).toFixed(1)}%</td>
            <td style="color:var(--accent-blue); font-weight:700;">${fairAmerican > 0 ? '+' : ''}${fairAmerican}</td>
          </tr>
        </tbody>
      </table>
      <div style="margin-top:12px; font-size:11px; color:var(--text-muted); line-height:1.5;">
        <strong>SGP Pricing Takeaway:</strong> Because yards are produced by receptions (&phi; &approx; 0.65), a receiver who clears receptions is much more likely to also clear yards. If your sportsbook prices this SGP using unadjusted product odds (~${(pIndep * 100).toFixed(1)}%), there is a <strong>+${(correlationLift * 100).toFixed(1)}%</strong> pricing inefficiency.
      </div>
    </div>
  `;
}

// Marsaglia and Tsang exact Gamma sampler
function sampleStandardNormal() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function sampleGamma(shape, scale) {
  if (shape < 1) {
    return sampleGamma(shape + 1, scale) * Math.pow(Math.random(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    const z = sampleStandardNormal();
    const v = 1 + c * z;
    if (v <= 0) continue;
    const v3 = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * z * z * z * z) {
      return d * v3 * scale;
    }
    if (Math.log(u) < 0.5 * z * z + d * (1 - v3 + Math.log(v3))) {
      return d * v3 * scale;
    }
  }
}

function samplePoisson(lambda) {
  if (lambda <= 0) return 0;
  if (lambda < 30) {
    const L = Math.exp(-lambda);
    let k = 0, p = 1.0;
    do {
      k++;
      p *= Math.random();
    } while (p > L);
    return k - 1;
  }
  return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * sampleStandardNormal()));
}

// --------------------------------------------------------------------------
// TAB 5: CLV Tracking & Logging (with Local-First & Static Fallback)
// --------------------------------------------------------------------------

async function loadClvData() {
  try {
    const res = await fetch('/api/clv/log');
    if (res.ok) {
      const data = await res.json();
      clvLogData = data.rows || [];
      renderClvDashboard(data.report || {});
      populateClosingPickSelect();
      renderClvTable();
      return;
    }
  } catch (_) {}

  // Fallback for Vercel edge / static mode: load viewer/picks_log.jsonl + localStorage
  try {
    const textRes = await fetch('picks_log.jsonl');
    let rows = [];
    if (textRes.ok) {
      const rawText = await textRes.text();
      rows = rawText.split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => {
          try { return JSON.parse(l); } catch (_) { return null; }
        })
        .filter(Boolean);
    }

    // Merge with any client-stored local picks
    try {
      const localPicks = JSON.parse(localStorage.getItem('clv_local_picks') || '[]');
      rows = [...rows, ...localPicks];
    } catch (_) {}

    clvLogData = rows;
    const report = calculateClientClvReport(rows);
    renderClvDashboard(report);
    populateClosingPickSelect();
    renderClvTable();
  } catch (err) {
    console.warn('Could not load static CLV log:', err);
  }
}

function calculateClientClvReport(rows) {
  const settled = rows.filter(r => r.clv !== undefined);
  if (settled.length === 0) return { status: 'no closing lines recorded yet', n: 0 };

  const clvVals = settled.map(r => r.clv);
  const sum = clvVals.reduce((a, b) => a + b, 0);
  const mean = sum / clvVals.length;

  let se = 0;
  if (clvVals.length > 1) {
    const variance = clvVals.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / (clvVals.length - 1);
    se = Math.sqrt(variance) / Math.sqrt(clvVals.length);
  }

  const beatClose = clvVals.filter(v => v > 0).length / clvVals.length;
  return {
    n: clvVals.length,
    mean_clv: mean,
    ci95: [mean - 1.96 * se, mean + 1.96 * se],
    pct_beating_close: beatClose,
    verdict: (clvVals.length > 1 && mean - 1.96 * se > 0)
      ? 'positive CLV - edge is plausible'
      : (clvVals.length < 5 ? 'insufficient sample size (n < 5)' : 'NOT distinguishable from zero - do not scale')
  };
}

function renderClvDashboard(rep) {
  const meanEl = document.getElementById('clvMeanVal');
  const ciEl = document.getElementById('clvCiVal');
  const seEl = document.getElementById('clvSeSub');
  const countEl = document.getElementById('clvCountVal');
  const weeksEl = document.getElementById('clvWeeksSub');
  const beatEl = document.getElementById('clvBeatingVal');
  const headerClvEl = document.getElementById('headerClvVal');

  if (rep && rep.n > 0) {
    const mean = rep.mean_clv;
    if (meanEl) {
      meanEl.textContent = `${mean > 0 ? '+' : ''}${(mean * 100).toFixed(2)}%`;
      meanEl.className = `kpi-value ${mean > 0 ? 'val-green' : 'val-red'}`;
    }
    if (headerClvEl) {
      headerClvEl.textContent = `${mean > 0 ? '+' : ''}${(mean * 100).toFixed(2)}% CLV (n=${rep.n})`;
      headerClvEl.className = `pill-val ${mean > 0 ? 'val-green' : 'val-red'}`;
    }
    if (ciEl && rep.ci95) {
      ciEl.textContent = `[${(rep.ci95[0] * 100).toFixed(1)}%, ${(rep.ci95[1] * 100).toFixed(1)}%]`;
    }
    if (countEl) countEl.textContent = rep.n;
    if (beatEl && rep.pct_beating_close !== undefined) {
      beatEl.textContent = `${(rep.pct_beating_close * 100).toFixed(1)}%`;
      beatEl.className = `kpi-value ${rep.pct_beating_close >= 0.5 ? 'val-green' : 'val-amber'}`;
    }

    const verdictTitle = document.getElementById('clvVerdictTitle');
    const verdictText = document.getElementById('clvVerdictText');
    if (verdictTitle) verdictTitle.textContent = rep.verdict;
    if (verdictText) {
      verdictText.textContent = rep.mean_clv > 0
        ? `Out-of-sample closing line audit indicates positive edge over sportsbooks. Continue monitoring as sample grows.`
        : `Sample mean is not statistically indistinguishable from zero. Do not scale bankroll size until CLV confirms positive edge.`;
    }
  } else {
    if (meanEl) meanEl.textContent = '0.00%';
    if (headerClvEl) headerClvEl.textContent = '0 Bets Audited';
    if (countEl) countEl.textContent = clvLogData.length;
    if (weeksEl) weeksEl.textContent = `${clvLogData.length} pending closing`;
    if (beatEl) beatEl.textContent = '—';
  }
}

function populateClosingPickSelect() {
  const sel = document.getElementById('closeSelectPick');
  if (!sel) return;

  const openPicks = clvLogData.filter(r => r.closing_prob === undefined || r.closing_prob === null);
  if (openPicks.length === 0) {
    sel.innerHTML = `<option value="">All logged picks have closing lines recorded</option>`;
    return;
  }

  sel.innerHTML = `<option value="">Select pick to settle closing line (${openPicks.length} open)...</option>` +
    openPicks.map((p, idx) => `
      <option value="${escape(JSON.stringify({ player: p.player, market: p.market, line: p.line }))}">
        ${p.player} &bull; ${p.side.toUpperCase()} ${p.line} ${p.market} (Placed: ${p.odds > 0 ? '+' : ''}${p.odds})
      </option>
    `).join('');
}

function onClosePickSelect() {}

function updateClosingProbFromOdds() {
  const oddsInput = document.getElementById('closingOddsInput');
  const probInput = document.getElementById('closingProbInput');
  if (!oddsInput || !probInput) return;
  const odds = parseFloat(oddsInput.value);
  if (!isNaN(odds) && odds !== 0) {
    const dec = americanToDecimal(odds);
    probInput.value = (1 / dec).toFixed(3);
  }
}

async function submitClosingLine() {
  const sel = document.getElementById('closeSelectPick');
  const probInput = document.getElementById('closingProbInput');
  if (!sel || !sel.value) {
    showToast('Please select a logged pick.');
    return;
  }
  const prob = parseFloat(probInput.value);
  if (isNaN(prob) || prob <= 0 || prob >= 1) {
    showToast('Please enter a valid closing probability (e.g. 0.525).');
    return;
  }

  const pickKey = JSON.parse(unescape(sel.value));

  // Try API first
  try {
    const res = await fetch('/api/clv/record-closing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        player: pickKey.player,
        market: pickKey.market,
        line: pickKey.line,
        closing_prob: prob
      })
    });
    if (res.ok) {
      showToast(`✓ Recorded closing probability for ${pickKey.player}!`);
      probInput.value = '';
      await loadClvData();
      return;
    }
  } catch (_) {}

  // Local storage fallback for Vercel
  try {
    const target = clvLogData.find(r => r.player === pickKey.player && r.market === pickKey.market && r.line === pickKey.line);
    if (target) {
      target.closing_prob = prob;
      target.clv = target.side === 'over' ? (target.model_prob - prob) : ((1 - prob) - target.model_prob);
      localStorage.setItem('clv_local_picks', JSON.stringify(clvLogData));
      showToast(`✓ Recorded closing probability locally for ${pickKey.player}!`);
      probInput.value = '';
      await loadClvData();
    }
  } catch (e) {
    showToast('Error recording closing line.');
  }
}

async function logCurrentCalcPick() {
  if (!selectedPlayer) return;
  const market = document.getElementById('calcMarket').value;
  const line = parseFloat(document.getElementById('calcLine').value) || 0;
  const overOdds = parseFloat(document.getElementById('calcOverOdds').value) || -110;
  const underOdds = parseFloat(document.getElementById('calcUnderOdds').value) || -110;

  const rawPOver = market === 'receptions' ? pRecOver(selectedPlayer.mu_rec, line) : pYardsOver(selectedPlayer.mu_rec, selectedPlayer.mu_ypr, line);
  const bias = market === 'receptions' ? W1_BIAS_REC : W1_BIAS_YDS;
  const modelPOver = Math.max(0.01, Math.min(0.99, rawPOver - bias));
  const modelPUnder = 1.0 - modelPOver;

  const decOver = americanToDecimal(overOdds);
  const decUnder = americanToDecimal(underOdds);
  const rawMktOver = 1 / decOver;
  const rawMktUnder = 1 / decUnder;
  const vigSum = rawMktOver + rawMktUnder;
  const devigMktOver = rawMktOver / vigSum;
  const devigMktUnder = rawMktUnder / vigSum;

  const side = (modelPOver - devigMktOver >= modelPUnder - devigMktUnder) ? 'over' : 'under';
  const modelProb = side === 'over' ? modelPOver : modelPUnder;
  const mktProb = side === 'over' ? devigMktOver : devigMktUnder;
  const odds = side === 'over' ? overOdds : underOdds;
  const edge = modelProb - mktProb;
  const dec = side === 'over' ? decOver : decUnder;
  const ev = modelProb * (dec - 1) - (1 - modelProb);
  const b = dec - 1;
  const kelly = ev > 0 ? Math.min(W1_KELLY_CAP, (b * modelProb - (1 - modelProb)) / b) : 0;

  const payload = {
    logged_at: new Date().toISOString(),
    player: selectedPlayer.player_display_name,
    market: market,
    side: side,
    line: line,
    book: "Consensus",
    odds: odds,
    model_prob: modelProb,
    market_prob: mktProb,
    edge: edge,
    ev_per_unit: ev,
    kelly_stake: kelly,
    projection: market === 'receptions' ? selectedPlayer.proj_rec : selectedPlayer.proj_yards
  };

  try {
    const res = await fetch('/api/clv/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      showToast(`✓ Logged ${selectedPlayer.player_display_name} ${side.toUpperCase()} ${line} to picks_log.jsonl`);
      await loadClvData();
      return;
    }
  } catch (_) {}

  // Local storage fallback for Vercel
  try {
    const local = JSON.parse(localStorage.getItem('clv_local_picks') || '[]');
    local.push(payload);
    localStorage.setItem('clv_local_picks', JSON.stringify(local));
    showToast(`✓ Logged ${selectedPlayer.player_display_name} locally to CLV ledger`);
    await loadClvData();
  } catch (e) {
    showToast('Failed to save pick.');
  }
}

function renderClvTable() {
  const tbody = document.getElementById('clvLogTbody');
  if (!tbody) return;

  if (clvLogData.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="11" style="text-align:center; padding:28px; color:var(--text-dim);">
          No picks logged in picks_log.jsonl yet. Use the Calculator or Runner to log picks.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = clvLogData.map(r => {
    const dateStr = r.logged_at ? r.logged_at.slice(0, 10) : '—';
    const sideClass = r.side === 'over' ? 'val-green' : 'val-blue';
    const clvFormatted = r.clv !== undefined
      ? `<span class="${r.clv > 0 ? 'val-green' : 'val-red'} font-bold">${r.clv > 0 ? '+' : ''}${(r.clv * 100).toFixed(2)}%</span>`
      : '<span style="color:var(--text-dim);">Open</span>';
    const statusPill = r.closing_prob !== undefined
      ? '<span class="tier-pill tier-1-pill">Settled</span>'
      : '<span class="tier-pill tier-2-pill">Awaiting Close</span>';

    return `
      <tr>
        <td style="font-family:var(--font-mono); font-size:11px; color:var(--text-dim);">${dateStr}</td>
        <td class="player-name-cell" onclick="openPlayerModalByName('${escape(r.player)}')">${r.player}</td>
        <td>${r.market}</td>
        <td class="${sideClass}" style="font-weight:700;">${r.side.toUpperCase()}</td>
        <td class="num-col font-mono">${r.line}</td>
        <td class="num-col font-mono">${r.odds > 0 ? '+' : ''}${r.odds}</td>
        <td class="num-col font-mono">${(r.model_prob * 100).toFixed(1)}%</td>
        <td class="num-col font-mono">${(r.market_prob * 100).toFixed(1)}%</td>
        <td class="num-col font-mono">${r.closing_prob !== undefined ? (r.closing_prob * 100).toFixed(1) + '%' : '—'}</td>
        <td class="num-col">${clvFormatted}</td>
        <td>${statusPill}</td>
      </tr>
    `;
  }).join('');
}

// --------------------------------------------------------------------------
// TAB 6: Weekly Runner (Streaming Shell Execution)
// --------------------------------------------------------------------------

function openRunModal() {
  setTab('run');
}

function clearTerminal() {
  const term = document.getElementById('terminalOutput');
  if (term) term.textContent = 'Terminal cleared. Ready for next run.\n';
}

async function executeWeeklyRun() {
  const season = document.getElementById('runSeasonSelect').value || 2026;
  const week = document.getElementById('runWeekSelect').value || 1;
  const allGames = document.getElementById('runAllGamesCheck').checked;
  const odds = document.getElementById('runOddsCheck').checked;

  const btn = document.getElementById('executeRunBtn');
  const term = document.getElementById('terminalOutput');
  if (btn) {
    btn.disabled = true;
    btn.style.opacity = '0.6';
    btn.innerHTML = `<span class="dot"></span><span>Running week1.py...</span>`;
  }

  term.textContent = `>>> Connecting to Pipeline Runner: python src/week1.py --season ${season} --week ${week}${allGames ? ' --all-games' : ''}${odds ? ' --odds' : ''}\n\n`;

  try {
    const url = `/api/run-week/stream?season=${season}&week=${week}&all_games=${allGames}&odds=${odds}`;
    const response = await fetch(url);
    if (!response.ok) {
      term.textContent += `[INFO] Cloud Edge Mode: The live pipeline requires a persistent process and disk.\n`;
      term.textContent += `To run on your local machine or Railway VPS:\n`;
      term.textContent += `  python src/week1.py --season ${season} --week ${week}\n`;
      term.textContent += `  cd viewer && vercel --prod\n`;
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let done = false;

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      done = readerDone;
      if (value) {
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const content = line.slice(6);
            term.textContent += content + '\n';
            term.scrollTop = term.scrollHeight;
          }
        }
      }
    }

    showToast('✓ Weekly run finished! Reloading slate & picks...');
    await loadData();
    renderPicksSection();
    renderSlateTable();
    renderTdPanel();
  } catch (err) {
    term.textContent += `\n[NOTE] Running in edge static mode. For persistent disk fits, run locally or via Railway.\n`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.innerHTML = `
        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
        <span>Run Pipeline Now</span>
      `;
    }
  }
}

// --------------------------------------------------------------------------
// Player Detail Modal
// --------------------------------------------------------------------------

function openPlayerModal(escapedPlayerId) {
  const playerId = unescape(escapedPlayerId);
  const p = slateData.find(x => x.player_id === playerId);
  if (!p) return;

  const modal = document.getElementById('playerModal');
  const nameEl = document.getElementById('modalPlayerName');
  const metaEl = document.getElementById('modalPlayerMeta');
  const posEl = document.getElementById('modalPosTag');
  const bodyEl = document.getElementById('modalBody');

  if (nameEl) nameEl.textContent = p.player_display_name;
  if (posEl) {
    posEl.textContent = p.position;
    posEl.className = `pos-tag pos-${p.position}`;
  }
  const homeStr = p.is_home === 0 ? '@' : 'vs';
  if (metaEl) {
    metaEl.innerHTML = `${p.team} ${homeStr} ${p.opponent_team} &bull; Spread: ${p.team_spread > 0 ? '+' : ''}${Number(p.team_spread).toFixed(1)} &bull; Total: ${Number(p.total_line).toFixed(1)} &bull; Implied: ${Number(p.implied_team_total).toFixed(1)} pts`;
  }

  const qAlert = p.questionable ? `
    <div style="background:rgba(245,158,11,0.12); border:1px solid rgba(245,158,11,0.35); border-radius:8px; padding:12px; margin-bottom:16px; color:#f59e0b; font-size:12px; line-height:1.5;">
      <strong>⚠️ QUESTIONABLE INJURY STATUS:</strong> Player is listed questionable on the official injury report. The model cannot price in-game reinjury risk or sudden snap reductions — discount manually or reduce stake.
    </div>
  ` : '';

  const exclAlert = p.excl_reason ? `
    <div style="background:rgba(248,113,113,0.12); border:1px solid rgba(248,113,113,0.35); border-radius:8px; padding:12px; margin-bottom:16px; color:#f87171; font-size:12px; line-height:1.5;">
      <strong>EXCLUSION FLAG (${p.excl_reason}):</strong> Excluded from automatic pick recommendation because target shares or offensive systems carry high offseason uncertainty.
    </div>
  ` : '';

  bodyEl.innerHTML = `
    ${qAlert}
    ${exclAlert}

    <!-- Core Projections & Fair Lines -->
    <h4 style="font-size:13px; font-family:var(--font-mono); color:var(--text-dim); margin-bottom:8px; text-transform:uppercase;">
      Predictive Distribution &amp; Fair Lines (50/50 Median)
    </h4>
    <div class="modal-grid-stats">
      <div class="stat-block">
        <span class="stat-block-label">FAIR LINE YARDS</span>
        <span class="stat-block-val" style="color:var(--accent-blue);">${Number(p.fair_line_yards).toFixed(1)}</span>
      </div>
      <div class="stat-block">
        <span class="stat-block-label">PROJECTED YARDS</span>
        <span class="stat-block-val">${Number(p.proj_yards).toFixed(1)}</span>
      </div>
      <div class="stat-block">
        <span class="stat-block-label">FAIR LINE REC</span>
        <span class="stat-block-val" style="color:var(--accent-blue);">${Number(p.fair_line_rec).toFixed(1)} <small style="font-size:11px; color:var(--text-dim);">(${Math.round((p.p_rec_at_fair_line || 0.5) * 100)}%)</small></span>
      </div>
      <div class="stat-block">
        <span class="stat-block-label">PROJECTED REC</span>
        <span class="stat-block-val">${Number(p.proj_rec).toFixed(1)}</span>
      </div>
      <div class="stat-block">
        <span class="stat-block-label">ANYTIME TD PROB</span>
        <span class="stat-block-val" style="color:var(--accent-green);">${Math.round(p.p_td * 100)}% <small style="font-size:10px;">(${p.td_fair_odds > 0 ? '+' : ''}${p.td_fair_odds})</small></span>
      </div>
      <div class="stat-block">
        <span class="stat-block-label">MODEL MU (REC/YPR)</span>
        <span class="stat-block-val">${Number(p.mu_rec).toFixed(2)} / ${Number(p.mu_ypr).toFixed(1)}</span>
      </div>
    </div>

    <!-- Season Volume Stats -->
    <h4 style="font-size:13px; font-family:var(--font-mono); color:var(--text-dim); margin-bottom:8px; text-transform:uppercase;">
      Prior Observed Season Form &amp; Usage
    </h4>
    <div class="modal-grid-stats">
      <div class="stat-block">
        <span class="stat-block-label">TARGET SHARE</span>
        <span class="stat-block-val">${(Number(p.target_share || p.f_tgt_share || 0) * 100).toFixed(1)}%</span>
      </div>
      <div class="stat-block">
        <span class="stat-block-label">AIR YARDS SHARE</span>
        <span class="stat-block-val">${(Number(p.air_yards_share || p.f_ay_share || 0) * 100).toFixed(1)}%</span>
      </div>
      <div class="stat-block">
        <span class="stat-block-label">aDOT</span>
        <span class="stat-block-val">${Number(p.adot || p.f_adot || 0).toFixed(1)} yds</span>
      </div>
      <div class="stat-block">
        <span class="stat-block-label">CATCH RATE</span>
        <span class="stat-block-val">${(Number(p.catch_rate_g || p.f_catch_rate || 0) * 100).toFixed(1)}%</span>
      </div>
      <div class="stat-block">
        <span class="stat-block-label">YPR (YARDS/REC)</span>
        <span class="stat-block-val">${Number(p.ypr_g || p.f_ypr || 0).toFixed(1)}</span>
      </div>
      <div class="stat-block">
        <span class="stat-block-label">2025 TDS (TARGETS)</span>
        <span class="stat-block-val">${p.receiving_tds || 0} (${p.targets || 0})</span>
      </div>
    </div>

    <!-- Trend vs Prior Weeks & Defensive Matchup -->
    <h4 style="font-size:13px; font-family:var(--font-mono); color:var(--text-dim); margin-bottom:8px; text-transform:uppercase;">
      Matchup &amp; Career Priors
    </h4>
    <div style="background:var(--bg-main); border:1px solid var(--border-color); border-radius:8px; padding:14px; font-size:12px; line-height:1.7; color:var(--text-muted);">
      &bull; <strong>Form vs Career Volume:</strong> Rolling form averages <strong>${Number(p.f_targets || 0).toFixed(1)} targets</strong> and <strong>${Number(p.f_yards || 0).toFixed(1)} yards</strong> per game, compared to career baseline of <strong>${Number(p.c_targets || 0).toFixed(1)} targets</strong> over ${p.games_prior || 0} prior games.<br>
      &bull; <strong>Target Volatility:</strong> Standard deviation <code>f_tgt_sd = ${Number(p.f_tgt_sd || 0).toFixed(2)}</code>.<br>
      &bull; <strong>Opponent Defensive Index:</strong> Opponent allows <strong>${((Number(p.def_yards_idx || 1.0) - 1.0) * 100).toFixed(1)}%</strong> ${p.def_yards_idx >= 1.0 ? 'more' : 'fewer'} yards to ${p.position}s than league average.<br>
      &bull; <strong>Weather / Venue:</strong> ${p.is_dome ? 'Indoor Dome' : 'Outdoor Stadium'} &bull; Wind: ${p.wind || 0.0} mph.
    </div>

    <div style="margin-top:20px; display:flex; justify-content:flex-end; gap:10px;">
      <button class="btn-primary" onclick="closePlayerModal(); openCalculatorFor('${escape(p.player_id)}')">
        Price in Calculator &rarr;
      </button>
    </div>
  `;

  modal.classList.add('active');
}

function openPlayerModalByName(escapedName) {
  const name = unescape(escapedName);
  const player = slateData.find(x => x.player_display_name === name);
  if (player) openPlayerModal(escape(player.player_id));
}

function closePlayerModal(e) {
  const modal = document.getElementById('playerModal');
  if (modal) modal.classList.remove('active');
}

// --------------------------------------------------------------------------
// Mathematical & Probability Distribution Helpers
// --------------------------------------------------------------------------

function americanToDecimal(odds) {
  const o = Number(odds);
  return o > 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o);
}

function probToAmerican(prob) {
  const p = Math.max(0.01, Math.min(0.99, Number(prob)));
  if (p >= 0.5) {
    return Math.round(-(p / (1 - p)) * 100);
  } else {
    return Math.round(((1 - p) / p) * 100);
  }
}

function logGamma(z) {
  const g = 7;
  const p = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.138571095836524,
    9.9843695780195716e-6,
    1.5056327351493116e-7
  ];
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * Math.exp(logGamma(1 - z)));
  z -= 1;
  let x = p[0];
  for (let i = 1; i < g + 2; i++) x += p[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function regularizedGammaP(s, x) {
  if (x <= 0) return 0;
  if (x < s + 1) {
    let sum = 1 / s;
    let term = 1 / s;
    for (let n = 1; n < 100; n++) {
      term *= x / (s + n);
      sum += term;
      if (term < sum * 1e-12) break;
    }
    return sum * Math.exp(-x + s * Math.log(x) - logGamma(s));
  } else {
    let a0 = 1, a1 = x;
    let b0 = 0, b1 = 1;
    let fac = 1;
    let g = 0;
    for (let n = 1; n < 100; n++) {
      let ana = n - s;
      a0 = (a1 + a0 * ana) * fac;
      b0 = (b1 + b0 * ana) * fac;
      let anf = n * fac;
      a1 = x * a0 + anf * a1;
      b1 = x * b0 + anf * b1;
      if (a1 !== 0) {
        fac = 1 / a1;
        g = b1 * fac;
      }
    }
    return 1 - Math.exp(-x + s * Math.log(x) - logGamma(s)) * g;
  }
}

// NegBin(mu, alpha) P(over)
function pRecOver(mu, line) {
  const r = 1.0 / MODEL_ALPHA;
  const p = r / (r + mu);
  const kMax = Math.floor(line);
  let cdf = 0;
  let term = Math.pow(p, r);
  cdf += term;
  for (let k = 1; k <= kMax; k++) {
    term *= ((k - 1 + r) / k) * (1 - p);
    cdf += term;
  }
  return Math.max(0, Math.min(1, 1 - cdf));
}

// Compound NegBin-Gamma P(over)
function pYardsOver(muRec, muYpr, line) {
  if (line <= 0) return 1.0;
  const r = 1.0 / MODEL_ALPHA;
  const p = r / (r + muRec);
  const scale = muYpr / MODEL_K;

  let pOver = 0;
  let nbProb = Math.pow(p, r);

  for (let n = 1; n <= 24; n++) {
    nbProb *= ((n - 1 + r) / n) * (1 - p);
    const shape = n * MODEL_K;
    const x = line / scale;
    const gammaCdf = regularizedGammaP(shape, x);
    pOver += nbProb * (1 - gammaCdf);
  }
  return Math.max(0, Math.min(1, pOver));
}

// Toast notification helper
function showToast(message, duration = 3000) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}
