(() => {
  'use strict';

  const schedule = document.getElementById('todaySchedule');
  const gamesEl = document.getElementById('todayScheduleGames');
  const leagueNavs = [document.getElementById('sportSwitcher'), document.getElementById('mobileSportSwitcher')].filter(Boolean);
  if (!schedule || !gamesEl || !leagueNavs.length) return;

  const leagueNames = { nba: 'NBA', nfl: 'NFL' };
  const leaguePaths = { nba: 'basketball/nba', nfl: 'football/nfl' };
  const teamAliases = { LAR: 'LA', WSH: 'WAS', NY: 'NYK', GS: 'GSW', SA: 'SAS', NO: 'NOP' };
  const activeSport = () => localStorage.getItem('propwire_active_sport') === 'nba' ? 'nba' : 'nfl';
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

  function easternDate(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const part = (type) => parts.find((item) => item.type === type).value;
    return `${part('year')}${part('month')}${part('day')}`;
  }

  const teamCode = (value) => teamAliases[value] || value;
  const eventTeams = (event) => {
    const competitors = event.competitions?.[0]?.competitors || [];
    return {
      away: teamCode(competitors.find((team) => team.homeAway === 'away')?.team?.abbreviation),
      home: teamCode(competitors.find((team) => team.homeAway === 'home')?.team?.abbreviation)
    };
  };

  function gameCard(event, index) {
    const competition = event.competitions?.[0] || {};
    const teams = competition.competitors || [];
    const away = teams.find((team) => team.homeAway === 'away') || {};
    const home = teams.find((team) => team.homeAway === 'home') || {};
    const status = competition.status || event.status || {};
    const state = status.type?.state || 'pre';
    const statusText = state === 'pre' ? 'Scheduled' : (status.type?.shortDetail || status.type?.detail || '');
    const date = new Date(event.date || competition.date);
    const time = Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
    }).format(date);
    const team = (entry) => {
      const name = escapeHtml(entry.team?.shortDisplayName || entry.team?.displayName || 'TBD');
      const initials = escapeHtml(entry.team?.abbreviation || '—');
      const logo = entry.team?.logo || entry.team?.logos?.[0]?.href;
      const safeLogo = /^https:\/\/a\.espncdn\.com\//.test(logo || '') ? logo : '';
      return `<div class="today-team"><span class="today-team-logo">${safeLogo ? `<img src="${escapeHtml(safeLogo)}" alt="" loading="lazy">` : `<span>${initials}</span>`}</span><strong>${name}</strong></div>`;
    };
    const score = state === 'pre' ? '<span class="today-versus">VS</span>' :
      `<span class="today-score">${escapeHtml(away.score ?? '0')} <span>–</span> ${escapeHtml(home.score ?? '0')}</span>`;
    return `<article class="today-game-card">
      <button class="today-game-trigger" type="button" data-game-index="${index}" aria-expanded="false" aria-controls="todayGameProps${index}" aria-label="${escapeHtml(away.team?.displayName || 'Away team')} at ${escapeHtml(home.team?.displayName || 'home team')}: show player prop projections">
        <div class="today-game-top"><span>${escapeHtml(time)}</span><span class="today-game-status ${state === 'in' ? 'is-live' : ''}">${escapeHtml(statusText || (state === 'post' ? 'Final' : 'Scheduled'))}</span></div>
        <div class="today-game-matchup">${team(away)}<div class="today-game-center">${score}</div>${team(home)}</div>
        <div class="today-game-action"><span>PLAYER PROP PROJECTIONS</span><span class="today-game-chevron" aria-hidden="true">⌄</span></div>
      </button>
      <div class="today-game-props" id="todayGameProps${index}" hidden></div>
    </article>`;
  }

  let requestNumber = 0;
  let currentEvents = [];
  const modelCache = new Map();
  const fetchJson = async (path) => {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) {
      const error = new Error(`Model data unavailable: ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  };

  async function modelSources(sport, dateKey) {
    const key = `${sport}:${dateKey}`;
    if (!modelCache.has(key)) {
      modelCache.set(key, (async () => {
        if (sport === 'nba') {
          const date = `${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6)}`;
          try {
            const [games, slate] = await Promise.all([
              fetchJson(`/nba_games_${date}.json`), fetchJson(`/nba_slate_${date}.json`)
            ]);
            return [{ games, slate }];
          } catch (error) {
            if (error.status === 404) return [];
            throw error;
          }
        }
        const index = await fetchJson('/feeds/slate-index.json');
        const slates = Object.values(index.sports?.nfl?.slates || {}).filter((item) => !item.historical && item.games && item.slate);
        return Promise.all(slates.map(async (item) => {
          const [games, slate] = await Promise.all([fetchJson(`/${item.games}`), fetchJson(`/${item.slate}`)]);
          return { games, slate };
        }));
      })().catch((error) => { modelCache.delete(key); throw error; }));
    }
    return modelCache.get(key);
  }

  function projectionRow(row, sport) {
    const number = (value) => Number.isFinite(Number(value)) ? Number(value).toFixed(1) : '—';
    const stats = sport === 'nba'
      ? [['PTS', row.proj_pts], ['REB', row.proj_reb], ['AST', row.proj_ast], ['3PM', row.proj_fg3m]]
      : [['REC YDS', row.proj_yards], ['REC', row.proj_rec]];
    return `<div class="today-prop-row"><div class="today-prop-player"><strong>${escapeHtml(row.player_display_name)}</strong><span>${escapeHtml(row.team)} · ${escapeHtml(row.position || row.position_hist || '')}</span></div><div class="today-prop-stats">${stats.map(([label, value]) => `<span><b>${number(value)}</b><small>${label}</small></span>`).join('')}</div></div>`;
  }

  async function showGameProps(button) {
    const panel = document.getElementById(button.getAttribute('aria-controls'));
    if (button.getAttribute('aria-expanded') === 'true') {
      button.setAttribute('aria-expanded', 'false');
      panel.hidden = true;
      return;
    }
    button.setAttribute('aria-expanded', 'true');
    panel.hidden = false;
    if (panel.dataset.loaded) return;
    panel.innerHTML = '<p class="today-prop-message">Loading player projections…</p>';
    const event = currentEvents[Number(button.dataset.gameIndex)];
    const sport = activeSport();
    const dateKey = easternDate(new Date(event.date));
    try {
      const sources = await modelSources(sport, dateKey);
      if (!button.isConnected) return;
      const { away, home } = eventTeams(event);
      const match = sources.flatMap((source) => (Array.isArray(source.games) ? source.games : []).map((game) => ({ game, slate: source.slate })))
        .find(({ game }) => game.gameday?.replaceAll('-', '') === dateKey && teamCode(game.away_team) === away && teamCode(game.home_team) === home && !game._fixture);
      const rows = match && Array.isArray(match.slate)
        ? match.slate.filter((row) => row.game_id === match.game.game_id && !row._fixture && (row.status === 'ACT' || row.status === 'ACTIVE') && !row.excl_reason)
        : [];
      rows.sort((a, b) => Number(b.proj_yards ?? b.proj_pts ?? 0) - Number(a.proj_yards ?? a.proj_pts ?? 0));
      panel.innerHTML = rows.length
        ? `<div class="today-prop-heading"><strong>${rows.length} player projections</strong><span>PropStein model · research only</span></div><div class="today-prop-list">${rows.map((row) => projectionRow(row, sport)).join('')}</div>`
        : '<p class="today-prop-message">No PropStein player projections are available for this matchup yet.</p>';
      panel.dataset.loaded = 'true';
    } catch (error) {
      if (!button.isConnected) return;
      panel.innerHTML = '<p class="today-prop-message">Player projections are unavailable right now. Close and reopen the game to retry.</p>';
      console.warn('[PropStein] Game projections unavailable:', error);
    }
  }
  async function loadTodayGames() {
    modelCache.clear();
    const sport = activeSport();
    const dateKey = easternDate();
    const dateLabel = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    }).format(new Date());
    document.getElementById('todayScheduleTitle').textContent = `${leagueNames[sport]} games today`;
    document.getElementById('todayScheduleDate').textContent = dateLabel;
    gamesEl.innerHTML = '<p class="today-schedule-message">Loading today’s games…</p>';
    document.getElementById('todayScheduleSource').textContent = '';
    const currentRequest = ++requestNumber;
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/${leaguePaths[sport]}/scoreboard?dates=${dateKey}&limit=1000`;
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Schedule request failed: ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.events)) throw new Error('Invalid schedule response');
      if (currentRequest !== requestNumber) return;
      const games = data.events.filter((event) => {
        const date = new Date(event.date);
        return !Number.isNaN(date.getTime()) && easternDate(date) === dateKey;
      }).sort((a, b) => new Date(a.date) - new Date(b.date));
      currentEvents = games;
      gamesEl.innerHTML = games.length ? games.map(gameCard).join('') : `<p class="today-schedule-message">No ${leagueNames[sport]} games are scheduled for today.</p>`;
      document.getElementById('todayScheduleSource').textContent = `Schedule and scores: ESPN · Times shown in Eastern Time · ${games.length} game${games.length === 1 ? '' : 's'}`;
    } catch (error) {
      if (currentRequest !== requestNumber) return;
      gamesEl.innerHTML = '<p class="today-schedule-message">Today’s schedule is unavailable. Tap Refresh to try again.</p>';
      document.getElementById('todayScheduleSource').textContent = '';
      console.warn('[PropWire] Today schedule unavailable:', error);
    }
  }

  function showComingSoon(sport) {
    const label = sport.toUpperCase();
    document.getElementById('comingSoonLogo').src = `/league-logos/${sport === 'ufc' ? 'ufc.svg' : 'nhl.png'}`;
    document.getElementById('comingSoonTitle').textContent = `${label} coming soon`;
    document.getElementById('comingSoonMessage').textContent = `${label} schedules and research are on the way. Select NBA or NFL to see today’s games.`;
    document.getElementById('comingSoonPage').hidden = false;
    document.body.classList.add('coming-soon-active');
    document.querySelectorAll('#sportSwitcher [data-sport], #mobileSportSwitcher [data-sport]').forEach((button) => {
      const selected = button.dataset.sport === sport;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-checked', String(selected));
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function showSchedule() {
    document.getElementById('comingSoonPage').hidden = true;
    document.body.classList.remove('coming-soon-active');
    document.querySelectorAll('#sportSwitcher [data-sport], #mobileSportSwitcher [data-sport]').forEach((button) => {
      const selected = button.dataset.sport === activeSport();
      button.classList.toggle('active', selected);
      button.setAttribute('aria-checked', String(selected));
    });
    loadTodayGames();
  }

  leagueNavs.forEach((leagueNav) => leagueNav.addEventListener('click', (event) => {
    const button = event.target.closest('[data-sport]');
    if (!button) return;
    if (button.dataset.sport === 'ufc' || button.dataset.sport === 'nhl') showComingSoon(button.dataset.sport);
    else if (button.dataset.sport === activeSport()) showSchedule();
  }));
  document.getElementById('comingSoonBack').addEventListener('click', showSchedule);
  document.getElementById('todayScheduleRefresh').addEventListener('click', loadTodayGames);
  gamesEl.addEventListener('click', (event) => {
    const button = event.target.closest('.today-game-trigger');
    if (button) showGameProps(button);
  });
  gamesEl.addEventListener('error', (event) => {
    if (event.target.matches('.today-team-logo img')) event.target.replaceWith(document.createTextNode('—'));
  }, true);
  loadTodayGames();
})();
