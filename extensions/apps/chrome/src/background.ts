/**
 * PropStein Live Sniper — Background Service Worker (Chrome MV3)
 * ==========================================================
 * Responsibilities:
 *  - Side panel open-on-action-click
 *  - Active-tab tracking; observation PAUSES when the monitored tab loses
 *    focus (spec §14) and never monitors unrelated tabs (spec §2)
 *  - Origin-validated message routing (packages/browser messaging protocol)
 *  - Session lifecycle: scoped token kept in chrome.storage.session only
 *    (memory-backed, cleared when the browser closes — never localStorage)
 *  - Signal pipeline: bridge market events → core normalization/matching/
 *    evaluation → panel broadcasts
 *  - Site permissions: explicit per-origin grants, nothing at install time
 */

import {
  SignalRegistry,
  reevaluateAll,
  normalizeObservedMarket,
  DEFAULT_SIGNAL_ENGINE_CONFIG,
  type ObservedMarket,
  type SignalSnapshot,
  type DriveContext,
} from "@propstein/core";
import {
  isTrustedExtensionSender,
  isTrustedBridgeSender,
  validateMarketEventBatch,
  safeOrigin,
  type PanelState,
  type PanelToBackgroundMessage,
  type SessionInfo,
} from "@propstein/browser";
import { SUPPORTED_SITE_ORIGINS, originFor, platformForOrigin, ensureSitePermission, type PermissionsApi } from "@propstein/browser";
import {
  createSyntheticDemoModelProvider,
  type DemoModelProvider,
} from "@propstein/detection";

/* eslint-disable no-restricted-globals */
declare const chrome: {
  runtime: {
    id: string;
    onInstalled: { addListener(cb: () => void): void };
    onMessage: { addListener(cb: (msg: unknown, sender: never, sendResponse: (r: unknown) => void) => boolean | void): void };
    sendMessage(msg: unknown): Promise<unknown>;
  };
  sidePanel: { setPanelBehavior(opts: { openPanelOnActionClick: boolean }): Promise<void> };
  action: { onClicked: { addListener(cb: (tab: { windowId?: number; id?: number }) => void): void } };
  tabs: {
    onActivated: { addListener(cb: (info: { tabId: number }) => void): void };
    onUpdated: { addListener(cb: (tabId: number, info: { status?: string; url?: string }, tab: { url?: string; active?: boolean }) => void): void };
    onRemoved: { addListener(cb: (tabId: number) => void): void };
    query(q: { active?: boolean; currentWindow?: boolean }): Promise<Array<{ id?: number; url?: string; active?: boolean }>>;
    get(tabId: number): Promise<{ id?: number; url?: string; active?: boolean }>;
    sendMessage(tabId: number, msg: unknown): Promise<unknown>;
    create(props: { url: string; active: boolean }): Promise<{ id?: number }>;
  };
  scripting: { executeScript(injection: { target: { tabId: number }; files?: string[] }): Promise<unknown> };
  storage: {
    session: {
      get(keys: string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string[]): Promise<void>;
    };
    local: {
      get(keys: string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
  permissions: {
    contains(p: { origins: string[] }): Promise<boolean>;
    request(p: { origins: string[] }): Promise<boolean>;
    remove(p: { origins: string[] }): Promise<boolean>;
  };
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const SIGNAL_REGISTRY = new SignalRegistry({ config: DEFAULT_SIGNAL_ENGINE_CONFIG });
const MODEL: DemoModelProvider = createSyntheticDemoModelProvider();

interface MonitoringState {
  monitoring: boolean;
  tabId: number | null;
  origin: string | null;
  platform: string | null;
  adapterReason: string | null;
  driveContext: DriveContext | null;
}

/**
 * The last active NON-extension tab — i.e. the sportsbook page the user was
 * actually looking at. Panel pages live in extension origins and must never
 * become monitoring targets (spec §2: only the user's active content tab).
 */
let lastContentTab: { id: number; url: string } | null = null;

function isExtensionUrl(url: string | undefined): boolean {
  return url !== undefined && url.startsWith("chrome-extension://");
}

let monitoring: MonitoringState = {
  monitoring: false,
  tabId: null,
  origin: null,
  platform: null,
  adapterReason: null,
  driveContext: null,
};

const GRANTED_ORIGINS = new Set<string>();
const permissionsApi: PermissionsApi = {
  contains: (origins) => chrome.permissions.contains({ origins }),
  request: (origins) => chrome.permissions.request({ origins }),
  remove: (origins) => chrome.permissions.remove({ origins }),
};

const API_BASE_URL = (globalThis as { __PROPSTEIN_API_BASE__?: string }).__PROPSTEIN_API_BASE__
  ?? "https://propstein.vercel.app";

// ---------------------------------------------------------------------------
// Panel state broadcast
// ---------------------------------------------------------------------------

function currentPanelState(statusOverride?: PanelState["status"]): PanelState {
  let status: PanelState["status"] = "IDLE";
  if (statusOverride) {
    status = statusOverride;
  } else if (monitoring.monitoring) {
    status = "MONITORING";
  }
  const trackedUrl = lastContentTab?.url ?? null;
  const trackedPlatform = trackedUrl ? platformForOrigin(originFor(trackedUrl)) : undefined;
  return {
    status,
    monitoring: monitoring.monitoring,
    activeTabUrl: trackedUrl,
    activeTabId: monitoring.tabId,
    contentTabReady: trackedPlatform !== undefined,
    adapterPlatform: monitoring.platform,
    adapterReason: monitoring.adapterReason,
    signalCount: SIGNAL_REGISTRY.snapshots().filter((s) => !s.withdrawn).length,
    lastUpdateIso: new Date().toISOString(),
  };
}

async function broadcast(message: Record<string, unknown>): Promise<void> {
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // No panel listening — that is normal; ignore.
  }
}

async function broadcastPanelState(statusOverride?: PanelState["status"]): Promise<void> {
  await broadcast({ type: "PANEL_STATE", panelState: currentPanelState(statusOverride) });
}

async function broadcastSnapshots(): Promise<void> {
  await broadcast({ type: "SIGNAL_SNAPSHOTS", snapshots: SIGNAL_REGISTRY.snapshots() });
}

// ---------------------------------------------------------------------------
// Signal pipeline
// ---------------------------------------------------------------------------

function modelForSnapshot(snap: SignalSnapshot) {
  return MODEL.evaluate(snap.normalized!);
}

/**
 * Apply a validated batch of market events from the content bridge.
 *
 * Registry keys are the DIFFER's identity keys (which include the drive id for
 * drive-scoped markets) — a drive transition therefore creates NEW keys, and
 * the old drive's signals are withdrawn as DRIVE ENDED rather than silently
 * overwritten (spec §15 critical test).
 */
function applyMarketEvents(events: Array<{ kind: string; signalKey?: string; market?: ObservedMarket }>): void {
  // Pass 1: adopt the live drive context from ANY market in the batch, so the
  // whole batch is interpreted against the board's CURRENT drive (a drive
  // transition replaces the market set atomically).
  for (const ev of events) {
    const m = ev.market;
    if (m?.driveId && m.eventId) {
      monitoring.driveContext = { driveId: m.driveId, eventId: m.eventId, isActive: true };
    }
  }
  for (const ev of events) {
    if (ev.kind === "NAVIGATED") {
      // SPA navigation: withdraw everything and let re-detection rebuild.
      for (const snap of SIGNAL_REGISTRY.snapshots()) SIGNAL_REGISTRY.remove(snap.signalKey);
      continue;
    }
    if (ev.kind === "REMOVED" && ev.signalKey) {
      const existing = SIGNAL_REGISTRY.get(ev.signalKey);
      const observedDrive = existing?.observed.driveId;
      const currentDrive = monitoring.driveContext?.driveId;
      if (observedDrive && currentDrive && observedDrive !== currentDrive) {
        // Drive transition: every signal on the old possession is invalidated,
        // even if its old price remains cached or visible (spec §15).
        SIGNAL_REGISTRY.driveEnded(observedDrive);
      } else {
        SIGNAL_REGISTRY.remove(ev.signalKey);
      }
      continue;
    }
    const market = ev.market;
    if (!market || !ev.signalKey) continue;
    const signalKey = ev.signalKey;
    const previous = SIGNAL_REGISTRY.get(signalKey);
    const normalized = previous?.normalized ?? normalizeObservedMarket(market);
    const match = MODEL.match(normalized);
    const model = MODEL.evaluate(normalized);
    SIGNAL_REGISTRY.observe(signalKey, market, {
      match,
      ...(model !== undefined ? { model } : {}),
      ...(monitoring.driveContext ? { driveContext: monitoring.driveContext } : {}),
      visible: true,
    });
  }
  // Safety net: any live signal still bound to a drive other than the current
  // one is invalid (covers batches where REMOVED events were not emitted).
  const currentDrive = monitoring.driveContext?.driveId;
  if (currentDrive) {
    for (const snap of SIGNAL_REGISTRY.snapshots()) {
      if (snap.observed.driveId && snap.observed.driveId !== currentDrive && !snap.withdrawn) {
        SIGNAL_REGISTRY.driveEnded(snap.observed.driveId);
      }
    }
  }
  void modelForSnapshot;
}

SIGNAL_REGISTRY.onEvent(async (e) => {
  if (e.type === "alert-raised") await broadcast({ type: "ALERT_RAISED", snapshot: e.snapshot });
  if (e.type === "alert-withdrawn") {
    await broadcast({ type: "ALERT_WITHDRAWN", snapshot: e.snapshot, reason: e.snapshot.withdrawalReason });
  }
});

// Freshness ticker: re-evaluate signals each second so quotes visibly expire.
setInterval(async () => {
  if (!monitoring.monitoring) return;
  reevaluateAll(SIGNAL_REGISTRY, {
    modelLookup: (snap) => (snap.normalized ? MODEL.evaluate(snap.normalized) : undefined),
    matchLookup: (snap) => (snap.normalized ? MODEL.match(snap.normalized) : undefined),
    // Preserve the live drive context on re-evaluation — without it every
    // drive-scoped signal would fail the possession gate and go STALE.
    ...(monitoring.driveContext ? { driveContext: monitoring.driveContext } : {}),
  });
  await broadcastSnapshots();
  await broadcastPanelState();
}, 1000);

// ---------------------------------------------------------------------------
// Monitoring lifecycle
// ---------------------------------------------------------------------------

async function stopMonitoring(reason?: string): Promise<void> {
  if (monitoring.tabId !== null) {
    try {
      await chrome.tabs.sendMessage(monitoring.tabId, { type: "SNIPE_STOP", correlationId: `stop-${Date.now()}` });
    } catch { /* tab may be gone */ }
  }
  monitoring = { ...monitoring, monitoring: false, adapterReason: reason ?? monitoring.adapterReason };
  for (const snap of SIGNAL_REGISTRY.snapshots()) SIGNAL_REGISTRY.remove(snap.signalKey);
  await broadcastSnapshots();
  await broadcastPanelState();
}

async function startMonitoring(): Promise<{ ok: boolean; reason?: string }> {
  // Target the last content tab the user was viewing — never an extension
  // page (the panel itself). Fall back to the active tab when no tab event
  // has been recorded yet (e.g. the service worker started after the page).
  let tab = lastContentTab;
  if (!tab) {
    try {
      const active = await chrome.tabs.query({ active: true, currentWindow: true });
      const candidate = active.find((t) => t.url && !isExtensionUrl(t.url));
      if (candidate?.id !== undefined && candidate.url) tab = { id: candidate.id, url: candidate.url };
    } catch {
      // Tabs API unavailable — leave tab unset and fail with a reason below.
    }
  }
  if (!tab || isExtensionUrl(tab.url)) return { ok: false, reason: "no active content tab — open a supported page first" };
  const origin = originFor(tab.url);
  const platform = platformForOrigin(origin);
  if (!platform) {
    monitoring = { ...monitoring, adapterReason: "no adapter supports this page" };
    await broadcastPanelState("MARKET_UNSUPPORTED");
    return { ok: false, reason: "unsupported site" };
  }
  const perm = await ensureSitePermission(permissionsApi, origin!);
  if (!perm.granted) {
    await broadcast({ type: "PERMISSION_REQUIRED", origin: origin! });
    await broadcastPanelState("PERMISSION_REQUIRED");
    return { ok: false, reason: perm.reason };
  }
  GRANTED_ORIGINS.add(origin!);
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content-bridge.js"] });
  await chrome.tabs.sendMessage(tab.id, { type: "SNIPE_START", correlationId: `start-${Date.now()}` });
  monitoring = {
    monitoring: true,
    tabId: tab.id,
    origin: origin!,
    platform,
    adapterReason: null,
    driveContext: null,
  };
  await broadcastPanelState();
  return { ok: true };
}

// Track the last content tab (non-extension) the user activated, and pause
// observation when the monitored tab goes away (spec §14).
chrome.tabs.onActivated.addListener(async (info) => {
  try {
    const tab = await chrome.tabs.get(info.tabId);
    if (tab.url && !isExtensionUrl(tab.url)) {
      lastContentTab = { id: info.tabId, url: tab.url };
    }
  } catch {
    // Tab already gone — ignore.
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  // Record the latest URL for the tracked content tab (and adopt any
  // fully-loaded content tab seen here — covers the initial page load).
  const url = info.url ?? tab.url;
  if (url && !isExtensionUrl(url)) {
    lastContentTab = { id: tabId, url };
  }
  if (monitoring.tabId === tabId && info.url && originFor(info.url) !== monitoring.origin) {
    await stopMonitoring("tab navigated away from the monitored site");
    return;
  }
  // Re-inject the content bridge after a page load/reload in the monitored
  // tab — MV3 programmatic injection does NOT survive navigation.
  if (
    monitoring.monitoring && monitoring.tabId === tabId && info.status === "complete"
    && url && originFor(url) === monitoring.origin && monitoring.origin
  ) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content-bridge.js"] });
      await chrome.tabs.sendMessage(tabId, { type: "SNIPE_START", correlationId: `reinj-${Date.now()}` });
    } catch {
      // Injection can race a navigation — the next complete event retries.
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (lastContentTab?.id === tabId) lastContentTab = null;
  if (monitoring.tabId === tabId) {
    await stopMonitoring("monitored tab closed");
  }
});

// ---------------------------------------------------------------------------
// Session management (scoped token in chrome.storage.session)
// ---------------------------------------------------------------------------

async function getSession(): Promise<SessionInfo | null> {
  const stored = await chrome.storage.session.get(["propsteinSession"]);
  const s = stored["propsteinSession"] as SessionInfo | undefined;
  if (!s) return null;
  if (Date.parse(s.expiresAtIso) <= Date.now()) return null; // expired
  return s;
}

async function signIn(token: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/v1/extension/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: "membership not active — sign-in rejected" };
    if (!res.ok) return { ok: false, error: `session endpoint returned ${res.status}` };
    const data = (await res.json()) as { tier?: string; expires_at?: string; provider?: string };
    const session: SessionInfo = {
      tier: data.tier === "pro" ? "pro" : "free",
      provider: data.provider ?? "unknown",
      expiresAtIso: data.expires_at ?? new Date(Date.now() + 15 * 60_000).toISOString(),
      refreshedAtIso: new Date().toISOString(),
    };
    await chrome.storage.session.set({ propsteinSession: session });
    await broadcast({ type: "SESSION_UPDATE", session });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function signOut(): Promise<void> {
  await chrome.storage.session.remove(["propsteinSession"]);
  await broadcast({ type: "SESSION_UPDATE", session: null });
}

// Session expiry watcher → SESSION_EXPIRED status (fail closed).
setInterval(async () => {
  const stored = await chrome.storage.session.get(["propsteinSession"]);
  const s = stored["propsteinSession"] as SessionInfo | undefined;
  if (s && Date.parse(s.expiresAtIso) <= Date.now()) {
    await chrome.storage.session.remove(["propsteinSession"]);
    await broadcast({ type: "SESSION_UPDATE", session: null });
    await broadcastPanelState("SESSION_EXPIRED");
  }
}, 15_000);

// ---------------------------------------------------------------------------
// Message router (origin-validated)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg: unknown, sender: never, sendResponse: (r: unknown) => void) => {
  const message = msg as Record<string, unknown> | undefined;
  if (!message || typeof message.type !== "string") return;

  // ---- Content-bridge traffic (from a granted site) ----
  const bridgeTypes = new Set(["MARKET_EVENTS", "SNIPE_ACK", "BRIDGE_STATUS"]);
  if (bridgeTypes.has(message.type)) {
    if (!isTrustedBridgeSender(sender as never, chrome.runtime, GRANTED_ORIGINS)) {
      sendResponse({ error: "untrusted sender" });
      return;
    }
    if (message.type === "MARKET_EVENTS") {
      const validated = validateMarketEventBatch(message);
      if (validated.ok) {
        applyMarketEvents(validated.events.events as Array<{ kind: string; signalKey?: string; market?: ObservedMarket }>);
        void broadcastSnapshots();
        void broadcastPanelState();
        sendResponse({ received: true });
      } else {
        sendResponse({ error: validated.reason });
      }
      return;
    }
    sendResponse({ received: true });
    return;
  }

  // ---- Panel traffic (extension pages only) ----
  if (!isTrustedExtensionSender(sender as never, chrome.runtime)) {
    sendResponse({ error: "untrusted sender" });
    return;
  }
  const panelMsg = message as unknown as PanelToBackgroundMessage;
  switch (panelMsg.type) {
    case "START_MONITORING": {
      startMonitoring().then((r) => sendResponse(r));
      return true;
    }
    case "STOP_MONITORING": {
      stopMonitoring().then(() => sendResponse({ ok: true }));
      return true;
    }
    case "REQUEST_SITE_PERMISSION": {
      ensureSitePermission(permissionsApi, panelMsg.origin).then((r) => sendResponse(r));
      return true;
    }
    case "SIGN_IN": {
      signIn(panelMsg.token).then((r) => sendResponse(r));
      return true;
    }
    case "SIGN_OUT": {
      signOut().then(() => sendResponse({ ok: true }));
      return true;
    }
    case "REFRESH_SESSION": {
      getSession().then((s) => sendResponse({ ok: s !== null, session: s }));
      return true;
    }
    case "GET_STATE": {
      (async () => {
        const session = await getSession();
        sendResponse({ panelState: currentPanelState(), session, snapshots: SIGNAL_REGISTRY.snapshots() });
      })();
      return true;
    }
    case "OPEN_DEMO_PAGE": {
      chrome.tabs.create({ url: "http://localhost:4173/demobook", active: true }).then((t) => {
        if (t.id) lastContentTab = { id: t.id, url: "http://localhost:4173/demobook" };
        sendResponse({ ok: true, tabId: t.id });
      });
      return true;
    }
    case "UPDATE_SETTINGS": {
      chrome.storage.local.set({ sniperSettings: panelMsg.settings }).then(() => sendResponse({ ok: true }));
      return true;
    }
    default:
      sendResponse({ error: "unknown message type" });
  }
});

// ---------------------------------------------------------------------------
// Install / action
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.action.onClicked.addListener((tab) => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  void tab.windowId;
});

export {};
