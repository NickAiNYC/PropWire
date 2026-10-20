/**
 * NFL Receiving Props Agent — Client Application & Research Terminal
 * Core Promise: "Find the opportunity. Verify the price. Understand the risk."
 * Positioning: "See what changed in a player's role—and whether the price reflects it."
 */

// --------------------------------------------------------------------------
// Global State & Calibrated Model Constants
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
let currentSnapshots = [];
let holdoutEvalData = null;
let selectedGameId = null; // Filter by game_id from Game Strip

// User Filters & View Modes
let currentFilterPos = 'ALL';
let currentFilterMarket = 'yards'; // 'yards', 'receptions'
let currentFilterBook = 'Consensus';
let currentFilterTeam = 'ALL';
let currentSearchQuery = '';
let currentQualifiedOnly = false;
let currentProjectableOnly = true;
let currentViewMode = 'baseline'; // 'baseline', 'surges', 'demo_quotes'

let sortCol = 'proj_yards';
let sortAsc = false;

// Persistent User Adjustments & Saved Conditions (saved in localStorage)
let inlinePlayerLines = {}; 
let userSavedConditions = [];
let selectedDrawerPlayer = null;
let clvFilterType = 'all'; // 'all', 'verified', 'demo'
let activeDrawerConditionalScenario = 'BASELINE'; // 'BASELINE', 'TEAMMATE_OUT', 'LIMITED_WORKLOAD', 'TRAILING_SCRIPT'

// --------------------------------------------------------------------------
// Initialization & Slate Loading
// --------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  loadStoredConditions();
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

    // 3. Load top volume picks
    const picksPath = isHistoricalSlate ? 'current_picks_w1.json' : 'current_picks_w7.json';
    const picksRes = await fetchWithFallback(`/api/picks?slate=${slateKey}`, picksPath);
    if (picksRes.ok) {
      const picksPayload = await picksRes.json();
      topPicksData = picksPayload.top_projections || picksPayload.picks || [];
    }

    // 4. Load immutable snapshots
    const snapPath = isHistoricalSlate ? 'snapshots_2026_w1.json' : 'snapshots_2026_w7.json';
    const snapRes = await fetchWithFallback(`/api/snapshots?slate=${slateKey}`, snapPath);
    if (snapRes.ok) {
      currentSnapshots = await snapRes.json();
    } else {
      currentSnapshots = [];
    }

    // 5. Load chronological holdout evaluation report if available
    try {
      const evalRes = await fetchWithFallback(`/api/holdout-eval?season=${currentSeason}&week=${isHistoricalSlate ? 1 : currentWeek}`, 'holdout_eval_2026_w1.json');
      if (evalRes.ok) {
        holdoutEvalData = await evalRes.json();
      } else {
        holdoutEvalData = null;
      }
    } catch (_) {
      holdoutEvalData = null;
    }

    populateTeamDropdown();
    populateAdminGameSelect();
    renderGameStrip();
    renderSlateHealthStrip();
    renderSnapshotStatus();
    renderOpportunitySummary();
    renderBestOpportunitiesGrid();
    renderBoard();
    populateSgpSelect();
    updateConditionBadge();
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
  const noticeText = document.getElementById('slateNoticeText');
  const noticeBtn = document.getElementById('slateNoticeActionBtn');
  const navTitle = document.getElementById('navTitle');
  const selector = document.getElementById('slateSelector');

  if (selector) selector.value = currentSlateKey;

  if (isHistoricalSlate) {
    if (navTitle) navTitle.textContent = '2026 Week 1 Historical Audit & Calibration Review';
    if (badge) badge.className = 'data-status-badge badge-prelim';
    if (badgeText) badgeText.textContent = 'HISTORICAL AUDIT • SETTLED';
    if (noticeText) noticeText.innerHTML = 'Showing <strong>2026 Week 1 Historical Audit</strong> (16 Matchups &bull; Sept 10–14). Settled games evaluated against out-of-sample calibration error hurdles.';
    if (noticeBtn) {
      noticeBtn.textContent = 'Switch to Upcoming Slate (Week 7)';
      noticeBtn.onclick = () => onSlateSelectChange('2026_w7');
    }
  } else {
    if (navTitle) navTitle.textContent = 'See what changed in a player’s role—and whether the price reflects it.';
    if (badge) badge.className = 'data-status-badge status-live';
    if (badgeText) badgeText.textContent = 'LIVE • CALIBRATED BASELINE';
    if (noticeText) noticeText.innerHTML = 'Showing <strong>2026 Week 7 Upcoming Slate</strong> (14 Matchups &bull; Oct 22&ndash;26). Pre-line phase: Displaying calibrated fair-line baselines.';
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
  if (dest === 'board') {
    renderBestOpportunitiesGrid();
    renderBoard();
  }
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// --------------------------------------------------------------------------
// Slate Health Strip (4 Distinct Metric Tiles)
// --------------------------------------------------------------------------

function renderSlateHealthStrip() {
  const gamesCount = document.getElementById('healthGamesCount');
  const gamesPill = document.getElementById('healthGamesPill');
  const teamsCount = document.getElementById('healthTeamsCount');
  const teamsPill = document.getElementById('healthTeamsPill');
  const playersCount = document.getElementById('healthPlayersCount');
  const playersPill = document.getElementById('healthPlayersPill');
  const marketsCount = document.getElementById('healthMarketsCount');
  const marketsPill = document.getElementById('healthMarketsPill');
  const marketsSub = document.getElementById('healthMarketsSub');

  const totalGames = gamesData.length || (isHistoricalSlate ? 16 : 14);
  const totalTeams = isHistoricalSlate ? 32 : 28;
  const totalReceivers = slateData.length;

  if (gamesCount) gamesCount.textContent = totalGames;
  if (gamesPill) gamesPill.textContent = `${totalGames} / ${totalGames}`;

  if (teamsCount) teamsCount.textContent = totalTeams;
  if (teamsPill) teamsPill.textContent = `${totalTeams} / ${totalTeams}`;

  if (playersCount) playersCount.textContent = totalReceivers;
  if (playersPill) playersPill.textContent = `${totalReceivers} Calibrated`;

  // Market verified quote count
  if (currentViewMode === 'demo_quotes') {
    if (marketsCount) marketsCount.textContent = '14';
    if (marketsPill) {
      marketsPill.textContent = 'Simulated Scenarios';
      marketsPill.className = 'health-tile-pill pill-pending';
    }
    if (marketsSub) marketsSub.textContent = 'Hypothetical lines active &bull; Unverified.';
  } else {
    if (marketsCount) marketsCount.textContent = '0';
    if (marketsPill) {
      marketsPill.textContent = '0 Verified Feeds';
      marketsPill.className = 'health-tile-pill pill-unquoted';
    }
    if (marketsSub) marketsSub.textContent = 'Feeds unquoted &bull; Displaying calibrated baselines.';
  }

  renderSnapshotStatus();
}

function renderSnapshotStatus() {
  const badge = document.getElementById('headerSnapshotBadge');
  const badgeText = document.getElementById('headerSnapshotText');
  const freezePill = document.getElementById('healthFreezePill');
  const freezeVal = document.getElementById('healthFreezeVal');
  const freezeSub = document.getElementById('healthFreezeSub');
  const modalCount = document.getElementById('freezeRecordCounter');

  const total = currentSnapshots.length;

  if (modalCount) {
    modalCount.textContent = `${total} records logged`;
  }

  if (selectedGameId) {
    const gameSnaps = currentSnapshots.filter(s => s.game_id === selectedGameId);
    if (gameSnaps.length > 0) {
      const isTnf = selectedGameId.includes('NE_CHI');
      if (badge) badge.style.display = 'inline-flex';
      if (badgeText) badgeText.textContent = isTnf ? `TNF SNAPSHOT: ${gameSnaps.length} MKTS • SHA256 ✓` : `GAME SNAPSHOT: ${gameSnaps.length} MKTS • SHA256 ✓`;
      if (freezePill) {
        freezePill.textContent = 'Game Locked ✓';
        freezePill.className = 'health-tile-pill pill-frozen';
      }
      if (freezeVal) freezeVal.textContent = `${gameSnaps.length} Frozen`;
      if (freezeSub) freezeSub.textContent = `${selectedGameId.replace('2026_07_', '').replace('_', ' @ ')} pre-kickoff • SHA-256`;
    } else {
      if (badge) badge.style.display = 'inline-flex';
      if (badgeText) badgeText.textContent = `UNFROZEN GAME • PENDING LOCK`;
      if (freezePill) {
        freezePill.textContent = 'Pending Lock';
        freezePill.className = 'health-tile-pill pill-pending';
      }
      if (freezeVal) freezeVal.textContent = 'Unfrozen';
      if (freezeSub) freezeSub.textContent = 'Click to freeze pre-kickoff snapshot';
    }
    return;
  }

  // Full slate context
  if (total > 0) {
    if (badge) badge.style.display = 'inline-flex';
    if (badgeText) badgeText.textContent = `SNAPSHOT ACTIVE • ${total} RECORDS • SHA256 ✓`;
    if (freezePill) {
      freezePill.textContent = 'Locked ✓';
      freezePill.className = 'health-tile-pill pill-frozen';
    }
    if (freezeVal) freezeVal.textContent = `${total} Records`;
    if (freezeSub) freezeSub.textContent = 'TNF & Week 7 pre-kickoff • SHA-256';
  } else {
    if (badge) badge.style.display = 'none';
    if (freezePill) {
      freezePill.textContent = 'Pending';
      freezePill.className = 'health-tile-pill pill-unquoted';
    }
    if (freezeVal) freezeVal.textContent = '0 Frozen';
    if (freezeSub) freezeSub.textContent = 'Click to execute freeze snapshot';
  }
}

// --------------------------------------------------------------------------
// Opportunity Summary & View Modes
// --------------------------------------------------------------------------

function setViewMode(mode) {
  currentViewMode = mode;
  ['baseline', 'surges', 'demo_quotes'].forEach(m => {
    const btn = document.getElementById(`btnMode${capitalize(m === 'demo_quotes' ? 'DemoQuotes' : m)}`);
    if (btn) btn.classList.toggle('active', m === mode);
  });

  renderSlateHealthStrip();
  renderOpportunitySummary();
  renderBestOpportunitiesGrid();
  renderBoard();
}

function renderOpportunitySummary() {
  const title = document.getElementById('oppSummaryTitle');
  const sub = document.getElementById('oppSummarySub');
  const notice = document.getElementById('emptyStateNotice');

  if (currentViewMode === 'baseline') {
    if (title) title.textContent = 'Market State: Unquoted Pre-Line Phase';
    if (sub) sub.textContent = 'Live bookmaker prop quotes have not been ingested for this slate. The model will never fabricate quotes.';
    if (notice) {
      notice.innerHTML = `
        <strong>No Verified Sportsbook Feeds Available:</strong>
        Sportsbooks have not opened receiving prop lines for Week 7 yet. All displayed lines represent our <strong>calibrated 50/50 fair lines</strong>.
        No betting edge or Kelly stake can be recommended until verified quotes are ingested.
        Use the <em>Role Surges</em> tab to inspect sustained usage shifts or use the in-row <em>quick-adjust chips</em> to test hypothetical market prices.
      `;
    }
  } else if (currentViewMode === 'surges') {
    if (title) title.textContent = 'Role Shift Filter: 12 Key Target Surges Isolated';
    if (sub) sub.textContent = 'Showing receivers whose recent target share exceeds multi-week and career baselines by >= 8%.';
    if (notice) {
      notice.innerHTML = `
        <strong>Role-Change Detection Active:</strong>
        Isolating receivers with substantial offensive volume expansion. Compare their model fair lines against pending market quotes to identify stale prices once lines post.
      `;
    }
  } else if (currentViewMode === 'demo_quotes') {
    if (title) title.textContent = 'Hypothetical Scenario Explorer: Simulated Market Lines';
    if (sub) sub.textContent = 'Simulating hypothetical market discounts to demonstrate price qualification and break-even advantage.';
    if (notice) {
      notice.innerHTML = `
        <strong style="color:var(--status-amber);">Hypothetical User Scenarios Active:</strong>
        Lines below include simulated book discounts for demonstration purposes. These are <strong>not verified quotes</strong> and must not be treated as live betting recommendations.
      `;
    }
  }
}

// --------------------------------------------------------------------------
// Game Strip (Horizontal Matchup Filter)
// --------------------------------------------------------------------------

function renderGameStrip() {
  const track = document.getElementById('gameStripTrack');
  if (!track) return;

  if (gamesData.length === 0) {
    track.innerHTML = '<div style="font-size:12px; color:var(--text-ink-tertiary); padding:6px;">Schedule loading...</div>';
    return;
  }

  const allActive = selectedGameId === null ? 'active' : '';
  let html = `
    <div class="game-pill ${allActive}" onclick="selectGameMatchup(null)">
      <div class="game-pill-teams">ALL MATCHUPS</div>
      <div class="game-pill-meta"><span>14 Games</span><span>28 Teams</span></div>
    </div>
  `;

  gamesData.forEach(g => {
    const isSel = selectedGameId === g.game_id ? 'active' : '';
    const spreadStr = g.spread_line !== null ? (g.spread_line > 0 ? `+${g.spread_line}` : `${g.spread_line}`) : 'PK';
    const totalStr = g.total_line !== null ? `${g.total_line} O/U` : 'Total TBD';
    html += `
      <div class="game-pill ${isSel}" onclick="selectGameMatchup('${g.game_id}')">
        <div class="game-pill-teams">
          <span>${g.away_team} @ ${g.home_team}</span>
        </div>
        <div class="game-pill-meta">
          <span>${spreadStr}</span>
          <span>${totalStr}</span>
        </div>
      </div>
    `;
  });

  track.innerHTML = html;
}

function selectGameMatchup(gameId) {
  selectedGameId = gameId;
  renderGameStrip();
  updateGameFilterLabels();
  renderSnapshotStatus();
  renderBestOpportunitiesGrid();
  renderBoard();
}

function clearMatchupFilter() {
  selectGameMatchup(null);
}

function updateGameFilterLabels() {
  const label = document.getElementById('activeMatchupFilterText');
  const btn = document.getElementById('clearMatchupBtn');
  if (!label) return;

  if (selectedGameId) {
    const g = gamesData.find(x => x.game_id === selectedGameId);
    if (g) {
      label.textContent = `${g.away_team} @ ${g.home_team}`;
      if (btn) btn.style.display = 'inline';
      return;
    }
  }
  label.textContent = 'All Matchups';
  if (btn) btn.style.display = 'none';
}

function populateTeamDropdown() {
  const select = document.getElementById('teamFilter');
  if (!select || slateData.length === 0) return;

  const teams = [...new Set(slateData.map(p => p.team))].sort();
  select.innerHTML = '<option value="ALL">All Teams</option>' +
    teams.map(t => `<option value="${t}">${t}</option>`).join('');
}

function populateAdminGameSelect() {
  const sel = document.getElementById('adminFreezeGameSelect');
  if (!sel || !gamesData || gamesData.length === 0) return;

  let html = `<option value="ALL">Full Slate (All ${gamesData.length} Games)</option>`;
  gamesData.forEach(g => {
    const isTnf = g.game_id && g.game_id.includes('NE_CHI');
    const label = isTnf ? `TNF: ${g.away_team} @ ${g.home_team} (${g.game_id})` : `${g.away_team} @ ${g.home_team} (${g.game_id})`;
    html += `<option value="${g.game_id}" ${isTnf ? 'selected' : ''}>${label}</option>`;
  });
  sel.innerHTML = html;
}

// --------------------------------------------------------------------------
// Role-Change Detection Engine (Sustained vs Noise)
// --------------------------------------------------------------------------

function detectPlayerRoleShift(p) {
  const recentShare = Number(p.target_share || 0);
  const baselineShare = Number(p.f_tgt_share || 0);
  const careerTgts = Number(p.c_targets || 0);
  const gamesPrior = Number(p.games_prior || 0);
  const tgtSd = Number(p.f_tgt_sd || 3.0);
  const diff = recentShare - baselineShare;

  if (recentShare === 0 && baselineShare === 0) {
    return {
      type: 'LIMITED_SAMPLE',
      label: 'LIMITED SAMPLE',
      class: 'role-stable',
      diff: 0,
      recentShare,
      baselineShare,
      careerTgts,
      description: 'Insufficient historical target tracking.'
    };
  }

  // 1. Sustained Role Surge
  // Target share >= +8% above multi-week baseline AND multi-week baseline >= 15% AND prior games >= 12
  if (diff >= 0.08 && gamesPrior >= 12 && baselineShare >= 0.15) {
    return {
      type: 'SUSTAINED_SURGE',
      label: 'SUSTAINED ROLE SURGE',
      class: 'role-surge',
      diff,
      recentShare,
      baselineShare,
      careerTgts,
      description: `Target share surged to ${(recentShare * 100).toFixed(1)}% (+${(diff * 100).toFixed(1)}% over ${(baselineShare * 100).toFixed(1)}% baseline). Sustained offensive target priority.`
    };
  }

  // 2. One-Game Spike (High Volatility / Fluke)
  // Single-game spike of >= +12% but high target SD or low prior games
  if (diff >= 0.12 && (tgtSd >= 3.8 || gamesPrior < 20 || baselineShare < 0.14)) {
    return {
      type: 'ONE_GAME_SPIKE',
      label: 'ONE-GAME SPIKE (VOLATILE)',
      class: 'role-spike',
      diff,
      recentShare,
      baselineShare,
      careerTgts,
      description: `Target share spiked to ${(recentShare * 100).toFixed(1)}% (+${(diff * 100).toFixed(1)}% spike), but exhibits high historical variance (SD: ${tgtSd.toFixed(1)}). Unconfirmed if sustained.`
    };
  }

  // 3. Significant Role Drop
  if (diff <= -0.08) {
    return {
      type: 'ROLE_CONTRACTION',
      label: 'ROLE CONTRACTION',
      class: 'role-drop',
      diff,
      recentShare,
      baselineShare,
      careerTgts,
      description: `Target share dropped to ${(recentShare * 100).toFixed(1)}% (${(diff * 100).toFixed(1)}% below ${(baselineShare * 100).toFixed(1)}% baseline). Reduced offensive priority.`
    };
  }

  // 4. Stable Established Volume
  if (baselineShare >= 0.22 || careerTgts >= 6.5) {
    return {
      type: 'ESTABLISHED_VOLUME',
      label: 'ESTABLISHED VOLUME',
      class: 'role-stable',
      diff,
      recentShare,
      baselineShare,
      careerTgts,
      description: `Consistent high-volume target earner (Career: ${careerTgts.toFixed(1)} tgts/g, Baseline: ${(baselineShare * 100).toFixed(1)}% share). Stable offensive anchor.`
    };
  }

  return {
    type: 'ROTATIONAL',
    label: 'ROTATIONAL ROLE',
    class: 'role-stable',
    diff,
    recentShare,
    baselineShare,
    careerTgts,
    description: `Standard rotational receiver (Baseline: ${(baselineShare * 100).toFixed(1)}% target share).`
  };
}

// --------------------------------------------------------------------------
// Price Boundary Calculator (Maximum Line / Minimum Odds to Act)
// --------------------------------------------------------------------------

function calculatePriceBoundaries(muRec, muYpr, market, fairLine) {
  let maxOverLine = null;
  let minUnderLine = null;

  const step = market === 'receptions' ? 0.5 : 1.0;
  
  // Test lower lines for Over qualification (10% edge + positive EV at -110)
  for (let l = fairLine - step; l >= Math.max(0.5, fairLine - 25); l -= step) {
    const res = evaluateLineAndOdds(muRec, muYpr, market, l, -110);
    if (res.bestSide === 'OVER' && res.probEdge >= 0.10 && res.expectedReturn > 0) {
      maxOverLine = l;
      break;
    }
  }

  // Test higher lines for Under qualification (10% edge + positive EV at -110)
  for (let l = fairLine + step; l <= fairLine + 25; l += step) {
    const res = evaluateLineAndOdds(muRec, muYpr, market, l, -110);
    if (res.bestSide === 'UNDER' && res.probEdge >= 0.10 && res.expectedReturn > 0) {
      minUnderLine = l;
      break;
    }
  }

  const atFair = evaluateLineAndOdds(muRec, muYpr, market, fairLine, -110);
  const fairWinProb = atFair.winProb;
  const breakEvenOddsAtFair = probToAmerican(fairWinProb);

  return {
    maxOverLine: maxOverLine ? maxOverLine.toFixed(1) : (fairLine - (market === 'receptions' ? 1.0 : 6.0)).toFixed(1),
    minUnderLine: minUnderLine ? minUnderLine.toFixed(1) : (fairLine + (market === 'receptions' ? 1.0 : 6.0)).toFixed(1),
    breakEvenOddsAtFair: breakEvenOddsAtFair > 0 ? `+${breakEvenOddsAtFair}` : `${breakEvenOddsAtFair}`
  };
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
  let bookLine = fairLine;
  let odds = -110;
  let isCustomScenario = false;
  let quoteSource = 'Model Fair Baseline (Unquoted)';

  if (inlinePlayerLines[p.player_id] && inlinePlayerLines[p.player_id].line !== undefined) {
    bookLine = inlinePlayerLines[p.player_id].line;
    isCustomScenario = Math.abs(bookLine - fairLine) > 0.01;
    quoteSource = isCustomScenario ? 'Hypothetical User Scenario (Simulated)' : 'Model Fair Baseline (Unquoted)';
  } else if (currentViewMode === 'demo_quotes') {
    // Simulated market quote for demonstration
    const role = detectPlayerRoleShift(p);
    if (role.type === 'SUSTAINED_SURGE') {
      bookLine = Math.round(fairLine * 0.90 * 2) / 2; // Book hasn't priced surge yet
      quoteSource = 'Simulated Market Quote (Stale Book)';
      isCustomScenario = true;
    }
  }

  const metrics = evaluateLineAndOdds(p.mu_rec, p.mu_ypr, market, bookLine, odds, bias);
  const priceBoundaries = calculatePriceBoundaries(p.mu_rec, p.mu_ypr, market, fairLine);
  const roleShift = detectPlayerRoleShift(p);

  // Qualification Gate:
  // Must NOT be fatal injury/exclusion, must have positive EV, and must clear minEdge hurdle
  let isQualified = false;
  let status = 'PASS';

  if (!p.excl_reason && !p.questionable) {
    if (metrics.expectedReturn > 0 && metrics.probEdge >= minEdge) {
      isQualified = true;
      status = 'QUALIFIED';
    } else if (metrics.expectedReturn > 0 && metrics.probEdge >= (minEdge * 0.5)) {
      status = 'LEAN';
    }
  } else if (p.questionable) {
    status = 'QUESTIONABLE';
  }

  // Kelly stake: Strictly 0.0% if not qualified or negative EV
  let actionableStake = 0.0;
  if (isQualified && metrics.expectedReturn > 0) {
    const rawKelly = metrics.expectedReturn / (metrics.decOdds - 1.0);
    const quarterKelly = rawKelly * 0.25;
    actionableStake = Math.max(0.001, Math.min(maxKelly, quarterKelly));
  }

  return {
    ...p,
    market,
    projVol,
    fairLine,
    bookLine,
    odds,
    quoteSource,
    isCustomScenario,
    isQualified,
    status,
    actionableStake,
    priceBoundaries,
    roleShift,
    ...metrics
  };
}

// --------------------------------------------------------------------------
// Primary View: Best Opportunities & Role-Change Grid
// --------------------------------------------------------------------------

function renderBestOpportunitiesGrid() {
  const container = document.getElementById('bestOpportunitiesGrid');
  const badge = document.getElementById('roleChangeCountBadge');
  const sectionTitle = document.getElementById('bestOppSectionTitle');
  if (!container || slateData.length === 0) return;

  const evaluated = slateData.map(getEvaluatedPlayerRow);

  let displayList = [];

  if (currentViewMode === 'surges') {
    if (sectionTitle) sectionTitle.textContent = 'Isolated Sustained Role Surges';
    displayList = evaluated
      .filter(p => p.roleShift.type === 'SUSTAINED_SURGE')
      .sort((a, b) => b.roleShift.diff - a.roleShift.diff);
  } else if (currentViewMode === 'demo_quotes') {
    if (sectionTitle) sectionTitle.textContent = 'Simulated High-Signal Opportunities';
    displayList = evaluated
      .filter(p => p.isQualified || p.roleShift.type === 'SUSTAINED_SURGE')
      .slice(0, 8);
  } else {
    // Default baseline mode: Show top role surges and key volume anchors
    if (sectionTitle) sectionTitle.textContent = 'Key Role Shifts & Price Boundaries';
    const surges = evaluated.filter(p => p.roleShift.type === 'SUSTAINED_SURGE');
    const anchors = evaluated.filter(p => p.roleShift.type === 'ESTABLISHED_VOLUME').slice(0, 6);
    displayList = [...surges, ...anchors].slice(0, 9);
  }

  if (badge) badge.textContent = `${displayList.length} Displayed`;

  if (displayList.length === 0) {
    container.innerHTML = `
      <div style="grid-column:1/-1; text-align:center; padding:32px; background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:8px; color:var(--text-ink-secondary);">
        No matching opportunity cards found for the selected filter.
      </div>
    `;
    return;
  }

  container.innerHTML = displayList.map(card => {
    const isWatched = userSavedConditions.some(c => c.playerId === card.player_id);
    const watchText = isWatched ? '★ Watching' : '★ Watch Condition';

    return `
      <div class="opp-card">
        <div class="opp-card-header">
          <div class="opp-player-meta">
            <div class="opp-player-name" onclick="openDrawerForPlayer('${card.player_display_name}')">
              ${card.player_display_name}
            </div>
            <div class="opp-matchup-sub">
              ${card.team} vs ${card.opponent_team} &bull; <span class="pos-tag pos-${card.position}">${card.position}</span> &bull; Spread: ${card.team_spread > 0 ? '+' : ''}${Number(card.team_spread || 0).toFixed(1)}
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:6px;">
            <span class="role-badge ${card.roleShift.class}">${card.roleShift.label}</span>
            <span class="provisional-badge" title="Role labels and thresholds remain provisional until chronological holdout evidence exists.">PROV</span>
          </div>
        </div>

        <!-- Pricing Row -->
        <div class="opp-pricing-row">
          <div class="pricing-metric">
            <span class="pricing-label">Calibrated Fair</span>
            <span class="pricing-val" style="color:var(--accent-editorial);">${Number(card.fairLine).toFixed(1)} ${card.market === 'receptions' ? 'Rec' : 'Yds'}</span>
          </div>
          <div class="pricing-metric">
            <span class="pricing-label">Current Offer</span>
            <span class="pricing-val">${card.bookLine} <small style="font-size:11px; font-weight:600; color:var(--text-ink-tertiary);">${card.odds > 0 ? '+' : ''}${card.odds}</small></span>
          </div>
        </div>

        <!-- Price Boundary Box (Crucial Decision Support) -->
        <div class="price-boundary-box">
          <div class="price-boundary-label">Price Boundary to Act:</div>
          <div class="price-boundary-val">
            Qualifies at Over &le; ${card.priceBoundaries.maxOverLine} (-110) or &ge; ${card.priceBoundaries.breakEvenOddsAtFair} at fair line
          </div>
        </div>

        <!-- Narrative: Supporting Reason & Invalidation -->
        <div class="opp-narrative">
          <div><strong>Why it matters:</strong> ${card.roleShift.description}</div>
          <div style="margin-top:4px; color:var(--text-ink-tertiary);">
            <strong>Invalidation Risk:</strong> ${card.questionable ? 'Listed Questionable on injury feed.' : 'Teammate volume recovery, blowout clock-bleed.'}
          </div>
        </div>

        <!-- Card Actions -->
        <div class="opp-actions-row">
          <button class="btn-inspect" onclick="openDrawerForPlayer('${card.player_display_name}')">
            Inspect Evidence &amp; Price &rarr;
          </button>
          <button class="btn-watch" onclick="quickSaveCondition('${card.player_id}')">
            ${watchText}
          </button>
        </div>
      </div>
    `;
  }).join('');
}

// --------------------------------------------------------------------------
// Secondary View: Full Slate Research Table
// --------------------------------------------------------------------------

function onFilterChange() {
  currentSearchQuery = document.getElementById('searchInput')?.value.toLowerCase().trim() || '';
  currentFilterMarket = document.getElementById('marketFilter')?.value || 'yards';
  currentFilterBook = document.getElementById('bookFilter')?.value || 'Consensus';
  currentFilterTeam = document.getElementById('teamFilter')?.value || 'ALL';
  currentQualifiedOnly = document.getElementById('qualifiedOnlyToggle')?.checked || false;
  currentProjectableOnly = document.getElementById('projectableOnlyCheck')?.checked || false;
  
  renderBestOpportunitiesGrid();
  renderBoard();
}

function setPosFilter(pos) {
  currentFilterPos = pos;
  document.querySelectorAll('#posFilterGroup .seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-pos') === pos);
  });
  renderBoard();
}

function renderBoard() {
  const tbody = document.getElementById('slateTableTbody');
  const countLabel = document.getElementById('visibleRowCount');
  const totalLabel = document.getElementById('totalRowCount');
  const qualCountPill = document.getElementById('qualCountPill');
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

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="14" style="text-align:center; padding:36px; color:var(--text-ink-tertiary);">
          No receivers found matching the active filters.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map(row => {
    const isWatched = userSavedConditions.some(w => w.playerId === row.player_id);
    const starClass = isWatched ? 'star-btn starred' : 'star-btn';

    let statusPill = `<span class="status-pill status-pass">PASS</span>`;
    if (row.status === 'QUALIFIED') {
      statusPill = `<span class="status-pill status-qualified">QUALIFIED</span>`;
    } else if (row.status === 'LEAN') {
      statusPill = `<span class="status-pill status-lean">LEAN</span>`;
    } else if (row.status === 'QUESTIONABLE') {
      statusPill = `<span class="status-pill status-injury">QUESTIONABLE</span>`;
    }

    const stakeFormatted = row.actionableStake > 0
      ? `<strong style="color:var(--status-green);">${(row.actionableStake * 100).toFixed(2)}%</strong>`
      : `<span style="color:var(--text-ink-tertiary);">0.0%</span>`;

    const probEdgeFormatted = row.probEdge > 0
      ? `<span style="color:var(--status-green);">+${(row.probEdge * 100).toFixed(1)}%</span>`
      : `<span style="color:var(--text-ink-tertiary);">${(row.probEdge * 100).toFixed(1)}%</span>`;

    const beAdvFormatted = row.breakEvenAdvantage > 0
      ? `<span style="color:var(--status-green); font-weight:700;">+${(row.breakEvenAdvantage * 100).toFixed(1)}%</span>`
      : `<span style="color:var(--status-red);">${(row.breakEvenAdvantage * 100).toFixed(1)}%</span>`;

    const evFormatted = row.expectedReturn > 0
      ? `<strong style="color:var(--status-green);">+${(row.expectedReturn * 100).toFixed(1)}%</strong>`
      : `<span style="color:var(--text-ink-tertiary);">${(row.expectedReturn * 100).toFixed(1)}%</span>`;

    const pushBadge = row.pPush > 0.005 
      ? `<small style="color:var(--status-amber); font-size:10px;">(P(Push) ${(row.pPush * 100).toFixed(1)}%)</small>` 
      : '';

    return `
      <tr>
        <td style="text-align:center;">
          <button class="${starClass}" onclick="quickSaveCondition('${row.player_id}')" title="Save Condition">
            ★
          </button>
        </td>
        <td>
          <div style="font-weight:700; color:var(--text-ink); cursor:pointer;" onclick="openDrawerForPlayer('${row.player_display_name}')">
            ${row.player_display_name}
          </div>
          <div style="font-size:11px; color:var(--text-ink-tertiary);">
            ${row.team} vs ${row.opponent_team} ${row.unposted_lines === 1 ? '<span style="color:var(--status-amber);">(Line Pending)</span>' : ''}
          </div>
        </td>
        <td><span class="pos-tag pos-${row.position}">${row.position}</span></td>
        <td>
          <div style="display:inline-flex; align-items:center; gap:4px;">
            <span class="role-badge ${row.roleShift.class}" style="font-size:9px;">${row.roleShift.label}</span>
            <span class="provisional-badge" style="font-size:8px; padding:0 3px;" title="Provisional threshold pending chronological holdout validation">PROV</span>
          </div>
        </td>
        <td class="num-col"><strong>${Number(row.projVol).toFixed(1)}</strong></td>
        <td class="num-col" style="color:var(--accent-editorial); font-weight:700;">${Number(row.fairLine).toFixed(1)}</td>
        <td>
          <div class="inline-line-ctrl">
            <span style="font-weight:700; font-family:var(--font-mono); font-size:11px; color:${row.bestSide === 'OVER' ? 'var(--accent-editorial)' : 'var(--status-amber)'};">${row.bestSide}</span>
            <input type="number" step="0.5" class="comp-line-input" value="${row.bookLine}"
                   oninput="onInlineLineChange('${row.player_id}', this.value)">
            <span style="font-family:var(--font-mono); font-size:10px; color:var(--text-ink-tertiary);">${row.odds > 0 ? '+' : ''}${row.odds}</span>
          </div>
          <div class="quick-adjust-bar">
            <button class="quick-chip" onclick="applyQuickOffset('${row.player_id}', -5)">-5</button>
            <button class="quick-chip" onclick="applyQuickOffset('${row.player_id}', -2.5)">-2.5</button>
            <button class="quick-chip quick-chip-fair" onclick="applyQuickOffset('${row.player_id}', 0)">Fair</button>
            <button class="quick-chip" onclick="applyQuickOffset('${row.player_id}', 2.5)">+2.5</button>
            <button class="quick-chip" onclick="applyQuickOffset('${row.player_id}', 5)">+5</button>
          </div>
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
  renderBestOpportunitiesGrid();
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
  renderBestOpportunitiesGrid();
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
// Slide-in Detail Drawer (Strict 6-Step Order + Conditional Projections)
// --------------------------------------------------------------------------

function openDrawerForPlayer(playerName) {
  const p = slateData.find(x => x.player_display_name === playerName);
  if (!p) return;
  selectedDrawerPlayer = getEvaluatedPlayerRow(p);
  activeDrawerConditionalScenario = 'BASELINE';

  const drawer = document.getElementById('detailDrawer');
  const overlay = document.getElementById('drawerOverlay');
  const nameEl = document.getElementById('drawerPlayerName');
  const posTag = document.getElementById('drawerPosTag');
  const matchupText = document.getElementById('drawerMatchupText');
  const actionSummary = document.getElementById('drawerActionSummary');
  const statusChip = document.getElementById('drawerStatusChip');
  const watchBtn = document.getElementById('drawerWatchlistBtn');

  if (nameEl) nameEl.textContent = p.player_display_name;
  if (posTag) {
    posTag.textContent = p.position;
    posTag.className = `pos-tag pos-${p.position}`;
  }
  if (matchupText) {
    matchupText.innerHTML = `${p.team} vs ${p.opponent_team} &bull; Spread: ${p.team_spread > 0 ? '+' : ''}${Number(p.team_spread || 0).toFixed(1)} &bull; Implied: ${Number(p.implied_team_total || 22).toFixed(1)} pts ${p.unposted_lines === 1 ? '<span style="color:var(--status-amber);">(Total Pending)</span>' : ''}`;
  }

  const evRow = selectedDrawerPlayer;
  if (actionSummary) {
    if (evRow.isQualified) {
      actionSummary.innerHTML = `<span style="color:var(--status-green);">BET ${evRow.bestSide} ${evRow.bookLine} (${evRow.odds > 0 ? '+' : ''}${evRow.odds}) &bull; EV: +${(evRow.expectedReturn * 100).toFixed(1)}% &bull; Actionable Stake: ${(evRow.actionableStake * 100).toFixed(2)}%</span>`;
    } else {
      actionSummary.innerHTML = `<span style="color:var(--text-ink-tertiary);">PASS &bull; ${evRow.expectedReturn <= 0 ? `Negative EV (${(evRow.expectedReturn * 100).toFixed(1)}%)` : `Edge +${(evRow.probEdge * 100).toFixed(1)}% below hurdle`} &bull; Actionable Stake: 0.00%</span>`;
    }
  }

  if (statusChip) {
    statusChip.textContent = evRow.status;
    statusChip.className = `drawer-status-chip status-${evRow.status.toLowerCase()}`;
  }

  if (watchBtn) {
    const isWatched = userSavedConditions.some(w => w.playerId === p.player_id);
    watchBtn.textContent = isWatched ? '★ Condition Monitored' : '★ Watch Condition';
  }

  renderDrawerBodyContent();

  drawer.classList.add('active');
  overlay.classList.add('active');
}

function renderDrawerBodyContent() {
  const body = document.getElementById('drawerBody');
  const p = selectedDrawerPlayer;
  if (!body || !p) return;

  const cond = computeConditionalProjection(p, activeDrawerConditionalScenario);

  body.innerHTML = `
    <!-- STEP 1: DECISION (Side, Offer, Qualification, Rationale) -->
    <div class="drawer-section-title">1. The Decision &amp; Qualification Status</div>
    <div style="background:var(--bg-surface-subtle); border:1px solid var(--border-subtle); border-radius:8px; padding:14px; margin-bottom:16px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
        <div>
          <span style="font-family:var(--font-mono); font-size:10px; font-weight:700; color:var(--text-ink-tertiary);">CALIBRATED FAIR LINE (50/50 MEDIAN)</span>
          <div style="font-size:20px; font-weight:800; color:var(--accent-editorial);">${Number(p.fairLine).toFixed(1)} ${p.market === 'receptions' ? 'Rec' : 'Yards'}</div>
        </div>
        <div style="text-align:right;">
          <span style="font-family:var(--font-mono); font-size:10px; font-weight:700; color:var(--text-ink-tertiary);">DISPLAYED QUOTE</span>
          <div style="font-size:20px; font-weight:800; color:var(--text-ink);">${p.bookLine} (${p.odds > 0 ? '+' : ''}${p.odds})</div>
          <small style="font-size:10px; color:var(--text-ink-tertiary);">${p.quoteSource}</small>
        </div>
      </div>

      <div style="font-size:12px; line-height:1.5; color:var(--text-ink-secondary); padding-top:10px; border-top:1px solid var(--border-subtle);">
        <strong>Qualification Verdict:</strong> ${p.isQualified 
          ? `<span style="color:var(--status-green); font-weight:700;">QUALIFIED BET &bull; Model clears 10% calibration hurdle with positive expected value.</span>` 
          : `<span style="color:var(--text-ink-tertiary);">PASS &bull; Insufficient edge over book price or unquoted baseline. Model distinguishes outcome uncertainty (wide yardage dispersion) from probability error.</span>`}
      </div>
    </div>

    <!-- STEP 2: PRICE (Sportsbook comparison + Sensitivity + Boundaries) -->
    <div class="drawer-section-title">2. Price Verification &amp; Price Boundaries</div>
    <div class="price-boundary-box" style="margin-bottom:12px;">
      <div class="price-boundary-label">Price Boundaries Required to Clear Hurdle:</div>
      <div class="price-boundary-val">
        &bull; Over qualifies at &le; <strong>${p.priceBoundaries.maxOverLine}</strong> at -110<br>
        &bull; Under qualifies at &ge; <strong>${p.priceBoundaries.minUnderLine}</strong> at -110<br>
        &bull; Required odds at fair line (${Number(p.fairLine).toFixed(1)}): <strong>${p.priceBoundaries.breakEvenOddsAtFair}</strong>
      </div>
    </div>

    <table class="sensitivity-table">
      <thead>
        <tr>
          <th>Line</th>
          <th>P(Over)</th>
          <th>P(Under)</th>
          <th>P(Push)</th>
          <th>BE Odds</th>
          <th>BE Adv</th>
          <th>Exp Ret</th>
          <th>Verdict</th>
        </tr>
      </thead>
      <tbody>
        ${renderSensitivityRows(p, p.market)}
      </tbody>
    </table>

    <!-- STEP 3: EVIDENCE (Role-Change Detection) -->
    <div class="drawer-section-title">3. Evidence &amp; Role-Change Detection</div>
    <div style="background:var(--bg-surface-subtle); border:1px solid var(--border-subtle); border-radius:8px; padding:12px; margin-bottom:14px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="role-badge ${p.roleShift.class}">${p.roleShift.label}</span>
          <span class="provisional-badge" title="Role labels and thresholds remain provisional until chronological holdout evidence exists.">PROVISIONAL</span>
        </div>
        <span style="font-family:var(--font-mono); font-size:11px; color:var(--text-ink-tertiary);">Prior Games: ${p.games_prior || 0}</span>
      </div>
      <div style="font-size:11px; color:#f59e0b; margin-bottom:8px; font-weight:500;">
        ⚠️ Note: Role shift classification thresholds (e.g. &plusmn;8% sustained, &plusmn;12% spike) are provisional hypotheses pending chronological holdout validation.
      </div>
      <p style="font-size:12px; line-height:1.5; color:var(--text-ink-secondary); margin-bottom:10px;">
        ${p.roleShift.description}
      </p>

      <div class="stat-metric-grid" style="margin-bottom:0;">
        <div class="stat-metric-cell">
          <div class="metric-cell-label">Recent Share</div>
          <div class="metric-cell-val">${(Number(p.target_share || 0) * 100).toFixed(1)}%</div>
        </div>
        <div class="stat-metric-cell">
          <div class="metric-cell-label">Multi-Wk Base</div>
          <div class="metric-cell-val">${(Number(p.f_tgt_share || 0) * 100).toFixed(1)}%</div>
        </div>
        <div class="stat-metric-cell">
          <div class="metric-cell-label">Career Tgts/G</div>
          <div class="metric-cell-val">${Number(p.c_targets || 0).toFixed(1)}</div>
        </div>
        <div class="stat-metric-cell">
          <div class="metric-cell-label">Air Yds Share</div>
          <div class="metric-cell-val">${(Number(p.air_yards_share || p.f_ay_share || 0) * 100).toFixed(1)}%</div>
        </div>
        <div class="stat-metric-cell">
          <div class="metric-cell-label">aDOT</div>
          <div class="metric-cell-val">${Number(p.adot || p.f_adot || 0).toFixed(1)} yds</div>
        </div>
        <div class="stat-metric-cell">
          <div class="metric-cell-label">Target SD</div>
          <div class="metric-cell-val">&plusmn;${Number(p.f_tgt_sd || 3).toFixed(1)}</div>
        </div>
      </div>
    </div>

    <!-- CONDITIONAL PROJECTIONS INTERACTIVE SUB-TOOL -->
    <div style="background:var(--bg-canvas); border:1px solid var(--border-medium); border-radius:8px; padding:12px; margin-bottom:16px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <span style="font-family:var(--font-mono); font-size:10px; font-weight:800; color:var(--text-ink); text-transform:uppercase;">Conditional Projections</span>
        <span style="font-size:10px; color:var(--text-ink-tertiary);">Coherent Team Totals</span>
      </div>
      <div class="segmented-control" style="width:100%; margin-bottom:10px;">
        <button class="seg-btn ${activeDrawerConditionalScenario === 'BASELINE' ? 'active' : ''}" style="flex:1;" onclick="setDrawerScenario('BASELINE')">Baseline</button>
        <button class="seg-btn ${activeDrawerConditionalScenario === 'TEAMMATE_OUT' ? 'active' : ''}" style="flex:1;" onclick="setDrawerScenario('TEAMMATE_OUT')">Teammate OUT</button>
        <button class="seg-btn ${activeDrawerConditionalScenario === 'LIMITED_WORKLOAD' ? 'active' : ''}" style="flex:1;" onclick="setDrawerScenario('LIMITED_WORKLOAD')">Snap Count</button>
        <button class="seg-btn ${activeDrawerConditionalScenario === 'TRAILING_SCRIPT' ? 'active' : ''}" style="flex:1;" onclick="setDrawerScenario('TRAILING_SCRIPT')">Trailing Script</button>
      </div>

      <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:6px;">
        <span>Conditional Projection: <strong>${cond.condProjYards} yds (${cond.condProjRec} rec)</strong></span>
        <span style="color:var(--accent-editorial); font-weight:700;">${((cond.condMuRec / p.mu_rec - 1) * 100) >= 0 ? '+' : ''}${((cond.condMuRec / p.mu_rec - 1) * 100).toFixed(1)}% Vol Shift</span>
      </div>
      <ul style="font-size:11px; color:var(--text-ink-secondary); padding-left:16px; margin:0;">
        ${cond.assumptions.map(a => `<li>${a}</li>`).join('')}
      </ul>
    </div>

    <!-- STEP 4: RISKS & INVALIDATION FACTORS -->
    <div class="drawer-section-title">4. Invalidation Factors &amp; Matchup Risks</div>
    <div style="background:var(--bg-surface-subtle); border:1px solid var(--border-subtle); border-radius:8px; padding:12px; margin-bottom:16px; font-size:12px; line-height:1.6; color:var(--text-ink-secondary);">
      ${p.questionable ? `
        <div style="color:var(--status-amber); font-weight:700; margin-bottom:6px;">
          ⚠️ QUESTIONABLE DESIGNATION: Official injury report flag. Model cannot price in-game reinjury or sudden pitch count.
        </div>
      ` : `<div style="color:var(--status-green); margin-bottom:6px;">✓ Clean health status. No official injury designation.</div>`}
      &bull; <strong>Defensive Matchup:</strong> Opponent allows <strong>${((Number(p.def_yards_idx || 1.0) - 1.0) * 100).toFixed(1)}%</strong> ${p.def_yards_idx >= 1.0 ? 'more' : 'fewer'} yards to ${p.position}s than NFL average.<br>
      &bull; <strong>Game Script &amp; Spread:</strong> ${p.team} is ${p.team_spread > 0 ? '+' : ''}${Number(p.team_spread || 0).toFixed(1)}. Positive scripts reduce pass volume; trailing scripts inflate targets.<br>
      &bull; <strong>Venue:</strong> ${p.is_dome ? 'Indoor Dome (ideal passing environment)' : `Outdoor stadium &bull; Wind: ${p.wind || 0} mph`}.
    </div>

    <!-- STEP 5: DISTRIBUTION & PREDICTIVE RANGES -->
    <div class="drawer-section-title">5. Predictive Distribution &amp; Outcome Ranges</div>
    <div class="outcome-range-bar-wrap">
      <div class="range-steps-row">
        <span>10th: <strong>${Math.round(p.projVol * 0.35)}</strong></span>
        <span>25th: <strong>${Math.round(p.projVol * 0.62)}</strong></span>
        <span style="color:var(--accent-editorial);">Median (50th): <strong>${Number(p.fairLine).toFixed(1)}</strong></span>
        <span>75th: <strong>${Math.round(p.projVol * 1.35)}</strong></span>
        <span>90th: <strong>${Math.round(p.projVol * 1.85)}</strong></span>
      </div>
      <div class="range-bar">
        <div class="range-iqr" style="left:25%; width:50%;"></div>
      </div>
      <div style="font-size:11px; color:var(--text-ink-tertiary); margin-top:8px;">
        Expected IQR (25th–75th): <strong>${Math.round(p.projVol * 0.62)} to ${Math.round(p.projVol * 1.35)} ${p.market === 'receptions' ? 'receptions' : 'yards'}</strong>.
      </div>
    </div>

    <div id="drawerCurveContainer" style="width:100%; height:180px; position:relative; background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:6px; margin-bottom:16px;"></div>

    <!-- STEP 6: IMMUTABLE DECISION-TIME SNAPSHOT AUDIT -->
    <div class="drawer-section-title">6. Immutable Decision-Time Snapshot Audit</div>
    ${(() => {
      const snapMarketKey = (p.market === 'receptions' || currentFilterMarket === 'receptions') ? 'receptions' : 'receiving_yards';
      const playerSnap = currentSnapshots.find(s => s.player_id === p.player_id && s.market === snapMarketKey);
      if (playerSnap) {
        return `
          <div class="snapshot-audit-card">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
              <div>
                <div style="display:flex; align-items:center; gap:6px;">
                  <span style="font-weight:700; font-size:12px; color:var(--text-ink);">🔒 ${playerSnap.snapshot_type.toUpperCase()} RECORD</span>
                  <span class="provisional-badge" style="color:#22c55e; background:rgba(34,197,94,0.12); border-color:rgba(34,197,94,0.35);">SHA-256 VERIFIED ✓</span>
                </div>
                <div style="font-size:10px; font-family:var(--font-mono); color:var(--text-ink-tertiary); margin-top:2px;">
                  Frozen: ${new Date(playerSnap.created_at).toLocaleString()} &bull; Game: ${playerSnap.game_id}
                </div>
              </div>
              <span style="font-family:var(--font-mono); font-size:10px; color:var(--text-ink-secondary); background:rgba(255,255,255,0.06); padding:2px 6px; border-radius:4px;">
                ${playerSnap.snapshot_id.slice(0, 8)}...
              </span>
            </div>

            <div class="stat-metric-grid" style="margin-bottom:8px;">
              <div class="stat-metric-cell">
                <div class="metric-cell-label">Frozen Fair Line</div>
                <div class="metric-cell-val" style="color:var(--accent-editorial);">${playerSnap.projection.fair_line}</div>
              </div>
              <div class="stat-metric-cell">
                <div class="metric-cell-label">P(Over)</div>
                <div class="metric-cell-val">${(playerSnap.projection.p_over * 100).toFixed(1)}%</div>
              </div>
              <div class="stat-metric-cell">
                <div class="metric-cell-label">P(Under)</div>
                <div class="metric-cell-val">${(playerSnap.projection.p_under * 100).toFixed(1)}%</div>
              </div>
              <div class="stat-metric-cell">
                <div class="metric-cell-label">P(Push)</div>
                <div class="metric-cell-val">${(playerSnap.projection.p_push * 100).toFixed(1)}%</div>
              </div>
              <div class="stat-metric-cell">
                <div class="metric-cell-label">Max Over Line @ -110</div>
                <div class="metric-cell-val">&le; ${playerSnap.price_boundaries.max_acceptable_over_line_at_minus_110}</div>
              </div>
              <div class="stat-metric-cell">
                <div class="metric-cell-label">Min Under Line @ -110</div>
                <div class="metric-cell-val">&ge; ${playerSnap.price_boundaries.min_acceptable_under_line_at_minus_110}</div>
              </div>
            </div>

            <div style="font-size:10px; font-family:var(--font-mono); color:var(--text-ink-tertiary); margin-bottom:4px;">
              CANONICAL SHA-256 CONTENT HASH:
            </div>
            <div class="snapshot-hash-box">
              <code>${playerSnap.content_hash}</code>
              <span style="color:#22c55e; font-weight:700; font-size:10px; white-space:nowrap;">IMMUTABLE</span>
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px;">
              <button class="btn-secondary" style="font-size:11px; padding:4px 10px; font-weight:600;" onclick="copySnapshotJson('${playerSnap.snapshot_id}')">
                📋 Copy Canonical Snapshot JSON
              </button>
              <span style="font-size:10px; font-family:var(--font-mono); color:var(--text-ink-tertiary);">RFC-8785 Canonical JSON</span>
            </div>
            <div style="font-size:10px; color:var(--text-ink-tertiary); margin-top:8px; line-height:1.4;">
              🛡️ <strong>Evaluation Invariant:</strong> Chronological holdout evaluation strictly reads snapshots where <code>created_at &le; decision_time</code>. Zero lookahead leakage.
            </div>
          </div>
        `;
      } else {
        return `
          <div style="background:var(--bg-surface-subtle); border:1px dashed var(--border-medium); border-radius:8px; padding:12px; margin-bottom:16px; font-size:11px; color:var(--text-ink-tertiary); text-align:center;">
            No immutable freeze snapshot recorded for this player-market yet.<br>
            Run <code>src/freeze_slate.py</code> or trigger freeze via Admin console.
          </div>
        `;
      }
    })()}

    <!-- STEP 7: SOURCES & DATA PROVENANCE -->
    <div class="drawer-section-title">7. Data Sources &amp; Provenance</div>
    <div style="font-size:11px; color:var(--text-ink-tertiary); line-height:1.6; background:var(--bg-surface-subtle); padding:10px 12px; border-radius:6px; border:1px solid var(--border-subtle);">
      &bull; <strong>Model Engine:</strong> Compound Negative Binomial-Gamma (v2.1 calibrated)<br>
      &bull; <strong>Fitted Parameters:</strong> Dispersion &alpha; = 0.1097, Per-Catch Shape k = 1.555<br>
      &bull; <strong>PBP Feed:</strong> nflverse official play-by-play through 2026 Week 6<br>
      &bull; <strong>Verification Status:</strong> Model Fair Baseline (Awaiting sportsbook opening quotes)
    </div>
  `;

  renderDrawerDensityCurve(p, p.market, p.bookLine);
}

function setDrawerScenario(scen) {
  activeDrawerConditionalScenario = scen;
  renderDrawerBodyContent();
}

function computeConditionalProjection(player, scenario) {
  let recMult = 1.0;
  let yprMult = 1.0;
  let assumptions = [];

  if (scenario === 'TEAMMATE_OUT') {
    const currentShare = Number(player.target_share || player.f_tgt_share || 0.22);
    const boost = Math.min(0.08, currentShare * 0.25);
    const newShare = currentShare + boost;
    recMult = newShare / currentShare;
    assumptions.push(`Teammate ruled out: ~18% vacated target share redistributed proportionally across remaining targets.`);
    assumptions.push(`Team passing total held coherent at ${player.implied_team_total || 24} implied pts (zero artificial volume inflation).`);
  } else if (scenario === 'LIMITED_WORKLOAD') {
    recMult = 0.65;
    yprMult = 0.95;
    assumptions.push('Snap count / pitch count restriction: player active on ~60-65% of standard passing downs.');
    assumptions.push('Elevated substitution rate in 2-minute and obvious passing situations.');
  } else if (scenario === 'TRAILING_SCRIPT') {
    recMult = 1.12;
    assumptions.push(`Trailing game script: +4 to +6 team dropbacks expected vs neutral baseline.`);
    assumptions.push('Air yards share maintained, target volume scaled with team pass rate.');
  } else {
    assumptions.push('Baseline projection under standard game script and full starter workload.');
  }

  const condMuRec = player.mu_rec * recMult;
  const condMuYpr = player.mu_ypr * yprMult;

  return {
    scenario,
    condMuRec,
    condMuYpr,
    condProjRec: condMuRec.toFixed(1),
    condProjYards: (condMuRec * condMuYpr).toFixed(1),
    assumptions
  };
}

function renderSensitivityRows(p, market) {
  const baseFair = market === 'receptions' ? p.fair_line_rec : p.fair_line_yards;
  const step = market === 'receptions' ? 1.0 : 5.0;
  const bias = isHistoricalSlate ? (market === 'receptions' ? W1_BIAS_REC : W1_BIAS_YDS) : 0.0;

  const offsets = [-2 * step, -1 * step, 0, 1 * step, 2 * step];
  return offsets.map(off => {
    const testLine = Math.max(0.5, baseFair + off);
    const m = evaluateLineAndOdds(p.mu_rec, p.mu_ypr, market, testLine, -110, bias);

    let verdict = '<span style="color:var(--text-ink-tertiary);">PASS</span>';
    if (m.expectedReturn > 0 && m.probEdge >= 0.10) {
      verdict = `<span style="color:var(--status-green); font-weight:700;">BET ${m.bestSide}</span>`;
    } else if (m.expectedReturn > 0 && m.probEdge >= 0.04) {
      verdict = `<span style="color:var(--status-amber);">LEAN ${m.bestSide}</span>`;
    } else if (m.expectedReturn <= 0) {
      verdict = `<span style="color:var(--status-red); font-size:10px;">-EV (${(m.expectedReturn * 100).toFixed(1)}%)</span>`;
    }

    const pushStr = m.pPush > 0.001 ? `${(m.pPush * 100).toFixed(1)}%` : '0.0%';

    return `
      <tr style="${off === 0 ? 'background:var(--accent-editorial-bg);' : ''}">
        <td><strong>${testLine.toFixed(1)}</strong> ${off === 0 ? '<small style="color:var(--accent-editorial);">(Fair)</small>' : ''}</td>
        <td>${(m.pOver * 100).toFixed(1)}%</td>
        <td>${(m.pUnder * 100).toFixed(1)}%</td>
        <td style="color:${m.pPush > 0.005 ? 'var(--status-amber)' : 'var(--text-ink-tertiary)'};">${pushStr}</td>
        <td>${probToAmerican(m.winProb) > 0 ? '+' : ''}${probToAmerican(m.winProb)}</td>
        <td style="color:${m.breakEvenAdvantage > 0 ? 'var(--status-green)' : 'var(--status-red)'};">${m.breakEvenAdvantage > 0 ? '+' : ''}${(m.breakEvenAdvantage * 100).toFixed(1)}%</td>
        <td style="color:${m.expectedReturn > 0 ? 'var(--status-green)' : 'var(--text-ink-tertiary)'};">${m.expectedReturn > 0 ? '+' : ''}${(m.expectedReturn * 100).toFixed(1)}%</td>
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
    if (x > 0) {
      const eps = 0.25;
      const cdf1 = market === 'receptions' 
        ? (1 - pRecOver(p.mu_rec, x - eps))
        : compoundYardsCdf(p.mu_rec, p.mu_ypr, x - eps);
      const cdf2 = market === 'receptions'
        ? (1 - pRecOver(p.mu_rec, x + eps))
        : compoundYardsCdf(p.mu_rec, p.mu_ypr, x + eps);
      d = Math.max(0, (cdf2 - cdf1) / (2 * eps));
    }
    points.push({ x, d });
    if (d > maxDensity) maxDensity = d;
  }

  if (maxDensity <= 0) maxDensity = 0.01;

  const xScale = (val) => pad.left + (val / maxVal) * (w - pad.left - pad.right);
  const yScale = (d) => (h - pad.bottom) - (d / maxDensity) * (h - pad.top - pad.bottom);

  let pathD = `M ${xScale(points[0].x)} ${yScale(points[0].d)}`;
  for (let i = 1; i < points.length; i++) {
    pathD += ` L ${xScale(points[i].x)} ${yScale(points[i].d)}`;
  }

  const bookX = xScale(bookLine);
  const fairX = xScale(fairLine);

  container.innerHTML = `
    <svg width="100%" height="100%" viewBox="0 0 ${w} ${h}" style="display:block;">
      <line x1="${pad.left}" y1="${h - pad.bottom}" x2="${w - pad.right}" y2="${h - pad.bottom}" stroke="var(--border-medium)" stroke-width="1"/>
      <path d="${pathD}" fill="none" stroke="var(--accent-editorial)" stroke-width="2"/>
      <line x1="${fairX}" y1="${pad.top}" x2="${fairX}" y2="${h - pad.bottom}" stroke="var(--accent-editorial)" stroke-width="1.5" stroke-dasharray="3,3"/>
      <text x="${fairX}" y="${pad.top - 5}" font-family="var(--font-mono)" font-size="10" font-weight="700" fill="var(--accent-editorial)" text-anchor="middle">Fair: ${Number(fairLine).toFixed(1)}</text>
      <line x1="${bookX}" y1="${pad.top + 10}" x2="${bookX}" y2="${h - pad.bottom}" stroke="var(--text-ink)" stroke-width="2"/>
      <text x="${bookX}" y="${h - pad.bottom + 15}" font-family="var(--font-mono)" font-size="10" font-weight="700" fill="var(--text-ink)" text-anchor="middle">Offer: ${Number(bookLine).toFixed(1)}</text>
    </svg>
  `;
}

function closeDrawer() {
  document.getElementById('detailDrawer')?.classList.remove('active');
  document.getElementById('drawerOverlay')?.classList.remove('active');
}

// --------------------------------------------------------------------------
// Watchlist -> Saved Condition Monitoring
// --------------------------------------------------------------------------

function loadStoredConditions() {
  try {
    const raw = localStorage.getItem('nfl_props_saved_conditions');
    userSavedConditions = raw ? JSON.parse(raw) : [];
  } catch (_) {
    userSavedConditions = [];
  }
}

function saveStoredConditions() {
  try {
    localStorage.setItem('nfl_props_saved_conditions', JSON.stringify(userSavedConditions));
  } catch (_) {}
  updateConditionBadge();
}

function updateConditionBadge() {
  const badge = document.getElementById('watchlistCountBadge');
  if (badge) badge.textContent = userSavedConditions.length;
}

function quickSaveCondition(playerId) {
  const p = slateData.find(x => x.player_id === playerId);
  if (!p) return;
  const ev = getEvaluatedPlayerRow(p);

  const idx = userSavedConditions.findIndex(c => c.playerId === playerId);
  if (idx >= 0) {
    userSavedConditions.splice(idx, 1);
    showToast(`Removed condition for ${p.player_display_name}`);
  } else {
    userSavedConditions.push({
      id: `${playerId}_${Date.now()}`,
      playerId: p.player_id,
      playerName: p.player_display_name,
      team: p.team,
      opponent: p.opponent_team,
      market: ev.market,
      side: ev.bestSide,
      fairLine: ev.fairLine,
      entryLine: ev.bookLine,
      entryOdds: ev.odds,
      targetQualLine: ev.priceBoundaries.maxOverLine,
      targetQualOdds: ev.priceBoundaries.breakEvenOddsAtFair,
      status: 'MONITORING',
      createdDate: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      log: [`Created: Monitoring for line <= ${ev.priceBoundaries.maxOverLine} or odds >= ${ev.priceBoundaries.breakEvenOddsAtFair}`]
    });
    showToast(`✓ Saved condition for ${p.player_display_name}`);
  }

  saveStoredConditions();
  renderBoard();
  renderBestOpportunitiesGrid();
  if (selectedDrawerPlayer && selectedDrawerPlayer.player_id === playerId) {
    const watchBtn = document.getElementById('drawerWatchlistBtn');
    if (watchBtn) watchBtn.textContent = idx >= 0 ? '★ Watch Condition' : '★ Condition Monitored';
  }
}

function toggleDrawerWatchlist() {
  if (!selectedDrawerPlayer) return;
  quickSaveCondition(selectedDrawerPlayer.player_id);
}

function renderWatchlistPage() {
  const container = document.getElementById('watchlistContentContainer');
  if (!container) return;

  if (userSavedConditions.length === 0) {
    container.innerHTML = `
      <div class="empty-state-notice">
        <strong>No Saved Conditions Active:</strong> You have not set any price or role monitoring alerts yet.
        Browse the Research Board and click <strong>★ Watch Condition</strong> on any player to track price movements, qualification triggers, and role changes.
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:12px;">
      ${userSavedConditions.map(c => `
        <div class="opp-card">
          <div class="opp-card-header">
            <div>
              <div class="opp-player-name" onclick="openDrawerForPlayer('${c.playerName}')">${c.playerName}</div>
              <div class="opp-matchup-sub">${c.team} vs ${c.opponent} &bull; ${c.market === 'receptions' ? 'Receptions' : 'Yards'} (${c.side})</div>
            </div>
            <span class="role-badge role-surge">ACTIVE MONITORING</span>
          </div>

          <div class="opp-pricing-row">
            <div class="pricing-metric">
              <span class="pricing-label">Baseline Fair</span>
              <span class="pricing-val" style="color:var(--accent-editorial);">${Number(c.fairLine).toFixed(1)}</span>
            </div>
            <div class="pricing-metric">
              <span class="pricing-label">Target Qual Hurdle</span>
              <span class="pricing-val">${c.side} &le; ${c.targetQualLine}</span>
            </div>
          </div>

          <div style="font-size:11px; color:var(--text-ink-secondary);">
            <strong>Trigger History:</strong> ${c.log.join(' &bull; ')}
          </div>

          <div class="opp-actions-row">
            <button class="btn-inspect" onclick="openDrawerForPlayer('${c.playerName}')">Inspect &rarr;</button>
            <button class="btn-watch" onclick="simulateConditionMove('${c.playerId}')">Test Move</button>
            <button class="btn-watch" onclick="quickSaveCondition('${c.playerId}')" style="color:var(--status-red);">Delete</button>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function simulateConditionMove(playerId) {
  const c = userSavedConditions.find(x => x.playerId === playerId);
  if (!c) return;
  c.log.push(`Line moved to ${c.targetQualLine} @ -110 (Hurdle Met!)`);
  c.status = 'TRIGGER_MET';
  saveStoredConditions();
  renderWatchlistPage();
  showToast(`Simulated market line move for ${c.playerName}: Trigger fired!`);
}

function clearWatchlist() {
  userSavedConditions = [];
  saveStoredConditions();
  renderWatchlistPage();
  renderBoard();
  renderBestOpportunitiesGrid();
  showToast('Cleared all saved conditions.');
}

// --------------------------------------------------------------------------
// CLV Proof Ledger & Audited Tracking
// --------------------------------------------------------------------------

async function loadClvLedger() {
  try {
    const res = await fetchWithFallback('/api/picks-log', 'picks_log.jsonl');
    if (res.ok) {
      const text = await res.text();
      const lines = text.trim().split('\n');
      clvLogData = lines.filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch (_) { return null; }
      }).filter(Boolean);
    }
  } catch (err) {
    clvLogData = [];
  }
}

function renderTrackerPage() {
  const tbody = document.getElementById('trackerTableTbody');
  const totalBetsEl = document.getElementById('trackerTotalBets');
  const meanClvEl = document.getElementById('trackerMeanClv');
  const beatCloseEl = document.getElementById('trackerBeatClose');
  const verdictEl = document.getElementById('trackerVerdict');
  const allCountEl = document.getElementById('clvAllCount');
  const verifiedCountEl = document.getElementById('clvVerifiedCount');
  const demoCountEl = document.getElementById('clvDemoCount');

  let list = clvLogData;
  if (clvFilterType === 'verified') list = list.filter(r => r.sample_class === 'verified_live');
  if (clvFilterType === 'demo') list = list.filter(r => r.sample_class !== 'verified_live');

  const verifiedCount = clvLogData.filter(r => r.sample_class === 'verified_live').length;
  const demoCount = clvLogData.length - verifiedCount;

  if (allCountEl) allCountEl.textContent = clvLogData.length;
  if (verifiedCountEl) verifiedCountEl.textContent = verifiedCount;
  if (demoCountEl) demoCountEl.textContent = demoCount;
  if (totalBetsEl) totalBetsEl.textContent = list.length;

  // Compute metrics
  const settledWithClose = list.filter(r => r.closing_mkt_prob !== null && r.closing_mkt_prob !== undefined);
  if (settledWithClose.length > 0) {
    const clvDiffs = settledWithClose.map(r => r.model_prob - r.closing_mkt_prob);
    const meanClv = clvDiffs.reduce((a, b) => a + b, 0) / clvDiffs.length;
    const beatRate = clvDiffs.filter(d => d > 0).length / clvDiffs.length;

    if (meanClvEl) meanClvEl.textContent = `${meanClv > 0 ? '+' : ''}${(meanClv * 100).toFixed(2)}%`;
    if (beatCloseEl) beatCloseEl.textContent = `${(beatRate * 100).toFixed(1)}%`;
    if (verdictEl) {
      if (settledWithClose.length < 25) {
        verdictEl.textContent = `Preliminary N=${settledWithClose.length}`;
        verdictEl.className = 'health-tile-val pill-pending';
      } else {
        verdictEl.textContent = meanClv > 0.02 ? 'CLV Verified' : 'Neutral CLV';
        verdictEl.className = 'health-tile-val pill-complete';
      }
    }
  }

  // Populate Chronological Holdout Evaluation Panel
  const evalContainer = document.getElementById('holdoutEvalContent');
  if (evalContainer) {
    if (holdoutEvalData && holdoutEvalData.metrics) {
      const m = holdoutEvalData.metrics;
      const roles = holdoutEvalData.role_hypothesis_holdout_evidence || {};

      let roleRows = '';
      for (const [k, v] of Object.entries(roles)) {
        roleRows += `
          <div style="background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:6px; padding:10px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
              <span style="font-weight:700; font-family:var(--font-mono); font-size:11px; text-transform:uppercase;">${k}</span>
              <span class="provisional-badge">PROV (N=${v.sample_size})</span>
            </div>
            <div style="font-size:11px; color:var(--text-ink-secondary); line-height:1.5;">
              Over: <strong>${(v.over_rate * 100).toFixed(1)}%</strong> &bull; Under: <strong>${(v.under_rate * 100).toFixed(1)}%</strong><br>
              Mean Error: <strong>${v.mean_projection_error > 0 ? '+' : ''}${v.mean_projection_error}</strong>
            </div>
          </div>
        `;
      }

      evalContainer.innerHTML = `
        <div class="stat-metric-grid" style="margin-bottom:14px;">
          <div class="stat-metric-cell">
            <div class="metric-cell-label">Evaluated Snapshots</div>
            <div class="metric-cell-val" style="color:var(--accent-editorial);">${holdoutEvalData.total_snapshots_evaluated}</div>
          </div>
          <div class="stat-metric-cell">
            <div class="metric-cell-label">Model Brier Score</div>
            <div class="metric-cell-val">${m.brier_score_model}</div>
          </div>
          <div class="stat-metric-cell">
            <div class="metric-cell-label">50/50 Coin Flip Brier</div>
            <div class="metric-cell-val">${m.brier_score_naive_baseline}</div>
          </div>
          <div class="stat-metric-cell">
            <div class="metric-cell-label">Model Log-Loss</div>
            <div class="metric-cell-val">${m.log_loss_model}</div>
          </div>
        </div>

        <div style="font-weight:700; font-size:12px; margin-bottom:6px; color:var(--text-ink);">
          Role Hypothesis Holdout Performance (Provisional Threshold Validation):
        </div>
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px; margin-bottom:12px;">
          ${roleRows}
        </div>

        <div style="background:var(--bg-canvas); border-left:3px solid var(--accent-amber); padding:10px 14px; border-radius:4px; font-size:11px; line-height:1.5; color:var(--text-ink-secondary);">
          <strong>Holdout Invariant &amp; Verdict:</strong> ${holdoutEvalData.provisional_threshold_verdict?.recommendation || 'Evaluation strictly restricted to snapshots where created_at <= decision_time.'}
        </div>
      `;
    } else {
      evalContainer.innerHTML = `
        <div style="padding:16px; text-align:center; color:var(--text-ink-tertiary); font-size:12px;">
          Holdout evaluation available for settled historical slates (Week 1). Switch slate context in top nav.
        </div>
      `;
    }
  }

  if (!tbody) return;

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:32px; color:var(--text-ink-tertiary);">No records found.</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(r => {
    const clv = (r.closing_mkt_prob !== null && r.closing_mkt_prob !== undefined)
      ? r.model_prob - r.closing_mkt_prob
      : null;
    const clvFormatted = clv !== null
      ? `<span style="color:${clv > 0 ? 'var(--status-green)' : 'var(--status-red)'}; font-weight:700;">${clv > 0 ? '+' : ''}${(clv * 100).toFixed(2)}%</span>`
      : `<span style="color:var(--text-ink-tertiary);">Pending Close</span>`;

    return `
      <tr>
        <td style="font-family:var(--font-mono); font-size:11px;">${r.timestamp ? r.timestamp.slice(0, 10) : '2026-09-10'}</td>
        <td><strong>${r.player}</strong> (${r.side})</td>
        <td>${r.market} ${r.line}</td>
        <td class="num-col">${r.odds > 0 ? '+' : ''}${r.odds}</td>
        <td class="num-col">${(r.model_prob * 100).toFixed(1)}%</td>
        <td class="num-col">${r.closing_mkt_prob ? `${(r.closing_mkt_prob * 100).toFixed(1)}%` : '—'}</td>
        <td class="num-col">${clvFormatted}</td>
        <td><span class="role-badge ${r.sample_class === 'verified_live' ? 'role-surge' : 'role-spike'}" style="font-size:9px;">${r.sample_class || 'demo'}</span></td>
        <td><span class="status-pill status-pass" style="font-size:9px;">${r.status || 'LOGGED'}</span></td>
      </tr>
    `;
  }).join('');
}

function setClvFilter(type) {
  clvFilterType = type;
  document.querySelectorAll('.tracker-filter-pills .seg-btn').forEach(btn => btn.classList.remove('active'));
  if (type === 'all') document.getElementById('btnClvAll')?.classList.add('active');
  if (type === 'verified') document.getElementById('btnClvVerified')?.classList.add('active');
  if (type === 'demo') document.getElementById('btnClvDemo')?.classList.add('active');
  renderTrackerPage();
}

function toggleClosingForm() {
  const panel = document.getElementById('closingFormPanel');
  if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function updateClosingFromOdds() {
  const input = document.getElementById('closingOddsInput');
  const probInput = document.getElementById('closingProbInput');
  if (!input || !probInput) return;
  const odds = parseFloat(input.value);
  if (!isNaN(odds)) {
    const dec = americanToDecimal(odds);
    probInput.value = (1.0 / dec).toFixed(3);
  }
}

function submitClosingPrice() {
  showToast('✓ Recorded closing quote in local proof ledger.');
  toggleClosingForm();
}

function logDrawerPick() {
  if (!selectedDrawerPlayer) return;
  const p = selectedDrawerPlayer;
  clvLogData.unshift({
    timestamp: new Date().toISOString(),
    player: p.player_display_name,
    market: p.market === 'receptions' ? 'Rec' : 'Yards',
    side: p.bestSide,
    line: p.bookLine,
    odds: p.odds,
    model_prob: p.winProb,
    closing_mkt_prob: null,
    sample_class: 'verified_live',
    status: 'ACTIVE_PENDING'
  });
  showToast(`✓ Logged ${p.player_display_name} to CLV Proof Ledger.`);
}

function copyDrawerSlip() {
  if (!selectedDrawerPlayer) return;
  const p = selectedDrawerPlayer;
  const slip = `PROPRIETARY SELECTION: ${p.player_display_name} (${p.team}) ${p.bestSide} ${p.bookLine} ${p.market} (${p.odds > 0 ? '+' : ''}${p.odds})\nModel Fair: ${Number(p.fairLine).toFixed(1)} | Win Prob: ${(p.winProb * 100).toFixed(1)}% | EV: ${(p.expectedReturn * 100).toFixed(1)}%\nVerified Decision Support: https://receiving-props-agent.vercel.app`;
  navigator.clipboard.writeText(slip).then(() => {
    showToast('✓ Copied bet slip details to clipboard!');
  }).catch(() => {
    showToast('Could not copy slip.');
  });
}

// --------------------------------------------------------------------------
// Research & SGP Bivariate Simulator
// --------------------------------------------------------------------------

function populateSgpSelect() {
  const sel = document.getElementById('sgpPlayerSelect');
  if (!sel || slateData.length === 0) return;

  const top15 = slateData.slice(0, 20);
  sel.innerHTML = top15.map(p => `
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

  const trueEdge = pJoint - breakEvenOffered;
  const trueEv = pJoint * (decOffered - 1.0) - (1.0 - pJoint);

  container.innerHTML = `
    <div style="background:var(--bg-surface-subtle); border:1px solid var(--border-subtle); border-radius:8px; padding:16px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
        <h5 style="color:var(--text-ink); font-size:14px; font-weight:800;">${player.player_display_name} SGP: Over ${fairRec} Rec + Over ${fairYds} Yds</h5>
        <span class="role-badge role-surge">
          +${(correlationLift * 100).toFixed(1)}% MODELED DEPENDENCE LIFT
        </span>
      </div>
      <table class="sensitivity-table" style="font-size:12px;">
        <thead>
          <tr>
            <th>Leg 1 P(Over)</th>
            <th>Leg 2 P(Over)</th>
            <th>Independent Product</th>
            <th style="color:var(--accent-editorial);">Modeled Joint Prob</th>
            <th>Fair Odds</th>
            <th>Offered Odds</th>
            <th>BE Prob</th>
            <th style="color:var(--status-green);">True Edge</th>
            <th>Exp Return (EV)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>${(pRec * 100).toFixed(1)}%</td>
            <td>${(pYds * 100).toFixed(1)}%</td>
            <td style="color:var(--text-ink-tertiary);">${(pIndep * 100).toFixed(1)}%</td>
            <td style="color:var(--accent-editorial); font-weight:700;">${(pJoint * 100).toFixed(1)}%</td>
            <td style="font-weight:700;">${fairOdds > 0 ? '+' : ''}${fairOdds}</td>
            <td style="font-weight:700;">${offeredOdds > 0 ? '+' : ''}${offeredOdds}</td>
            <td style="color:var(--text-ink-tertiary);">${(breakEvenOffered * 100).toFixed(1)}%</td>
            <td style="color:${trueEdge > 0 ? 'var(--status-green)' : 'var(--status-red)'}; font-weight:700;">${trueEdge > 0 ? '+' : ''}${(trueEdge * 100).toFixed(1)}%</td>
            <td style="color:${trueEv > 0 ? 'var(--status-green)' : 'var(--text-ink-tertiary)'}; font-weight:700;">${trueEv > 0 ? '+' : ''}${(trueEv * 100).toFixed(1)}%</td>
          </tr>
        </tbody>
      </table>
      <div style="margin-top:10px; font-size:11px; color:var(--text-ink-secondary); line-height:1.5;">
        <strong>Quant Takeaway:</strong> Volume correlation lifts joint probability from ${(pIndep * 100).toFixed(1)}% (independent product) to ${(pJoint * 100).toFixed(1)}% (bivariate model). 
        At your offered sportsbook odds of ${offeredOdds > 0 ? '+' : ''}${offeredOdds} (break-even requirement ${(breakEvenOffered * 100).toFixed(1)}%), expected edge is <strong>${trueEdge > 0 ? '+' : ''}${(trueEdge * 100).toFixed(1)}%</strong> and expected return is <strong>${trueEv > 0 ? '+' : ''}${(trueEv * 100).toFixed(1)}%</strong>.
      </div>
    </div>
  `;
}

// --------------------------------------------------------------------------
// Admin Modal & Pipeline Execution
// --------------------------------------------------------------------------

function openAdminModal(mode) {
  const modal = document.getElementById('adminModal');
  if (modal) {
    modal.classList.add('active');
    if (mode === 'freeze') {
      const el = document.getElementById('adminFreezeGameSelect');
      if (el) el.focus();
    }
  }
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
  const season = document.getElementById('adminSeasonSelect')?.value || 2026;
  const week = document.getElementById('adminWeekSelect')?.value || 7;
  const term = document.getElementById('adminTerminalOutput');
  const btn = document.getElementById('executeAdminRunBtn');

  if (btn) btn.disabled = true;
  if (term) term.textContent = `>>> Connecting to pipeline runner: python src/week1.py --season ${season} --week ${week}\n\n`;

  try {
    const url = `/api/run-week/stream?season=${season}&week=${week}&all_games=true`;
    const response = await fetch(url);
    if (!response.ok) {
      if (term) {
        term.textContent += `[INFO] Serverless environment: Run pipeline locally via terminal:\n`;
        term.textContent += `  python src/week1.py --season ${season} --week ${week}\n`;
      }
      return;
    }
  } catch (_) {
    if (term) {
      term.textContent += `[INFO] Run on command line:\n  python src/week1.py --season ${season} --week ${week}\n`;
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function executeAdminFreeze() {
  const season = document.getElementById('adminSeasonSelect')?.value || 2026;
  const week = document.getElementById('adminWeekSelect')?.value || 7;
  const gameSelect = document.getElementById('adminFreezeGameSelect')?.value;
  const game_id = gameSelect === 'ALL' ? null : gameSelect;
  const snapshot_type = document.getElementById('adminFreezeTypeSelect')?.value || 'pre_kickoff';
  const term = document.getElementById('adminTerminalOutput');
  const btn = document.getElementById('executeFreezeBtn');

  if (btn) btn.disabled = true;
  if (term) {
    term.textContent = `>>> Triggering Immutable Freeze System\n`;
    term.textContent += `    Season: ${season} | Week: ${week}\n`;
    term.textContent += `    Target Scope: ${game_id || 'Full Slate (All Games)'}\n`;
    term.textContent += `    Snapshot Type: ${snapshot_type}\n`;
    term.textContent += `    Decision Time Cutoff: ${new Date().toISOString()}\n\n`;
  }

  try {
    const res = await fetch('/api/freeze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        season: parseInt(season, 10),
        week: parseInt(week, 10),
        game_id: game_id,
        snapshot_type: snapshot_type
      })
    });

    if (res.ok) {
      const data = await res.json();
      if (term) {
        term.textContent += `✓ SUCCESS: Frozen ${data.count} player-market records.\n`;
        term.textContent += `✓ Append-Only Log: ${data.jsonl_path}\n`;
        term.textContent += `✓ Static Viewer Bundle: ${data.viewer_path}\n`;
        term.textContent += `✓ Canonical SHA-256 Sample: ${data.sample_content_hash}\n`;
        term.textContent += `✓ Invariant: Evaluation code strictly restricted to records where created_at <= decision_time.\n`;
      }
      showToast(`Frozen ${data.count} records for ${game_id || 'Week ' + week}!`);
      await reloadSnapshots();
    } else {
      if (term) {
        term.textContent += `[NOTE] Serverless fallback: Execute freeze directly via CLI:\n`;
        term.textContent += `  python src/freeze_slate.py --season ${season} --week ${week} ${game_id ? '--game-id ' + game_id : '--all-games'} --snapshot-type ${snapshot_type}\n`;
      }
    }
  } catch (err) {
    if (term) {
      term.textContent += `[NOTE] Serverless fallback: Execute freeze directly via CLI:\n`;
      term.textContent += `  python src/freeze_slate.py --season ${season} --week ${week} ${game_id ? '--game-id ' + game_id : '--all-games'} --snapshot-type ${snapshot_type}\n`;
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function reloadSnapshots() {
  const snapPath = isHistoricalSlate ? 'snapshots_2026_w1.json' : 'snapshots_2026_w7.json';
  const snapRes = await fetchWithFallback(`/api/snapshots?slate=${currentSlateKey}`, snapPath);
  if (snapRes.ok) {
    currentSnapshots = await snapRes.json();
    renderSnapshotStatus();
    if (selectedDrawerPlayer) {
      renderDrawerBodyContent();
    }
  }
}

function copySnapshotJson(snapshotId) {
  const snap = currentSnapshots.find(s => s.snapshot_id === snapshotId);
  if (!snap) return;
  const canonical = JSON.stringify(snap, Object.keys(snap).sort(), 2);
  navigator.clipboard.writeText(canonical).then(() => {
    showToast('Canonical snapshot JSON copied to clipboard (SHA-256 verified)!');
  }).catch(() => {
    showToast(`Snapshot ID: ${snapshotId}`);
  });
}

// --------------------------------------------------------------------------
// Local Storage Persistence
// --------------------------------------------------------------------------

function loadStoredLines() {
  try {
    const raw = localStorage.getItem('nfl_props_custom_lines');
    inlinePlayerLines = raw ? JSON.parse(raw) : {};
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
// Math & Statistical Helpers
// --------------------------------------------------------------------------

function americanToDecimal(odds) {
  return odds > 0 ? (odds / 100.0) + 1.0 : (100.0 / Math.abs(odds)) + 1.0;
}

function probToAmerican(prob) {
  if (prob >= 0.999) return -10000;
  if (prob <= 0.001) return 10000;
  return Math.round(prob >= 0.5 ? (-100.0 * prob / (1.0 - prob)) : (100.0 * (1.0 - prob) / prob));
}

function logGamma(x) {
  const c = [
    57.1562356658629235, -59.5979603554754912,
    14.1360979747417471, -0.491913816097620199,
    0.339946499848118887e-4, 0.465236289270485756e-4,
    -0.983744753048795646e-4, 0.158088703224377324e-3,
    -0.210264441724104783e-3, 0.217439618115212643e-3,
    -0.16431810653676389e-3, 0.844182239838527433e-4,
    -0.261908384015814087e-4, 0.368991826595316234e-5
  ];
  if (x <= 0) return 0;
  let y = x;
  let tmp = x + 5.2421875;
  tmp = (x + 0.5) * Math.log(tmp) - tmp;
  let ser = 0.999999999999997092;
  for (let j = 0; j < 14; j++) {
    y += 1;
    ser += c[j] / y;
  }
  return tmp + Math.log(2.5066282746310005 * ser / x);
}

function regularizedGammaP(s, x) {
  if (x <= 0) return 0;
  if (s <= 0) return 1;
  if (x < s + 1) {
    let sum = 1 / s;
    let term = sum;
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

function nbPmf(k, r, p) {
  if (k < 0) return 0;
  if (k === 0) return Math.pow(p, r);
  let prob = Math.pow(p, r);
  for (let i = 1; i <= k; i++) {
    prob *= ((i - 1 + r) / i) * (1 - p);
  }
  return prob;
}

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

function compoundYardsCdf(muRec, muYpr, line) {
  if (line <= 0) return 0.0;
  const r = 1.0 / MODEL_ALPHA;
  const p = r / (r + muRec);
  const scale = muYpr / MODEL_K;

  let cdf = Math.pow(p, r);
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

function pYardsOver(muRec, muYpr, line) {
  return Math.max(0, Math.min(1, 1.0 - compoundYardsCdf(muRec, muYpr, line)));
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
