import { onCleanup, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { subscribe } from '@bundled/yaar';
import { loadServers } from '../actions';
import { MCP_URI } from '../constants';
import { logError } from '../log';
import { ProbeSection } from './ProbeSection';
import { ScanSection } from './ScanSection';
import { ServerList } from './ServerList';

/**
 * Follow the gateway: it pings this URI whenever a server connects,
 * disconnects or re-caches its tools, which is what makes the list "live".
 *
 * `subscribe` resolves *after* mount, so the unsubscribe thunk can arrive once
 * the component is already gone — hence the `disposed` flag, which calls it
 * immediately rather than leaking the subscription.
 */
function watchGateway(): void {
  let unsubscribe: (() => void) | undefined;
  let disposed = false;

  subscribe(MCP_URI, () => {
    void loadServers();
  })
    .then((fn) => {
      if (disposed) fn();
      else unsubscribe = fn;
    })
    .catch((err) => {
      // The list still works, it just stops updating itself — not worth a toast.
      logError('live status subscription failed', err);
    });

  onCleanup(() => {
    disposed = true;
    unsubscribe?.();
  });
}

export function App() {
  onMount(() => {
    void loadServers();
    watchGateway();
  });

  return html`
    <div class="y-app mcp-app">
      <${ProbeSection} />
      <${ScanSection} />
      <${ServerList} />
    </div>
  `;
}