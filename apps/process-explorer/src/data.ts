export {};

import { createSignal, createMemo, createEffect, onCleanup } from '@bundled/solid-js';
import { createStore } from '@bundled/solid-js/store';
import { list, invoke, del, subscribe, stream, showToast, type StreamFrame } from '@bundled/yaar';
import type {
  AgentStats,
  AgentEntry,
  AgentActivity,
  WindowInfo,
  InstalledApp,
  AppProcess,
  TabId,
} from './types';

// ── Signals ──────────────────────────────────────────────────

const [agentStats, setAgentStats] = createSignal<AgentStats | null>(null);
const [windows, setWindows] = createSignal<WindowInfo[]>([]);
const [installedApps, setInstalledApps] = createSignal<InstalledApp[]>([]);
const [lastRefresh, setLastRefresh] = createSignal<Date | null>(null);
const [activeTab, setActiveTab] = createSignal<TabId>('agents');

export { agentStats, windows, installedApps, lastRefresh, activeTab };

/**
 * Live per-agent activity, keyed by agent id, folded from each agent's stream.
 * A fine-grained store so a frame for one agent re-renders only that row.
 */
const [agentActivity, setAgentActivity] = createStore<Record<string, AgentActivity>>({});
export { agentActivity };

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

  // Live activity: subscribe to each agent's stream, reconciling as the roster
  // changes. The subscription set is derived from agentList(), so an agent that
  // appears gets a stream and one that disappears has it torn down.
  createEffect(() => reconcileStreams(agentList()));
  onCleanup(() => {
    for (const stop of streamStops.values()) stop();
    streamStops.clear();
  });

  // Freshness is the one readout that changes with no frame arriving — "3s ago"
  // has to become "4s ago" on its own — so it needs a clock of its own.
  const clock = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(clock));
}

/** Ticks once a second so `updatedAt` can be rendered as elapsed time. */
const [now, setNow] = createSignal(Date.now());
export { now };

// ── Live agent streams ───────────────────────────────────────

/** Longest tail of streamed assistant text we keep per agent. */
const TEXT_TAIL_CHARS = 200;

/** Active stream unsubscribers, keyed by agent id. */
const streamStops = new Map<string, () => void>();

/**
 * Fold one frame from agent `id`'s stream into its live activity.
 *
 * `start` *replaces* the record rather than merging into it — that is the whole
 * point of the boundary. Every other kind merges, and every kind refreshes
 * `updatedAt` so a row can show how long it has been since the agent last said
 * anything.
 */
function onAgentFrame(id: string, frame: StreamFrame) {
  const data = (frame.data ?? {}) as {
    delta?: string;
    toolName?: string;
    status?: string;
    error?: string;
  };
  const at = frame.ts;

  switch (frame.kind) {
    case 'start':
      // A new turn: drop last turn's text tail and tool line entirely.
      setAgentActivity(id, { state: 'responding', updatedAt: at });
      break;
    case 'tool':
      setAgentActivity(id, (prev) => ({
        ...prev,
        // A finished tool hands the turn back to the model; only a running one
        // is 'using-tool'.
        state: data.status === 'running' ? 'using-tool' : 'responding',
        tool: { name: data.toolName ?? 'tool', status: data.status ?? 'running' },
        updatedAt: at,
      }));
      break;
    case 'text':
      setAgentActivity(id, (prev) => ({
        ...prev,
        state: 'responding',
        text: ((prev?.text ?? '') + (data.delta ?? '')).slice(-TEXT_TAIL_CHARS),
        updatedAt: at,
      }));
      break;
    case 'done':
      setAgentActivity(id, (prev) => ({
        ...prev,
        state: 'done',
        endStatus: data.status === 'interrupted' ? 'interrupted' : 'completed',
        updatedAt: at,
      }));
      break;
    case 'error':
      setAgentActivity(id, (prev) => ({
        ...prev,
        state: 'error',
        error: data.error ?? 'error',
        updatedAt: at,
      }));
      break;
  }
}

/**
 * Reconcile the set of live streams against the current roster. Subscribes to any
 * non-session agent we aren't already watching, and drops streams for agents that
 * are gone. The session agent's stream is shielded server-side (it would 403), so
 * we never ask for it.
 */
function reconcileStreams(agents: AgentEntry[]) {
  const live = new Set<string>();
  for (const agent of agents) {
    if (agent.type === 'session') continue;
    live.add(agent.id);
    if (streamStops.has(agent.id)) continue;

    // Reserve the slot synchronously so a second reconcile before the async
    // subscribe resolves doesn't open a duplicate.
    streamStops.set(agent.id, () => {});
    stream(`yaar://agents/${agent.id}/stream`, (frame) => onAgentFrame(agent.id, frame), {
      // `start` and `error` are as load-bearing as the content kinds: one resets
      // the row per turn, the other is a terminal the row would otherwise miss.
      kinds: ['start', 'text', 'tool', 'done', 'error'],
    })
      .then((stop) => {
        // Torn down (agent vanished) before the subscription landed — drop it.
        if (streamStops.has(agent.id)) streamStops.set(agent.id, stop);
        else stop();
      })
      .catch(() => {
        streamStops.delete(agent.id);
      });
  }

  for (const [id, stop] of streamStops) {
    if (live.has(id)) continue;
    stop();
    streamStops.delete(id);
    setAgentActivity(id, undefined!);
  }
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
