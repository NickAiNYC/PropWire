import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

/**
 * NFL PARITY SNAPSHOT HARNESS — test/nfl-parity.snapshot.mjs
 *
 * Captures byte-identical golden outputs of viewer/app.js against the real
 * committed NFL feeds, BEFORE and AFTER the sport-adapter refactor.
 *
 *   node --test test/nfl-parity.snapshot.mjs                  # assert parity
 *   PW_UPDATE_SNAPSHOTS=1 node --test test/nfl-parity.snapshot.mjs  # re-capture
 *
 * Determinism controls:
 *   - Date is frozen at 2026-10-22T12:00:00Z (pre-kickoff for the whole
 *     2026_w7 slate, so no row is "closed" by wall-clock).
 *   - Timezone pinned to America/New_York (matches primeLabel formatting).
 *   - Non-deterministic ledger fields (id, ticket_id, logged_at) are
 *     normalized to <TOKEN> before comparison.
 *   - No third-party dependencies: app.js runs in a node:vm sandbox with a
 *     minimal stub DOM that records every innerHTML/textContent assignment.
 *
 * Announced, intentional post-refactor deltas (whitelisted, each documented
 * in the phase report — anything else failing is a regression):
 *   - ledger entries gain `sport: "nfl"` (spec'd migration, user-approved)
 *   - evaluateRow output gains `exemption_audit` object on exempted rows
 *     (user small-edit #4: auditable beneficiary exemption)
 */

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SNAPDIR = path.join(ROOT, 'test', 'snapshots', 'nfl');
const VIEWER = path.join(ROOT, 'viewer');
const UPDATE = process.env.PW_UPDATE_SNAPSHOTS === '1';

// ── Timezone pin (must take effect before any Date formatting) ──────────────
process.env.TZ = 'America/New_York';
const FROZEN_MS = Date.parse('2026-10-22T12:00:00Z');

// ── Canonical, stable JSON (sorted keys, arrays in order) ───────────────────
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

function normalizeTokens(text) {
  return String(text)
    .replace(/bet_\d+_[a-z0-9]+/g, 'bet_<TOKEN>')
    .replace(/"ticket_id":"[^"]*"/g, '"ticket_id":"<TOKEN>"')
    .replace(/"logged_at":"[^"]*"/g, '"logged_at":"<TOKEN>"');
}

// ── Stub DOM ─────────────────────────────────────────────────────────────────
function makeElement() {
  return {
    innerHTML: '', textContent: '', value: '', hidden: false, disabled: false,
    open: false, offsetWidth: 0, scrollTop: 0, dataset: {}, style: { cssText: '' },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    appendChild() {}, insertBefore() {}, remove() {}, focus() {}, blur() {},
    scrollIntoView() {}, setAttribute() {}, getAttribute() { return null; },
    querySelector() { return makeElement(); }, querySelectorAll() { return []; },
    closest() { return null; }, showModal() {}, close() {}, insertAdjacentHTML() {},
  };
}

function buildSandbox() {
  const registry = new Map();
  const getEl = (selector) => {
    if (!registry.has(selector)) registry.set(selector, makeElement());
    return registry.get(selector);
  };
  const lsStore = new Map();
  const localStorage = {
    getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => lsStore.set(k, String(v)),
    removeItem: (k) => lsStore.delete(k),
  };
  const FrozenDate = class extends Date {
    constructor(...args) {
      if (args.length === 0) super(FROZEN_MS);
      else super(...args);
    }
    static now() { return FROZEN_MS; }
  };

  const document = {
    querySelector: (sel) => getEl(sel),
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    createElement: () => makeElement(),
    documentElement: { dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {} },
    body: { classList: { add() {}, remove() {}, toggle() {} }, dataset: {} },
    title: '',
  };

  const window = {
    matchMedia: () => ({ matches: false, media: '', addEventListener() {}, addListener() {} }),
    addEventListener() {},
    removeEventListener() {},
    scrollTo() {},
    open() { return null; },
    location: { href: 'https://propwire.test/', protocol: 'https:', pathname: '/', search: '', hash: '' },
    navigator: {},
    localStorage,
  };

  const fetchImpl = async (rawPath) => {
    const clean = String(rawPath).split('?')[0];
    const file = path.join(VIEWER, clean.replace(/^\/+/, ''));
    if (clean.startsWith('http') || !fs.existsSync(file)) {
      return { ok: false, status: 404, json: async () => { throw new Error('not found'); } };
    }
    const text = fs.readFileSync(file, 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(text) };
  };

  const sandbox = {
    console: { log() {}, warn() {}, error() {}, debug() {}, info() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    document, window, localStorage, Date: FrozenDate,
    fetch: fetchImpl, URL, URLSearchParams, Event: class { constructor() {} },
    navigator: window.navigator,
    location: window.location,
    matchMedia: window.matchMedia,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame() {},
    isFinite, Number, String, Boolean, Array, Object, Math, JSON, Map, Set,
    Promise, Error, RegExp, parseFloat, parseInt,
    globalThis: {},
  };
  sandbox.globalThis = sandbox;
  sandbox.window.matchMedia = window.matchMedia;
  return { sandbox, registry, lsStore };
}

// ── Load sport registry + NFL adapter + app.js (same order as index.html) ───
function loadApp(sandbox) {
  const registrySrc = fs.readFileSync(path.join(VIEWER, 'js', 'sports', 'registry.js'), 'utf8');
  const nflSrc = fs.readFileSync(path.join(VIEWER, 'js', 'sports', 'nfl.js'), 'utf8');
  const source = fs.readFileSync(path.join(VIEWER, 'app.js'), 'utf8');
  const hook = `
  globalThis.__PW_PARITY__ = {
    state, SLATES, loadSlate, evaluateRow, filteredRows, renderAll, renderBoard,
    fairValue, projectionValue, logBet, setView, setPlayMode,
    storage: { loadPortfolio, savePortfolio, loadWatchlist, saveWatchlist }
  };
})();`;
  const injected = source.replace(/\}\)\(\);\s*$/, hook);
  if (injected === source) throw new Error('Failed to inject parity hook into viewer/app.js');
  vm.createContext(sandbox);
  vm.runInContext(registrySrc, sandbox, { filename: 'viewer/js/sports/registry.js' });
  vm.runInContext(nflSrc, sandbox, { filename: 'viewer/js/sports/nfl.js' });
  vm.runInContext(injected, sandbox, { filename: 'viewer/app.js' });
  return sandbox.__PW_PARITY__;
}

// ── Capture routines ─────────────────────────────────────────────────────────
function dumpRegistry(registry) {
  const out = {};
  for (const [selector, el] of [...registry.entries()].sort()) {
    out[selector] = { innerHTML: el.innerHTML, textContent: el.textContent };
  }
  return canonical(out);
}

function dumpEvaluations(P) {
  const markets = ['receiving_yards', 'receptions', 'anytime_td'];
  const out = {};
  for (const market of markets) {
    P.state.filters.market = market;
    const rows = {};
    for (const row of P.state.slate) rows[row.player_id] = P.evaluateRow(row);
    out[market] = { rows, order: P.filteredRows().map((r) => r.player_id) };
  }
  return canonical(out);
}

function dumpProjections(P) {
  return canonical(P.state.slate);
}

async function dumpRender(P, registry, view, market) {
  P.state.filters.market = market;
  P.setView(view);
  P.renderAll();
  return dumpRegistry(registry);
}

async function dumpLedger(P, lsStore) {
  const quoted = P.state.odds.quotes.find((q) => q.market === 'receiving_yards' && q.player_id);
  assert.ok(quoted, 'live_odds_feed must contain at least one receiving_yards quote');
  P.state.filters.market = 'receiving_yards';
  P.state.portfolio = [];
  globalThis.__pwConfirm = () => true;
  P.logBet(quoted.player_id);
  const entry = P.state.portfolio[0];
  assert.ok(entry, 'logBet must create a ledger entry');
  const storedRaw = lsStore.get('propwire_portfolio_ledger') || '';
  return {
    entry: canonical(JSON.parse(normalizeTokens(canonical(entry)))),
    stored: normalizeTokens(storedRaw),
  };
}

function dumpBreaker() {
  const raw = fs.readFileSync(path.join(VIEWER, 'circuit_breaker_config.json'), 'utf8');
  return {
    sha256: createHash('sha256').update(raw).digest('hex'),
    parsed: canonical(JSON.parse(raw)),
    // Semantic NFL values only — these must survive the per-sport restructure unchanged.
    nfl_values: canonical({
      drift_yards_hurdle: JSON.parse(raw).thresholds.drift_yards_hurdle,
      drift_rec_hurdle: JSON.parse(raw).thresholds.drift_rec_hurdle,
      drift_pct_hurdle: JSON.parse(raw).thresholds.drift_pct_hurdle,
      high_edge_caution_hurdle: JSON.parse(raw).thresholds.high_edge_caution_hurdle,
      cooldown_minutes: JSON.parse(raw).thresholds.cooldown_minutes,
      beneficiary_max_drift_yards: JSON.parse(raw).thresholds.beneficiary_max_drift_yards,
      beneficiary_max_drift_rec: JSON.parse(raw).thresholds.beneficiary_max_drift_rec,
      deadman_switch_max_age_seconds: JSON.parse(raw).thresholds.deadman_switch_max_age_seconds,
    }),
  };
}

// ── Full capture ─────────────────────────────────────────────────────────────
async function captureAll() {
  const { sandbox, registry, lsStore } = buildSandbox();
  const P = loadApp(sandbox);

  await P.loadSlate('2026_w7');
  P.state.filters.market = 'receiving_yards';

  const snaps = {};
  const tableMarkets = ['receiving_yards', 'receptions', 'anytime_td'];
  for (const market of tableMarkets) {
    snaps[`renders_table_${market}.json`] = await dumpRender(P, registry, 'table', market);
  }
  snaps['renders_cards_receiving_yards.json'] = await dumpRender(P, registry, 'cards', 'receiving_yards');
  snaps['evaluations.json'] = dumpEvaluations(P);
  snaps['projections_slate_2026_w7.json'] = dumpProjections(P);
  const ledger = await dumpLedger(P, lsStore);
  snaps['ledger_entry.json'] = canonical(ledger);
  snaps['breaker_config.json'] = canonical(dumpBreaker());
  return snaps;
}

// ── Snapshot I/O ─────────────────────────────────────────────────────────────
function snapshotPath(name) { return path.join(SNAPDIR, name); }

function compareOrUpdate(snaps) {
  const results = { updated: [], passed: [], failed: [] };
  for (const [name, actual] of Object.entries(snaps).sort()) {
    const file = snapshotPath(name);
    if (UPDATE) {
      fs.mkdirSync(SNAPDIR, { recursive: true });
      fs.writeFileSync(file, actual);
      results.updated.push(name);
      continue;
    }
    if (!fs.existsSync(file)) { results.failed.push(`${name}: snapshot file missing`); continue; }
    const expected = fs.readFileSync(file, 'utf8');
    if (expected !== actual) {
      results.failed.push(`${name}: OUTPUT DIFFERS from golden snapshot`);
    } else {
      results.passed.push(name);
    }
  }
  return results;
}

test('NFL parity: rendered output, evaluations, projections, ledger, breaker config', async () => {
  assert.equal(process.env.TZ, 'America/New_York', 'TZ pin failed — Date formatting would be machine-dependent');
  const snaps = await captureAll();
  const results = compareOrUpdate(snaps);

  if (UPDATE) {
    console.log(`parity snapshots UPDATED: ${results.updated.join(', ')}`);
    return;
  }
  assert.deepStrictEqual(
    results.failed, [],
    `NFL PARITY REGRESSION — golden snapshots do not match.\n${results.failed.join('\n')}\n` +
    'If (and only if) this diff is an announced, intentional change, re-capture with PW_UPDATE_SNAPSHOTS=1 and document it in the phase report.',
  );
  assert.ok(results.passed.length >= 8, `expected 8 snapshots, passed: ${results.passed.length}`);
});
