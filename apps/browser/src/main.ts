/**
 * Browser app — displays live screenshots from browser sessions.
 * Subscribes to SSE (/api/browser/{sessionId}/events) for real-time updates.
 * App Protocol is registered in ./protocol.ts.
 */
import { signal, html, mount, show, onMount, onCleanup } from '@bundled/yaar';
import { registerBrowserProtocol } from './protocol';
import './styles.css';

// Extract query params
const params = new URLSearchParams(window.location.search);

// sessionId (validate format)
const rawSessionId = params.get('sessionId') || '';
const sessionId = /^[a-zA-Z0-9_-]+$/.test(rawSessionId) ? rawSessionId : '';

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

const currentUrl = signal(parsedInitialUrl);
const pageTitle = signal('');
const loading = signal(false);
const showScreenshot = signal(false);
const placeholderText = signal(
  sessionId ? 'Waiting for navigation...' : 'No active browser session.'
);

let lastVersion = -1;

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
  const ts = Date.now();
  const src = `/api/browser/${sessionId}/screenshot?t=${ts}${fresh ? '&fresh' : ''}`;
  loading(true);

  screenshotEl.onload = () => {
    showScreenshot(true);
    loading(false);
  };
  screenshotEl.onerror = () => {
    loading(false);
  };
  screenshotEl.src = src;
}

function updateUrlBar(url: string, title?: string) {
  currentUrl(url);
  if (title !== undefined) pageTitle(title);
}

function clearDisplay() {
  showScreenshot(false);
  updateUrlBar('about:blank');
  pageTitle('');
  placeholderText('Browser closed.');
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
    const y = (window as any).yaar;
    y?.app?.sendInteraction?.({ event: 'navigate_request', url });
  }
}

// ── SSE subscription (lifecycle managed by onMount/onCleanup) ─────────

onMount(() => {
  if (!sessionId) return;

  const MAX_SSE_ERRORS = 5;
  let sseErrorCount = 0;
  const evtSource = new EventSource(`/api/browser/${sessionId}/events`);

  evtSource.onmessage = (e) => {
    if (sseErrorCount > 0) {
      placeholderText(sessionId ? 'Waiting for navigation...' : 'No active browser session.');
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
      placeholderText('Reconnecting...');
      showScreenshot(false);
    }
    if (sseErrorCount >= MAX_SSE_ERRORS) {
      evtSource.close();
      placeholderText('Connection lost. Session may have ended.');
      showScreenshot(false);
    }
  };

  onCleanup(() => evtSource.close());
});

// ── Render ────────────────────────────────────────────────────────────

mount(html`
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
        disabled=${!sessionId}
        onClick=${handleReload}>↻</button>
      <span class="title-text y-text-xs y-text-muted y-truncate">${() => pageTitle()}</span>
    </div>
    <div class="screenshot-area">
      <div class=${() => loading() ? 'loading-bar active' : 'loading-bar'}></div>
      ${show(() => !showScreenshot(), () => html`
        <div class="placeholder y-text-muted y-text-sm">${() => placeholderText()}</div>
      `)}
      <img
        ref=${(el: HTMLImageElement) => { screenshotEl = el; }}
        style=${() => showScreenshot() ? '' : 'display:none'}
        alt="Browser screenshot" />
    </div>
  </div>
`);

// ── App Protocol ──────────────────────────────────────────────────────

registerBrowserProtocol({
  getCurrentUrl: () => currentUrl(),
  updateUrlBar,
  refreshScreenshot,
  clearDisplay,
});
