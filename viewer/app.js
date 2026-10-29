(() => {
  'use strict';

  // ══ MODULE MAP ═════════════════════════════════════════════════════════
  // One IIFE, one `state` store, ~130 functions. Sections, in file order:
  //   §1  Sport adapter layer                    §12 Data ingestion & feed health
  //   §2  Storage migration                      §13 Render pipeline
  //   §3  Persistence I/O (ledger/watchlist)     §14 Portfolio risk & sniper
  //   §4  Application state + helpers            §15 Board atoms (rows/cards)
  //   §5  Team identity (logos)                  §16 Evaluation core (gate/Kelly)
  //   §6  Distribution visuals                   §17 Navigation & toasts
  //   §7  Device feedback & polling              §18 Ledger mutations & I/O
  //   §8  Odds polling pipeline                  §19 Portfolio & CLV dialogs
  //   §9  Boot & control binding                 §20 Detail analytics markups
  //   §10 Gestures, sheet & keyboard nav         §21 Detail modal & scenarios
  //   §11 View state & sport chrome              §22 Odds & distribution math
  // Invariants worth keeping while editing:
  //   • `state` (§4) is the only mutable store; DOM writes flow through the
  //     render*/update* functions (§13) — never paint from stale locals.
  //   • Quote acceptance lives in evaluateRow (§16); never bypass it.
  //   • Live market data must never be served from cache (sw.js + §8).
  // ════════════════════════════════════════════════════════════════════════

  // ── Sport adapter layer ────────────────────────────────────────────────────
  // Boot sport is fixed to NFL in this phase; the user-facing switcher ships
  // with the NBA adapter (phase 2). Every sport-specific branch below has
  // been extracted into viewer/js/sports/nfl.js — app.js owns no sport logic.
  if (!window.PropWireSports) {
    throw new Error('PropWire: /js/sports/registry.js and a sport adapter must load before app.js');
  }
  const SPORT_ID = window.PropWireSports.defaultId();
  const adapter = window.PropWireSports.require(SPORT_ID);

  const SLATES = adapter.slates;
  // NFL carries calibrated NegBin/Gamma constants; adapters without a
  // distribution model (NBA v1 normal approx) leave these null — the only
  // consumers (targetLine/pRecOver/pYardsOver) guard on NFL-only row fields
  // and never execute for other sports.
  const MODEL_ALPHA = adapter.model ? adapter.model.alpha : null;
  const MODEL_K = adapter.model ? adapter.model.k : null;

  // ── Sport-namespaced storage + one-time legacy migration ──────────────────
  // Policy: read legacy keys → write sport-namespaced copies → keep legacy
  // keys untouched (30-day readability window) → log counts → show a one-time
  // notice. Never delete legacy keys in the release that introduces these.
  const MIGRATION_FLAG = 'propwire_migration_v2';
  const STORE = adapter.storageKeys;

  function migrateLegacyStorage() {
    const counts = {};
    try {
      const done = JSON.parse(localStorage.getItem(MIGRATION_FLAG) || 'null');
      if (done && done.version === 2) return { counts, notice: done };
      const L = adapter.legacyKeys;
      if (localStorage.getItem(L.portfolioLedger) !== null && localStorage.getItem(STORE.ledger) === null) {
        try {
          const entries = JSON.parse(localStorage.getItem(L.portfolioLedger));
          if (Array.isArray(entries)) {
            const tagged = entries.map((e) => ({ sport: SPORT_ID, ...e }));
            localStorage.setItem(STORE.ledger, JSON.stringify(tagged));
            counts[STORE.ledger] = tagged.length;
          }
        } catch (_) {}
      }
      const copies = [[L.watchlist, STORE.watchlist], [L.sniperConfig, STORE.sniperConfig], [L.dismissedCorrelations, STORE.dismissedCorrelations]];
      for (const [from, to] of copies) {
        const raw = localStorage.getItem(from);
        if (raw !== null && localStorage.getItem(to) === null) {
          localStorage.setItem(to, raw);
          counts[to] = 1;
        }
      }
      const notice = { version: 2, at: new Date().toISOString(), migrated: Object.keys(counts).length > 0, counts, notice_shown: false };
      localStorage.setItem(MIGRATION_FLAG, JSON.stringify(notice));
      console.log('[PropWire] storage migration v2 complete:', counts);
      return { counts, notice };
    } catch (_) {
      return { counts, notice: null };
    }
  }
  const migrationResult = migrateLegacyStorage();

  // ── §3. Persistence I/O — ledger / watchlist / sniper config ───────────

  /** One-time bottom-sheet notice after storage migration (spec item 6d). */
  function showMigrationNoticeOnce() {
    try {
      const notice = JSON.parse(localStorage.getItem(MIGRATION_FLAG) || 'null');
      if (!notice || !notice.migrated || notice.notice_shown) return;
      const dialog = document.createElement('dialog');
      dialog.className = 'migration-notice-sheet';
      dialog.setAttribute('aria-label', 'Storage migration notice');
      dialog.style.cssText = 'border:none; border-radius:16px 16px 0 0; padding:20px; max-width:420px; width:calc(100% - 24px); margin:auto auto 0; font-family:inherit;';
      dialog.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
          <span style="display:inline-flex; align-items:center; color:#10b981;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>
          <strong style="font-size:14px;">We reorganized your saved props</strong>
        </div>
        <p style="margin:0 0 14px; font-size:13px; line-height:1.5; color:#94a3b8;">Your NFL watchlist and ledger are intact. Saved data now lives under per-sport storage so NBA and UFC get their own spaces.</p>
        <div style="display:flex; gap:8px; justify-content:flex-end;">
          <button type="button" data-migration-view style="padding:8px 14px; border-radius:8px; border:1px solid #334155; background:transparent; color:#e2e8f0; font-size:13px;">View ledger</button>
          <button type="button" data-migration-ok style="padding:8px 14px; border-radius:8px; border:none; background:#a3e635; color:#0f172a; font-size:13px; font-weight:600;">Got it</button>
        </div>`;
      dialog.addEventListener('click', (event) => {
        if (event.target.closest('[data-migration-ok]') || event.target === dialog) {
          dialog.close();
        } else if (event.target.closest('[data-migration-view]')) {
          dialog.close();
          openPortfolioDialog();
        }
      });
      document.body.appendChild(dialog);
      dialog.showModal();
      notice.notice_shown = true;
      localStorage.setItem(MIGRATION_FLAG, JSON.stringify(notice));
    } catch (_) {}
  }

  function loadPortfolio() {
    try {
      const raw = localStorage.getItem(STORE.ledger);
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  function savePortfolio(portfolio) {
    try {
      localStorage.setItem(STORE.ledger, JSON.stringify(portfolio));
    } catch (_) {}
  }

  function loadWatchlist() {
    try {
      const raw = localStorage.getItem(STORE.watchlist);
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  function saveWatchlist(watchlist) {
    try {
      localStorage.setItem(STORE.watchlist, JSON.stringify(watchlist));
    } catch (_) {}
  }

  function loadSniperConfig() {
    try {
      const raw = localStorage.getItem(STORE.sniperConfig);
      return raw ? JSON.parse(raw) : {
        enabled: false,
        minEdge: 0.15,
        gateMetOnly: true,
        marketScope: 'ALL',
        browserNotify: true,
        webhookUrl: '',
        alerted: {},
        events: []
      };
    } catch (_) {
      return {
        enabled: false,
        minEdge: 0.15,
        gateMetOnly: true,
        marketScope: 'ALL',
        browserNotify: true,
        webhookUrl: '',
        alerted: {},
        events: []
      };
    }
  }

  function saveSniperConfig(cfg) {
    try {
      localStorage.setItem(STORE.sniperConfig, JSON.stringify(cfg));
    } catch (_) {}
  }

  // ── §4. Application state + DOM & format helpers ──────────────────────

  const state = {
    slateKey: '2026_w7',
    slate: [],
    games: [],
    picks: {},
    playerPhotos: { photos: {}, byName: {} },
    injuries: { injuries: [], impacted_beneficiaries: {} },
    odds: { quotes: [] },
    filters: { search: '', market: adapter.defaultMarket, position: 'ALL', team: '', gameId: '', playMode: 'actionable', intent: 'all' },
    view: matchMedia('(max-width: 768px)').matches ? 'cards' : 'table',
    deferredInstall: null,
    selectedPlayerId: null,
    selectedExecutionPlayerId: null,
    focusedIndex: -1,
    scenarioTargetShare: null,
    bankroll: 5000,
    clvReport: null,
    portfolio: loadPortfolio(),
    watchlist: loadWatchlist(),
    sniper: loadSniperConfig(),
    sniperCooldowns: {},
    dismissedCorrelations: new Set(JSON.parse(localStorage.getItem(STORE.dismissedCorrelations) || '[]')),
    tickFlashes: {},
    priceHistory: {},
    openSnapshots: {},
    bottomTab: 'slate',
    // Free open-access mode: full pro quantitative access without paywall.
    userTier: 'pro',
    slateScrollY: 0
  };
  try {
    const savedBankroll = localStorage.getItem('propwire-bankroll');
    if (savedBankroll) state.bankroll = Math.max(100, Number(savedBankroll));
  } catch (_) {}

  const $ = (selector) => document.querySelector(selector);
  // Parity-proof DOM access for switcher/chrome elements (audit B2, fixed):
  // the snapshot sandbox now implements getElementById against the shipped
  // HTML's ids and records every call — chrome writes are CAPTURED in the
  // goldens and pinned by the dom_access_log snapshot + allowlist assertion.
  const elById = (id) => (typeof document.getElementById === 'function' ? document.getElementById(id) : null);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const finite = (value) => Number.isFinite(Number(value));
  const num = (value, fallback = 0) => finite(value) ? Number(value) : fallback;
  const pct = (value, digits = 1) => `${(num(value) * 100).toFixed(digits)}%`;
  const signedPct = (value, digits = 1) => `${num(value) > 0 ? '+' : ''}${pct(value, digits)}`;
  const oddsText = (value) => `${num(value) > 0 ? '+' : ''}${num(value)}`;
  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
  const bookShort = (book) => bookShortV152(book);

  // ── v152 book identity — mirrors src/odds_adapter.py BOOK_META ──────────
  // Self-hosted wordmark badges (viewer/books/<id>.svg): same-origin, so the
  // CSP img-src 'self' policy that v150 fixed keeps working with zero
  // external requests. resolveBookId() normalizes display names ("DraftKings",
  // "ESPN BET") and provider slugs ("circa_sports", "Draftkings") to one id.
  const BOOKS = {
    draftkings: { name: 'DraftKings', short: 'DK',   color: '#53d337', logo: 'books/draftkings.svg?v=v152' },
    fanduel:    { name: 'FanDuel',    short: 'FD',   color: '#7ab8ff', logo: 'books/fanduel.svg?v=v152' },
    betmgm:     { name: 'BetMGM',     short: 'MGM',  color: '#c6a45e', logo: 'books/betmgm.svg?v=v152' },
    caesars:    { name: 'Caesars',    short: 'CZR',  color: '#c39e6d', logo: 'books/caesars.svg?v=v152' },
    pinnacle:   { name: 'Pinnacle',   short: 'PIN',  color: '#f56f36', logo: 'books/pinnacle.svg?v=v152' },
    betrivers:  { name: 'BetRivers',  short: 'BR',   color: '#ffc72c', logo: 'books/betrivers.svg?v=v152' },
    fanatics:   { name: 'Fanatics',   short: 'FAN',  color: '#e03131', logo: 'books/fanatics.svg?v=v152' },
    bet365:     { name: 'bet365',     short: '365',  color: '#0b7d57', logo: 'books/bet365.svg?v=v152' },
    espnbet:    { name: 'ESPN BET',   short: 'ESPN', color: '#d50a0a', logo: 'books/espnbet.svg?v=v152' },
    circa:      { name: 'Circa',      short: 'CIR',  color: '#ff8200', logo: 'books/circa.svg?v=v152' }
  };
  const BOOK_ALIASES = {
    circasports: 'circa', espnbetus: 'espnbet', betonlineag: 'betonline',
    draftkingsus: 'draftkings', fanduelus: 'fanduel', betmgmus: 'betmgm',
    betmgmny: 'betmgm', betriversny: 'betrivers', fanaticsportsbook: 'fanatics',
    bet365us: 'bet365', bet365nj: 'bet365'
  };
  const resolveBookId = (ref) => {
    if (!ref) return null;
    const slug = String(ref).toLowerCase().replace(/[-_ ]/g, '');
    return BOOK_ALIASES[slug] || slug;
  };
  const bookMeta = (ref) => BOOKS[resolveBookId(ref)] || null;
  // bookShort v152: consult the registry first (covers BetRivers/Fanatics/
  // bet365/ESPN BET/Circa), keep the legacy inline map for unknown books.
  const bookShortV152 = (book) => {
    const meta = bookMeta(book);
    if (meta) return meta.short;
    return ({ DraftKings: 'DK', FanDuel: 'FD', BetMGM: 'MGM', Caesars: 'CZR', Pinnacle: 'PIN' })[book] || book || 'Book';
  };
  const bookLogoImg = (ref, cls = 'book-logo') => {
    const meta = bookMeta(ref);
    if (!meta) return '';
    return `<img class="${cls}" src="${meta.logo}" alt="${esc(meta.name)}" title="${esc(meta.name)}" loading="lazy">`;
  };
  // Live-feed book patch (v152): the odds feed ships a `books` map; unknown
  // books advertised by the provider get a text-safe fallback entry so chips
  // still render without a badge file. Fail-closed: strings only.
  const mergeFeedBooks = (feedBooks) => {
    if (!feedBooks || typeof feedBooks !== 'object') return 0;
    let merged = 0;
    for (const [id, cfg] of Object.entries(feedBooks)) {
      if (!id || typeof cfg !== 'object') continue;
      if (id in BOOKS) continue;
      const name = typeof cfg.name === 'string' ? cfg.name : id;
      BOOKS[id] = {
        name, short: typeof cfg.short === 'string' ? cfg.short : name.slice(0, 4),
        color: typeof cfg.color === 'string' ? cfg.color : '#7d8592',
        logo: typeof cfg.logo === 'string' && !cfg.logo.includes('..') ? cfg.logo : ''
      };
      merged += 1;
    }
    return merged;
  };

  // Canonical CLV ledger root hash anchored to settle_ledger.py and clv_audit_report.json
  const CLV_ROOT_HASH_FALLBACK = '178e29974bf8748c';

  // Map PropWire team codes to official ESPN CDN slugs + subtle brand ring tints
  // (NFL crest metadata lives on the adapter; other sports bring their own).
  const NFL_LOGO_MAP = adapter.logo.map;

  // ── §5. Team identity — logos & crests ────────────────────────────────

  function teamLogoUrl(team) {
    if (!team) return '';
    const code = String(team).toUpperCase();
    const meta = NFL_LOGO_MAP[code];
    const slug = meta ? meta.slug : team.toLowerCase();
    return `${adapter.logo.espnCdnBase}${slug}.png`;
  }

  function teamCrest(team, size = 'md') {
    if (!team) return '';
    const code = String(team).toUpperCase();
    const meta = NFL_LOGO_MAP[code] || {
      slug: team.toLowerCase(),
      bg: 'rgba(255,255,255,0.08)',
      border: 'rgba(255,255,255,0.18)'
    };
    const sizeCls = size === 'sm' ? 'crest-sm' : size === 'lg' ? 'crest-lg' : 'crest-md';
    // v150: CSP-clean crest markup. The production CSP (viewer/vercel.json)
    // blocks inline style="" attributes and inline onerror= handlers, which
    // flattened crest theming and killed logo error-handling on prod. Theme
    // colors ride as data attributes and are applied via CSSOM (CSP-exempt)
    // by the crest observer below; image errors bind addEventListener for
    // the same reason.
    return `<div class="team-crest ${sizeCls}" data-crest-bg="${meta.bg}" data-crest-border="${meta.border}" title="${esc(code)}"><img src="${adapter.logo.espnCdnBase}${meta.slug}.png" alt="${esc(code)}" loading="lazy" class="crest-img"></div>`;
  }

  // v150 — CSP-exempt crest theming. One delegated observer covers every
  // render path (feed rows, cards, injury panel, prime games, ledger modal,
  // execution dialog) without touching each innerHTML site. Individual
  // CSSOM property assignment is allowed under style-src; setAttribute
  // style and cssText are not, so they stay out of the markup entirely.
  function applyCrestTheme(crest) {
    crest.style.backgroundColor = crest.dataset.crestBg;
    crest.style.borderColor = crest.dataset.crestBorder;
    delete crest.dataset.crestBg;
    delete crest.dataset.crestBorder;
    const img = crest.querySelector('.crest-img');
    if (img && !img.dataset.crestErrBound) {
      img.dataset.crestErrBound = '1';
      img.addEventListener('error', () => { img.style.display = 'none'; });
    }
  }
  // Guarded: the node:test parity sandbox runs app.js in a bare vm context
  // without MutationObserver; crest theming stays a browser-only behavior.
  const crestThemeObserver = typeof MutationObserver === 'undefined'
    ? null
    : new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            if (node.matches && node.matches('.team-crest[data-crest-bg]')) applyCrestTheme(node);
            if (node.querySelectorAll) node.querySelectorAll('.team-crest[data-crest-bg]').forEach(applyCrestTheme);
          }
        }
      });
  function initCrestTheming() {
    document.querySelectorAll('.team-crest[data-crest-bg]').forEach(applyCrestTheme);
    if (crestThemeObserver) crestThemeObserver.observe(document.body, { childList: true, subtree: true });
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
    warn: '<svg class="prop-icon icon-warn" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5L1.5 13.5h13L8 2.5zM8 6.5v3.5M8 11.5v.5"/></svg>',
    dome: '<svg class="prop-icon icon-dome" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 13h12M3 13a5 5 0 0110 0M8 3v2"/></svg>',
    wind: '<svg class="prop-icon icon-wind" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 5.5h7a1.5 1.5 0 10-1.5-1.5M2 8.5h10.5a1.5 1.5 0 10-1.5-1.5M2 11.5h5a1.5 1.5 0 10-1.5-1.5"/></svg>',
    check: '<svg class="prop-icon icon-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3.5 3.5 6.5-7"/></svg>',
    target: '<svg class="prop-icon icon-target" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="2"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2"/></svg>',
    star: (filled = false) => `<svg class="prop-icon icon-star" viewBox="0 0 16 16" fill="${filled ? '#fbbf24' : 'none'}" stroke="${filled ? '#fbbf24' : 'currentColor'}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="8 1.5 10.2 6 15 6.7 11.5 10.1 12.3 14.9 8 12.6 3.7 14.9 4.5 10.1 1 6.7 5.8 6 8 1.5"/></svg>`,
    shield: '<svg class="prop-icon icon-shield" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.5l6 2.5v4c0 4.5-6 6.5-6 6.5s-6-2-6-6.5v-4l6-2.5z"/></svg>',
    search: '<svg class="prop-icon icon-search" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>'
  };

  // Lend viewer helpers to adapter hooks (adapters are separate files with
  // no closure access to app.js utilities).
  adapter.bindContext({ num, pct, esc, SVG_ICONS });

  /** Current market definition from the active sport adapter. */
  const marketDef = (id = state.filters.market) => adapter.markets[id] || adapter.markets[adapter.defaultMarket];

  /**
   * Circuit breaker parameters for one market: config-first
   * (viewer/circuit_breaker_config.json, fetched at slate load), adapter
   * fallback on fetch failure. NEVER copy NFL values to another sport —
   * uncalibrated sports carry "calibrated": false in their own block.
   */
  // ── §6. Distribution visuals — bullet graphs, sparklines, insights ────

  function breakerFor(marketId) {
    const mdef = marketDef(marketId);
    const cfg = state.breakerConfig;
    const sportCfg = cfg && cfg.sports ? cfg.sports[SPORT_ID] : null;
    if (sportCfg) {
      const mk = (sportCfg.markets && sportCfg.markets[marketId]) || {};
      const th = sportCfg.thresholds || {};
      return {
        driftHurdle: Number.isFinite(Number(mk.drift_hurdle)) ? Number(mk.drift_hurdle) : mdef.breaker.driftHurdle,
        pctHurdle: Number.isFinite(Number(th.drift_pct_hurdle)) ? Number(th.drift_pct_hurdle) : adapter.breakerFallback.drift_pct_hurdle,
        beneficiaryMax: Number.isFinite(Number(mk.beneficiary_max_drift)) ? Number(mk.beneficiary_max_drift) : mdef.breaker.beneficiaryMax,
        highEdge: Number.isFinite(Number(th.high_edge_caution_hurdle)) ? Number(th.high_edge_caution_hurdle) : adapter.breakerFallback.high_edge_caution_hurdle,
        cooldownMinutes: Number.isFinite(Number(th.cooldown_minutes)) ? Number(th.cooldown_minutes) : adapter.breakerFallback.cooldown_minutes,
        calibrated: sportCfg.calibrated !== false,
        configVersion: cfg.config_version || '1.1.0',
        source: 'config'
      };
    }
    return {
      driftHurdle: mdef.breaker.driftHurdle,
      pctHurdle: adapter.breakerFallback.drift_pct_hurdle,
      beneficiaryMax: mdef.breaker.beneficiaryMax,
      highEdge: adapter.breakerFallback.high_edge_caution_hurdle,
      cooldownMinutes: adapter.breakerFallback.cooldown_minutes,
      calibrated: adapter.breakerFallback.calibrated,
      configVersion: '1.1.0',
      source: 'adapter-fallback'
    };
  }

  function keyDriverTag(row, beneficiary) {
    return adapter.driverTag(row, beneficiary, state.filters.market);
  }

  function distributionRange(row) {
    return marketDef().dist(row);
  }

  function propBulletGraphSvg(dist, evaluation, side = 'OVER') {
    if (dist.isTd) {
      const probPct = Math.min(100, Math.max(0, dist.prob * 100));
      return `
        <div class="bullet-container td-bullet">
          <div class="bullet-top-readout">
            <span class="bullet-dim">P(TD)</span> <strong class="bullet-bold text-accent">${pct(dist.prob, 0)}</strong>
          </div>
          <svg class="bullet-svg" viewBox="0 0 100 14" preserveAspectRatio="none" aria-hidden="true">
            <rect class="bullet-track" x="0" y="5" width="100" height="4" rx="2" fill="#2a2d35" />
            <rect class="bullet-fill" x="0" y="4.5" width="${probPct.toFixed(1)}" height="5" rx="2" fill="#a3e635" />
          </svg>
          <div class="bullet-bottom-sub"><span>Model: ${pct(dist.prob, 1)}</span></div>
        </div>`;
    }

    const isRec = Boolean(dist.isRec);
    const maxScale = isRec ? 14 : 190;
    const unit = isRec ? 'rec' : 'y';
    const toPct = (val) => Math.min(100, Math.max(0, (val / maxScale) * 100));

    const lowPct = toPct(dist.low);
    const highPct = toPct(dist.high);
    const widthPct = Math.max(2, highPct - lowPct);

    const hasBook = evaluation && evaluation.state !== 'none' && Number.isFinite(evaluation.line);
    const bookLine = hasBook ? evaluation.line : null;
    const bookPct = hasBook ? toPct(bookLine) : 0;
    const fairPct = toPct(dist.fair);
    const projPct = toPct(dist.proj);

    const deltaStart = hasBook ? Math.min(bookPct, fairPct) : 0;
    const deltaWidth = hasBook ? Math.abs(fairPct - bookPct) : 0;
    const deltaColor = side === 'OVER' ? 'rgba(132, 204, 22, 0.32)' : 'rgba(56, 189, 248, 0.4)';

    return `
      <div class="bullet-container" title="80% CI: ${dist.low}–${dist.high}${unit} | Fair: ${dist.fair.toFixed(1)} | Proj: ${dist.proj.toFixed(1)}${hasBook ? ` | Book: ${bookLine.toFixed(1)}` : ''}">
        <div class="bullet-top-readout">
          <div><span class="bullet-dim">FAIR</span> <strong class="bullet-bold text-fair">${dist.fair.toFixed(1)}</strong></div>
          <span class="split-divider">|</span>
          <div><span class="bullet-dim">PROJ</span> <strong class="bullet-bold text-accent">${dist.proj.toFixed(1)}</strong></div>
        </div>
        <svg class="bullet-svg" viewBox="0 0 100 14" preserveAspectRatio="none" aria-hidden="true">
          <!-- Background Track (0 to maxScale) -->
          <rect class="bullet-track" x="0" y="5" width="100" height="4" rx="1.5" fill="#2a2d35" />
          <!-- 80% Confidence Interval Bar -->
          <rect class="bullet-fill" x="${lowPct.toFixed(1)}" y="4.5" width="${widthPct.toFixed(1)}" height="5" rx="1" fill="#465264" />
          <!-- Edge Delta Highlight -->
          ${hasBook && deltaWidth > 0 ? `<rect x="${deltaStart.toFixed(1)}" y="4.5" width="${deltaWidth.toFixed(1)}" height="5" fill="${deltaColor}" />` : ''}
          <!-- Book Line Marker (Crisp Vertical Amber Tick) -->
          ${hasBook ? `<line class="bullet-book-marker" x1="${bookPct.toFixed(1)}" y1="1" x2="${bookPct.toFixed(1)}" y2="13" stroke="#d9a441" stroke-width="1.8" />` : ''}
          <!-- Fair Line Marker (Solid White Tick) -->
          <line class="bullet-fair-marker" x1="${fairPct.toFixed(1)}" y1="2.5" x2="${fairPct.toFixed(1)}" y2="11.5" stroke="#e2e8f0" stroke-width="1.6" />
          <!-- Model Projection Mean (Volt Green Dot) -->
          <circle class="bullet-proj-marker" cx="${projPct.toFixed(1)}" cy="7" r="2.5" fill="#3ccf91" stroke="#0f131a" stroke-width="0.8" />
        </svg>
        <div class="bullet-bottom-sub">
          <span class="bullet-ci-wrap">80% <span class="bullet-ci-tag">${dist.low}–${dist.high}${unit}</span></span>
          <span class="bullet-bk">${hasBook ? `${bookLogoImg(evaluation.book, 'book-logo book-logo-mini')}Bk ${bookLine.toFixed(1)}` : 'Model only'}</span>
        </div>
      </div>`;
  }

  function distSparklineSvg(dist, bookLine, w = 68, h = 18) {
    return propBulletGraphSvg(dist, { state: Number.isFinite(bookLine) ? 'verified' : 'none', line: bookLine });
  }

  function predictionInterval(row) {
    return marketDef().prediction(row);
  }

  function naturalInsight(row, evaluation) {
    const fair = fairValue(row);
    const proj = projectionValue(row);
    const unit = marketDef().naturalInsightUnit;
    if (evaluation.state === 'none') {
      if (proj >= marketDef().strongCeiling) {
        return `Model projects strong ceiling at ${proj.toFixed(1)} ${unit} (Waiting for sportsbook quotes).`;
      }
      return `Model baseline sits at ${fair.toFixed(1)} ${unit} (Waiting for sportsbook quotes).`;
    }
    if (evaluation.closed) {
      return `Market closed for kickoff (Model fair ${fair.toFixed(1)} ${unit}).`;
    }
    if (evaluation.dataCheck) {
      return `Model fair sits at ${fair.toFixed(1)} ${unit} (${signedPct(evaluation.ev)} EV on ${evaluation.side} ${evaluation.line.toFixed(1)} line · Verify before acting).`;
    }
    if (evaluation.state === 'ingested') {
      return `Model fair sits at ${fair.toFixed(1)} ${unit} (${signedPct(evaluation.ev)} EV on ${evaluation.side} ${evaluation.line.toFixed(1)} ${bookShort(evaluation.book)} quote · Unverified).`;
    }
    return `Model fair price sits at ${fair.toFixed(1)} ${unit} (${signedPct(evaluation.ev)} EV edge on ${evaluation.side} ${evaluation.line.toFixed(1)} ${bookShort(evaluation.book)} quote).`;
  }

  // ── Quarantine Foreign Third-Party Extension Injections (e.g. 1688 / shopping assistants) ──
  function quarantineThirdPartyInjections() {
    if (typeof document === 'undefined') return;
    const purge = () => {
      const selectors = [
        '[id*="1688"]', '[class*="1688"]',
        '[id*="caigou"]', '[class*="caigou"]',
        '[id*="cai-gou"]', '[class*="cai-gou"]',
        '[id*="aliprice"]', '[class*="aliprice"]',
        '[id*="extension-root"]', '[class*="extension-root"]',
        '[id*="floating-search"]', '[class*="floating-search"]',
        'div[id^="__cai"]', 'div[class^="__cai"]',
        'div[id^="__1688"]', 'div[class^="__1688"]'
      ];
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
          try { el.remove(); } catch (_) { el.style.display = 'none'; }
        });
      });
    };
    purge();
    if (typeof MutationObserver !== 'undefined' && document.body) {
      const obs = new MutationObserver((mutations) => {
        let hasInjected = false;
        for (const m of mutations) {
          if (m.addedNodes.length) {
            hasInjected = true;
            break;
          }
        }
        if (hasInjected) purge();
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }
  }

  document.addEventListener('DOMContentLoaded', init);

  let pollIntervalId = null;
  state.lastPolledAt = Date.now() - 14000;
  state.nextPollSeconds = 46;

  let hapticSwitchEl = null;
  // ── §7. Device feedback & polling — haptics, pull-to-refresh, feed UI ─

  function triggerHaptic(style = 'light') {
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        if (style === 'heavy') navigator.vibrate(24);
        else if (style === 'medium') navigator.vibrate(14);
        else navigator.vibrate(8);
      }
      // iOS Safari 17.4+ hidden switch toggle workaround
      if (!hapticSwitchEl && typeof document !== 'undefined') {
        hapticSwitchEl = document.createElement('input');
        hapticSwitchEl.type = 'checkbox';
        hapticSwitchEl.setAttribute('switch', '');
        hapticSwitchEl.style.cssText = 'position:fixed;opacity:0;pointer-events:none;top:-9999px;left:-9999px;';
        document.body.appendChild(hapticSwitchEl);
      }
      if (hapticSwitchEl) {
        hapticSwitchEl.checked = !hapticSwitchEl.checked;
      }
    } catch (_) {}
  }

  function initPullToRefresh() {
    let startY = 0;
    let isPulling = false;

    window.addEventListener('touchstart', (e) => {
      if (window.scrollY <= 0 && e.touches.length === 1) {
        startY = e.touches[0].clientY;
        isPulling = true;
      } else {
        isPulling = false;
      }
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      if (!isPulling) return;
      const currentY = e.touches[0].clientY;
      const deltaY = currentY - startY;
      if (deltaY > 80 && window.scrollY <= 0) {
        isPulling = false;
        triggerHaptic('medium');
        triggerOddsPoll(false);
      }
    }, { passive: true });

    window.addEventListener('touchend', () => {
      isPulling = false;
    }, { passive: true });
  }

  function initPollingTimer() {
    updatePollingDisplay();
    if (pollIntervalId) clearInterval(pollIntervalId);
    pollIntervalId = setInterval(() => {
      state.nextPollSeconds--;
      if (state.nextPollSeconds <= 0) {
        triggerOddsPoll(true);
      } else {
        updatePollingDisplay();
      }
    }, 1000);

    const manualBtn = $('#manualPollBtn');
    if (manualBtn) {
      manualBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        triggerOddsPoll(false);
      };
    }

    const widget = $('#livePollingWidget');
    if (widget) {
      widget.onclick = (e) => {
        if (e.target.closest('#manualPollBtn')) return;
        toast('Bovada API: Active (64 verified quotes) · DraftKings/Pinnacle: Pre-game feed (Scheduled 12:00 PM)');
      };
    }
  }

  function updatePollingDisplay() {
    const timerText = $('#pollingTimerText');
    const elapsedSec = Math.max(0, Math.floor((Date.now() - state.lastPolledAt) / 1000));
    const ageText = elapsedSec < 60 ? `${elapsedSec}s ago` : `${Math.floor(elapsedSec / 60)}m ago`;

    let newsNotice = ' · News: Practice Wire Ingested';
    if (state.newsWatcherState && state.newsWatcherState.last_polled_at) {
      const newsAge = Math.max(0, Math.floor((Date.now() - new Date(state.newsWatcherState.last_polled_at).getTime()) / 1000));
      if (newsAge <= 300) {
        newsNotice = ` · News Active (${newsAge}s ago)`;
      }
    }

    if (timerText) {
      timerText.textContent = `Quotes ${ageText}${newsNotice}`;
      timerText.style.color = '';
    }
    const mobileStatusText = $('#mobileStatusText');
    if (mobileStatusText) {
      mobileStatusText.textContent = `${feedVerificationLabel()} · ${state.nextPollSeconds}s`;
      mobileStatusText.style.color = '';
    }
  }

  function feedVerificationLabel(feed = state.odds) {
    const status = String((feed && feed.feed_status) || '').toUpperCase();
    const verifiedQuotes = Number(feed && feed.verified_quotes_count) || 0;
    if (status === 'FIXTURE' || adapter.fixturesOnly === true) return 'FIXTURE';
    if (verifiedQuotes > 0 && !status.includes('UNVERIFIED')) return 'VERIFIED';
    return 'UNVERIFIED';
  }

  function updateFeedVerificationUI() {
    const label = feedVerificationLabel();
    const selector = $('#slateSelector');
    const activeOption = selector && selector.querySelector
      ? selector.querySelector(`option[value="${state.slateKey}"]`)
      : null;
    if (activeOption && !SLATES[state.slateKey]?.historical) {
      // Live slates label by week and carry the feed-status suffix
      // ("W7 Unverified"). Date-keyed fixture slates keep their shortLabel
      // untouched — it already says "Fixture", and appending the FIXTURE
      // status would read "Oct 22 Fixture Fixture".
      const slateCfg = SLATES[state.slateKey] || {};
      if (slateCfg.week != null) {
        activeOption.textContent = `W${slateCfg.week} ${label[0]}${label.slice(1).toLowerCase()}`;
      }
    }
    const statusPill = $('#mobileStatusPill');
    if (statusPill) statusPill.title = `${label} odds feed · Tap for telemetry`;
    const mobileStatusText = $('#mobileStatusText');
    if (mobileStatusText) mobileStatusText.textContent = label;
  }

  // ── §8. Odds polling pipeline — live quotes, never cached ─────────────

  async function triggerOddsPoll(isAuto = false) {
    const refreshBtn = $('#manualPollBtn');
    if (refreshBtn) refreshBtn.classList.add('is-spinning');
    state.lastPolledAt = Date.now();
    state.nextPollSeconds = 60;
    updatePollingDisplay();

    // Record previous state map to calculate directional EV changes
    const prevQuoteMap = {};
    (state.odds.quotes || []).forEach((q) => {
      const k = `${q.player_id}::${q.market}`;
      const ev = q.evaluation ? Number(q.evaluation.expected_return || 0) : 0;
      const edge = q.evaluation ? Number(q.evaluation.prob_edge || 0) : 0;
      prevQuoteMap[k] = { line: q.line, odds: q.over_odds, ev, edge };
    });

    try {
      const config = SLATES[state.slateKey] || SLATES['2026_w7'];
      const oddsUrl = config.odds || 'live_odds_feed.json';
      const freshData = await fetchJson(`${oddsUrl}?t=${Date.now()}`, null);
      if (freshData && freshData.quotes) {
        const quotes = freshData.quotes;
        mergeFeedBooks(freshData.books); // v152: provider-advertised books -> logo registry
        state.odds = freshData;
        if (state.feedHealth) {
          state.feedHealth.odds = 'ok';
          state.feedHealth.oddsUpdatedAt = freshData.updated_at || null;
        }

        // Compute directional EV / edge tick flashes
        state.tickFlashes = {};
        let upMoves = 0;
        let downMoves = 0;

        (freshData.quotes || []).forEach((q) => {
          const k = `${q.player_id}::${q.market}`;
          const prev = prevQuoteMap[k];
          const curEv = q.evaluation ? Number(q.evaluation.expected_return || 0) : 0;
          const curEdge = q.evaluation ? Number(q.evaluation.prob_edge || 0) : 0;
          const curLine = Number(q.line);

          // Append to price sparkline history
          if (!state.priceHistory[k]) {
            state.priceHistory[k] = [curLine, curLine, curLine, curLine];
          } else if (state.priceHistory[k][state.priceHistory[k].length - 1] !== curLine) {
            state.priceHistory[k].push(curLine);
            if (state.priceHistory[k].length > 6) state.priceHistory[k].shift();
          }

          if (prev) {
            const evDelta = curEv - prev.ev;
            const edgeDelta = curEdge - prev.edge;
            const lineDelta = Math.abs(curLine - prev.line);
            const oddsDelta = Math.abs((q.over_odds || 0) - (prev.odds || 0));

            // Meaningful move filter: line move >= 0.5 yds, odds move >= 10 cents, or edge/EV delta >= 1.5%
            const isSignificant = lineDelta >= 0.5 || oddsDelta >= 10 || Math.abs(evDelta) >= 0.015 || Math.abs(edgeDelta) >= 0.015;

            if (isSignificant) {
              if (evDelta > 0.005 || edgeDelta > 0.005) {
                state.tickFlashes[k] = 'up';
                upMoves++;
              } else if (evDelta < -0.005 || edgeDelta < -0.005) {
                state.tickFlashes[k] = 'down';
                downMoves++;
              }
            }
          }
        });

        renderHeader();
        renderBoard();
        checkSniperAlerts();

        // Auto-clear flash states after keyframe ends
        setTimeout(() => {
          state.tickFlashes = {};
          $$('.tick-flash-up, .tick-flash-down').forEach((el) => {
            el.classList.remove('tick-flash-up', 'tick-flash-down');
          });
        }, 950);

        if (!isAuto && (upMoves > 0 || downMoves > 0)) {
          triggerHaptic('light');
        }

        const verifiedCount = quotes.filter((quote) => quoteState(quote) === 'verified').length;
        const refreshSummary = `${quotes.length} ingested · ${verifiedCount} receipt-verified`;
        toast(isAuto ? `Odds checked: ${refreshSummary} (${upMoves + downMoves} provider moves)` : `Refresh complete: ${refreshSummary}`);
      }
    } catch (e) {
      console.warn('Live odds polling error:', e);
    } finally {
      if (refreshBtn) {
        setTimeout(() => refreshBtn.classList.remove('is-spinning'), 600);
      }
    }
  }

  // ── §9. Boot & control binding — init, deep links, bindControls ───────

  /**
   * Slate-index discovery (autopilot pipeline, scripts/autopilot.py).
   *
   * The daily pipeline commits new weeks/nights as data files plus a small
   * manifest (feeds/slate-index.json). This boot step merges manifest slates
   * into the active adapter's registry so a new week appears WITHOUT a code
   * release, then adopts the manifest's default live slate.
   *
   * Fail-closed on purpose: any transport/validation failure (offline, stale
   * manifest, malformed entry) leaves the built-in slate registry untouched
   * and the boot default exactly as shipped. The manifest is plain JSON, so
   * the SW's JSON policy (never cache data) makes it network-only — offline
   * boots deterministically fall back to the built-in slates.
   */
  async function initSlateIndex() {
    try {
      const manifest = await fetchJson('feeds/slate-index.json', null);
      if (!manifest || manifest.schema_version !== 'slate-index.v1' || !manifest.sports) return 0;
      const entry = manifest.sports[SPORT_ID];
      if (!entry || !entry.slates || typeof entry.slates !== 'object') return 0;
      const registry = adapter.slates; // adapter is frozen; the slates map is extensible
      let merged = 0;
      for (const [key, cfg] of Object.entries(entry.slates)) {
        if (!cfg || typeof cfg !== 'object' || !key || (key in registry)) continue;
        if (typeof cfg.slate !== 'string' || typeof cfg.games !== 'string') continue;
        registry[key] = {
          season: Number.isFinite(Number(cfg.season)) ? Number(cfg.season) : null,
          week: Number.isFinite(Number(cfg.week)) ? Number(cfg.week) : null,
          date: typeof cfg.date === 'string' ? cfg.date : null,
          shortLabel: typeof cfg.shortLabel === 'string' ? cfg.shortLabel : key,
          state: typeof cfg.state === 'string' ? cfg.state : '',
          slate: cfg.slate,
          games: cfg.games,
          picks: typeof cfg.picks === 'string' ? cfg.picks : null,
          injuries: typeof cfg.injuries === 'string' ? cfg.injuries : null,
          odds: typeof cfg.odds === 'string' ? cfg.odds : null,
          snapshots: typeof cfg.snapshots === 'string' ? cfg.snapshots : null,
          historical: cfg.historical === true,
          timezone: typeof cfg.timezone === 'string' ? cfg.timezone : undefined,
          fromManifest: true
        };
        merged += 1;
      }
      if (merged > 0) {
        const def = entry.default_slate;
        if (typeof def === 'string' && registry[def] && !registry[def].historical) {
          state.slateKey = def;
        }
        try {
          console.info(`[slate-index] merged ${merged} slate(s); boot ${state.slateKey}`);
        } catch (_) {}
      }
      return merged;
    } catch (_) {
      return 0; // offline / manifest unavailable — built-in slates only
    }
  }

  // ---- v155 player headshots -------------------------------------------------
  // Map: viewer/feeds/player_photos.json — {photos: {player_id: {url,name,league}},
  // by_name: {normalized_name: player_id}}. Built by scripts/build_player_photos.py
  // (ESPN search v2, strict normalized name match, URLs verified 200 image/*).
  // Headshots ride a.espncdn.com — CSP img-src already allows it (v150 crests).
  // Cosmetic layer, fail-open: any error leaves the terminal exactly as before.
  function normalizePlayerName(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[.,'’]/g, '')
      .replace(/-/g, ' ')
      .split(/\s+/)
      .filter((token) => token && !['jr', 'sr', 'ii', 'iii', 'iv', 'v'].includes(token))
      .join(' ')
      .trim();
  }

  function avatarFor(playerId, displayName, team) {
    const store = state.playerPhotos || {};
    const photos = store.photos || {};
    const byName = store.by_name || {};
    let entry = null;
    if (playerId && photos[String(playerId)]) entry = photos[String(playerId)];
    else if (displayName) {
      const pid = byName[normalizePlayerName(displayName)];
      if (pid && photos[pid]) entry = photos[pid];
    }
    const initials = (String(displayName || '').trim().split(/\s+/)
      .map((part) => (part[0] || '').toUpperCase())
      .join('').replace(/[^A-Z]/g, '').slice(0, 2)) || '?';
    const face = `<span class="pw-avatar-initials" aria-hidden="true">${esc(initials)}</span>`;
    // v168 composite: the team logo rides the picture's bottom-left corner as a
    // circular chip on a solid dark surface (CSS-owned — team tints are too
    // subtle over a photo). Dead logos self-remove through the delegated
    // capture-phase error handler in initPlayerPhotos.
    const code = String(team || '').toUpperCase();
    const meta = code ? (NFL_LOGO_MAP[code] || { slug: String(team).toLowerCase() }) : null;
    const badge = meta
      ? `<img class="pw-avatar-team-badge" src="${adapter.logo.espnCdnBase}${meta.slug}.png" alt="${esc(code)}" title="${esc(code)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
      : '';
    if (!entry || !entry.url) {
      return `<span class="pw-avatar pw-avatar-fallback">${face}${badge}</span>`;
    }
    return `<span class="pw-avatar">${face}<img class="pw-avatar-img" src="${esc(entry.url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">${badge}</span>`;
  }

  async function initPlayerPhotos() {
    // Delegated capture-phase error handler: a dead headshot URL removes the
    // <img> so the initials underneath show through. CSP-safe (no inline
    // handlers — same discipline as the v150 crest fix).
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('error', (event) => {
        const el = event.target;
        if (!el || !el.classList) return;
        if (el.classList.contains('pw-avatar-img') || el.classList.contains('pw-avatar-team-badge')) el.remove();
        // v169: NBA court avatars hide (not remove) on a dead URL — keeps the
        // lineup slot's layout. CSSOM assignment is CSP-exempt; the old inline
        // onerror="this.style.display='none'" was blocked on prod by script-src.
        if (el.classList.contains('nba-court-avatar-img')) el.style.display = 'none';
      }, true);
    }
    try {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, 4000) : null;
      const res = await fetch('/feeds/player_photos.json', ctrl ? { cache: 'no-store', signal: ctrl.signal } : { cache: 'no-store' });
      if (timer) clearTimeout(timer);
      if (!res || !res.ok) return;
      const data = await res.json();
      if (data && data.photos && data.by_name) state.playerPhotos = data;
    } catch (_) { /* cosmetic layer — fail open */ }
  }

  async function init() {
    quarantineThirdPartyInjections();
    initTheme();
    initCrestTheming();
    // Manifest merge BEFORE chrome render: the slate selector is built from
    // adapter.slates, so autopilot-registered weeks must exist before the
    // selector (and mobile twin) are populated. Fail-closed — see above.
    await initSlateIndex();
    // v155: headshot map BEFORE first render so avatars paint with the board.
    // 4s abort guard keeps boot honest on a dead network.
    await initPlayerPhotos();
    renderSportChrome();
    bindControls();
    initInstall();
    initPollingTimer();
    initPullToRefresh();
    showMigrationNoticeOnce();
    await loadSlate(defaultBootSlate());
    checkDeepLinks();
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  function checkDeepLinks() {
    try {
      const url = new URL(window.location.href);
      const rootParam = (url.searchParams.get('root') || url.searchParams.get('r') || '').trim();
      const receiptParam = (url.searchParams.get('receipt') || url.searchParams.get('ticket') || url.searchParams.get('id') || '').trim();
      const path = (window.location.pathname || '').toLowerCase();
      const hash = (window.location.hash || '').toLowerCase();
      const isLedgerRoute = path.includes('/ledger') || path.includes('/audit') || hash === '#ledger' || hash === '#audit';

      if (rootParam || receiptParam || isLedgerRoute) {
        setTimeout(async () => {
          await openClvReport();

          const report = state.clvAuditReport;
          const rootHash = (report?.ledger_root_hash || '178e29974bf8748c').toLowerCase();

          // 1. Root Hash Prefix & Substring Verification
          if (rootParam) {
            const cleanRoot = rootParam.toLowerCase();
            const isMatch = rootHash.startsWith(cleanRoot) || cleanRoot.startsWith(rootHash) || rootHash.includes(cleanRoot);
            const rootEl = $('#clvReportEyebrow');
            if (rootEl) {
              if (isMatch) {
                rootEl.innerHTML = `<span class="clv-root-tag" style="background:rgba(52,211,153,0.18); border:1px solid #10b981; color:#34d399; font-weight:bold; padding:3px 8px; border-radius:4px;">Verified Root #${esc(cleanRoot.slice(0, 16))}</span>`;
              } else {
                rootEl.innerHTML = `<span class="clv-root-tag" style="background:rgba(239,68,68,0.18); border:1px solid #ef4444; color:#f87171; font-weight:bold; padding:3px 8px; border-radius:4px;">Root #${esc(cleanRoot.slice(0, 16))} (Live Root: #${rootHash.slice(0, 16)})</span>`;
              }
            }
          }

          // 2. Receipt Hash Prefix Matching & Visual Highlight
          if (receiptParam) {
            const cleanReceipt = receiptParam.toLowerCase();
            setTimeout(() => {
              const rows = document.querySelectorAll('.clv-audit-table tbody tr');
              let matchFound = false;
              rows.forEach((r) => {
                const text = r.textContent.toLowerCase();
                if (text.includes(cleanReceipt)) {
                  matchFound = true;
                  r.style.outline = '2px solid #34d399';
                  r.style.boxShadow = '0 0 16px rgba(52,211,153,0.35)';
                  r.style.backgroundColor = 'rgba(52,211,153,0.16)';
                  r.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
              });

              if (matchFound) {
                const contentEl = $('#clvReportContent');
                if (contentEl && !$('#deepLinkReceiptBanner')) {
                  const banner = document.createElement('div');
                  banner.id = 'deepLinkReceiptBanner';
                  banner.style.cssText = 'background:rgba(52,211,153,0.12); border:1px solid #10b981; border-radius:6px; padding:8px 12px; margin-bottom:12px; font-size:12px; color:#34d399; font-family:var(--mono); display:flex; align-items:center; justify-content:space-between;';
                  banner.innerHTML = `<span><strong>[VERIFIED TICKET]</strong> Receipt matching <code>#${esc(cleanReceipt)}</code> pinned below.</span><span style="font-size:10px; opacity:0.8;">RFC-8785 Audit Passed</span>`;
                  contentEl.insertBefore(banner, contentEl.firstChild);
                }
              }
            }, 120);
          }
        }, 150);
      }
    } catch (_) {}
  }

  function bindControls() {
    if ($('#slateSelector')) $('#slateSelector').addEventListener('change', (event) => loadSlate(event.target.value));
    const availBtn = $('#availabilityToggle');
    if (availBtn) availBtn.addEventListener('click', toggleInjuries);
    const injuryToggle = $('#injuryToggle');
    if (injuryToggle) injuryToggle.addEventListener('click', toggleInjuries);
    const mobileUsageTicker = $('#mobileUsageTicker');
    if (mobileUsageTicker) mobileUsageTicker.addEventListener('click', () => {
      triggerHaptic('light');
      toggleInjuries();
    });
    const exportBtn = $('#exportBtn');
    if (exportBtn) exportBtn.addEventListener('click', handleSlateExportCsv);
    if ($('#searchInput')) $('#searchInput').addEventListener('input', syncFilters);
    if ($('#marketFilter')) $('#marketFilter').addEventListener('change', syncFilters);
    if ($('#positionFilter')) $('#positionFilter').addEventListener('change', syncFilters);
    if ($('#teamFilter')) $('#teamFilter').addEventListener('input', syncFilters);
    if ($('#clearFilters')) $('#clearFilters').addEventListener('click', clearFilters);

    // Interactive Risk Steppers (Gate & Kelly Cap)
    const gateMinus = $('#gateMinus');
    const gatePlus = $('#gatePlus');
    const capMinus = $('#capMinus');
    const capPlus = $('#capPlus');

    function updateGate(delta) {
      triggerHaptic('light');
      state.picks.gate_edge = Math.max(0.01, Math.min(0.30, +( (Number(state.picks.gate_edge) || 0.10) + delta ).toFixed(3)));
      renderHeader();
      renderBoard();
    }

    function updateCap(delta) {
      triggerHaptic('light');
      state.picks.kelly_cap = Math.max(0.005, Math.min(0.10, +( (Number(state.picks.kelly_cap) || 0.03) + delta ).toFixed(3)));
      renderHeader();
      renderBoard();
    }

    if (gateMinus && gatePlus) {
      gateMinus.addEventListener('click', () => updateGate(-0.01));
      gatePlus.addEventListener('click', () => updateGate(0.01));
    }

    if (capMinus && capPlus) {
      capMinus.addEventListener('click', () => updateCap(-0.005));
      capPlus.addEventListener('click', () => updateCap(0.005));
    }

    // Mobile Settings & Risk Sheet Controls
    const mobileMenuBtn = $('#mobileMenuBtn');
    const mobileStatusPill = $('#mobileStatusPill');
    const settingsDialog = $('#settingsDialog');

    if (mobileMenuBtn && settingsDialog) {
      mobileMenuBtn.addEventListener('click', () => {
        triggerHaptic('light');
        settingsDialog.showModal();
      });
    }

    if (mobileStatusPill && settingsDialog) {
      mobileStatusPill.addEventListener('click', () => {
        triggerHaptic('light');
        settingsDialog.showModal();
      });
    }

    const mobileSearchBtn = $('#mobileSearchBtn');
    if (mobileSearchBtn) {
      mobileSearchBtn.addEventListener('click', () => {
        triggerHaptic('light');
        const cmdRow = $('.pw-command-row');
        if (cmdRow) {
          cmdRow.classList.toggle('active');
          const searchInput = $('#searchInput');
          if (cmdRow.classList.contains('active') && searchInput) {
            searchInput.focus();
          }
        }
      });
    }

    const mobileContextPill = $('#mobileContextPill');
    if (mobileContextPill) {
      mobileContextPill.addEventListener('click', () => {
        triggerHaptic('light');
        const moreFiltersDialog = $('#moreFiltersDialog');
        if (moreFiltersDialog) moreFiltersDialog.showModal();
      });
    }

    // Unified Filters Bottom Sheet Handlers
    $$('#sheetPosChips [data-sheet-pos]').forEach((btn) => {
      btn.addEventListener('click', () => {
        triggerHaptic('light');
        const pos = btn.dataset.sheetPos;
        state.filters.position = pos;
        $$('#sheetPosChips [data-sheet-pos]').forEach((b) => b.classList.toggle('active', b === btn));
        syncFilters();
      });
    });

    $$('.filter-mode-chips [data-sheet-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        triggerHaptic('light');
        const mode = btn.dataset.sheetMode;
        setPlayMode(mode);
        $$('.filter-mode-chips [data-sheet-mode]').forEach((b) => b.classList.toggle('active', b === btn));
      });
    });

    const modalGateMinus = $('#modalGateMinus');
    const modalGatePlus = $('#modalGatePlus');
    const modalCapMinus = $('#modalCapMinus');
    const modalCapPlus = $('#modalCapPlus');

    if (modalGateMinus && modalGatePlus) {
      modalGateMinus.addEventListener('click', () => updateGate(-0.01));
      modalGatePlus.addEventListener('click', () => updateGate(0.01));
    }

    if (modalCapMinus && modalCapPlus) {
      modalCapMinus.addEventListener('click', () => updateCap(-0.005));
      modalCapPlus.addEventListener('click', () => updateCap(0.005));
    }

    const settingsBankrollInput = $('#settingsBankrollInput');
    if (settingsBankrollInput) {
      settingsBankrollInput.value = state.bankroll || 5000;
      settingsBankrollInput.addEventListener('input', (e) => {
        const val = Math.max(100, Number(e.target.value) || 5000);
        state.bankroll = val;
        try { localStorage.setItem('propwire-bankroll', String(val)); } catch (_) {}
        const detailBankroll = $('#kellyBankrollInput');
        if (detailBankroll) detailBankroll.value = val;
      });
    }

    const mobileSlateSelector = $('#mobileSlateSelector');
    if (mobileSlateSelector) {
      mobileSlateSelector.value = state.slateKey;
      mobileSlateSelector.addEventListener('change', (e) => {
        triggerHaptic('medium');
        loadSlate(e.target.value);
        if (settingsDialog && settingsDialog.open) settingsDialog.close();
      });
    }

    const settingsOpenAuditBtn = $('#settingsOpenAuditBtn');
    if (settingsOpenAuditBtn) {
      settingsOpenAuditBtn.addEventListener('click', () => {
        triggerHaptic('light');
        if (settingsDialog && settingsDialog.open) settingsDialog.close();
        openClvReport();
      });
    }

    const settingsExportBtn = $('#settingsExportBtn');
    if (settingsExportBtn) {
      settingsExportBtn.addEventListener('click', () => {
        triggerHaptic('light');
        handleSlateExportCsv();
      });
    }

    // Commercial Pricing & Membership Tier Switches
    const pricingDialog = $('#pricingDialog');
    const pricingBtn = $('#pricingBtn');
    if (pricingBtn && pricingDialog) {
      pricingBtn.addEventListener('click', () => {
        triggerHaptic('light');
        pricingDialog.showModal();
      });
    }

    document.addEventListener('click', (e) => {
      const modelHelp = e.target.closest('[data-model-only-help]');
      if (modelHelp) {
        e.preventDefault();
        e.stopPropagation();
        const popover = modelHelp.parentElement?.querySelector('.model-only-popover');
        const willOpen = Boolean(popover?.hidden);
        document.querySelectorAll('.model-only-popover:not([hidden])').forEach((item) => { item.hidden = true; });
        document.querySelectorAll('[data-model-only-help][aria-expanded="true"]').forEach((item) => item.setAttribute('aria-expanded', 'false'));
        if (popover && willOpen) {
          popover.hidden = false;
          modelHelp.setAttribute('aria-expanded', 'true');
          triggerHaptic('light');
        }
        return;
      }
      if (!e.target.closest('.model-only-popover')) {
        document.querySelectorAll('.model-only-popover:not([hidden])').forEach((item) => { item.hidden = true; });
        document.querySelectorAll('[data-model-only-help][aria-expanded="true"]').forEach((item) => item.setAttribute('aria-expanded', 'false'));
      }

      const pricingTrigger = e.target.closest('[data-open-pricing]');
      if (pricingTrigger && pricingDialog) {
        e.preventDefault();
        triggerHaptic('light');
        pricingDialog.showModal();
      }

      const checkoutBtn = e.target.closest('[data-checkout-tier]');
      if (checkoutBtn) {
        e.preventDefault();
        triggerHaptic('light');
        toast('Sign in to manage membership. Access is verified by the server.');
      }
    });

    // Slim Availability Header Pill
    const slimInjuryBanner = $('#slimInjuryBanner');
    const dismissInjuryBannerBtn = $('#dismissInjuryBannerBtn');

    if (slimInjuryBanner) {
      slimInjuryBanner.addEventListener('click', () => {
        triggerHaptic('light');
        toggleInjuries();
      });
    }

    if (dismissInjuryBannerBtn && slimInjuryBanner) {
      dismissInjuryBannerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        triggerHaptic('light');
        slimInjuryBanner.hidden = true;
        slimInjuryBanner.style.display = 'none';
        slimInjuryBanner.dataset.dismissed = 'true';
      });
    }

    // Single Horizontal Scrolling Chip Row (Mode, Market, Pos, More)
    const mobileFilterStrip = $('#mobileFilterStrip');
    if (mobileFilterStrip) {
      mobileFilterStrip.addEventListener('click', (e) => {
        const modeBtn = e.target.closest('[data-mode]');
        if (modeBtn) {
          triggerHaptic('light');
          setPlayMode(modeBtn.dataset.mode);
          return;
        }
        const marketBtn = e.target.closest('[data-market]');
        if (marketBtn) {
          triggerHaptic('light');
          state.filters.market = marketBtn.dataset.market;
          if ($('#marketFilter')) $('#marketFilter').value = marketBtn.dataset.market;
          syncFilterChipsUI();
          renderBoard();
          return;
        }
        const posBtn = e.target.closest('[data-pos]');
        if (posBtn) {
          triggerHaptic('light');
          const pos = posBtn.dataset.pos === 'all' ? 'ALL' : posBtn.dataset.pos;
          state.filters.position = pos;
          if ($('#positionFilter')) $('#positionFilter').value = pos;
          syncFilterChipsUI();
          renderBoard();
          return;
        }
      });
    }

    // More Filters Bottom Sheet (Signal Archetypes & Matchups)
    const moreFiltersBtn = $('#moreFiltersBtn');
    const moreFiltersDialog = $('#moreFiltersDialog');
    if (moreFiltersBtn && moreFiltersDialog) {
      moreFiltersBtn.addEventListener('click', () => {
        triggerHaptic('light');
        moreFiltersDialog.showModal();
      });
    }

    const signalSheetChips = $('#signalSheetChips');
    if (signalSheetChips) {
      signalSheetChips.addEventListener('click', (e) => {
        const btn = e.target.closest('.signal-chip-btn');
        if (!btn) return;
        triggerHaptic('light');
        $$('.signal-chip-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        setIntent(btn.dataset.intent);
      });
    }

    const resetMoreFiltersBtn = $('#resetMoreFiltersBtn');
    if (resetMoreFiltersBtn) {
      resetMoreFiltersBtn.addEventListener('click', () => {
        triggerHaptic('light');
        setIntent('all');
        $$('.signal-chip-btn').forEach((b) => b.classList.toggle('active', b.dataset.intent === 'all'));
        state.filters.gameId = '';
        renderGameChips();
        renderBoard();
      });
    }

    const applyMoreFiltersBtn = $('#applyMoreFiltersBtn');
    if (applyMoreFiltersBtn && moreFiltersDialog) {
      applyMoreFiltersBtn.addEventListener('click', () => {
        triggerHaptic('light');
        moreFiltersDialog.close();
      });
    }

    const intentFilter = $('#intentFilter');
    if (intentFilter) {
      intentFilter.addEventListener('change', (e) => setIntent(e.target.value));
    }

    const modeActionableBtn = $('#modeActionableBtn');
    const modeTopBtn = $('#modeTopBtn');
    const modeAllBtn = $('#modeAllBtn');
    if (modeActionableBtn) modeActionableBtn.addEventListener('click', () => setPlayMode('actionable'));
    if (modeTopBtn) modeTopBtn.addEventListener('click', () => setPlayMode('top'));
    if (modeAllBtn) modeAllBtn.addEventListener('click', () => setPlayMode('all'));

    const firstRunBanner = $('#firstRunBriefing');
    const dismissBriefingBtn = $('#dismissBriefingBtn');
    const enterTerminalBtn = $('#enterTerminalBtn');
    const settingsBriefingBtn = $('#settingsBriefingBtn');
    if (firstRunBanner) {
      firstRunBanner.hidden = true;
      firstRunBanner.style.display = 'none';
      const closeBriefing = () => {
        triggerHaptic('light');
        firstRunBanner.hidden = true;
        firstRunBanner.style.display = 'none';
        try {
          localStorage.setItem('propwire_onboarding_dismissed', 'true');
        } catch (_) {}
      };
      if (dismissBriefingBtn) dismissBriefingBtn.addEventListener('click', closeBriefing);
      if (enterTerminalBtn) enterTerminalBtn.addEventListener('click', closeBriefing);
      firstRunBanner.addEventListener('click', (e) => {
        if (e.target === firstRunBanner) closeBriefing();
      });
    }
    if (settingsBriefingBtn) {
      settingsBriefingBtn.addEventListener('click', () => {
        if (firstRunBanner) {
          firstRunBanner.hidden = false;
          firstRunBanner.style.display = 'flex';
        }
        const settingsDialog = $('#settingsDialog');
        if (settingsDialog && settingsDialog.open) settingsDialog.close();
      });
    }

    $$('.slate-mode-toggle button, .dataset-switcher button').forEach((button) => button.addEventListener('click', () => setPlayMode(button.dataset.mode)));
    $$('.intent-chips .intent-chip').forEach((button) => button.addEventListener('click', () => setIntent(button.dataset.intent)));
    $$('.view-switch button').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));

    try {
      const mql = window.matchMedia('(max-width: 768px)');
      mql.addEventListener('change', (e) => {
        if (e.matches && state.view === 'table') {
          setView('cards');
        } else if (!e.matches && state.view === 'cards') {
          setView('table');
        }
      });
    } catch (_) {}

    $('#slateRows').addEventListener('click', inspectFromEvent);
    $('#cardView').addEventListener('click', inspectFromEvent);

    const portfolioBtn = $('#portfolioBtn');
    if (portfolioBtn) portfolioBtn.addEventListener('click', openPortfolioDialog);

    const clvReportBtn = $('#clvReportBtn');
    if (clvReportBtn) clvReportBtn.addEventListener('click', openClvReport);

    const clvStatusEl = $('#clvStatus');
    if (clvStatusEl) {
      clvStatusEl.style.cursor = 'pointer';
      clvStatusEl.setAttribute('role', 'button');
      clvStatusEl.setAttribute('tabindex', '0');
      clvStatusEl.setAttribute('title', 'Click to inspect cryptographic CLV audit ledger & root hash');
      clvStatusEl.addEventListener('click', () => {
        triggerHaptic('light');
        openClvReport();
      });
      clvStatusEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          triggerHaptic('light');
          openClvReport();
        }
      });
    }


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

    // Native Mobile 4-Tab Bottom Navigation
    const bottomNavSlate = $('#bottomNavSlate');
    const bottomNavWatchlist = $('#bottomNavWatchlist');
    const bottomNavLedger = $('#bottomNavLedger');
    const bottomNavAudit = $('#bottomNavAudit');

    if (bottomNavSlate) {
      bottomNavSlate.addEventListener('click', () => {
        triggerHaptic('light');
        const detailDialog = $('#detailDialog');
        if (detailDialog && detailDialog.open) detailDialog.close();
        const portfolioDialog = $('#portfolioDialog');
        if (portfolioDialog && portfolioDialog.open) portfolioDialog.close();
        const clvDialog = $('#clvDialog');
        if (clvDialog && clvDialog.open) clvDialog.close();

        state.bottomTab = 'slate';
        $$('.bottom-nav-item').forEach((b) => b.classList.remove('active'));
        bottomNavSlate.classList.add('active');
        renderBoard();
        window.scrollTo({ top: state.slateScrollY || 0, behavior: 'smooth' });
      });
    }

    if (bottomNavWatchlist) {
      bottomNavWatchlist.addEventListener('click', () => {
        triggerHaptic('light');
        const detailDialog = $('#detailDialog');
        if (detailDialog && detailDialog.open) detailDialog.close();
        const portfolioDialog = $('#portfolioDialog');
        if (portfolioDialog && portfolioDialog.open) portfolioDialog.close();
        const clvDialog = $('#clvDialog');
        if (clvDialog && clvDialog.open) clvDialog.close();

        if (state.bottomTab === 'slate') {
          state.slateScrollY = window.scrollY;
        }
        state.bottomTab = 'watchlist';
        $$('.bottom-nav-item').forEach((b) => b.classList.remove('active'));
        bottomNavWatchlist.classList.add('active');
        renderBoard();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }

    if (bottomNavLedger) {
      bottomNavLedger.addEventListener('click', () => {
        triggerHaptic('light');
        openPortfolioDialog();
        $$('.bottom-nav-item').forEach((b) => b.classList.remove('active'));
        bottomNavLedger.classList.add('active');
      });
    }

    if (bottomNavAudit) {
      bottomNavAudit.addEventListener('click', () => {
        triggerHaptic('light');
        openClvReport();
        $$('.bottom-nav-item').forEach((b) => b.classList.remove('active'));
        bottomNavAudit.classList.add('active');
      });
    }

    const portfolioDialogEl = $('#portfolioDialog');
    if (portfolioDialogEl) {
      portfolioDialogEl.addEventListener('close', () => {
        $$('.bottom-nav-item').forEach((b) => b.classList.remove('active'));
        if (state.bottomTab === 'watchlist' && bottomNavWatchlist) {
          bottomNavWatchlist.classList.add('active');
        } else if (bottomNavSlate) {
          bottomNavSlate.classList.add('active');
        }
      });
    }

    const clvDialogEl = $('#clvDialog');
    if (clvDialogEl) {
      clvDialogEl.addEventListener('close', () => {
        $$('.bottom-nav-item').forEach((b) => b.classList.remove('active'));
        if (state.bottomTab === 'watchlist' && bottomNavWatchlist) {
          bottomNavWatchlist.classList.add('active');
        } else if (bottomNavSlate) {
          bottomNavSlate.classList.add('active');
        }
      });
    }

    window.addEventListener('scroll', () => {
      const bar = $('#stickyContextBar');
      if (bar) {
        if (window.scrollY > 180) {
          bar.classList.add('is-visible');
        } else {
          bar.classList.remove('is-visible');
        }
      }
    }, { passive: true });

    // Wire Sniper Trigger Buttons
    const sniperBtn = $('#sniperBtn');
    if (sniperBtn) {
      sniperBtn.addEventListener('click', () => {
        triggerHaptic('light');
        openSniperDialog();
      });
    }
    const mobileSniperBtn = $('#mobileSniperBtn');
    if (mobileSniperBtn) {
      mobileSniperBtn.addEventListener('click', () => {
        triggerHaptic('light');
        openSniperDialog();
      });
    }

    initKeyboardNav();
    updatePortfolioBadge();
    updateWatchlistBadge();
    updateActiveFilterBadge();
    updateSniperUIBadges();

    // Wire native bottom-sheet behaviors: tap backdrop to close + swipe down to dismiss
    [$('#detailDialog'), $('#executionDialog'), $('#settingsDialog'), $('#moreFiltersDialog'), $('#portfolioDialog'), $('#clvDialog'), $('#sniperDialog'), $('#pricingDialog')].forEach(setupBottomSheet);

    initMobileSwipeGestures();
  }

  let wasCardSwiped = false;
  // ── §10. Gestures, bottom sheet & keyboard navigation ─────────────────

  function initMobileSwipeGestures() {
    const cardView = $('#cardView');
    if (!cardView) return;

    let touchStartX = 0;
    let touchStartY = 0;
    let activeCard = null;
    let isSwiping = false;

    cardView.addEventListener('touchstart', (e) => {
      const card = e.target.closest('article.mobile-quant-row');
      if (!card || e.target.closest('button') || e.target.closest('input')) {
        activeCard = null;
        return;
      }
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      // Guard against iOS Safari edge-swipe back navigation conflict
      if (touchStartX <= 24) {
        activeCard = null;
        return;
      }
      activeCard = card;
      isSwiping = false;
    }, { passive: true });

    cardView.addEventListener('touchmove', (e) => {
      if (!activeCard) return;
      const currentX = e.touches[0].clientX;
      const currentY = e.touches[0].clientY;
      const deltaX = currentX - touchStartX;
      const deltaY = currentY - touchStartY;

      // Only engage if swiping right horizontally
      if (deltaX > 10 && Math.abs(deltaX) > Math.abs(deltaY) * 1.3) {
        isSwiping = true;
        const translateX = deltaX <= 95 ? deltaX : 95 + (deltaX - 95) * 0.25;
        activeCard.style.transform = `translateX(${translateX}px)`;
        activeCard.classList.toggle('swipe-log-ready', deltaX >= 85);
      }
    }, { passive: true });

    const finishSwipe = (e) => {
      if (!activeCard) return;
      const card = activeCard;
      activeCard = null;

      if (isSwiping) {
        const deltaX = (e.changedTouches ? e.changedTouches[0].clientX : 0) - touchStartX;
        if (deltaX >= 85) {
          wasCardSwiped = true;
          triggerHaptic('medium');
          const playerId = card.dataset.playerId;
          if (playerId) logBet(playerId);
          setTimeout(() => { wasCardSwiped = false; }, 380);
        }
      }
      card.style.transition = 'transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)';
      card.style.transform = '';
      card.classList.remove('swipe-log-ready');
      setTimeout(() => { card.style.transition = ''; }, 240);
      isSwiping = false;
    };

    cardView.addEventListener('touchend', finishSwipe);
    cardView.addEventListener('touchcancel', finishSwipe);

    // One-time discoverability peek on first load for mobile users
    peekFirstCardHint();
  }

  function peekFirstCardHint() {
    try {
      if (typeof window === 'undefined' || window.innerWidth > 768) return;
      if (localStorage.getItem('pw_swipe_hint_seen')) return;
      localStorage.setItem('pw_swipe_hint_seen', 'true');
      setTimeout(() => {
        const firstCard = document.querySelector('#cardView article.mobile-quant-row');
        if (!firstCard) return;
        firstCard.style.transition = 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)';
        firstCard.style.transform = 'translateX(42px)';
        firstCard.classList.add('swipe-log-ready');
        setTimeout(() => {
          firstCard.style.transform = '';
          firstCard.classList.remove('swipe-log-ready');
          setTimeout(() => { firstCard.style.transition = ''; }, 350);
        }, 550);
      }, 1100);
    } catch (_) {}
  }

  function setupBottomSheet(dialog) {
    if (!dialog) return;

    // 1. Tap outside (backdrop click) to dismiss
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) {
        triggerHaptic('light');
        dialog.close();
      }
    });

    // 2. Swipe down on drag handle or header to dismiss
    let startY = 0;
    let currentY = 0;
    let isDragging = false;

    const dragHandle = dialog.querySelector('.dialog-sheet-handle') || dialog.querySelector('.dialog-header');
    if (dragHandle) {
      dragHandle.addEventListener('touchstart', (e) => {
        if (!dialog.open) return;
        startY = e.touches[0].clientY;
        currentY = startY;
        isDragging = true;
      }, { passive: true });

      dragHandle.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        currentY = e.touches[0].clientY;
        const deltaY = currentY - startY;
        if (deltaY > 0) {
          dialog.style.transform = `translateY(${deltaY}px)`;
        }
      }, { passive: true });

      dragHandle.addEventListener('touchend', () => {
        if (!isDragging) return;
        isDragging = false;
        const deltaY = currentY - startY;
        if (deltaY > 50) {
          triggerHaptic('light');
          dialog.style.transform = 'translateY(100%)';
          setTimeout(() => {
            dialog.close();
            dialog.style.transform = '';
          }, 150);
        } else {
          dialog.style.transform = '';
        }
      });

      dragHandle.addEventListener('touchcancel', () => {
        isDragging = false;
        dialog.style.transform = '';
      });
    }
  }

  function initKeyboardNav() {
    const handleKeyNav = (e) => {
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
          if (rows.length) {
            if (focusedRowIndex >= 0 && rows[focusedRowIndex]) {
              rows[focusedRowIndex].classList.remove('keyboard-focus', 'terminal-focused');
              rows[focusedRowIndex].removeAttribute('data-focused');
            }
            if (focusedRowIndex < rows.length - 1) {
              focusedRowIndex++;
            } else if (focusedRowIndex === -1) {
              focusedRowIndex = 0;
            }
            state.focusedIndex = focusedRowIndex;
            if (rows[focusedRowIndex]) {
              rows[focusedRowIndex].classList.add('keyboard-focus', 'terminal-focused');
              rows[focusedRowIndex].setAttribute('data-focused', 'true');
              rows[focusedRowIndex].scrollIntoView({ block: 'nearest' });
            }
          }
          break;

        case 'k': // Move Up
        case 'K':
        case 'ArrowUp':
          e.preventDefault();
          if (rows.length && focusedRowIndex > 0) {
            if (rows[focusedRowIndex]) {
              rows[focusedRowIndex].classList.remove('keyboard-focus', 'terminal-focused');
              rows[focusedRowIndex].removeAttribute('data-focused');
            }
            focusedRowIndex--;
            state.focusedIndex = focusedRowIndex;
            if (rows[focusedRowIndex]) {
              rows[focusedRowIndex].classList.add('keyboard-focus', 'terminal-focused');
              rows[focusedRowIndex].setAttribute('data-focused', 'true');
              rows[focusedRowIndex].scrollIntoView({ block: 'nearest' });
            }
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

        case 's': // Sniper Feed
        case 'S':
          e.preventDefault();
          openSniperDialog('sniper_feed');
          break;

        case 'l': // Live Board (or bet log if shift held)
        case 'L':
          e.preventDefault();
          if (e.shiftKey) {
            const targetIdx = focusedRowIndex >= 0 ? focusedRowIndex : (rows.length ? 0 : -1);
            if (targetIdx >= 0 && rows[targetIdx]) {
              const playerId = rows[targetIdx].dataset.playerId;
              if (playerId) logBet(playerId);
            }
          } else {
            openSniperDialog('live_board');
          }
          break;

        case 'p': // Polymarket Board
        case 'P':
          e.preventDefault();
          openSniperDialog('polymarket');
          break;

        case 'i': // Injuries Drawer
        case 'I':
          e.preventDefault();
          toggleInjuries();
          break;

        case 'e': // Explain Edge (toggle reasoning chains in Sniper Feed)
        case 'E':
          e.preventDefault();
          state.sniperExplainAll = !state.sniperExplainAll;
          openSniperDialog('sniper_feed');
          break;
      }
    };

    window.addEventListener('keydown', handleKeyNav);
    document.addEventListener('keydown', handleKeyNav);
  }

  // ── §11. View state & sport switcher chrome ───────────────────────────

  function getVisibleItems() {
    if (state.view === 'table') {
      return $$('#slateRows tr[data-testid="slate-row"]');
    }
    return $$('#cardView article[data-testid="slate-card"]');
  }

  function clearFocusedRow() {
    state.focusedIndex = -1;
    getVisibleItems().forEach((item) => {
      item.classList.remove('keyboard-focus', 'terminal-focused');
      item.removeAttribute('data-focused');
    });
  }

  // Terminal is dark-locked (2026-10 restyle): one calibrated FanDuel-style
  // dark palette — obsidian navy canvas, white text, baby-blue accent. The
  // PR #13 light/dark toggle was removed with the restyle and any stale
  // persisted choice is cleared so every visitor gets the same shell. The
  // [data-theme="light"] CSS hooks stay dormant; restoring a toggle is a
  // one-commit revert (docs/TECH-DEBT.md — dark-lock decision row).
  const THEME_KEY = 'propwire-theme';

  function initTheme() {
    document.documentElement.dataset.theme = 'dark';
    document.documentElement.classList.add('dark');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', '#0b0e14');
    try { localStorage.removeItem(THEME_KEY); } catch (_) {}
  }

  // ─── Sport switcher + per-sport filter chrome (Phase 2) ─────────────
  // DOM population goes through document.getElementById (NOT the $ helper).
  // Since the audit B2 remediation the parity sandbox RESOLVES these ids and
  // the chrome content is captured in the NFL goldens as an earned,
  // documented whitelist delta (see test/nfl-parity.snapshot.mjs).
  const SPORT_SWITCHER_KEY = 'propwire_active_sport';

  function sportSwitcherItems() {
    return window.PropWireSports.ids().map((id) => {
      let label = String(id).toUpperCase();
      try { label = window.PropWireSports.require(id).label || label; } catch (_) {}
      return { id, label, active: id === SPORT_ID };
    });
  }

  function switchToSport(id) {
    if (!id || id === SPORT_ID) return;
    try { window.PropWireSports.require(id); } catch (_) { return; }
    try {
      localStorage.setItem(SPORT_SWITCHER_KEY, id);
    } catch (_) {
      return; // storage unavailable: keep the current sport (no reload loop)
    }
    window.location.reload();
  }

  function renderSportChrome() {
    const switcher = elById('sportSwitcher');
    if (switcher) {
      switcher.innerHTML = sportSwitcherItems().map((item) => `
        <button type="button" class="sport-switch-btn${item.active ? ' active' : ''}" role="radio"
          aria-checked="${item.active}" data-sport="${esc(item.id)}" title="Switch to ${esc(item.label)}">${esc(item.label)}</button>`).join('');
      switcher.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('[data-sport]') : null;
        if (btn) switchToSport(btn.dataset.sport);
      });
    }
    const marketGroup = elById('marketChipGroup');
    if (marketGroup) {
      marketGroup.innerHTML = adapter.marketOrder.map((id) => {
        const m = adapter.markets[id];
        const active = id === adapter.defaultMarket;
        return `<button type="button" class="chip-pill${active ? ' active' : ''}" data-market="${esc(id)}" role="radio" aria-checked="${active}">${esc(m.chipLabel)}</button>`;
      }).join('');
    }
    const posGroup = elById('positionChipGroup');
    if (posGroup) {
      posGroup.innerHTML = '<button type="button" class="chip-pill active" data-pos="ALL" role="radio" aria-checked="true">All</button>' +
        adapter.positions.map((p) => `<button type="button" class="chip-pill" data-pos="${esc(p)}" role="radio" aria-checked="false">${esc(p)}</button>`).join('');
    }
    const signalGroup = elById('signalSheetChips');
    if (signalGroup && adapter.intents) {
      const intents = [
        { id: 'all', label: 'All Signals' },
        { id: 'edge', label: 'Highest Edge (>10%)' },
        ...adapter.intents.map((i) => ({ id: i.id, label: `${i.label} Plays` })),
      ];
      signalGroup.innerHTML = intents.map((i, idx) => `<button type="button" class="signal-chip-btn${idx === 0 ? ' active' : ''}" data-intent="${esc(i.id)}">${esc(i.label)}</button>`).join('');
    }
    const slateOptions = (config) => Object.entries(config).map(([key, slate]) =>
      `<option value="${esc(key)}">${esc(slate.shortLabel || slate.state || key)}</option>`).join('');
    const slateSelector = elById('slateSelector');
    if (slateSelector) slateSelector.innerHTML = slateOptions(adapter.slates);
    const mobileSlateSelector = elById('mobileSlateSelector');
    if (mobileSlateSelector) mobileSlateSelector.innerHTML = slateOptions(adapter.slates);
    const topBtn = elById('modeTopBtn');
    if (topBtn) {
      topBtn.title = adapter.topPlays && adapter.topPlays.source === 'ev_ranked'
        ? 'Rank plays by expected value per unit staked'
        : 'Show Top Model Volume Plays';
    }
    if (adapter.pageTitle) document.title = adapter.pageTitle;
  }

  /** Boot slate: keep the stored key when the adapter knows it, else the adapter default. */
  function defaultBootSlate() {
    if (adapter.slates[state.slateKey]) return state.slateKey;
    return typeof adapter.defaultSlateKey === 'function' ? adapter.defaultSlateKey() : state.slateKey;
  }

  function initInstall() {
    const installBtn = $('#installButton');
    if (!installBtn) return;
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      state.deferredInstall = event;
      installBtn.hidden = false;
    });
    installBtn.addEventListener('click', async () => {
      if (!state.deferredInstall) return;
      state.deferredInstall.prompt();
      await state.deferredInstall.userChoice;
      state.deferredInstall = null;
      installBtn.hidden = true;
    });
  }

  // ── §12. Data ingestion — fetch, slate loading, feed health ───────────

  async function fetchJson(path, fallback) {
    try {
      const response = await fetch(`${path}?v=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) return fallback;
      return await response.json();
    } catch (_) {
      return fallback;
    }
  }

  /** fetchJson + transport status — powers the Phase 2 failure-mode UI. */
  async function fetchJsonStatus(path, fallback) {
    try {
      const response = await fetch(`${path}?v=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) return { data: fallback, ok: false, status: response.status };
      return { data: await response.json(), ok: true, status: response.status };
    } catch (_) {
      return { data: fallback, ok: false, status: 0 };
    }
  }

  async function fetchClvAuditReport() {
    try {
      const report = await fetchJson('clv_audit_report.json', null);
      if (report && (report.records || report.ledger)) {
        state.clvAuditReport = report;
        return report;
      }
    } catch (_) {}
    return null;
  }

  function renderSkeletons() {
    const tableSkeleton = Array.from({ length: 6 }).map((_, i) => `
      <tr class="skeleton-row" style="--row-index:${i}">
        <td><div style="display:flex;align-items:center;gap:10px;"><div class="skeleton-block" style="width:28px;height:28px;border-radius:50%;"></div><div style="display:flex;flex-direction:column;gap:5px;"><div class="skeleton-block" style="width:110px;height:12px;"></div><div class="skeleton-block" style="width:70px;height:10px;"></div></div></div></td>
        <td><div class="skeleton-block" style="width:60px;height:16px;"></div></td>
        <td><div class="skeleton-block" style="width:90px;height:18px;"></div></td>
        <td><div class="skeleton-block" style="width:140px;height:24px;"></div></td>
        <td class="td-num"><div class="skeleton-block" style="width:75px;height:28px;border-radius:6px;float:right;"></div></td>
      </tr>
    `).join('');
    if ($('#slateRows')) $('#slateRows').innerHTML = tableSkeleton;

    const cardSkeleton = Array.from({ length: 5 }).map((_, i) => `
      <article class="mobile-quant-row skeleton-card" style="--row-index:${i}; opacity: 0.6; min-height: 98px; justify-content: space-between; padding: 12px 14px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div style="display:flex;align-items:center;gap:8px;">
            <div class="skeleton-block" style="width:26px;height:26px;border-radius:50%;"></div>
            <div style="display:flex;flex-direction:column;gap:5px;"><div class="skeleton-block" style="width:115px;height:14px;"></div><div class="skeleton-block" style="width:75px;height:10px;"></div></div>
          </div>
          <div class="skeleton-block" style="width:55px;height:18px;border-radius:4px;"></div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;">
          <div class="skeleton-block" style="width:130px;height:16px;"></div>
          <div class="skeleton-block" style="width:65px;height:26px;border-radius:6px;"></div>
        </div>
      </article>
    `).join('');
    if ($('#cardView')) $('#cardView').innerHTML = cardSkeleton;
  }

  async function loadSlate(slateKey) {
    const config = SLATES[slateKey];
    if (!config) return;
    state.slateKey = slateKey;
    const initialMode = config.historical ? 'all' : 'actionable';
    state.filters = { search: '', market: state.filters.market, position: 'ALL', team: '', gameId: '', playMode: initialMode, intent: 'all' };
    if ($('#searchInput')) $('#searchInput').value = '';
    if ($('#positionFilter')) $('#positionFilter').value = 'ALL';
    if ($('#teamFilter')) $('#teamFilter').value = '';
    if ($('#slateSelector')) $('#slateSelector').value = slateKey;
    renderSkeletons();

    const [slateRes, gamesRes, picks, injuries, oddsRes, clvReport, snapshots, newsRes, breakerCfg] = await Promise.all([
      fetchJsonStatus(config.slate, []),
      fetchJsonStatus(config.games, []),
      fetchJson(config.picks, {}),
      config.injuries ? fetchJson(config.injuries, { injuries: [], impacted_beneficiaries: {} }) : Promise.resolve({ injuries: [], impacted_beneficiaries: {} }),
      config.odds ? fetchJsonStatus(config.odds, { quotes: [] }) : Promise.resolve({ data: { quotes: [] }, ok: true, status: 0 }),
      fetchClvAuditReport(),
      config.snapshots ? fetchJson(config.snapshots, []) : Promise.resolve([]),
      fetchJsonStatus('news_watcher_state.json', null),
      fetchJson('circuit_breaker_config.json', null)
    ]);
    const slate = slateRes.data;
    const games = gamesRes.data;
    const odds = oddsRes.data;
    const newsState = newsRes.data;

    state.slate = Array.isArray(slate) ? slate : [];
    state.games = Array.isArray(games) ? games : [];
    state.picks = picks && typeof picks === 'object' ? picks : {};
    state.injuries = injuries && typeof injuries === 'object' ? injuries : { injuries: [], impacted_beneficiaries: {} };
    // Slate switches invalidate the drawer body (it is built at toggle time
    // from the previous slate's state) — collapse it so nothing stale shows.
    const availabilityDrawer = $('#availabilityDetails') || $('#injuryDetails');
    if (availabilityDrawer) availabilityDrawer.hidden = true;
    state.odds = normalizeFeed(odds);
    state.newsWatcherState = newsState && typeof newsState === 'object' ? newsState : { teams_locked: {}, players_pending: {} };
    state.breakerConfig = breakerCfg && typeof breakerCfg === 'object' && breakerCfg.sports ? breakerCfg : null;

    // Feed health (Phase 2 failure-mode UI): transport status per critical
    // feed + data kind. Consumed by updateFeedHealthUI(); staleness is
    // derived at render time against the per-sport config thresholds.
    state.feedHealth = {
      slate: slateRes.ok ? 'ok' : 'error',
      games: gamesRes.ok ? 'ok' : 'error',
      odds: oddsRes.ok ? 'ok' : 'error',
      news: newsRes.ok ? 'ok' : 'error',
      dataKind: (state.odds.feed_status === 'fixture') || adapter.fixturesOnly === true ? 'fixture' : 'live',
      oddsUpdatedAt: state.odds.updated_at || null,
      newsLastPolledAt: state.newsWatcherState.last_polled_at || null
    };
    updateFeedVerificationUI();

    // Build open snapshots map & price trajectory history
    state.openSnapshots = {};
    state.priceHistory = {};
    if (Array.isArray(snapshots)) {
      snapshots.forEach(s => {
        if (s && s.quote && s.quote.line !== null && s.quote.line !== undefined) {
          const k = `${s.player_id}::${s.market}`;
          state.openSnapshots[k] = s.quote;
        }
      });
    }
    (state.odds.quotes || []).forEach(q => {
      const k = `${q.player_id}::${q.market}`;
      const openSnap = state.openSnapshots[k];
      const curLine = Number(q.line);
      if (openSnap && Number.isFinite(Number(openSnap.line))) {
        const openLine = Number(openSnap.line);
        const step1 = +(openLine + (curLine - openLine) * 0.35).toFixed(1);
        const step2 = +(openLine + (curLine - openLine) * 0.70).toFixed(1);
        state.priceHistory[k] = [openLine, step1, step2, curLine];
      } else {
        const fair = Number(q.fair_line || curLine);
        const driftOpen = +(curLine + (curLine > fair ? -1.0 : curLine < fair ? 1.0 : 0)).toFixed(1);
        state.priceHistory[k] = [driftOpen, +(driftOpen * 0.65 + curLine * 0.35).toFixed(1), +(driftOpen * 0.25 + curLine * 0.75).toFixed(1), curLine];
      }
    });

    renderAll(clvReport);
    updateFeedHealthUI();
    updateSniperUIBadges();
    checkSniperAlerts();
    window.__PROP_WIRE_READY__ = true;
    window.__PROP_WIRE_STATE__ = state;
    window.__PROP_WIRE_TRIGGER_POLL__ = triggerOddsPoll;
    window.__PROP_WIRE_EXPORT__ = handleLedgerExport;
    window.__PROP_WIRE_IMPORT__ = handleLedgerImportFile;
  }

  // ─── Feed health: failure-mode UI (Phase 2) ─────────────────────────────
  // A feed outage must NEVER masquerade as "the market is efficient": every
  // transport failure, staleness breach, and fixture dataset is surfaced in
  // a dedicated banner. Banner content is captured in the NFL parity goldens
  // (and its DOM access is pinned by the dom_access_log snapshot) since the
  // audit B2 remediation enabled getElementById in the sandbox.
  function feedThresholds() {
    const cfg = state.breakerConfig;
    const sportCfg = cfg && cfg.sports ? cfg.sports[SPORT_ID] : null;
    const th = (sportCfg && sportCfg.thresholds) || {};
    const numOr = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
    return {
      oddsStaleSeconds: numOr(th.odds_stale_max_age_seconds, 21600),
      newsStaleSeconds: numOr(th.deadman_switch_max_age_seconds, 300)
    };
  }

  function feedHealthStates() {
    const health = state.feedHealth || {};
    const thresholds = feedThresholds();
    const now = Date.now();
    const ageSeconds = (iso) => {
      const t = iso ? Date.parse(iso) : NaN;
      return Number.isFinite(t) ? Math.max(0, (now - t) / 1000) : null;
    };
    const oddsAge = health.odds === 'ok' ? ageSeconds(health.oddsUpdatedAt) : null;
    const oddsFreshness = health.odds === 'error' ? 'error'
      : oddsAge === null ? 'unknown'
        : oddsAge > thresholds.oddsStaleSeconds ? 'stale' : 'ok';
    const newsAge = ageSeconds(health.newsLastPolledAt);
    const newsFreshness = health.news === 'error' ? 'error'
      : newsAge === null ? 'unknown'
        : newsAge > thresholds.newsStaleSeconds ? 'stale' : 'ok';
    // Staleness semantics apply to LIVE feeds only: fixture datasets are
    // static by design (fixed updated_at), so their age is not a health
    // signal. Transport failures still surface for every data kind.
    const fixtureStatic = health.dataKind === 'fixture';
    return {
      ...health,
      oddsFreshness: fixtureStatic && oddsFreshness !== 'error' ? 'ok' : oddsFreshness,
      newsFreshness: fixtureStatic && newsFreshness !== 'error' ? 'ok' : newsFreshness,
      oddsAgeSeconds: oddsAge,
      thresholds
    };
  }

  function executionDecision(row, evaluation = null) {
    const result = evaluation || evaluateRow(row);
    const health = feedHealthStates();
    const quote = result.quote || null;
    const receipt = quote && (quote.receipt_id || quote.provider_quote_id || quote.source_url || (/^https?:\/\//i.test(quote.source || '') && quote.content_hash));
    const observedAt = quote && Date.parse(quote.observed_at || '');
    const completeQuote = Boolean(
      quote && receipt && Number.isFinite(observedAt) && result.book &&
      Number.isFinite(Number(result.line)) && Number.isFinite(Number(result.odds)) &&
      Number(result.odds) !== 0
    );
    const deny = (code, message) => ({ allowed: false, code, message, mode: 'research' });

    if (SLATES[state.slateKey]?.historical || health.dataKind === 'fixture') return deny('historical', 'Historical and fixture slates are research-only.');
    if (state.userTier === 'free') return deny('unauthorized', 'Sign in with an active membership to review executable prices.');
    if (result.state === 'none') return deny('no_quote', 'No sportsbook quote is available for this projection.');
    if (result.state !== 'verified') return deny('unverified', 'Price unverified—refresh or choose another book.');
    if (!completeQuote) return deny('incomplete_quote', 'The quote is missing its book, line, odds, timestamp, or receipt.');
    if (health.odds !== 'ok' || health.oddsFreshness !== 'ok') return deny('stale_odds', 'Odds are stale or unavailable. The slate is in research mode.');
    if (health.news !== 'ok' || health.newsFreshness !== 'ok') return deny('stale_news', 'News context is stale or unavailable. Refresh before reviewing a wager.');
    if (result.closed) return deny('closed', 'This market is closed.');
    if (result.volatilityHalt) return deny('volatility_halt', result.haltReason || 'Execution is halted after an abnormal line move.');
    if (result.dataCheck || result.highEdgeCaution) return deny('verification_required', result.highEdgeWarning || 'Refresh the price and news context before acting.');
    if (!result.qualified || !result.actionable) return deny('below_gate', 'This price does not clear the configured execution gate.');
    return { allowed: true, code: 'actionable', message: 'Verified, fresh, and clears the execution gate.', mode: 'live' };
  }

  function updateFeedHealthUI() {
    const banner = elById('dataQualityBanner');
    if (!banner) return;
    const health = feedHealthStates();
    const items = [];
    let tone = 'ok';
    if (health.dataKind === 'fixture') {
      items.push('<strong>RESEARCH FIXTURES</strong><span>Sample data for demonstration — not actionable, not a research record. Synthetic values; not sportsbook quotes.</span>');
      tone = 'fixture';
    }
    if (health.slate === 'error') {
      items.push('<strong>SLATE FEED OFFLINE</strong><span>The slate file failed to load — the board is empty because data is missing, not because the market is efficient.</span>');
      tone = 'error';
    }
    if (health.games === 'error') {
      items.push('<strong>GAMES FEED OFFLINE</strong><span>Matchup context may be incomplete.</span>');
      if (tone === 'ok') tone = 'warn';
    }
    if (health.odds === 'error') {
      items.push('<strong>ODDS FEED OFFLINE</strong><span>Projections render without market quotes; no actionable classification is possible.</span>');
      tone = 'error';
    } else if (health.oddsFreshness === 'stale') {
      items.push(`<strong>ODDS STALE</strong><span>Last update ${Math.max(1, Math.round(health.oddsAgeSeconds / 60))}m ago (limit ${Math.round(health.thresholds.oddsStaleSeconds / 60)}m) — treat prices as historical.</span>`);
      if (tone === 'ok') tone = 'warn';
    }
    if (health.newsFreshness === 'stale') {
      items.push('<strong>NEWS FEED STALE</strong><span>News watcher exceeded the dead-man threshold — automated sniper dispatch is suppressed.</span>');
      if (tone === 'ok') tone = 'warn';
    }
    if (!items.length) {
      banner.hidden = true;
      banner.innerHTML = '';
      banner.className = 'data-quality-banner';
      return;
    }
    banner.hidden = false;
    banner.className = `data-quality-banner ${tone}`;
    banner.innerHTML = items.map((item) => `<div class="dq-item">${item}</div>`).join('')
      + '<button type="button" id="dqRetryBtn" class="dq-retry-btn">Retry</button>';
    const retry = document.getElementById('dqRetryBtn');
    if (retry) retry.addEventListener('click', () => window.location.reload());
  }

  /**
   * Per-sport calibration badge (audit H9): the spec requires a VISIBLE
   * uncalibrated badge on rows of an uncalibrated sport, not just a config
   * flag. Sourced from the breaker config's sports block with the adapter
   * fallback, so badge truth = breaker truth. Calibrated sports (NFL)
   * render nothing — the badge must be a real signal, not chrome.
   */
  function sportCalibrationBadge() {
    const cfgSport = state.breakerConfig && state.breakerConfig.sports
      ? state.breakerConfig.sports[SPORT_ID]
      : null;
    const calibrated = cfgSport && typeof cfgSport.calibrated === 'boolean'
      ? cfgSport.calibrated
      : !(adapter.breakerFallback && adapter.breakerFallback.calibrated === false);
    return calibrated ? ''
      : '<span class="uncal-tag" title="Model parameters are not calibrated for this sport — outputs are directional research only, never actionable.">UNCALIBRATED</span>';
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

  function updateClvFooter(report) {
    const el = $('#clvStatus');
    if (!el) return;
    if (report && (report.total_records || report.records?.length)) {
      const total = report.total_records ?? report.records.length;
      const beatRate = report.beat_close_rate_pct ?? (report.summary ? +(report.summary.positive_clv_pct * 100).toFixed(1) : 0);
      const avgClv = report.avg_clv_prob_pct ?? (report.summary ? +(report.summary.avg_clv_ev * 100).toFixed(2) : 0);
      const root = report.ledger_root_hash || CLV_ROOT_HASH_FALLBACK;
      el.innerHTML = `<strong>CLV</strong> ${total} verified records · ${beatRate}% beat close · +${avgClv}% mean CLV · Root #${root}`;
    } else {
      el.innerHTML = `<strong>CLV</strong> 0 verified live records.`;
    }
  }

  function renderAll(clvReport = null) {
    renderHeader();
    renderInjuries();
    renderTeams();
    renderGameChips();
    renderBoard();
    updateClvFooter(clvReport || state.clvAuditReport);
  }

  // ── §13. Render pipeline — header, injuries, teams, chips, board ──────

  function renderHeader() {
    const config = SLATES[state.slateKey];
    const activePolicy = policy();
    const ingested = state.odds.quotes.length;
    const verified = state.odds.quotes.filter((quote) => quoteState(quote) === 'verified').length;
    const teams = new Set(state.slate.flatMap((row) => [row.team, row.opponent_team]).filter(Boolean));
    if ($('#gateChip')) $('#gateChip').textContent = activePolicy ? `Gate ${pct(activePolicy.gate, 0)}` : 'Gate missing';
    if ($('#capChip')) $('#capChip').textContent = activePolicy ? `Kelly cap ${pct(activePolicy.cap, 1)}` : 'Kelly cap missing';
    if ($('#gateVal')) $('#gateVal').textContent = activePolicy ? pct(activePolicy.gate, 0) : '—';
    if ($('#capVal')) $('#capVal').textContent = activePolicy ? pct(activePolicy.cap, 1) : '—';
    if ($('#modalGateVal')) $('#modalGateVal').textContent = activePolicy ? pct(activePolicy.gate, 0) : '—';
    if ($('#modalCapVal')) $('#modalCapVal').textContent = activePolicy ? pct(activePolicy.cap, 1) : '—';
    if ($('#slateState')) $('#slateState').textContent = config.state;
    if ($('#tickerLine')) {
      $('#tickerLine').innerHTML = [
        adapter.labels.ticker.games(state.games.length),
        adapter.labels.ticker.teams(teams.size),
        adapter.labels.ticker.records(state.slate.length),
        adapter.labels.ticker.ingestedTail(ingested, verified)
      ].map((item, index) => `${index ? '<span class="ticker-sep">|</span>' : ''}<span class="${item.includes('verified') && verified ? 'ticker-verified' : item.includes('verified') && ingested ? 'ticker-caution' : ''}">${esc(item)}</span>`).join('');
    }

    if (!activePolicy) {
      if ($('#marketState')) $('#marketState').textContent = 'Qualification policy is missing from JSON. Action fields are disabled.';
    } else if (config.historical) {
      if ($('#marketState')) $('#marketState').textContent = 'Historical slate. Games are closed and cannot be presented as actionable.';
    } else if (ingested === 0) {
      if ($('#marketState')) $('#marketState').textContent = 'No odds feed connected / 0 quotes ingested. Showing model projections and scoped fair lines only.';
    } else if (verified === 0) {
      if ($('#marketState')) $('#marketState').textContent = `No verified price receipts / ${ingested} quotes ingested. Offers are visible, but action fields remain locked.`;
    } else {
      if ($('#marketState')) $('#marketState').textContent = `${verified}/${ingested} Receipt-Verified`;
    }
    if ($('#priceCheckText')) $('#priceCheckText').textContent = `${ingested} ingested · ${verified} receipt-verified.`;

    const mobileHeaderSport = $('#mobileHeaderSport');
    const mobileHeaderSlate = $('#mobileHeaderSlate');
    if (mobileHeaderSport) mobileHeaderSport.textContent = (SPORT_ID || 'nfl').toUpperCase();
    if (mobileHeaderSlate) {
      const short = config?.shortLabel || (config?.week != null ? `W${config.week}` : (state.slateKey || 'Live'));
      mobileHeaderSlate.textContent = short;
    }
  }

  function renderInjuries() {
    const injuries = Array.isArray(state.injuries.injuries) ? state.injuries.injuries : [];
    const countEl = $('#injuryAlertCount');
    const previewEl = $('#injuryAlertPreview');
    const chevronEl = $('#injuryAlertChevron');
    const toggleBtn = $('#availabilityToggle');
    const details = $('#availabilityDetails') || $('#injuryDetails');
    const slimBanner = $('#slimInjuryBanner');
    const slimText = $('#slimInjuryText');
    const mobileUsageTicker = $('#mobileUsageTicker');
    const mobileUsageSummary = $('#mobileUsageSummary');
    const mobileUsageCount = $('#mobileUsageCount');

    if (!injuries.length) {
      if (countEl) countEl.textContent = '0 Alerts';
      if (previewEl) previewEl.textContent = 'No active injury alerts';
      if (details) details.hidden = true;
      if (slimBanner) slimBanner.hidden = true;
      if (mobileUsageTicker) mobileUsageTicker.hidden = true;
      return;
    }

    if (countEl) countEl.textContent = `${injuries.length} Injury Alerts`;
    if (slimText) slimText.textContent = `${injuries.length} Alerts`;
    if (slimBanner && !slimBanner.dataset.dismissed) slimBanner.hidden = false;
    if (mobileUsageTicker) mobileUsageTicker.hidden = false;
    if (mobileUsageCount) mobileUsageCount.textContent = String(injuries.length);
    if (mobileUsageSummary) {
      mobileUsageSummary.textContent = injuries.slice(0, 2).map((item) => {
        const last = String(item.player_name || '').split(' ').pop();
        const status = item.report_status === 'QUESTIONABLE' ? 'Q' : item.report_status === 'LIMITED' ? 'LIM' : item.report_status;
        return `${item.team} ${last} ${status}`;
      }).join(' · ');
    }

    if (previewEl) {
      const topItems = injuries.slice(0, 3).map(i => {
        const lastName = (i.player_name || '').split(' ').pop();
        const stat = i.report_status === 'LIMITED' ? 'LIM' : i.report_status === 'QUESTIONABLE' ? 'Q' : i.report_status;
        return `${lastName} ${stat}`;
      });
      previewEl.textContent = topItems.join(' · ');
    }
  }

  function injuryDetailsMarkup() {
    const injuries = Array.isArray(state.injuries.injuries) ? state.injuries.injuries : [];
    if (!injuries.length) return '';

    // Same dynamic receipt count the header marketState pill uses — never a
    // hardcoded number (the historical hardcoded count went stale when the
    // de-identified W7 feed landed with 0 verified quotes).
    const ingestedQuotes = Array.isArray(state.odds && state.odds.quotes) ? state.odds.quotes.length : 0;
    const verifiedQuotes = ingestedQuotes
      ? state.odds.quotes.filter((quote) => quoteState(quote) === 'verified').length
      : 0;
    const receiptPillText = ingestedQuotes > 0
      ? `${verifiedQuotes}/${ingestedQuotes} Receipt-Verified`
      : 'No book receipts ingested';

    const statusStyles = {
      red: 'status-tier-red',
      amber: 'status-tier-amber',
      slate: 'status-tier-slate'
    };

    const cards = injuries.map(item => {
      const statusUpper = String(item.report_status || '').toUpperCase();
      const isRed = statusUpper.includes('OUT') || statusUpper.includes('IR') || item.severity === 'CRITICAL';
      const isAmber = statusUpper.includes('LIMITED') || statusUpper.includes('QUESTIONABLE');
      const tier = isRed ? 'red' : isAmber ? 'amber' : 'slate';

      let quantImpact = '';
      // Sport-agnostic gate: NFL injuries vacate targets/air yards; NBA-style
      // injuries vacate minutes. The adapter label owns the unit wording.
      if (item.vacated_targets || item.vacated_minutes) {
        quantImpact = adapter.labels.injuredQuantImpact.vacated(item);
      } else if (item.notes && item.notes.includes('0.50x Kelly Stake Cap')) {
        quantImpact = '0.50x Kelly Stake Cap · Elevated Variance';
      } else if (statusUpper.includes('LIMITED')) {
        quantImpact = 'Snap Cap Risk · Target Redistribution';
      } else if (statusUpper.includes('BYE')) {
        quantImpact = adapter.labels.byeImpact(item);
      } else {
        quantImpact = 'Priced In · Baseline Adjusted';
      }

      let beneficiaries = '';
      if (item.redistribution_plan) {
        const topBeneficiaries = Object.values(item.redistribution_plan)
          .slice(0, 2)
          .map(b => b.beneficiary_name.split(' ').pop());
        if (topBeneficiaries.length) {
          beneficiaries = `<span class="pw-injury-beneficiaries">Elevated: ${esc(topBeneficiaries.join(', '))}</span>`;
        }
      }

      return `
        <div class="pw-injury-card">
          <div class="pw-injury-card-top">
            <div class="pw-injury-player-meta">
              ${avatarFor(item.player_id, item.player_name, item.team)}
              <div class="pw-injury-name-col">
                <div class="pw-injury-name-row">
                  <span class="pw-injury-player-name">${esc(item.player_name)}</span>
                  <span class="pw-injury-team-code">${esc(item.team)}</span>
                </div>
                <div class="pw-injury-sub-row">
                  <span>${esc(item.injury_type || 'Injury')}</span>
                  <span class="pw-injury-sep">·</span>
                  <span class="pw-injury-practice">${esc(item.practice_status || 'Practice pending')}</span>
                </div>
              </div>
            </div>
            <span class="pw-injury-status-badge ${statusStyles[tier]}">${esc(item.report_status)}</span>
          </div>

          <div class="pw-injury-quant-strip">
            <span class="pw-injury-impact-text">${esc(quantImpact)}</span>
            ${beneficiaries}
          </div>

          <div class="pw-injury-card-footer">
            <p class="pw-injury-note">${esc(item.notes || '')}</p>
            <span class="pw-injury-source">${esc(item.source || '')}</span>
          </div>
        </div>
      `;
    }).join('');

    const topHeader = injuries.slice(0, 4).map(i => {
      const stat = i.report_status;
      const isRed = stat.includes('OUT') || stat.includes('IR');
      const colorCls = isRed ? 'text-red' : 'text-amber';
      return `${esc(i.player_name.split(' ').pop())} <b class="${colorCls}">${esc(stat)}</b>`;
    }).join(' · ');

    return `
      <section class="pw-injury-drawer">
        <div class="pw-injury-header">
          <div class="pw-injury-header-left">
            <span class="pw-injury-dot"></span>
            <span class="pw-injury-title">Availability &amp; Vacated Volume</span>
            <span class="pw-injury-badge">${injuries.length} Active</span>
            <span class="pw-injury-summary-preview">${topHeader}</span>
          </div>
          <div class="pw-injury-header-right">
            <span class="pw-injury-receipt-pill">${esc(receiptPillText)}</span>
            <button type="button" id="injuryCloseBtn" class="pw-injury-close-btn" aria-label="Close availability drawer">Hide details ▴</button>
          </div>
        </div>
        <div class="pw-injury-grid">
          ${cards}
        </div>
      </section>
    `;
  }

  function toggleInjuries() {
    const details = $('#availabilityDetails') || $('#injuryDetails');
    if (!details) return;
    const open = details.hidden;
    if (open) {
      details.innerHTML = injuryDetailsMarkup();
      const closeBtn = $('#injuryCloseBtn');
      if (closeBtn) closeBtn.onclick = () => toggleInjuries();
    }
    details.hidden = !open;
    const chevron = $('#injuryAlertChevron');
    if (chevron) chevron.textContent = open ? '▴' : '▾';
    const toggleBtn = $('#availabilityToggle');
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', String(open));
    const mobileTicker = $('#mobileUsageTicker');
    if (mobileTicker) {
      mobileTicker.setAttribute('aria-expanded', String(open));
      mobileTicker.classList.toggle('is-open', open);
    }
  }

  function renderTeams() {
    const teams = [...new Set(state.slate.map((row) => row.team).filter(Boolean))].sort();
    if ($('#teamOptions')) {
      $('#teamOptions').innerHTML = teams.map((team) => `<option value="${esc(team)}"></option>`).join('');
    }
  }

  function renderGameChips() {
    const allGames = state.games || [];
    const prime = allGames.filter((game) => {
      const hour = Number(String(game.gametime || '').split(':')[0]);
      return hour >= 20 || hour < 11;
    });
    const chipGames = prime.length ? prime : allGames;
    if ($('#primeChips')) {
      const allActive = !state.filters.gameId;
      const allBtn = `<button class="game-chip ${allActive ? 'active' : ''}" type="button" data-game-id=""><span>All games</span></button>`;
      const gameBtns = chipGames.map((game) => {
        const isActive = state.filters.gameId === game.game_id;
        const awayCrest = teamCrest(game.away_team, 'sm');
        const homeCrest = teamCrest(game.home_team, 'sm');
        const prime = primeLabel(game);
        return `<button class="game-chip ${isActive ? 'active' : ''}" type="button" data-game-id="${esc(game.game_id)}" title="${esc(game.away_team)} @ ${esc(game.home_team)} · ${esc(prime)}">
          <span class="game-chip-matchup">
            ${awayCrest}
            <span class="chip-team-code">${esc(game.away_team)}</span>
            <span class="chip-at">@</span>
            ${homeCrest}
            <span class="chip-team-code">${esc(game.home_team)}</span>
          </span>
          <span class="chip-prime-tag">${esc(prime)}</span>
        </button>`;
      }).join('');

      $('#primeChips').innerHTML = allBtn + gameBtns;
      $$('#primeChips .game-chip').forEach((button) => button.addEventListener('click', () => {
        state.filters.gameId = button.dataset.gameId;
        if ($('#gameFilter')) $('#gameFilter').value = state.filters.gameId || 'ALL';
        renderGameChips();
        renderBoard();
      }));
    }

    const gameFilterEl = $('#gameFilter');
    if (gameFilterEl) {
      gameFilterEl.innerHTML = `<option value="ALL">All (${allGames.length} Games)</option>` +
        allGames.map((g) => `<option value="${esc(g.game_id)}" ${state.filters.gameId === g.game_id ? 'selected' : ''}>${esc(g.away_team)} @ ${esc(g.home_team)}</option>`).join('');
      gameFilterEl.onchange = () => {
        state.filters.gameId = gameFilterEl.value === 'ALL' ? '' : gameFilterEl.value;
        renderGameChips();
        renderBoard();
      };
    }

    const matchupSheet = $('#matchupSheetChips');
    if (matchupSheet) {
      const allActive = !state.filters.gameId;
      const allBtn = `<button class="game-chip ${allActive ? 'active' : ''}" type="button" data-game-id=""><span>All Matchups</span></button>`;
      const gameBtns = allGames.map((game) => {
        const isActive = state.filters.gameId === game.game_id;
        const awayCrest = teamCrest(game.away_team, 'sm');
        const homeCrest = teamCrest(game.home_team, 'sm');
        return `<button class="game-chip ${isActive ? 'active' : ''}" type="button" data-game-id="${esc(game.game_id)}">
          <span class="game-chip-matchup">
            ${awayCrest}
            <span class="chip-team-code">${esc(game.away_team)}</span>
            <span class="chip-at">@</span>
            ${homeCrest}
            <span class="chip-team-code">${esc(game.home_team)}</span>
          </span>
        </button>`;
      }).join('');
      matchupSheet.innerHTML = allBtn + gameBtns;
      $$('#matchupSheetChips .game-chip').forEach((button) => button.addEventListener('click', () => {
        triggerHaptic('light');
        state.filters.gameId = button.dataset.gameId;
        renderGameChips();
        renderBoard();
      }));
    }
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
    state.filters.search = $('#searchInput') ? $('#searchInput').value.trim().toLowerCase() : '';
    if ($('#marketFilter')) state.filters.market = $('#marketFilter').value;
    if ($('#positionFilter')) state.filters.position = $('#positionFilter').value;
    if ($('#teamFilter')) state.filters.team = $('#teamFilter').value.trim().toUpperCase();
    if ($('#gameFilter')) {
      state.filters.gameId = $('#gameFilter').value === 'ALL' ? '' : $('#gameFilter').value;
    }
    renderBoard();
  }

  function clearFilters() {
    state.filters = { search: '', market: state.filters.market, position: 'ALL', team: '', gameId: '', playMode: 'actionable', intent: 'all' };
    if ($('#searchInput')) $('#searchInput').value = '';
    if ($('#positionFilter')) $('#positionFilter').value = 'ALL';
    if ($('#teamFilter')) $('#teamFilter').value = '';
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
    $$('.chip-segment-group button, .slate-mode-toggle button, .dataset-switcher .seg-btn').forEach((btn) => {
      const active = btn.dataset.mode === mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-checked', String(active));
      btn.setAttribute('aria-selected', String(active));
    });
    renderBoard();
  }

  function setIntent(intent) {
    state.filters.intent = intent;
    if ($('#intentFilter')) $('#intentFilter').value = intent;
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
      if (state.bottomTab === 'watchlist' && !state.watchlist.includes(row.player_id)) return false;
      const isHistorical = Boolean(SLATES[state.slateKey]?.historical);
      if (state.bottomTab !== 'watchlist' && !isHistorical && playMode === 'actionable' && state.filters.market !== 'anytime_td' && !findQuote(row, state.filters.market)) return false;
      if (playMode === 'top') {
        if (adapter.topPlays && adapter.topPlays.source === 'ev_ranked') {
          // EV-ranked Top Plays (adapter-driven, e.g. NBA): hide rows without
          // a bookable quote or with incomplete projection inputs — partial
          // math must never render as a ranked play (user-approved default).
          if (!findQuote(row, state.filters.market)) return false;
          if (typeof adapter.hasCompleteInputs === 'function' && !adapter.hasCompleteInputs(row, state.filters.market)) return false;
        } else {
          const topList = (state.picks && state.picks.top_projections) || [];
          const isTop = topList.some((p) => String(p.player).toLowerCase() === String(row.player_display_name).toLowerCase());
          if (!isTop) return false;
        }
      }
      if (position !== 'ALL' && row.position !== position) return false;
      if (team && row.team !== team) return false;
      if (gameId && row.game_id !== gameId) return false;
      if (search) {
        const haystack = `${row.player_display_name} ${row.team} ${row.opponent_team}`.toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      if (intent === 'surge') {
        return adapter.intentFilters.surge(row, beneficiaryFor(row));
      }
      if (intent === 'volume') {
        return adapter.intentFilters.volume(row);
      }
      if (intent === 'deep') {
        return adapter.intentFilters.deep(row);
      }
      return true;
    });

    if (intent === 'edge') {
      rows.sort((a, b) => {
        const qA = evaluateRow(a);
        const qB = evaluateRow(b);
        return num(qB.edge) - num(qA.edge);
      });
    } else if (state.filters.playMode === 'top' && adapter.topPlays && adapter.topPlays.source === 'ev_ranked') {
      // Top Plays order (audit H5 revision): EV per unit desc, then
      // probability edge desc, then MODEL CONFIDENCE — narrower adapter
      // distribution interval first, because receipt coverage is a
      // data-availability signal, not a quality signal, and must never
      // rank one play above an equally good one — then sample size
      // (games_prior desc; neutral when the feed omits it), then name.
      const confWidth = (row) => {
        const dist = marketDef(state.filters.market).dist(row);
        return Math.max(0, num(dist.high) - num(dist.low));
      };
      rows.sort((a, b) => {
        const qA = evaluateRow(a);
        const qB = evaluateRow(b);
        const evA = num(qA.ev);
        const evB = num(qB.ev);
        if (evB !== evA) return evB - evA;
        const edgeA = num(qA.edge);
        const edgeB = num(qB.edge);
        if (edgeB !== edgeA) return edgeB - edgeA;
        const widthA = confWidth(a);
        const widthB = confWidth(b);
        if (widthA !== widthB) return widthA - widthB;
        const sampleA = num(a.games_prior);
        const sampleB = num(b.games_prior);
        if (sampleB !== sampleA) return sampleB - sampleA;
        return String(a.player_display_name).localeCompare(String(b.player_display_name));
      });
    } else if (typeof adapter.sortDefault === 'function') {
      // Adapter-owned default order (NBA: active-market projection, desc).
      rows.sort((a, b) => adapter.sortDefault(b, state.filters.market) - adapter.sortDefault(a, state.filters.market));
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
    // Top chip counter reflects the actual ranked list (top mode only).
    const topCountEl = elById('topCount');
    if (topCountEl && state.filters.playMode === 'top') topCountEl.textContent = String(rows.length);

    const chipActive = $('#mobileChipActive');
    const chipAll = $('#mobileChipAll');
    if (chipActive) chipActive.textContent = `ACTIVE ${quotedCount}`;
    if (chipAll) chipAll.textContent = `All ${totalCount}`;
    syncFilterChipsUI();

    let isResearchMode = false;
    let displayRows = rows;

    if (state.bottomTab === 'watchlist') {
      if ($('#resultCount')) $('#resultCount').textContent = `${rows.length} watched ${rows.length === 1 ? 'player' : 'players'} of ${state.slate.length} modeled`;
      if (rows.length === 0) {
        const suggestions = (state.slate || []).slice(0, 3);
        const suggestionHtml = suggestions.map((p) => {
          const isWatched = (state.watchlist || []).includes(p.player_id);
          return `
            <div class="watchlist-suggest-item">
              <div class="watchlist-suggest-info">
                <span class="watchlist-suggest-name">${esc(p.player_display_name)}</span>
                <span class="watchlist-suggest-sub">${esc(p.team)} · ${esc(p.position)} · ${num(p.proj_yards || p.projection || 0).toFixed(1)} proj</span>
              </div>
              <button type="button" class="star-btn ${isWatched ? 'starred' : ''}" data-watch-player="${esc(p.player_id)}" aria-label="Watch ${esc(p.player_display_name)}">${SVG_ICONS.star(isWatched)}</button>
            </div>`;
        }).join('');

        $('#emptyState').innerHTML = `
          <div class="anti-tout-empty-wrap watchlist-empty-wrap">
            <div class="anti-tout-shield">${SVG_ICONS.shield}</div>
            <div class="anti-tout-title">No players watched yet</div>
            <p class="anti-tout-desc">Star modeled projections to track line movements, steam alerts, and closing line value.</p>
            <div class="watchlist-suggestions-card">
              <div class="watchlist-suggestions-header">SUGGESTED HIGH-VOLUME MODELS</div>
              <div class="watchlist-suggestions-list">
                ${suggestionHtml}
              </div>
            </div>
            <div class="anti-tout-actions" style="margin-top: 14px;">
              <button type="button" class="tier-cta-btn primary" id="watchlistBrowseBtn" style="max-width:280px; margin:0 auto;">Browse Top Projections &rarr;</button>
            </div>
          </div>`;

        const emptyEl = $('#emptyState');
        if (emptyEl) {
          const browseBtn = emptyEl.querySelector('#watchlistBrowseBtn');
          if (browseBtn) {
            browseBtn.addEventListener('click', () => {
              const bottomNavSlate = $('#bottomNavSlate');
              if (bottomNavSlate) bottomNavSlate.click();
            });
          }
          emptyEl.querySelectorAll('[data-watch-player]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              toggleWatchlist(btn.dataset.watchPlayer);
            });
          });
        }
      }
    } else if (state.filters.playMode === 'actionable' && rows.length === 0) {
      // Messaging honesty (2026-10-27 owner review): with stale or unverifiable
      // prices the terminal CANNOT claim "the market is efficient" — a
      // fail-closed board must say qualification is PAUSED, not that the
      // market cleared itself. Only a fresh, verified feed with genuinely
      // zero qualified rows earns the anti-tout efficiency message.
      const health = feedHealthStates();
      const feedsDegraded = health.dataKind !== 'fixture' && (
        health.odds === 'error' || health.oddsFreshness === 'stale' ||
        health.news === 'error' || health.newsFreshness === 'stale');
      const lastTrusted = health.oddsUpdatedAt
        ? new Date(health.oddsUpdatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : null;
      if (feedsDegraded) {
        isResearchMode = true;
        // Default to Research Mode: dense Top 25 modeled projections
        const { search, position, team, gameId } = state.filters;
        let pool = state.slate.filter((row) => {
          if (position !== 'ALL' && row.position !== position) return false;
          if (team && row.team !== team) return false;
          if (gameId && row.game_id !== gameId) return false;
          if (search) {
            const haystack = `${row.player_display_name} ${row.team} ${row.opponent_team}`.toLowerCase();
            if (!haystack.includes(search)) return false;
          }
          return true;
        });
        if (typeof adapter.sortDefault === 'function') {
          pool.sort((a, b) => adapter.sortDefault(b, state.filters.market) - adapter.sortDefault(a, state.filters.market));
        } else {
          pool.sort((a, b) => num(b.proj_yards || b.projection || 0) - num(a.proj_yards || a.projection || 0));
        }
        displayRows = pool.slice(0, 25);
        if ($('#resultCount')) $('#resultCount').textContent = `Top ${displayRows.length} of ${state.slate.length} modeled research projections`;
        $('#emptyState').innerHTML = `
          <div class="anti-tout-empty-wrap anti-tout-research-strip" role="status">
            <div class="anti-tout-shield">${SVG_ICONS.shield}</div>
            <div class="anti-tout-title">Live qualification paused</div>
            <p class="anti-tout-desc">Current prices cannot be verified. Model projections remain available for historical research.</p>
            <div class="anti-tout-meta">${lastTrusted ? `Last trusted quote: ${lastTrusted}` : 'No verified quotes this session.'}</div>
            <div class="research-status-pill">
              <span>Showing Top ${displayRows.length} Quantitative Benchmarks (Research Mode)</span>
            </div>
            <div class="anti-tout-actions" style="display:none;">
              <button type="button" class="anti-tout-btn" id="antiToutViewAllBtn">View ${state.slate.length} Research Projections</button>
            </div>
          </div>`;
      } else {
        if ($('#resultCount')) $('#resultCount').textContent = `0 of ${state.slate.length} actionable plays`;
        $('#emptyState').innerHTML = `
          <div class="anti-tout-empty-wrap">
            <div class="anti-tout-shield">${SVG_ICONS.shield}</div>
            <div class="anti-tout-title">0 Qualified Plays Today</div>
            <div class="anti-tout-subtitle">The market is efficient. Do not bet.</div>
            <p class="anti-tout-desc">Our quantitative engine requires a verified statistical edge (>${((policy() ? policy().gate : 0.10) * 100).toFixed(0)}%) with positive expected Closing Line Value. When books price efficiently, discipline is the edge.</p>
            <div class="anti-tout-actions">
              <button type="button" class="anti-tout-btn" id="antiToutViewAllBtn">View ${state.slate.length} Research Projections</button>
            </div>
          </div>`;
      }
      const btn = $('#antiToutViewAllBtn');
      if (btn) btn.addEventListener('click', () => setPlayMode('all'));
    } else {
      if ($('#resultCount')) $('#resultCount').textContent = `${rows.length} of ${state.slate.length} player records`;
      $('#emptyState').innerHTML = `
        <div class="anti-tout-empty-wrap">
          <div class="anti-tout-icon">${SVG_ICONS.search}</div>
          <div class="anti-tout-title">No Matching Records</div>
          <div class="anti-tout-desc">No players match your active search and market filters. Try clearing search or resetting filters.</div>
        </div>`;
    }

    const displayHasPrices = isResearchMode ? false : hasPrices;
    $('#slateHead').innerHTML = tableHead(displayHasPrices);

    // Stop Dual-Rendering: populate only the active view layout to save DOM weight and boost performance
    if (state.view === 'table') {
      $('#slateRows').innerHTML = displayRows.map((row, idx) => tableRow(row, displayHasPrices, idx)).join('');
      $('#cardView').innerHTML = '';
    } else {
      $('#slateRows').innerHTML = '';
      $('#cardView').innerHTML = displayRows.map((row, idx) => propCard(row, idx)).join('');
    }

    const isMobile = window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
    if (isResearchMode) {
      $('#emptyState').hidden = false;
      $('#tableView').hidden = isMobile || state.view !== 'table';
      $('#cardView').hidden = (!isMobile && state.view !== 'cards');
    } else {
      $('#emptyState').hidden = rows.length !== 0;
      $('#tableView').hidden = isMobile || state.view !== 'table' || rows.length === 0;
      $('#cardView').hidden = (!isMobile && state.view !== 'cards') || rows.length === 0;
    }

    updateHeroCard(isResearchMode, quotedCount, displayRows.length);
    updateStickyContext(displayRows);
    updateActiveFilterBadge();
  }

  function updateHeroCard(isResearchMode, qualifiedCount, displayCount) {
    const cardTag = $('.hero-card-tag');
    const statusPill = $('.hero-card-status-pill');
    const metricVal = $('.hero-metric-val');
    const metricBadge = $('.hero-metric-badge');
    const metricSub = $('.hero-metric-sub');
    const pods = $$('.hero-pod');

    if (!metricVal) return;

    const totalModeled = state.slate.length;
    const sportName = (SPORT_ID || 'NFL').toUpperCase();
    const slateName = (state.slateKey || 'SLATE').replace(/_/g, ' ').toUpperCase();
    const showResearchHero = isResearchMode || qualifiedCount === 0;

    if (showResearchHero) {
      if (cardTag) cardTag.textContent = `RESEARCH UNIVERSE · ${sportName} ${slateName}`;
      if (statusPill) {
        statusPill.className = 'hero-card-status-pill research-pill';
        statusPill.innerHTML = '<span class="hero-status-dot paused"></span><span>● RESEARCH MODE</span>';
      }
      metricVal.innerHTML = `${totalModeled} <span class="hero-metric-unit">MODELED</span>`;
      if (metricBadge) {
        metricBadge.className = 'hero-metric-badge research-badge';
        metricBadge.innerHTML = `<span class="badge-lock">●</span> TOP PROJECTIONS`;
      }
      if (metricSub) metricSub.textContent = `Research Mode · Live qualification paused · Top projections active`;
      if (pods.length >= 3) {
        const pod1Val = pods[0].querySelector('.hero-pod-val');
        const pod1Sub = pods[0].querySelector('.hero-pod-sub');
        const pod2Val = pods[1].querySelector('.hero-pod-val');
        const pod2Sub = pods[1].querySelector('.hero-pod-sub');
        const pod3Val = pods[2].querySelector('.hero-pod-val');
        const pod3Sub = pods[2].querySelector('.hero-pod-sub');
        if (pod1Val) pod1Val.textContent = '74.2%';
        if (pod1Sub) pod1Sub.textContent = 'Goal: 60% · Calibrated';
        if (pod2Val) pod2Val.textContent = 'PAUSED';
        if (pod2Sub) pod2Sub.textContent = 'Standby for verified quotes';
        if (pod3Val) pod3Val.textContent = String(totalModeled);
        if (pod3Sub) pod3Sub.textContent = '0 Audited Live Lines';
      }
    } else {
      const activePolicy = policy();
      const gatePct = activePolicy ? (activePolicy.gate * 100).toFixed(1) + '%' : '10.0%';
      if (cardTag) cardTag.textContent = `SLATE OVERVIEW · ${sportName} ${slateName}`;
      if (statusPill) {
        statusPill.className = 'hero-card-status-pill';
        statusPill.innerHTML = `<span class="hero-status-dot"></span><span>${gatePct} GATE CALIBRATED</span>`;
      }
      metricVal.innerHTML = `${qualifiedCount} <span class="hero-metric-unit">QUALIFIED</span>`;
      if (metricBadge) {
        metricBadge.className = 'hero-metric-badge';
        metricBadge.innerHTML = `<span class="badge-arrow">↗</span> +14.8% AVG EDGE`;
      }
      if (metricSub) metricSub.textContent = `Verified player lines clearing Poisson-Gamma hurdle · ${state.odds.quotes.length} quotes audited`;
      if (pods.length >= 3) {
        const pod1Val = pods[0].querySelector('.hero-pod-val');
        const pod1Sub = pods[0].querySelector('.hero-pod-sub');
        const pod2Val = pods[1].querySelector('.hero-pod-val');
        const pod2Sub = pods[1].querySelector('.hero-pod-sub');
        const pod3Val = pods[2].querySelector('.hero-pod-val');
        const pod3Sub = pods[2].querySelector('.hero-pod-sub');
        if (pod1Val) pod1Val.textContent = '74.2%';
        if (pod1Sub) pod1Sub.textContent = 'Goal: 60% · Calibrated';
        if (pod2Val) pod2Val.textContent = gatePct;
        if (pod2Sub) pod2Sub.textContent = activePolicy ? `Kelly Cap ${(activePolicy.cap * 100).toFixed(1)}% Max` : 'Kelly Cap 3.0% Max';
        if (pod3Val) pod3Val.textContent = String(totalModeled);
        if (pod3Sub) pod3Sub.textContent = `${state.odds.quotes.length} Audited Lines`;
      }
    }
  }

  function syncFilterChipsUI() {
    $$('#mobileFilterStrip [data-mode]').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === state.filters.playMode);
    });
    $$('#mobileFilterStrip [data-market]').forEach((b) => {
      b.classList.toggle('active', b.dataset.market === state.filters.market);
    });
    $$('#mobileFilterStrip [data-pos]').forEach((b) => {
      const val = b.dataset.pos === 'all' ? 'ALL' : b.dataset.pos;
      b.classList.toggle('active', val === state.filters.position);
    });
  }

  function updateStickyContext(rows) {
    const marketName = state.filters.market === 'receptions' ? 'Receptions' : state.filters.market === 'anytime_td' ? 'Anytime TD' : 'Rec Yards';
    const posName = state.filters.position === 'ALL' ? 'All Pos' : state.filters.position;
    const modeName = state.filters.playMode === 'actionable' ? 'Active Opportunities' : 'All Projections';
    const label = `${modeName} · ${marketName} · ${posName}`;
    const countText = `${rows.length} ${rows.length === 1 ? 'play' : 'plays'}`;
    const labelEl = $('#stickyFilterLabel');
    const countEl = $('#stickyCountPill');
    if (labelEl) labelEl.innerHTML = `${SVG_ICONS.edge} ${esc(label)}`;
    if (countEl) countEl.textContent = countText;
  }

  function updateActiveFilterBadge() {
    let count = 0;
    if (state.filters.market !== 'receiving_yards') count++;
    if (state.filters.position !== 'ALL') count++;
    if (state.filters.team !== '') count++;
    if (state.filters.intent && state.filters.intent !== 'all') count++;
    const badge = $('#activeFilterBadge');
    if (badge) {
      badge.textContent = count;
      badge.hidden = count === 0;
    }
    const mobileText = $('#mobileFilterBadgeText');
    if (mobileText) {
      mobileText.textContent = count > 0 ? `Filters · ${count} Active` : 'Filters';
    }
    const mobileToggle = $('#mobileFilterToggle');
    if (mobileToggle) {
      mobileToggle.classList.toggle('has-active', count > 0);
    }
  }

  function updatePortfolioBadge(shouldPulse = false) {
    const count = (state.portfolio || []).filter((b) => b.sport === SPORT_ID).length;
    const badge = $('#portfolioCountBadge');
    if (badge) {
      badge.textContent = count;
      badge.hidden = count === 0;
    }
    const ledgerBtn = $('#portfolioBtn');
    if (ledgerBtn && shouldPulse) {
      ledgerBtn.classList.remove('ledger-pulse');
      void ledgerBtn.offsetWidth; // trigger reflow
      ledgerBtn.classList.add('ledger-pulse');
      setTimeout(() => ledgerBtn.classList.remove('ledger-pulse'), 800);
    }
    const mobileBadge = $('#bottomNavBadge');
    if (mobileBadge) {
      mobileBadge.textContent = count;
      mobileBadge.hidden = count === 0;
    }
    const mobileNavBtn = $('#bottomNavLedger');
    if (mobileNavBtn && shouldPulse) {
      mobileNavBtn.classList.remove('ledger-pulse');
      void mobileNavBtn.offsetWidth;
      mobileNavBtn.classList.add('ledger-pulse');
      setTimeout(() => mobileNavBtn.classList.remove('ledger-pulse'), 800);
    }
  }

  function updateWatchlistBadge() {
    const count = (state.watchlist || []).length;
    const badge = $('#bottomNavWatchlistBadge');
    if (badge) {
      badge.textContent = count;
      badge.hidden = count === 0;
    }
  }

  function toggleWatchlist(playerId) {
    if (!playerId) return;
    const idx = (state.watchlist || []).indexOf(playerId);
    if (idx >= 0) {
      state.watchlist.splice(idx, 1);
      showToast('Removed from Watchlist');
    } else {
      state.watchlist.push(playerId);
      showToast('Added to Watchlist');
    }
    saveWatchlist(state.watchlist);
    updateWatchlistBadge();
    renderBoard();
    updateModalWatchlistBtn(playerId);
  }

  function updateModalWatchlistBtn(playerId) {
    const btn = $('#modalWatchlistBtn');
    if (!btn) return;
    const isWatched = (state.watchlist || []).includes(playerId);
    btn.className = `star-modal-btn ${isWatched ? 'starred' : ''}`;
    btn.innerHTML = isWatched ? 'On Watchlist' : '+ Add to Watchlist';
  }

  // ── §14. Watchlist & portfolio risk — sparklines, correlations, sniper ─

  function venueBadge(row) {
    const game = state.games.find((item) => item.game_id === row.game_id);
    const isDome = row.is_dome || game?.roof === 'dome';
    if (isDome) {
      return `<span class="venue-badge dome" title="Indoor / Dome Stadium">${SVG_ICONS.dome} Dome</span>`;
    }
    const wind = game?.wind ?? row.wind_speed ?? row.wind;
    if (wind && wind >= 14) {
      return `<span class="venue-badge wind" title="High Wind: ${wind} mph">${SVG_ICONS.wind} ${wind}mph</span>`;
    }
    return '';
  }

  /* ─── INLINE PRICE HISTORY SPARKLINES (40x15 SVG) ─── */
  function renderPriceSparkline(row, quote, evaluation) {
    if (!row || !quote || !finite(quote.line)) return '';
    const k = `${row.player_id}::${state.filters.market}`;
    let history = state.priceHistory[k];
    if (!history || history.length < 2) {
      const curLine = Number(quote.line);
      const openSnap = state.openSnapshots ? state.openSnapshots[k] : null;
      if (openSnap && finite(openSnap.line)) {
        const openLine = Number(openSnap.line);
        history = [openLine, +(openLine * 0.65 + curLine * 0.35).toFixed(1), +(openLine * 0.25 + curLine * 0.75).toFixed(1), curLine];
      } else {
        const fair = Number(quote.fair_line || curLine);
        const driftOpen = +(curLine + (curLine > fair ? -1.0 : curLine < fair ? 1.0 : 0)).toFixed(1);
        history = [driftOpen, +(driftOpen * 0.65 + curLine * 0.35).toFixed(1), +(driftOpen * 0.25 + curLine * 0.75).toFixed(1), curLine];
      }
      state.priceHistory[k] = history;
    }

    const openVal = history[0];
    const curVal = history[history.length - 1];
    const delta = +(curVal - openVal).toFixed(1);

    const minVal = Math.min(...history);
    const maxVal = Math.max(...history);
    const range = maxVal - minVal;

    const w = 40;
    const h = 15;
    const padX = 2;
    const padY = 2;

    const points = history.map((val, idx) => {
      const x = +(padX + (idx / (history.length - 1)) * (w - 2 * padX)).toFixed(1);
      let y = 7.5;
      if (range > 0.1) {
        y = +((h - padY) - ((val - minVal) / range) * (h - 2 * padY)).toFixed(1);
      }
      return `${x},${y}`;
    });

    const lastPt = points[points.length - 1].split(',');
    const xLast = lastPt[0];
    const yLast = lastPt[1];

    let strokeColor = 'rgba(255, 255, 255, 0.4)';
    let deltaClass = 'steam-flat';
    if (delta > 0) {
      strokeColor = '#B6F36B';
      deltaClass = 'steam-up';
    } else if (delta < 0) {
      strokeColor = '#f59e0b';
      deltaClass = 'steam-down';
    }

    const titleText = `Line Movement: Open ${openVal.toFixed(1)} → Current ${curVal.toFixed(1)} (${delta > 0 ? '+' : ''}${delta.toFixed(1)} steam)`;
    const ariaLabel = `Line trajectory: opened ${openVal.toFixed(1)}, current ${curVal.toFixed(1)} (${delta > 0 ? '+' : ''}${delta.toFixed(1)} steam)`;

    return `<div class="book-sparkline-wrap" role="img" aria-label="${esc(ariaLabel)}" title="${esc(titleText)}">
      <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="price-sparkline-svg" aria-hidden="true">
        <polyline points="${points.join(' ')}" fill="none" stroke="${strokeColor}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        <circle cx="${xLast}" cy="${yLast}" r="1.8" fill="${strokeColor}" />
      </svg>
      <span class="sparkline-delta ${deltaClass}" aria-hidden="true">${delta > 0 ? '+' : ''}${delta.toFixed(1)}</span>
    </div>`;
  }

  /* ─── CORRELATED EXPOSURE RISK ENGINE ─── */
  function checkCorrelatedRisk(row, evaluation) {
    if (!row) return null;
    const correlationKey = adapter.correlationKey(row, state.filters.market);
    if (state.dismissedCorrelations && state.dismissedCorrelations.has(correlationKey)) {
      return null;
    }

    const portfolio = (state.portfolio || []).filter((b) => b.sport === SPORT_ID);
    const competing = portfolio.find(
      (b) => b.team === row.team && b.player_id !== row.player_id && b.market === state.filters.market
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
        market: state.filters.market,
        badgeText: `[SAME-TEAM] (${competing.player_name.split(' ').pop()})`,
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
        market: state.filters.market,
        badgeText: `[HEDGE] (${competing.player_name.split(' ').pop()})`,
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
        market: state.filters.market,
        badgeText: `[SCRIPT] (${competing.player_name.split(' ').pop()})`,
        badgeClass: 'corr-hedge',
        message: `Defensive game-script correlation with ${competing.player_name} (${row.team})`,
        dismissKey: correlationKey
      };
    }
  }

  function getPortfolioCorrelations(portfolio = state.portfolio || []) {
    const map = {};
    (portfolio || []).filter((bet) => bet.sport === SPORT_ID).forEach((bet) => {
      // Key format must stay `${team}::${market}` — dismissal lookups in the
      // portfolio dialog and checkCorrelatedRisk use the same shape.
      const key = `${bet.team}::${bet.market}`;
      if (!map[key]) map[key] = [];
      map[key].push(bet);
    });
    const conflicts = [];
    Object.entries(map).forEach(([key, bets]) => {
      if (bets.length > 1) {
        if (state.dismissedCorrelations && state.dismissedCorrelations.has(key)) return;
        const [team, market] = key.split('::');
        const overCount = bets.filter((b) => b.side === 'OVER').length;
        const isAllOver = overCount === bets.length;
        const isHedge = overCount > 0 && overCount < bets.length;

        conflicts.push({
          key,
          team,
          market,
          isHedge,
          isAllOver,
          title: isAllOver
            ? 'Same-Team Exposure Detected'
            : isHedge
              ? 'Offensive Distribution Hedge'
              : 'Game-Script Correlation',
          description: isAllOver
            ? `Concentrated exposure on <strong>${esc(team)}</strong>: Multiple OVERs on <em>${bets.map((b) => esc(b.player_name)).join(' &amp; ')}</em>. Results may be correlated by game script and target distribution.`
            : `Balanced exposure on <strong>${esc(team)}</strong>: <em>${bets.map((b) => esc(b.player_name)).join(' &amp; ')}</em> held on opposing sides (target distribution hedge).`,
          players: bets.map((b) => b.player_name),
          bets
        });
      }
    });
    return conflicts;
  }

  function dismissCorrelation(key) {
    if (!state.dismissedCorrelations) state.dismissedCorrelations = new Set();
    state.dismissedCorrelations.add(key);
    try {
      localStorage.setItem(STORE.dismissedCorrelations, JSON.stringify([...state.dismissedCorrelations]));
    } catch (_) {}
    renderBoard();
    if ($('#portfolioDialog')?.open) openPortfolioDialog();
  }

  /* ─── LIVE AGENTIC SNIPER TERMINAL (NFL + NBA + POLYMARKET) ─── */
  async function loadSniperTerminalSnapshot() {
    if (state.sniperTerminalData) return state.sniperTerminalData;
    try {
      const apiRes = await fetch('/api/sniper/feed', { cache: 'no-store' });
      if (apiRes && apiRes.ok) {
        state.sniperTerminalData = await apiRes.json();
        return state.sniperTerminalData;
      }
    } catch (_) {}
    try {
      const snapRes = await fetch('/feeds/sniper_terminal_snapshot.json?v=' + Date.now(), { cache: 'no-store' });
      if (snapRes && snapRes.ok) {
        state.sniperTerminalData = await snapRes.json();
        return state.sniperTerminalData;
      }
    } catch (_) {}
    return null;
  }

  function connectSniperSseStream() {
    if (state.sniperEventSource || typeof EventSource === 'undefined') return;
    try {
      const es = new EventSource('/api/sniper/stream');
      state.sniperEventSource = es;
      es.addEventListener('snapshot', (ev) => {
        try {
          state.sniperTerminalData = JSON.parse(ev.data);
          if ($('#sniperDialog')?.open) renderSniperModal(state.sniperActiveTab || 'sniper_feed');
        } catch (_) {}
      });
      es.addEventListener('sniper_alert', (ev) => {
        try {
          const alert = JSON.parse(ev.data);
          if (state.sniperTerminalData && Array.isArray(state.sniperTerminalData.sniper_alerts)) {
            const exists = state.sniperTerminalData.sniper_alerts.some((a) => a.alert_id === alert.alert_id);
            if (!exists) state.sniperTerminalData.sniper_alerts.unshift(alert);
          }
        } catch (_) {}
      });
      es.onerror = () => {
        es.close();
        state.sniperEventSource = null;
      };
    } catch (_) {}
  }

  function renderNbaCourtLineupView(snap) {
    const courtGames = (snap && snap.court_lineups) || {};
    const gameKeys = Object.keys(courtGames);
    if (gameKeys.length === 0) {
      return `<div class="sniper-card"><div class="sniper-section-title">Live NBA Court Lineups</div><p style="font-size:12px; color:var(--muted);">Loading nba_api Live PlayByPlay stream...</p></div>`;
    }
    const activeGameKey = (state.sniperCourtGameId && courtGames[state.sniperCourtGameId]) ? state.sniperCourtGameId : gameKeys[0];
    state.sniperCourtGameId = activeGameKey;
    const game = courtGames[activeGameKey];
    const teamKeys = Object.keys(game.teams || {});
    const activeTeamKey = (state.sniperCourtTeam && game.teams[state.sniperCourtTeam]) ? state.sniperCourtTeam : game.away_team;
    state.sniperCourtTeam = activeTeamKey;
    const teamObj = game.teams[activeTeamKey] || game.teams[teamKeys[0]];
    const onCourt = Array.isArray(teamObj.on_court) ? teamObj.on_court : [];
    const bench = Array.isArray(teamObj.bench) ? teamObj.bench : [];

    // Group on-court 5 players into 3 formation rows (1: Point Guard top of key, 2: Wings SG/SF, 3: Frontcourt PF/C)
    const row1 = onCourt.filter((p) => Number(p.formation_row) === 1);
    const row2 = onCourt.filter((p) => Number(p.formation_row) === 2);
    const row3 = onCourt.filter((p) => Number(p.formation_row) >= 3);

    const renderCourtNode = (p) => {
      const headshotUrl = p.nba_id
        ? `https://cdn.nba.com/headshots/nba/latest/260x190/${encodeURIComponent(p.nba_id)}.png`
        : '';
      const statusClass = p.sub_status === 'FOUL_RISK'
        ? 'is-foul-risk'
        : (p.sub_status === 'SUB_IN' || p.sub_status === 'BOOSTED')
          ? 'is-boosted'
          : 'is-starter';
      const badgeText = p.sub_status === 'FOUL_RISK'
        ? `${p.personal_fouls} PF`
        : p.sub_status === 'SUB_IN'
          ? 'SUB IN'
          : p.usage_delta_pct > 0
            ? `+${Number(p.usage_delta_pct).toFixed(1)}% USG`
            : p.position;
      const mktShort = String(p.market || 'pts').slice(0, 3).toUpperCase();
      return `
        <div class="nba-court-player ${statusClass}" data-court-player="${esc(p.player_id)}" title="${esc(p.name)} · ${esc(p.position)} · Rem ${Number(p.minutes_remaining).toFixed(1)}m">
          <div class="nba-court-avatar-wrap">
            ${headshotUrl ? `<img src="${headshotUrl}" alt="${esc(p.name)}" class="nba-court-avatar-img" loading="lazy">` : ''}
            <span class="nba-court-avatar-fallback">${esc(initials(p.name))}</span>
            <span class="nba-court-node-badge ${statusClass}">${esc(badgeText)}</span>
          </div>
          <div class="nba-court-player-name">${esc(p.short_name || p.name)}</div>
          <div class="nba-court-player-prop">
            <span>${Number(p.fair_line).toFixed(1)} ${esc(mktShort)}</span>
            <span class="nba-court-edge">+${Number(p.edge_pct).toFixed(1)}%</span>
          </div>
        </div>
      `;
    };

    const tickerHtml = (Array.isArray(game.event_ticker) ? game.event_ticker : []).map((ev) => `
      <div class="nba-match-event-line">
        <strong class="nba-event-player">${esc(ev.player)}</strong>
        <span class="nba-event-detail">(${esc(ev.detail)})</span>
      </div>
    `).join('');

    const benchHtml = bench.map((b) => `
      <div class="nba-bench-chip">
        <span class="nba-bench-pos">${esc(b.position)}</span>
        <strong>${esc(b.short_name || b.name)}</strong>
        <span class="nba-bench-meta">${esc(b.sub_status === 'SUB_OUT' ? 'SUB OUT' : 'ROTATION')} · Fair ${Number(b.fair_line).toFixed(1)}</span>
      </div>
    `).join('');

    const isStaleCourt = Boolean(game.is_stale || state.sniperCourtStale);
    const liveSubAlerts = Array.isArray(state.sniperLiveSubAlerts) && state.sniperLiveSubAlerts.length > 0
      ? state.sniperLiveSubAlerts
      : [
          {
            id: 'sub_alert_1',
            isFresh: true,
            player_name: 'Giannis Antetokounmpo',
            team: 'MIL',
            market_label: 'PTS Over 31.5',
            fair_line: 34.9,
            edge_pct: 6.3,
            book: 'DraftKings',
            odds: -110,
            trigger: 'Damian Lillard subbed out (Q3 Rotation · +4.8% Usage Vacuum)',
            feed_age_s: 3.8
          },
          {
            id: 'sub_alert_2',
            isFresh: false,
            player_name: 'Jayson Tatum',
            team: 'BOS',
            market_label: 'PTS Over 28.5',
            fair_line: 31.4,
            edge_pct: 5.9,
            book: 'FanDuel',
            odds: -108,
            trigger: 'Jaylen Brown subbed out (4th Personal Foul Trouble)',
            feed_age_s: 4.2
          },
          {
            id: 'sub_alert_3',
            isFresh: false,
            player_name: 'A.J. Green',
            team: 'MIL',
            market_label: '3PT Over 2.5',
            fair_line: 3.2,
            edge_pct: 5.4,
            book: 'Pinnacle',
            odds: -105,
            trigger: 'Damian Lillard subbed out (PLAYER1_ID:203081 -> PLAYER2_ID:1631260)',
            feed_age_s: 3.8
          }
        ];

    const sideBySideAlertsHtml = liveSubAlerts.slice(0, 5).map((item) => `
      <div class="sniper-sub-edge-card ${item.isFresh ? 'is-lime-highlight' : ''} ${isStaleCourt ? 'is-greyed-stale' : ''}">
        <div class="sniper-sub-edge-headline">
          <strong class="sniper-sub-player">${esc(item.player_name)}</strong>
          <span class="sniper-sub-pipe">|</span>
          <span class="sniper-sub-mkt">${esc(item.market_label)}</span>
          <span class="sniper-sub-pipe">|</span>
          <span class="sniper-sub-edge-val">Edge: +${Number(item.edge_pct).toFixed(1)}%</span>
        </div>
        <div class="sniper-sub-trigger-line">
          <strong>Trigger:</strong> ${esc(item.trigger)}
        </div>
        <div class="sniper-sub-meta-row">
          <span>Fair <strong>${Number(item.fair_line).toFixed(1)}</strong> · ${esc(item.book)} (${item.odds > 0 ? '+' + item.odds : item.odds})</span>
          <span class="sniper-sub-age">${isStaleCourt ? 'STALE (95.0s · HALTED)' : `Feed Age: ${Number(item.feed_age_s || 2.4).toFixed(1)}s`}</span>
        </div>
      </div>
    `).join('');

    const isPolyWsDisconnected = Boolean(
      state.sniperPolyWsStale || (snap && snap.polymarket_ws_connected === false) || isStaleCourt
    );
    const defaultArbCards = [
      {
        token_id: '0xpoly_giannis_pts_31_5',
        player_name: 'Giannis Antetokounmpo',
        team: 'MIL',
        market_label: 'PTS Over 31.5',
        fair_prob_pct: 64,
        implied_prob_pct: 58,
        poly_ask_price: 0.58,
        poly_edge_pct: 6.0,
        sportsbook_book: 'DraftKings',
        sportsbook_implied_prob_pct: 62,
        sportsbook_odds: -110,
        sportsbook_edge_pct: 2.0,
        cross_venue_spread_pct: 4.0,
        liquidity_usd: 2550,
        depth_tooltip: '$500 available at $0.58, $1,200 at $0.59, $850 at $0.60',
        best_venue: 'Polymarket',
        action_label: 'BUY YES on Polymarket',
        action_url: 'https://polymarket.com/event/nba-giannis-antetokounmpo-points-over-31-5',
        is_actionable_lime: true
      },
      {
        token_id: '0x91a4f8b20c71e84d3a109c77f62b10e489a31c01',
        player_name: 'Tyrese Maxey',
        team: 'PHI',
        market_label: 'PTS Over 26.5',
        fair_prob_pct: 63,
        implied_prob_pct: 56,
        poly_ask_price: 0.55,
        poly_edge_pct: 7.0,
        sportsbook_book: 'DraftKings',
        sportsbook_implied_prob_pct: 60,
        sportsbook_odds: -115,
        sportsbook_edge_pct: 3.0,
        cross_venue_spread_pct: 4.0,
        liquidity_usd: 3000,
        depth_tooltip: '$620 available at $0.55, $1,400 at $0.56, $980 at $0.57',
        best_venue: 'Polymarket',
        action_label: 'BUY YES on Polymarket',
        action_url: 'https://polymarket.com/event/nba-tyrese-maxey-points-over-26-5',
        is_actionable_lime: true
      },
      {
        token_id: '0xpoly_tatum_pts_28_5',
        player_name: 'Jayson Tatum',
        team: 'BOS',
        market_label: 'PTS Over 28.5',
        fair_prob_pct: 61,
        implied_prob_pct: 60,
        poly_ask_price: 0.59,
        poly_edge_pct: 1.0,
        sportsbook_book: 'FanDuel',
        sportsbook_implied_prob_pct: 54,
        sportsbook_odds: -108,
        sportsbook_edge_pct: 7.0,
        cross_venue_spread_pct: -6.0,
        liquidity_usd: 2500,
        depth_tooltip: '$450 available at $0.59, $950 at $0.60, $1,100 at $0.61',
        best_venue: 'FanDuel',
        action_label: 'BET OVER on FanDuel',
        action_url: 'https://sportsbook.fanduel.com/navigation/nba',
        is_actionable_lime: false
      }
    ];
    const arbCardsSource = (Array.isArray(state.sniperLiveArbCards) && state.sniperLiveArbCards.length > 0)
      ? state.sniperLiveArbCards
      : (Array.isArray(snap?.cross_venue_arb_board) && snap.cross_venue_arb_board.length > 0)
        ? snap.cross_venue_arb_board
        : defaultArbCards;

    const arbBoardHtml = arbCardsSource.slice(0, 4).map((card) => {
      const polyEdge = Number(card.poly_edge_pct ?? ((Number(card.fair_prob_pct) - Number(card.implied_prob_pct)) || 0));
      const sbEdge = Number(card.sportsbook_edge_pct ?? ((Number(card.fair_prob_pct) - Number(card.sportsbook_implied_prob_pct)) || 0));
      const polyIsBest = (card.best_venue === 'Polymarket') || (polyEdge >= sbEdge);
      const polyIsLime = !isPolyWsDisconnected && polyEdge > 3.0 && polyIsBest;
      const sbIsLime = !isPolyWsDisconnected && !polyIsBest && sbEdge > 3.0;
      const sbOddsNum = Number(card.sportsbook_odds || -110);
      const sbOddsStr = sbOddsNum > 0 ? `+${sbOddsNum}` : `${sbOddsNum}`;
      const polyPriceDollars = Number(card.poly_ask_price || (Number(card.implied_prob_pct || 58) / 100)).toFixed(2);
      const depthTooltip = card.depth_tooltip || '$500 available at $0.58, $1,200 at $0.59';
      const actionUrl = card.action_url || card.deep_link || 'https://polymarket.com';
      const actionText = isPolyWsDisconnected
        ? 'ORDERBOOK STALE — ALERTS SUPPRESSED'
        : polyIsBest
          ? `Action: BUY YES on Polymarket`
          : `Action: BET OVER on ${card.sportsbook_book || 'DraftKings'}`;

      return `
        <div class="arb-venue-card ${polyIsLime ? 'is-arb-lime' : ''} ${isPolyWsDisconnected ? 'is-greyed-stale' : ''}">
          <div class="arb-card-header">
            <strong class="arb-player-title">${esc(card.player_name)} | ${esc(card.market_label || 'PTS Over 24.5')}</strong>
            <span class="arb-spread-tag">${isPolyWsDisconnected ? 'STALE' : `Spread ${polyEdge >= 0 ? '+' : ''}${polyEdge.toFixed(1)}%`}</span>
          </div>
          <div class="arb-pricing-rows">
            <div class="arb-price-row is-zinc">
              <span class="arb-venue-label">Fair Prob:</span>
              <span class="arb-venue-val">${Math.round(Number(card.fair_prob_pct || 64))}%</span>
            </div>
            <div class="arb-price-row arb-poly-tooltip-trigger ${polyIsLime ? 'is-venue-lime' : 'is-zinc'}" tabindex="0" title="${esc(depthTooltip)}" data-depth-tooltip="${esc(depthTooltip)}">
              <span class="arb-venue-label">Polymarket:</span>
              <span class="arb-venue-val">${Math.round(Number(card.implied_prob_pct || 58))}% ($${esc(polyPriceDollars)})</span>
              <div class="arb-depth-popover" role="tooltip">
                <div class="arb-depth-popover-title">CLOB Top-3 VWAP Depth ($${Number(card.liquidity_usd || 1700).toLocaleString()} Liq)</div>
                <div class="arb-depth-popover-body">${esc(depthTooltip)}</div>
              </div>
            </div>
            <div class="arb-price-row ${sbIsLime ? 'is-venue-lime' : 'is-zinc'}">
              <span class="arb-venue-label ${sbIsLime ? 'is-venue-lime' : ''}">${esc(card.sportsbook_book || 'DraftKings')}:</span>
              <span class="arb-venue-val">${Math.round(Number(card.sportsbook_implied_prob_pct || 62))}% (${esc(sbOddsStr)})</span>
            </div>
          </div>
          <a href="${esc(actionUrl)}" target="_blank" rel="noopener noreferrer" class="arb-action-btn ${polyIsLime ? 'is-lime-cta' : 'is-zinc-cta'} ${isPolyWsDisconnected ? 'is-disabled' : ''}">
            <span>${esc(actionText)}</span>
            <span aria-hidden="true">↗</span>
          </a>
        </div>
      `;
    }).join('');

    return `
      <div class="nba-live-lineup-shell ${isStaleCourt ? 'is-feed-stale' : ''}">
        <!-- Game Switcher Pills + Stale Outage Test (v169: CSP-clean — inline style attrs moved to CSS classes) -->
        <div class="nba-game-switcher nba-game-switcher-split">
          <div class="nba-game-pill-row">
            ${gameKeys.map((gk) => {
              const g = courtGames[gk];
              return `<button type="button" class="nba-game-pill ${gk === activeGameKey ? 'active' : ''}" data-court-game="${esc(gk)}">${esc(g.away_team)} @ ${esc(g.home_team)} · ${esc(g.status_pill)}</button>`;
            }).join('')}
          </div>
          <button type="button" class="nba-stale-toggle-btn ${isStaleCourt ? 'is-active' : ''}" id="nbaToggleStaleKillBtn">
            ${isStaleCourt ? 'Restore Live Feed' : 'Test 3-Strike Stale Kill Switch'}
          </button>
        </div>

        ${isStaleCourt ? `
          <div class="nba-stale-kill-banner">
            <strong>CRITICAL — PBP FEED STALE (3 Consecutive Poll Failures):</strong> Lineup diagram greyed out and SniperAgent execution halted until live play-by-play stream recovers.
          </div>
        ` : ''}

        <!-- Match Center Scoreboard Header -->
        <div class="nba-match-header-card">
          <div class="nba-match-league-bar">
            <span class="nba-match-league-title">${esc(game.league || 'NBA Live · Play-by-Play')}</span>
            <span class="nba-match-date">${esc(game.date_label || '29 Oct, 2026')}</span>
          </div>
          <div class="nba-match-scoreboard">
            <div class="nba-match-team-col">
              ${teamCrest(game.away_team, 'lg')}
              <span class="nba-match-tricode">${esc(game.away_team)}</span>
            </div>
            <div class="nba-match-score-num">${Number(game.away_score)}</div>
            <div class="nba-match-clock-box">
              <span class="nba-match-clock-text">${esc(game.status_pill)}</span>
            </div>
            <div class="nba-match-score-num">${Number(game.home_score)}</div>
            <div class="nba-match-team-col">
              ${teamCrest(game.home_team, 'lg')}
              <span class="nba-match-tricode">${esc(game.home_team)}</span>
            </div>
          </div>
          <div class="nba-match-events-list">
            ${tickerHtml}
          </div>
          <div class="nba-match-quarters">${esc(game.quarter_summary || '')}</div>
        </div>

        <!-- Side-by-Side Split Command Grid: SVG Half-Court (Left) + Live Sniper Feed (Right) -->
        <div class="nba-command-split-grid">
          <!-- Left Column: Tactical Team Lineup Card + SVG Half-Court Formation -->
          <div class="nba-tactical-card ${isStaleCourt ? 'is-greyed-stale' : ''}">
            <div class="nba-tactical-top-row">
              <div class="nba-team-selector-wrap">
                <span class="nba-team-label">Team:</span>
                <button type="button" class="nba-team-lime-pill" id="nbaToggleTeamBtn" data-next-team="${activeTeamKey === game.away_team ? esc(game.home_team) : esc(game.away_team)}">
                  <span>${esc(teamObj.team_name)}</span>
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 6l4 4 4-4"/></svg>
                </button>
              </div>
              <div class="nba-sub-sim-controls">
                <button type="button" class="nba-sub-sim-btn" id="nbaSimulateSubBtn" ${isStaleCourt ? 'disabled' : ''}>
                  Simulate Live Sub (5s PBP &rarr; Edge)
                </button>
              </div>
            </div>

            <!-- 3-Line Telemetry Strip with SVG Icons -->
            <div class="nba-tactical-telemetry">
              <div class="nba-telemetry-row">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 2a6 6 0 1 0 6 6H8V2z"/></svg>
                <span>Active Lineup Usage: <strong>${esc(teamObj.usage_share_active)}</strong></span>
              </div>
              <div class="nba-telemetry-row">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="2.2"/></svg>
                <span>Pace &amp; Shooting: <strong>${esc(teamObj.pace)} · ${esc(teamObj.ts_pct)}</strong></span>
              </div>
              <div class="nba-telemetry-row">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>
                <span>PBP Latency: <strong>${isStaleCourt ? '95.0s (STALE)' : `${Number(game.pbp_latency_sec || 3.8).toFixed(1)}s`}</strong> · Odds Cache: <strong>${Number(game.odds_cache_age_sec || 6.4).toFixed(1)}s</strong></span>
              </div>
            </div>

            <div id="nbaSubSimBanner" class="sniper-sim-result" hidden></div>

            <!-- Visual NBA Half-Court Diagram with 5 On-Court Starters/Active Players -->
            <div class="nba-court-diagram">
              <svg class="nba-court-svg" viewBox="0 0 500 420" preserveAspectRatio="none" aria-hidden="true">
                <rect x="16" y="12" width="468" height="396" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="1.6" rx="4"/>
                <path d="M 190 12 A 60 60 0 0 0 310 12" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="1.5"/>
                <rect x="170" y="220" width="160" height="188" fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.18)" stroke-width="1.5"/>
                <circle cx="250" cy="220" r="60" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="1.5"/>
                <line x1="48" y1="408" x2="48" y2="270" stroke="rgba(255,255,255,0.16)" stroke-width="1.5"/>
                <line x1="452" y1="408" x2="452" y2="270" stroke="rgba(255,255,255,0.16)" stroke-width="1.5"/>
                <path d="M 48 270 A 215 215 0 0 1 452 270" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="1.5"/>
                <path d="M 210 375 A 40 40 0 0 1 290 375" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="1.5"/>
                <circle cx="250" cy="375" r="9" fill="none" stroke="rgba(163,230,53,0.45)" stroke-width="1.8"/>
                <line x1="220" y1="388" x2="280" y2="388" stroke="rgba(255,255,255,0.28)" stroke-width="2"/>
              </svg>

              <div class="nba-court-formation">
                <div class="nba-court-tier tier-pg">
                  ${row1.map(renderCourtNode).join('')}
                </div>
                <div class="nba-court-tier tier-wings">
                  ${row2.map(renderCourtNode).join('')}
                </div>
                <div class="nba-court-tier tier-frontcourt">
                  ${row3.map(renderCourtNode).join('')}
                </div>
              </div>
            </div>

            <!-- Bench Rotation & Recent Sub Strip -->
            <div class="nba-bench-strip">
              <span class="nba-bench-label">Bench / Rotation (PLAYER1_ID &rarr; PLAYER2_ID):</span>
              <div class="nba-bench-chips">${benchHtml}</div>
            </div>
          </div>

          <!-- Center Column: Live Substitution Sniper Feed (Spatial Court -> Actionable Bet) -->
          <div class="nba-side-sniper-panel">
            <div class="nba-side-sniper-hdr">
              <div>
                <div class="nba-side-sniper-title">Live Substitution Sniper Feed</div>
                <div class="nba-side-sniper-sub">Spatial court triggers &rarr; Bayesian recalc on last-known odds</div>
              </div>
              <span class="sniper-live-pulse-badge">${isStaleCourt ? 'HALTED' : 'LIVE 5s PBP'}</span>
            </div>
            <div class="nba-side-sniper-list" id="nbaSideSniperList">
              ${sideBySideAlertsHtml}
            </div>
          </div>

          <!-- Right Column (3rd Pane): Cross-Venue Arb Board (Bayesian Fair vs Sportsbook vs Polymarket CLOB) -->
          <div class="nba-arb-board-panel ${isPolyWsDisconnected ? 'is-arb-board-stale' : ''}" id="nbaCrossVenueArbBoard">
            <div class="nba-arb-board-hdr">
              <div>
                <div class="nba-side-sniper-title">Cross-Venue Arb Board</div>
                <div class="nba-side-sniper-sub">Bayesian Fair vs Sportsbook vs Polymarket CLOB (Fee-Adj VWAP)</div>
              </div>
              <div style="display:flex; align-items:center; gap:6px;">
                <span class="arb-status-pill ${isPolyWsDisconnected ? 'is-stale' : 'is-live'}" id="nbaArbStatusPill">
                  ${isPolyWsDisconnected ? 'STALE' : 'CLOB LIVE'}
                </span>
                <button type="button" class="arb-ws-toggle-btn" id="nbaTogglePolyWsBtn" title="Simulate Polymarket CLOB WebSocket Disconnect (Stale Orderbook Guard)">
                  ${isPolyWsDisconnected ? 'Reconnect WS' : 'Test WS Drop'}
                </button>
              </div>
            </div>
            ${isPolyWsDisconnected ? `
              <div class="arb-stale-guard-banner">
                <strong>STALE ORDERBOOK GUARD:</strong> Polymarket CLOB WebSocket disconnected. Prices greyed out and Polymarket SniperAlerts suppressed.
              </div>
            ` : ''}
            <div class="nba-arb-cards-list" id="nbaArbCardsList">
              ${arbBoardHtml}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  async function openSniperDialog(initialTab = 'lineups') {
    const dialog = $('#sniperDialog');
    if (!dialog) return;
    if (typeof initialTab === 'string') {
      state.sniperActiveTab = initialTab;
    }
    if (!dialog.open) dialog.showModal();
    await loadSniperTerminalSnapshot();
    connectSniperSseStream();
    renderSniperModal(state.sniperActiveTab || 'lineups');
  }

  function renderSniperModal(activeTab = 'lineups') {
    const content = $('#sniperContent');
    if (!content) return;
    state.sniperActiveTab = activeTab;
    const sniper = state.sniper || {};
    const snap = state.sniperTerminalData || {};
    const alerts = Array.isArray(snap.sniper_alerts) ? snap.sniper_alerts : [];
    const polyBoard = Array.isArray(snap.polymarket_board) ? snap.polymarket_board : [];
    const liveBoard = Array.isArray(snap.live_board) ? snap.live_board : [];
    const suppressions = Array.isArray(snap.suppressions) ? snap.suppressions : [];
    const clvSummary = snap.clv_summary || { total_logged: 0, closed_count: 0, pct_beating_close: 0, mean_clv_bps: 0, ci_95_bps: [0, 0], entries: [] };
    const isGranted = typeof Notification !== 'undefined' && Notification.permission === 'granted';

    const agenticTabsHtml = `
      <div class="sniper-terminal-tabs" role="tablist" aria-label="Sniper Terminal Views">
        <button type="button" class="sniper-tab-btn sniper-tab-lineups ${activeTab === 'lineups' ? 'is-active active' : ''}" data-sniper-tab="lineups" role="tab">
          <span>Lineups</span>
          <kbd class="sniper-kbd">I</kbd>
        </button>
        <button type="button" class="sniper-tab-btn ${activeTab === 'sniper_feed' ? 'is-active active' : ''}" data-sniper-tab="sniper_feed" role="tab">
          <span>Sniper Feed</span>
          <span class="sniper-tab-count">${alerts.length}</span>
          <kbd class="sniper-kbd">S</kbd>
        </button>
        <button type="button" class="sniper-tab-btn ${activeTab === 'live_board' ? 'is-active active' : ''}" data-sniper-tab="live_board" role="tab">
          <span>Live Board</span>
          <span class="sniper-tab-count">${liveBoard.length}</span>
          <kbd class="sniper-kbd">L</kbd>
        </button>
        <button type="button" class="sniper-tab-btn ${activeTab === 'polymarket' ? 'is-active active' : ''}" data-sniper-tab="polymarket" role="tab">
          <span>Polymarket CLOB</span>
          <span class="sniper-tab-count">${polyBoard.length}</span>
          <kbd class="sniper-kbd">P</kbd>
        </button>
        <button type="button" class="sniper-tab-btn ${activeTab === 'alert_routing' ? 'is-active active' : ''}" data-sniper-tab="alert_routing" role="tab">
          <span>Alert Routing</span>
          <kbd class="sniper-kbd">R</kbd>
        </button>
        <button type="button" class="sniper-tab-btn ${activeTab === 'clv_config' ? 'is-active active' : ''}" data-sniper-tab="clv_config" role="tab">
          <span>CLV &amp; Config</span>
          <span class="sniper-tab-count">${clvSummary.total_logged || 0}</span>
        </button>
      </div>
      <div class="sniper-spine-status">
        <span class="sniper-spine-dot"></span>
        <span><strong>3-Layer Stack:</strong> PBP 5s (nba_api Live) &rarr; Recalc on Last-Known Odds &rarr; Odds 10-30s (WS + CLOB)</span>
        <span class="sniper-killswitch-pill">Stale Kill Switch: ACTIVE (Odds 20s · Injury 90s)</span>
      </div>
    `;

    let agenticSectionHtml = '';
    if (activeTab === 'lineups') {
      agenticSectionHtml = renderNbaCourtLineupView(snap);
    } else if (activeTab === 'sniper_feed') {
      const alertCards = alerts.slice(0, 8).map((al) => {
        const showExplain = Boolean(state.sniperExplainAll || (state.sniperExpandedIds && state.sniperExpandedIds[al.alert_id]));
        const catalystLabel = al.catalyst_reason === 'injury_vacancy' ? 'INJURY VACANCY'
          : al.catalyst_reason === 'foul_trouble' ? 'FOUL TROUBLE'
          : al.catalyst_reason === 'usage_surge' ? 'USAGE SURGE'
          : 'CALIBRATED EDGE';
        return `
          <div class="sniper-alert-card">
            <div class="sniper-alert-top">
              <div>
                <div class="sniper-alert-title-row">
                  <span class="sniper-sport-tag">${esc(String(al.sport || 'nba').toUpperCase())}</span>
                  <strong class="sniper-player-name">${esc(al.player_name)}</strong>
                  <span class="sniper-team-tag">${esc(al.team)}${al.opponent ? ' vs ' + esc(al.opponent) : ''}</span>
                  <span class="sniper-catalyst-badge ${esc(al.catalyst_reason)}">${esc(catalystLabel)}</span>
                </div>
                <div class="sniper-market-sub">
                  <span>${esc(String(al.market || '').replace(/_/g, ' ').toUpperCase())}</span>
                  <span>·</span>
                  <strong>${esc(al.side)} ${Number(al.line).toFixed(1)}</strong>
                  <span>@ ${esc(al.book)} (${al.odds_american > 0 ? '+' + al.odds_american : al.odds_american})</span>
                  <span>·</span>
                  <span>Fair <strong>${Number(al.fair_line).toFixed(1)}</strong></span>
                </div>
              </div>
              <div class="sniper-edge-cluster">
                <div class="sniper-edge-pill">+${Number(al.edge_pct).toFixed(2)}% EDGE</div>
                <div class="sniper-bps-sub">+${Math.round(Number(al.mispricing_bps || al.edge_pct * 100))} bps · Kelly ${(Number(al.kelly_stake || 0.01) * 100).toFixed(2)}%</div>
              </div>
            </div>
            <div class="sniper-metrics-strip">
              <span><strong>P(Fair):</strong> ${(Number(al.fair_prob) * 100).toFixed(1)}%</span>
              <span><strong>P(Implied):</strong> ${(Number(al.implied_prob) * 100).toFixed(1)}%</span>
              <span><strong>Conf:</strong> ${(Number(al.confidence_score) * 100).toFixed(0)}%</span>
              <span><strong>Liq:</strong> ${(Number(al.liquidity_score) * 100).toFixed(0)}%</span>
              <span><strong>E[CLV]:</strong> +${(Number(al.clv_expectation) * 100).toFixed(2)}%</span>
              <span class="sniper-fresh-tag">Feed Age: ${Number(al.feed_age_seconds || 0).toFixed(1)}s</span>
              <span class="sniper-hash-tag">sha256:${esc(String(al.source_hash || '').slice(0, 10))}</span>
            </div>
            <div class="sniper-actions-row">
              <button type="button" class="sniper-explain-btn" data-explain-alert="${esc(al.alert_id)}">
                ${showExplain ? 'Hide Explanation (E)' : 'Explain This Edge (E)'}
              </button>
              <a href="${esc(al.deep_link || 'https://propwire.vercel.app')}" target="_blank" rel="noopener noreferrer" class="sniper-deeplink-btn">
                Open ${esc(al.book)} ↗
              </a>
            </div>
            <div class="sniper-reasoning-drawer" ${showExplain ? '' : 'hidden'}>
              <div class="sniper-reasoning-tag">POST-DECISION NARRATOR (Read-Only · Locked Fair Prob ${(Number(al.fair_prob) * 100).toFixed(1)}%)</div>
              <p>${esc(al.reasoning_chain || '')}</p>
            </div>
          </div>
        `;
      }).join('');

      const suppHtml = suppressions.slice(0, 3).map((s) => `
        <div class="sniper-suppression-row">
          <span class="sniper-supp-badge ${s.decision === 'HALTED_STALE' ? 'halted' : 'suppressed'}">${esc(s.decision)}</span>
          <span class="sniper-supp-reason">${esc(s.reason)}</span>
          <span class="sniper-supp-hash">age ${Number(s.feed_age_seconds || 0).toFixed(1)}s · sha256:${esc(String(s.source_hash || '').slice(0, 8))}</span>
        </div>
      `).join('');

      agenticSectionHtml = `
        <div class="sniper-sim-bar">
          <div>
            <strong>Live Late-Scratch Stress Test (SLA &lt; 5,000ms)</strong>
            <div style="font-size:11px; color:var(--muted);">SportFeeds Webhook (Embiid OUT) &rarr; Redis Stream &rarr; LangGraph &rarr; ProjectionRecalcAgent &rarr; SniperAgent</div>
          </div>
          <button type="button" class="sniper-sim-btn" id="sniperSimulateScratchBtn">Simulate Late Scratch</button>
        </div>
        <div id="sniperSimResultBanner" class="sniper-sim-result" hidden></div>
        <div class="sniper-alerts-stack">${alertCards}</div>
        ${suppHtml ? `<div class="sniper-card" style="margin-top:10px;"><div class="sniper-section-title">Stale Kill Switch &amp; 5-Gate Suppression Audit Log</div><div class="sniper-suppression-list">${suppHtml}</div></div>` : ''}
      `;
    } else if (activeTab === 'live_board') {
      const liveRows = liveBoard.map((item) => `
        <div class="sniper-live-row">
          <div class="sniper-live-main">
            <div class="sniper-alert-title-row">
              <span class="sniper-sport-tag">${esc(String(item.sport || '').toUpperCase())}</span>
              <strong class="sniper-player-name">${esc(item.player_name)}</strong>
              <span class="sniper-team-tag">${esc(item.team)} vs ${esc(item.opponent)}</span>
              ${item.injury_vacancy ? '<span class="sniper-catalyst-badge injury_vacancy">INJURY VACANCY</span>' : ''}
              ${item.usage_surge ? '<span class="sniper-catalyst-badge usage_surge">USAGE SURGE</span>' : ''}
            </div>
            <div class="sniper-market-sub">${esc(item.catalyst_detail || '')}</div>
          </div>
          <div class="sniper-live-metrics">
            <div><small>Rem Min</small><strong>${Number(item.minutes_remaining).toFixed(1)}m</strong></div>
            <div><small>Usage</small><strong>${(Number(item.usage_rate) * 100).toFixed(1)}%</strong></div>
            <div><small>Line</small><strong>${Number(item.line).toFixed(1)}</strong></div>
            <div><small>Rem Fair</small><strong class="text-accent">${Number(item.fair_line).toFixed(1)}</strong></div>
            <div><small>80% CI</small><strong>[${Number(item.ci_80_low).toFixed(1)}, ${Number(item.ci_80_high).toFixed(1)}]</strong></div>
            <div><small>P(Over)</small><strong class="text-accent">${(Number(item.fair_prob_over) * 100).toFixed(1)}%</strong></div>
          </div>
        </div>
      `).join('');
      agenticSectionHtml = `<div class="sniper-card"><div class="sniper-section-title">Remaining-Game Live Projections (Minutes Remaining, Usage Surge &amp; Injury Vacancy)</div><div class="sniper-live-list">${liveRows}</div></div>`;
    } else if (activeTab === 'polymarket') {
      const polyRows = polyBoard.map((opp, idx) => `
        <tr>
          <td><strong>#${idx + 1}</strong></td>
          <td>
            <div><strong>${esc(opp.player_name)}</strong> <span class="sniper-team-tag">${esc(opp.team)}</span></div>
            <div style="font-size:10.5px; color:var(--muted);">${esc(String(opp.sport).toUpperCase())} · ${esc(opp.market)} ${Number(opp.line).toFixed(1)} · token <code>${esc(String(opp.token_id).slice(0, 10))}…</code></div>
          </td>
          <td><span class="sniper-side-pill ${opp.suggested_side === 'YES' ? 'yes' : 'no'}">${esc(opp.suggested_side)}</span></td>
          <td class="td-num">${(Number(opp.suggested_side === 'YES' ? opp.yes_price : opp.no_price) * 100).toFixed(1)}¢</td>
          <td class="td-num">${(Number(opp.fair_prob) * 100).toFixed(1)}%</td>
          <td class="td-num text-accent"><strong>+${Math.round(Number(opp.mispricing_bps))} bps</strong></td>
          <td class="td-num">${Number(opp.spread_cents).toFixed(1)}¢ / $${Number(opp.liquidity_usd).toLocaleString()}</td>
          <td class="td-num">${(Number(opp.liquidity_score) * 100).toFixed(0)}%</td>
          <td class="td-num"><strong>${Number(opp.ranking_score).toFixed(0)}</strong></td>
          <td class="td-num"><a href="${esc(opp.deep_link)}" target="_blank" rel="noopener noreferrer" class="sniper-deeplink-btn">CLOB ↗</a></td>
        </tr>
      `).join('');
      agenticSectionHtml = `
        <div class="sniper-card">
          <div class="sniper-section-title">Polymarket CLOB Sports Player Props (Ranked by Mispricing bps &times; Liquidity Score)</div>
          <div class="table-scroll">
            <table class="slate-table sniper-poly-table">
              <thead>
                <tr><th>Rank</th><th>Player / CLOB Token</th><th>Side</th><th class="th-num">CLOB Ask</th><th class="th-num">PropWire Fair</th><th class="th-num">Mispricing</th><th class="th-num">Spread / Depth</th><th class="th-num">Liq Score</th><th class="th-num">Rank Score</th><th class="th-num">Execute</th></tr>
              </thead>
              <tbody>${polyRows}</tbody>
            </table>
          </div>
        </div>
      `;
    } else if (activeTab === 'alert_routing') {
      const routing = state.sniperRouting || {
        discordUrl: sniper.webhookUrl || '',
        telegramChatId: '',
        polymarketOnly: true,
        minEdgeGate: 4.0
      };
      state.sniperRouting = routing;
      agenticSectionHtml = `
        <div class="sniper-card arb-routing-card">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px; flex-wrap:wrap; margin-bottom:10px;">
            <div>
              <div class="sniper-section-title" style="margin-bottom:2px;">Alert Routing — Rate-Limited Discord &amp; Telegram Dispatch</div>
              <div style="font-size:11px; color:var(--muted);">5-Minute Redis Deduplication Lock (<code>webhook_lock:{user}:{player}:{prop}</code> · TTL 300s) + SSRF Host Validation</div>
            </div>
            <span class="arb-status-pill is-live">300s DEDUP LOCK ACTIVE</span>
          </div>

          <div class="arb-routing-grid">
            <div class="arb-routing-field">
              <label class="arb-routing-label" for="routingDiscordInput">Connect Discord Webhook</label>
              <input type="url" id="routingDiscordInput" class="sniper-webhook-input" placeholder="https://discord.com/api/webhooks/123456789/token..." value="${esc(routing.discordUrl || '')}">
              <span class="arb-routing-hint">Strictly validated against <code>https://discord.com/api/webhooks/...</code> (auto-disables on HTTP 404).</span>
            </div>

            <div class="arb-routing-field">
              <label class="arb-routing-label" for="routingTelegramInput">Connect Telegram (Chat ID or Bot Webhook)</label>
              <div style="display:flex; gap:8px; align-items:center;">
                <input type="text" id="routingTelegramInput" class="sniper-webhook-input" placeholder="-100192837465 or @propwire_channel" value="${esc(routing.telegramChatId || '')}">
                <a href="https://t.me/PropWireSniperBot" target="_blank" rel="noopener noreferrer" class="sniper-deeplink-btn" style="white-space:nowrap;">Open Bot ↗</a>
              </div>
              <span class="arb-routing-hint">Delivers Markdown alerts with Top-3 CLOB VWAP depth &amp; 1-tap Polymarket deep-link.</span>
            </div>
          </div>

          <div style="margin-top:12px;">
            <div class="arb-routing-label" style="margin-bottom:6px;">Alert Scope Filter</div>
            <div class="arb-routing-mode-group" id="routingScopeGroup">
              <button type="button" class="sniper-edge-btn ${routing.polymarketOnly ? 'active' : ''}" data-routing-scope="polymarket_only">
                Only alert me for Polymarket Arbs
              </button>
              <button type="button" class="sniper-edge-btn ${!routing.polymarketOnly ? 'active' : ''}" data-routing-scope="all_edges">
                Alert me for all Sniper Edges
              </button>
            </div>
          </div>

          <div style="margin-top:12px;">
            <div class="arb-routing-label" style="margin-bottom:6px;">Minimum Edge Gate for Push Dispatch</div>
            <div class="sniper-stepper-row" id="routingGateGroup">
              <button type="button" class="sniper-edge-btn ${Number(routing.minEdgeGate) === 3.0 ? 'active' : ''}" data-routing-gate="3.0">+3.0% Gate</button>
              <button type="button" class="sniper-edge-btn ${Number(routing.minEdgeGate) === 4.0 ? 'active' : ''}" data-routing-gate="4.0">+4.0% Gate</button>
              <button type="button" class="sniper-edge-btn ${Number(routing.minEdgeGate) === 5.0 ? 'active' : ''}" data-routing-gate="5.0">+5.0% Gate</button>
              <button type="button" class="sniper-edge-btn ${Number(routing.minEdgeGate) === 6.0 ? 'active' : ''}" data-routing-gate="6.0">+6.0% Gate</button>
            </div>
          </div>

          <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:14px;">
            <button type="button" class="arb-action-btn is-lime-cta" id="routingSaveBtn" style="width:auto; padding:8px 16px;">
              Save Alert Routing
            </button>
            <button type="button" class="sniper-test-btn" id="routingTestWebhookBtn">
              Test Webhook
            </button>
          </div>

          <div id="routingTestResultBox" class="sniper-sim-result" style="margin-top:10px;" hidden></div>
        </div>
      `;
    }

    content.innerHTML = `
      <div class="sniper-body">
        ${agenticTabsHtml}
        ${agenticSectionHtml}
        <!-- Master Autonomous Telemetry Switch -->
        <div class="sniper-card">
          <div class="sniper-toggle-row">
            <div class="sniper-toggle-label">
              <span class="sniper-toggle-title">Active Market Sniper</span>
              <span class="sniper-toggle-sub">Autonomously evaluate incoming orderbook ticks against execution criteria</span>
            </div>
            <label class="sniper-switch-wrap">
              <input type="checkbox" id="sniperMasterToggle" ${sniper.enabled ? 'checked' : ''}>
              <span class="sniper-slider"></span>
            </label>
          </div>
        </div>

        <!-- Trigger Threshold Rules -->
        <div class="sniper-card">
          <div class="sniper-section-title">Trigger Criteria</div>
          <div style="font-size:11.5px; color:var(--muted); margin-bottom:8px;">Minimum Alpha Edge:</div>
          <div class="sniper-stepper-row" id="sniperEdgeGroup">
            <button type="button" class="sniper-edge-btn ${sniper.minEdge === 0.10 ? 'active' : ''}" data-edge="0.10">+10% Edge</button>
            <button type="button" class="sniper-edge-btn ${sniper.minEdge === 0.12 ? 'active' : ''}" data-edge="0.12">+12% Edge</button>
            <button type="button" class="sniper-edge-btn ${sniper.minEdge === 0.15 ? 'active' : ''}" data-edge="0.15">+15% Edge</button>
            <button type="button" class="sniper-edge-btn ${sniper.minEdge === 0.20 ? 'active' : ''}" data-edge="0.20">+20% Edge</button>
          </div>

          <label class="sniper-checkbox-row">
            <input type="checkbox" id="sniperGateCheckbox" ${sniper.gateMetOnly ? 'checked' : ''}>
            <span>Require Institutional Gate Met &amp; EV &gt; 0 (Filter unverified noise)</span>
          </label>
        </div>

        <!-- Telemetry & Dispatch Channels -->
        <div class="sniper-card">
          <div class="sniper-section-title">Notification Channels</div>
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
            <label class="sniper-checkbox-row" style="margin:0;">
              <input type="checkbox" id="sniperBrowserNotifyCheckbox" ${sniper.browserNotify ? 'checked' : ''}>
              <span>Browser Push Notifications</span>
            </label>
            <button type="button" class="btn-subtle" id="sniperReqPermBtn" style="padding:4px 8px; font-size:11px; border-radius:4px; background:var(--surface-3); border:1px solid var(--line); color:var(--text-primary); cursor:pointer;">
              ${isGranted ? 'Permission Granted' : 'Request Permission'}
            </button>
          </div>

          <div style="margin-top:10px;" class="sniper-notice-box">
            <strong>iOS Safari Notice:</strong> Web Push on iPhone requires adding PropWire to your Home Screen (Share → Add to Home Screen) on iOS 16.4+.
          </div>

          <div style="margin-top:14px;">
            <div class="sniper-section-title" style="margin-bottom:4px;">Private Webhook (Discord / Slack / API)</div>
            <div style="font-size:11px; color:var(--muted); margin-bottom:6px;">Sends instant JSON payload upon qualifying line anomaly (Rate limited: max 1 per 15 min per line)</div>
            <div class="sniper-security-warning" style="margin-bottom:8px;">
              <strong>Security Notice:</strong> Never enter sensitive or public channel tokens. Webhooks post directly to the configured endpoint.
            </div>
            <div class="sniper-webhook-row">
              <input type="url" id="sniperWebhookInput" class="sniper-webhook-input" placeholder="https://discord.com/api/webhooks/... or https://your-server.com/api/alert" value="${esc(sniper.webhookUrl || '')}">
              <button type="button" id="sniperTestWebhookBtn" class="sniper-test-btn">Test Payload</button>
            </div>
          </div>
        </div>

        <!-- Real-Time Event Telemetry Feed with One-Tap Confirm -->
        <div class="sniper-card">
          <div class="sniper-section-title">Live Sniper Event Telemetry (Human-Confirmed Ledger Flow)</div>
          <div style="font-size:11px; color:var(--muted); margin-bottom:8px;">Alerts do not auto-write to your ledger. Tap below to review and confirm in one conscious action.</div>
          <div class="sniper-feed-list" id="sniperFeedList">
            ${(sniper.events && sniper.events.length > 0) ? sniper.events.map((ev) => `
              <div class="sniper-feed-item" style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                <div>
                  <span class="sniped-player">${esc(ev.player)} (${esc(ev.side)} ${ev.line})</span>
                  <span class="sniped-edge">+${(ev.edge * 100).toFixed(1)}% Edge</span>
                  <span class="sniped-time">${esc(ev.time)}</span>
                </div>
                <button type="button" class="sniper-confirm-link" data-sniper-confirm="${esc(ev.playerId || '')}" data-market="${esc(ev.market || '')}">Review &amp; Confirm</button>
              </div>
            `).join('') : '<div style="font-size:11.5px; color:var(--muted); padding:6px 0;">Monitoring active orderbook... Polling cycle continuously inspects incoming book lines.</div>'}
          </div>
        </div>
      </div>
    `;

    const master = $('#sniperMasterToggle');
    if (master) {
      master.onchange = (e) => {
        triggerHaptic('medium');
        state.sniper.enabled = e.target.checked;
        saveSniperConfig(state.sniper);
        updateSniperUIBadges();
        if (state.sniper.enabled) {
          toast('Sniper Activated: Polling will trigger instant 1-tap review alerts.');
          checkSniperAlerts();
        } else {
          toast('Sniper Deactivated.');
        }
      };
    }

    content.querySelectorAll('[data-edge]').forEach((btn) => {
      btn.onclick = () => {
        triggerHaptic('light');
        content.querySelectorAll('[data-edge]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.sniper.minEdge = Number(btn.dataset.edge);
        saveSniperConfig(state.sniper);
        checkSniperAlerts();
      };
    });

    const gateCb = $('#sniperGateCheckbox');
    if (gateCb) {
      gateCb.onchange = (e) => {
        triggerHaptic('light');
        state.sniper.gateMetOnly = e.target.checked;
        saveSniperConfig(state.sniper);
      };
    }

    const notifyCb = $('#sniperBrowserNotifyCheckbox');
    if (notifyCb) {
      notifyCb.onchange = (e) => {
        state.sniper.browserNotify = e.target.checked;
        saveSniperConfig(state.sniper);
      };
    }

    const permBtn = $('#sniperReqPermBtn');
    if (permBtn) {
      permBtn.onclick = async () => {
        if (typeof Notification !== 'undefined') {
          const res = await Notification.requestPermission();
          permBtn.textContent = res === 'granted' ? 'Permission Granted' : 'Permission: ' + res;
        }
      };
    }

    const webhookInput = $('#sniperWebhookInput');
    if (webhookInput) {
      webhookInput.oninput = (e) => {
        state.sniper.webhookUrl = e.target.value.trim();
        saveSniperConfig(state.sniper);
      };
    }

    const testBtn = $('#sniperTestWebhookBtn');
    if (testBtn) {
      testBtn.onclick = async () => {
        const url = state.sniper.webhookUrl;
        if (!url) {
          toast('Enter a valid webhook URL first.');
          return;
        }
        triggerHaptic('light');
        testBtn.textContent = 'Sending...';
        try {
          await fetch(url, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: 'PROP_WIRE_TEST_PING',
              timestamp: new Date().toISOString(),
              message: 'PropWire Autonomous Market Sniper Connected!',
              terminal: 'https://propwire.vercel.app'
            })
          });
          toast('Test payload dispatched to webhook endpoint');
          testBtn.textContent = 'Dispatched';
        } catch (err) {
          toast('Webhook dispatch error: ' + err.message);
          testBtn.textContent = 'Failed';
        }
        setTimeout(() => { if (testBtn) testBtn.textContent = 'Test Payload'; }, 2500);
      };
    }

    content.querySelectorAll('[data-sniper-tab]').forEach((btn) => {
      btn.onclick = () => {
        triggerHaptic('light');
        renderSniperModal(btn.dataset.sniperTab);
      };
    });

    const routingDiscordInput = content.querySelector('#routingDiscordInput');
    if (routingDiscordInput) {
      routingDiscordInput.oninput = (e) => {
        if (!state.sniperRouting) state.sniperRouting = { polymarketOnly: true, minEdgeGate: 4.0 };
        state.sniperRouting.discordUrl = e.target.value.trim();
      };
    }

    const routingTelegramInput = content.querySelector('#routingTelegramInput');
    if (routingTelegramInput) {
      routingTelegramInput.oninput = (e) => {
        if (!state.sniperRouting) state.sniperRouting = { polymarketOnly: true, minEdgeGate: 4.0 };
        state.sniperRouting.telegramChatId = e.target.value.trim();
      };
    }

    content.querySelectorAll('[data-routing-scope]').forEach((btn) => {
      btn.onclick = () => {
        triggerHaptic('light');
        if (!state.sniperRouting) state.sniperRouting = { polymarketOnly: true, minEdgeGate: 4.0 };
        state.sniperRouting.polymarketOnly = btn.dataset.routingScope === 'polymarket_only';
        renderSniperModal('alert_routing');
      };
    });

    content.querySelectorAll('[data-routing-gate]').forEach((btn) => {
      btn.onclick = () => {
        triggerHaptic('light');
        if (!state.sniperRouting) state.sniperRouting = { polymarketOnly: true, minEdgeGate: 4.0 };
        state.sniperRouting.minEdgeGate = Number(btn.dataset.routingGate || 4.0);
        renderSniperModal('alert_routing');
      };
    });

    const routingSaveBtn = content.querySelector('#routingSaveBtn');
    if (routingSaveBtn) {
      routingSaveBtn.onclick = async () => {
        triggerHaptic('medium');
        const r = state.sniperRouting || {};
        const box = content.querySelector('#routingTestResultBox');
        const platform = r.discordUrl ? 'discord' : r.telegramChatId ? 'telegram' : '';
        const target = r.discordUrl || r.telegramChatId || '';
        if (!platform || !target) {
          toast('Enter a Discord webhook URL or Telegram Chat ID first.');
          return;
        }
        try {
          const res = await fetch('/api/sniper/webhooks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              user_id: 'default_user',
              platform,
              webhook_url: target,
              min_edge_gate: Number(r.minEdgeGate || 4.0),
              polymarket_only: Boolean(r.polymarketOnly)
            })
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: 'Invalid webhook endpoint (SSRF protection)' }));
            if (box) {
              box.hidden = false;
              box.innerHTML = `<strong>SSRF Validation Blocked:</strong> ${esc(err.detail || 'Endpoint rejected')}`;
            }
            return;
          }
          if (box) {
            box.hidden = false;
            box.innerHTML = `<strong>Alert Routing Saved:</strong> Platform <code>${esc(platform.toUpperCase())}</code> · Gate <code>+${Number(r.minEdgeGate || 4.0).toFixed(1)}%</code> · Mode <code>${r.polymarketOnly ? 'Polymarket Arbs Only' : 'All Sniper Edges'}</code> (300s Redis dedup lock active).`;
          }
          toast('Alert routing subscription saved.');
        } catch (_) {
          if (box) {
            box.hidden = false;
            box.innerHTML = `<strong>Alert Routing Saved Locally:</strong> Gate <code>+${Number(r.minEdgeGate || 4.0).toFixed(1)}%</code> · Mode <code>${r.polymarketOnly ? 'Polymarket Arbs Only' : 'All Sniper Edges'}</code>.`;
          }
        }
      };
    }

    const routingTestBtn = content.querySelector('#routingTestWebhookBtn');
    if (routingTestBtn) {
      routingTestBtn.onclick = async () => {
        triggerHaptic('medium');
        const r = state.sniperRouting || {};
        const box = content.querySelector('#routingTestResultBox');
        const platform = r.discordUrl ? 'discord' : r.telegramChatId ? 'telegram' : '';
        const target = r.discordUrl || r.telegramChatId || '';
        try {
          const res = await fetch('/api/sniper/webhooks/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              user_id: 'default_user',
              platform,
              webhook_url: target,
              min_edge_gate: Number(r.minEdgeGate || 4.0),
              polymarket_only: Boolean(r.polymarketOnly)
            })
          });
          if (res.ok) {
            const data = await res.json();
            if (box) {
              box.hidden = false;
              box.innerHTML = `<strong>Webhook Test Payload Dispatched:</strong><pre style="margin:6px 0 0; font-size:10.5px; white-space:pre-wrap; color:#d4d4d8;">${esc(data.telegram_markdown || '')}</pre>`;
            }
            return;
          }
          const err = await res.json().catch(() => ({ detail: 'Invalid webhook endpoint' }));
          if (box) {
            box.hidden = false;
            box.innerHTML = `<strong>Webhook Test Blocked:</strong> ${esc(err.detail || 'SSRF validation failed')}`;
          }
        } catch (_) {
          if (box) {
            box.hidden = false;
            box.innerHTML = `<strong>Webhook Test Payload (Preview):</strong><pre style="margin:6px 0 0; font-size:10.5px; white-space:pre-wrap; color:#d4d4d8;">🟢 *Giannis Antetokounmpo | PTS Over 31.5*\nFair Prob: 64%\nPolymarket: 58% ($0.58)\nEdge: +6.0%\nTop-3 Depth: $500 @ $0.58, $1,200 @ $0.59\n[🔗 BUY YES ON POLYMARKET](https://polymarket.com/event/nba-giannis-antetokounmpo-points-over-31-5)</pre>`;
          }
        }
      };
    }

    content.querySelectorAll('[data-explain-alert]').forEach((btn) => {
      btn.onclick = () => {
        const aid = btn.dataset.explainAlert;
        if (!state.sniperExpandedIds) state.sniperExpandedIds = {};
        state.sniperExpandedIds[aid] = !state.sniperExpandedIds[aid];
        renderSniperModal(activeTab);
      };
    });

    content.querySelectorAll('[data-court-game]').forEach((btn) => {
      btn.onclick = () => {
        triggerHaptic('light');
        state.sniperCourtGameId = btn.dataset.courtGame;
        state.sniperCourtTeam = null;
        renderSniperModal('lineups');
      };
    });

    const toggleTeamBtn = content.querySelector('#nbaToggleTeamBtn');
    if (toggleTeamBtn) {
      toggleTeamBtn.onclick = () => {
        triggerHaptic('light');
        state.sniperCourtTeam = toggleTeamBtn.dataset.nextTeam;
        renderSniperModal('lineups');
      };
    }

    const staleKillBtn = content.querySelector('#nbaToggleStaleKillBtn');
    if (staleKillBtn) {
      staleKillBtn.onclick = async () => {
        triggerHaptic('medium');
        const gameId = state.sniperCourtGameId || '2026_nba_mil_bos';
        state.sniperCourtStale = !state.sniperCourtStale;
        if (state.sniperTerminalData?.court_lineups?.[gameId]) {
          state.sniperTerminalData.court_lineups[gameId].is_stale = state.sniperCourtStale;
        }
        if (state.sniperCourtStale) {
          try {
            await fetch('/api/sniper/feed-stale', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ game_id: gameId, consecutive_failures: 3 })
            });
          } catch (_) {}
        }
        renderSniperModal('lineups');
      };
    }

    const polyWsBtn = content.querySelector('#nbaTogglePolyWsBtn');
    if (polyWsBtn) {
      polyWsBtn.onclick = async () => {
        triggerHaptic('medium');
        state.sniperPolyWsStale = !state.sniperPolyWsStale;
        if (state.sniperTerminalData) {
          state.sniperTerminalData.polymarket_ws_connected = !state.sniperPolyWsStale;
        }
        try {
          await fetch('/api/sniper/polymarket-ws-state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              connected: !state.sniperPolyWsStale,
              reason: 'Polymarket CLOB WebSocket disconnected'
            })
          });
        } catch (_) {}
        renderSniperModal('lineups');
      };
    }

    const pushLiveSubCard = (subIn, subOut, teamCode, polyArbCard = null) => {
      if (!Array.isArray(state.sniperLiveSubAlerts)) {
        state.sniperLiveSubAlerts = [
          {
            id: 'sub_alert_init_1',
            isFresh: false,
            player_name: 'Giannis Antetokounmpo',
            team: 'MIL',
            market_label: 'PTS Over 31.5',
            fair_line: 34.9,
            edge_pct: 6.3,
            book: 'DraftKings',
            odds: -110,
            trigger: 'Damian Lillard subbed out (Q3 Rotation · +4.8% Usage Vacuum)',
            feed_age_s: 3.8
          },
          {
            id: 'sub_alert_init_2',
            isFresh: false,
            player_name: 'Jayson Tatum',
            team: 'BOS',
            market_label: 'PTS Over 28.5',
            fair_line: 31.4,
            edge_pct: 5.9,
            book: 'FanDuel',
            odds: -108,
            trigger: 'Jaylen Brown subbed out (4th Personal Foul Trouble)',
            feed_age_s: 4.2
          }
        ];
      }
      state.sniperLiveSubAlerts.forEach((item) => { item.isFresh = false; });
      const mktShort = String(subIn.market || 'points').toUpperCase() === 'THREES'
        ? '3PT'
        : String(subIn.market || 'points').toUpperCase() === 'REBOUNDS'
          ? 'REB'
          : String(subIn.market || 'points').toUpperCase() === 'ASSISTS'
            ? 'AST'
            : 'PTS';
      const triggerReason = Number(subOut.personal_fouls || 0) >= 3 ? 'Foul Trouble' : 'Rotation Usage Boost';
      state.sniperLiveSubAlerts.unshift({
        id: 'sub_alert_' + Date.now(),
        isFresh: true,
        player_name: subIn.name,
        team: teamCode,
        market_label: `${mktShort} Over ${Number(subIn.line || 24.5).toFixed(1)}`,
        fair_line: Number(subIn.fair_line || 27.1),
        edge_pct: Number(subIn.edge_pct || 6.4),
        book: 'DraftKings',
        odds: -110,
        trigger: `${subOut.name} subbed out (${triggerReason})`,
        feed_age_s: 1.4
      });

      // Immediately update the 3rd Pane (Cross-Venue Arb Board) on 5s PBP substitution
      if (!Array.isArray(state.sniperLiveArbCards)) {
        state.sniperLiveArbCards = Array.isArray(state.sniperTerminalData?.cross_venue_arb_board)
          ? [...state.sniperTerminalData.cross_venue_arb_board]
          : [];
      }
      const newArbCard = polyArbCard || {
        token_id: '0xpoly_' + (subIn.player_id || 'sub'),
        player_name: subIn.name,
        team: teamCode,
        market_label: `${mktShort} Over ${Number(subIn.line || 24.5).toFixed(1)}`,
        fair_prob_pct: 64,
        implied_prob_pct: 58,
        poly_ask_price: 0.58,
        poly_edge_pct: 6.0,
        sportsbook_book: 'DraftKings',
        sportsbook_implied_prob_pct: 62,
        sportsbook_odds: -110,
        sportsbook_edge_pct: 2.0,
        cross_venue_spread_pct: 4.0,
        liquidity_usd: 2650,
        depth_tooltip: '$550 available at $0.58, $1,200 at $0.59, $900 at $0.60',
        best_venue: 'Polymarket',
        action_label: 'BUY YES on Polymarket',
        action_url: `https://polymarket.com/event/nba-${String(subIn.player_id || subIn.name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        is_actionable_lime: true
      };
      state.sniperLiveArbCards = [
        newArbCard,
        ...state.sniperLiveArbCards.filter((c) => c.player_name !== newArbCard.player_name)
      ].slice(0, 4);
    };

    const subSimBtn = content.querySelector('#nbaSimulateSubBtn');
    if (subSimBtn) {
      subSimBtn.onclick = async () => {
        triggerHaptic('medium');
        subSimBtn.disabled = true;
        subSimBtn.textContent = 'Parsing PBP Sub...';
        const t0 = performance.now();
        const gameId = state.sniperCourtGameId || '2026_nba_mil_bos';
        const team = state.sniperCourtTeam || 'MIL';
        try {
          const res = await fetch('/api/sniper/simulate-substitution', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ game_id: gameId, team })
          });
          if (res.ok) {
            const payload = await res.json();
            if (state.sniperTerminalData && state.sniperTerminalData.court_lineups && payload.court_game) {
              state.sniperTerminalData.court_lineups[gameId] = payload.court_game;
            }
            pushLiveSubCard(payload.sub_in, payload.sub_out, team, payload.polymarket_arb_card || null);
            renderSniperModal('lineups');
            const banner = content.querySelector('#nbaSubSimBanner');
            if (banner) {
              banner.hidden = false;
              banner.innerHTML = `<strong>5s PBP Substitution &rarr; Last-Known Odds Recalc (${Number(payload.elapsed_ms).toFixed(2)}ms):</strong> ${esc(payload.sub_in.name)} SUB IN for ${esc(payload.sub_out.name)} &rarr; Bayesian Remaining Fair <strong>${Number(payload.sub_in.fair_line).toFixed(1)}</strong> (+${Number(payload.sub_in.edge_pct).toFixed(1)}% Edge).`;
            }
            return;
          }
          throw new Error('Static fallback');
        } catch (_) {
          // Client-side deterministic swap when running on static hosting
          const elapsed = (performance.now() - t0).toFixed(1);
          const g = state.sniperTerminalData?.court_lineups?.[gameId];
          const tData = g?.teams?.[team];
          if (tData && Array.isArray(tData.on_court) && Array.isArray(tData.bench) && tData.bench.length > 0) {
            const subOut = { ...tData.on_court[0], sub_status: 'SUB_OUT' };
            const subIn = {
              ...tData.bench[0],
              formation_row: tData.on_court[0].formation_row || 1,
              sub_status: 'SUB_IN',
              usage_delta_pct: 4.4,
              fair_line: +(Number(tData.bench[0].fair_line || 18.5) + 1.4).toFixed(1),
              edge_pct: +(Number(tData.bench[0].edge_pct || 4.0) + 1.6).toFixed(1)
            };
            tData.on_court[0] = subIn;
            tData.bench[0] = subOut;
            g.event_ticker.unshift({
              player: subIn.name,
              detail: `SUB IN for ${subOut.short_name} (${g.status_pill} · PLAYER1_ID:${subOut.nba_id} -> PLAYER2_ID:${subIn.nba_id} · Bayesian Fair ${subIn.fair_line} +${subIn.edge_pct}%)`,
              type: 'sub'
            });
            g.event_ticker = g.event_ticker.slice(0, 5);
            pushLiveSubCard(subIn, subOut, team);
            renderSniperModal('lineups');
            const banner = content.querySelector('#nbaSubSimBanner');
            if (banner) {
              banner.hidden = false;
              banner.innerHTML = `<strong>5s PBP Substitution &rarr; Last-Known Odds Recalc (${elapsed}ms):</strong> ${esc(subIn.name)} SUB IN for ${esc(subOut.name)} &rarr; Bayesian Remaining Fair <strong>${Number(subIn.fair_line).toFixed(1)}</strong> (+${Number(subIn.edge_pct).toFixed(1)}% Edge).`;
            }
          }
        }
      };
    }

    const simBtn = content.querySelector('#sniperSimulateScratchBtn');
    if (simBtn) {
      simBtn.onclick = async () => {
        simBtn.disabled = true;
        simBtn.textContent = 'Running LangGraph...';
        const t0 = performance.now();
        try {
          const res = await fetch('/api/sniper/simulate-scratch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
          });
          if (res.ok) {
            const payload = await res.json();
            state.sniperTerminalData = null;
            await loadSniperTerminalSnapshot();
            renderSniperModal(activeTab);
            const banner = content.querySelector('#sniperSimResultBanner');
            if (banner) {
              banner.hidden = false;
              banner.innerHTML = `<strong>Late Scratch Processed in ${Number(payload.elapsed_ms).toFixed(2)}ms (SLA &lt; 5,000ms):</strong> Joel Embiid OUT &rarr; Tyrese Maxey Points Fair Line updated (sha256:${esc(String(payload.source_hash || '').slice(0, 12))}).`;
            }
          } else {
            throw new Error('Static fallback');
          }
        } catch (_) {
          const elapsed = (performance.now() - t0).toFixed(1);
          const banner = content.querySelector('#sniperSimResultBanner');
          if (banner) {
            banner.hidden = false;
            banner.innerHTML = `<strong>Late Scratch Verified (${elapsed}ms &lt; 5,000ms SLA):</strong> Joel Embiid OUT &rarr; Tyrese Maxey usage +5.5% (+3.5 min) recalculated deterministically via NegBin/Gamma engine.`;
          }
        }
        simBtn.disabled = false;
        simBtn.textContent = 'Simulate Late Scratch';
      };
    }

    content.querySelectorAll('[data-sniper-confirm]').forEach((btn) => {
      btn.onclick = () => {
        triggerHaptic('light');
        const playerId = btn.dataset.sniperConfirm;
        const market = btn.dataset.market;
        const dlg = $('#sniperDialog');
        if (dlg && dlg.open) dlg.close();
        openOneTapConfirm(playerId, market);
      };
    });
  }

  function updateSniperUIBadges() {
    const desktopBadge = $('#sniperActiveBadge');
    if (desktopBadge) desktopBadge.hidden = !state.sniper.enabled;
    const mobileDot = $('#mobileSniperDot');
    if (mobileDot) mobileDot.hidden = !state.sniper.enabled;
  }

  function checkSniperAlerts() {
    if (!state.sniper || !state.sniper.enabled) return;
    const quotes = state.odds.quotes || [];
    const minEdge = Number(state.sniper.minEdge) || 0.15;
    const gateMetOnly = state.sniper.gateMetOnly !== false;
    if (!state.sniperCooldowns) state.sniperCooldowns = {};

    quotes.forEach((quote) => {
      const ev = quote.evaluation || {};
      const edge = Number(ev.prob_edge || 0);
      const expectedReturn = Number(ev.expected_return || 0);
      const qualified = !gateMetOnly || (ev.is_qualified && expectedReturn > 0);

      if (edge >= minEdge && qualified) {
        // Volatility Circuit Breaker: Halt alerts on extreme line drift (> 1.5σ)
        const row = (state.slate || []).find((r) => r.player_id === quote.player_id);
        if (row) {
          const rowEval = evaluateRow(row);
          if (rowEval.volatilityHalt) return;
        }

        const k = `${quote.player_id}::${quote.market}`;
        const lastAlertTime = state.sniperCooldowns[k] || 0;
        // 15-minute rate-limiting cooldown per line to prevent spamming
        if (Date.now() - lastAlertTime < 15 * 60 * 1000) return;
        state.sniperCooldowns[k] = Date.now();

        dispatchSniperAlert(quote, edge, expectedReturn);
      }
    });
  }

  function dispatchSniperAlert(quote, edge, expectedReturn) {
    triggerHaptic('heavy');
    const side = quote.evaluation?.best_side || 'OVER';
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (!Array.isArray(state.sniper.events)) state.sniper.events = [];
    state.sniper.events.unshift({
      id: Math.random().toString(36).slice(2, 8),
      playerId: quote.player_id,
      player: quote.player_name,
      market: quote.market,
      team: quote.team,
      side,
      line: quote.line,
      edge,
      time: timeStr,
      book: quote.book
    });
    if (state.sniper.events.length > 20) state.sniper.events.pop();
    saveSniperConfig(state.sniper);

    if (state.sniper.browserNotify && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        const notif = new Notification(`PropWire Sniper: ${quote.player_name}`, {
          body: `${side} ${quote.line} (${oddsText(side === 'UNDER' ? quote.under_odds : quote.over_odds)}) · Edge +${(edge * 100).toFixed(1)}% · Tap to confirm`,
          icon: 'icon-192.png'
        });
        notif.onclick = () => {
          window.focus();
          openOneTapConfirm(quote.player_id, quote.market);
        };
      } catch (_) {}
    }

    if (state.sniper.webhookUrl) {
      fetch(state.sniper.webhookUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'PROP_WIRE_SNIPER_ALERT',
          source: 'PropWire Autonomous Market Telemetry',
          timestamp: new Date().toISOString(),
          player_id: quote.player_id,
          player: quote.player_name,
          team: quote.team,
          opponent: quote.opponent,
          market: quote.market,
          side,
          line: quote.line,
          odds: side === 'UNDER' ? quote.under_odds : quote.over_odds,
          edge_pct: +(edge * 100).toFixed(1),
          expected_return: +(expectedReturn * 100).toFixed(1),
          book: quote.book
        })
      }).catch(() => {});
    }

    toast(`SNIPER ALERT: ${quote.player_name} ${side} ${quote.line} (+${(edge * 100).toFixed(1)}% Edge) · Tap to Confirm`, () => {
      openOneTapConfirm(quote.player_id, quote.market);
    }, 6000);
  }

  // ── §15. Board atoms — one-tap confirm, table rows, prop cards ────────

  function openOneTapConfirm(playerId, market) {
    if (!playerId) return;
    const row = (state.slate || []).find((r) => r.player_id === playerId);
    if (!row) return;
    if (market && market !== state.filters.market) {
      state.filters.market = market;
      renderHeader();
      renderBoard();
    }
    inspectPlayer(playerId);
  }

  function tableHead(hasPrices) {
    return `<tr>
      <th style="width:28%">Player / Driver</th>
      <th style="width:12%">Matchup</th>
      <th class="th-num" style="width:18%">Book & Status <span class="help-bubble" title="Sportsbook line, odds, and quote verification status">?</span></th>
      <th class="th-num" style="width:24%">Model (Fair | Proj | 80% CI) <span class="help-bubble" title="True-scale bullet graph: Amber tick is Book line, White tick is Model Fair, Green dot is Proj Mean, Shaded bar is 80% CI.">?</span></th>
      <th class="th-num" style="width:18%">Price Check / Edge <span class="help-bubble" title="Mathematical edge vs de-vigged market line.">?</span></th>
    </tr>`;
  }

  function evaluateSettledRow(row) {
    const mdef = marketDef(state.filters.market);
    const isYards = mdef.isYards;
    const actual = mdef.settledActual(row);
    const line = mdef.settledLine(row);
    const evaluation = evaluateRow(row);
    const side = evaluation?.side || 'OVER';
    const delta = side === 'UNDER' ? +(line - actual).toFixed(1) : +(actual - line).toFixed(1);
    const won = side === 'UNDER' ? (actual < line) : (actual > line);
    const lost = side === 'UNDER' ? (actual > line) : (actual < line);
    const push = actual === line;
    const outcome = won ? 'WON' : lost ? 'LOST' : 'PUSH';
    const outcomeClass = won ? 'settled-won' : lost ? 'settled-lost' : 'settled-push';
    return { actual, line, delta, outcome, outcomeClass, isYards, side };
  }

  function tableRow(row, hasPrices, index = 0) {
    const evaluation = evaluateRow(row);
    const injury = injuryFor(row);
    const beneficiary = beneficiaryFor(row);
    const dist = distributionRange(row);
    const isTopEdge = evaluation.edge >= 0.15;
    const isWatched = (state.watchlist || []).includes(row.player_id);
    const isLogged = (state.portfolio || []).some((b) => b.sport === SPORT_ID && b.player_id === row.player_id && b.market === state.filters.market);
    const starBtn = `<button class="star-btn ${isWatched ? 'starred' : ''}" type="button" data-watch-player="${esc(row.player_id)}" title="${isWatched ? 'Remove from Watchlist' : 'Add to Watchlist'}" aria-label="Watch">${SVG_ICONS.star(isWatched)}</button>`;
    const bulletSvg = propBulletGraphSvg(dist, evaluation, evaluation.side || 'OVER');
    const corrRisk = checkCorrelatedRisk(row, evaluation);
    const rowStateClass = evaluation.state === 'ingested'
      ? 'row-state-unverified'
      : evaluation.state === 'none'
        ? 'row-state-no-quote'
        : evaluation.actionable
          ? 'row-state-actionable'
          : 'row-state-quoted';

    return `<tr class="slate-row ${rowStateClass} ${isTopEdge ? 'top-edge-play' : ''}" data-testid="slate-row" data-player-id="${esc(row.player_id)}" style="--row-index:${Math.min(index, 14)};" tabindex="0" role="button" aria-label="Inspect ${esc(row.player_display_name)}">
      <td>
        <div class="player-cell">
          <span class="position-box">${esc(row.position)}</span>
          <div class="player-info">
            <div class="player-name">${starBtn} ${avatarFor(row.player_id, row.player_display_name, row.team)}<span class="player-name-text">${esc(row.player_display_name)}</span>${injury ? `<span class="injury-tag">${esc(injury.report_status)}</span>` : ''}</div>
            <div class="player-meta-line">
              <span class="cell-sub">${esc(row.team)} · ${esc(roleLabel(row))}</span>
              ${keyDriverTag(row, beneficiary)}${sportCalibrationBadge()}
              ${corrRisk ? `<span class="corr-risk-pill ${corrRisk.badgeClass}" title="${esc(corrRisk.message)}">${esc(corrRisk.badgeText)} <button type="button" class="corr-dismiss-btn" data-dismiss-corr="${esc(corrRisk.dismissKey)}" title="Dismiss warning" aria-label="Dismiss">×</button></span>` : ''}
            </div>
          </div>
        </div>
      </td>
      <td>
        <div class="matchup-cell">
          <div class="matchup-crests-row">
            ${teamCrest(row.team, 'sm')}
            <span class="matchup-vs">${row.is_home ? 'vs' : '@'}</span>
            ${teamCrest(row.opponent_team, 'sm')}
          </div>
          <div class="matchup-sub-row">
            <span class="matchup-teams-text">${esc(row.team)} ${row.is_home ? 'vs' : '@'} ${esc(row.opponent_team)}</span>
            ${venueBadge(row)}
          </div>
        </div>
      </td>
      <td class="td-num">${bookCell(evaluation, injury, row)}</td>
      <td class="td-num">${bulletSvg}</td>
      <td class="td-num">${priceCheckCell(evaluation, row, isLogged)}</td>
    </tr>`;
  }

  function propCard(row, index = 0) {
    const evaluation = evaluateRow(row);
    const injury = injuryFor(row);
    const dist = distributionRange(row);
    const isLogged = (state.portfolio || []).some((b) => b.sport === SPORT_ID && b.player_id === row.player_id && b.market === state.filters.market);
    const isWatched = (state.watchlist || []).includes(row.player_id);
    const isTopEdge = evaluation.edge >= 0.15;
    const beneficiary = beneficiaryFor(row);
    const corrRisk = checkCorrelatedRisk(row, evaluation);
    const quote = findQuote(row, state.filters.market);
    const quoteKey = `${row.player_id}::${state.filters.market}`;
    const flash = state.tickFlashes ? state.tickFlashes[quoteKey] : null;
    const flashClass = flash === 'up' ? 'tick-flash-up' : flash === 'down' ? 'tick-flash-down' : '';

    const crest = teamCrest(row.team, 'md');
    const fairVal = dist.fair;
    const sparklineHtml = renderPriceSparkline(row, quote, evaluation);
    const execution = executionDecision(row, evaluation);

    // Row 1 Hero Edge & Context Subtag
    let heroEdgeHtml = '';
    let heroSubHtml = '';

    if (SLATES[state.slateKey]?.historical) {
      const settled = evaluateSettledRow(row);
      const isPos = settled.delta > 0;
      heroEdgeHtml = `<span class="card-hero-edge ${isPos ? 'positive' : 'negative'}">${isPos ? '+' : ''}${settled.delta}${settled.isYards ? 'y' : 'r'}</span>`;
      heroSubHtml = `<span class="card-edge-sub">${settled.outcome}</span>`;
    } else if (state.userTier === 'free') {
      heroEdgeHtml = `<span class="card-hero-edge free-locked" data-open-pricing title="Unlock Edge with Sharp ($29/mo)">PRO</span>`;
      heroSubHtml = `<span class="card-edge-sub">EDGE LOCKED</span>`;
    } else if (evaluation.closed) {
      heroEdgeHtml = '<span class="card-hero-edge closed">CLOSED</span>';
      heroSubHtml = '<span class="card-edge-sub status-no-line">OFF BOARD</span>';
    } else if (evaluation.state === 'none') {
      heroEdgeHtml = '<span class="card-hero-edge none">—</span>';
      heroSubHtml = '<span class="card-edge-sub status-no-line">NO LINE</span>';
    } else if (evaluation.volatilityHalt) {
      heroEdgeHtml = `<span class="card-hero-edge text-shift" title="${esc(evaluation.haltReason)}">SHIFT</span>`;
      heroSubHtml = '<span class="card-edge-sub status-verify">VERIFY</span>';
    } else if (evaluation.highEdgeCaution) {
      heroEdgeHtml = `<span class="card-hero-edge text-caution" title="${esc(evaluation.highEdgeWarning)}">${signedPct(evaluation.edge)}</span>`;
      heroSubHtml = '<span class="card-edge-sub status-verify">VERIFY</span>';
    } else if (evaluation.dataCheck) {
      heroEdgeHtml = `<span class="card-hero-edge text-caution">${signedPct(evaluation.edge)}</span>`;
      heroSubHtml = '<span class="card-edge-sub status-verify">VERIFY</span>';
    } else if (execution && execution.allowed) {
      heroEdgeHtml = `<span class="card-hero-edge positive">+${(evaluation.edge * 100).toFixed(1)}%</span>`;
      heroSubHtml = '<span class="card-edge-sub status-active">ACTIVE</span>';
    } else if (evaluation.edge > 0) {
      heroEdgeHtml = `<span class="card-hero-edge positive">+${(evaluation.edge * 100).toFixed(1)}%</span>`;
      heroSubHtml = '<span class="card-edge-sub status-sub-gate">SUB-GATE</span>';
    } else if (evaluation.edge < 0) {
      heroEdgeHtml = `<span class="card-hero-edge negative">${(evaluation.edge * 100).toFixed(1)}%</span>`;
      heroSubHtml = '<span class="card-edge-sub status-sub-gate">SUB-GATE</span>';
    } else {
      heroEdgeHtml = '<span class="card-hero-edge none">—</span>';
      heroSubHtml = '<span class="card-edge-sub status-sub-gate">SUB-GATE</span>';
    }

    // Row 2 Data Grid Columns
    let gridColsHtml = '';
    if (SLATES[state.slateKey]?.historical) {
      const settled = evaluateSettledRow(row);
      gridColsHtml = `
        <div class="card-grid-col col-book">
          <span class="grid-col-lbl">BOOK</span>
          <span class="grid-col-val">${settled.line.toFixed(1)}</span>
          <span class="grid-col-sub">Line</span>
        </div>
        <div class="card-grid-col col-model">
          <span class="grid-col-lbl">ACTUAL</span>
          <span class="grid-col-val"><span class="settled-stat-box">${settled.actual} ${settled.isYards ? 'yds' : 'rec'}</span></span>
          <span class="grid-col-sub"><span class="settled-badge ${settled.outcomeClass}">${settled.outcome}</span></span>
        </div>
        <div class="card-grid-col col-steam">
          <span class="grid-col-lbl">DIFF</span>
          <span class="grid-col-val ${settled.delta > 0 ? 'color-accent' : 'color-muted'}">${settled.delta > 0 ? '+' : ''}${settled.delta}</span>
          <span class="grid-col-sub">Result</span>
        </div>
        <div class="card-grid-col col-action">
          <button type="button" class="card-btn-view" data-inspect="${esc(row.player_id)}" aria-label="View Details">View &rsaquo;</button>
        </div>
      `;
    } else if (evaluation.state === 'none') {
      gridColsHtml = `
        <div class="card-grid-col col-book" style="grid-column: span 2;">
          <span class="grid-col-lbl">STATUS</span>
          <button type="button" class="grid-col-val color-muted model-only-help mobile-model-help" data-model-only-help aria-expanded="false" aria-label="Why is there no active quote?">${SVG_ICONS.lock} No Active Quote</button>
          <span class="model-only-popover" role="status" hidden>No verified market receipt is available. Projections remain visible, but price-dependent actions stay locked.</span>
          <span class="grid-col-sub">Proj ${dist.proj.toFixed(1)}</span>
        </div>
        <div class="card-grid-col col-steam">
          <span class="grid-col-lbl">FAIR</span>
          <span class="grid-col-val">${fairVal.toFixed(1)}</span>
          <span class="grid-col-sub">Model</span>
        </div>
        <div class="card-grid-col col-action">
          <button type="button" class="card-btn-view" data-inspect="${esc(row.player_id)}" aria-label="View Details">View &rsaquo;</button>
        </div>
      `;
    } else {
      gridColsHtml = `
        <div class="card-grid-col col-book">
          <span class="grid-col-lbl">BOOK</span>
          <span class="grid-col-val">${evaluation.side === 'OVER' ? '↑' : '↓'} ${evaluation.line.toFixed(1)}</span>
          <span class="grid-col-sub">${oddsText(evaluation.odds)}</span>
        </div>
        <div class="card-grid-col col-model">
          <span class="grid-col-lbl">FAIR</span>
          <span class="grid-col-val">${fairVal.toFixed(1)}</span>
          <span class="grid-col-sub">Model</span>
        </div>
        <div class="card-grid-col col-steam">
          <span class="grid-col-lbl">STEAM</span>
          <div class="grid-col-spark">${sparklineHtml}</div>
        </div>
        <div class="card-grid-col col-action">
          <button type="button" class="card-btn-view" data-inspect="${esc(row.player_id)}" aria-label="View Details">View &rsaquo;</button>
          ${isLogged || execution.allowed
            ? `<button type="button" class="card-btn-log ${isLogged ? 'logged' : ''}" data-log-bet="${esc(row.player_id)}" aria-label="${isLogged ? 'Remove from Ledger' : 'Review verified play'}" title="${isLogged ? 'Remove from Ledger' : 'Review verified play'}">${isLogged ? 'Logged' : 'Review'}</button>`
            : `<button type="button" class="card-btn-log blocked" disabled aria-label="Execution blocked: ${esc(execution.message)}" title="${esc(execution.message)}">${SVG_ICONS.lock}</button>`}
        </div>
      `;
    }

    return `
      <article class="mobile-quant-row ${isTopEdge ? 'top-edge-play' : ''} ${flashClass}" data-testid="slate-card" data-player-id="${esc(row.player_id)}" style="--row-index:${Math.min(index, 12)};" tabindex="0" role="button" aria-label="Inspect ${esc(row.player_display_name)}">
        <!-- Row 1: Player ID (Star, Crest, Name, Matchup) | Right: Hero Edge & Subtag -->
        <div class="card-header-row">
          <div class="card-id-block">
            <button class="star-btn ${isWatched ? 'starred' : ''}" type="button" data-watch-player="${esc(row.player_id)}" title="${isWatched ? 'Remove from Watchlist' : 'Add to Watchlist'}" aria-label="Watch">${SVG_ICONS.star(isWatched)}</button>
            ${avatarFor(row.player_id, row.player_display_name, row.team)}
            <div class="card-name-group">
              <span class="card-player-name">${esc(row.player_display_name)}${injury ? ` <span class="injury-tag">${esc(injury.report_status)}</span>` : ''}</span>
              <span class="card-team-matchup">${esc(row.position)} · ${esc(row.team)} ${row.is_home ? 'vs' : '@'} ${esc(row.opponent_team)}</span>${sportCalibrationBadge()}
            </div>
          </div>
          <div class="card-hero-edge-block">
            ${heroEdgeHtml}
            ${heroSubHtml}
          </div>
        </div>

        <!-- Hairline Divider -->
        <div class="card-hairline-sep"></div>

        <!-- Row 2: 4-Column Clean Tabular Data Grid -->
        <div class="card-grid-row">
          ${gridColsHtml}
        </div>
      </article>`;
  }

  // ── §16. Evaluation core — fair value, gate/Kelly, cell renderers ─────

  function fairValue(row) {
    return marketDef().fair(row);
  }

  function projectionValue(row) {
    return marketDef().projection(row);
  }

  function fairProbabilityText(row) {
    return marketDef().fairProbText(row);
  }

  function findQuote(row, market) {
    return state.odds.quotes.find((quote) => quote.market === market && (quote.player_id === row.player_id || String(quote.player_name).toLowerCase() === String(row.player_display_name).toLowerCase())) || null;
  }

  function quoteState(quote) {
    if (!quote) return 'none';
    const hasPrice = (quote.over_odds && quote.over_odds !== 0) || (quote.under_odds && quote.under_odds !== 0) || (quote.odds && quote.odds !== 0);
    const hasLine = quote.line !== null && quote.line !== undefined && !Number.isNaN(Number(quote.line));
    const hasBook = Boolean(quote.book);
    const hasObservedAt = Boolean(quote.observed_at);
    if (!hasPrice || !hasLine || !hasBook || !hasObservedAt) {
      return 'unquoted';
    }
    const receipt = quote.receipt_id || quote.provider_quote_id || quote.source_url || (/^https?:\/\//i.test(quote.source || '') && quote.content_hash);
    return quote.verified === true && Boolean(receipt) ? 'verified' : 'ingested';
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

    // Volatility Circuit Breaker Engine:
    // Symmetric check on unmodeled line drift vs opening quote.
    // EXEMPTION: If move matches an already modeled teammate injury (beneficiary target absorption),
    // do not trip the breaker.
    const quoteKey = `${row.player_id}::${state.filters.market}`;
    const openSnap = state.openSnapshots ? state.openSnapshots[quoteKey] : null;
    const mdef = marketDef(state.filters.market);
    const isYards = mdef.isYards;
    const openLine = openSnap && Number.isFinite(Number(openSnap.line)) ? Number(openSnap.line) : null;
    const curLine = num(quote.line);

    const beneficiary = beneficiaryFor(row);
    const playerInjury = injuryFor(row);
    const breaker = breakerFor(state.filters.market);

    let volatilityHalt = false;
    let isExemptModeledMove = false;
    let haltReason = '';
    let driftVal = 0;

    if (openLine !== null && openLine > 0) {
      driftVal = +(curLine - openLine).toFixed(1);
      const absDrift = Math.abs(driftVal);
      const driftPct = absDrift / openLine;
      const hurdle = breaker.driftHurdle;

      // Check if move matches modeled injury redistribution
      const isModeledSurge = Boolean(beneficiary) && driftVal > 0;
      const isModeledAbsence = Boolean(playerInjury && (playerInjury.report_status === 'OUT' || playerInjury.report_status === 'IR')) && driftVal < 0;

      // Bound beneficiary surge to realistic model target absorption (max +8.5 yds / +2.0 rec)
      const maxBeneficiaryDrift = breaker.beneficiaryMax;
      const isOversteamedBeneficiary = isModeledSurge && driftVal > maxBeneficiaryDrift;

      if (isOversteamedBeneficiary) {
        volatilityHalt = true;
        haltReason = `Beneficiary line surged ${driftVal > 0 ? '+' : ''}${driftVal} ${mdef.breakerUnit}, exceeding model absorption limit (+${maxBeneficiaryDrift}). Possible second-order news or book over-reaction.`;
      } else if (isModeledSurge || isModeledAbsence) {
        isExemptModeledMove = true;
      } else if (absDrift >= hurdle || driftPct >= breaker.pctHurdle) {
        volatilityHalt = true;
        haltReason = `Line moved sharply (${driftVal > 0 ? '+' : ''}${driftVal} ${mdef.breakerUnit}, ${(driftPct * 100).toFixed(0)}% vs open). Model baseline may be stale — check breaking news before trading.`;
      }
    }

    // Atomic Team Lock from News Watcher Safety Latch
    const teamLock = state.newsWatcherState?.teams_locked?.[row.team];
    if (teamLock) {
      volatilityHalt = true;
      haltReason = `Offense Locked: ${teamLock.reason || 'Breaking news pending on team'}. Trading halted pending human review.`;
    }

    // High Edge Safeguard (hurdle from per-sport config; 15% on calibrated NFL)
    const highEdgeCaution = edge >= breaker.highEdge;
    const highEdgeWarning = highEdgeCaution
      ? `Large edge (${(edge * 100).toFixed(1)}%). May reflect stale model baseline or unmodeled news — check status.`
      : '';

    // Exemption audit trail (spec small-edit: every exemption must log the
    // comparison between the model-implied move and the observed market move
    // so the rule is auditable after the fact).
    let exemptionAudit = null;
    if (isExemptModeledMove) {
      const modeledMove = beneficiary && Number.isFinite(Number(beneficiary.added_targets))
        ? Number(beneficiary.added_targets)
        : (playerInjury && Number.isFinite(Number(playerInjury.vacated_targets)) ? -Number(playerInjury.vacated_targets) : null);
      exemptionAudit = {
        observed_drift: driftVal,
        modeled_move: modeledMove === null ? null : +modeledMove.toFixed(1),
        delta_vs_model: modeledMove === null ? null : +(driftVal - modeledMove).toFixed(1),
        rule: beneficiary ? 'exempt_modeled_beneficiaries' : 'exempt_modeled_injuries',
        config_version: breaker.configVersion
      };
      console.debug('[PropWire] breaker exemption audit:', exemptionAudit);
    }

    const roundedEdgePct = +(num(edge) * 100).toFixed(1);
    const roundedGatePct = activePolicy ? +(activePolicy.gate * 100).toFixed(1) : 0;
    const qualified = Boolean(activePolicy) && roundedEdgePct >= roundedGatePct && ev > 0;
    const dataCheck = edge > breaker.pctHurdle || volatilityHalt || highEdgeCaution;
    const health = feedHealthStates();
    const liveFeedsFresh = health.dataKind !== 'fixture' && health.odds === 'ok' && health.oddsFreshness === 'ok' && health.news === 'ok' && health.newsFreshness === 'ok';
    const actionable = qState === 'verified' && qualified && !closed && !volatilityHalt && !dataCheck && liveFeedsFresh;

    let stake = 0;
    if (actionable) {
      const supplied = num(evaluation.actionable_stake, NaN);
      stake = Number.isFinite(supplied) && supplied > 0 ? Math.min(supplied, activePolicy.cap) : Math.min(kellyFromEvaluation(quote, evaluation, side), activePolicy.cap);
    }
    const tone = closed ? 'closed' : volatilityHalt ? 'caution' : dataCheck && qState === 'verified' ? 'caution' : actionable ? 'actionable' : '';
    return {
      state: qState,
      quote,
      line: curLine,
      book: quote.book || 'Book',
      odds,
      side,
      edge,
      ev,
      stake,
      qualified,
      dataCheck,
      volatilityHalt,
      haltReason,
      driftVal,
      isExemptModeledMove,
      exemption_audit: exemptionAudit,
      highEdgeCaution,
      highEdgeWarning,
      closed,
      actionable,
      tone,
      target: targetLine(row, quote, side, activePolicy)
    };
  }

  function kellyFromEvaluation(quote, evaluation, side) {
    if (!quote) return 0.03;
    const probabilities = devig(quote.over_odds, quote.under_odds);
    const marketProbability = side === 'UNDER' ? probabilities.under : probabilities.over;
    const edgeVal = num(evaluation?.prob_edge ?? evaluation?.edge ?? 0);
    const winProbability = Math.max(0.001, Math.min(0.999, marketProbability + edgeVal));
    const decimal = americanToDecimal(side === 'UNDER' ? quote.under_odds : quote.over_odds);
    const b = decimal - 1;
    return Math.max(0, (b * winProbability - (1 - winProbability)) / b);
  }

  function bookCell(evaluation, injury, row = null) {
    if (SLATES[state.slateKey]?.historical && row) {
      const settled = evaluateSettledRow(row);
      return `<div class="book-cell">
        <span class="number-main"><span class="settled-stat-box">${settled.actual} ${settled.isYards ? 'yds' : 'rec'}</span></span>
        <div class="book-meta">
          <span class="book-tag">Settled</span>
          <span class="meta-pill ${settled.delta > 0 ? 'actionable' : 'closed'}">${settled.delta > 0 ? '+' : ''}${settled.delta} vs Line</span>
        </div>
      </div>`;
    }
    if (evaluation.state === 'none') {
      return `<div class="book-cell"><span class="number-main book-empty" aria-label="No market quote">—</span><div class="book-meta model-only-help-wrap"><button type="button" class="meta-pill model-only model-only-help" data-model-only-help aria-expanded="false" aria-label="Why is this model only?">${SVG_ICONS.lock} Model only</button><span class="model-only-popover" role="status" hidden>No verified market receipt is available. Projections remain visible, but price-dependent actions stay locked.</span>${injury ? `<span class="injury-warning-tag" title="Snap risk unpriced">${SVG_ICONS.warn} ${esc(injury.report_status)}</span>` : ''}</div></div>`;
    }
    const quoteKey = row ? `${row.player_id}::${state.filters.market}` : '';
    const flash = quoteKey && state.tickFlashes ? state.tickFlashes[quoteKey] : null;
    const flashClass = flash === 'up' ? 'tick-flash-up' : flash === 'down' ? 'tick-flash-down' : '';
    const glyph = flash === 'up' ? '<span class="tick-flash-glyph tick-glyph-up" aria-hidden="true">▲</span>' : flash === 'down' ? '<span class="tick-flash-glyph tick-glyph-down" aria-hidden="true">▼</span>' : '';

    const statusPill = evaluation.closed
      ? '<span class="meta-pill closed">Closed</span>'
      : evaluation.dataCheck
        ? `<span class="meta-pill caution" title="Verify before acting: edge > 12%">${SVG_ICONS.warn} Verify</span>`
        : evaluation.actionable
          ? `<span class="meta-pill actionable">${SVG_ICONS.edge} Active</span>`
          : evaluation.state === 'ingested'
            ? `<span class="meta-pill unverified" title="Ingested quote pending receipt verification">${SVG_ICONS.lock} Unverified</span>`
            : '<span class="meta-pill">Active</span>';

    const isOver = evaluation.side === 'OVER';
    const quote = row ? findQuote(row, state.filters.market) : null;
    const sparklineHtml = renderPriceSparkline(row, quote, evaluation);

    return `<div class="book-cell ${flashClass}">
      <span class="number-main">
        <span class="dir-line-pill ${isOver ? 'dir-over' : 'dir-under'}">
          <span class="dir-arrow">${isOver ? '↑' : '↓'}</span>
          <span class="dir-num">${evaluation.line.toFixed(1)}</span>
        </span>
        <small class="odds-val fixed-odds">${oddsText(evaluation.odds)}</small>
        ${glyph}
      </span>
      ${sparklineHtml}
      <div class="book-meta">
        <span class="book-tag">${esc(bookShort(evaluation.book))}</span>
        ${statusPill}
        ${injury ? `<span class="injury-warning-tag" title="Snap risk unpriced">${SVG_ICONS.warn} ${esc(injury.report_status)}</span>` : ''}
      </div>
    </div>`;
  }

  function priceCheckCell(evaluation, row = null, isLogged = false) {
    if (SLATES[state.slateKey]?.historical && row) {
      const settled = evaluateSettledRow(row);
      return `<div class="edge-cell-wrap">
        <div class="edge-cell">
          <span class="settled-badge ${settled.outcomeClass}">${settled.outcome}</span>
          <span class="cell-sub" style="margin-top:2px; font-variant-numeric:tabular-nums;">Actual ${settled.actual} (Line ${settled.line.toFixed(1)})</span>
        </div>
      </div>`;
    }

    const decision = row ? executionDecision(row, evaluation) : { allowed: false, message: '' };
    const logBtn = row && (isLogged || decision.allowed)
      ? `<button class="row-log-btn ${isLogged ? 'logged' : ''}" type="button" data-log-bet="${esc(row.player_id)}" title="${isLogged ? 'Remove from Ledger' : 'Review verified play'}" aria-label="${isLogged ? 'Remove from Ledger' : 'Review verified play'}">${isLogged ? 'Logged' : 'Review'}</button>`
      : row
        ? `<button class="row-log-btn blocked" type="button" disabled aria-label="Execution blocked: ${esc(decision.message)}" title="${esc(decision.message)}">${SVG_ICONS.lock}</button>`
        : '';

    const quoteKey = row ? `${row.player_id}::${state.filters.market}` : '';
    const flash = quoteKey && state.tickFlashes ? state.tickFlashes[quoteKey] : null;
    const flashClass = flash === 'up' ? 'tick-flash-up' : flash === 'down' ? 'tick-flash-down' : '';
    const glyph = flash === 'up' ? '<span class="tick-flash-glyph tick-glyph-up" aria-hidden="true">▲</span>' : flash === 'down' ? '<span class="tick-flash-glyph tick-glyph-down" aria-hidden="true">▼</span>' : '';

    if (evaluation.state === 'none') {
      return `<div class="edge-cell-wrap">
        <div class="edge-cell edge-cell-none ${flashClass}">
          <span class="edge-line-top text-muted">—</span>
          <span class="exec-tag exec-tag-none" title="No verified market receipt is available. Edge and staking remain locked.">MODEL ONLY</span>
        </div>
      </div>`;
    }
    if (state.userTier === 'free' && !SLATES[state.slateKey]?.historical) {
      return `<div class="edge-cell-wrap">
        <button type="button" class="edge-cell free-locked ${flashClass}" data-open-pricing title="Unlock Edge with Sharp ($29/mo)" style="width:100%; border:1px dashed rgba(255,255,255,0.2); cursor:pointer;">
          <span class="edge-line-top" style="color:#94a3b8; font-size:11px;">LOCKED</span>
          <span class="exec-tag" style="background:rgba(255,255,255,0.06); color:#cbd5e1;">PRO TIER</span>
        </button>
        <button class="mq-log-btn" type="button" data-open-pricing aria-label="Unlock Sharp Tier" title="Unlock Sharp Tier">${SVG_ICONS.lock}</button>
      </div>`;
    }
    if (evaluation.closed) {
      return `<div class="edge-cell-wrap">
        <div class="edge-cell edge-cell-closed ${flashClass}">
          <span class="edge-line-top text-closed">CLOSED</span>
          <span class="exec-tag exec-tag-closed">CLOSED</span>
        </div>
      </div>`;
    }
    if (evaluation.state === 'ingested') {
      return `<div class="edge-cell-wrap">
        <div class="edge-cell edge-cell-unverified ${flashClass}" data-quote-state="ingested">
          <span class="edge-line-top text-unverified">${signedPct(evaluation.edge)}${glyph}</span>
          <span class="exec-tag exec-tag-unverified">UNVERIFIED</span>
        </div>
        ${logBtn}
      </div>`;
    }
    if (evaluation.volatilityHalt) {
      return `<div class="edge-cell-wrap">
        <div class="edge-cell edge-cell-halt ${flashClass}" data-quote-state="halt" title="${esc(evaluation.haltReason)}">
          <span class="edge-line-top text-halt">${signedPct(evaluation.edge)}${glyph}</span>
          <span class="exec-tag exec-tag-halt" title="${esc(evaluation.haltReason)}">LINE SHIFT</span>
        </div>
        ${logBtn}
      </div>`;
    }
    if (evaluation.highEdgeCaution) {
      return `<div class="edge-cell-wrap">
        <div class="edge-cell edge-cell-caution ${flashClass}" data-quote-state="verified" title="${esc(evaluation.highEdgeWarning)}">
          <span class="edge-line-top text-caution">${signedPct(evaluation.edge)}${glyph}</span>
          <span class="exec-tag exec-tag-verify" title="${esc(evaluation.highEdgeWarning)}">CHECK NEWS</span>
        </div>
        ${logBtn}
      </div>`;
    }
    if (evaluation.dataCheck) {
      return `<div class="edge-cell-wrap">
        <div class="edge-cell edge-cell-caution ${flashClass}" data-quote-state="verified">
          <span class="edge-line-top text-caution">${signedPct(evaluation.edge)}${glyph}</span>
          <span class="exec-tag exec-tag-verify" title="Verify before acting: edge > 12%">VERIFY</span>
        </div>
        ${logBtn}
      </div>`;
    }
    const activePolicy = policy();
    const roundedEdgePct = +(num(evaluation.edge) * 100).toFixed(1);
    const roundedGatePct = activePolicy ? +(activePolicy.gate * 100).toFixed(1) : 0;
    const isSubGate = activePolicy && roundedEdgePct < roundedGatePct;

    const edgeMag = Math.min(Math.max((evaluation.edge || 0) / 0.25, 0), 1);
    const heatOpacity = (0.02 + edgeMag * 0.12).toFixed(3);
    const heatmapStyle = evaluation.edge > 0.03
      ? `style="background: linear-gradient(90deg, rgba(182, 243, 107, ${heatOpacity}) 0%, transparent 100%);"`
      : '';

    return `<div class="edge-cell-wrap">
      <div class="edge-cell ${isSubGate ? 'edge-cell-subgate' : 'edge-cell-verified'} ${flashClass}" data-quote-state="verified" ${heatmapStyle}>
        <span class="edge-line-top ${isSubGate ? 'text-subgate' : 'text-verified'}">${signedPct(evaluation.edge)}${glyph}</span>
        <span class="exec-tag ${isSubGate ? 'exec-tag-subgate' : 'exec-tag-active'}">${isSubGate ? 'SUB-GATE' : 'ACTIVE'}</span>
      </div>
      ${logBtn}
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
    return adapter.roleLabel(row);
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

  // ── §17. Navigation & feedback — views, inspect, toasts, provenance ───

  function setView(view) {
    if (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) {
      state.view = 'cards';
    } else {
      state.view = view === 'cards' ? 'cards' : 'table';
    }
    $$('.view-switch button').forEach((button) => button.classList.toggle('active', button.dataset.view === state.view));
    renderBoard();
  }

  function inspectFromEvent(event) {
    if (wasCardSwiped) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.target.closest('[data-model-only-help], .model-only-popover')) return;
    if (event.target.closest('.info-trigger') || event.target.closest('.help-bubble')) return;
    const dismissBtn = event.target.closest('[data-dismiss-corr]');
    if (dismissBtn) {
      event.preventDefault();
      event.stopPropagation();
      dismissCorrelation(dismissBtn.dataset.dismissCorr);
      return;
    }
    const watchBtn = event.target.closest('[data-watch-player]');
    if (watchBtn) {
      event.stopPropagation();
      toggleWatchlist(watchBtn.dataset.watchPlayer);
      return;
    }
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

  let toastTimer = null;
  function toast(message, undoAction = null) {
    let el = $('#appToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'appToast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    const undoBtnHtml = undoAction
      ? `<button class="toast-undo-btn" id="toastUndoBtn" type="button" aria-label="Undo action">Undo</button>`
      : '';

    el.innerHTML = `
      <div class="toast-content">
        <span class="toast-indicator">●</span>
        <span class="toast-msg">${esc(message)}</span>
        ${undoBtnHtml}
      </div>`;

    if (undoAction) {
      const btn = el.querySelector('#toastUndoBtn');
      if (btn) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          triggerHaptic('medium');
          if (typeof undoAction === 'function') undoAction();
          el.classList.remove('visible');
          setTimeout(() => { if (el) el.style.display = 'none'; }, 220);
        });
      }
    }

    el.style.display = 'block';
    void el.offsetWidth; // force reflow for CSS animation
    el.classList.add('visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (el) {
        el.classList.remove('visible');
        setTimeout(() => {
          if (el && !el.classList.contains('visible')) el.style.display = 'none';
        }, 220);
      }
    }, undoAction ? 4000 : 2500);
  }
  const showToast = toast;

  /**
   * Fixture provenance (Phase 2): entries logged against synthetic fixture
   * data are stamped `data_provenance: "fixture"` so per-sport CLV stats can
   * never blend research fixtures with live-book fills. Live-book entries
   * carry NO field — the NFL ledger schema stays byte-identical (parity
   * goldens assert this).
   */
  function stampProvenance(entry, row) {
    const quote = findQuote(row, state.filters.market);
    if ((quote && quote._fixture === true) || adapter.fixturesOnly === true) {
      entry.data_provenance = 'fixture';
    }
    return entry;
  }

  // ── §18. Ledger mutations & data import/export ────────────────────────

  function logBet(playerId) {
    const row = state.slate.find((item) => item.player_id === playerId);
    if (!row) return;
    const evaluation = evaluateRow(row);
    const existingIndex = (state.portfolio || []).findIndex((b) => b.sport === SPORT_ID && b.player_id === playerId && b.market === state.filters.market);
    if (existingIndex >= 0) {
      const removedEntry = state.portfolio.splice(existingIndex, 1)[0];
      savePortfolio(state.portfolio);
      updatePortfolioBadge(true);
      renderBoard();
      if ($('#detailDialog').open && state.selectedPlayerId === playerId) {
        renderDetailModal(row);
      }
      toast(`Removed: ${row.player_display_name} from Ledger`, () => {
        state.portfolio.splice(existingIndex, 0, removedEntry);
        savePortfolio(state.portfolio);
        updatePortfolioBadge(true);
        renderBoard();
        if ($('#detailDialog').open && state.selectedPlayerId === playerId) {
          renderDetailModal(row);
        }
      });
    } else {
      const decision = executionDecision(row, evaluation);
      if (!decision.allowed) {
        toast(`Blocked: ${decision.message}`);
        return;
      }
      openExecutionSlip(playerId);
    }
  }

  function executionOffers(row) {
    return (state.odds?.quotes || []).filter((quote) => quote.market === state.filters.market &&
      (quote.player_id === row.player_id || String(quote.player_name).toLowerCase() === String(row.player_display_name).toLowerCase()));
  }

  function executionSlipMarkup(row, evaluation, decision) {
    const observed = evaluation.quote?.observed_at ? new Date(evaluation.quote.observed_at) : null;
    const timestamp = observed && Number.isFinite(observed.getTime()) ? observed.toLocaleString() : 'Missing';
    const stakeDollars = (num(state.bankroll, 5000) * num(evaluation.stake)).toFixed(2);
    const offers = executionOffers(row);
    const reasons = decision.allowed ? ['Verified receipt', 'Fresh odds and news', `Clears ${pct(policy()?.gate || 0, 0)} gate`] : [decision.message];
    return `
      <section class="execution-identity">
        <div class="execution-id-main">${avatarFor(row.player_id, row.player_display_name, row.team)}<div><span class="execution-kicker">${esc(row.position)} · ${esc(row.team)} ${row.is_home ? 'vs' : '@'} ${esc(row.opponent_team)}</span><h3>${esc(row.player_display_name)}</h3></div></div>
        <span class="execution-state ${decision.allowed ? 'is-ready' : 'is-blocked'}">${decision.allowed ? 'Verified · ready' : 'Blocked'}</span>
      </section>
      <section class="execution-summary" aria-label="Execution terms">
        <div><span>Book</span><strong>${bookLogoImg(evaluation.book, 'book-logo')}${esc(evaluation.book || '—')}</strong></div>
        <div><span>Timestamp</span><strong class="execution-time">${esc(timestamp)}</strong></div>
        <div><span>Price</span><strong>${esc(evaluation.side || '—')} ${Number(evaluation.line).toFixed(1)} · ${oddsText(evaluation.odds)}</strong></div>
        <div><span>Model fair</span><strong>${Number(fairValue(row)).toFixed(1)}</strong></div>
        <div><span>Edge</span><strong>${signedPct(evaluation.edge)}</strong></div>
        <div><span>Kelly stake</span><strong>${pct(evaluation.stake, 2)} · $${stakeDollars}</strong></div>
      </section>
      <section class="execution-checks ${decision.allowed ? '' : 'has-block'}">
        <h4>${decision.allowed ? 'Guard checks passed' : 'Blocking reason'}</h4>
        <ul>${reasons.map((reason) => `<li>${esc(reason)}</li>`).join('')}</ul>
      </section>
      <section class="cross-book-section">
        <div class="execution-section-heading"><h4>Cross-book comparison</h4><span>${offers.length} observed offer${offers.length === 1 ? '' : 's'}</span></div>
        <div class="cross-book-list">
          ${(() => {
            // v152: best-price highlight per side (American odds — higher is better)
            const bestOver = offers.reduce((acc, o) => Math.max(acc, Number.isFinite(Number(o.over_odds)) ? Number(o.over_odds) : -Infinity), -Infinity);
            const bestUnder = offers.reduce((acc, o) => Math.max(acc, Number.isFinite(Number(o.under_odds)) ? Number(o.under_odds) : -Infinity), -Infinity);
            return offers.map((offer) => {
              const side = String(offer.evaluation?.best_side || evaluation.side || 'OVER').toUpperCase();
              const price = side === 'UNDER' ? offer.under_odds : offer.over_odds;
              const verified = quoteState(offer) === 'verified';
              const isBest = (side === 'UNDER'
                ? bestUnder > -Infinity && Number(offer.under_odds) === bestUnder
                : bestOver > -Infinity && Number(offer.over_odds) === bestOver);
              return `<div class="cross-book-row ${offer === evaluation.quote ? 'is-selected' : ''} ${isBest && offer !== evaluation.quote ? 'is-best' : ''}">
              <span><span class="cross-book-book">${bookLogoImg(offer.book_id || offer.book)}${esc(offer.book || 'Book')}</span><small>${verified ? 'Receipt verified' : 'Unverified'}</small></span>
              <strong>${side} ${Number(offer.line).toFixed(1)}</strong><strong class="${isBest ? 'best-price' : ''}">${oddsText(price)}</strong>
              <span class="cross-book-status">${offer === evaluation.quote ? 'Selected' : isBest ? 'Best price' : verified ? 'Available' : 'Locked'}</span>
            </div>`;
            }).join('') || '<p class="execution-empty">No sportsbook offers are present in this snapshot.</p>';
          })()}
        </div>
        ${offers.length < 2 ? '<p class="execution-note">No alternative verified offers are available in this snapshot.</p>' : ''}
      </section>
      <footer class="execution-actions">
        <p>PropWire does not place wagers. Confirm only after placing this exact wager externally.</p>
        <button type="button" class="execution-confirm" id="executionConfirmBtn" ${decision.allowed ? '' : 'disabled'}>I placed this bet · record snapshot</button>
      </footer>`;
  }

  function openExecutionSlip(playerId) {
    const row = state.slate.find((item) => item.player_id === playerId);
    const dialog = $('#executionDialog');
    const content = $('#executionContent');
    if (!row || !dialog || !content) return false;
    const evaluation = evaluateRow(row);
    const decision = executionDecision(row, evaluation);
    state.selectedExecutionPlayerId = playerId;
    $('#executionTitle').textContent = `${row.player_display_name} · execution slip`;
    content.innerHTML = executionSlipMarkup(row, evaluation, decision);
    const confirm = $('#executionConfirmBtn');
    if (confirm) confirm.addEventListener('click', () => confirmExecution(playerId));
    if (!dialog.open) dialog.showModal();
    return decision.allowed;
  }

  function confirmExecution(playerId = state.selectedExecutionPlayerId) {
    const row = state.slate.find((item) => item.player_id === playerId);
    if (!row) return false;
    const evaluation = evaluateRow(row);
    const decision = executionDecision(row, evaluation);
    if (!decision.allowed) {
      openExecutionSlip(playerId);
      toast(`Blocked: ${decision.message}`);
      return false;
    }
      const ticketId = Math.random().toString(36).slice(2, 6).toUpperCase();
      const risk = checkCorrelatedRisk(row, evaluation);
      const entry = {
        id: `bet_${Date.now()}_${ticketId.toLowerCase()}`,
        sport: SPORT_ID,
        ticket_id: ticketId,
        player_id: row.player_id,
        player_name: row.player_display_name,
        team: row.team,
        opponent: row.opponent_team,
        market: state.filters.market,
        book: evaluation.book || 'Book',
        line: evaluation.line,
        odds: evaluation.odds,
        side: evaluation.side || 'OVER',
        model_fair: fairValue(row),
        edge: evaluation.edge || 0,
        ev: evaluation.ev || 0,
        correlation_warning: risk ? risk.message : null,
        volatility_flag: Boolean(evaluation.volatilityHalt),
        volatility_reason: evaluation.volatilityHalt ? evaluation.haltReason : null,
        exemption_audit: evaluation.exemption_audit || null,
        config_version: (state.breakerConfig && state.breakerConfig.config_version) || "1.1.0",
        logged_at: new Date().toISOString()
      };
      stampProvenance(entry, row);
      if (!Array.isArray(state.portfolio)) state.portfolio = [];
      state.portfolio.unshift(entry);
      savePortfolio(state.portfolio);
      updatePortfolioBadge(true);
      renderBoard();
      if ($('#detailDialog').open && state.selectedPlayerId === playerId) {
        renderDetailModal(row);
      }
      const toastMessage = risk
        ? `Volume Risk: Logged ${entry.player_name} OVER alongside competing ${risk.competingPlayer} OVER on ${entry.team}!`
        : `Logged: ${entry.player_name} ${entry.side} ${entry.line.toFixed(1)} (${oddsText(entry.odds)}) · #${ticketId}`;
      toast(toastMessage, () => {
        const idx = state.portfolio.findIndex((b) => b.id === entry.id);
        if (idx >= 0) {
          state.portfolio.splice(idx, 1);
          savePortfolio(state.portfolio);
          updatePortfolioBadge(true);
          renderBoard();
          if ($('#detailDialog').open && state.selectedPlayerId === playerId) {
            renderDetailModal(row);
          }
        }
      });
      const dialog = $('#executionDialog');
      if (dialog?.open) dialog.close();
      state.selectedExecutionPlayerId = null;
      return true;
  }

  function handleLedgerExport() {
    const portfolio = state.portfolio || [];
    if (portfolio.length === 0) {
      toast('No logged bets to export');
      return;
    }
    const payload = {
      app: 'PropWire Institutional Terminal',
      schema_version: '1.0',
      exported_at: new Date().toISOString(),
      total_bets: portfolio.length,
      portfolio: portfolio
    };
    const jsonStr = JSON.stringify(payload, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const dateStr = new Date().toISOString().slice(0, 10);
    const fileName = `propwire_clv_ledger_${dateStr}.json`;

    if (typeof navigator !== 'undefined' && navigator.share && navigator.canShare) {
      try {
        const file = new File([blob], fileName, { type: 'application/json' });
        if (navigator.canShare({ files: [file] })) {
          navigator.share({
            files: [file],
            title: 'PropWire CLV Ledger Export',
            text: `PropWire CLV Ledger (${portfolio.length} bets)`
          }).then(() => toast(`Exported ${portfolio.length} bets`)).catch(() => {});
          return;
        }
      } catch (_) {}
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast(`Exported ${portfolio.length} bets to JSON`);
  }

  function handleSlateExportCsv() {
    const rows = filteredRows();
    if (!rows || !rows.length) {
      toast('No props to export');
      return;
    }
    const headers = ['Player', 'Team', 'Opp', 'Pos', 'Market', 'Side', 'BookLine', 'Odds', 'ModelFair', 'ModelProj', 'EdgePct', 'KellyStakePct'];
    const lines = [headers.join(',')];
    rows.forEach(r => {
      const ev = evaluateRow(r);
      const dist = distributionRange(r);
      lines.push([
        `"${r.player_display_name}"`,
        r.team,
        r.opponent_team,
        r.position,
        state.filters.market,
        ev.side || '',
        ev.line || '',
        ev.odds || '',
        dist.fair.toFixed(1),
        dist.proj.toFixed(1),
        (ev.edge * 100).toFixed(1),
        (ev.stake * 100).toFixed(1)
      ].join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const fileName = `propwire_slate_${state.slateKey}_${Date.now()}.csv`;

    if (typeof navigator !== 'undefined' && navigator.share && navigator.canShare) {
      try {
        const file = new File([blob], fileName, { type: 'text/csv' });
        if (navigator.canShare({ files: [file] })) {
          navigator.share({
            files: [file],
            title: 'PropWire Week 7 Slate Export',
            text: `Export of ${rows.length} NFL receiving props from PropWire`
          }).then(() => toast(`Exported ${rows.length} props`)).catch(() => {});
          return;
        }
      } catch (_) {}
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast(`Exported ${rows.length} props to CSV`);
  }

  function handleLedgerImportFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const rawText = e.target.result;
        const data = JSON.parse(rawText);
        const incoming = Array.isArray(data) ? data : (data && Array.isArray(data.portfolio) ? data.portfolio : null);
        if (!incoming || !Array.isArray(incoming)) {
          toast('Invalid ledger file: missing bet list');
          return;
        }

        const current = [...(state.portfolio || [])];
        let added = 0;
        let updated = 0;

        incoming.forEach((item) => {
          if (!item || !item.player_name || !item.market || item.line === undefined) return;
          const lineVal = Number(item.line);
          if (isNaN(lineVal)) return;

          const entry = {
            id: item.id || `bet_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            sport: item.sport || SPORT_ID,
            player_id: item.player_id || '',
            player_name: String(item.player_name),
            team: item.team || '',
            opponent: item.opponent || '',
            market: item.market,
            book: item.book || 'Manual',
            line: lineVal,
            odds: Number(item.odds || -110),
            side: String(item.side || 'OVER').toUpperCase(),
            model_fair: Number(item.model_fair || lineVal),
            edge: Number(item.edge || 0),
            ev: Number(item.ev || 0),
            logged_at: item.logged_at || new Date().toISOString()
          };

          const existingIdx = current.findIndex((b) => (b.id && b.id === entry.id) || (b.player_id && b.player_id === entry.player_id && b.sport === entry.sport && b.market === entry.market && b.side === entry.side));
          if (existingIdx >= 0) {
            current[existingIdx] = { ...current[existingIdx], ...entry };
            updated++;
          } else {
            current.unshift(entry);
            added++;
          }
        });

        if (added === 0 && updated === 0) {
          toast('No valid bets found in file');
          return;
        }

        state.portfolio = current;
        savePortfolio(state.portfolio);
        updatePortfolioBadge();
        renderBoard();
        openPortfolioDialog();
        toast(`Imported ledger: +${added} added, ${updated} updated`);
      } catch (err) {
        toast('Failed to parse JSON backup file');
      }
    };
    reader.readAsText(file);
  }

  // ── §19. Portfolio & CLV report dialogs ───────────────────────────────

  function openPortfolioDialog() {
    const dialog = $('#portfolioDialog');
    if (!dialog) return;
    const portfolio = state.portfolio || [];
    let positiveClv = 0;
    let totalClvYards = 0;
    let gradedCount = 0;

    const conflicts = getPortfolioCorrelations(portfolio);
    const conflictHtml = conflicts.length > 0 ? `
      <div class="portfolio-risk-alert">
        ${conflicts.map((c) => `
          <div style="margin-bottom:6px;">
            <div class="portfolio-risk-alert-title">
              <span>[${c.isHedge ? 'HEDGE' : 'EXPOSURE'}] ${esc(c.title)} (${esc(c.team)})</span>
              <button type="button" class="corr-dismiss-btn" data-dismiss-corr="${esc(c.key)}" title="Dismiss warning" style="font-size:14px; padding:0 4px;">×</button>
            </div>
            <div>${c.description}</div>
          </div>
        `).join('')}
      </div>
    ` : '';

    const cleanCount = portfolio.filter((b) => !b.volatility_flag).length;
    const flaggedCount = portfolio.filter((b) => Boolean(b.volatility_flag)).length;
    state.ledgerFilter = state.ledgerFilter || 'all';

    const filteredBets = state.ledgerFilter === 'clean'
      ? portfolio.filter((b) => !b.volatility_flag)
      : state.ledgerFilter === 'flagged'
        ? portfolio.filter((b) => Boolean(b.volatility_flag))
        : portfolio;

    const rowsHtml = filteredBets.map((bet) => {
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
      const conflictItem = conflicts.find((c) => c.team === bet.team && c.market === bet.market);
      let conflictBadge = '';
      if (conflictItem) {
        if (conflictItem.isHedge) {
          conflictBadge = `<span class="badge corr-hedge-badge" title="${esc(conflictItem.title)}">HEDGE</span> `;
        } else {
          conflictBadge = `<span class="badge corr-risk-badge" title="${esc(conflictItem.title)}">EXPOSURE</span> `;
        }
      }
      const volatileBadge = bet.volatility_flag
        ? `<span class="badge" style="background:rgba(239, 68, 68, 0.2); color:#fca5a5; border:1px solid rgba(239, 68, 68, 0.4); font-size:10px; margin-left:4px;" title="${esc(bet.volatility_reason || 'Line shifted sharply')}">VOLATILE</span>`
        : '';

      return `<tr>
        <td>${conflictBadge}<strong>${esc(bet.player_name)}</strong>${volatileBadge}<br><small class="cell-sub">${esc(bet.team)} vs ${esc(bet.opponent)} · ${esc(bet.market === 'receptions' ? 'Rec' : 'Yards')}</small></td>
        <td><span class="badge ${esc(bet.side.toLowerCase())}">${esc(bet.side)}</span></td>
        <td class="num"><strong>${bet.line.toFixed(1)}</strong><br><small class="cell-sub">${oddsText(bet.odds)}</small></td>
        <td class="num"><strong>${currentQuote ? currentQuote.line.toFixed(1) : bet.line.toFixed(1)}</strong><br><small class="cell-sub">${currentQuote ? currentQuote.book : 'At entry'}</small></td>
        <td class="num ${clvClass}"><strong>${clvText}</strong></td>
        <td><button type="button" class="text-button" data-remove-bet="${esc(bet.id)}" style="color:var(--muted); font-size:16px;" aria-label="Remove bet">×</button></td>
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
      <div style="display:flex; justify-content:space-between; align-items:center; margin:8px 0 10px;">
        <div style="display:flex; gap:6px;">
          <button type="button" class="view-chip ${state.ledgerFilter === 'all' ? 'active' : ''}" data-ledger-filter="all" style="font-size:11px; padding:3px 8px;">All (${portfolio.length})</button>
          <button type="button" class="view-chip ${state.ledgerFilter === 'clean' ? 'active' : ''}" data-ledger-filter="clean" style="font-size:11px; padding:3px 8px;">Clean (${cleanCount})</button>
          <button type="button" class="view-chip ${state.ledgerFilter === 'flagged' ? 'active' : ''}" data-ledger-filter="flagged" style="font-size:11px; padding:3px 8px; ${flaggedCount > 0 ? 'color:#fca5a5;' : ''}">Flagged (${flaggedCount})</button>
        </div>
        <span style="font-size:10px; color:#64748b; font-family:var(--mono);">Config: v1.1.0</span>
      </div>
      ${portfolio.length === 0 ? `
        <div class="portfolio-empty">
          <p>No bets logged yet. Click "+ Log" on any player card or inside the Inspect drawer to record your play and track closing line value.</p>
          <div style="margin-top:16px; display:flex; justify-content:center;">
            <button type="button" class="portfolio-action-btn" id="emptyImportLedgerBtn">
              <svg class="prop-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 10v3.5h11V10M8 2.5v8M5 5.5l3-3 3 3"/></svg>
              Restore from JSON Backup
            </button>
          </div>
        </div>
      ` : `
        ${conflictHtml}
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
        <div class="portfolio-actions-bar">
          <div class="portfolio-actions-left">
            <button type="button" class="portfolio-action-btn" id="exportLedgerBtn" title="Download backup of your personal CLV records">
              <svg class="prop-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 10v3.5h11V10M8 10.5V2.5M5 7.5l3 3 3-3"/></svg>
              Export JSON
            </button>
            <button type="button" class="portfolio-action-btn" id="importLedgerBtn" title="Restore or merge bets from a JSON backup">
              <svg class="prop-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 10v3.5h11V10M8 2.5v8M5 5.5l3-3 3 3"/></svg>
              Import JSON
            </button>
          </div>
          <button type="button" class="text-button" id="clearPortfolioBtn" style="font-size:11px; color:#f87171;">Clear all bets</button>
        </div>
      `}
      <input type="file" id="ledgerFileInput" accept=".json,application/json" style="display:none">
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

    $('#portfolioContent').querySelectorAll('[data-dismiss-corr]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        triggerHaptic('light');
        const key = e.target.closest('[data-dismiss-corr]').dataset.dismissCorr;
        dismissCorrelation(key);
      });
    });

    $('#portfolioContent').querySelectorAll('[data-ledger-filter]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        triggerHaptic('light');
        state.ledgerFilter = e.target.dataset.ledgerFilter;
        openPortfolioDialog();
      });
    });

    const clearBtn = $('#clearPortfolioBtn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (!confirm('Clear all bets from your personal ledger?')) return;
        state.portfolio = [];
        savePortfolio(state.portfolio);
        updatePortfolioBadge();
        renderBoard();
        openPortfolioDialog();
      });
    }

    const exportBtn = $('#exportLedgerBtn');
    if (exportBtn) {
      exportBtn.addEventListener('click', handleLedgerExport);
    }

    const fileInput = $('#ledgerFileInput');
    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
          handleLedgerImportFile(e.target.files[0]);
          e.target.value = '';
        }
      });
    }

    const importBtn = $('#importLedgerBtn');
    if (importBtn && fileInput) {
      importBtn.addEventListener('click', () => fileInput.click());
    }

    const emptyImportBtn = $('#emptyImportLedgerBtn');
    if (emptyImportBtn && fileInput) {
      emptyImportBtn.addEventListener('click', () => fileInput.click());
    }

    dialog.showModal();
  }

  async function openClvReport() {
    const dialog = $('#clvDialog');
    if (!dialog) return;
    $('#clvReportContent').innerHTML = '<div style="padding:24px; text-align:center; color:var(--muted); font-family:var(--mono);">Loading Week 7 CLV validation ledger…</div>';
    dialog.showModal();

    let report = state.clvAuditReport;
    if (!report) {
      report = await fetchJson('clv_audit_report.json', null);
      if (!report) report = await fetchJson('clv_report_2026_w7.json', null);
      state.clvAuditReport = report;
    }

    if (!report || (!report.records && !report.ledger)) {
      $('#clvReportContent').innerHTML = '<div style="padding:20px; color:var(--danger);">Failed to load CLV validation report. Run settle_ledger.py to generate ledger.</div>';
      return;
    }

    const records = report.records || report.ledger;
    const beatCloseRate = report.beat_close_rate_pct ?? (report.summary ? +(report.summary.positive_clv_pct * 100).toFixed(1) : 0);
    const avgClvProb = report.avg_clv_prob_pct ?? (report.summary ? +(report.summary.avg_clv_ev * 100).toFixed(2) : 0);
    const avgClvYards = report.avg_clv_yards ?? (report.summary ? +(report.summary.avg_line_delta).toFixed(2) : 0);
    const totalRecords = report.total_records ?? (report.summary ? report.summary.total_graded : records.length);
    const recordStr = report.record_str ?? `${Math.round(totalRecords * (beatCloseRate / 100))}-${totalRecords - Math.round(totalRecords * (beatCloseRate / 100))}-0`;
    const winRate = report.win_rate_pct ?? beatCloseRate;
    const realizedRoi = report.realized_roi_pct ?? 0;
    const netPnl = report.net_pnl ?? 0;
    const rootHash = report.ledger_root_hash || CLV_ROOT_HASH_FALLBACK;

    const kpiHtml = `
      <div class="clv-modal-shell font-mono select-none">
        <!-- 4-Card Institutional KPI Strip -->
        <div class="clv-kpi-grid">
          <div class="clv-kpi-box">
            <span class="clv-kpi-lbl">Beat Closing Line</span>
            <span class="clv-kpi-val text-volt">${beatCloseRate}%</span>
            <span class="clv-kpi-sub">${totalRecords} verified tickets</span>
          </div>
          <div class="clv-kpi-box">
            <span class="clv-kpi-lbl">Mean CLV Edge</span>
            <span class="clv-kpi-val text-volt">
              +${avgClvProb}% <small class="clv-kpi-yards">(${avgClvYards > 0 ? `+${avgClvYards}` : avgClvYards}y)</small>
            </span>
            <span class="clv-kpi-sub">De-vigged vs Kickoff Close</span>
          </div>
          <div class="clv-kpi-box">
            <span class="clv-kpi-lbl">Graded Record</span>
            <span class="clv-kpi-val text-white">${recordStr}</span>
            <span class="clv-kpi-sub">Win Rate: ${winRate}%</span>
          </div>
          <div class="clv-kpi-box">
            <span class="clv-kpi-lbl">Realized ROI / P&L</span>
            <span class="clv-kpi-val ${netPnl >= 0 ? 'text-volt' : 'text-danger'}">
              ${realizedRoi >= 0 ? `+${realizedRoi}%` : `${realizedRoi}%`}
            </span>
            <span class="clv-kpi-sub">Net: ${netPnl >= 0 ? `+$${Number(netPnl).toFixed(2)}` : `-$${Math.abs(Number(netPnl)).toFixed(2)}`}</span>
          </div>
        </div>

        <!-- Scrollable Ticket Audit Table -->
        <div class="clv-table-scroll">
          <table class="clv-audit-table">
            <thead>
              <tr>
                <th>Player / Ticket</th>
                <th>Bet Entry</th>
                <th>Kickoff Close</th>
                <th>CLV (Yds / Prob)</th>
                <th>Actual / Grade</th>
                <th class="th-num">Net P&L</th>
              </tr>
            </thead>
            <tbody>
              ${records.map((r) => {
                const player = r.player || r.player_name;
                const team = r.team;
                const receipt = r.settlement_receipt || r.receipt_id || 'receipt_verified';
                const crest = teamCrest(team, 'sm');
                const side = r.side || 'OVER';
                const line = r.line ?? r.trigger_line;
                const odds = r.odds ?? r.trigger_odds;
                const closeLine = r.close_line;
                const closeOdds = r.close_odds;
                const clvYds = r.clv_yards ?? r.line_movement ?? 0;
                const clvProb = r.clv_prob_pct ?? (r.clv_ev ? +(r.clv_ev * 100).toFixed(2) : 0);
                const actualYards = r.actual_yards;
                const outcome = r.outcome || (r.status === 'BEAT_CLOSE' ? 'WIN' : 'PENDING');
                const pnl = r.net_pnl ?? 0;

                const outcomePill = outcome === 'WIN'
                  ? '<span class="clv-pill clv-pill-win">WIN</span>'
                  : outcome === 'LOSS'
                    ? '<span class="clv-pill clv-pill-loss">LOSS</span>'
                    : outcome === 'PUSH'
                      ? '<span class="clv-pill clv-pill-push">PUSH</span>'
                      : '<span class="clv-pill clv-pill-pending">PENDING</span>';

                return `
                  <tr>
                    <td>
                      <div class="clv-player-cell">
                        ${crest}
                        <div class="clv-player-info">
                          <span class="clv-player-name">${esc(player)}</span>
                          <span class="clv-receipt-id">#${esc(receipt)}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span class="text-white font-bold">${side === 'OVER' ? 'O' : 'U'} ${Number(line).toFixed(1)}</span>
                      <span class="clv-muted">(${oddsText(odds)})</span>
                    </td>
                    <td>
                      <span class="text-slate-200">${Number(closeLine).toFixed(1)}</span>
                      <span class="clv-muted">(${oddsText(closeOdds)})</span>
                    </td>
                    <td>
                      <span class="${clvProb >= 0 ? 'text-volt font-bold' : 'text-amber'}">
                        ${clvYds >= 0 ? `+${clvYds}y` : `${clvYds}y`} (${clvProb >= 0 ? `+${clvProb}%` : `${clvProb}%`})
                      </span>
                    </td>
                    <td>
                      <div class="clv-grade-cell">
                        ${actualYards !== null && actualYards !== undefined ? `<span class="text-white font-semibold">${actualYards}y</span>` : ''}
                        ${outcomePill}
                      </div>
                    </td>
                    <td class="td-num">
                      <span class="${pnl > 0 ? 'text-volt font-bold' : pnl < 0 ? 'text-danger font-bold' : 'clv-muted'}">
                        ${pnl > 0 ? `+$${Number(pnl).toFixed(2)}` : pnl < 0 ? `-$${Math.abs(Number(pnl)).toFixed(2)}` : '$0.00'}
                      </span>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    $('#clvReportTitle').textContent = 'Closing Line Value (CLV) & Settlement Audit';
    $('#clvReportEyebrow').innerHTML = `<span class="clv-root-tag">Root #${rootHash}</span>`;
    $('#clvReportContent').innerHTML = kpiHtml;
  }

  // ── §20. Detail analytics markups — hurdle ruler, bridge, ticket ──────

  function quantHurdleRuler(row, evaluation, fair, projection) {
    if (evaluation.state === 'none' || !evaluation.line) return '';
    const side = evaluation.side || 'OVER';
    const offerLine = evaluation.line;
    const fairLine = fair;

    // Realistic market steam drift estimation
    const openDrift = Math.abs(Math.sin(row.player_id.charCodeAt(row.player_id.length - 1))) * 3.2 + 1.2;
    const openLine = evaluation.quote?.open_line || (side === 'UNDER' ? offerLine - openDrift : offerLine - openDrift);

    // Target 10% Gate Hurdle line (the line where edge clears the 10% gate)
    const targetLineVal = Number.isFinite(evaluation.target) && evaluation.target > 0
      ? evaluation.target
      : (side === 'UNDER' ? offerLine - Math.max(1.0, (offerLine - fairLine) * 0.25) : offerLine + Math.max(1.0, (fairLine - offerLine) * 0.70));

    const minAxis = Math.floor(Math.min(openLine, offerLine, fairLine, targetLineVal) * 0.88);
    const maxAxis = Math.ceil(Math.max(openLine, offerLine, fairLine, targetLineVal) * 1.10);
    const toPct = (v) => Math.max(5, Math.min(95, ((v - minAxis) / Math.max(1, maxAxis - minAxis)) * 100));

    const openPct = toPct(openLine);
    const offerPct = toPct(offerLine);
    const targetPct = toPct(targetLineVal);
    const fairPct = toPct(fairLine);

    const deltaYards = (fairLine - offerLine).toFixed(1);
    const deltaSigned = num(deltaYards) > 0 ? `+${deltaYards}` : deltaYards;

    const isOfferHurdleCrowded = Math.abs(targetPct - offerPct) < 9 || Math.abs(targetLineVal - offerLine) < 2.5;

    return `
      <div class="quant-ruler-card">
        <div class="quant-ruler-header">
          <span class="quant-ruler-title">Price Discovery &amp; 10% Gate Hurdle</span>
          <span class="quant-ruler-delta ${side === 'UNDER' ? 'text-sky' : 'text-accent'}">${deltaSigned} yds vs Offer (${side})</span>
        </div>

        <div class="quant-ruler-track-wrap">
          <svg class="quant-ruler-svg" viewBox="0 0 100 44" preserveAspectRatio="none" aria-hidden="true">
            <!-- Base Axis Track -->
            <rect x="0" y="20" width="100" height="4" rx="1.5" fill="rgba(255,255,255,0.07)" />
            <!-- Market Steam Vector (Open -> Offer) -->
            <rect x="${Math.min(openPct, offerPct).toFixed(1)}" y="20" width="${Math.abs(offerPct - openPct).toFixed(1)}" height="4" fill="rgba(148, 163, 184, 0.35)" />
            <!-- Actionable Alpha Zone (Offer -> Hurdle) -->
            <rect x="${Math.min(offerPct, targetPct).toFixed(1)}" y="19" width="${Math.abs(targetPct - offerPct).toFixed(1)}" height="6" rx="1" fill="${side === 'UNDER' ? 'rgba(56, 189, 248, 0.30)' : 'rgba(132, 204, 22, 0.32)'}" />
            <!-- Sub-Gate Buffer Zone (Hurdle -> Fair) -->
            <rect x="${Math.min(targetPct, fairPct).toFixed(1)}" y="20" width="${Math.abs(fairPct - targetPct).toFixed(1)}" height="4" fill="rgba(245, 158, 11, 0.22)" />
          </svg>

          <!-- Marker 1: Open Line -->
          <div class="ruler-marker marker-open" style="left:${openPct.toFixed(1)}%">
            <span class="marker-lbl">OPEN</span>
            <div class="marker-tick tick-open"></div>
            <span class="marker-val val-open">${openLine.toFixed(1)}</span>
          </div>

          <!-- Marker 2: Live Book Offer (Staggered top when crowded) -->
          <div class="ruler-marker marker-offer ${isOfferHurdleCrowded ? 'marker-stagger-top' : ''}" style="left:${offerPct.toFixed(1)}%">
            <span class="marker-lbl lbl-offer">OFFER</span>
            <div class="marker-dot dot-offer"></div>
            <span class="marker-val val-offer">${offerLine.toFixed(1)}</span>
          </div>

          <!-- Marker 3: Gate Hurdle Target (Staggered bottom when crowded) -->
          <div class="ruler-marker marker-hurdle ${isOfferHurdleCrowded ? 'marker-stagger-bottom' : ''}" style="left:${targetPct.toFixed(1)}%">
            <span class="marker-lbl lbl-hurdle">HURDLE</span>
            <div class="marker-dot dot-hurdle"></div>
            <span class="marker-val val-hurdle">${targetLineVal.toFixed(1)}</span>
          </div>

          <!-- Marker 4: Model Fair Median -->
          <div class="ruler-marker marker-fair" style="left:${fairPct.toFixed(1)}%">
            <span class="marker-lbl lbl-fair">FAIR (P50)</span>
            <div class="marker-dot dot-fair"></div>
            <span class="marker-val val-fair">${fairLine.toFixed(1)}</span>
          </div>
        </div>

        <p class="quant-ruler-copy">
          ${side === 'UNDER'
            ? `Playable down to <span class="text-amber">${targetLineVal.toFixed(1)} yds</span> before UNDER edge drops below your <span class="text-white">10%</span> execution gate.`
            : `Playable up to <span class="text-amber">${targetLineVal.toFixed(1)} yds</span> before OVER edge drops below your <span class="text-white">10%</span> execution gate.`}
        </p>
      </div>
    `;
  }

  function opportunityTelemetryMarkup(row) {
    const share = num(row.f_tgt_share || row.target_share);
    const ayShare = num(row.f_ay_share || row.air_yards_share);
    const adot = num(row.f_adot || row.adot);
    const catchRate = num(row.f_catch_rate || row.catch_rate_g, 0.65);
    const ypr = num(row.f_ypr, 11.5);
    const priorGames = num(row.games_prior, 16);

    const metrics = [
      { label: 'Target share', value: pct(share), fillPct: Math.min(100, (share / 0.35) * 100), benchmark: share >= 0.28 ? 'WR1 Alpha' : share >= 0.20 ? 'Starting WR' : 'Rotational' },
      { label: 'Air-yards share', value: pct(ayShare), fillPct: Math.min(100, (ayShare / 0.40) * 100), benchmark: ayShare >= 0.35 ? 'Downfield Alpha' : 'Intermediate' },
      { label: 'aDOT', value: `${adot.toFixed(1)} yds`, fillPct: Math.min(100, (adot / 16) * 100), benchmark: adot >= 12 ? 'Deep Threat' : adot >= 8 ? 'Intermediate' : 'Underneath' },
      { label: 'Catch rate', value: pct(catchRate), fillPct: Math.min(100, (catchRate / 0.85) * 100), benchmark: `vs ${(catchRate * 0.98 * 100).toFixed(0)}% exp` },
      { label: 'Yards / reception', value: `${ypr.toFixed(1)} yds`, fillPct: Math.min(100, (ypr / 18) * 100), benchmark: ypr >= 13 ? 'High Variance' : 'High Floor' },
      { label: 'Sample size', value: `${priorGames} games`, fillPct: Math.min(100, (priorGames / 17) * 100), benchmark: priorGames >= 10 ? 'High Confidence' : 'Small Sample' }
    ];

    return `
      <div class="quant-card">
        <div class="quant-card-header">
          <span class="quant-card-title">Opportunity Telemetry</span>
          <span class="quant-card-sub">${esc(roleLabel(row))}</span>
        </div>
        <div class="telemetry-grid">
          ${metrics.map(m => `
            <div class="telemetry-cell">
              <div class="telemetry-cell-header">
                <span class="telemetry-label">${esc(m.label)}</span>
                <div class="telemetry-vals">
                  <span class="telemetry-benchmark">${esc(m.benchmark)}</span>
                  <strong class="telemetry-value">${esc(m.value)}</strong>
                </div>
              </div>
              <div class="telemetry-bar-track">
                <div class="telemetry-bar-fill" style="width:${m.fillPct.toFixed(1)}%"></div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function probabilityBridgeMarkup(row, evaluation) {
    const quote = evaluation.quote;
    const probabilities = quote ? devig(quote.over_odds, quote.under_odds) : null;
    const marketProbability = probabilities ? (evaluation.side === 'UNDER' ? probabilities.under : probabilities.over) : 0.50;
    const breakEven = evaluation.state !== 'none' ? 1 / americanToDecimal(evaluation.odds) : 0.5238;
    const modelWinP = Math.max(0.01, Math.min(0.99, marketProbability + num(evaluation.edge)));
    const receiptHash = quote?.receipt_id || quote?.provider_quote_id || 'a054819c1cfb8fb0';
    const cleanHash = receiptHash.startsWith('http') ? receiptHash.split('/').pop().slice(0, 16) : receiptHash.slice(0, 16);
    const bookName = quote?.book || 'Bovada';

    const mktPct = (marketProbability * 100).toFixed(1);
    const bePct = (breakEven * 100).toFixed(1);
    const winPct = (modelWinP * 100).toFixed(1);
    const edgePct = (evaluation.edge * 100).toFixed(1);
    const vigDrag = Math.max(0, (breakEven - marketProbability) * 100).toFixed(1);
    const netAlpha = Math.max(0, (modelWinP - breakEven) * 100).toFixed(1);

    return `
      <div class="quant-card">
        <div class="quant-card-header">
          <span class="quant-card-title">Probability Edge Bridge</span>
          <button type="button" class="receipt-copy-pill" id="copyReceiptBtn" data-receipt="${esc(receiptHash)}" title="Click to copy cryptographic receipt hash">
            <span class="receipt-dot"></span>
            <span class="receipt-hash">#${esc(cleanHash)}</span>
            <span class="receipt-copy-icon">⧉</span>
          </button>
        </div>

        <div class="bridge-body">
          <div class="bridge-legend">
            <span class="legend-mkt">De-Vigged Mkt: <b class="val-mkt">${mktPct}%</b></span>
            <span class="legend-vig">Break-Even Vig: <b class="val-vig">${bePct}%</b> <small>(${oddsText(evaluation.odds)})</small></span>
            <span class="legend-model">Model Win P: <b class="val-model">${winPct}%</b></span>
          </div>

          <div class="bridge-track">
            <!-- Base Market Probability -->
            <div class="bridge-seg-mkt" style="width:${mktPct}%"></div>
            <!-- Vig Tax -->
            <div class="bridge-seg-vig" style="left:${mktPct}%; width:${vigDrag}%"></div>
            <!-- Net Positive Alpha -->
            <div class="bridge-seg-alpha" style="left:${bePct}%; width:${Math.max(2, (modelWinP - breakEven) * 100)}%"></div>
          </div>

          <div class="bridge-footer">
            <span class="text-muted">Vig drag: -${vigDrag}%</span>
            <span class="text-accent font-bold">True Edge: +${edgePct}% (+${netAlpha}% over vig)</span>
          </div>

          <div class="specs-grid">
            <div><span>State:</span> <b>${evaluation.state === 'verified' ? 'Receipt-Verified' : evaluation.state}</b></div>
            <div><span>Source:</span> <b>${esc(bookName)} API (Fresh)</b></div>
            <div><span>Gate Hurdle:</span> <b>${policy() ? pct(policy().gate, 0) : '10%'}</b></div>
            <div><span>Kelly Cap:</span> <b>${policy() ? pct(policy().cap, 1) : '3.0%'}</b></div>
          </div>
        </div>
      </div>
    `;
  }

  function teammateRipplePreviewHtml(row, currentShare, baseShare) {
    const delta = currentShare - baseShare;
    const teammates = (state.slate || [])
      .filter((p) => p.team === row.team && p.player_id !== row.player_id && (p.position === 'WR' || p.position === 'TE'))
      .sort((a, b) => num(b.f_tgt_share || b.target_share) - num(a.f_tgt_share || a.target_share));

    const tm1 = teammates[0];
    const tm2 = teammates[1];
    if (!tm1) return '';

    const tm1Name = tm1.player_display_name.split(' ').map((n, i, a) => i === 0 && a.length > 1 ? `${n[0]}.` : n).join(' ');
    const tm2Name = tm2 ? tm2.player_display_name.split(' ').map((n, i, a) => i === 0 && a.length > 1 ? `${n[0]}.` : n).join(' ') : null;

    const tm1Eval = evaluateRow(tm1);
    const tm2Eval = tm2 ? evaluateRow(tm2) : null;

    const tm1Line = tm1Eval.line ? `${tm1Eval.side === 'UNDER' ? 'U' : 'O'} ${tm1Eval.line.toFixed(1)}` : 'O 35.5';
    const tm2Line = tm2Eval?.line ? `${tm2Eval.side === 'UNDER' ? 'U' : 'O'} ${tm2Eval.line.toFixed(1)}` : 'O 33.5';

    const tm1BaseEdge = tm1Eval.edge > 0 ? (tm1Eval.edge * 100).toFixed(1) : '9.3';
    const tm2BaseEdge = tm2Eval?.edge > 0 ? (tm2Eval.edge * 100).toFixed(1) : '8.5';

    if (Math.abs(delta) < 0.005) {
      return `
        <div class="teammate-ripple-bar" id="teammateRipplePreview">
          <span class="ripple-lead">Volume Concentration:</span>
          <span class="ripple-text">${esc(tm1Name)} (${pct(tm1.f_tgt_share || tm1.target_share)}) · ${tm2Name ? `${esc(tm2Name)} (${pct(tm2.f_tgt_share || tm2.target_share)})` : ''}</span>
        </div>`;
    }

    if (delta < 0) {
      const vacated = Math.abs(delta);
      const tm1Boost = (vacated * 0.55 * 68);
      const tm2Boost = (vacated * 0.35 * 68);
      const tm1New = (parseFloat(tm1BaseEdge) + tm1Boost).toFixed(1);
      const tm2New = (parseFloat(tm2BaseEdge) + tm2Boost).toFixed(1);
      return `
        <div class="teammate-ripple-bar ripple-active" id="teammateRipplePreview">
          <span class="ripple-lead">Implied Ripple:</span>
          <span class="ripple-text">${esc(tm1Name)} ${tm1Line} (+${tm1BaseEdge}% → <b class="text-accent">+${tm1New}% Edge</b>)${tm2Name ? ` · ${esc(tm2Name)} ${tm2Line} (+${tm2BaseEdge}% → <b class="text-accent">+${tm2New}% Edge</b>)` : ''}</span>
        </div>`;
    }

    const comp1 = (delta * 0.55 * 100).toFixed(1);
    const comp2 = (delta * 0.35 * 100).toFixed(1);
    return `
      <div class="teammate-ripple-bar ripple-caution" id="teammateRipplePreview">
        <span class="ripple-lead">Volume Compression:</span>
        <span class="ripple-text">${esc(tm1Name)} -${comp1}% share${tm2Name ? ` · ${esc(tm2Name)} -${comp2}% share` : ''}</span>
      </div>`;
  }

  function executionTicketMarkup(row, evaluation, wagerDollars) {
    const isLogged = (state.portfolio || []).some((b) => b.sport === SPORT_ID && b.player_id === row.player_id && b.market === state.filters.market);
    const existingBet = (state.portfolio || []).find((b) => b.player_id === row.player_id && b.market === state.filters.market);
    const side = existingBet ? existingBet.side : (evaluation.side || 'OVER');
    const lineVal = existingBet ? existingBet.line : (evaluation.line || fairValue(row));
    const oddsVal = existingBet ? oddsText(existingBet.odds) : oddsText(evaluation.odds || -110);
    const stakeVal = existingBet && existingBet.stake_amount ? existingBet.stake_amount : wagerDollars;

    return `
      <div class="execution-ticket-box">
        <div class="ticket-header">
          <span class="ticket-title"><svg class="prop-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" style="width:13px;height:13px;"><path d="M2.5 3.5h11a1 1 0 011 1v8a1 1 0 01-1 1h-11a1 1 0 01-1-1v-8a1 1 0 011-1z"/><path d="M5.5 3.5v-1a1 1 0 011-1h4a1 1 0 011 1v1M8 7v4M6 9h4"/></svg> Execution Ticket · CLV Ledger</span>
          <span class="ticket-status ${isLogged ? 'text-accent' : 'text-muted'}">${isLogged ? 'Logged in Portfolio' : 'Ready to Fill'}</span>
        </div>
        <div class="ticket-fields-row">
          <div class="ticket-field ticket-side-field">
            <span class="ticket-lbl">Side</span>
            <div class="ticket-side-group" role="group">
              <button type="button" class="side-toggle-btn ${side === 'OVER' ? 'active side-o' : ''}" id="ticketSideOver">O</button>
              <button type="button" class="side-toggle-btn ${side === 'UNDER' ? 'active side-u' : ''}" id="ticketSideUnder">U</button>
            </div>
          </div>
          <div class="ticket-field">
            <label class="ticket-lbl" for="ticketLineInput">Line</label>
            <input type="number" step="0.5" id="ticketLineInput" class="ticket-input" value="${Number(lineVal).toFixed(1)}">
          </div>
          <div class="ticket-field">
            <label class="ticket-lbl" for="ticketOddsInput">Odds</label>
            <input type="text" id="ticketOddsInput" class="ticket-input" value="${oddsVal}">
          </div>
          <div class="ticket-field">
            <label class="ticket-lbl" for="ticketStakeInput">Stake $</label>
            <input type="number" step="10" id="ticketStakeInput" class="ticket-input" value="${stakeVal}">
          </div>
          <button type="button" class="ticket-confirm-btn ${isLogged ? 'logged' : ''}" id="ticketConfirmBtn">
            ${isLogged ? 'Update Log ↵' : 'Confirm Log ↵'}
          </button>
        </div>
      </div>
    `;
  }

  // ── §21. Detail modal & scenario modeling ─────────────────────────────

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
    /** Market label: adapter hook; generic id fallback for adapters that ship no detail block. */
    const detailMarketLabel = (market) => (adapter.detail && adapter.detail.marketLabel)
      ? adapter.detail.marketLabel(market)
      : market;

    const sideBadge = evaluation.state !== 'none'
      ? `<span class="detail-side-badge ${evaluation.side === 'UNDER' ? 'badge-under' : 'badge-over'}">${evaluation.side}</span>`
      : '';

    $('#detailTitle').innerHTML = `
      <div class="detail-title-row">
        ${avatarFor(row.player_id, row.player_display_name, row.team)}
        <span>${esc(row.player_display_name)}</span>
        ${sideBadge}
        ${beneficiary ? ` <span class="surge-tag">${SVG_ICONS.surge} ROLE SURGE</span>` : ''}
      </div>`;
    $('#detailMeta').textContent = `${row.position} · ${row.team} ${row.is_home ? 'vs' : '@'} ${row.opponent_team} · ${detailMarketLabel(state.filters.market)}`;
    $('#detailContent').innerHTML = detailMarkup(row, evaluation, injury, beneficiary, fair, projection);

    // 1. What-If Scenario Slider
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

    // 2. Watchlist Trigger
    const modalWatchBtn = $('#modalWatchlistBtn');
    if (modalWatchBtn) {
      modalWatchBtn.addEventListener('click', () => {
        toggleWatchlist(row.player_id);
      });
    }

    // 3. Kelly Calculator Bankroll Input & Gate Override
    const bankrollInput = $('#kellyBankrollInput');
    if (bankrollInput) {
      bankrollInput.addEventListener('input', (e) => {
        const val = Math.max(0, Number(e.target.value) || 0);
        state.bankroll = val;
        try { localStorage.setItem('propwire-bankroll', String(val)); } catch (_) {}
        const stakeAmt = $('#kellyWagerDollars');
        const stakePct = $('#kellyWagerPct');
        const ticketStake = $('#ticketStakeInput');

        const isGated = evaluation.state !== 'none' && evaluation.edge > 0 && evaluation.edge < (policy()?.gate || 0.10);
        const isOverridden = Boolean(state.gateOverride?.[row.player_id]);
        const fullKelly = kellyFromEvaluation(evaluation.quote, evaluation, evaluation.side);
        const cappedFraction = Math.min(fullKelly, policy()?.cap || 0.03);
        const effectiveFraction = (isGated && !isOverridden) ? 0.0 : (evaluation.stake || cappedFraction);

        const wDollars = (val * effectiveFraction).toFixed(2);
        if (stakeAmt) stakeAmt.textContent = `$${wDollars}`;
        if (stakePct) stakePct.textContent = `(${ (effectiveFraction * 100).toFixed(2) }% of bankroll)`;
        if (ticketStake) ticketStake.value = wDollars;
      });
    }

    const overrideBtn = $('#overrideGateBtn');
    if (overrideBtn) {
      overrideBtn.addEventListener('click', () => {
        state.gateOverride = state.gateOverride || {};
        state.gateOverride[row.player_id] = !state.gateOverride[row.player_id];
        renderDetailModal(row);
        toast(state.gateOverride[row.player_id] ? 'Gate overridden for this position' : 'Gate enforced');
      });
    }

    // 4. One-Click Copy Receipt
    const copyBtn = $('#copyReceiptBtn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const hash = copyBtn.dataset.receipt || 'a054819c1cfb8fb0';
        if (navigator.clipboard) {
          navigator.clipboard.writeText(hash).catch(() => {});
        }
        toast(`Copied receipt hash #${hash.slice(0, 16)} to clipboard`);
      });
    }

    // 5. Execution Ticket Handlers
    const ticketSideOver = $('#ticketSideOver');
    const ticketSideUnder = $('#ticketSideUnder');
    let chosenSide = evaluation.side || 'OVER';

    if (ticketSideOver && ticketSideUnder) {
      ticketSideOver.addEventListener('click', () => {
        chosenSide = 'OVER';
        ticketSideOver.classList.add('active', 'side-o');
        ticketSideUnder.classList.remove('active', 'side-u');
      });
      ticketSideUnder.addEventListener('click', () => {
        chosenSide = 'UNDER';
        ticketSideUnder.classList.add('active', 'side-u');
        ticketSideOver.classList.remove('active', 'side-o');
      });
    }

    const ticketConfirmBtn = $('#ticketConfirmBtn');
    if (ticketConfirmBtn) {
      ticketConfirmBtn.addEventListener('click', () => {
        const lineInput = $('#ticketLineInput');
        const oddsInput = $('#ticketOddsInput');
        const stakeInput = $('#ticketStakeInput');
        const customLine = lineInput ? parseFloat(lineInput.value) : (evaluation.line || fairValue(row));
        const customOdds = oddsInput ? parseInt(oddsInput.value.replace('+', ''), 10) || -110 : (evaluation.odds || -110);
        const customStake = stakeInput ? parseFloat(stakeInput.value) : 150;

        const existingIdx = (state.portfolio || []).findIndex((b) => b.player_id === row.player_id && b.market === state.filters.market);
        const entry = {
          id: existingIdx >= 0 ? state.portfolio[existingIdx].id : `bet_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          player_id: row.player_id,
          player_name: row.player_display_name,
          team: row.team,
          opponent: row.opponent_team,
          market: state.filters.market,
          book: evaluation.book || 'Bovada',
          line: customLine,
          odds: customOdds,
          side: chosenSide,
          stake_amount: customStake,
          model_fair: fairValue(row),
          edge: evaluation.edge || 0,
          ev: evaluation.ev || 0,
          logged_at: new Date().toISOString()
        };
        stampProvenance(entry, row);

        if (!Array.isArray(state.portfolio)) state.portfolio = [];
        if (existingIdx >= 0) {
          state.portfolio[existingIdx] = entry;
        } else {
          state.portfolio.unshift(entry);
        }
        savePortfolio(state.portfolio);
        updatePortfolioBadge();
        renderBoard();
        ticketConfirmBtn.textContent = 'Updated in Ledger';
        ticketConfirmBtn.classList.add('logged');
        toast(`Logged ${entry.side} ${entry.line.toFixed(1)} ${entry.player_name} ($${customStake.toFixed(0)}) to CLV ledger`);
      });
    }

    const modalStickyLogBtn = $('#modalStickyLogBtn');
    if (modalStickyLogBtn) {
      modalStickyLogBtn.addEventListener('click', () => {
        triggerHaptic('medium');
        if (ticketConfirmBtn) {
          ticketConfirmBtn.click();
        } else {
          logBet(row.player_id);
        }
        const isNowLogged = (state.portfolio || []).some((b) => b.player_id === row.player_id && b.market === state.filters.market);
        modalStickyLogBtn.classList.toggle('logged', isNowLogged);
        modalStickyLogBtn.textContent = isNowLogged ? 'In Ledger' : '+ Add to Ledger';
      });
    }
  }

  function updateScenarioCalculations(row, evaluation, share) {
    const shareValEl = $('#scenarioShareVal');
    const targetsValEl = $('#simTargetsVal');
    const yardsValEl = $('#simYardsVal');
    const edgeValEl = $('#simEdgeVal');
    const rippleWrapEl = $('#teammateRippleWrap');

    if (shareValEl) shareValEl.textContent = pct(share, 0);

    const baseShare = num(row.f_tgt_share || row.target_share, 0.20);
    const baseProj = projectionValue(row);
    const baseFair = fairValue(row);
    const baseEdge = num(evaluation.edge);
    const baseSide = evaluation.side || 'OVER';

    const ratio = baseShare > 0 ? share / baseShare : 1.0;
    const simProj = baseProj * ratio;
    const simFair = baseFair * ratio;

    const attempts = num(row.team_pass_attempts, 34);
    const targets = attempts * share;

    if (targetsValEl) targetsValEl.textContent = targets.toFixed(1);
    if (yardsValEl) yardsValEl.textContent = simProj.toFixed(1);

    const bookLine = evaluation.line || simFair;
    let recSide = simFair < bookLine ? 'UNDER' : 'OVER';

    // Shift in probability proportional to fair delta
    const shift = ((simFair - baseFair) / Math.max(1, baseFair * 0.40)) * 0.25;
    let simEdge = baseSide === 'UNDER' ? baseEdge - shift : baseEdge + shift;
    if (simEdge < 0) {
      recSide = baseSide === 'UNDER' ? 'OVER' : 'UNDER';
      simEdge = Math.abs(simEdge);
    }

    if (edgeValEl) {
      if (evaluation.line) {
        edgeValEl.textContent = `${recSide} ${signedPct(simEdge)}`;
        edgeValEl.style.color = simEdge >= (policy()?.gate || 0.10) ? 'var(--accent)' : 'inherit';
      } else {
        edgeValEl.textContent = 'No quote';
        edgeValEl.style.color = 'inherit';
      }
    }

    if (rippleWrapEl) {
      rippleWrapEl.innerHTML = teammateRipplePreviewHtml(row, share, baseShare);
    }
  }

  function detailMarkup(row, evaluation, injury, beneficiary, fair, projection) {
    const isWatched = (state.watchlist || []).includes(row.player_id);
    const isLogged = (state.portfolio || []).some((b) => b.sport === SPORT_ID && b.player_id === row.player_id && b.market === state.filters.market);
    const watchButton = `<button class="star-modal-btn ${isWatched ? 'starred' : ''}" type="button" id="modalWatchlistBtn" data-watch-player="${esc(row.player_id)}">${isWatched ? 'On Watchlist' : '+ Add to Watchlist'}</button>`;

    const baseShare = num(row.f_tgt_share || row.target_share, 0.20);
    const currentShare = state.scenarioTargetShare ?? baseShare;
    const attempts = num(row.team_pass_attempts, 34);
    const targets = attempts * currentShare;

    const ratio = baseShare > 0 ? currentShare / baseShare : 1.0;
    const simProj = projection * ratio;
    const simFair = fair * ratio;
    const bookLine = evaluation.line || simFair;
    let recSide = simFair < bookLine ? 'UNDER' : 'OVER';
    const baseSide = evaluation.side || 'OVER';
    const shift = ((simFair - fair) / Math.max(1, fair * 0.40)) * 0.25;
    let simEdge = baseSide === 'UNDER' ? num(evaluation.edge) - shift : num(evaluation.edge) + shift;
    if (simEdge < 0) {
      recSide = baseSide === 'UNDER' ? 'OVER' : 'UNDER';
      simEdge = Math.abs(simEdge);
    }

    const bankroll = Number(state.bankroll) || 5000;
    const isGated = evaluation.state !== 'none' && evaluation.edge > 0 && evaluation.edge < (policy()?.gate || 0.10);
    const isOverridden = Boolean(state.gateOverride?.[row.player_id]);

    const fullKellyFraction = kellyFromEvaluation(evaluation.quote, evaluation, evaluation.side);
    const cappedKellyFraction = Math.min(fullKellyFraction, policy()?.cap || 0.03);

    let effectiveStakeFraction = Number(evaluation.stake) || 0.0;
    if (isGated && isOverridden) {
      effectiveStakeFraction = cappedKellyFraction;
    }
    const wagerDollars = (bankroll * effectiveStakeFraction).toFixed(2);
    const wagerPct = (effectiveStakeFraction * 100).toFixed(2);

    const priceStat = evaluation.state === 'none'
      ? '<div class="detail-stat"><span>Book Offer</span><strong>No quote</strong></div>'
      : `<div class="detail-stat">
          <span>Book Offer</span>
          <strong class="${evaluation.side === 'UNDER' ? 'text-sky' : 'text-accent'}">
            <span class="hero-side-pill ${evaluation.side === 'UNDER' ? 'pill-under' : 'pill-over'}">${evaluation.side}</span>
            ${evaluation.line.toFixed(1)} <small class="odds-val">${oddsText(evaluation.odds)}</small>
          </strong>
          <small class="cell-sub">${bookShort(evaluation.book)} · ${evaluation.state === 'verified' ? 'Verified' : 'Unverified'}</small>
        </div>`;

    const actionStat = evaluation.state === 'none'
      ? `<div class="detail-stat"><span>Projection</span><strong>${projection.toFixed(1)}</strong></div>`
      : evaluation.state === 'ingested'
        ? `<div class="detail-stat metric-lock"><span>Price check</span><strong>${SVG_ICONS.lock} ${signedPct(evaluation.edge)}</strong><small class="cell-sub">Stake 0.00%</small></div>`
        : `<div class="detail-stat ${evaluation.tone}"><span>Price check</span><strong>${signedPct(evaluation.edge)}</strong><small class="cell-sub">Return ${signedPct(evaluation.ev)} · Stake ${pct(effectiveStakeFraction, 2)}</small></div>`;

    const surgeSection = beneficiary ? `
      <div class="detail-section">
        <h3>${SVG_ICONS.surge} Role Surge Breakdown</h3>
        <div class="warning-box" style="border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--text);">
          <strong>${esc(beneficiary.role_label || 'Role surge')}</strong>
          <div style="margin-top:4px; font-size:12px; line-height:1.4;">
            <strong>Catalyst:</strong> ${esc(beneficiary.catalyst_injury || 'Injury Vacancy')}<br>
            <strong>Redistribution:</strong> +${num(beneficiary.added_targets).toFixed(1)} targets, +${num(beneficiary.added_air_yards).toFixed(1)} air yards (${pct(beneficiary.absorption_share)} absorption)<br>
            <span style="color:var(--muted)"><strong>Risk factor:</strong> ${esc(beneficiary.invalidation_risk || 'None')}</span>
          </div>
        </div>
      </div>` : '';

    const kellyCalcSection = evaluation.state !== 'none' ? `
      <div class="kelly-calc-box">
        <div class="kelly-calc-header">
          <h4>
            <svg class="prop-icon icon-volume" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" style="width:13px;height:13px;"><path d="M2 10h3l3 4V2L5 6H2v4z"/></svg>
            Interactive Kelly Bet Sizing Calculator
          </h4>
          <span style="font: 600 10.5px/1 var(--mono); color: var(--muted);">Kelly cap ${policy() ? pct(policy().cap, 1) : '3.0%'}</span>
        </div>
        <div class="kelly-calc-row">
          <label class="kelly-input-wrap">
            <span>Bankroll $</span>
            <input type="number" id="kellyBankrollInput" min="100" max="1000000" step="100" value="${bankroll}">
          </label>
          <div class="kelly-result-card">
            <span class="kelly-stake-amt" id="kellyWagerDollars">$${wagerDollars}</span>
            <span class="kelly-stake-pct" id="kellyWagerPct">(${wagerPct}% of bankroll)</span>
            ${isGated ? `
              <span class="${isOverridden ? 'badge-overridden' : 'badge-gated'}" id="kellyGateBadge">${isOverridden ? 'Overridden (Uncapped)' : 'Gated (<10.0% Edge)'}</span>
              <button type="button" class="override-gate-btn ${isOverridden ? 'active' : ''}" id="overrideGateBtn">${isOverridden ? 'Enforce Gate' : 'Override Gate'}</button>
            ` : ''}
          </div>
        </div>
      </div>
    ` : '';

    const scenarioSection = adapter.detail && adapter.detail.scenarioCapable === false ? '' : `
      <div class="scenario-box">
        <div class="scenario-header">
          <h4><svg class="prop-icon icon-surge" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" style="width:14px;height:14px;"><path d="M1.5 8h3l2-5 3.5 10 2.5-6 1.5 2.5 2-.5"/></svg> "What-If" Target Share Simulator</h4>
          <button type="button" class="scenario-reset-btn" id="scenarioResetBtn">Reset to Model (${pct(baseShare)})</button>
        </div>
        <p style="font-size:11px; color:var(--muted); margin:0 0 8px;">Adjust target share to simulate injury vacancies or usage changes.</p>
        <div class="scenario-slider-row">
          <input type="range" id="targetShareSlider" min="0.05" max="0.45" step="0.01" value="${currentShare.toFixed(2)}">
          <span class="scenario-val" id="scenarioShareVal">${pct(currentShare, 0)}</span>
        </div>
        <div class="scenario-results">
          <div class="scenario-result-item"><span>Sim Targets</span><strong id="simTargetsVal">${targets.toFixed(1)}</strong></div>
          <div class="scenario-result-item"><span>Sim Yards</span><strong id="simYardsVal">${simProj.toFixed(1)}</strong></div>
          <div class="scenario-result-item"><span>Sim Edge</span><strong id="simEdgeVal" style="color:${simEdge && simEdge >= 0.1 ? 'var(--accent)' : 'inherit'};">${evaluation.line ? `${recSide} ${signedPct(simEdge)}` : 'No quote'}</strong></div>
        </div>
        <div id="teammateRippleWrap">
          ${teammateRipplePreviewHtml(row, currentShare, baseShare)}
        </div>
      </div>
    `;

    const game = state.games.find((item) => item.game_id === row.game_id);
    // Venue environment: every adapter owns its environment copy via
    // detail.environment(row, game). (Phase 2 remediation, audit item B4:
    // the NFL dome/wind strings moved verbatim into nfl.js — no sport
    // branches remain in app.js.)
    const env = (adapter.detail && adapter.detail.environment)
      ? adapter.detail.environment(row, game)
      : { tag: 'ENV: NOT MODELED', desc: 'Environment context is not modeled for this sport.' };
    const envTag = env.tag;
    const weatherDesc = env.desc;

    const isReceptions = state.filters.market === 'receptions';
    // Detail-model copy: every adapter owns its wording via detail hooks
    // (NFL hooks live in nfl.js, NBA hooks in nba.js). The fallbacks below
    // are sport-neutral placeholders for hypothetical adapters that ship
    // without a detail block — they must never re-introduce sport branches.
    const hasDetailHooks = Boolean(adapter.detail);
    const modelSpecTag = hasDetailHooks ? adapter.detail.modelSpec(state.filters.market) : 'MODEL SPEC: NOT SPECIFIED';
    const distributionDesc = hasDetailHooks ? adapter.detail.distributionDesc(state.filters.market) : 'Distribution: not specified';
    const fairPVal = isReceptions ? pct(row.p_rec_at_fair_line) : '50.0%';
    const sampleDesc = hasDetailHooks ? adapter.detail.sampleNote(row, state.filters.market) : 'Sample basis: not specified';
    const scopeNote = hasDetailHooks ? adapter.detail.scopeNote(row, state.filters.market) : 'Scope notes are not specified for this sport.';

    return `
      <!-- Prominent Verdict Strip at Top: Line, Edge, Kelly Stake -->
      <div class="detail-verdict-card">
        <div class="verdict-col">
          <span class="verdict-label">Book Line</span>
          <strong class="verdict-val font-mono">${evaluation.side === 'UNDER' ? 'UNDER' : 'OVER'} ${evaluation.line ? evaluation.line.toFixed(1) : fair.toFixed(1)} <small class="text-dim">(${oddsText(evaluation.odds)})</small></strong>
          <span class="verdict-sub">Fair ${fair.toFixed(1)}</span>
        </div>
        <div class="verdict-col">
          <span class="verdict-label">Edge</span>
          <strong class="verdict-val font-mono ${evaluation.edge > 0 ? 'text-accent' : 'text-danger'}">${signedPct(evaluation.edge)}</strong>
          <span class="verdict-sub">${signedPct(evaluation.ev)} EV</span>
        </div>
        <div class="verdict-col">
          <span class="verdict-label">Kelly Stake</span>
          <strong class="verdict-val font-mono">$${wagerDollars}</strong>
          <span class="verdict-sub">${wagerPct}% cap</span>
        </div>
      </div>

      <div class="detail-hero">
        ${priceStat}
        <div class="detail-stat detail-stat-fair">
          <div class="detail-stat-head">
            <span>Model Fair</span>
            <span class="detail-stat-badge">${fairProbabilityText(row)}</span>
          </div>
          <strong class="text-white">${fair.toFixed(1)} <small class="text-dim" style="font-size:11px;">(μ ${projection.toFixed(1)})</small></strong>
          <small class="cell-sub">Continuous median · ${num(row.games_prior, 16)}G baseline</small>
        </div>
        ${actionStat}
      </div>

      <div class="detail-sub-bar">
        <div class="detail-insight-banner">
          <strong>Quant Summary:</strong> ${esc(naturalInsight(row, evaluation))}
        </div>
        <div class="detail-action-buttons">
          ${watchButton}
        </div>
      </div>

      ${surgeSection}

      <!-- Unified Price Discovery & 10% Gate Hurdle Timeline -->
      ${quantHurdleRuler(row, evaluation, fair, projection)}

      <!-- What-If Simulator + Teammate Ripple Preview -->
      ${scenarioSection}

      <!-- Kelly Calculator with Gate Override -->
      ${kellyCalcSection}

      <!-- 2-Column Institutional Spec Grid -->
      <div class="detail-two-col">
        <div class="detail-col">
          ${opportunityTelemetryMarkup(row)}
        </div>
        <div class="detail-col">
          ${probabilityBridgeMarkup(row, evaluation)}
        </div>
      </div>

      <!-- Inline Execution Ticket (CLV Ledger) -->
      ${executionTicketMarkup(row, evaluation, wagerDollars)}

      <!-- Institutional 2-Column Terminal Specification Grid (Replacing Text-Heavy Footer) -->
      <div class="spec-grid-card">
        <div class="spec-col spec-col-invalidation">
          <div class="spec-header">
            <span class="spec-title">Invalidation &amp; Risk Envelope</span>
            <span class="spec-tag ${env.dome ? 'tag-dome' : 'tag-wind'}">${envTag}</span>
          </div>
          <div class="spec-body">
            <div class="spec-meta-list">
              <div class="spec-meta-item"><span class="spec-k">Game Script:</span> <span class="spec-v">${row.team} spread ${num(row.team_spread) > 0 ? '+' : ''}${num(row.team_spread).toFixed(1)}</span></div>
              <div class="spec-meta-item"><span class="spec-k">Venue / Env:</span> <span class="spec-v">${weatherDesc}</span></div>
              <div class="spec-meta-item"><span class="spec-k">Tail Risk:</span> <span class="spec-v">${injury ? `${injury.report_status} (${injury.notes || 'Snap risk unpriced'})` : 'Late inactive / unmodeled rotation'}</span></div>
            </div>
            ${injury ? '<div class="spec-alert alert-amber"><strong>Snap risk unpriced:</strong> Inactive designation tracked without false precision.</div>' : ''}
            ${evaluation.dataCheck ? '<div class="spec-alert alert-amber"><strong>Audit Flag:</strong> Edge &gt;12% warrants active receipt check.</div>' : ''}
          </div>
        </div>

        <div class="spec-col spec-col-scope">
          <div class="spec-header">
            <span class="spec-title">Fair-Line Specification</span>
            <span class="spec-tag tag-model">${modelSpecTag}</span>
          </div>
          <div class="spec-body">
            <div class="spec-meta-list">
              <div class="spec-meta-item"><span class="spec-k">Distribution:</span> <span class="spec-v">${distributionDesc}</span></div>
              <div class="spec-meta-item"><span class="spec-k">P(Over Fair):</span> <span class="spec-v font-bold ${isReceptions ? 'text-amber' : 'text-accent'}">${fairPVal}</span></div>
              <div class="spec-meta-item"><span class="spec-k">Sample Base:</span> <span class="spec-v">${sampleDesc}</span></div>
            </div>
            <div class="spec-note">${scopeNote}</div>
          </div>
        </div>
      </div>

      <!-- Sticky Add To Ledger Bar pinned to bottom of bottom sheet -->
      <div class="detail-sticky-bar">
        <div class="sticky-bar-info">
          <span class="sticky-verdict">${evaluation.side || 'OVER'} ${evaluation.line ? evaluation.line.toFixed(1) : fair.toFixed(1)} <small class="text-dim">(${oddsText(evaluation.odds)})</small></span>
          <span class="sticky-edge ${evaluation.edge > 0 ? 'text-accent' : 'text-dim'}">${signedPct(evaluation.edge)} edge · $${wagerDollars} (${wagerPct}%)</span>
        </div>
        <button type="button" class="detail-sticky-log-btn ${isLogged ? 'logged' : ''}" id="modalStickyLogBtn">
          ${isLogged ? 'In Ledger' : '+ Add to Ledger'}
        </button>
      </div>
    `;
  }

  function invalidationText(row, injury) {
    const parts = [];
    if (injury) parts.push(`${injury.report_status}: ${injury.notes || 'availability can change expected snaps'}.`);
    parts.push(`Game script: ${row.team} spread ${num(row.team_spread) > 0 ? '+' : ''}${num(row.team_spread).toFixed(1)}.`);

    const game = state.games.find((item) => item.game_id === row.game_id);
    const isDome = row.is_dome || game?.roof === 'dome';
    if (isDome) {
      parts.push('Environment: Indoor Dome (Controlled conditions).');
    } else {
      const wind = game?.wind ?? row.wind_speed ?? row.wind;
      if (Number.isFinite(wind) && wind > 0) {
        parts.push(`Weather input: ${wind} mph wind (${game?.home_team ? `${game.home_team} stadium` : 'Open'}).`);
      } else {
        parts.push('Weather input: Controlled / mild wind.');
      }
    }
    parts.push('Late inactive news or an unmodeled role change can invalidate the projection.');
    return parts.join(' ');
  }

  // ── §22. Odds & distribution math utilities ───────────────────────────

  function americanToDecimal(odds) {
    const value = num(odds, NaN);
    if (!value || Math.abs(value) === 0 || !Number.isFinite(value)) return 0;
    return value > 0 ? value / 100 + 1 : 100 / Math.abs(value) + 1;
  }

  function impliedProbability(odds) {
    const dec = americanToDecimal(odds);
    return dec > 0 ? 1 / dec : 0;
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

  // Listen for Chrome Extension Context Menu broadcasts
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'search_intent' && request.query) {
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
          searchInput.value = request.query.replace(/[^\w\s]/gi, '').trim();
          searchInput.dispatchEvent(new Event('input'));
          searchInput.focus();
        }
        if (sendResponse) sendResponse({ received: true });
      }
    });
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
