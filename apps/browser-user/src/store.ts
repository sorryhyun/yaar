/**
 * Shared reactive state for the Real Browser app.
 *
 * Both the UI (main.ts) and the App Protocol (protocol.ts) read/write the same
 * `tabs` / `connected` signals, so the agent always sees exactly what the user
 * sees. `pollOnce()` is the single source of truth for refreshing that state
 * from the Bridge — the UI calls it on an interval; the protocol's `refresh`
 * command calls it on demand.
 */
export {};
import { createSignal } from '@bundled/solid-js';
import { listTabs, type Tab } from './bridge';

const [tabs, setTabs] = createSignal<Tab[]>([]);
const [connected, setConnected] = createSignal(false);
const [loaded, setLoaded] = createSignal(false);

export { tabs, connected, loaded };

/** The currently active tab, or null. */
export function activeTab(): Tab | null {
  return tabs().find((t) => t.active) ?? null;
}

/**
 * Poll the Bridge once and update the shared signals.
 * Returns the fresh tab list (empty when disconnected).
 */
export async function pollOnce(): Promise<Tab[]> {
  const res = await listTabs();
  if (res.ok && res.data && Array.isArray(res.data.tabs) && res.data.connected) {
    setTabs(res.data.tabs);
    setConnected(true);
    setLoaded(true);
    return res.data.tabs;
  }
  setTabs([]);
  setConnected(false);
  setLoaded(true);
  return [];
}
