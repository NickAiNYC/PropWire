/**
 * Shared VM sandbox for PropWire browser-code tests.
 * Zero dependencies: stub DOM + frozen Date + file-backed fetch.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
export const VIEWER = path.join(ROOT, 'viewer');
export const FROZEN_MS = Date.parse('2026-10-22T12:00:00Z');

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

export function normalizeTokens(text) {
  return String(text)
    .replace(/bet_\d+_[a-z0-9]+/g, 'bet_<TOKEN>')
    .replace(/"ticket_id":"[^"]*"/g, '"ticket_id":"<TOKEN>"')
    .replace(/"logged_at":"[^"]*"/g, '"logged_at":"<TOKEN>"');
}

export function makeElement() {
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

export function buildSandbox({ seedLocalStorage = {} } = {}) {
  const registry = new Map();
  const getEl = (selector) => {
    if (!registry.has(selector)) registry.set(selector, makeElement());
    return registry.get(selector);
  };
  const lsStore = new Map(Object.entries(seedLocalStorage));
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
    body: { appendChild() {}, classList: { add() {}, remove() {}, toggle() {} }, dataset: {} },
    documentElement: { dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {} },
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

/** Load registry.js + every adapter + app.js (same order as the HTML pages). */
export function loadApp(sandbox) {
  const sources = [
    ['viewer/js/sports/registry.js', path.join(VIEWER, 'js', 'sports', 'registry.js')],
    ['viewer/js/sports/nfl.js', path.join(VIEWER, 'js', 'sports', 'nfl.js')],
  ];
  const source = fs.readFileSync(path.join(VIEWER, 'app.js'), 'utf8');
  const hook = `
  globalThis.__PW_PARITY__ = {
    state, SLATES, SPORT_ID, adapter, loadSlate, evaluateRow, filteredRows,
    renderAll, renderBoard, fairValue, projectionValue, logBet, setView,
    setPlayMode, breakerFor,
    storage: { loadPortfolio, savePortfolio, loadWatchlist, saveWatchlist, migrateLegacyStorage, MIGRATION_FLAG, STORE, migrationResult }
  };
})();`;
  const injected = source.replace(/\}\)\(\);\s*$/, hook);
  if (injected === source) throw new Error('Failed to inject parity hook into viewer/app.js');
  vm.createContext(sandbox);
  for (const [name, file] of sources) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: name });
  }
  vm.runInContext(injected, sandbox, { filename: 'viewer/app.js' });
  return sandbox.__PW_PARITY__;
}
