export {};

import { createSignal, createMemo, onCleanup } from '@bundled/solid-js';
import { list, invoke, del, showToast } from '@bundled/yaar';
import { listTabs, closeTab } from '@bundled/yaar-web';
import type { AgentStats, AgentEntry, WindowInfo, BrowserTab } from './types';

// ── Signals ──────────────────────────────────────────────────

const [agentStats, setAgentStats] = createSignal<AgentStats | null>(null);
const [windows, setWindows] = createSignal<WindowInfo[]>([]);
const [browsers, setBrowsers] = createSignal<BrowserTab[]>([]);
const [lastRefresh, setLastRefresh] = createSignal<Date | null>(null);

export { agentStats, windows, browsers, lastRefresh };

// ── Derived: agent list from stats ───────────────────────────

export const agentList = createMemo<AgentEntry[]>(() => {
  const stats = agentStats();
  if (!stats) return [];
  const entries: AgentEntry[] = [];

  for (const id of stats.monitorAgent) {
    entries.push({ id, type: 'monitor' });
  }
  for (const id of stats.ephemeralAgents) {
    entries.push({ id, type: 'ephemeral' });
  }
  if (stats.sessionAgent?.exists) {
    entries.push({ id: 'session', type: 'session', busy: stats.sessionAgent.busy });
  }
  // App agents are a count — we don't have individual IDs from the stats endpoint
  if (stats.appAgents > 0) {
    for (let i = 0; i < stats.appAgents; i++) {
      entries.push({ id: `app-${i}`, type: 'app' });
    }
  }

  return entries;
});

// ── Fetch functions ──────────────────────────────────────────

async function fetchAgents() {
  try {
    const data = await list<AgentStats>('yaar://sessions/current/agents');
    if (data) setAgentStats(data);
  } catch {
    setAgentStats(null);
  }
}

async function fetchWindows() {
  try {
    const data = await list<WindowInfo[]>('yaar://windows');
    setWindows(Array.isArray(data) ? data : []);
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

// ── Polling ──────────────────────────────────────────────────

export function startPolling(interval = 3000) {
  refreshAll();
  const timer = setInterval(refreshAll, interval);
  onCleanup(() => clearInterval(timer));
}

// ── Actions ──────────────────────────────────────────────────

export async function interruptAgent(agentId: string) {
  try {
    await invoke(`yaar://sessions/current/agents/${agentId}`, { action: 'interrupt' });
    showToast(`Interrupted ${agentId}`, 'success');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Interrupt failed', 'error');
  }
  await refreshAll();
}

export async function closeWindow(windowId: string) {
  try {
    await del(`yaar://windows/${windowId}`);
    showToast(`Closed window`, 'success');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Close failed', 'error');
  }
  await refreshAll();
}

export async function closeBrowser(browserId: string) {
  try {
    await closeTab(browserId);
    showToast(`Closed browser tab`, 'success');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Close failed', 'error');
  }
  await refreshAll();
}
