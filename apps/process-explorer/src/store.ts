export {};

// The app's reactive state: the raw signals the fetchers fill, the views derived
// from them, and the small mutators everything else goes through. No I/O happens
// here — see fetchers.ts, streams.ts and actions.ts.

import { createMemo, createSignal } from '@bundled/solid-js';
import { createStore } from '@bundled/solid-js/store';
import { AGENT_TIER, TAB_IDS } from './constants';
import type {
  AgentActivity,
  AgentEntry,
  AgentStats,
  AppProcess,
  BrowserSession,
  InstalledApp,
  TabId,
  WindowInfo,
} from './types';

// ── Raw state ────────────────────────────────────────────────────

const [agentStats, setAgentStats] = createSignal<AgentStats | null>(null);
const [windows, setWindows] = createSignal<WindowInfo[]>([]);
const [installedApps, setInstalledApps] = createSignal<InstalledApp[]>([]);
const [browsers, setBrowsers] = createSignal<BrowserSession[]>([]);
const [lastRefresh, setLastRefresh] = createSignal<Date | null>(null);
const [activeTab, setActiveTab] = createSignal<TabId>(TAB_IDS[0]);

/** Ticks once a second so `updatedAt` can be rendered as elapsed time. */
const [now, setNow] = createSignal(Date.now());

// `installedApps` is deliberately not exported: it feeds display names into
// appProcesses() and nothing outside this file has a use for the raw roster.
export { agentStats, windows, browsers, lastRefresh, activeTab, now };
export { setAgentStats, setWindows, setInstalledApps, setBrowsers, setNow };

/**
 * Live per-agent activity, keyed by agent id, folded from each agent's stream.
 * A fine-grained store so a frame for one agent re-renders only that row.
 */
const [agentActivity, setAgentActivity] = createStore<Record<string, AgentActivity>>({});
export { agentActivity, setAgentActivity };

// ── Mutators ───────────────────────────────────────────────────

export function selectTab(tab: TabId) {
  setActiveTab(tab);
}

/**
 * Stamp "last refresh" as of now. Called after every successful fetch and every
 * pushed change, so the status bar reports when the panel last agreed with the
 * server rather than when the user last pressed Refresh.
 */
export function markRefreshed() {
  setLastRefresh(new Date());
}

/**
 * Drop an agent's activity record. `undefined!` is the documented solid-store
 * idiom for deleting a key — the non-null assertion is what lets the setter's
 * value type stay `AgentActivity` for every other caller.
 */
export function clearActivity(agentId: string) {
  setAgentActivity(agentId, undefined!);
}

// ── Derived views ──────────────────────────────────────────────

export const agentList = createMemo<AgentEntry[]>(() => agentStats()?.agents ?? []);

/**
 * Running apps, joined from the two lists we already subscribe to: windows carry
 * an appId, and so do app agents. An app is running if it has either. Sorted so
 * orphans (agent alive, no windows) surface first — they're the ones you'd want
 * to kill.
 */
export const appProcesses = createMemo<AppProcess[]>(() => {
  const names = new Map(installedApps().map((a) => [a.id, a.name]));
  const byApp = new Map<string, AppProcess>();

  const slot = (appId: string): AppProcess => {
    let proc = byApp.get(appId);
    if (!proc) {
      proc = { appId, name: names.get(appId) ?? appId, windows: [], agent: null, orphaned: false };
      byApp.set(appId, proc);
    }
    return proc;
  };

  for (const win of windows()) {
    if (win.appId) slot(win.appId).windows.push(win);
  }
  for (const agent of agentList()) {
    if (agent.type === AGENT_TIER.app && agent.appId) slot(agent.appId).agent = agent;
  }

  const procs = [...byApp.values()];
  for (const proc of procs) {
    proc.orphaned = proc.agent !== null && proc.windows.length === 0;
  }

  return procs.sort((a, b) => {
    if (a.orphaned !== b.orphaned) return a.orphaned ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
});
