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

  const state = {
    slateKey: '2026_w7',
    slate: [],
    games: [],
    picks: {},
    injuries: { injuries: [], impacted_beneficiaries: {} },
    odds: { quotes: [] },
    filters: { search: '', market: 'receiving_yards', position: 'ALL', team: '', gameId: '' },
    view: matchMedia('(max-width: 680px)').matches ? 'cards' : 'table',
    deferredInstall: null,
    selectedPlayerId: null
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const finite = (value) => Number.isFinite(Number(value));
  const num = (value, fallback = 0) => finite(value) ? Number(value) : fallback;
  const pct = (value, digits = 1) => `${(num(value) * 100).toFixed(digits)}%`;
  const signedPct = (value, digits = 1) => `${num(value) > 0 ? '+' : ''}${pct(value, digits)}`;
  const oddsText = (value) => `${num(value) > 0 ? '+' : ''}${num(value)}`;
  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
  const bookShort = (book) => ({ DraftKings: 'DK', FanDuel: 'FD', BetMGM: 'MGM', Caesars: 'CZR', Pinnacle: 'PIN' })[book] || book || 'Book';

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
    $$('.view-switch button').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
    $('#slateRows').addEventListener('click', inspectFromEvent);
    $('#cardView').addEventListener('click', inspectFromEvent);
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && $('#detailDialog').open) $('#detailDialog').close();
    });
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
    state.filters = { search: '', market: state.filters.market, position: 'ALL', team: '', gameId: '' };
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
    state.filters = { search: '', market: state.filters.market, position: 'ALL', team: '', gameId: '' };
    $('#searchInput').value = '';
    $('#positionFilter').value = 'ALL';
    $('#teamFilter').value = '';
    renderGameChips();
    renderBoard();
  }

  function filteredRows() {
    const { search, position, team, gameId } = state.filters;
    return state.slate.filter((row) => {
      if (position !== 'ALL' && row.position !== position) return false;
      if (team && row.team !== team) return false;
      if (gameId && row.game_id !== gameId) return false;
      if (search) {
        const haystack = `${row.player_display_name} ${row.team} ${row.opponent_team}`.toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    }).sort((a, b) => num(b.proj_yards) - num(a.proj_yards));
  }

  function renderBoard() {
    const rows = filteredRows();
    const hasPrices = rows.some((row) => Boolean(findQuote(row, state.filters.market)));
    $('#resultCount').textContent = `${rows.length} of ${state.slate.length} player records`;
    $('#slateHead').innerHTML = tableHead(hasPrices);
    $('#slateRows').innerHTML = rows.map((row) => tableRow(row, hasPrices)).join('');
    $('#cardView').innerHTML = rows.map(propCard).join('');
    $('#emptyState').hidden = rows.length !== 0;
    $('#tableView').hidden = state.view !== 'table' || rows.length === 0;
    $('#cardView').hidden = state.view !== 'cards' || rows.length === 0;
  }

  function tableHead(hasPrices) {
    return `<tr>
      <th style="width:22%">Player</th>
      <th style="width:10%">Matchup</th>
      <th style="width:14%">Book line</th>
      <th style="width:15%">Model fair</th>
      ${hasPrices ? '<th style="width:15%">Price check</th><th style="width:14%">Hurdle / Target</th>' : ''}
      <th style="width:12%">State</th>
      <th style="width:8%"><span class="sr-only">Inspect</span></th>
    </tr>`;
  }

  function tableRow(row, hasPrices) {
    const evaluation = evaluateRow(row);
    const injury = injuryFor(row);
    const fair = fairValue(row);
    const projection = projectionValue(row);
    const fairProbability = fairProbabilityText(row);
    return `<tr data-testid="slate-row" data-player-id="${esc(row.player_id)}">
      <td><div class="player-cell"><span class="position-box">${esc(row.position)}</span><div><div class="player-name">${esc(row.player_display_name)}${injury ? `<span class="injury-tag">${esc(injury.report_status)}</span>` : ''}</div><span class="cell-sub">${esc(roleLabel(row))}</span></div></div></td>
      <td><span class="number-main">${esc(row.team)}</span><span class="cell-sub">${row.is_home ? 'vs' : '@'} ${esc(row.opponent_team)}</span></td>
      <td>${bookCell(evaluation)}</td>
      <td><span class="number-main">${fair.toFixed(1)}</span><span class="cell-sub">Proj ${projection.toFixed(1)} · ${fairProbability}</span></td>
      ${hasPrices ? `<td>${priceCheckCell(evaluation)}</td><td>${gaugeCell(row, evaluation)}</td>` : ''}
      <td>${stateCell(row, evaluation, injury)}</td>
      <td><button class="inspect-button" type="button" data-inspect="${esc(row.player_id)}" aria-label="Inspect ${esc(row.player_display_name)}">Inspect</button></td>
    </tr>`;
  }

  function propCard(row) {
    const evaluation = evaluateRow(row);
    const injury = injuryFor(row);
    const fair = fairValue(row);
    const projection = projectionValue(row);
    const thirdLabel = evaluation.state === 'none' ? 'Projection' : 'Price check';
    const thirdValue = evaluation.state === 'none' ? projection.toFixed(1) : evaluation.state === 'ingested' ? `🔒 ${signedPct(evaluation.edge)}` : signedPct(evaluation.edge);
    const thirdClass = evaluation.state === 'verified' ? evaluation.tone : evaluation.state === 'ingested' ? 'price-lock' : '';
    return `<article class="prop-card" data-testid="slate-card" data-player-id="${esc(row.player_id)}">
      <div class="card-top"><div><h2>${esc(row.player_display_name)}${injury ? `<span class="injury-tag">${esc(injury.report_status)}</span>` : ''}</h2><p>${esc(row.position)} · ${esc(row.team)} ${row.is_home ? 'vs' : '@'} ${esc(row.opponent_team)}</p></div>${statePill(row, evaluation)}</div>
      <div class="card-numbers">
        <div class="card-number"><span>Book line</span><strong>${evaluation.state === 'none' ? 'No quote' : `${evaluation.line.toFixed(1)} ${oddsText(evaluation.odds)}`}</strong></div>
        <div class="card-number"><span>Model fair</span><strong>${fair.toFixed(1)}</strong><small class="cell-sub">${fairProbabilityText(row)}</small></div>
        <div class="card-number ${thirdClass}"><span>${thirdLabel}</span><strong>${thirdValue}</strong>${evaluation.state === 'ingested' ? '<small class="cell-sub">Stake 0.00%</small>' : evaluation.state === 'verified' ? `<small class="cell-sub">Return ${signedPct(evaluation.ev)}</small>` : ''}</div>
      </div>
      <div class="card-bottom"><span class="meta-pill ${evaluation.tone}">${esc(metaText(row, evaluation))}</span><button class="inspect-button" type="button" data-inspect="${esc(row.player_id)}">Inspect</button></div>
    </article>`;
  }

  function fairValue(row) {
    return num(state.filters.market === 'receptions' ? row.fair_line_rec : row.fair_line_yards);
  }

  function projectionValue(row) {
    return num(state.filters.market === 'receptions' ? row.proj_rec : row.proj_yards);
  }

  function fairProbabilityText(row) {
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

  function bookCell(evaluation) {
    if (evaluation.state === 'none') return '<span class="number-main">No quote</span><span class="cell-sub">Model only</span>';
    return `<span class="number-main">${evaluation.side} ${evaluation.line.toFixed(1)}</span><span class="cell-sub">${esc(evaluation.book)} · ${oddsText(evaluation.odds)}</span>`;
  }

  function priceCheckCell(evaluation) {
    if (evaluation.state === 'none') return '<span class="cell-sub">No price comparison</span>';
    if (evaluation.state === 'ingested') {
      return `<div class="metric-stack metric-lock" data-quote-state="ingested"><span class="number-main">🔒 ${signedPct(evaluation.edge)} edge</span><span class="cell-sub">${signedPct(evaluation.ev)} return · price unverified</span><span class="cell-sub">Stake 0.00%</span></div>`;
    }
    if (evaluation.closed) return '<div class="metric-stack closed"><span class="number-main">Closed</span><span class="cell-sub">Not actionable</span></div>';
    if (evaluation.dataCheck) {
      return `<div class="metric-stack caution" data-quote-state="verified"><span class="number-main">${signedPct(evaluation.edge)} edge</span><span class="cell-sub">${signedPct(evaluation.ev)} return</span><span class="cell-sub hover-help" title="Likely causes: stale price, name mismatch, unmodeled injury, or role change.">Verify before acting</span></div>`;
    }
    return `<div class="metric-stack ${evaluation.tone}" data-quote-state="verified"><span class="number-main">${signedPct(evaluation.edge)} edge</span><span class="cell-sub">${signedPct(evaluation.ev)} return · Stake ${pct(evaluation.stake, 2)}</span></div>`;
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
    return `${statePill(row, evaluation)}${injury ? `<span class="cell-sub caution">Snap risk unpriced</span>` : ''}`;
  }

  function statePill(row, evaluation) {
    let text = metaText(row, evaluation);
    let className = evaluation.tone;
    if (row.excl_reason) { text = `Excluded · ${row.excl_reason}`; className = 'closed'; }
    return `<span class="meta-pill ${className}">${esc(text)}</span>`;
  }

  function metaText(row, evaluation) {
    if (evaluation.state === 'none') return `${roleLabel(row)} · No quote`;
    if (evaluation.state === 'ingested') return `${bookShort(evaluation.book)} · ${roleLabel(row)} · Unverified`;
    if (evaluation.closed) return `${bookShort(evaluation.book)} · Closed`;
    if (evaluation.dataCheck) return `${bookShort(evaluation.book)} · Verify before acting`;
    return `${bookShort(evaluation.book)} · ${roleLabel(row)} · Verified`;
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
    const button = event.target.closest('[data-inspect]');
    if (!button) return;
    openDetail(button.dataset.inspect);
  }

  function openDetail(playerId) {
    const row = state.slate.find((item) => item.player_id === playerId);
    if (!row) return;
    state.selectedPlayerId = playerId;
    const evaluation = evaluateRow(row);
    const injury = injuryFor(row);
    const fair = fairValue(row);
    const projection = projectionValue(row);
    $('#detailTitle').textContent = row.player_display_name;
    $('#detailMeta').textContent = `${row.position} · ${row.team} ${row.is_home ? 'vs' : '@'} ${row.opponent_team} · ${state.filters.market === 'receptions' ? 'Receptions' : 'Receiving yards'}`;
    $('#detailContent').innerHTML = detailMarkup(row, evaluation, injury, fair, projection);
    $('#detailDialog').showModal();
  }

  function detailMarkup(row, evaluation, injury, fair, projection) {
    const probabilities = evaluation.quote ? devig(evaluation.quote.over_odds, evaluation.quote.under_odds) : null;
    const marketProbability = probabilities ? (evaluation.side === 'UNDER' ? probabilities.under : probabilities.over) : null;
    const breakEven = evaluation.state !== 'none' ? 1 / americanToDecimal(evaluation.odds) : null;
    const priceStat = evaluation.state === 'none'
      ? '<div class="detail-stat"><span>Book line</span><strong>No quote</strong></div>'
      : `<div class="detail-stat"><span>Book line</span><strong>${evaluation.line.toFixed(1)} ${oddsText(evaluation.odds)}</strong></div>`;
    const actionStat = evaluation.state === 'none'
      ? `<div class="detail-stat"><span>Projection</span><strong>${projection.toFixed(1)}</strong></div>`
      : evaluation.state === 'ingested'
        ? `<div class="detail-stat metric-lock"><span>Price check</span><strong>🔒 ${signedPct(evaluation.edge)}</strong><small class="cell-sub">Stake 0.00%</small></div>`
        : `<div class="detail-stat ${evaluation.tone}"><span>Price check</span><strong>${signedPct(evaluation.edge)}</strong><small class="cell-sub">Return ${signedPct(evaluation.ev)} · Stake ${pct(evaluation.stake, 2)}</small></div>`;
    const receipt = evaluation.quote ? evaluation.quote.receipt_id || evaluation.quote.provider_quote_id || evaluation.quote.source_url || 'No receipt' : 'No quote';
    return `<div class="detail-hero">
      ${priceStat}
      <div class="detail-stat"><span>Model fair</span><strong>${fair.toFixed(1)}</strong><small class="cell-sub">${fairProbabilityText(row)}</small></div>
      ${actionStat}
    </div>
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
