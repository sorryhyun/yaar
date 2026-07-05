export {};
import { For, Show, onCleanup } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import * as bridge from './bridge';
import type { Tab } from './bridge';
import { tabs, connected, loaded, pollOnce } from './store';
import { registerBrowserUserProtocol } from './protocol';

const POLL_INTERVAL_MS = 1200;

// Initial load + live polling of the real tab feed.
pollOnce();
const timer = setInterval(() => pollOnce(), POLL_INTERVAL_MS);
onCleanup(() => clearInterval(timer));

function faviconHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** Fire a Bridge action at a tab. Server-side guards handle consent / self-target refusal. */
async function act(tab: Tab, action: 'focus' | 'close' | 'track') {
  try {
    if (action === 'focus') await bridge.focus(tab.id);
    else if (action === 'close') await bridge.close(tab.id);
    else await bridge.track(tab.id);
    // Trigger an immediate refresh so the list reflects the change without waiting a full tick.
    pollOnce();
  } catch (err) {
    console.error(`[real-tabs] ${action} failed`, err);
  }
}

function TabRow(tab: Tab) {
  // Handlers bound once here (outside the reactive template) — Solid re-fires event props
  // passed reactively, so keep these stable per row.
  const onFocus = () => act(tab, 'focus');
  const onTrack = () => act(tab, 'track');
  const onClose = () => act(tab, 'close');
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
      <div class="y-flex" style="gap:var(--yaar-sp-1); flex:0 0 auto;">
        <button class="y-btn y-btn-ghost" title="Show a tracking cursor on this tab" onClick=${onTrack}>👁</button>
        <button class="y-btn y-btn-ghost" title="Focus this tab" onClick=${onFocus}>Focus</button>
        ${() =>
          tab.isSelf
            ? null
            : html`<button class="y-btn y-btn-danger" title="Close this tab" onClick=${onClose}>✕</button>`}
      </div>
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

// ── App Protocol ─────────────────────────────────────────────────────────
registerBrowserUserProtocol();
