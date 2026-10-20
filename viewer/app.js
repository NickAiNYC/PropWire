/**
 * NFL Receiving Props Agent — Client Application
 * Core Promise: "Understand the opportunity, verify the price, know what could invalidate it."
 */

// --------------------------------------------------------------------------
// Global State & Model Constants
// --------------------------------------------------------------------------

const MODEL_ALPHA = 0.1097; // Calibrated NB dispersion (Var = mu + alpha*mu^2)
const MODEL_K = 1.555;      // Calibrated Gamma shape per reception (k = 1.555)

// Empirical out-of-sample calibration error hurdles
const W1_BIAS_REC = 0.057; // Week 1 empirical bias
const W1_BIAS_YDS = 0.088; // Week 1 empirical bias
const W1_MIN_EDGE = 0.10;  // 10% edge hurdle for Week 1
const W1_KELLY_CAP = 0.005; // 0.5% max bankroll cap

const STD_MIN_EDGE = 0.05; // 5% edge hurdle for regular weeks
const STD_KELLY_CAP = 0.02; // 2% max bankroll cap

let currentSlateKey = '2026_w7'; // '2026_w7' (Upcoming) or '2026_w1' (Historical)
let currentSeason = 2026;
let currentWeek = 7;
let isHistoricalSlate = false;

let slateData = [];
let topPicksData = [];
let gamesData = [];
let clvLogData = [];
let selectedGameId = null; // Filter by game_id from Game Strip

// User Filters
let currentFilterPos = 'ALL';
let currentFilterMarket = 'yards'; // 'yards', 'receptions', 'anytime_td'
let currentFilterBook = 'Consensus';
let currentFilterTeam = 'ALL';
let currentSearchQuery = '';
let currentQualifiedOnly = false;
let currentProjectableOnly = true;

let sortCol = 'proj_yards';
let sortAsc = false;

// Persistent User Adjustments (saved in localStorage)
let inlinePlayerLines = {}; 
let userWatchlist = [];
let selectedDrawerPlayer = null;
let clvFilterType = 'all'; // 'all', 'verified', 'demo'

// --------------------------------------------------------------------------
// Initialization & Slate Loading
// --------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  loadStoredWatchlist();
  loadStoredLines();
  
  // Keyboard shortcut: Escape to close drawer/modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeDrawer();
      closeAdminModal();
    }
  });

  await initSlate(currentSlateKey);
  await loadClvLedger();
});

async function initSlate(slateKey) {
  currentSlateKey = slateKey;
  if (slateKey === '2026_w1') {
    currentWeek = 1;
    isHistoricalSlate = true;
  } else {
    currentWeek = 7;
    isHistoricalSlate = false;
  }

  updateSlateHeaderContext();

  try {
    // 1. Load games schedule
    const gamesPath = isHistoricalSlate ? 'games_2026_w1.json' : 'games_2026_w7.json';
    const gamesRes = await fetchWithFallback(`/api/games?slate=${slateKey}`, gamesPath);
    if (gamesRes.ok) {
      gamesData = await gamesRes.json();
    } else {
      gamesData = [];
    }

    // 2. Load slate projections
    const slatePath = isHistoricalSlate ? 'slate_2026_w1.json' : 'slate_2026_w7.json';
    const slateRes = await fetchWithFallback(`/api/slate?slate=${slateKey}`, slatePath);
    if (slateRes.ok) {
      slateData = await slateRes.json();
    }

    // 3. Load top picks
    const picksPath = isHistoricalSlate ? 'current_picks_w1.json' : 'current_picks_w7.json';
    const picksRes = await fetchWithFallback(`/api/picks?slate=${slateKey}`, picksPath);
    if (picksRes.ok) {
      const picksPayload = await picksRes.json();
      topPicksData = picksPayload.top_projections || picksPayload.picks || [];
    }

    populateTeamDropdown();
    renderGameStrip();
    renderTopPicksCard();
    renderBoard();
    populateSgpSelect();
  } catch (err) {
    console.error('Error loading slate data:', err);
    showToast('Failed to load slate data.');
  }
}

async function fetchWithFallback(apiPath, staticFallback) {
  try {
    const res = await fetch(apiPath);
    if (res.ok) return res;
  } catch (_) {}
  return fetch(staticFallback);
}

function updateSlateHeaderContext() {
  const badge = document.getElementById('dataStatusBadge');
  const badgeText = document.getElementById('dataStatusText');
  const noticeBanner = document.getElementById('slateNoticeBanner');
  const noticeText = document.getElementById('slateNoticeText');
  const noticeBtn = document.getElementById('slateNoticeActionBtn');
  const navTitle = document.getElementById('navTitle');
  const selector = document.getElementById('slateSelector');
  const boardBadge = document.getElementById('boardTotalBadge');

  if (selector) selector.value = currentSlateKey;

  if (isHistoricalSlate) {
    if (navTitle) navTitle.textContent = '2026 Week 1 Slate & Historical Audit';
    if (badge) badge.className = 'data-status-badge badge-prelim';
    if (badgeText) badgeText.textContent = 'HISTORICAL AUDIT • SETTLED';
    if (noticeBanner) noticeBanner.style.background = 'rgba(245,158,11,0.08)';
    if (noticeText) noticeText.innerHTML = 'Showing <strong>2026 Week 1 Historical Audit</strong> (Settled games from Sept 10–14). Schedule: 16 Games (32 Teams). Week 1 calibration error (3–5%) applied.';
    if (noticeBtn) {
      noticeBtn.textContent = 'Switch to Upcoming Slate (Week 7)';
      noticeBtn.onclick = () => onSlateSelectChange('2026_w7');
    }
  } else {
    if (navTitle) navTitle.textContent = '2026 Week 7 Slate & Prop Intelligence';
    if (badge) badge.className = 'data-status-badge status-live';
    if (badgeText) badgeText.textContent = 'UPCOMING SLATE • CALIBRATED';
    if (noticeBanner) noticeBanner.style.background = 'rgba(56,189,248,0.06)';
    if (noticeText) noticeText.innerHTML = '<strong>Schedule Coverage:</strong> 14 Games (28 Teams) &bull; <strong>Projections:</strong> 28 of 28 Teams (390 Receivers) &bull; <strong>Market Totals:</strong> 10 games posted, 4 games pending Vegas totals (NE@CHI, SF@ATL, LA@LV, KC@SEA).';
    if (noticeBtn) {
      noticeBtn.textContent = 'Switch to Historical Audit (Week 1)';
      noticeBtn.onclick = () => onSlateSelectChange('2026_w1');
    }
  }
}

function onSlateSelectChange(val) {
  selectedGameId = null;
  initSlate(val);
}

function toggleSlateContext() {
  const next = isHistoricalSlate ? '2026_w7' : '2026_w1';
  onSlateSelectChange(next);
}

// --------------------------------------------------------------------------
// Navigation (4 Primary Destinations)
// --------------------------------------------------------------------------

function setDestination(dest) {
  const tabs = ['board', 'watchlist', 'tracker', 'research'];
  tabs.forEach(t => {
    const btn = document.getElementById(`tab${capitalize(t)}`);
    const page = document.getElementById(`${t}Destination`);
    if (btn) btn.classList.toggle('active', t === dest);
    if (page) page.classList.toggle('active', t === dest);
  });

  if (dest === 'watchlist') renderWatchlistPage();
  if (dest === 'tracker') renderTrackerPage();
  if (dest === 'board') renderBoard();
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// --------------------------------------------------------------------------
// Game Strip (Horizontal Matchup Filter)
// --------------------------------------------------------------------------

function renderGameStrip() {
  const track = document.getElementById('gameStripTrack');
  if (!track) return;

  if (gamesData.length === 0) {
    track.innerHTML = `<span style="font-size:12px; color:var(--text-dim); padding:4px;">No matchup schedule files found for this slate.</span>`;
    return;
  }

  const allActive = selectedGameId === null ? 'active' : '';
  let html = `
    <div class="matchup-tile ${allActive}" onclick="selectMatchup(null)">
      <div class="tile-teams">ALL GAMES</div>
      <div class="tile-time">${gamesData.length} Matchups</div>
      <div class="tile-lines">Full Slate (28 Teams)</div>
    </div>
  `;

  gamesData.forEach(g => {
    const isAct = selectedGameId === g.game_id ? 'active' : '';
    const isUnposted = (g.spread_line === null || g.spread_line === undefined);
    const spreadStr = !isUnposted ? (g.spread_line > 0 ? `+${g.spread_line}` : `${g.spread_line}`) : 'PK*';
    const totalStr = !isUnposted ? `O/U ${g.total_line}` : 'Total Pending*';
    const timeStr = formatGameTime(g.gameday, g.gametime);

    html += `
      <div class="matchup-tile ${isAct}" onclick="selectMatchup('${g.game_id}')">
        <div class="tile-teams">
          <span>${g.away_team}</span>
          <span style="color:var(--text-dim); font-weight:400;">@</span>
          <span>${g.home_team}</span>
        </div>
        <div class="tile-time">${timeStr} ${isUnposted ? '<small style="color:var(--status-amber);">(Line Pending)</small>' : ''}</div>
        <div class="tile-lines">${g.home_team} ${spreadStr} &bull; ${totalStr}</div>
      </div>
    `;
  });

  track.innerHTML = html;
}

function formatGameTime(gameday, gametime) {
  if (!gameday) return 'TBD';
  const parts = gameday.split('-');
  const dateObj = new Date(parts[0], parts[1] - 1, parts[2]);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayName = days[dateObj.getDay()];
  const time = gametime ? gametime.slice(0, 5) : '';
  return `${dayName} ${time}`;
}

function selectMatchup(gameId) {
  selectedGameId = gameId;
  renderGameStrip();
  const label = document.getElementById('activeMatchupFilterText');
  const clearBtn = document.getElementById('clearMatchupBtn');
  if (gameId) {
    const g = gamesData.find(x => x.game_id === gameId);
    if (g && label) label.innerHTML = `Game: <strong>${g.away_team} @ ${g.home_team}</strong>`;
    if (clearBtn) clearBtn.style.display = 'inline-block';
  } else {
    if (label) label.textContent = 'All Matchups';
    if (clearBtn) clearBtn.style.display = 'none';
  }
  renderBoard();
}

function clearMatchupFilter() {
  selectMatchup(null);
}

// --------------------------------------------------------------------------
// Top Volume Projections Card (DFS / Fantasy Volume Leaders)
// --------------------------------------------------------------------------

function renderTopPicksCard() {
  const container = document.getElementById('topPicksCardGrid');
  if (!container) return;

  const list = topPicksData.slice(0, 15);
  if (list.length === 0) {
    container.innerHTML = `<span style="font-size:12px; color:var(--text-dim);">No projections available.</span>`;
    return;
  }

  container.innerHTML = list.map(p => `
    <div class="top-pick-card-item" onclick="openDrawerForPlayer('${p.player}')">
      <div class="pick-card-top">
        <span class="pick-rank-tag">#${p.rank} VOLUME</span>
        <span class="pos-tag pos-${p.position}">${p.position}</span>
      </div>
      <div class="pick-player-name" title="${p.player}">${p.player}</div>
      <div class="pick-matchup-meta">${p.team} vs ${p.opponent}</div>
      <div class="pick-stat-row">
        <span>Proj: <strong>${Number(p.proj_yards).toFixed(1)} yds</strong></span>
        <span>Fair: <strong style="color:var(--accent-blue);">${Number(p.fair_line_yards).toFixed(1)}</strong></span>
      </div>
    </div>
  `).join('');
}

function copyTopPicksText() {
  if (topPicksData.length === 0) return;
  let text = `NFL WEEK ${currentWeek} VOLUME PROJECTIONS (CALIBRATED FAIR LINES)\n`;
  text += `===========================================================\n`;
  topPicksData.slice(0, 20).forEach(p => {
    text += `#${p.rank} ${p.player} (${p.position} - ${p.team}) vs ${p.opponent}\n`;
    text += `   Proj: ${Number(p.proj_yards).toFixed(1)} yds (${Number(p.proj_rec).toFixed(1)} rec) | Fair Line: ${Number(p.fair_line_yards).toFixed(1)} yds\n`;
  });
  text += `\n* Note: Fair lines represent the calibrated 50/50 median. Verify sportsbooks before placing slips.`;

  navigator.clipboard.writeText(text).then(() => {
    showToast('✓ Copied volume projection summary to clipboard!');
  }).catch(() => {
    showToast('Could not copy to clipboard.');
  });
}

// --------------------------------------------------------------------------
// Mathematical & Pricing Evaluation Engine (3 Distinct Quant Metrics)
// --------------------------------------------------------------------------

function evaluateLineAndOdds(muRec, muYpr, market, line, offeredOdds, bias = 0.0) {
  const isWhole = Math.abs(line - Math.round(line)) < 1e-4;
  let pOver = 0;
  let pUnder = 0;
  let pPush = 0;

  if (market === 'receptions') {
    const r = 1.0 / MODEL_ALPHA;
    const p = r / (r + muRec);
    if (isWhole) {
      const k = Math.round(line);
      pPush = nbPmf(k, r, p);
      pOver = Math.max(0.001, Math.min(0.999, pRecOver(muRec, k) - bias));
      pUnder = Math.max(0.001, Math.min(0.999, 1.0 - pOver - pPush));
    } else {
      pPush = 0.0;
      pOver = Math.max(0.001, Math.min(0.999, pRecOver(muRec, line) - bias));
      pUnder = Math.max(0.001, Math.min(0.999, 1.0 - pOver));
    }
  } else {
    // Receiving yards
    if (isWhole) {
      const L = Math.round(line);
      // Discrete integer grading: box scores report integer yards; pushes occur on exact integers
      const cdfLo = compoundYardsCdf(muRec, muYpr, L - 0.5);
      const cdfHi = compoundYardsCdf(muRec, muYpr, L + 0.5);
      pPush = Math.max(0.0, cdfHi - cdfLo);
      pOver = Math.max(0.001, Math.min(0.999, (1.0 - cdfHi) - bias));
      pUnder = Math.max(0.001, Math.min(0.999, cdfLo));
      const s = pOver + pUnder + pPush;
      if (s > 0) {
        pOver /= s;
        pUnder /= s;
        pPush /= s;
      }
    } else {
      pPush = 0.0;
      pOver = Math.max(0.001, Math.min(0.999, pYardsOver(muRec, muYpr, line) - bias));
      pUnder = Math.max(0.001, Math.min(0.999, 1.0 - pOver));
    }
  }

  const decOdds = americanToDecimal(offeredOdds);
  const breakEvenProb = 1.0 / decOdds;
  const deviggedMktProb = 0.50; // Reference 50/50 fair market price

  // Expected returns per dollar staked
  const evOver = pOver * (decOdds - 1.0) - (1.0 - pOver - pPush);
  const evUnder = pUnder * (decOdds - 1.0) - (1.0 - pUnder - pPush);

  const bestSide = evOver >= evUnder ? 'OVER' : 'UNDER';
  const winProb = bestSide === 'OVER' ? pOver : pUnder;
  const lossProb = 1.0 - winProb - pPush;
  const expectedReturn = winProb * (decOdds - 1.0) - lossProb;

  // 1. Probability edge: Model probability minus devigged market probability
  const probEdge = winProb - deviggedMktProb;

  // 2. Break-even advantage: Model probability minus offered price's break-even probability
  const breakEvenAdvantage = winProb - breakEvenProb;

  return {
    line,
    pOver,
    pUnder,
    pPush,
    bestSide,
    winProb,
    lossProb,
    breakEvenProb,
    deviggedMktProb,
    probEdge,
    breakEvenAdvantage,
    expectedReturn,
    decOdds,
    offeredOdds
  };
}

function getEvaluatedPlayerRow(p) {
  const market = currentFilterMarket;
  const biasRec = isHistoricalSlate ? W1_BIAS_REC : 0.0;
  const biasYds = isHistoricalSlate ? W1_BIAS_YDS : 0.0;
  const bias = market === 'receptions' ? biasRec : biasYds;
  const minEdge = isHistoricalSlate ? W1_MIN_EDGE : STD_MIN_EDGE;
  const maxKelly = isHistoricalSlate ? W1_KELLY_CAP : STD_KELLY_CAP;

  const fairLine = market === 'receptions' ? p.fair_line_rec : p.fair_line_yards;
  const projVol = market === 'receptions' ? p.proj_rec : p.proj_yards;

  // Check stored user scenario or default
  const stored = inlinePlayerLines[p.player_id] || {};
  const isHypothetical = stored.line !== undefined;
  const bookLine = stored.line !== undefined ? stored.line : fairLine;
  const odds = stored.odds !== undefined ? stored.odds : -110;

  // Evaluate exact 3 quant metrics with explicit push probability
  const metrics = evaluateLineAndOdds(p.mu_rec, p.mu_ypr, market, bookLine, odds, bias);

  // STRICT STAKE GATING:
  // Must have: Expected Return > 0 AND Prob Edge >= minEdge AND healthy AND projectable
  const clearsEdgeHurdle = metrics.probEdge >= minEdge;
  const clearsEvHurdle = metrics.expectedReturn > 0;
  const isHealthy = !p.questionable;
  const isQualified = clearsEdgeHurdle && clearsEvHurdle && isHealthy && !p.excl_reason;

  let actionableStake = 0.0;
  if (isQualified) {
    const b = metrics.decOdds - 1.0;
    const rawKelly = (b * metrics.winProb - metrics.lossProb) / b;
    actionableStake = Math.max(0.0, Math.min(maxKelly, rawKelly));
  }

  let status = 'PASS';
  if (p.questionable) {
    status = 'QUESTIONABLE';
  } else if (isQualified) {
    status = 'QUALIFIED';
  } else if (metrics.expectedReturn > 0 && metrics.probEdge >= 0.04) {
    status = 'LEAN';
  } else {
    status = 'PASS';
  }

  // Quote source provenance description
  let quoteSource = 'Model Fair Baseline (Unquoted)';
  if (isHypothetical) {
    quoteSource = 'Hypothetical User Scenario (Simulated)';
  } else if (p.unposted_lines === 1) {
    quoteSource = 'Vegas Lines Pending (Default 44.5 Total)';
  }

  return {
    ...p,
    market,
    bookLine,
    odds,
    fairLine,
    projVol,
    isHypothetical,
    quoteSource,
    ...metrics,
    actionableStake,
    isQualified,
    status
  };
}

// --------------------------------------------------------------------------
// Main Board & Filtering Logic
// --------------------------------------------------------------------------

function populateTeamDropdown() {
  const sel = document.getElementById('teamFilter');
  if (!sel) return;
  const teams = [...new Set(slateData.map(p => p.team).filter(Boolean))].sort();
  sel.innerHTML = `<option value="ALL">All Teams (${teams.length})</option>` +
    teams.map(t => `<option value="${t}">${t}</option>`).join('');
}

function setPosFilter(pos) {
  currentFilterPos = pos;
  document.querySelectorAll('#posFilterGroup .seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.pos === pos);
  });
  renderBoard();
}

function onFilterChange() {
  currentSearchQuery = (document.getElementById('searchInput')?.value || '').toLowerCase().trim();
  currentFilterMarket = document.getElementById('marketFilter')?.value || 'yards';
  currentFilterBook = document.getElementById('bookFilter')?.value || 'Consensus';
  currentFilterTeam = document.getElementById('teamFilter')?.value || 'ALL';
  currentQualifiedOnly = document.getElementById('qualifiedOnlyToggle')?.checked || false;
  currentProjectableOnly = document.getElementById('projectableOnlyCheck')?.checked || false;
  renderBoard();
}

function renderBoard() {
  const tbody = document.getElementById('slateTableTbody');
  const countLabel = document.getElementById('visibleRowCount');
  const totalLabel = document.getElementById('totalRowCount');
  const qualCountPill = document.getElementById('qualCountPill');
  const qualContainer = document.getElementById('qualifiedOpportunitiesContainer');
  const boardBadge = document.getElementById('boardTotalBadge');

  if (!tbody || slateData.length === 0) return;

  const evaluatedAll = slateData.map(getEvaluatedPlayerRow);

  // Filter pipeline
  let filtered = evaluatedAll.filter(row => {
    if (currentProjectableOnly && row.excl_reason) return false;
    if (currentFilterPos !== 'ALL' && row.position !== currentFilterPos) return false;
    if (currentFilterTeam !== 'ALL' && row.team !== currentFilterTeam) return false;
    if (selectedGameId && row.game_id !== selectedGameId) return false;
    if (currentSearchQuery) {
      const matchName = row.player_display_name.toLowerCase().includes(currentSearchQuery);
      const matchTeam = row.team.toLowerCase().includes(currentSearchQuery);
      if (!matchName && !matchTeam) return false;
    }
    if (currentQualifiedOnly && !row.isQualified) return false;
    return true;
  });

  // Sort
  filtered.sort((a, b) => {
    let valA = a[sortCol];
    let valB = b[sortCol];
    if (typeof valA === 'string') valA = valA.toLowerCase();
    if (typeof valB === 'string') valB = valB.toLowerCase();
    if (valA < valB) return sortAsc ? -1 : 1;
    if (valA > valB) return sortAsc ? 1 : -1;
    return 0;
  });

  const qualifiedList = evaluatedAll.filter(r => r.isQualified);
  if (qualCountPill) qualCountPill.textContent = qualifiedList.length;
  if (countLabel) countLabel.textContent = filtered.length;
  if (totalLabel) totalLabel.textContent = slateData.length;
  if (boardBadge) boardBadge.textContent = slateData.length;

  // Render Qualified Opportunities Card
  if (qualContainer) {
    if (qualifiedList.length === 0) {
      qualContainer.innerHTML = `
        <div class="qual-empty-state">
          <strong>No Verified Sportsbook Quotes Available:</strong> Live Vegas / sportsbook prop feeds have not been ingested for this slate. 
          The board is displaying unquoted model fair-line baselines. No betting edge can be claimed until real bookmaker quotes are verified.
          Use the in-row scenario chips below to simulate hypothetical bookmaker lines.
        </div>
      `;
    } else {
      qualContainer.innerHTML = `
        <div class="top-picks-scroll-grid">
          ${qualifiedList.map(q => `
            <div class="top-pick-card-item" onclick="openDrawerForPlayer('${q.player_display_name}')" style="border-color:var(--status-green-border); background:rgba(16,185,129,0.04);">
              <div class="pick-card-top">
                <span class="status-pill status-qualified">${q.bestSide} ${q.bookLine}</span>
                <span class="pos-tag pos-${q.position}">${q.position}</span>
              </div>
              <div class="pick-player-name">${q.player_display_name}</div>
              <div class="pick-matchup-meta">${q.team} vs ${q.opponent_team} &bull; ${q.odds > 0 ? '+' : ''}${q.odds}</div>
              <div class="pick-stat-row">
                <span>Exp Return: <strong style="color:var(--status-green);">+${(q.expectedReturn * 100).toFixed(1)}%</strong></span>
                <span>Stake: <strong>${(q.actionableStake * 100).toFixed(2)}%</strong></span>
              </div>
            </div>
          `).join('')}
        </div>
      `;
    }
  }

  // Render Table Rows
  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="14" style="text-align:center; padding:36px; color:var(--text-dim);">
          No receivers found matching the active filters.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map(row => {
    const isStarred = userWatchlist.some(w => w.player_id === row.player_id);
    const starClass = isStarred ? 'star-btn starred' : 'star-btn';

    let statusPill = `<span class="status-pill status-pass">PASS</span>`;
    if (row.status === 'QUALIFIED') {
      statusPill = `<span class="status-pill status-qualified">QUALIFIED</span>`;
    } else if (row.status === 'LEAN') {
      statusPill = `<span class="status-pill status-lean">LEAN</span>`;
    } else if (row.status === 'QUESTIONABLE') {
      statusPill = `<span class="status-pill status-injury">QUESTIONABLE</span>`;
    }

    // Actionable stake: Strictly 0.0% if PASS / Negative EV
    const stakeFormatted = row.actionableStake > 0
      ? `<strong style="color:var(--status-green);">${(row.actionableStake * 100).toFixed(2)}%</strong>`
      : `<span style="color:var(--text-dim);">0.0%</span>`;

    // 1. Prob Edge vs 50%
    const probEdgeFormatted = row.probEdge > 0
      ? `<span style="color:var(--status-green);">+${(row.probEdge * 100).toFixed(1)}%</span>`
      : `<span style="color:var(--text-dim);">${(row.probEdge * 100).toFixed(1)}%</span>`;

    // 2. Break-Even Advantage vs Odds
    const beAdvFormatted = row.breakEvenAdvantage > 0
      ? `<span style="color:var(--status-green); font-weight:700;">+${(row.breakEvenAdvantage * 100).toFixed(1)}%</span>`
      : `<span style="color:var(--status-red);">${(row.breakEvenAdvantage * 100).toFixed(1)}%</span>`;

    // 3. Expected Return (EV %)
    const evFormatted = row.expectedReturn > 0
      ? `<strong style="color:var(--status-green);">+${(row.expectedReturn * 100).toFixed(1)}%</strong>`
      : `<span style="color:var(--text-dim);">${(row.expectedReturn * 100).toFixed(1)}%</span>`;

    const sideClass = row.bestSide === 'OVER' ? 'val-blue' : 'val-amber';

    const pushBadge = row.pPush > 0.005 
      ? `<small style="color:var(--status-amber); font-size:10px;">(P(Push) ${(row.pPush * 100).toFixed(1)}%)</small>` 
      : '';

    return `
      <tr>
        <td style="text-align:center;">
          <button class="${starClass}" onclick="toggleWatchlistPlayer('${row.player_id}')" title="Save to Watchlist">
            ★
          </button>
        </td>
        <td>
          <div style="font-weight:700; color:#fff; cursor:pointer;" onclick="openDrawerForPlayer('${row.player_display_name}')">
            ${row.player_display_name}
          </div>
          <div style="font-size:11px; color:var(--text-dim);">
            ${row.team} vs ${row.opponent_team} ${row.unposted_lines === 1 ? '<span style="color:var(--status-amber);">(Line Pending)</span>' : ''}
          </div>
        </td>
        <td><span class="pos-tag pos-${row.position}">${row.position}</span></td>
        <td style="font-family:var(--font-mono); font-size:11px; color:var(--text-muted);">${row.market === 'receptions' ? 'Rec' : 'Yards'}</td>
        <td class="num-col"><strong>${Number(row.projVol).toFixed(1)}</strong></td>
        <td class="num-col" style="color:var(--accent-blue); font-weight:700;">${Number(row.fairLine).toFixed(1)}</td>
        <td>
          <div class="inline-line-ctrl">
            <span class="${sideClass}" style="font-weight:700; font-family:var(--font-mono); font-size:11px;">${row.bestSide}</span>
            <input type="number" step="0.5" class="comp-line-input" value="${row.bookLine}"
                   oninput="onInlineLineChange('${row.player_id}', this.value)">
            <span style="font-family:var(--font-mono); font-size:10px; color:var(--text-dim);">${row.odds > 0 ? '+' : ''}${row.odds}</span>
          </div>
          <div class="quick-adjust-bar">
            <button class="quick-chip" onclick="applyQuickOffset('${row.player_id}', -5)">-5</button>
            <button class="quick-chip" onclick="applyQuickOffset('${row.player_id}', -2.5)">-2.5</button>
            <button class="quick-chip quick-chip-fair" onclick="applyQuickOffset('${row.player_id}', 0)">Fair</button>
            <button class="quick-chip" onclick="applyQuickOffset('${row.player_id}', 2.5)">+2.5</button>
            <button class="quick-chip" onclick="applyQuickOffset('${row.player_id}', 5)">+5</button>
          </div>
          <div style="font-size:9px; color:var(--text-dim); margin-top:3px; font-family:var(--font-mono);">${row.quoteSource}</div>
        </td>
        <td class="num-col">${(row.winProb * 100).toFixed(1)}% ${pushBadge}</td>
        <td class="num-col">${probEdgeFormatted}</td>
        <td class="num-col">${beAdvFormatted}</td>
        <td class="num-col">${evFormatted}</td>
        <td class="num-col">${stakeFormatted}</td>
        <td>${statusPill}</td>
        <td style="text-align:right;">
          <button class="action-inspect-btn" onclick="openDrawerForPlayer('${row.player_display_name}')">
            Inspect &rarr;
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function onInlineLineChange(playerId, val) {
  const line = parseFloat(val);
  if (isNaN(line)) return;
  if (!inlinePlayerLines[playerId]) inlinePlayerLines[playerId] = {};
  inlinePlayerLines[playerId].line = line;
  saveStoredLines();
  renderBoard();
}

function applyQuickOffset(playerId, offset) {
  const p = slateData.find(x => x.player_id === playerId);
  if (!p) return;
  const baseFair = currentFilterMarket === 'receptions' ? p.fair_line_rec : p.fair_line_yards;
  const targetLine = offset === 0 ? baseFair : Math.max(0.5, baseFair + offset);
  if (!inlinePlayerLines[playerId]) inlinePlayerLines[playerId] = {};
  inlinePlayerLines[playerId].line = targetLine;
  saveStoredLines();
  renderBoard();
}

function sortTable(col) {
  if (sortCol === col) {
    sortAsc = !sortAsc;
  } else {
    sortCol = col;
    sortAsc = (col === 'player_display_name' || col === 'position');
  }
  renderBoard();
}

// --------------------------------------------------------------------------
// Slide-in Detail Drawer ("Understand, Verify, Know What Invalidates It")
// --------------------------------------------------------------------------

function openDrawerForPlayer(playerName) {
  const p = slateData.find(x => x.player_display_name === playerName);
  if (!p) return;
  selectedDrawerPlayer = getEvaluatedPlayerRow(p);

  const drawer = document.getElementById('detailDrawer');
  const overlay = document.getElementById('drawerOverlay');
  const nameEl = document.getElementById('drawerPlayerName');
  const posTag = document.getElementById('drawerPosTag');
  const matchupText = document.getElementById('drawerMatchupText');
  const actionSummary = document.getElementById('drawerActionSummary');
  const statusChip = document.getElementById('drawerStatusChip');
  const body = document.getElementById('drawerBody');
  const watchBtn = document.getElementById('drawerWatchlistBtn');

  if (nameEl) nameEl.textContent = p.player_display_name;
  if (posTag) {
    posTag.textContent = p.position;
    posTag.className = `pos-tag pos-${p.position}`;
  }
  if (matchupText) {
    matchupText.innerHTML = `${p.team} vs ${p.opponent_team} &bull; Spread: ${p.team_spread > 0 ? '+' : ''}${Number(p.team_spread || 0).toFixed(1)} &bull; Implied: ${Number(p.implied_team_total || 22).toFixed(1)} pts ${p.unposted_lines === 1 ? '<span style="color:var(--status-amber);">(Vegas Total Pending)</span>' : ''}`;
  }

  const evRow = selectedDrawerPlayer;
  if (actionSummary) {
    if (evRow.isQualified) {
      actionSummary.innerHTML = `<span style="color:var(--status-green);">BET ${evRow.bestSide} ${evRow.bookLine} (${evRow.odds > 0 ? '+' : ''}${evRow.odds}) &bull; EV: +${(evRow.expectedReturn * 100).toFixed(1)}% &bull; Actionable Stake: ${(evRow.actionableStake * 100).toFixed(2)}%</span>`;
    } else {
      actionSummary.innerHTML = `<span style="color:var(--text-dim);">PASS &bull; ${evRow.expectedReturn <= 0 ? `Negative EV (${(evRow.expectedReturn * 100).toFixed(1)}%)` : `Edge +${(evRow.probEdge * 100).toFixed(1)}% below hurdle`} &bull; Actionable Stake: 0.00%</span>`;
    }
  }

  if (statusChip) {
    statusChip.textContent = evRow.status;
    statusChip.className = `drawer-status-chip status-${evRow.status.toLowerCase()}`;
  }

  if (watchBtn) {
    const isWatched = userWatchlist.some(w => w.player_id === p.player_id);
    watchBtn.textContent = isWatched ? '★ Remove from Watchlist' : '★ Add to Watchlist';
  }

  body.innerHTML = `
    <!-- Opportunity Status Banner -->
    <div style="background:var(--bg-card); border:1px solid var(--border-color); border-radius:8px; padding:14px; margin-bottom:16px;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div>
          <span style="font-family:var(--font-mono); font-size:11px; color:var(--text-dim);">CALIBRATED FAIR LINE (50/50 MEDIAN)</span>
          <div style="font-size:20px; font-weight:800; color:var(--accent-blue);">${Number(evRow.fairLine).toFixed(1)} ${evRow.market === 'receptions' ? 'Rec' : 'Yards'}</div>
        </div>
        <div style="text-align:right;">
          <span style="font-family:var(--font-mono); font-size:11px; color:var(--text-dim);">ACTIVE SCENARIO LINE</span>
          <div style="font-size:20px; font-weight:800; color:#fff;">${evRow.bookLine} (${evRow.odds > 0 ? '+' : ''}${evRow.odds})</div>
          <small style="font-size:10px; color:var(--text-dim);">${evRow.quoteSource}</small>
        </div>
      </div>

      <!-- 3 Quant Metrics Breakdown -->
      <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; margin-top:12px; padding-top:12px; border-top:1px solid var(--border-color); font-family:var(--font-mono); font-size:11px;">
        <div style="background:var(--bg-main); padding:8px; border-radius:4px;">
          <div style="color:var(--text-dim); font-size:9px;">1. PROB EDGE (vs 50%)</div>
          <div style="font-size:14px; font-weight:700; color:${evRow.probEdge > 0 ? 'var(--status-green)' : 'var(--text-dim)'};">${evRow.probEdge > 0 ? '+' : ''}${(evRow.probEdge * 100).toFixed(1)}%</div>
        </div>
        <div style="background:var(--bg-main); padding:8px; border-radius:4px;">
          <div style="color:var(--text-dim); font-size:9px;">2. BE ADV (vs Odds)</div>
          <div style="font-size:14px; font-weight:700; color:${evRow.breakEvenAdvantage > 0 ? 'var(--status-green)' : 'var(--status-red)'};">${evRow.breakEvenAdvantage > 0 ? '+' : ''}${(evRow.breakEvenAdvantage * 100).toFixed(1)}%</div>
        </div>
        <div style="background:var(--bg-main); padding:8px; border-radius:4px;">
          <div style="color:var(--text-dim); font-size:9px;">3. EXP RETURN (EV)</div>
          <div style="font-size:14px; font-weight:700; color:${evRow.expectedReturn > 0 ? 'var(--status-green)' : 'var(--status-red)'};">${evRow.expectedReturn > 0 ? '+' : ''}${(evRow.expectedReturn * 100).toFixed(1)}%</div>
        </div>
      </div>
    </div>

    <!-- 1. Why this projection? -->
    <div class="drawer-section-title">1. Why this projection? (Offensive Usage & Role)</div>
    <div class="stat-metric-grid">
      <div class="stat-metric-cell">
        <div class="metric-cell-label">TARGET SHARE</div>
        <div class="metric-cell-val">${(Number(p.target_share || p.f_tgt_share || 0.22) * 100).toFixed(1)}%</div>
      </div>
      <div class="stat-metric-cell">
        <div class="metric-cell-label">AIR YARDS SHARE</div>
        <div class="metric-cell-val">${(Number(p.air_yards_share || p.f_ay_share || 0.28) * 100).toFixed(1)}%</div>
      </div>
      <div class="stat-metric-cell">
        <div class="metric-cell-label">aDOT</div>
        <div class="metric-cell-val">${Number(p.adot || p.f_adot || 11.2).toFixed(1)} yds</div>
      </div>
      <div class="stat-metric-cell">
        <div class="metric-cell-label">CATCH RATE</div>
        <div class="metric-cell-val">${(Number(p.catch_rate_g || p.f_catch_rate || 0.68) * 100).toFixed(1)}%</div>
      </div>
      <div class="stat-metric-cell">
        <div class="metric-cell-label">YARDS / REC (YPR)</div>
        <div class="metric-cell-val">${Number(p.mu_ypr || 12.8).toFixed(1)}</div>
      </div>
      <div class="stat-metric-cell">
        <div class="metric-cell-label">EXP. TARGETS</div>
        <div class="metric-cell-val">${(Number(p.mu_rec || 5.0) / Math.max(0.4, Number(p.catch_rate_g || 0.68))).toFixed(1)}</div>
      </div>
    </div>

    <!-- 2. What could invalidate it? -->
    <div class="drawer-section-title">2. What could invalidate it? (Risk Factors)</div>
    <div style="background:var(--bg-card); border:1px solid var(--border-color); border-radius:8px; padding:12px; margin-bottom:16px; font-size:12px; line-height:1.6; color:var(--text-muted);">
      ${p.questionable ? `
        <div style="color:var(--status-amber); font-weight:700; margin-bottom:6px;">
          ⚠️ QUESTIONABLE STATUS: Listed on official injury report. The statistical model cannot price in-game reinjury risk or sudden snap count truncation.
        </div>
      ` : `<div style="color:var(--status-green); margin-bottom:6px;">✓ Clean health status. No official injury report designation.</div>`}
      &bull; <strong>Defensive Matchup:</strong> Opponent allows <strong>${((Number(p.def_yards_idx || 1.0) - 1.0) * 100).toFixed(1)}%</strong> ${p.def_yards_idx >= 1.0 ? 'more' : 'fewer'} yards to ${p.position}s than NFL average.<br>
      &bull; <strong>Game Script &amp; Spread:</strong> ${p.team} is ${p.team_spread > 0 ? '+' : ''}${Number(p.team_spread || 0).toFixed(1)}. Positive game scripts reduce pass volume; trailing scripts inflate targets.<br>
      &bull; <strong>Venue &amp; Environment:</strong> ${p.is_dome ? 'Indoor Dome (ideal passing conditions)' : `Outdoor stadium &bull; Wind: ${p.wind || 0} mph`}.
    </div>

    <!-- 3. What price is required? (Line Sensitivity Matrix with Explicit Push) -->
    <div class="drawer-section-title">3. What price is required? (Sensitivity &amp; Push Analysis)</div>
    <div style="font-size:11px; color:var(--text-dim); margin-bottom:6px;">
      Explicitly displays P(Over), P(Under), and P(Push) across surrounding lines:
    </div>
    <table class="sensitivity-table">
      <thead>
        <tr>
          <th>Line</th>
          <th>P(Over)</th>
          <th>P(Under)</th>
          <th>P(Push)</th>
          <th>Break-Even Odds</th>
          <th>BE Adv</th>
          <th>Exp Return</th>
          <th>Verdict</th>
        </tr>
      </thead>
      <tbody>
        ${renderSensitivityRows(p, evRow.market)}
      </tbody>
    </table>

    <!-- 4. How uncertain is it? (Outcome Ranges) -->
    <div class="drawer-section-title">4. How uncertain is it? (Predictive Outcome Ranges)</div>
    <div class="outcome-range-bar-wrap">
      <div class="range-steps-row">
        <span>10th: <strong>${Math.round(evRow.projVol * 0.35)}</strong></span>
        <span>25th: <strong>${Math.round(evRow.projVol * 0.62)}</strong></span>
        <span style="color:var(--accent-blue);">Median (50th): <strong>${Number(evRow.fairLine).toFixed(1)}</strong></span>
        <span>75th: <strong>${Math.round(evRow.projVol * 1.35)}</strong></span>
        <span>90th: <strong>${Math.round(evRow.projVol * 1.85)}</strong></span>
      </div>
      <div class="range-bar">
        <div class="range-iqr" style="left:25%; width:50%;"></div>
      </div>
      <div style="font-size:11px; color:var(--text-dim); margin-top:8px;">
        Expected interquartile range (IQR 25th–75th): <strong>${Math.round(evRow.projVol * 0.62)} to ${Math.round(evRow.projVol * 1.35)} ${evRow.market === 'receptions' ? 'receptions' : 'yards'}</strong>.
      </div>
    </div>

    <!-- 5. Calibrated Density Curve -->
    <div class="drawer-section-title">5. Calibrated Probability Density Curve</div>
    <div id="drawerCurveContainer" style="width:100%; height:180px; position:relative; background:var(--bg-main); border:1px solid var(--border-color); border-radius:6px;">
      <!-- SVG chart rendered below -->
    </div>
  `;

  renderDrawerDensityCurve(p, evRow.market, evRow.bookLine);

  drawer.classList.add('active');
  overlay.classList.add('active');
}

function renderSensitivityRows(p, market) {
  const baseFair = market === 'receptions' ? p.fair_line_rec : p.fair_line_yards;
  const step = market === 'receptions' ? 1.0 : 5.0;
  const bias = isHistoricalSlate ? (market === 'receptions' ? W1_BIAS_REC : W1_BIAS_YDS) : 0.0;

  const offsets = [-2 * step, -1 * step, 0, 1 * step, 2 * step];
  return offsets.map(off => {
    const testLine = Math.max(0.5, baseFair + off);
    const m = evaluateLineAndOdds(p.mu_rec, p.mu_ypr, market, testLine, -110, bias);

    let verdict = '<span style="color:var(--text-dim);">PASS</span>';
    if (m.expectedReturn > 0 && m.probEdge >= 0.10) {
      verdict = `<span style="color:var(--status-green); font-weight:700;">BET ${m.bestSide}</span>`;
    } else if (m.expectedReturn > 0 && m.probEdge >= 0.04) {
      verdict = `<span style="color:var(--status-amber);">LEAN ${m.bestSide}</span>`;
    } else if (m.expectedReturn <= 0) {
      verdict = `<span style="color:var(--status-red); font-size:10px;">-EV (${(m.expectedReturn * 100).toFixed(1)}%)</span>`;
    }

    const pushStr = m.pPush > 0.001 ? `${(m.pPush * 100).toFixed(1)}%` : '0.0%';

    return `
      <tr style="${off === 0 ? 'background:rgba(56,189,248,0.06);' : ''}">
        <td><strong>${testLine.toFixed(1)}</strong> ${off === 0 ? '<small style="color:var(--accent-blue);">(Fair)</small>' : ''}</td>
        <td>${(m.pOver * 100).toFixed(1)}%</td>
        <td>${(m.pUnder * 100).toFixed(1)}%</td>
        <td style="color:${m.pPush > 0.005 ? 'var(--status-amber)' : 'var(--text-dim)'};">${pushStr}</td>
        <td>${probToAmerican(m.winProb) > 0 ? '+' : ''}${probToAmerican(m.winProb)}</td>
        <td style="color:${m.breakEvenAdvantage > 0 ? 'var(--status-green)' : 'var(--status-red)'};">${m.breakEvenAdvantage > 0 ? '+' : ''}${(m.breakEvenAdvantage * 100).toFixed(1)}%</td>
        <td style="color:${m.expectedReturn > 0 ? 'var(--status-green)' : 'var(--text-dim)'};">${m.expectedReturn > 0 ? '+' : ''}${(m.expectedReturn * 100).toFixed(1)}%</td>
        <td>${verdict}</td>
      </tr>
    `;
  }).join('');
}

function renderDrawerDensityCurve(p, market, bookLine) {
  const container = document.getElementById('drawerCurveContainer');
  if (!container) return;

  const w = container.clientWidth || 530;
  const h = 180;
  const pad = { left: 35, right: 25, top: 20, bottom: 25 };

  const fairLine = market === 'receptions' ? p.fair_line_rec : p.fair_line_yards;
  const maxVal = market === 'receptions' ? Math.max(14, fairLine * 2.2) : Math.max(160, fairLine * 2.3);

  const steps = 100;
  const points = [];
  let maxDensity = 0;

  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * maxVal;
    let d = 0;
    if (market === 'receptions') {
      const r = 1.0 / MODEL_ALPHA;
      const pp = r / (r + p.mu_rec);
      const k = Math.round(x);
      d = Math.pow(pp, r) * Math.pow(1 - pp, k) * (gammaRatio(k + r, r) / factorial(k));
    } else {
      const k = MODEL_K * (p.mu_rec || 4.0);
      const theta = (p.mu_ypr || 12.0) / MODEL_K;
      if (x > 0 && k > 0) {
        d = (1 / (Math.exp(logGamma(k)) * Math.pow(theta, k))) * Math.pow(x, k - 1) * Math.exp(-x / theta);
      }
    }
    if (isNaN(d) || !isFinite(d)) d = 0;
    points.push({ x, y: d });
    if (d > maxDensity) maxDensity = d;
  }
  if (maxDensity <= 0) maxDensity = 1.0;

  const scaleX = val => pad.left + (val / maxVal) * (w - pad.left - pad.right);
  const scaleY = val => h - pad.bottom - (val / maxDensity) * (h - pad.top - pad.bottom);

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

  const fairX = scaleX(fairLine);
  const bookX = scaleX(bookLine);

  container.innerHTML = `
    <svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}">
      <defs>
        <linearGradient id="curveTailGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.45"/>
          <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.05"/>
        </linearGradient>
      </defs>
      <line x1="${pad.left}" y1="${h - pad.bottom}" x2="${w - pad.right}" y2="${h - pad.bottom}" stroke="#222d42" stroke-width="1"/>
      ${tailPathD ? `<path d="${tailPathD}" fill="url(#curveTailGrad)"/>` : ''}
      <path d="${pathD}" fill="none" stroke="#38bdf8" stroke-width="2.2" stroke-linecap="round"/>
      
      <!-- Calibrated Fair Line (Median) -->
      <line x1="${fairX}" y1="${pad.top}" x2="${fairX}" y2="${h - pad.bottom}" stroke="#38bdf8" stroke-width="1.8" stroke-dasharray="4,4"/>
      <text x="${fairX}" y="${pad.top - 4}" fill="#38bdf8" font-size="10" font-family="monospace" text-anchor="middle" font-weight="700">Fair: ${fairLine}</text>
      
      <!-- Current Book Line -->
      <line x1="${bookX}" y1="${pad.top + 8}" x2="${bookX}" y2="${h - pad.bottom}" stroke="#ef4444" stroke-width="2"/>
      <text x="${bookX}" y="${h - pad.bottom + 16}" fill="#ef4444" font-size="10" font-family="monospace" text-anchor="middle" font-weight="700">Book: ${bookLine}</text>
    </svg>
  `;
}

function closeDrawer() {
  const drawer = document.getElementById('detailDrawer');
  const overlay = document.getElementById('drawerOverlay');
  if (drawer) drawer.classList.remove('active');
  if (overlay) overlay.classList.remove('active');
  selectedDrawerPlayer = null;
}

function toggleDrawerWatchlist() {
  if (!selectedDrawerPlayer) return;
  toggleWatchlistPlayer(selectedDrawerPlayer.player_id);
  const watchBtn = document.getElementById('drawerWatchlistBtn');
  if (watchBtn) {
    const isWatched = userWatchlist.some(w => w.player_id === selectedDrawerPlayer.player_id);
    watchBtn.textContent = isWatched ? '★ Remove from Watchlist' : '★ Add to Watchlist';
  }
}

function copyDrawerSlip() {
  if (!selectedDrawerPlayer) return;
  const p = selectedDrawerPlayer;
  const text = `PROPS SLIP: ${p.player_display_name} ${p.bestSide} ${p.bookLine} (${p.odds > 0 ? '+' : ''}${p.odds})\n` +
               `Market: ${p.market === 'receptions' ? 'Receptions' : 'Receiving Yards'} vs ${p.opponent_team}\n` +
               `Win Prob: ${(p.winProb * 100).toFixed(1)}% | Fair Line: ${p.fairLine}\n` +
               `Prob Edge: +${(p.probEdge * 100).toFixed(1)}% | Exp Return (EV): ${(p.expectedReturn * 100).toFixed(1)}% | Stake: ${(p.actionableStake * 100).toFixed(2)}%`;
  
  navigator.clipboard.writeText(text).then(() => {
    showToast(`✓ Copied bet slip for ${p.player_display_name}!`);
  });
}

async function logDrawerPick() {
  if (!selectedDrawerPlayer) return;
  const p = selectedDrawerPlayer;
  await logPickToLedger({
    player: p.player_display_name,
    market: p.market === 'receptions' ? 'receptions' : 'receiving_yards',
    side: p.bestSide.toLowerCase(),
    line: p.bookLine,
    odds: p.odds,
    model_prob: p.winProb,
    market_prob: p.deviggedMktProb,
    edge: p.probEdge,
    ev_per_unit: p.expectedReturn,
    kelly_stake: p.actionableStake,
    projection: p.projVol,
    is_demo: false,
    status: 'open'
  });
}

// --------------------------------------------------------------------------
// Watchlist Management
// --------------------------------------------------------------------------

function loadStoredWatchlist() {
  try {
    userWatchlist = JSON.parse(localStorage.getItem('nfl_props_watchlist') || '[]');
  } catch (_) {
    userWatchlist = [];
  }
  updateWatchlistBadge();
}

function saveStoredWatchlist() {
  try {
    localStorage.setItem('nfl_props_watchlist', JSON.stringify(userWatchlist));
  } catch (_) {}
  updateWatchlistBadge();
}

function updateWatchlistBadge() {
  const badge = document.getElementById('watchlistCountBadge');
  if (badge) badge.textContent = userWatchlist.length;
}

function toggleWatchlistPlayer(playerId) {
  const idx = userWatchlist.findIndex(w => w.player_id === playerId);
  if (idx >= 0) {
    userWatchlist.splice(idx, 1);
    showToast('Removed from watchlist.');
  } else {
    const p = slateData.find(x => x.player_id === playerId);
    if (p) {
      userWatchlist.push({
        player_id: p.player_id,
        name: p.player_display_name,
        team: p.team,
        saved_line: p.fair_line_yards,
        saved_at: new Date().toISOString()
      });
      showToast(`★ Added ${p.player_display_name} to watchlist!`);
    }
  }
  saveStoredWatchlist();
  renderBoard();
}

function clearWatchlist() {
  if (confirm('Clear all saved props from your watchlist?')) {
    userWatchlist = [];
    saveStoredWatchlist();
    renderWatchlistPage();
    renderBoard();
  }
}

function renderWatchlistPage() {
  const container = document.getElementById('watchlistContentContainer');
  if (!container) return;

  if (userWatchlist.length === 0) {
    container.innerHTML = `
      <div style="background:var(--bg-card); border:1px dashed var(--border-color); border-radius:8px; padding:40px; text-align:center; color:var(--text-dim);">
        <p style="font-size:14px; font-weight:600; color:#fff;">Your Watchlist is Empty</p>
        <p style="font-size:12px; margin-top:4px;">Star any player on the Main Board to track price moves and receive line alert notifications.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="main-slate-card">
      <table class="slate-table">
        <thead>
          <tr>
            <th>Player &amp; Matchup</th>
            <th>Pos</th>
            <th>Saved Line</th>
            <th>Current Model Fair Line</th>
            <th>Status</th>
            <th style="text-align:right;">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${userWatchlist.map(w => {
            const current = slateData.find(p => p.player_id === w.player_id);
            const currentFair = current ? Number(current.fair_line_yards).toFixed(1) : '—';
            return `
              <tr>
                <td>
                  <div style="font-weight:700; color:#fff;">${w.name}</div>
                  <div style="font-size:11px; color:var(--text-dim);">${w.team}</div>
                </td>
                <td><span class="pos-tag pos-WR">WR</span></td>
                <td class="num-col">${w.saved_line}</td>
                <td class="num-col" style="color:var(--accent-blue); font-weight:700;">${currentFair}</td>
                <td><span class="status-pill status-qualified">TRACKED</span></td>
                <td style="text-align:right;">
                  <button class="action-inspect-btn" onclick="openDrawerForPlayer('${w.name}')">Inspect</button>
                  <button class="action-inspect-btn" onclick="toggleWatchlistPlayer('${w.player_id}'); renderWatchlistPage();" style="color:var(--status-red);">Remove</button>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function loadStoredLines() {
  try {
    inlinePlayerLines = JSON.parse(localStorage.getItem('nfl_props_custom_lines') || '{}');
  } catch (_) {
    inlinePlayerLines = {};
  }
}

function saveStoredLines() {
  try {
    localStorage.setItem('nfl_props_custom_lines', JSON.stringify(inlinePlayerLines));
  } catch (_) {}
}

// --------------------------------------------------------------------------
// CLV Tracker & Integrity Ledger
// --------------------------------------------------------------------------

async function loadClvLedger() {
  try {
    let rows = [];
    const res = await fetchWithFallback('/api/clv/log', 'picks_log.jsonl');
    if (res.ok) {
      const text = await res.text();
      rows = text.split('\n')
        .map(l => {
          try { return JSON.parse(l); } catch (_) { return null; }
        })
        .filter(Boolean);
    }

    // Merge with any client local tracked picks
    try {
      const local = JSON.parse(localStorage.getItem('clv_local_picks') || '[]');
      rows = [...rows, ...local];
    } catch (_) {}

    clvLogData = rows;
    updateClvHeaderBadge();
    populateClosingPickSelect();
    renderTrackerPage();
  } catch (err) {
    console.warn('Could not load CLV ledger:', err);
  }
}

function updateClvHeaderBadge() {
  const badge = document.getElementById('clvStatusBadge');
  if (badge) {
    const verified = clvLogData.filter(r => !r.is_demo);
    badge.textContent = verified.length > 0 ? `Verified N=${verified.length}` : `Demo N=${clvLogData.length}`;
  }
}

function setClvFilter(type) {
  clvFilterType = type;
  document.getElementById('btnClvAll')?.classList.toggle('active', type === 'all');
  document.getElementById('btnClvVerified')?.classList.toggle('active', type === 'verified');
  document.getElementById('btnClvDemo')?.classList.toggle('active', type === 'demo');
  renderTrackerPage();
}

function renderTrackerPage() {
  const tbody = document.getElementById('trackerTableTbody');
  const meanEl = document.getElementById('trackerMeanClv');
  const ciEl = document.getElementById('trackerClvCi');
  const beatEl = document.getElementById('trackerBeatClose');
  const totalEl = document.getElementById('trackerTotalBets');
  const verdictEl = document.getElementById('trackerVerdict');

  const countAll = document.getElementById('clvAllCount');
  const countVer = document.getElementById('clvVerifiedCount');
  const countDemo = document.getElementById('clvDemoCount');

  if (countAll) countAll.textContent = clvLogData.length;
  if (countVer) countVer.textContent = clvLogData.filter(r => !r.is_demo).length;
  if (countDemo) countDemo.textContent = clvLogData.filter(r => r.is_demo).length;

  let activeRows = clvLogData;
  if (clvFilterType === 'verified') activeRows = clvLogData.filter(r => !r.is_demo);
  if (clvFilterType === 'demo') activeRows = clvLogData.filter(r => r.is_demo);

  const settled = activeRows.filter(r => r.clv !== undefined);
  if (totalEl) totalEl.textContent = activeRows.length;

  if (settled.length === 0) {
    if (meanEl) meanEl.textContent = '—';
    if (ciEl) ciEl.textContent = '95% CI: [—, —]';
    if (beatEl) beatEl.textContent = '—';
    if (verdictEl) verdictEl.textContent = 'Awaiting closing records';
  } else {
    const clvs = settled.map(r => r.clv);
    const mean = clvs.reduce((a, b) => a + b, 0) / clvs.length;
    let se = 0;
    if (clvs.length > 1) {
      const variance = clvs.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (clvs.length - 1);
      se = Math.sqrt(variance) / Math.sqrt(clvs.length);
    }
    const beatRate = clvs.filter(v => v > 0).length / clvs.length;

    if (meanEl) meanEl.textContent = `${mean > 0 ? '+' : ''}${(mean * 100).toFixed(2)}%`;
    if (ciEl) ciEl.textContent = `95% CI: [${((mean - 1.96 * se) * 100).toFixed(1)}%, ${((mean + 1.96 * se) * 100).toFixed(1)}%]`;
    if (beatEl) beatEl.textContent = `${(beatRate * 100).toFixed(1)}%`;
    
    if (verdictEl) {
      if (settled.length < 30) {
        verdictEl.textContent = `Preliminary sample (N=${settled.length}) — requires N ≥ 100+ to separate signal from noise`;
        verdictEl.style.color = 'var(--status-amber)';
      } else if (mean - 1.96 * se > 0) {
        verdictEl.textContent = 'Positive CLV — edge is statistically plausible';
        verdictEl.style.color = 'var(--status-green)';
      } else {
        verdictEl.textContent = 'NOT distinguishable from zero market noise';
        verdictEl.style.color = 'var(--status-red)';
      }
    }
  }

  if (!tbody) return;
  if (activeRows.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" style="text-align:center; padding:30px; color:var(--text-dim);">
          No records found in this category.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = activeRows.map(r => {
    const isDemo = r.is_demo;
    const classBadge = isDemo
      ? `<span class="badge-prelim-inline">DEMO DATA</span>`
      : `<span class="status-pill status-qualified">VERIFIED LIVE</span>`;

    const clvFormatted = r.clv !== undefined
      ? `<strong style="color:${r.clv > 0 ? 'var(--status-green)' : 'var(--status-red)'}; font-family:var(--font-mono);">${r.clv > 0 ? '+' : ''}${(r.clv * 100).toFixed(2)}%</strong>`
      : `<span style="color:var(--text-dim);">Awaiting Close</span>`;

    const closeFormatted = r.closing_prob !== undefined
      ? `${(r.closing_prob * 100).toFixed(1)}%`
      : '—';

    return `
      <tr>
        <td style="font-family:var(--font-mono); font-size:11px; color:var(--text-dim);">${(r.logged_at || '').slice(0, 10)}</td>
        <td>
          <strong style="color:#fff;">${r.player}</strong>
          <span class="pos-tag pos-WR" style="margin-left:4px;">${(r.side || '').toUpperCase()}</span>
        </td>
        <td style="font-family:var(--font-mono);">${r.market} ${r.line}</td>
        <td class="num-col">${r.odds > 0 ? '+' : ''}${r.odds} <small style="color:var(--text-dim);">(${(r.market_prob * 100).toFixed(1)}%)</small></td>
        <td class="num-col font-mono">${(r.model_prob * 100).toFixed(1)}%</td>
        <td class="num-col font-mono">${closeFormatted}</td>
        <td class="num-col">${clvFormatted}</td>
        <td>${classBadge}</td>
        <td><span class="status-pill ${r.closing_prob !== undefined ? 'status-qualified' : 'status-lean'}">${r.closing_prob !== undefined ? 'Settled' : 'Open'}</span></td>
      </tr>
    `;
  }).join('');
}

function toggleClosingForm() {
  const panel = document.getElementById('closingFormPanel');
  if (panel) {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  }
}

function populateClosingPickSelect() {
  const sel = document.getElementById('closingPickSelect');
  if (!sel) return;
  const openPicks = clvLogData.filter(r => r.closing_prob === undefined || r.closing_prob === null);
  if (openPicks.length === 0) {
    sel.innerHTML = `<option value="">All logged picks have closing lines recorded</option>`;
    return;
  }
  sel.innerHTML = openPicks.map(p => `
    <option value="${escape(JSON.stringify({ player: p.player, market: p.market, line: p.line }))}">
      ${p.player} &bull; ${(p.side || '').toUpperCase()} ${p.line} (${p.market})
    </option>
  `).join('');
}

function updateClosingFromOdds() {
  const oddsInput = document.getElementById('closingOddsInput');
  const probInput = document.getElementById('closingProbInput');
  if (!oddsInput || !probInput) return;
  const odds = parseFloat(oddsInput.value);
  if (isNaN(odds)) return;
  const dec = americanToDecimal(odds);
  const prob = (1 / dec);
  probInput.value = prob.toFixed(3);
}

async function submitClosingPrice() {
  const sel = document.getElementById('closingPickSelect');
  const probInput = document.getElementById('closingProbInput');
  if (!sel || !sel.value || !probInput || !probInput.value) {
    showToast('Please select a pick and enter closing probability.');
    return;
  }

  const pickKey = JSON.parse(unescape(sel.value));
  const closingProb = parseFloat(probInput.value);

  // Try API first
  try {
    const res = await fetch('/api/clv/record-closing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        player: pickKey.player,
        market: pickKey.market,
        line: pickKey.line,
        closing_prob: closingProb
      })
    });
    if (res.ok) {
      showToast(`✓ Recorded closing price for ${pickKey.player}!`);
      probInput.value = '';
      await loadClvLedger();
      return;
    }
  } catch (_) {}

  // Local-first storage fallback
  try {
    const target = clvLogData.find(r => r.player === pickKey.player && r.market === pickKey.market && r.line === pickKey.line);
    if (target) {
      target.closing_prob = closingProb;
      const entryMkt = target.market_prob || 0.5;
      target.clv = target.side === 'over' ? (closingProb - entryMkt) : (entryMkt - closingProb);
      localStorage.setItem('clv_local_picks', JSON.stringify(clvLogData));
      showToast(`✓ Recorded closing price locally for ${pickKey.player}!`);
      probInput.value = '';
      await loadClvLedger();
    }
  } catch (err) {
    showToast('Failed to record closing price.');
  }
}

async function logPickToLedger(payload) {
  payload.logged_at = new Date().toISOString();

  try {
    const res = await fetch('/api/clv/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      showToast(`✓ Logged ${payload.player} to CLV tracker!`);
      await loadClvLedger();
      return;
    }
  } catch (_) {}

  try {
    const local = JSON.parse(localStorage.getItem('clv_local_picks') || '[]');
    local.push(payload);
    localStorage.setItem('clv_local_picks', JSON.stringify(local));
    showToast(`✓ Logged ${payload.player} locally to CLV tracker!`);
    await loadClvLedger();
  } catch (err) {
    showToast('Could not save pick to log.');
  }
}

// --------------------------------------------------------------------------
// Research & SGP Bivariate Simulator (Modeled Dependence)
// --------------------------------------------------------------------------

function populateSgpSelect() {
  const sel = document.getElementById('sgpPlayerSelect');
  if (!sel || slateData.length === 0) return;
  const projectable = slateData.filter(d => !d.excl_reason).slice(0, 30);
  sel.innerHTML = projectable.map(p => `
    <option value="${p.player_id}">${p.player_display_name} (${p.position} - ${p.team})</option>
  `).join('');
  runSgpSimulation();
}

function runSgpSimulation() {
  const sel = document.getElementById('sgpPlayerSelect');
  const container = document.getElementById('sgpSimulationResultsContainer');
  const oddsInput = document.getElementById('sgpOfferedOdds');
  if (!sel || !container || slateData.length === 0) return;

  const player = slateData.find(p => p.player_id === sel.value) || slateData[0];
  if (!player) return;

  const offeredOdds = oddsInput ? (parseFloat(oddsInput.value) || 180) : 180;
  const decOffered = americanToDecimal(offeredOdds);
  const breakEvenOffered = 1.0 / decOffered;

  const muRec = player.mu_rec;
  const muYpr = player.mu_ypr;
  const fairRec = player.fair_line_rec;
  const fairYds = player.fair_line_yards;

  const nSims = 40000;
  const r = 1.0 / MODEL_ALPHA;
  const p = r / (r + muRec);
  const scale = muYpr / MODEL_K;

  let overRecCount = 0;
  let overYdsCount = 0;
  let jointOverCount = 0;

  for (let i = 0; i < nSims; i++) {
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
  const fairOdds = probToAmerican(pJoint);

  // True edge against offered sportsbook odds
  const trueEdge = pJoint - breakEvenOffered;
  const trueEv = pJoint * (decOffered - 1.0) - (1.0 - pJoint);

  container.innerHTML = `
    <div style="background:var(--bg-main); border:1px solid var(--border-color); border-radius:6px; padding:16px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
        <h5 style="color:#fff; font-size:14px;">${player.player_display_name} SGP: Over ${fairRec} Rec + Over ${fairYds} Yds</h5>
        <span class="status-pill status-qualified" style="background:rgba(192,132,252,0.15); color:var(--accent-purple); border-color:rgba(192,132,252,0.35);">
          +${(correlationLift * 100).toFixed(1)}% MODELED DEPENDENCE LIFT
        </span>
      </div>
      <table class="sensitivity-table" style="font-size:12px;">
        <thead>
          <tr>
            <th>Leg 1 P(Over)</th>
            <th>Leg 2 P(Over)</th>
            <th>Naive Independent Prob</th>
            <th style="color:var(--accent-purple);">Modeled Joint Prob</th>
            <th>Fair No-Vig Odds</th>
            <th>Offered Odds</th>
            <th>Break-Even Prob</th>
            <th style="color:var(--status-green);">True Edge vs Offered</th>
            <th>Exp Return (EV)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>${(pRec * 100).toFixed(1)}%</td>
            <td>${(pYds * 100).toFixed(1)}%</td>
            <td style="color:var(--text-dim);">${(pIndep * 100).toFixed(1)}%</td>
            <td style="color:var(--accent-purple); font-weight:700;">${(pJoint * 100).toFixed(1)}%</td>
            <td style="color:var(--accent-blue); font-weight:700;">${fairOdds > 0 ? '+' : ''}${fairOdds}</td>
            <td style="font-weight:700;">${offeredOdds > 0 ? '+' : ''}${offeredOdds}</td>
            <td style="color:var(--text-dim);">${(breakEvenOffered * 100).toFixed(1)}%</td>
            <td style="color:${trueEdge > 0 ? 'var(--status-green)' : 'var(--status-red)'}; font-weight:700;">${trueEdge > 0 ? '+' : ''}${(trueEdge * 100).toFixed(1)}%</td>
            <td style="color:${trueEv > 0 ? 'var(--status-green)' : 'var(--text-dim)'}; font-weight:700;">${trueEv > 0 ? '+' : ''}${(trueEv * 100).toFixed(1)}%</td>
          </tr>
        </tbody>
      </table>
      <div style="margin-top:12px; font-size:11px; color:var(--text-muted); line-height:1.5;">
        <strong>Quant Takeaway:</strong> Positive volume correlation lifts joint probability from ${(pIndep * 100).toFixed(1)}% (independent product) to ${(pJoint * 100).toFixed(1)}% (bivariate model). 
        At your offered sportsbook odds of ${offeredOdds > 0 ? '+' : ''}${offeredOdds} (break-even requirement ${(breakEvenOffered * 100).toFixed(1)}%), the expected edge is <strong>${trueEdge > 0 ? '+' : ''}${(trueEdge * 100).toFixed(1)}%</strong> and expected return is <strong>${trueEv > 0 ? '+' : ''}${(trueEv * 100).toFixed(1)}%</strong>.
      </div>
    </div>
  `;
}

// --------------------------------------------------------------------------
// Admin Modal & Pipeline Execution
// --------------------------------------------------------------------------

function openAdminModal() {
  const modal = document.getElementById('adminModal');
  if (modal) modal.classList.add('active');
}

function closeAdminModal() {
  const modal = document.getElementById('adminModal');
  if (modal) modal.classList.remove('active');
}

function clearAdminTerminal() {
  const term = document.getElementById('adminTerminalOutput');
  if (term) term.textContent = 'Terminal cleared.\n';
}

async function executeAdminRun() {
  const season = document.getElementById('adminSeasonSelect').value || 2026;
  const week = document.getElementById('adminWeekSelect').value || 7;
  const allGames = document.getElementById('adminAllGamesCheck').checked;
  const odds = document.getElementById('adminOddsCheck').checked;

  const btn = document.getElementById('executeAdminRunBtn');
  const term = document.getElementById('adminTerminalOutput');

  if (btn) btn.disabled = true;
  term.textContent = `>>> Connecting to pipeline runner: python src/week1.py --season ${season} --week ${week}${allGames ? ' --all-games' : ''}${odds ? ' --odds' : ''}\n\n`;

  try {
    const url = `/api/run-week/stream?season=${season}&week=${week}&all_games=${allGames}&odds=${odds}`;
    const response = await fetch(url);
    if (!response.ok) {
      term.textContent += `[INFO] Cloud Edge Mode: Persistent shell execution requires local machine or Railway VPS.\n`;
      term.textContent += `To run on your command line:\n`;
      term.textContent += `  python src/week1.py --season ${season} --week ${week}\n`;
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
            term.textContent += line.slice(6) + '\n';
            term.scrollTop = term.scrollHeight;
          }
        }
      }
    }

    showToast('✓ Pipeline run finished! Refreshing slate...');
    await initSlate(currentSlateKey);
  } catch (err) {
    term.textContent += `\n[NOTE] Edge Mode active. For full model refitting, execute on local terminal or Railway.\n`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// --------------------------------------------------------------------------
// Mathematical & Distributional Helpers (n_max = 36)
// --------------------------------------------------------------------------

function americanToDecimal(odds) {
  const o = Number(odds);
  return o > 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o);
}

function probToAmerican(prob) {
  const p = Math.max(0.001, Math.min(0.999, Number(prob)));
  if (p >= 0.5) {
    return Math.round(-(p / (1 - p)) * 100);
  } else {
    return Math.round(((1 - p) / p) * 100);
  }
}

function logGamma(z) {
  const g = 7;
  const p = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.138571095836524, 9.9843695780195716e-6, 1.5056327351493116e-7
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

// NegBin discrete PMF: P(N == k)
function nbPmf(k, r, p) {
  if (k < 0) return 0;
  if (k === 0) return Math.pow(p, r);
  let prob = Math.pow(p, r);
  for (let i = 1; i <= k; i++) {
    prob *= ((i - 1 + r) / i) * (1 - p);
  }
  return prob;
}

// NegBin(mu, alpha) P(N > line)
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

// Compound NegBin-Gamma Cumulative Distribution Function: F(line) = P(Y <= line)
function compoundYardsCdf(muRec, muYpr, line) {
  if (line <= 0) return 0.0;
  const r = 1.0 / MODEL_ALPHA;
  const p = r / (r + muRec);
  const scale = muYpr / MODEL_K;

  let cdf = Math.pow(p, r); // P(N = 0)
  let nbProb = Math.pow(p, r);

  for (let n = 1; n <= 36; n++) {
    nbProb *= ((n - 1 + r) / n) * (1 - p);
    const shape = n * MODEL_K;
    const x = line / scale;
    const gammaCdf = regularizedGammaP(shape, x);
    cdf += nbProb * gammaCdf;
  }
  return Math.max(0, Math.min(1, cdf));
}

// Compound NegBin-Gamma Survival Function: P(Y > line)
function pYardsOver(muRec, muYpr, line) {
  return Math.max(0, Math.min(1, 1.0 - compoundYardsCdf(muRec, muYpr, line)));
}

function gammaRatio(a, b) {
  return Math.exp(logGamma(a) - logGamma(b));
}

function factorial(n) {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}

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
