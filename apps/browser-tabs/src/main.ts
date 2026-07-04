export {};
import { createSignal, For, Show, onCleanup } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import { read, subscribe } from '@bundled/yaar';

const TABS_URI = 'yaar://browser/tabs';

interface Tab {
  id: number;
  url: string;
  title: string;
  active?: boolean;
  audible?: boolean;
  isSelf?: boolean;
}

const [tabs, setTabs] = createSignal<Tab[]>([]);
const [connected, setConnected] = createSignal(false);
const [loaded, setLoaded] = createSignal(false);

async function refresh() {
  try {
    const raw = await read<unknown>(TABS_URI);
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    // The handler returns either { fidelity, tabs } (connected) or a plain
    // "not connected" text string (which JSON.parse throws on → caught below).
    if (data && Array.isArray(data.tabs)) {
      setTabs(data.tabs as Tab[]);
      setConnected(true);
    } else {
      setTabs([]);
      setConnected(false);
    }
  } catch {
    // Non-JSON text ("Bridge is not connected …")
    setTabs([]);
    setConnected(false);
  } finally {
    setLoaded(true);
  }
}

// Initial load + live updates whenever the Bridge pushes a change.
refresh();
subscribe(TABS_URI, () => refresh()).then((unsub) => onCleanup(unsub));

function faviconHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function TabRow(tab: Tab) {
  return html`
    <div class="y-list-item" style="display:flex; align-items:center; gap:var(--yaar-sp-2);">
      <div style="flex:1; min-width:0;">
        <div class="y-truncate" style="font-weight:500;">${() => tab.title || '(untitled)'}</div>
        <div class="y-truncate" style="color:var(--yaar-text-muted); font-size:0.85em;">
          ${() => faviconHost(tab.url) || tab.url}
        </div>
      </div>
      ${() => (tab.active ? html`<span class="y-badge">active</span>` : null)}
      ${() => (tab.audible ? html`<span class="y-badge">🔊</span>` : null)}
      ${() => (tab.isSelf ? html`<span class="y-badge">self</span>` : null)}
    </div>
  `;
}

function App() {
  return html`
    <div class="y-app" style="position:absolute; inset:0; display:flex; flex-direction:column;">
      <div
        class="y-toolbar"
        style="display:flex; align-items:center; justify-content:space-between;"
      >
        <span class="y-label">Real Tabs</span>
        <span
          class="y-badge"
          style=${() =>
            connected()
              ? 'background:var(--yaar-success);'
              : 'background:var(--yaar-border); color:var(--yaar-text-muted);'}
        >
          ${() => (connected() ? `bridge · ${tabs().length}` : 'disconnected')}
        </span>
      </div>

      <div style="flex:1; overflow:auto; padding:var(--yaar-sp-2);">
        <${Show}
          when=${() => loaded()}
          fallback=${html`<div class="y-empty"><div class="y-empty-icon">⏳</div>Loading…</div>`}
        >
          <${Show}
            when=${() => connected() && tabs().length > 0}
            fallback=${html`
              <div class="y-empty">
                <div class="y-empty-icon">🔌</div>
                YAAR Bridge not connected. Load the extension (see
                <code>extension/README.md</code>) and it'll appear here live.
              </div>
            `}
          >
            <${For} each=${() => tabs()}>${(tab: Tab) => TabRow(tab)}<//>
          <//>
        <//>
      </div>
    </div>
  `;
}

const root = document.getElementById('app') ?? document.body;
render(App, root);
