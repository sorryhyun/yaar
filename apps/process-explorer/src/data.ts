export {};

import { createSignal, createMemo, onCleanup } from '@bundled/solid-js';
import { list, invoke, del, subscribe, showToast } from '@bundled/yaar';
import { listTabs, closeTab } from '@bundled/yaar-web';
import type { AgentStats, AgentEntry, WindowInfo, BrowserTab, TabId } from './types';

// ── Signals ──────────────────────────────────────────────────

const [agentStats, setAgentStats] = createSignal<AgentStats | null>(null);
const [windows, setWindows] = createSignal<WindowInfo[]>([]);
const [browsers, setBrowsers] = createSignal<BrowserTab[]>([]);
const [lastRefresh, setLastRefresh] = createSignal<Date | null>(null);
const [activeTab, setActiveTab] = createSignal<TabId>('agents');

export { agentStats, windows, browsers, lastRefresh, activeTab };

/**
 * Switch tabs. Opening the browsers tab fetches immediately rather than waiting
 * out the poll interval — the other two tabs are pushed to by subscriptions.
 */
export function selectTab(tab: TabId) {
  setActiveTab(tab);
  if (tab === 'browsers') {
    void fetchBrowsers().then(() => setLastRefresh(new Date()));
  }
}

// ── Derived: agent list from stats ───────────────────────────

export const agentList = createMemo<AgentEntry[]>(() => agentStats()?.agents ?? []);

// ── Fetch functions ──────────────────────────────────────────

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
    // Adapt resource_link format { uri, name, description } → WindowInfo
    setWindows(
      raw.map((entry: any) => {
        if (entry.uri && entry.name != null && !entry.id) {
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

async function fetchBrowsers() {
  try {
    const data = await listTabs() as BrowserTab[] | { data: BrowserTab[] };
    const tabs = Array.isArray(data) ? data : Array.isArray((data as { data: BrowserTab[] })?.data) ? (data as { data: BrowserTab[] }).data : [];
    setBrowsers(tabs);
  } catch {
    setBrowsers([]);
  }
}

export async function refreshAll() {
  await Promise.all([fetchAgents(), fetchWindows(), fetchBrowsers()]);
  setLastRefresh(new Date());
}

// ── Watching ─────────────────────────────────────────────────

/** Interval for the browsers tab, which has nothing to subscribe to. */
const BROWSER_POLL_MS = 5000;

/**
 * Subscribe rather than poll. The server pushes a change ping whenever an agent
 * is created, disposed, or flips busy/idle, and on every window.* action — so a
 * quiet desktop costs nothing and a busy one updates as it happens.
 *
 * Browser tabs are the exception: they live in Chrome, not in YAAR's state, so
 * nothing notifies us when the user opens one. They stay on a timer, and only
 * while the user is actually looking at that tab.
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

  const timer = setInterval(() => {
    if (activeTab() !== 'browsers') return;
    void fetchBrowsers().then(() => setLastRefresh(new Date()));
  }, BROWSER_POLL_MS);
  onCleanup(() => clearInterval(timer));
}

// ── Actions ──────────────────────────────────────────────────

// Each action re-fetches only the list it touched. The subscription would push
// the same change a moment later, but refreshing here keeps the row from lingering
// if the ping is lost — and re-fetching all three would mean a CDP round-trip on
// every button click.

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

export async function closeBrowser(browserId: string) {
  try {
    await closeTab(browserId);
    showToast(`Closed browser tab`, 'success');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Close failed', 'error');
  }
  await fetchBrowsers();
  setLastRefresh(new Date());
}
