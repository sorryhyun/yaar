/**
 * Shared reactive state for the Real Browser app: the UI and the App Protocol read the same
 * `tabs` / `connected` signals. `pollOnce()` is the only thing that refreshes them from the
 * Bridge; the UI calls it on an interval and the `refresh` command on demand.
 */
export {};
import { createSignal } from '@bundled/solid-js';
import { listTabs, type Tab } from './bridge';

const [tabs, setTabs] = createSignal<Tab[]>([]);
const [connected, setConnected] = createSignal(false);
const [loaded, setLoaded] = createSignal(false);

export { tabs, connected, loaded };

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
