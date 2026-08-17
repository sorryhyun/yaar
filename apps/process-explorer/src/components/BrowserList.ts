export {};

import { Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { browsers, killBrowser, reviveBrowser } from '../data';
import { formatBytes, formatIdle } from '../format';
import { browserStateColor } from '../theme';
import type { BrowserSession } from '../types';
import { ProcessList } from './ProcessList';

/** Host of a URL, which is what identifies a tab at a glance. Falls back to the raw string. */
function host(url: string) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function BrowserRow(props: { session: BrowserSession }) {
  const b = () => props.session;
  const suspended = () => b().state !== 'live';

  return html`
    <div class="process-row">
      <div class="process-info">
        <div class="process-detail">
          <div class="process-title">
            ${() => b().title || host(b().url) || '(new tab)'}
          </div>
          <div class="process-meta">
            <span class="y-badge" style=${() => `border-color:${browserStateColor(b().state)}`}
              >${() => b().state}</span
            >
            <span class="y-badge">${() => b().id}</span>
            ${() => (b().mobile ? html`<span class="y-badge">mobile</span>` : null)}
            ${() => (b().driving ? html`<span class="y-badge">agent driving</span>` : null)}
            ${() => (b().viewers > 0 ? html`<span class="y-badge">watching</span>` : null)}
            <span class="y-truncate">${() => host(b().url)}</span>
            <span>${() => formatIdle(b().idleMs)}</span>
            ${() =>
              b().jsHeapBytes !== null
                ? html`<span>${formatBytes(b().jsHeapBytes as number)}</span>`
                : null}
          </div>
        </div>
      </div>
      <div class="process-actions">
        <${Show} when=${suspended}>
          <button
            class="y-btn y-btn-ghost btn-sm"
            onClick=${() => reviveBrowser(b().id)}
            title="Reopen this session on the page it was left on"
          >
            Revive
          </button>
        </>
        <button
          class="y-btn y-btn-ghost btn-sm btn-danger"
          onClick=${() => killBrowser(b().id)}
          title="Close this browser session and its window"
        >
          Kill
        </button>
      </div>
    </div>
  `;
}

/**
 * The sandbox browser's sessions, as processes.
 *
 * Lists suspended sessions beside live ones on purpose: a `browserId` whose socket
 * is gone still names a page and a profile, and "this tab exists but nothing is
 * connected to it" is exactly the state a user needs to be able to see — and act
 * on — rather than discover through a window that will not paint.
 */
export function BrowserList() {
  return html`
    <${ProcessList} each=${browsers} icon="◍" emptyText="No browser sessions"
      >${(session: BrowserSession) => html`<${BrowserRow} session=${session} />`}</
    >
  `;
}
