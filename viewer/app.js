// NFL Receiving Props Agent — Week 1 Viewer Logic

const MODEL_ALPHA = 0.1116; // NegBin dispersion for receptions
const MODEL_K = 1.558;      // Gamma shape per reception
const W1_BIAS_REC = 0.057;  // Out-of-sample Week 1 bias on P(over)
const W1_BIAS_YDS = 0.088;  // Out-of-sample Week 1 bias on P(over)
const W1_MIN_EDGE = 0.10;   // 10% minimum edge gate for Week 1
const W1_KELLY_CAP = 0.005; // 0.5% max bankroll stake for Week 1

let slateData = [];
let picksData = { picks: [] };
let currentPosFilter = 'ALL';
let currentSortCol = 'proj_yards';
let currentSortAsc = false;
let selectedPlayer = null;

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
  await loadData();
  renderSlateTable();
  renderPicksSection();
  populateCalculator();
});

async function loadData() {
  try {
    const slateRes = await fetch('slate_projections.json');
    slateData = await slateRes.json();
  } catch (err) {
    console.error('Failed to fetch slate_projections.json:', err);
  }

  try {
    const picksRes = await fetch('current_picks.json');
    picksData = await picksRes.json();
  } catch (err) {
    console.error('Failed to fetch current_picks.json:', err);
  }

  updateSummaryStats();
}

function updateSummaryStats() {
  const badge = document.getElementById('picksCountBadge');
  if (badge) badge.textContent = picksData.picks ? picksData.picks.length : 0;

  const showing = document.getElementById('showingCount');
  if (showing) showing.textContent = slateData.length;

  if (slateData.length > 0) {
    const topYards = [...slateData].sort((a, b) => b.proj_yards - a.proj_yards)[0];
    const topRec = [...slateData].sort((a, b) => b.proj_rec - a.proj_rec)[0];
    const q = slateData.filter(d => d.questionable === 1).length;

    const tyEl = document.getElementById('topProjYards');
    if (tyEl && topYards) tyEl.textContent = `${topYards.proj_yards.toFixed(1)} (${topYards.player_display_name})`;

    const trEl = document.getElementById('topProjRec');
    if (trEl && topRec) trEl.textContent = `${topRec.proj_rec.toFixed(1)} (${topRec.player_display_name})`;

    const qEl = document.getElementById('qCount');
    if (qEl) qEl.textContent = q;
  }
}

// Tab switcher
function setTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.content-section').forEach(sec => sec.classList.remove('active'));

  if (tabId === 'slate') {
    document.getElementById('tabSlate').classList.add('active');
    document.getElementById('slateSection').classList.add('active');
  } else if (tabId === 'picks') {
    document.getElementById('tabPicks').classList.add('active');
    document.getElementById('picksSection').classList.add('active');
  } else if (tabId === 'calc') {
    document.getElementById('tabCalc').classList.add('active');
    document.getElementById('calcSection').classList.add('active');
  }
}

// Toggle Warning Details Accordion
function toggleDetails() {
  const details = document.getElementById('warningDetails');
  const btn = document.getElementById('toggleDetailsBtn');
  if (details.style.display === 'none') {
    details.style.display = 'block';
    btn.textContent = 'Hide';
  } else {
    details.style.display = 'none';
    btn.textContent = 'Details';
  }
}

// Position filter
function setPosFilter(pos) {
  currentPosFilter = pos;
  document.querySelectorAll('.pos-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.pos === pos);
  });
  renderSlateTable();
}

// Search filter
function filterData() {
  const q = document.getElementById('searchInput').value.trim();
  const clearBtn = document.getElementById('clearSearchBtn');
  if (clearBtn) clearBtn.style.display = q.length > 0 ? 'block' : 'none';
  renderSlateTable();
}

function clearSearch() {
  const input = document.getElementById('searchInput');
  input.value = '';
  document.getElementById('clearSearchBtn').style.display = 'none';
  renderSlateTable();
}

// Sorting
function sortBy(col) {
  if (currentSortCol === col) {
    currentSortAsc = !currentSortAsc;
  } else {
    currentSortCol = col;
    currentSortAsc = col === 'player_display_name';
  }
  updateSortArrows();
  renderSlateTable();
}

function updateSortArrows() {
  const cols = ['player_display_name', 'proj_rec', 'fair_line_rec', 'proj_yards', 'fair_line_yards'];
  cols.forEach(c => {
    const el = document.getElementById(`sort-${c}`);
    if (el) {
      if (c === currentSortCol) {
        el.textContent = currentSortAsc ? '▲' : '▼';
      } else {
        el.textContent = '';
      }
    }
  });
}

// Render Slate Table
function renderSlateTable() {
  const tbody = document.getElementById('slateTbody');
  if (!tbody) return;

  const q = document.getElementById('searchInput').value.toLowerCase().trim();

  let filtered = slateData.filter(row => {
    if (currentPosFilter !== 'ALL' && row.position !== currentPosFilter) return false;
    if (q) {
      const p = row.player_display_name.toLowerCase();
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
    return currentSortAsc ? (vA - vB) : (vB - vA);
  });

  const showingEl = document.getElementById('showingCount');
  if (showingEl) showingEl.textContent = filtered.length;

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" style="text-align:center; padding:32px; color:var(--text-dim);">
          No receivers found matching your search.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map(row => {
    const qBadge = row.questionable ? `<span class="q-badge" title="Questionable on Injury Report">Q</span>` : '';
    const posTag = `<span class="pos-tag pos-${row.position}">${row.position}</span>`;
    const homeStr = row.is_home === 1 ? 'vs' : '@';
    const matchup = `<span class="matchup-tag">${row.team} <span class="home-indicator">${homeStr}</span> ${row.opponent_team}</span>`;
    const context = `Spread: ${row.team_spread > 0 ? '+' : ''}${row.team_spread.toFixed(1)} &bull; Tot: ${row.total_line.toFixed(1)} &bull; Impl: ${row.implied_team_total.toFixed(1)}`;

    return `
      <tr>
        <td class="player-name-cell">
          <span>${row.player_display_name}</span>
          ${qBadge}
        </td>
        <td>${posTag}</td>
        <td>${matchup}</td>
        <td class="num-col highlight-val">${row.proj_rec.toFixed(1)}</td>
        <td class="num-col fair-val">${row.fair_line_rec.toFixed(1)}</td>
        <td class="num-col highlight-val">${row.proj_yards.toFixed(1)}</td>
        <td class="num-col fair-val">${row.fair_line_yards.toFixed(1)}</td>
        <td class="game-context-cell">${context}</td>
        <td class="action-col">
          <button class="action-btn" onclick="openCalculatorFor('${escape(row.player_id)}')">Price Prop</button>
        </td>
      </tr>
    `;
  }).join('');
}

// Render Scored Picks Section
function renderPicksSection() {
  const container = document.getElementById('picksContainer');
  const chip = document.getElementById('picksStatusChip');
  if (!container) return;

  const picks = picksData.picks || [];
  if (picks.length === 0) {
    if (chip) {
      chip.className = 'status-chip chip-neutral';
      chip.textContent = '0 Picks Cleared 10% Gate';
    }
    container.innerHTML = `
      <div class="empty-picks-box">
        <h4>No Picks Cleared the Week 1 Guardrail</h4>
        <p>
          ${picksData.note || 'Zero picks currently clear the 10% edge gate.'}
          In Week 1, model error is 3&ndash;5%, so any claimed edge below 10% is within measurement noise.
        </p>
        <p style="font-size:12px; color:var(--text-dim); margin-top:8px;">
          Use the <strong>Prop Pricing Calculator</strong> tab or the <strong>Price Prop</strong> buttons in the slate table to evaluate specific sportsbook lines against the model's predictive distribution.
        </p>
        <button class="action-btn" style="padding:8px 16px; font-size:13px;" onclick="setTab('slate')">View All Fair Lines</button>
      </div>
    `;
    return;
  }

  if (chip) {
    chip.className = 'status-chip chip-active';
    chip.textContent = `${picks.length} Picks Active`;
  }

  container.innerHTML = `
    <div class="table-container">
      <table class="slate-table">
        <thead>
          <tr>
            <th>Player</th>
            <th>Market</th>
            <th>Side</th>
            <th class="num-col">Line</th>
            <th>Book</th>
            <th class="num-col">Odds</th>
            <th class="num-col">Model P</th>
            <th class="num-col">Mkt P</th>
            <th class="num-col">Edge</th>
            <th class="num-col">EV</th>
            <th class="num-col">Kelly Stake</th>
          </tr>
        </thead>
        <tbody>
          ${picks.map(p => `
            <tr>
              <td class="player-name-cell">${p.player}</td>
              <td>${p.market.replace('_', ' ')}</td>
              <td><strong>${p.side.toUpperCase()}</strong></td>
              <td class="num-col">${p.line.toFixed(1)}</td>
              <td>${p.book}</td>
              <td class="num-col">${p.odds > 0 ? '+' : ''}${p.odds}</td>
              <td class="num-col">${(p.model_prob * 100).toFixed(1)}%</td>
              <td class="num-col">${(p.market_prob * 100).toFixed(1)}%</td>
              <td class="num-col val-green">+${(p.edge * 100).toFixed(1)}%</td>
              <td class="num-col val-green">+${(p.ev_per_unit * 100).toFixed(1)}%</td>
              <td class="num-col val-green">${(p.kelly_stake * 100).toFixed(2)}%</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// --------------------------------------------------------------------------
// Calculator & Mathematical Probability Engine
// --------------------------------------------------------------------------

function populateCalculator() {
  const select = document.getElementById('calcPlayerSelect');
  if (!select || slateData.length === 0) return;

  select.innerHTML = slateData.map(p => `
    <option value="${p.player_id}">${p.player_display_name} (${p.position} - ${p.team})</option>
  `).join('');

  if (slateData.length > 0) {
    select.value = slateData[0].player_id;
    selectedPlayer = slateData[0];
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
    // Set default line to fair line yards
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

  ctxBox.innerHTML = `
    <strong>${selectedPlayer.player_display_name}</strong> &bull; ${selectedPlayer.position} &bull; ${selectedPlayer.team} vs ${selectedPlayer.opponent_team}<br>
    Model Mu (Rec): <strong>${selectedPlayer.mu_rec.toFixed(2)}</strong> &bull; Mu (YPR): <strong>${selectedPlayer.mu_ypr.toFixed(2)}</strong><br>
    Projection: <strong>${selectedPlayer.proj_rec.toFixed(1)} rec</strong> / <strong>${selectedPlayer.proj_yards.toFixed(1)} yds</strong><br>
    Model Median (Fair Line): <strong>${selectedPlayer.fair_line_rec.toFixed(1)} rec</strong> / <strong>${selectedPlayer.fair_line_yards.toFixed(1)} yds</strong><br>
    Implied Team Total: <strong>${selectedPlayer.implied_team_total.toFixed(1)}</strong> &bull; Wind: <strong>${selectedPlayer.wind} mph</strong>
  `;
}

// Math helpers
function americanToDecimal(odds) {
  return odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds);
}

function logGamma(z) {
  // Lanczos approximation
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
  // P(s, x) via series expansion or continued fraction
  if (x < 0) return 0;
  if (x === 0) return 0;
  if (x < s + 1) {
    // Series
    let sum = 1 / s;
    let term = 1 / s;
    for (let n = 1; n < 100; n++) {
      term *= x / (s + n);
      sum += term;
      if (term < sum * 1e-12) break;
    }
    return sum * Math.exp(-x + s * Math.log(x) - logGamma(s));
  } else {
    // Continued fraction for Q(s, x)
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

// Model P(over) for Receptions: NegBin(mu, alpha)
function pRecOver(mu, line) {
  const r = 1.0 / MODEL_ALPHA;
  const p = r / (r + mu);
  const kMax = Math.floor(line);
  // CDF = sum_{k=0}^{kMax} P(X = k)
  let cdf = 0;
  let term = Math.pow(p, r);
  cdf += term;
  for (let k = 1; k <= kMax; k++) {
    term *= ((k - 1 + r) / k) * (1 - p);
    cdf += term;
  }
  return Math.max(0, Math.min(1, 1 - cdf));
}

// Model P(over) for Yards: Compound NegBin-Gamma
function pYardsOver(muRec, muYpr, line) {
  if (line <= 0) return 1.0;
  const r = 1.0 / MODEL_ALPHA;
  const p = r / (r + muRec);
  const scale = muYpr / MODEL_K;

  let pOver = 0;
  let nbProb = Math.pow(p, r);

  for (let n = 1; n <= 24; n++) {
    nbProb *= ((n - 1 + r) / n) * (1 - p);
    // Y | N=n ~ Gamma(shape = n*k, scale)
    const shape = n * MODEL_K;
    const x = line / scale;
    const gammaCdf = regularizedGammaP(shape, x);
    const gammaOver = 1 - gammaCdf;
    pOver += nbProb * gammaOver;
  }
  return Math.max(0, Math.min(1, pOver));
}

function calculateEdge() {
  if (!selectedPlayer) return;
  const market = document.getElementById('calcMarket').value;
  const line = parseFloat(document.getElementById('calcLine').value) || 0;
  const overOdds = parseFloat(document.getElementById('calcOverOdds').value) || -110;
  const underOdds = parseFloat(document.getElementById('calcUnderOdds').value) || -110;

  // Raw model probability
  let rawPOver = 0;
  let bias = 0;
  if (market === 'receptions') {
    rawPOver = pRecOver(selectedPlayer.mu_rec, line);
    bias = W1_BIAS_REC;
  } else {
    rawPOver = pYardsOver(selectedPlayer.mu_rec, selectedPlayer.mu_ypr, line);
    bias = W1_BIAS_YDS;
  }

  // Week 1 bias corrected
  const modelPOver = Math.max(0.01, Math.min(0.99, rawPOver - bias));
  const modelPUnder = 1.0 - modelPOver;

  // De-vig market probabilities
  const decOver = americanToDecimal(overOdds);
  const decUnder = americanToDecimal(underOdds);
  const rawMktOver = 1 / decOver;
  const rawMktUnder = 1 / decUnder;
  const vigSum = rawMktOver + rawMktUnder;
  const devigMktOver = rawMktOver / vigSum;
  const devigMktUnder = rawMktUnder / vigSum;

  // Over EV & Edge
  const edgeOver = modelPOver - devigMktOver;
  const evOver = modelPOver * (decOver - 1) - (1 - modelPOver);
  let kellyOver = 0;
  if (evOver > 0) {
    const b = decOver - 1;
    kellyOver = Math.min(W1_KELLY_CAP, (b * modelPOver - (1 - modelPOver)) / b);
  }

  // Under EV & Edge
  const edgeUnder = modelPUnder - devigMktUnder;
  const evUnder = modelPUnder * (decUnder - 1) - (1 - modelPUnder);
  let kellyUnder = 0;
  if (evUnder > 0) {
    const b = decUnder - 1;
    kellyUnder = Math.min(W1_KELLY_CAP, (b * modelPUnder - (1 - modelPUnder)) / b);
  }

  // Determine best side
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
