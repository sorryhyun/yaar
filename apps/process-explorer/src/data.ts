export {};

import { createSignal, createMemo, onCleanup } from '@bundled/solid-js';
import { list, invoke, del, subscribe, showToast } from '@bundled/yaar';
import type { AgentStats, AgentEntry, WindowInfo, InstalledApp, AppProcess, TabId } from './types';

// ── Signals ──────────────────────────────────────────────────

const [agentStats, setAgentStats] = createSignal<AgentStats | null>(null);
const [windows, setWindows] = createSignal<WindowInfo[]>([]);
const [installedApps, setInstalledApps] = createSignal<InstalledApp[]>([]);
const [lastRefresh, setLastRefresh] = createSignal<Date | null>(null);
const [activeTab, setActiveTab] = createSignal<TabId>('agents');

export { agentStats, windows, installedApps, lastRefresh, activeTab };

export function selectTab(tab: TabId) {
  setActiveTab(tab);
}

// ── Derived ──────────────────────────────────────────────────

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
    if (agent.type === 'app' && agent.appId) slot(agent.appId).agent = agent;
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

// ── Fetch functions ──────────────────────────────────────────

/**
 * Adapt a resource_link list — `{ uri, name, description }` — into a flat record.
 * The verb layer returns links for `yaar://windows` and `yaar://apps` alike.
 */
function isResourceLink(entry: any): boolean {
  return entry && entry.uri && entry.name != null && !entry.id;
}

async function fetchAgents() {
  try {
    const data = await list<AgentStats>('yaar://session/agents');
    if (data) setAgentStats(data);
  } catch {
    setAgentStats(null);
  }
}

async function fetchWindows() {
  try {
    const raw = await list<unknown[]>('yaar://windows');
    if (!Array.isArray(raw)) {
      setWindows([]);
      return;
    }
    setWindows(
      raw.map((entry: any) => {
        if (isResourceLink(entry)) {
          const id = entry.uri.replace(/^yaar:\/\/windows\//, '');
          const parts: string[] = (entry.description ?? '').split(', ');
          const appPart = parts.find((p: string) => p.startsWith('app:'));
          return {
            id,
            uri: entry.uri,
            title: entry.name,
            renderer: parts[0] ?? '',
            size: parts[1] ?? '',
            position: '',
            locked: parts.includes('locked'),
            appId: appPart?.slice(4),
          } as WindowInfo;
        }
        return entry as WindowInfo;
      }),
    );
  } catch {
    setWindows([]);
  }
}

/**
 * The installed-app roster, for display names only — the running set comes from
 * windows and agents. Fetched once at mount: apps change on install/uninstall,
 * which is rare and doesn't push a change ping. An app installed mid-session just
 * shows its appId until the next refresh.
 */
async function fetchApps() {
  try {
    const raw = await list<unknown[]>('yaar://apps');
    if (!Array.isArray(raw)) {
      setInstalledApps([]);
      return;
    }
    setInstalledApps(
      raw.map((entry: any) => {
        if (isResourceLink(entry)) {
          return {
            id: entry.uri.replace(/^yaar:\/\/apps\//, ''),
            name: entry.name,
            description: entry.description,
          } as InstalledApp;
        }
        return entry as InstalledApp;
      }),
    );
  } catch {
    setInstalledApps([]);
  }
}

export async function refreshAll() {
  await Promise.all([fetchAgents(), fetchWindows(), fetchApps()]);
  setLastRefresh(new Date());
}

// ── Watching ─────────────────────────────────────────────────

/**
 * Subscribe rather than poll. The server pushes a change ping whenever an agent is
 * created, disposed, or flips busy/idle, and on every window.* action — so a quiet
 * desktop costs nothing and a busy one updates as it happens.
 *
 * The apps view needs no subscription of its own: it is derived from these same two
 * lists, so it re-renders whenever either is pushed.
 */
export function startWatching() {
  refreshAll();

  const watch = (uri: string, onChange: () => void) => {
    let unsubscribe: (() => void) | null = null;
    let cancelled = false;

    subscribe(uri, () => {
      void onChange();
      setLastRefresh(new Date());
    })
      .then((unsub) => {
        // Unmounted before the subscription landed — drop it immediately.
        if (cancelled) unsub();
        else unsubscribe = unsub;
      })
      .catch((err) => {
        console.error(`[process-explorer] subscribe(${uri}) failed`, err);
        showToast(`Live updates unavailable for ${uri}`, 'error');
      });

    onCleanup(() => {
      cancelled = true;
      unsubscribe?.();
    });
  };

  watch('yaar://session/agents', fetchAgents);
  watch('yaar://windows', fetchWindows);
}

// ── Actions ──────────────────────────────────────────────────

// Each action re-fetches only the list it touched. The subscription would push the
// same change a moment later, but refreshing here keeps the row from lingering if
// the ping is lost.

export async function interruptAgent(agentId: string) {
  try {
    await invoke(`yaar://session/agents/${agentId}`, { action: 'interrupt' });
    showToast(`Interrupted ${agentId}`, 'success');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Interrupt failed', 'error');
  }
  await fetchAgents();
  setLastRefresh(new Date());
}

export async function closeWindow(windowId: string) {
  try {
    await del(`yaar://windows/${windowId}`);
    showToast(`Closed window`, 'success');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Close failed', 'error');
  }
  await fetchWindows();
  setLastRefresh(new Date());
}

/**
 * Kill an app's agent, freeing its slot and dropping its context. The app itself
 * stays installed and its windows stay open — the next interaction spawns a fresh
 * agent. This is the only way to reclaim an orphaned agent.
 */
export async function killAppAgent(appId: string) {
  try {
    await del(`yaar://session/agents/${appId}`);
    showToast(`Killed ${appId} agent`, 'success');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Kill failed', 'error');
  }
  await fetchAgents();
  setLastRefresh(new Date());
}

/** Close every open window belonging to an app. Leaves the app agent alone. */
export async function closeAppWindows(appId: string) {
  const targets = appProcesses().find((p) => p.appId === appId)?.windows ?? [];
  if (targets.length === 0) return;

  try {
    await Promise.all(targets.map((w) => del(`yaar://windows/${w.id}`)));
    showToast(`Closed ${targets.length} window${targets.length === 1 ? '' : 's'}`, 'success');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Close failed', 'error');
  }
  await fetchWindows();
  setLastRefresh(new Date());
}
