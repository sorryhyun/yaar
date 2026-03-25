/**
 * Browser app — entry point.
 * Wires together store, SSE, actions, UI render, and App Protocol.
 *
 * Responsibilities:
 *   - Initialize SSE with the DOM-level refreshScreenshot callback
 *   - Define the high-level attach() orchestration (store + SSE)
 *   - Render the Solid.js UI tree
 *   - Register the App Protocol (./protocol.ts)
 */
import { onCleanup } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
// Store: signals + derived state + pure state mutators
import {
  lock, loading, showScreenshot, placeholderText, currentUrl, pageTitle,
  activeBrowserId, setActiveBrowserId,
  initialBrowserId,
  updateUrlBar, resetDisplay, clearDisplay,
} from './store';
// SSE: real-time connection management
import { connectSSE, disconnectSSE, initSSE } from './sse';
// Actions: screenshot refresh + UI event handlers
import {
  refreshScreenshot, setScreenshotEl,
  handleNav, handleReload, handleUrlFocus, handleUrlKeydown,
} from './actions';
// App Protocol
import { registerBrowserProtocol } from './protocol';
import './styles.css';

// ── Bootstrap ────────────────────────────────────────────────────────────

// Inject refreshScreenshot into SSE module before first connectSSE() call
initSSE(refreshScreenshot);

/**
 * Attach to a different browser at runtime.
 * Orchestrates store + SSE together (defined here to avoid circular deps).
 */
function attach(browserId: string): void {
  setActiveBrowserId(browserId);
  resetDisplay('Connecting...');
  connectSSE(browserId);
}

// Initial SSE connection
connectSSE(initialBrowserId);
onCleanup(() => disconnectSSE());

// ── Render ───────────────────────────────────────────────────────────────

render(() => html`
  <div class="browser-chrome y-app">
    <div class="url-bar y-flex y-gap-2 y-px-2 y-surface y-border-b">
      <button class="y-btn y-btn-sm y-btn-ghost" title="Back" aria-label="Back"
        onClick=${() => handleNav('navigate_back')}>←</button>
      <button class="y-btn y-btn-sm y-btn-ghost" title="Forward" aria-label="Forward"
        onClick=${() => handleNav('navigate_forward')}>→</button>
      <span class=${() => lock().cls}>${() => lock().icon}</span>
      <input class="url-text y-input"
        value=${() => currentUrl()}
        onFocus=${handleUrlFocus}
        onKeydown=${handleUrlKeydown} />
      <button class="y-btn y-btn-sm y-btn-ghost" title="Reload" aria-label="Reload"
        onClick=${handleReload}>↻</button>
      <span class="title-text y-text-xs y-text-muted y-truncate">${() => pageTitle()}</span>
    </div>
    <div class="screenshot-area">
      <div class=${() => loading() ? 'loading-bar active' : 'loading-bar'}></div>
      ${() => !showScreenshot() ? html`
        <div class="placeholder y-text-muted y-text-sm">${() => placeholderText()}</div>
      ` : null}
      <img
        ref=${(el: HTMLImageElement) => { setScreenshotEl(el); }}
        style=${() => showScreenshot() ? '' : 'display:none'}
        alt="Browser screenshot" />
    </div>
  </div>
`, document.getElementById('app')!);

// ── App Protocol ─────────────────────────────────────────────────────────

registerBrowserProtocol({
  getCurrentUrl: () => currentUrl(),
  getPageTitle: () => pageTitle(),
  getActiveBrowserId: () => activeBrowserId(),
  setActiveBrowserId: (id: string) => {
    setActiveBrowserId(id);
    connectSSE(id);
  },
  updateUrlBar,
  refreshScreenshot,
  clearDisplay,
  attach,
});
