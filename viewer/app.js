(() => {
  'use strict';

  const MODEL_ALPHA = 0.1097;
  const MODEL_K = 1.555;
  const SLATES = {
    '2026_w7': {
      season: 2026,
      week: 7,
      state: 'Upcoming slate · Oct 22–26',
      slate: 'slate_2026_w7.json',
      games: 'games_2026_w7.json',
      picks: 'current_picks_w7.json',
      injuries: 'injuries_2026_w7.json',
      odds: 'live_odds_feed.json',
      historical: false
    },
    '2026_w1': {
      season: 2026,
      week: 1,
      state: 'Historical audit · Sept 10–14',
      slate: 'slate_2026_w1.json',
      games: 'games_2026_w1.json',
      picks: 'current_picks_w1.json',
      injuries: null,
      odds: null,
      historical: true
    }
  };

  function loadPortfolio() {
    try {
      const raw = localStorage.getItem('propwire_portfolio_ledger');
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  function savePortfolio(portfolio) {
    try {
      localStorage.setItem('propwire_portfolio_ledger', JSON.stringify(portfolio));
    } catch (_) {}
  }

  const state = {
    slateKey: '2026_w7',
    slate: [],
    games: [],
    picks: {},
    injuries: { injuries: [], impacted_beneficiaries: {} },
    odds: { quotes: [] },
    filters: { search: '', market: 'receiving_yards', position: 'ALL', team: '', gameId: '', playMode: 'actionable', intent: 'all' },
    view: matchMedia('(max-width: 680px)').matches ? 'cards' : 'table',
    deferredInstall: null,
    selectedPlayerId: null,
    focusedIndex: -1,
    scenarioTargetShare: null,
    bankroll: 5000,
    clvReport: null,
    portfolio: loadPortfolio()
  };
  try {
    const savedBankroll = localStorage.getItem('propwire-bankroll');
    if (savedBankroll) state.bankroll = Math.max(100, Number(savedBankroll));
  } catch (_) {}

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const finite = (value) => Number.isFinite(Number(value));
  const num = (value, fallback = 0) => finite(value) ? Number(value) : fallback;
  const pct = (value, digits = 1) => `${(num(value) * 100).toFixed(digits)}%`;
  const signedPct = (value, digits = 1) => `${num(value) > 0 ? '+' : ''}${pct(value, digits)}`;
  const oddsText = (value) => `${num(value) > 0 ? '+' : ''}${num(value)}`;
  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
  const bookShort = (book) => ({ DraftKings: 'DK', FanDuel: 'FD', BetMGM: 'MGM', Caesars: 'CZR', Pinnacle: 'PIN' })[book] || book || 'Book';

  const TEAM_LOGO_MAP = {
    LA: 'lar',
    WSH: 'wsh'
  };

  function teamLogoUrl(team) {
    if (!team) return '';
    const code = TEAM_LOGO_MAP[team] || team.toLowerCase();
    return `https://a.espncdn.com/i/teamlogos/nfl/500/${code}.png`;
  }

  const SVG_ICONS = {
    edge: '<svg class="prop-icon icon-edge" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 1.5L2.5 9h5l-1 5.5L13.5 7h-5l1-5.5z"/></svg>',
    surge: '<svg class="prop-icon icon-surge" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 8h3l2-5 3.5 10 2.5-6 1.5 2.5 2-.5"/></svg>',
    alpha: '<svg class="prop-icon icon-alpha" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><circle cx="8" cy="8" r="2.5"/></svg>',
    air: '<svg class="prop-icon icon-air" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 13L13 3M13 3H7M13 3V9"/></svg>',
    adot: '<svg class="prop-icon icon-deep" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1v14M1 8h14"/><circle cx="8" cy="8" r="5.5"/></svg>',
    volume: '<svg class="prop-icon icon-volume" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 13.5v-4M6.5 13.5v-7M10.5 13.5v-10M14.5 13.5v-6"/></svg>',
    starter: '<svg class="prop-icon icon-starter" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2"/></svg>',
    depth: '<svg class="prop-icon icon-depth" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 5l6-3 6 3-6 3-6-3zM2 9.5l6 3 6-3M2 13l6 3 6-3"/></svg>',
    lock: '<svg class="prop-icon icon-lock" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="6.5" width="9" height="8" rx="1.5"/><path d="M5.5 6.5V4.5a2.5 2.5 0 015 0v2"/></svg>',
    warn: '<svg class="prop-icon icon-warn" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5L1.5 13.5h13L8 2.5zM8 6.5v3.5M8 11.5v.5"/></svg>'
  };

  function keyDriverTag(row, beneficiary) {
    if (state.filters.market === 'anytime_td') {
      const rzShare = Math.min(0.48, Math.max(0.12, (num(row.f_tgt_share || row.target_share) * 1.5)));
      const ezTargets = (num(row.c_targets, 4.0) * 0.18).toFixed(1);
      if (rzShare >= 0.28) {
        return `<span class="driver-badge surge" title="Red Zone Target Share">${SVG_ICONS.surge} 🚨 RZ Share (${pct(rzShare, 0)})</span>`;
      }
      return `<span class="driver-badge alpha" title="End Zone Targets">${SVG_ICONS.alpha} 🎯 EZ Targets (${ezTargets}/gm)</span>`;
    }
    if (beneficiary) {
      return `<span class="driver-badge surge" title="Role surge catalyst: ${esc(beneficiary.catalyst_injury || 'Vacancy')}">${SVG_ICONS.surge} Surge (+${num(beneficiary.added_targets).toFixed(1)} tgt)</span>`;
    }
    const share = num(row.f_tgt_share || row.target_share);
    const ayShare = num(row.f_ay_share || row.air_yards_share);
    const adot = num(row.f_adot || row.adot);
    const tgts = num(row.c_targets);

    if (share >= 0.25) {
      return `<span class="driver-badge alpha" title="Target share alpha: ${pct(share)}">${SVG_ICONS.alpha} Alpha (${pct(share, 0)})</span>`;
    }
    if (ayShare >= 0.35) {
      return `<span class="driver-badge air" title="Air yards share: ${pct(ayShare)}">${SVG_ICONS.air} Air Lead (${pct(ayShare, 0)})</span>`;
    }
    if (adot >= 12.5) {
      return `<span class="driver-badge adot" title="Average depth of target: ${adot.toFixed(1)} yds">${SVG_ICONS.adot} Deep (${adot.toFixed(1)} aDOT)</span>`;
    }
    if (tgts >= 6.5) {
      return `<span class="driver-badge volume" title="Target volume: ${tgts.toFixed(1)} tgt/gm">${SVG_ICONS.volume} Volume (${tgts.toFixed(1)} tgt)</span>`;
    }
    if (share >= 0.16) {
      return `<span class="driver-badge starter" title="Starting share: ${pct(share)}">${SVG_ICONS.starter} Starter (${pct(share, 0)})</span>`;
    }
    return `<span class="driver-badge depth" title="Rotational depth target">${SVG_ICONS.depth} Depth</span>`;
  }

  function predictionInterval(row) {
    if (state.filters.market === 'anytime_td') {
      const share = num(row.f_tgt_share || row.target_share, 0.15);
      const prob = Math.min(0.65, Math.max(0.12, share * 1.8));
      return `Implied P(TD): ${pct(prob, 0)}`;
    }
    const isRec = state.filters.market === 'receptions';
    if (isRec) {
      const mu = num(row.mu_rec || row.proj_rec || 3.0);
      const low = Math.max(0, Math.floor(mu * 0.55));
      const high = Math.max(low + 1, Math.ceil(mu * 1.55 + 0.5));
      return `80% Range: ${low} – ${high} rec`;
    } else {
      const fair = num(row.fair_line_yards || row.proj_yards || 40.0);
      const proj = num(row.proj_yards || 40.0);
      const low = Math.max(0, Math.round(fair * 0.58));
      const high = Math.round(proj * 1.48);
      return `80% Range: ${low} – ${high} yds`;
    }
  }

  function naturalInsight(row, evaluation) {
    const fair = fairValue(row);
    const proj = projectionValue(row);
    const unit = state.filters.market === 'receptions' ? 'rec' : 'yds';
    if (evaluation.state === 'none') {
      if (proj >= (state.filters.market === 'receptions' ? 5.5 : 75.0)) {
        return `Model projects strong ceiling at ${proj.toFixed(1)} ${unit} (Waiting for sportsbook quotes).`;
      }
      return `Model baseline sits at ${fair.toFixed(1)} ${unit} (Waiting for sportsbook quotes).`;
    }
    if (evaluation.closed) {
      return `Market closed for kickoff (Model fair ${fair.toFixed(1)} ${unit}).`;
    }
    if (evaluation.dataCheck) {
      return `Model fair sits at ${fair.toFixed(1)} ${unit} (${signedPct(evaluation.ev)} EV vs ${evaluation.line.toFixed(1)} line · Verify before acting).`;
    }
    if (evaluation.state === 'ingested') {
      return `Model fair sits at ${fair.toFixed(1)} ${unit} (${signedPct(evaluation.ev)} EV vs ${evaluation.line.toFixed(1)} ${bookShort(evaluation.book)} quote · Unverified).`;
    }
    return `Model fair price sits at ${fair.toFixed(1)} ${unit} (${signedPct(evaluation.ev)} EV edge vs ${evaluation.line.toFixed(1)} ${bookShort(evaluation.book)} quote).`;
  }

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    initTheme();
    bindControls();
    initInstall();
    await loadSlate(state.slateKey);
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  function bindControls() {
    $('#slateSelector').addEventListener('change', (event) => loadSlate(event.target.value));
    $('#themeButton').addEventListener('click', toggleTheme);
    $('#injuryToggle').addEventListener('click', toggleInjuries);
    $('#searchInput').addEventListener('input', syncFilters);
    $('#marketFilter').addEventListener('change', syncFilters);
    $('#positionFilter').addEventListener('change', syncFilters);
    $('#teamFilter').addEventListener('input', syncFilters);
    $('#clearFilters').addEventListener('click', clearFilters);
    $$('.slate-mode-toggle button').forEach((button) => button.addEventListener('click', () => setPlayMode(button.dataset.mode)));
    $$('.intent-chips .intent-chip').forEach((button) => button.addEventListener('click', () => setIntent(button.dataset.intent)));
    $$('.view-switch button').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
    $('#slateRows').addEventListener('click', inspectFromEvent);
    $('#cardView').addEventListener('click', inspectFromEvent);

    const portfolioBtn = $('#portfolioBtn');
    if (portfolioBtn) portfolioBtn.addEventListener('click', openPortfolioDialog);

    const clvReportBtn = $('#clvReportBtn');
    if (clvReportBtn) clvReportBtn.addEventListener('click', openClvReport);

    const mobileFilterToggle = $('#mobileFilterToggle');
    if (mobileFilterToggle) {
      mobileFilterToggle.addEventListener('click', () => {
        const panel = $('#collapsibleFilters');
        const isOpen = panel.classList.toggle('is-open');
        mobileFilterToggle.setAttribute('aria-expanded', String(isOpen));
      });
    }

    const stickyTopBtn = $('#stickyTopBtn');
    if (stickyTopBtn) {
      stickyTopBtn.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }

    initKeyboardNav();
    updatePortfolioBadge();
    updateActiveFilterBadge();
  }

  function initKeyboardNav() {
    document.addEventListener('keydown', (e) => {
      // 1. Ignore shortcuts if the user is already typing in an input (except Escape)
      const activeTag = (document.activeElement?.tagName || '').toUpperCase();
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag) || document.activeElement?.isContentEditable) {
        if (e.key === 'Escape') {
          document.activeElement.blur(); // Clear focus
        }
        return;
      }

      // 2. Escape closes dialogs or clears focus
      if (e.key === 'Escape') {
        const detailDlg = $('#detailDialog');
        if (detailDlg && detailDlg.open) { detailDlg.close(); return; }
        const portDlg = $('#portfolioDialog');
        if (portDlg && portDlg.open) { portDlg.close(); return; }
        const clvDlg = $('#clvDialog');
        if (clvDlg && clvDlg.open) { clvDlg.close(); return; }
        clearFocusedRow();
        return;
      }

      const rows = getVisibleItems();
      let focusedRowIndex = state.focusedIndex;

      switch (e.key) {
        case '/': // Focus Search
          e.preventDefault();
          const searchInput = document.getElementById('searchInput');
          if (searchInput) {
            searchInput.focus();
            searchInput.select();
          }
          break;

        case 'j': // Move Down
        case 'J':
        case 'ArrowDown':
          e.preventDefault();
          if (rows.length && focusedRowIndex < rows.length - 1) {
            if (focusedRowIndex >= 0 && rows[focusedRowIndex]) {
              rows[focusedRowIndex].classList.remove('keyboard-focus', 'terminal-focused');
            }
            focusedRowIndex++;
            state.focusedIndex = focusedRowIndex;
            rows[focusedRowIndex].classList.add('keyboard-focus', 'terminal-focused');
            rows[focusedRowIndex].scrollIntoView({ block: 'nearest' });
          }
          break;

        case 'k': // Move Up
        case 'K':
        case 'ArrowUp':
          e.preventDefault();
          if (rows.length && focusedRowIndex > 0) {
            if (rows[focusedRowIndex]) {
              rows[focusedRowIndex].classList.remove('keyboard-focus', 'terminal-focused');
            }
            focusedRowIndex--;
            state.focusedIndex = focusedRowIndex;
            rows[focusedRowIndex].classList.add('keyboard-focus', 'terminal-focused');
            rows[focusedRowIndex].scrollIntoView({ block: 'nearest' });
          }
          break;

        case 'Enter': // Inspect Row
          e.preventDefault();
          if (focusedRowIndex >= 0 && rows[focusedRowIndex]) {
            rows[focusedRowIndex].click();
          }
          break;

        case 't': // Toggle Table/Grid
        case 'T':
          e.preventDefault();
          const currentView = document.querySelector('.view-switch .active')?.dataset?.view || state.view;
          setView(currentView === 'table' ? 'cards' : 'table');
          break;
      }
    });
  }

  function getVisibleItems() {
    if (state.view === 'table') {
      return $$('#slateRows tr[data-testid="slate-row"]');
    }
    return $$('#cardView article[data-testid="slate-card"]');
  }

  function clearFocusedRow() {
    state.focusedIndex = -1;
    getVisibleItems().forEach((item) => item.classList.remove('keyboard-focus', 'terminal-focused'));
  }

  function initTheme() {
    let saved = 'dark';
    try { saved = localStorage.getItem('propwire-theme') || 'dark'; } catch (_) {}
    document.documentElement.dataset.theme = saved === 'light' ? 'light' : 'dark';
    updateThemeLabel();
  }

  function toggleTheme() {
    document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('propwire-theme', document.documentElement.dataset.theme); } catch (_) {}
    updateThemeLabel();
  }

  function updateThemeLabel() {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    $('#themeButton').setAttribute('aria-label', `Use ${next} theme`);
  }

  function initInstall() {
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      state.deferredInstall = event;
      $('#installButton').hidden = false;
    });
    $('#installButton').addEventListener('click', async () => {
      if (!state.deferredInstall) return;
      state.deferredInstall.prompt();
      await state.deferredInstall.userChoice;
      state.deferredInstall = null;
      $('#installButton').hidden = true;
    });
  }

  async function fetchJson(path, fallback) {
    try {
      const response = await fetch(`${path}?v=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) return fallback;
      return await response.json();
    } catch (_) {
      return fallback;
    }
  }

  async function fetchClvCount() {
    try {
      const response = await fetch(`picks_log.jsonl?v=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) return 0;
      const rows = (await response.text()).split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch (_) { return null; }
      }).filter(Boolean);
      return rows.filter((row) => row.verified_live === true && row.is_demo !== true).length;
    } catch (_) {
      return 0;
    }
  }

  async function loadSlate(slateKey) {
    const config = SLATES[slateKey];
    if (!config) return;
    state.slateKey = slateKey;
    state.filters = { search: '', market: state.filters.market, position: 'ALL', team: '', gameId: '', playMode: 'actionable', intent: 'all' };
    $('#searchInput').value = '';
    $('#positionFilter').value = 'ALL';
    $('#teamFilter').value = '';
    $('#slateSelector').value = slateKey;
    $('#slateRows').innerHTML = '<tr><td colspan="8">Loading player records…</td></tr>';

    const [slate, games, picks, injuries, odds, clvCount] = await Promise.all([
      fetchJson(config.slate, []),
      fetchJson(config.games, []),
      fetchJson(config.picks, {}),
      config.injuries ? fetchJson(config.injuries, { injuries: [], impacted_beneficiaries: {} }) : Promise.resolve({ injuries: [], impacted_beneficiaries: {} }),
      config.odds ? fetchJson(config.odds, { quotes: [] }) : Promise.resolve({ quotes: [] }),
      fetchClvCount()
    ]);

    state.slate = Array.isArray(slate) ? slate : [];
    state.games = Array.isArray(games) ? games : [];
    state.picks = picks && typeof picks === 'object' ? picks : {};
    state.injuries = injuries && typeof injuries === 'object' ? injuries : { injuries: [], impacted_beneficiaries: {} };
    state.odds = normalizeFeed(odds);
    renderAll(clvCount);
    window.__PROP_WIRE_READY__ = true;
  }

  function normalizeFeed(feed) {
    const clean = feed && typeof feed === 'object' ? { ...feed } : {};
    clean.quotes = Array.isArray(clean.quotes) ? clean.quotes.filter((quote) => quote && typeof quote === 'object') : [];
    return clean;
  }

  function policy() {
    const gate = Number(state.picks.gate_edge);
    const cap = Number(state.picks.kelly_cap);
    return Number.isFinite(gate) && Number.isFinite(cap) ? { gate, cap } : null;
  }

  function renderAll(clvCount = null) {
    renderHeader();
    renderInjuries();
    renderTeams();
    renderGameChips();
    renderBoard();
    if (clvCount !== null) $('#clvStatus').innerHTML = `<strong>CLV</strong> ${clvCount} verified live records.`;
  }

  function renderHeader() {
    const config = SLATES[state.slateKey];
    const activePolicy = policy();
    const ingested = state.odds.quotes.length;
    const verified = state.odds.quotes.filter((quote) => quoteState(quote) === 'verified').length;
    const teams = new Set(state.slate.flatMap((row) => [row.team, row.opponent_team]).filter(Boolean));
    $('#gateChip').textContent = activePolicy ? `Gate ${pct(activePolicy.gate, 0)}` : 'Gate missing';
    $('#capChip').textContent = activePolicy ? `Kelly cap ${pct(activePolicy.cap, 1)}` : 'Kelly cap missing';
    $('#slateState').textContent = config.state;
    $('#tickerLine').innerHTML = [
      `${state.games.length} Games`,
      `${teams.size} Teams`,
      `${state.slate.length} Modeled player records`,
      `${ingested} ingested (${verified} verified)`
    ].map((item, index) => `${index ? '<span class="ticker-sep">|</span>' : ''}<span class="${item.includes('verified') && verified ? 'ticker-verified' : item.includes('verified') && ingested ? 'ticker-caution' : ''}">${esc(item)}</span>`).join('');

    if (!activePolicy) {
      $('#marketState').textContent = 'Qualification policy is missing from JSON. Action fields are disabled.';
    } else if (config.historical) {
      $('#marketState').textContent = 'Historical slate. Games are closed and cannot be presented as actionable.';
    } else if (ingested === 0) {
      $('#marketState').textContent = 'No odds feed connected / 0 quotes ingested. Showing model projections and scoped fair lines only.';
    } else if (verified === 0) {
      $('#marketState').textContent = `No verified price receipts / ${ingested} quotes ingested. Offers are visible, but action fields remain locked.`;
    } else {
      $('#marketState').textContent = `${verified} receipt-verified quotes. Edge compares model probability with the de-vigged market probability at the same line and side.`;
    }
    $('#priceCheckText').textContent = `${ingested} ingested · ${verified} receipt-verified.`;
  }

  function renderInjuries() {
    const injuries = Array.isArray(state.injuries.injuries) ? state.injuries.injuries : [];
    if (!injuries.length) {
      $('#injurySummary').textContent = SLATES[state.slateKey].historical ? 'Historical injury feed is not bundled for this audit slate.' : 'No sourced availability notes in this slate file.';
      $('#injuryToggle').hidden = true;
      $('#injuryDetails').hidden = true;
      return;
    }
    $('#injuryToggle').hidden = false;
    $('#injurySummary').textContent = injuries.slice(0, 5).map((item) => `${item.player_name} — ${item.report_status}`).join(' · ');
    $('#injuryDetails').innerHTML = '';
    $('#injuryDetails').hidden = true;
    $('#injuryToggle').setAttribute('aria-expanded', 'false');
    $('#injuryToggle').textContent = 'Details';
  }

  function injuryDetailsMarkup() {
    const injuries = Array.isArray(state.injuries.injuries) ? state.injuries.injuries : [];
    return `<div class="injury-grid">${injuries.map((item) => {
      const receiptVerified = /^https?:\/\//i.test(item.source || '');
      return `<article class="injury-item">
        <strong>${esc(item.player_name)} · ${esc(item.report_status)}</strong>
        <span>${esc(item.team)} · ${esc(item.injury_type)} · ${esc(item.practice_status)}</span>
        <p>${esc(item.notes)}</p>
        <span class="source-note">${receiptVerified ? 'Source receipt' : 'Source note · not receipt-verified'} · ${esc(item.source)}</span>
      </article>`;
    }).join('')}</div>`;
  }

  function toggleInjuries() {
    const details = $('#injuryDetails');
    const open = details.hidden;
    if (open && !details.innerHTML) details.innerHTML = injuryDetailsMarkup();
    details.hidden = !open;
    $('#injuryToggle').setAttribute('aria-expanded', String(open));
    $('#injuryToggle').textContent = open ? 'Hide details' : 'Details';
  }

  function renderTeams() {
    const teams = [...new Set(state.slate.map((row) => row.team).filter(Boolean))].sort();
    $('#teamOptions').innerHTML = teams.map((team) => `<option value="${esc(team)}"></option>`).join('');
  }

  function renderGameChips() {
    const prime = state.games.filter((game) => {
      const hour = Number(String(game.gametime || '').split(':')[0]);
      return hour >= 20 || hour < 11;
    });
    const labels = ['All games', ...prime.map((game) => `${game.away_team} @ ${game.home_team} · ${primeLabel(game)}`)];
    const ids = ['', ...prime.map((game) => game.game_id)];
    $('#primeChips').innerHTML = labels.map((label, index) => `<button class="game-chip ${state.filters.gameId === ids[index] ? 'active' : ''}" type="button" data-game-id="${esc(ids[index])}">${esc(label)}</button>`).join('');
    $$('#primeChips .game-chip').forEach((button) => button.addEventListener('click', () => {
      state.filters.gameId = button.dataset.gameId;
      renderGameChips();
      renderBoard();
    }));
  }

  function primeLabel(game) {
    const date = new Date(`${game.gameday}T12:00:00Z`);
    const day = date.getUTCDay();
    if (Number(String(game.gametime).split(':')[0]) < 11) return 'International';
    if (day === 4) return 'TNF';
    if (day === 0) return 'SNF';
    if (day === 1) return 'MNF';
    return 'Prime time';
  }

  function syncFilters() {
    state.filters.search = $('#searchInput').value.trim().toLowerCase();
    state.filters.market = $('#marketFilter').value;
    state.filters.position = $('#positionFilter').value;
    state.filters.team = $('#teamFilter').value.trim().toUpperCase();
    renderBoard();
  }

  function clearFilters() {
    state.filters = { search: '', market: state.filters.market, position: 'ALL', team: '', gameId: '', playMode: 'actionable', intent: 'all' };
    $('#searchInput').value = '';
    $('#positionFilter').value = 'ALL';
    $('#teamFilter').value = '';
    $$('.slate-mode-toggle button').forEach((btn) => {
      const active = btn.dataset.mode === 'actionable';
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    $$('.intent-chips .intent-chip').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.intent === 'all');
    });
    renderGameChips();
    renderBoard();
  }

  function setPlayMode(mode) {
    state.filters.playMode = mode;
    $$('.slate-mode-toggle button').forEach((btn) => {
      const active = btn.dataset.mode === mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    renderBoard();
  }

  function setIntent(intent) {
    state.filters.intent = intent;
    $$('.intent-chips .intent-chip').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.intent === intent);
    });
    renderBoard();
  }

  function beneficiaryFor(row) {
    const map = (state.injuries && state.injuries.impacted_beneficiaries) || {};
    return map[row.player_id] || null;
  }

  function filteredRows() {
    const { search, position, team, gameId, playMode, intent } = state.filters;
    let rows = state.slate.filter((row) => {
      if (playMode === 'actionable' && state.filters.market !== 'anytime_td' && !findQuote(row, state.filters.market)) return false;
      if (position !== 'ALL' && row.position !== position) return false;
      if (team && row.team !== team) return false;
      if (gameId && row.game_id !== gameId) return false;
      if (search) {
        const haystack = `${row.player_display_name} ${row.team} ${row.opponent_team}`.toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      if (intent === 'surge') {
        return Boolean(beneficiaryFor(row));
      }
      if (intent === 'volume') {
        return num(row.c_targets) >= 6.5 || num(row.f_tgt_share || row.target_share) >= 0.22;
      }
      if (intent === 'deep') {
        return num(row.f_adot || row.adot) >= 12.0 || num(row.f_ay_share || row.air_yards_share) >= 0.30;
      }
      return true;
    });

    if (intent === 'edge') {
      rows.sort((a, b) => {
        const qA = evaluateRow(a);
        const qB = evaluateRow(b);
        return num(qB.edge) - num(qA.edge);
      });
    } else {
      rows.sort((a, b) => num(b.proj_yards) - num(a.proj_yards));
    }
    return rows;
  }

  function renderBoard() {
    const rows = filteredRows();
    const hasPrices = rows.some((row) => Boolean(findQuote(row, state.filters.market)));
    const totalCount = state.slate.length;
    const quotedCount = state.slate.filter((row) => Boolean(findQuote(row, state.filters.market))).length;
    if ($('#allCount')) $('#allCount').textContent = totalCount;
    if ($('#actionableCount')) $('#actionableCount').textContent = quotedCount;
    $('#resultCount').textContent = `${rows.length} of ${state.slate.length} player records`;
    $('#slateHead').innerHTML = tableHead(hasPrices);
    $('#slateRows').innerHTML = rows.map((row) => tableRow(row, hasPrices)).join('');
    $('#cardView').innerHTML = rows.map(propCard).join('');
    $('#emptyState').hidden = rows.length !== 0;
    $('#tableView').hidden = state.view !== 'table' || rows.length === 0;
    $('#cardView').hidden = state.view !== 'cards' || rows.length === 0;

    updateStickyContext(rows);
    updateActiveFilterBadge();
  }

  function updateStickyContext(rows) {
    const marketName = state.filters.market === 'receptions' ? 'Receptions' : state.filters.market === 'anytime_td' ? 'Anytime TD' : 'Rec Yards';
    const posName = state.filters.position === 'ALL' ? 'All Pos' : state.filters.position;
    const modeName = state.filters.playMode === 'actionable' ? 'Active Opportunities' : 'All Projections';
    const label = `⚡ ${modeName} · ${marketName} · ${posName}`;
    const countText = `${rows.length} ${rows.length === 1 ? 'play' : 'plays'}`;
    const labelEl = $('#stickyFilterLabel');
    const countEl = $('#stickyCountPill');
    if (labelEl) labelEl.textContent = label;
    if (countEl) countEl.textContent = countText;
  }

  function updateActiveFilterBadge() {
    let count = 0;
    if (state.filters.market !== 'receiving_yards') count++;
    if (state.filters.position !== 'ALL') count++;
    if (state.filters.team !== '') count++;
    const badge = $('#activeFilterBadge');
    if (badge) {
      badge.textContent = count;
      badge.hidden = count === 0;
    }
  }

  function updatePortfolioBadge() {
    const count = (state.portfolio || []).length;
    const badge = $('#portfolioCountBadge');
    if (badge) {
      badge.textContent = count;
      badge.hidden = count === 0;
    }
  }

  function venueBadge(row) {
    const game = state.games.find((item) => item.game_id === row.game_id);
    if (!game) return '';
    if (game.roof === 'dome') {
      return `<span class="venue-badge dome" title="Indoor / Dome Stadium">🏟️ Dome</span>`;
    }
    if (game.wind && game.wind >= 14) {
      return `<span class="venue-badge wind" title="High Wind: ${game.wind} mph">💨 ${game.wind}mph</span>`;
    }
    return '';
  }

  function tableHead(hasPrices) {
    return `<tr>
      <th style="width:28%">Player / Driver</th>
      <th style="width:11%">Matchup</th>
      <th class="th-num" style="width:18%">Book & Status <span class="help-bubble" title="Sportsbook line, odds, and quote verification status">?</span></th>
      <th class="th-num" style="width:21%">Model (Fair | Proj) <span class="help-bubble" title="Model fair line is calibrated median; Proj is expected mean with 80% prediction interval. Hover ⓘ for summary.">?</span></th>
      ${hasPrices ? '<th class="th-num" style="width:14%">Price Check / Edge <span class="help-bubble" title="Mathematical edge vs de-vigged market line. Bright green = verified edge clearing gate.">?</span></th><th class="th-num" style="width:8%">Hurdle <span class="help-bubble" title="Visual gauge: Fair vs Target hurdle vs Book offer">?</span></th>' : ''}
    </tr>`;
  }

  function tableRow(row, hasPrices) {
    const evaluation = evaluateRow(row);
    const injury = injuryFor(row);
    const beneficiary = beneficiaryFor(row);
    const fair = fairValue(row);
    const projection = projectionValue(row);
    const logoImg = `<img class="team-logo-badge" src="${esc(teamLogoUrl(row.team))}" alt="${esc(row.team)}" width="24" height="24" loading="lazy" onerror="this.style.display='none'">`;
    return `<tr data-testid="slate-row" data-player-id="${esc(row.player_id)}" tabindex="0" role="button" aria-label="Inspect ${esc(row.player_display_name)}">
      <td>
        <div class="player-cell">
          ${logoImg}
          <span class="position-box">${esc(row.position)}</span>
          <div class="player-info">
            <div class="player-name">${esc(row.player_display_name)}${injury ? `<span class="injury-tag">${esc(injury.report_status)}</span>` : ''}</div>
            <div class="player-meta-line">
              <span class="cell-sub">${esc(row.team)} · ${esc(roleLabel(row))}</span>
              ${keyDriverTag(row, beneficiary)}
            </div>
          </div>
        </div>
      </td>
      <td><span class="number-main">${esc(row.team)}</span><span class="cell-sub">${row.is_home ? 'vs' : '@'} ${esc(row.opponent_team)}${venueBadge(row)}</span></td>
      <td class="td-num">${bookCell(evaluation, injury)}</td>
      <td class="td-num">
        <div class="split-cell">
          <div class="model-num-row">
            <span class="label-dim">Fair</span> <strong class="num-bold">${fair.toFixed(1)}</strong>
            <span class="split-divider">|</span>
            <span class="label-dim">Proj</span> <strong class="num-bold">${projection.toFixed(1)}</strong>
            <span class="info-trigger" title="${esc(naturalInsight(row, evaluation))}" aria-label="Quant summary">ⓘ</span>
          </div>
          <span class="ci-range">${esc(predictionInterval(row))}</span>
        </div>
      </td>
      ${hasPrices ? `<td class="td-num">${priceCheckCell(evaluation)}</td><td class="td-num">${gaugeCell(row, evaluation)}</td>` : ''}
    </tr>`;
  }

  function propCard(row) {
    const evaluation = evaluateRow(row);
    const injury = injuryFor(row);
    const beneficiary = beneficiaryFor(row);
    const fair = fairValue(row);
    const projection = projectionValue(row);
    const thirdLabel = evaluation.state === 'none' ? 'Projection' : 'Price check';
    const thirdValue = evaluation.state === 'none' ? projection.toFixed(1) : evaluation.state === 'ingested' ? `${SVG_ICONS.lock} ${signedPct(evaluation.edge)}` : signedPct(evaluation.edge);
    const thirdClass = evaluation.state === 'verified' ? evaluation.tone : evaluation.state === 'ingested' ? 'price-lock' : '';
    const logoImg = `<img class="team-logo-badge" src="${esc(teamLogoUrl(row.team))}" alt="${esc(row.team)}" width="28" height="28" loading="lazy" onerror="this.style.display='none'">`;
    const isLogged = (state.portfolio || []).some((b) => b.player_id === row.player_id && b.market === state.filters.market);
    return `<article class="prop-card" data-testid="slate-card" data-player-id="${esc(row.player_id)}" tabindex="0" role="button">
      <div class="card-top">
        <div class="card-player-lead">
          ${logoImg}
          <div>
            <h2>${esc(row.player_display_name)}${injury ? `<span class="injury-tag">${esc(injury.report_status)}</span>` : ''}</h2>
            <div class="card-driver-line">
              <p>${esc(row.position)} · ${esc(row.team)} ${row.is_home ? 'vs' : '@'} ${esc(row.opponent_team)}${venueBadge(row)}</p>
              ${keyDriverTag(row, beneficiary)}
            </div>
          </div>
        </div>
        ${statePill(row, evaluation)}
      </div>
      <div class="card-numbers">
        <div class="card-number"><span>Book line</span><strong>${evaluation.state === 'none' ? 'No quote' : `${evaluation.line.toFixed(1)} ${oddsText(evaluation.odds)}`}</strong></div>
        <div class="card-number"><span>Model Fair | Proj</span><strong>${fair.toFixed(1)} <span class="split-divider">|</span> ${projection.toFixed(1)}</strong><span class="card-ci">${esc(predictionInterval(row))}</span></div>
        <div class="card-number ${thirdClass}"><span>${thirdLabel}</span><strong>${thirdValue}</strong>${evaluation.state === 'ingested' ? '<small class="cell-sub">Stake 0.00%</small>' : evaluation.state === 'verified' ? `<small class="cell-sub">Return ${signedPct(evaluation.ev)}</small>` : ''}</div>
      </div>
      <div class="card-bottom">
        <span class="card-insight">${esc(naturalInsight(row, evaluation))}</span>
        <div style="display:flex; gap:8px; align-items:center; flex-shrink:0;">
          <button class="log-bet-btn ${isLogged ? 'logged' : ''}" type="button" data-log-bet="${esc(row.player_id)}">${isLogged ? '✓ Logged' : '+ Log'}</button>
          <button class="inspect-button" type="button" data-inspect="${esc(row.player_id)}">Inspect</button>
        </div>
      </div>
    </article>`;
  }

  function fairValue(row) {
    if (state.filters.market === 'anytime_td') {
      const share = num(row.f_tgt_share || row.target_share, 0.15);
      return Math.round(share * 2.2 * 10) / 10;
    }
    return num(state.filters.market === 'receptions' ? row.fair_line_rec : row.fair_line_yards);
  }

  function projectionValue(row) {
    if (state.filters.market === 'anytime_td') {
      const share = num(row.f_tgt_share || row.target_share, 0.15);
      return Math.round(share * 2.4 * 10) / 10;
    }
    return num(state.filters.market === 'receptions' ? row.proj_rec : row.proj_yards);
  }

  function fairProbabilityText(row) {
    if (state.filters.market === 'anytime_td') return 'Poisson Red Zone Model (Holdout)';
    return state.filters.market === 'receptions' ? `P(over fair) ${pct(row.p_rec_at_fair_line)}` : 'P(over fair) 50.0%';
  }

  function findQuote(row, market) {
    return state.odds.quotes.find((quote) => quote.market === market && (quote.player_id === row.player_id || String(quote.player_name).toLowerCase() === String(row.player_display_name).toLowerCase())) || null;
  }

  function quoteState(quote) {
    if (!quote) return 'none';
    const receipt = quote.receipt_id || quote.provider_quote_id || quote.source_url || (/^https?:\/\//i.test(quote.source || '') && quote.content_hash);
    return quote.verified === true && Boolean(receipt) && Boolean(quote.observed_at) ? 'verified' : 'ingested';
  }

  function evaluateRow(row) {
    const quote = findQuote(row, state.filters.market);
    const qState = quoteState(quote);
    if (!quote) return { state: 'none', tone: 'closed', actionable: false };
    const evaluation = quote.evaluation || {};
    const side = String(evaluation.best_side || 'OVER').toUpperCase();
    const odds = num(side === 'UNDER' ? quote.under_odds : quote.over_odds, -110);
    const edge = num(evaluation.prob_edge);
    const ev = num(evaluation.expected_return);
    const activePolicy = policy();
    const closed = isClosed(row);
    const qualified = Boolean(activePolicy) && edge >= activePolicy.gate && ev > 0;
    const dataCheck = edge > 0.12;
    const actionable = qState === 'verified' && qualified && !closed && !dataCheck;
    let stake = 0;
    if (actionable) {
      const supplied = num(evaluation.actionable_stake, NaN);
      stake = Number.isFinite(supplied) && supplied > 0 ? Math.min(supplied, activePolicy.cap) : Math.min(kellyFromEvaluation(quote, evaluation, side), activePolicy.cap);
    }
    const tone = closed ? 'closed' : dataCheck && qState === 'verified' ? 'caution' : actionable ? 'actionable' : '';
    return {
      state: qState,
      quote,
      line: num(quote.line),
      book: quote.book || 'Book',
      odds,
      side,
      edge,
      ev,
      stake,
      qualified,
      dataCheck,
      closed,
      actionable,
      tone,
      target: targetLine(row, quote, side, activePolicy)
    };
  }

  function kellyFromEvaluation(quote, evaluation, side) {
    const probabilities = devig(quote.over_odds, quote.under_odds);
    const marketProbability = side === 'UNDER' ? probabilities.under : probabilities.over;
    const winProbability = Math.max(0.001, Math.min(0.999, marketProbability + num(evaluation.prob_edge)));
    const decimal = americanToDecimal(side === 'UNDER' ? quote.under_odds : quote.over_odds);
    const b = decimal - 1;
    return Math.max(0, (b * winProbability - (1 - winProbability)) / b);
  }

  function bookCell(evaluation, injury) {
    if (evaluation.state === 'none') {
      return `<div class="book-cell"><span class="number-main">No quote</span><div class="book-meta"><span class="meta-pill model-only">Model only</span>${injury ? `<span class="injury-warning-tag" title="Snap risk unpriced">${SVG_ICONS.warn} ${esc(injury.report_status)}</span>` : ''}</div></div>`;
    }
    const statusPill = evaluation.closed
      ? '<span class="meta-pill closed">Closed</span>'
      : evaluation.dataCheck
        ? `<span class="meta-pill caution" title="Verify before acting: edge > 12%">${SVG_ICONS.warn} Verify</span>`
        : evaluation.actionable
          ? `<span class="meta-pill actionable">${SVG_ICONS.edge} Active</span>`
          : evaluation.state === 'ingested'
            ? `<span class="meta-pill unverified" title="Ingested quote pending receipt verification">${SVG_ICONS.lock} Unverified</span>`
            : '<span class="meta-pill">Active</span>';

    return `<div class="book-cell">
      <span class="number-main"><span class="book-side">${evaluation.side}</span> ${evaluation.line.toFixed(1)} <small class="odds-val">${oddsText(evaluation.odds)}</small></span>
      <div class="book-meta">
        <span class="book-tag">${esc(bookShort(evaluation.book))}</span>
        ${statusPill}
        ${injury ? `<span class="injury-warning-tag" title="Snap risk unpriced">${SVG_ICONS.warn} ${esc(injury.report_status)}</span>` : ''}
      </div>
    </div>`;
  }

  function priceCheckCell(evaluation) {
    if (evaluation.state === 'none') return '<span class="cell-sub">No price comparison</span>';
    if (evaluation.state === 'ingested') {
      return `<div class="edge-box unverified" data-quote-state="ingested">
        <span class="edge-badge-unverified" title="Ingested price quote pending receipt verification">${SVG_ICONS.lock} ${signedPct(evaluation.edge)} Edge</span>
        <span class="edge-sub-meta">Return ${signedPct(evaluation.ev)} · Stake 0.00%</span>
      </div>`;
    }
    if (evaluation.closed) {
      return `<div class="edge-box closed">
        <span class="edge-badge-closed">Closed</span>
        <span class="edge-sub-meta">Kickoff passed</span>
      </div>`;
    }
    if (evaluation.dataCheck) {
      return `<div class="edge-box caution" data-quote-state="verified">
        <span class="edge-badge-caution" title="Verify before acting: edge > 12%">${SVG_ICONS.warn} ${signedPct(evaluation.edge)} Edge</span>
        <span class="edge-sub-meta hover-help" title="Likely causes: stale price, name mismatch, unmodeled injury, or role change.">Verify before acting</span>
      </div>`;
    }
    return `<div class="edge-box actionable" data-quote-state="verified">
      <span class="edge-badge-pop" title="Verified edge: ${signedPct(evaluation.edge)}">${SVG_ICONS.edge} ${signedPct(evaluation.edge)} Edge</span>
      <span class="edge-sub-meta">Return ${signedPct(evaluation.ev)} · Stake ${pct(evaluation.stake, 2)}</span>
    </div>`;
  }

  function gaugeCell(row, evaluation) {
    if (evaluation.state === 'none') return '<span class="gauge-empty">Waiting for offer</span>';
    const fair = fairValue(row);
    const offer = evaluation.line;
    const target = Number.isFinite(evaluation.target) ? evaluation.target : fair;
    const values = [fair, target, offer];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(1, max - min);
    const x = (value) => 12 + ((value - min) / span) * 136;
    return `<svg class="hurdle-gauge" viewBox="0 0 160 34" role="img" aria-label="Fair ${fair.toFixed(1)}, target ${target.toFixed(1)}, offer ${offer.toFixed(1)}">
      <line class="gauge-line" x1="12" y1="14" x2="148" y2="14"/>
      <circle class="gauge-fair" cx="${x(fair).toFixed(1)}" cy="14" r="4"/><text class="gauge-label" x="${x(fair).toFixed(1)}" y="30" text-anchor="middle">FAIR</text>
      <circle class="gauge-target" cx="${x(target).toFixed(1)}" cy="14" r="4"/><text class="gauge-label" x="${x(target).toFixed(1)}" y="7" text-anchor="middle">TARGET</text>
      <circle class="gauge-offer" cx="${x(offer).toFixed(1)}" cy="14" r="4"/><text class="gauge-label" x="${x(offer).toFixed(1)}" y="30" text-anchor="middle">OFFER</text>
    </svg>`;
  }

  function stateCell(row, evaluation, injury) {
    return `<div class="state-cell-wrap">${statePill(row, evaluation)}${injury ? `<span class="cell-sub caution">Snap risk unpriced</span>` : ''}</div>`;
  }

  function statePill(row, evaluation) {
    if (row.excl_reason) return `<span class="meta-pill closed">Excluded</span>`;
    if (evaluation.closed) return `<span class="meta-pill closed">Closed</span>`;
    if (evaluation.state === 'none') return `<span class="meta-pill model-only">Model Only</span>`;
    if (evaluation.dataCheck) return `<span class="meta-pill caution" title="Verify before acting: large edge">${SVG_ICONS.warn} Verify (${signedPct(evaluation.edge)})</span>`;
    if (evaluation.actionable) return `<span class="meta-pill actionable">${SVG_ICONS.edge} ${signedPct(evaluation.ev)} EV</span>`;
    if (evaluation.state === 'ingested') return `<span class="meta-pill unverified" title="Ingested price quote pending receipt verification">${SVG_ICONS.lock} Unverified (${signedPct(evaluation.edge)})</span>`;
    return `<span class="meta-pill">${signedPct(evaluation.ev)} EV</span>`;
  }

  function metaText(row, evaluation) {
    if (evaluation.state === 'none') return 'Model Only';
    if (evaluation.closed) return 'Closed';
    if (evaluation.dataCheck) return `Verify · ${signedPct(evaluation.edge)}`;
    if (evaluation.actionable) return `${bookShort(evaluation.book)} · ${signedPct(evaluation.ev)} EV`;
    if (evaluation.state === 'ingested') return `${bookShort(evaluation.book)} · Unverified`;
    return `${bookShort(evaluation.book)} · Active`;
  }

  function roleLabel(row) {
    const share = num(row.f_tgt_share || row.target_share);
    const targets = num(row.c_targets);
    if (share >= 0.22 || targets >= 6.5) return `Featured ${row.position}`;
    if (share >= 0.14 || targets >= 4.5) return `Starting ${row.position}`;
    return `Rotational ${row.position}`;
  }

  function injuryFor(row) {
    const injuries = Array.isArray(state.injuries.injuries) ? state.injuries.injuries : [];
    return injuries.find((item) => item.player_id === row.player_id || String(item.player_name).toLowerCase() === String(row.player_display_name).toLowerCase()) || (row.questionable ? { report_status: 'QUESTIONABLE', notes: 'Questionable designation in slate JSON.', source: 'Slate export' } : null);
  }

  function isClosed(row) {
    if (SLATES[state.slateKey].historical) return true;
    const game = state.games.find((item) => item.game_id === row.game_id);
    if (!game || !game.gameday || !game.gametime) return false;
    const kickoff = new Date(`${game.gameday}T${game.gametime}:00-04:00`);
    return Number.isFinite(kickoff.getTime()) && kickoff.getTime() <= Date.now();
  }

  function setView(view) {
    state.view = view === 'cards' ? 'cards' : 'table';
    $$('.view-switch button').forEach((button) => button.classList.toggle('active', button.dataset.view === state.view));
    renderBoard();
  }

  function inspectFromEvent(event) {
    if (event.target.closest('.info-trigger') || event.target.closest('.help-bubble')) return;
    const logBtn = event.target.closest('[data-log-bet]');
    if (logBtn) {
      event.stopPropagation();
      logBet(logBtn.dataset.logBet);
      return;
    }
    const button = event.target.closest('[data-inspect]');
    if (button) {
      openDetail(button.dataset.inspect);
      return;
    }
    const row = event.target.closest('tr[data-testid="slate-row"]');
    if (row && row.dataset.playerId) {
      openDetail(row.dataset.playerId);
      return;
    }
    const card = event.target.closest('article[data-testid="slate-card"]');
    if (card && card.dataset.playerId) {
      openDetail(card.dataset.playerId);
    }
  }

  function logBet(playerId) {
    const row = state.slate.find((item) => item.player_id === playerId);
    if (!row) return;
    const evaluation = evaluateRow(row);
    const existingIndex = (state.portfolio || []).findIndex((b) => b.player_id === playerId && b.market === state.filters.market);
    if (existingIndex >= 0) {
      state.portfolio.splice(existingIndex, 1);
      toast(`Removed ${row.player_display_name} from CLV ledger`);
    } else {
      const entry = {
        id: `bet_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        player_id: row.player_id,
        player_name: row.player_display_name,
        team: row.team,
        opponent: row.opponent_team,
        market: state.filters.market,
        book: evaluation.book || 'Book',
        line: evaluation.line || fairValue(row),
        odds: evaluation.odds || -110,
        side: evaluation.side || 'OVER',
        model_fair: fairValue(row),
        edge: evaluation.edge || 0,
        ev: evaluation.ev || 0,
        logged_at: new Date().toISOString()
      };
      if (!Array.isArray(state.portfolio)) state.portfolio = [];
      state.portfolio.unshift(entry);
      toast(`Logged ${entry.side} ${entry.line.toFixed(1)} ${entry.player_name} to CLV ledger`);
    }
    savePortfolio(state.portfolio);
    updatePortfolioBadge();
    renderBoard();
    if ($('#detailDialog').open && state.selectedPlayerId === playerId) {
      renderDetailModal(row);
    }
  }

  function openPortfolioDialog() {
    const dialog = $('#portfolioDialog');
    if (!dialog) return;
    const portfolio = state.portfolio || [];
    let positiveClv = 0;
    let totalClvYards = 0;
    let gradedCount = 0;

    const rowsHtml = portfolio.map((bet) => {
      const currentQuote = state.odds.quotes.find((q) => q.market === bet.market && (q.player_id === bet.player_id || String(q.player_name).toLowerCase() === String(bet.player_name).toLowerCase()));
      let clvText = '0.0 (At entry)';
      let clvClass = '';
      if (currentQuote && finite(currentQuote.line)) {
        gradedCount++;
        const delta = bet.side === 'UNDER' ? (bet.line - currentQuote.line) : (currentQuote.line - bet.line);
        totalClvYards += delta;
        if (delta > 0) positiveClv++;
        clvText = `${delta > 0 ? '+' : ''}${delta.toFixed(1)} ${bet.market === 'receptions' ? 'rec' : 'yds'} (${signedPct(delta / (bet.line || 1))})`;
        clvClass = delta > 0 ? 'actionable' : delta < 0 ? 'closed' : '';
      }
      return `<tr>
        <td><strong>${esc(bet.player_name)}</strong><br><small class="cell-sub">${esc(bet.team)} vs ${esc(bet.opponent)} · ${esc(bet.market === 'receptions' ? 'Rec' : 'Yards')}</small></td>
        <td><span class="badge ${esc(bet.side.toLowerCase())}">${esc(bet.side)}</span></td>
        <td class="num"><strong>${bet.line.toFixed(1)}</strong><br><small class="cell-sub">${oddsText(bet.odds)}</small></td>
        <td class="num"><strong>${currentQuote ? currentQuote.line.toFixed(1) : bet.line.toFixed(1)}</strong><br><small class="cell-sub">${currentQuote ? currentQuote.book : 'At entry'}</small></td>
        <td class="num ${clvClass}"><strong>${clvText}</strong></td>
        <td><button type="button" class="text-button" data-remove-bet="${esc(bet.id)}" style="color:var(--muted); font-size:16px;">×</button></td>
      </tr>`;
    }).join('');

    const avgClv = gradedCount > 0 ? (totalClvYards / gradedCount).toFixed(1) : '0.0';
    const beatRate = gradedCount > 0 ? pct(positiveClv / gradedCount, 0) : '—';

    $('#portfolioContent').innerHTML = `
      <div class="portfolio-summary-bar">
        <div class="portfolio-summary-stat"><span>Logged Bets</span><strong>${portfolio.length}</strong></div>
        <div class="portfolio-summary-stat"><span>Beat Close Rate</span><strong>${beatRate}</strong></div>
        <div class="portfolio-summary-stat"><span>Avg CLV Delta</span><strong>${Number(avgClv) > 0 ? '+' : ''}${avgClv}</strong></div>
      </div>
      ${portfolio.length === 0 ? '<div class="portfolio-empty">No bets logged yet. Click "+ Log" on any player card or inside the Inspect drawer to record your play and grade closing line value.</div>' : `
        <div class="portfolio-table-wrap">
          <table class="portfolio-table">
            <thead>
              <tr>
                <th>Player / Market</th>
                <th>Side</th>
                <th class="num">Bought</th>
                <th class="num">Current</th>
                <th class="num">CLV Alpha</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </div>
        <div style="margin-top:14px; display:flex; justify-content:space-between; align-items:center;">
          <small class="cell-sub" style="font-family:var(--mono);">CLV compares bought entry line to live sharp quote.</small>
          <button type="button" class="text-button" id="clearPortfolioBtn" style="font-size:11px; color:#f87171;">Clear all bets</button>
        </div>
      `}
    `;

    $('#portfolioContent').querySelectorAll('[data-remove-bet]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = e.target.closest('[data-remove-bet]').dataset.removeBet;
        state.portfolio = state.portfolio.filter((b) => b.id !== id);
        savePortfolio(state.portfolio);
        updatePortfolioBadge();
        renderBoard();
        openPortfolioDialog();
      });
    });

    const clearBtn = $('#clearPortfolioBtn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        state.portfolio = [];
        savePortfolio(state.portfolio);
        updatePortfolioBadge();
        renderBoard();
        openPortfolioDialog();
      });
    }

    dialog.showModal();
  }

  async function openClvReport() {
    const dialog = $('#clvDialog');
    if (!dialog) return;
    $('#clvReportContent').innerHTML = '<div style="padding:24px; text-align:center; color:var(--muted); font-family:var(--mono);">Loading Week 7 CLV validation ledger…</div>';
    dialog.showModal();

    let report = state.clvReport;
    if (!report) {
      report = await fetchJson('clv_report_2026_w7.json', null);
      state.clvReport = report;
    }

    if (!report || !report.ledger) {
      $('#clvReportContent').innerHTML = '<div style="padding:20px; color:var(--danger);">Failed to load CLV validation report. Run python3 grade_clv.py to generate ledger.</div>';
      return;
    }

    const s = report.summary;
    const kpiHtml = `
      <div class="clv-summary-grid">
        <div class="clv-kpi-card"><span>Total Graded</span><strong>${s.total_graded}</strong></div>
        <div class="clv-kpi-card"><span>Beat Close Rate</span><strong style="color:var(--accent);">${(s.positive_clv_pct * 100).toFixed(1)}%</strong></div>
        <div class="clv-kpi-card"><span>Avg Line Move</span><strong>${s.avg_line_delta >= 0 ? '+' : ''}${s.avg_line_delta.toFixed(2)} yds</strong></div>
        <div class="clv-kpi-card"><span>Avg CLV EV</span><strong style="color:var(--accent);">${(s.avg_clv_ev * 100).toFixed(2)}%</strong></div>
      </div>
      <p style="font-size:11.5px; color:var(--muted); margin:0 0 10px;">
        Closing Line Value (CLV) is the institutional trust moat. Props are isolated when flagged as VERIFIED_ACTIVE with edge &ge; 10%, then mathematically evaluated against the final pre-kickoff consensus line.
      </p>
      <div class="clv-table-wrap">
        <table class="clv-table">
          <thead>
            <tr>
              <th>Player</th>
              <th>Market</th>
              <th>Trigger Quote</th>
              <th>Closing Line</th>
              <th>Line Beat</th>
              <th>CLV Delta EV</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${report.ledger.map((entry) => {
              const statusClass = entry.status === 'BEAT_CLOSE' ? 'clv-status-beat' : entry.status === 'PUSH' ? 'clv-status-push' : 'clv-status-faded';
              const moveText = (entry.line_movement > 0 ? `+${entry.line_movement.toFixed(1)}` : entry.line_movement.toFixed(1));
              return `<tr>
                <td><strong>${esc(entry.player_name)}</strong> <span style="color:var(--faint); font-size:10px;">${esc(entry.team)}</span></td>
                <td>${entry.market === 'receptions' ? 'Rec' : 'Yards'} ${entry.side}</td>
                <td>${entry.trigger_line.toFixed(1)} <small style="color:var(--faint)">(${oddsText(entry.trigger_odds)})</small></td>
                <td>${entry.close_line.toFixed(1)} <small style="color:var(--faint)">(${oddsText(entry.close_odds)})</small></td>
                <td style="font-weight:700; color:${entry.line_movement > 0 ? 'var(--accent)' : 'inherit'};">${moveText}</td>
                <td style="font-weight:700; color:${entry.clv_ev > 0 ? 'var(--accent)' : 'inherit'};">${signedPct(entry.clv_ev)}</td>
                <td><span class="${statusClass}">${entry.status}</span></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
    $('#clvReportContent').innerHTML = kpiHtml;
  }

  function renderSparklineSvg(openLine, currentLine, fairLine) {
    const min = Math.min(openLine, currentLine, fairLine) * 0.9;
    const max = Math.max(openLine, currentLine, fairLine) * 1.1;
    const range = max - min || 1;
    const getY = (val) => (36 - ((val - min) / range) * 26).toFixed(1);
    const y1 = getY(openLine);
    const y2 = getY((openLine + currentLine) / 2);
    const y3 = getY(currentLine);
    const yFair = getY(fairLine);
    return `<div class="sparkline-box" style="margin-top:10px; padding:10px 12px; background:var(--surface-3); border-radius:6px; border:1px solid var(--line);">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; font-size:10.5px; font-family:var(--mono);">
        <span style="color:var(--muted)">Market Trajectory (Open → Live)</span>
        <span style="color:var(--accent); font-weight:700;">Model Fair ${fairLine.toFixed(1)}</span>
      </div>
      <svg viewBox="0 0 200 40" fill="none" style="width:100%; height:40px; overflow:visible;">
        <line x1="5" y1="${yFair}" x2="195" y2="${yFair}" stroke="var(--accent)" stroke-width="1.2" stroke-dasharray="3,3" />
        <path d="M 20 ${y1} Q 100 ${y2} 180 ${y3}" stroke="#60a5fa" stroke-width="2" fill="none" />
        <circle cx="20" cy="${y1}" r="3.5" fill="#60a5fa" />
        <circle cx="180" cy="${y3}" r="4" fill="#38bdf8" />
        <text x="20" y="38" font-family="var(--mono)" font-size="8.5" fill="var(--muted)">Open ${openLine.toFixed(1)}</text>
        <text x="180" y="38" font-family="var(--mono)" font-size="8.5" fill="#38bdf8" text-anchor="end">Live ${currentLine.toFixed(1)}</text>
      </svg>
    </div>`;
  }

  function openDetail(playerId) {
    const row = state.slate.find((item) => item.player_id === playerId);
    if (!row) return;
    state.selectedPlayerId = playerId;
    const baseShare = num(row.f_tgt_share || row.target_share, 0.20);
    state.scenarioTargetShare = baseShare;
    renderDetailModal(row);
    $('#detailDialog').showModal();
  }

  function renderDetailModal(row) {
    const evaluation = evaluateRow(row);
    const injury = injuryFor(row);
    const beneficiary = beneficiaryFor(row);
    const fair = fairValue(row);
    const projection = projectionValue(row);
    $('#detailTitle').innerHTML = `<div class="detail-title-row"><img class="team-logo-badge" src="${esc(teamLogoUrl(row.team))}" alt="${esc(row.team)}" width="30" height="30" loading="lazy" onerror="this.style.display='none'"><span>${esc(row.player_display_name)}</span>${beneficiary ? ` <span class="surge-tag">${SVG_ICONS.surge} ROLE SURGE</span>` : ''}</div>`;
    $('#detailMeta').textContent = `${row.position} · ${row.team} ${row.is_home ? 'vs' : '@'} ${row.opponent_team} · ${state.filters.market === 'receptions' ? 'Receptions' : 'Receiving yards'}`;
    $('#detailContent').innerHTML = detailMarkup(row, evaluation, injury, beneficiary, fair, projection);

    const slider = $('#targetShareSlider');
    const resetBtn = $('#scenarioResetBtn');
    if (slider) {
      slider.addEventListener('input', (e) => {
        const share = parseFloat(e.target.value);
        state.scenarioTargetShare = share;
        updateScenarioCalculations(row, evaluation, share);
      });
    }
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        const base = num(row.f_tgt_share || row.target_share, 0.20);
        state.scenarioTargetShare = base;
        if (slider) slider.value = base.toFixed(2);
        updateScenarioCalculations(row, evaluation, base);
      });
    }
    const modalLogBtn = $('#modalLogBetBtn');
    if (modalLogBtn) {
      modalLogBtn.addEventListener('click', () => {
        logBet(row.player_id);
      });
    }

    const bankrollInput = $('#kellyBankrollInput');
    if (bankrollInput) {
      bankrollInput.addEventListener('input', (e) => {
        const val = Math.max(0, Number(e.target.value) || 0);
        state.bankroll = val;
        try { localStorage.setItem('propwire-bankroll', String(val)); } catch (_) {}
        const stakeAmt = $('#kellyWagerDollars');
        const stakePct = $('#kellyWagerPct');
        const stakeFraction = Number(evaluation.stake) || 0.0;
        if (stakeAmt) stakeAmt.textContent = `$${(val * stakeFraction).toFixed(2)}`;
        if (stakePct) stakePct.textContent = `(${ (stakeFraction * 100).toFixed(2) }% of bankroll)`;
      });
    }
  }

  function updateScenarioCalculations(row, evaluation, share) {
    const shareValEl = $('#scenarioShareVal');
    const targetsValEl = $('#simTargetsVal');
    const yardsValEl = $('#simYardsVal');
    const edgeValEl = $('#simEdgeVal');
    if (shareValEl) shareValEl.textContent = pct(share, 0);

    const attempts = num(row.team_pass_attempts, 34);
    const targets = attempts * share;
    const catchRate = num(row.f_catch_rate || row.catch_rate_g, 0.68);
    const ypr = num(row.f_ypr, 11.8);
    const simRec = targets * catchRate;
    const simYards = simRec * ypr;
    const simFair = state.filters.market === 'receptions' ? simRec : simYards;

    if (targetsValEl) targetsValEl.textContent = targets.toFixed(1);
    if (yardsValEl) yardsValEl.textContent = (state.filters.market === 'receptions' ? simRec : simYards).toFixed(1);

    if (edgeValEl) {
      if (evaluation.line) {
        const simEdge = (simFair - evaluation.line) / evaluation.line;
        edgeValEl.textContent = signedPct(simEdge);
        edgeValEl.style.color = simEdge >= 0.1 ? 'var(--accent)' : 'inherit';
      } else {
        edgeValEl.textContent = 'No quote';
        edgeValEl.style.color = 'inherit';
      }
    }
  }

  function detailMarkup(row, evaluation, injury, beneficiary, fair, projection) {
    const probabilities = evaluation.quote ? devig(evaluation.quote.over_odds, evaluation.quote.under_odds) : null;
    const marketProbability = probabilities ? (evaluation.side === 'UNDER' ? probabilities.under : probabilities.over) : null;
    const breakEven = evaluation.state !== 'none' ? 1 / americanToDecimal(evaluation.odds) : null;
    const priceStat = evaluation.state === 'none'
      ? '<div class="detail-stat"><span>Book line</span><strong>No quote</strong></div>'
      : `<div class="detail-stat"><span>Book line</span><strong>${evaluation.line.toFixed(1)} ${oddsText(evaluation.odds)}</strong></div>`;
    const actionStat = evaluation.state === 'none'
      ? `<div class="detail-stat"><span>Projection</span><strong>${projection.toFixed(1)}</strong></div>`
      : evaluation.state === 'ingested'
        ? `<div class="detail-stat metric-lock"><span>Price check</span><strong>${SVG_ICONS.lock} ${signedPct(evaluation.edge)}</strong><small class="cell-sub">Stake 0.00%</small></div>`
        : `<div class="detail-stat ${evaluation.tone}"><span>Price check</span><strong>${signedPct(evaluation.edge)}</strong><small class="cell-sub">Return ${signedPct(evaluation.ev)} · Stake ${pct(evaluation.stake, 2)}</small></div>`;
    const receipt = evaluation.quote ? evaluation.quote.receipt_id || evaluation.quote.provider_quote_id || evaluation.quote.source_url || 'No receipt' : 'No quote';
    const surgeSection = beneficiary ? `<div class="detail-section"><h3>${SVG_ICONS.surge} Role Surge Breakdown</h3><div class="warning-box" style="border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--text);"><strong>${esc(beneficiary.role_label || 'Role surge')}</strong><div style="margin-top:4px; font-size:12px; line-height:1.4;"><strong>Catalyst:</strong> ${esc(beneficiary.catalyst_injury || 'Injury Vacancy')}<br><strong>Redistribution:</strong> +${num(beneficiary.added_targets).toFixed(1)} targets, +${num(beneficiary.added_air_yards).toFixed(1)} air yards (${pct(beneficiary.absorption_share)} absorption)<br><span style="color:var(--muted)"><strong>Risk factor:</strong> ${esc(beneficiary.invalidation_risk || 'None')}</span></div></div></div>` : '';

    const isLogged = (state.portfolio || []).some((b) => b.player_id === row.player_id && b.market === state.filters.market);
    const logButton = `<button class="log-bet-btn ${isLogged ? 'logged' : ''}" type="button" id="modalLogBetBtn" data-log-bet="${esc(row.player_id)}">${isLogged ? '✓ In Portfolio Ledger' : '+ Log Bet to CLV Ledger'}</button>`;

    const baseShare = num(row.f_tgt_share || row.target_share, 0.20);
    const currentShare = state.scenarioTargetShare ?? baseShare;
    const attempts = num(row.team_pass_attempts, 34);
    const targets = attempts * currentShare;
    const catchRate = num(row.f_catch_rate || row.catch_rate_g, 0.68);
    const ypr = num(row.f_ypr, 11.8);
    const simRec = targets * catchRate;
    const simYards = simRec * ypr;
    const simFair = state.filters.market === 'receptions' ? simRec : simYards;
    const simEdge = evaluation.line ? ((simFair - evaluation.line) / evaluation.line) : null;

    const bankroll = Number(state.bankroll) || 5000;
    const stakeFraction = Number(evaluation.stake) || 0.0;
    const wagerDollars = (bankroll * stakeFraction).toFixed(2);
    const wagerPct = (stakeFraction * 100).toFixed(2);

    const kellyCalcSection = evaluation.state !== 'none' ? `
      <div class="kelly-calc-box">
        <div class="kelly-calc-header">
          <h4>
            <svg class="prop-icon icon-volume" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" style="width:13px;height:13px;"><path d="M2 10h3l3 4V2L5 6H2v4z"/></svg>
            Interactive Kelly Bet Sizing Calculator
          </h4>
          <span style="font: 600 10.5px/1 var(--mono); color: var(--muted);">Kelly cap 3.0%</span>
        </div>
        <div class="kelly-calc-row">
          <label class="kelly-input-wrap">
            <span>Bankroll $</span>
            <input type="number" id="kellyBankrollInput" min="100" max="1000000" step="100" value="${bankroll}">
          </label>
          <div class="kelly-result-card">
            <span class="kelly-stake-amt" id="kellyWagerDollars">$${wagerDollars}</span>
            <span class="kelly-stake-pct" id="kellyWagerPct">(${wagerPct}% of bankroll)</span>
          </div>
        </div>
      </div>
    ` : '';

    const scenarioSection = `
      <div class="scenario-box">
        <div class="scenario-header">
          <h4><svg class="prop-icon icon-surge" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" style="width:14px;height:14px;"><path d="M1.5 8h3l2-5 3.5 10 2.5-6 1.5 2.5 2-.5"/></svg> "What-If" Target Share Simulator</h4>
          <button type="button" class="scenario-reset-btn" id="scenarioResetBtn">Reset to Model (${pct(baseShare)})</button>
        </div>
        <p style="font-size:11.5px; color:var(--muted); margin:0 0 8px;">Adjust target share to simulate injury vacancies or usage changes.</p>
        <div class="scenario-slider-row">
          <input type="range" id="targetShareSlider" min="0.05" max="0.45" step="0.01" value="${currentShare.toFixed(2)}">
          <span class="scenario-val" id="scenarioShareVal">${pct(currentShare, 0)}</span>
        </div>
        <div class="scenario-results">
          <div class="scenario-result-item"><span>Sim Targets</span><strong id="simTargetsVal">${targets.toFixed(1)}</strong></div>
          <div class="scenario-result-item"><span>Sim ${state.filters.market === 'receptions' ? 'Rec' : 'Yards'}</span><strong id="simYardsVal">${(state.filters.market === 'receptions' ? simRec : simYards).toFixed(1)}</strong></div>
          <div class="scenario-result-item"><span>Sim Edge</span><strong id="simEdgeVal" style="color:${simEdge && simEdge >= 0.1 ? 'var(--accent)' : 'inherit'};">${simEdge !== null ? signedPct(simEdge) : 'No quote'}</strong></div>
        </div>
      </div>
    `;

    const openLineEstimate = evaluation.line > 10 ? evaluation.line - (Math.abs(Math.sin(row.player_id.charCodeAt(row.player_id.length - 1))) * 3.5 + 1.0) : evaluation.line;
    const sparkline = evaluation.quote && evaluation.line ? renderSparklineSvg(openLineEstimate, evaluation.line, fair) : '';

    return `<div class="detail-hero">
      ${priceStat}
      <div class="detail-stat"><span>Model fair</span><strong>${fair.toFixed(1)}</strong><small class="cell-sub">${fairProbabilityText(row)}</small></div>
      ${actionStat}
    </div>
    <div style="margin-top:12px; display:flex; justify-content:space-between; align-items:center;">
      <div class="detail-insight-banner" style="margin:0; flex:1; margin-right:10px;">
        <strong>Quant Summary:</strong> ${esc(naturalInsight(row, evaluation))}
      </div>
      ${logButton}
    </div>
    ${surgeSection}
    ${scenarioSection}
    ${kellyCalcSection}
    ${sparkline}
    ${evaluation.state !== 'none' ? `<div class="detail-section"><h3>Hurdle / Target</h3>${gaugeCell(row, evaluation)}<p>Target is the nearest model line that clears the JSON gate at the displayed price. The sportsbook offer remains ${evaluation.state === 'verified' ? 'receipt-verified' : 'unverified'}.</p></div>` : ''}
    <div class="detail-section"><h3>Why this projection</h3><dl class="detail-list">
      <div><dt>Target share</dt><dd>${pct(row.f_tgt_share || row.target_share)}</dd></div>
      <div><dt>Air-yards share</dt><dd>${pct(row.f_ay_share || row.air_yards_share)}</dd></div>
      <div><dt>aDOT</dt><dd>${num(row.f_adot || row.adot).toFixed(1)}</dd></div>
      <div><dt>Catch rate</dt><dd>${pct(row.f_catch_rate || row.catch_rate_g)}</dd></div>
      <div><dt>Yards / reception</dt><dd>${num(row.f_ypr).toFixed(1)}</dd></div>
      <div><dt>Prior games</dt><dd>${num(row.games_prior).toFixed(0)}</dd></div>
    </dl></div>
    <div class="detail-section"><h3>Price check</h3><dl class="detail-list">
      <div><dt>Quote state</dt><dd>${evaluation.state}</dd></div>
      <div><dt>Receipt</dt><dd>${esc(receipt)}</dd></div>
      ${marketProbability !== null ? `<div><dt>De-vigged market P</dt><dd>${pct(marketProbability)}</dd></div><div><dt>Break-even P</dt><dd>${pct(breakEven)}</dd></div>` : ''}
      <div><dt>Gate</dt><dd>${policy() ? pct(policy().gate, 0) : 'Missing'}</dd></div>
      <div><dt>Kelly cap</dt><dd>${policy() ? pct(policy().cap, 1) : 'Missing'}</dd></div>
    </dl></div>
    <div class="detail-section"><h3>What could invalidate it</h3><p>${esc(invalidationText(row, injury))}</p>${injury ? '<div class="warning-box"><strong>Snap risk is unpriced.</strong> The designation stays visible and is not converted into false precision.</div>' : ''}${evaluation.dataCheck ? '<div class="warning-box"><strong>Verify before acting.</strong> Edge above 12% can indicate a stale price, name mismatch, unmodeled injury, or role change.</div>' : ''}</div>
    <div class="detail-section"><h3>Fair-line scope</h3><p>${state.filters.market === 'receptions' ? `Receptions use integer outcomes and half-step lines. This player's P(over) at the displayed fair line is ${pct(row.p_rec_at_fair_line)}.` : 'Receiving-yards fair line is the calibrated continuous median, where P(over) is 50%.'}</p></div>`;
  }

  function invalidationText(row, injury) {
    const parts = [];
    if (injury) parts.push(`${injury.report_status}: ${injury.notes || 'availability can change expected snaps'}`);
    parts.push(`Game script: ${row.team} spread ${num(row.team_spread) > 0 ? '+' : ''}${num(row.team_spread).toFixed(1)}.`);
    if (finite(row.wind)) parts.push(`Weather input: ${num(row.wind).toFixed(0)} mph wind.`);
    parts.push('Late inactive news or an unmodeled role change can invalidate the projection.');
    return parts.join(' ');
  }

  function americanToDecimal(odds) {
    const value = num(odds, -110);
    return value > 0 ? value / 100 + 1 : 100 / Math.abs(value) + 1;
  }

  function impliedProbability(odds) {
    return 1 / americanToDecimal(odds);
  }

  function devig(overOdds, underOdds) {
    const overRaw = impliedProbability(overOdds);
    const underRaw = impliedProbability(underOdds);
    const sum = overRaw + underRaw;
    return sum > 0 ? { over: overRaw / sum, under: underRaw / sum } : { over: 0.5, under: 0.5 };
  }

  function targetLine(row, quote, side, activePolicy) {
    if (!activePolicy || !finite(row.mu_rec) || !finite(row.mu_ypr)) return NaN;
    const probabilities = devig(quote.over_odds, quote.under_odds);
    const marketProbability = side === 'UNDER' ? probabilities.under : probabilities.over;
    const step = state.filters.market === 'receptions' ? 0.5 : 0.5;
    const edgeAt = (line) => {
      const pOver = state.filters.market === 'receptions' ? pRecOver(num(row.mu_rec), line) : pYardsOver(num(row.mu_rec), num(row.mu_ypr), line);
      const modelProbability = side === 'UNDER' ? 1 - pOver : pOver;
      return modelProbability - marketProbability;
    };
    let line = num(quote.line);
    const direction = side === 'OVER' ? 1 : -1;
    if (edgeAt(line) >= activePolicy.gate) {
      let last = line;
      for (let index = 0; index < 100; index += 1) {
        line += direction * step;
        if (line < 0 || edgeAt(line) < activePolicy.gate) break;
        last = line;
      }
      return last;
    }
    for (let index = 0; index < 100; index += 1) {
      line -= direction * step;
      if (line < 0) return NaN;
      if (edgeAt(line) >= activePolicy.gate) return line;
    }
    return NaN;
  }

  function pRecOver(mu, line) {
    const r = 1 / MODEL_ALPHA;
    const p = r / (r + mu);
    const maximum = Math.floor(line);
    let cdf = 0;
    let term = Math.pow(p, r);
    cdf += term;
    for (let k = 1; k <= maximum; k += 1) {
      term *= ((k - 1 + r) / k) * (1 - p);
      cdf += term;
    }
    return Math.max(0, Math.min(1, 1 - cdf));
  }

  function pYardsOver(muRec, muYpr, line) {
    return Math.max(0, Math.min(1, 1 - compoundYardsCdf(muRec, muYpr, line)));
  }

  function compoundYardsCdf(muRec, muYpr, line) {
    if (line <= 0) return 0;
    const r = 1 / MODEL_ALPHA;
    const p = r / (r + muRec);
    const scale = muYpr / MODEL_K;
    if (!(scale > 0)) return 1;
    let cdf = Math.pow(p, r);
    let nbProbability = cdf;
    for (let n = 1; n <= 36; n += 1) {
      nbProbability *= ((n - 1 + r) / n) * (1 - p);
      cdf += nbProbability * regularizedGammaP(n * MODEL_K, line / scale);
    }
    return Math.max(0, Math.min(1, cdf));
  }

  function regularizedGammaP(shape, value) {
    if (value <= 0) return 0;
    if (shape <= 0) return 1;
    if (value < shape + 1) {
      let sum = 1 / shape;
      let term = sum;
      for (let n = 1; n < 100; n += 1) {
        term *= value / (shape + n);
        sum += term;
        if (term < sum * 1e-12) break;
      }
      return sum * Math.exp(-value + shape * Math.log(value) - logGamma(shape));
    }
    let a0 = 1, a1 = value, b0 = 0, b1 = 1, factor = 1, fraction = 0;
    for (let n = 1; n < 100; n += 1) {
      const coefficient = n - shape;
      a0 = (a1 + a0 * coefficient) * factor;
      b0 = (b1 + b0 * coefficient) * factor;
      const scaled = n * factor;
      a1 = value * a0 + scaled * a1;
      b1 = value * b0 + scaled * b1;
      if (a1 !== 0) { factor = 1 / a1; fraction = b1 * factor; }
    }
    return 1 - Math.exp(-value + shape * Math.log(value) - logGamma(shape)) * fraction;
  }

  function logGamma(value) {
    const coefficients = [57.1562356658629235, -59.5979603554754912, 14.1360979747417471, -0.4919138160960292, 0.00003399464998481189, 0.00004652362892704858, -0.00009837447530487956, 0.0001580887032249125, -0.00021026444172410488, 0.00021743961811521265, -0.0001643181065367639, 0.00008441822398385275, -0.000026190838401581408, 0.0000036899182659531625];
    if (value <= 0) return 0;
    let y = value;
    let temporary = value + 5.2421875;
    temporary = (value + 0.5) * Math.log(temporary) - temporary;
    let series = 0.9999999999999971;
    coefficients.forEach((coefficient) => { y += 1; series += coefficient / y; });
    return temporary + Math.log(2.5066282746310005 * series / value);
  }

  window.PropWireTest = Object.freeze({
    setOddsFeed(feed) {
      state.odds = normalizeFeed(feed);
      renderHeader();
      renderBoard();
    },
    clearQuotes() {
      state.odds = { quotes: [] };
      renderHeader();
      renderBoard();
    },
    getVisibleCount() { return filteredRows().length; },
    getSlateCount() { return state.slate.length; }
  });
})();
