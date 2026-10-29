(() => {
  'use strict';

  const schedule = document.getElementById('todaySchedule');
  const gamesEl = document.getElementById('todayScheduleGames');
  const leagueNavs = [document.getElementById('sportSwitcher'), document.getElementById('mobileSportSwitcher')].filter(Boolean);
  if (!schedule || !gamesEl || !leagueNavs.length) return;

  const leagueNames = { nba: 'NBA', nfl: 'NFL' };
  const leaguePaths = { nba: 'basketball/nba', nfl: 'football/nfl' };
  const activeSport = () => localStorage.getItem('propwire_active_sport') === 'nba' ? 'nba' : 'nfl';
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

  function easternDate(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const part = (type) => parts.find((item) => item.type === type).value;
    return `${part('year')}${part('month')}${part('day')}`;
  }

  function gameCard(event) {
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
      <div class="today-game-top"><span>${escapeHtml(time)}</span><span class="today-game-status ${state === 'in' ? 'is-live' : ''}">${escapeHtml(statusText || (state === 'post' ? 'Final' : 'Scheduled'))}</span></div>
      <div class="today-game-matchup">${team(away)}<div class="today-game-center">${score}</div>${team(home)}</div>
    </article>`;
  }

  let requestNumber = 0;
  async function loadTodayGames() {
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
  gamesEl.addEventListener('error', (event) => {
    if (event.target.matches('.today-team-logo img')) event.target.replaceWith(document.createTextNode('—'));
  }, true);
  loadTodayGames();
})();
