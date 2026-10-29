      distributionDesc: (market) => market === 'receptions' ? 'Discrete Poisson (Half-step)' : market === 'anytime_td' ? 'Poisson Red Zone Model' : 'Calibrated Continuous Log-Normal',
      sampleNote: (row) => `${num(row.games_prior, 16)} games prior · ${row.season || '2026'}`,
      scopeNote: (row, market) => market === 'receptions'
        ? `Receptions use integer outcomes and half-step lines. Fair line calibrated at P(over) = ${pct(row.p_rec_at_fair_line)}.`
        : 'Receiving-yards fair line is the calibrated continuous median, where P(over) is exactly 50.0%.',
      environment: (row, game) => {
        const isDome = row.is_dome || game?.roof === 'dome';
        const wind = game?.wind ?? row.wind_speed ?? row.wind;
        const tag = isDome ? 'ENV: DOME' : (Number.isFinite(wind) && wind > 0) ? `ENV: ${wind} MPH WIND` : 'ENV: MILD / OUTDOOR';
        const desc = isDome ? 'Indoor Dome (Controlled Conditions)' : (Number.isFinite(wind) && wind > 0) ? `${wind} mph wind (${game?.home_team ? `${game.home_team} stadium` : 'Open'})` : 'Controlled / mild conditions';
        return { tag, desc, dome: isDome };
      }
    },

    // ── Storage namespaces ──────────────────────────────────────────────────
    // Legacy keys are NEVER renamed or deleted (30-day dual-write policy);
    // migration copies legacy data into these sport-namespaced keys once.
    storageKeys: {
      ledger: 'propstein_portfolio_ledger_v2',
      watchlist: 'propstein_watchlist_nfl',
      sniperConfig: 'propstein_sniper_config_nfl',
      dismissedCorrelations: 'propstein_dismissed_correlations_nfl'
    },
    legacyKeys: {
      portfolioLedger: 'propstein_portfolio_ledger',
      watchlist: 'propstein_watchlist',
      sniperConfig: 'propstein_sniper_config',
      dismissedCorrelations: 'propstein_dismissed_correlations'
    },

    // ── Circuit breaker fallback ────────────────────────────────────────────
    // PRIMARY SOURCE: viewer/circuit_breaker_config.json (fetched at slate
    // load; single source of truth, shared with scripts/sniper_cron.py).
    // These fallbacks exist ONLY for offline/fetch-failure resilience and
    // carry the exact calibrated NFL values. Never copy these numbers to
    // another sport — each sport ships its own (initially uncalibrated)
    // config block.
    breakerFallback: {
      drift_pct_hurdle: 0.12,
      high_edge_caution_hurdle: 0.15,
      cooldown_minutes: 15,
      deadman_switch_max_age_seconds: 300,
      calibrated: true
    },

    /**
     * Correlation rule — verbatim key from pre-adapter checkCorrelatedRisk:
     * NFL receivers on the same team share game-script/target distribution.
     */
    correlationKey: (row, market) => `${row.team}::${market}`
  };

  window.PropSteinSports.register(NFL_ADAPTER);
})();
