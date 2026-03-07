/**
 * Browser app — displays live screenshots from browser sessions.
 * Subscribes to SSE (/api/browser/{browserId}/events) for real-time updates.
 * Supports runtime session switching via the `attach` protocol command.
 * App Protocol is registered in ./protocol.ts.
 */
import { createSignal, onCleanup } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import { registerBrowserProtocol } from './protocol';
import './styles.css';

// Extract query params
const params = new URLSearchParams(window.location.search);
const initialBrowserId = params.get('browserId') || '0';

// optional initial url (for direct app open like ?url=https://...)
const rawInitialUrl = params.get('url') || '';
let parsedInitialUrl = 'about:blank';
if (rawInitialUrl) {
  try {
    const parsed = new URL(rawInitialUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      parsedInitialUrl = parsed.toString();
    }
  } catch {
    // ignore invalid url and keep about:blank
  }
}

// ── Reactive State ────────────────────────────────────────────────────

const [activeBrowserId, setActiveBrowserId] = createSignal(initialBrowserId);
const [currentUrl, setCurrentUrl] = createSignal(parsedInitialUrl);
const [pageTitle, setPageTitle] = createSignal('');
const [loading, setLoading] = createSignal(false);
const [showScreenshot, setShowScreenshot] = createSignal(false);
const [placeholderText, setPlaceholderText] = createSignal('Waiting for navigation...');

let lastVersion = -1;
let pollTimer: ReturnType<typeof setInterval> | null = null;

// ── Derived helpers ───────────────────────────────────────────────────

function lockClass(): string {
  const url = currentUrl();
  if (url === 'about:blank') return 'lock hidden';
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? 'lock' : 'lock insecure';
  } catch {
    return 'lock insecure';
  }
}

function lockIcon(): string {
  const url = currentUrl();
  if (url === 'about:blank') return '';
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? '🔒' : '🔓';
  } catch {
    return '🔓';
  }
}

// ── Actions ───────────────────────────────────────────────────────────

let screenshotEl!: HTMLImageElement;

function refreshScreenshot(fresh = false) {
  const bid = activeBrowserId();
  const ts = Date.now();
  const src = `/api/browser/${bid}/screenshot?t=${ts}${fresh ? '&fresh' : ''}`;
  setLoading(true);

  screenshotEl.onload = () => {
    setShowScreenshot(true);
    setLoading(false);
  };
  screenshotEl.onerror = () => {
    setLoading(false);
  };
  screenshotEl.src = src;
}

function updateUrlBar(url: string, title?: string) {
  setCurrentUrl(url);
  if (title !== undefined) setPageTitle(title);
}

function clearDisplay() {
  setShowScreenshot(false);
  updateUrlBar('about:blank');
  setPageTitle('');
  setPlaceholderText('Browser closed.');
}

// ── Event handlers ────────────────────────────────────────────────────

function handleBack() {
  const y = (window as any).yaar;
  y?.app?.sendInteraction?.({ event: 'navigate_back' });
}

function handleForward() {
  const y = (window as any).yaar;
  y?.app?.sendInteraction?.({ event: 'navigate_forward' });
}

function handleReload() {
  refreshScreenshot(true);
}

function handleUrlFocus(e: FocusEvent) {
  (e.target as HTMLInputElement).select();
}

async function navigateDirect(url: string) {
  const bid = activeBrowserId();
  setLoading(true);
  try {
    const resp = await fetch(`/api/browser/${bid}/navigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      console.error('[browser] Navigate failed:', err);
    }
    // SSE will handle screenshot refresh
  } catch (err) {
    console.error('[browser] Navigate error:', err);
  }
}

function handleUrlKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault();
    let url = (e.target as HTMLInputElement).value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }
    (e.target as HTMLInputElement).value = url;
    (e.target as HTMLInputElement).blur();
    navigateDirect(url);
  }
}

// ── SSE connection management ─────────────────────────────────────────

let currentEvtSource: EventSource | null = null;
const MAX_SSE_ERRORS = 5;

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling(bid: string) {
  stopPolling();
  pollTimer = setInterval(() => {
    const ts = Date.now();
    const img = new Image();
    img.onload = () => {
      screenshotEl.src = img.src;
      setShowScreenshot(true);
    };
    img.src = `/api/browser/${bid}/screenshot?t=${ts}`;
  }, 200);
}

function disconnectSSE() {
  stopPolling();
  if (currentEvtSource) {
    currentEvtSource.close();
    currentEvtSource = null;
  }
}

function connectSSE(bid: string) {
  disconnectSSE();
  lastVersion = -1;

  let sseErrorCount = 0;
  const evtSource = new EventSource(`/api/browser/${bid}/events`);
  currentEvtSource = evtSource;
  startPolling(bid);

  evtSource.onmessage = (e) => {
    if (sseErrorCount > 0) {
      setPlaceholderText('Waiting for navigation...');
    }
    sseErrorCount = 0;
    try {
      const data = JSON.parse(e.data) as { url: string; title: string; version: number };
      if (data.version <= lastVersion) return;
      lastVersion = data.version;

      if (data.url) updateUrlBar(data.url, data.title);
      refreshScreenshot();
    } catch {
      // ignore malformed events
    }
  };

  evtSource.onerror = () => {
    sseErrorCount++;
    if (sseErrorCount === 1) {
      setPlaceholderText('Reconnecting...');
      setShowScreenshot(false);
    }
    if (sseErrorCount >= MAX_SSE_ERRORS) {
      evtSource.close();
      setPlaceholderText('Connection lost. Session may have ended.');
      setShowScreenshot(false);
    }
  };
}

/**
 * Attach to a different browser at runtime.
 * Tears down the current SSE connection and reconnects.
 */
function attach(browserId: string) {
  setActiveBrowserId(browserId);
  setShowScreenshot(false);
  setCurrentUrl('about:blank');
  setPageTitle('');
  setPlaceholderText('Connecting...');
  connectSSE(browserId);
}

// Initial connection
connectSSE(initialBrowserId);
onCleanup(() => disconnectSSE());

// ── Render ────────────────────────────────────────────────────────────

render(() => html`
  <div class="browser-chrome y-app">
    <div class="url-bar y-flex y-gap-2 y-px-2 y-surface y-border-b">
      <button class="y-btn y-btn-sm y-btn-ghost" title="Back" aria-label="Back"
        onClick=${handleBack}>←</button>
      <button class="y-btn y-btn-sm y-btn-ghost" title="Forward" aria-label="Forward"
        onClick=${handleForward}>→</button>
      <span class=${() => lockClass()}>${() => lockIcon()}</span>
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
        ref=${(el: HTMLImageElement) => { screenshotEl = el; }}
        style=${() => showScreenshot() ? '' : 'display:none'}
        alt="Browser screenshot" />
    </div>
  </div>
`, document.getElementById('app')!);

// ── App Protocol ──────────────────────────────────────────────────────

registerBrowserProtocol({
  getCurrentUrl: () => currentUrl(),
  getActiveBrowserId: () => activeBrowserId(),
  updateUrlBar,
  refreshScreenshot,
  clearDisplay,
  attach,
});
