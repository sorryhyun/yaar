/**
 * Browser app — displays live screenshots from browser sessions.
 * Subscribes to SSE (/api/browser/{sessionId}/events) for real-time updates.
 * Also registers with App Protocol for state queries and manual commands.
 */

const root = document.getElementById('app');
if (!root) throw new Error('Missing app root');

// Extract query params
const params = new URLSearchParams(window.location.search);

// sessionId (validate format)
const rawSessionId = params.get('sessionId') || '';
const sessionId = /^[a-zA-Z0-9_-]+$/.test(rawSessionId) ? rawSessionId : '';

// optional initial url (for direct app open like ?url=https://...)
const rawInitialUrl = params.get('url') || '';
let initialUrl = 'about:blank';
if (rawInitialUrl) {
  try {
    const parsed = new URL(rawInitialUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      initialUrl = parsed.toString();
    }
  } catch {
    // ignore invalid url and keep about:blank
  }
}

root.innerHTML = `
  <style>
    :root { color-scheme: dark; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #1e1e1e; overflow: hidden; }

    .browser-chrome {
      display: grid;
      grid-template-rows: auto 1fr;
      height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    .url-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: #2d2d2d;
      border-bottom: 1px solid #3e3e3e;
      min-height: 40px;
    }

    .url-bar .lock {
      font-size: 12px;
      color: #4caf50;
      flex-shrink: 0;
    }

    .url-bar .lock.insecure {
      color: #ff9800;
    }

    .url-bar .url-text {
      flex: 1;
      font-size: 13px;
      color: #ccc;
      background: #3e3e3e;
      border: 1px solid transparent;
      border-radius: 16px;
      padding: 6px 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: inherit;
      outline: none;
    }

    .url-bar .url-text:focus {
      border-color: #4fc3f7;
      background: #333;
      color: #fff;
    }

    .url-bar .url-text[readonly] {
      cursor: default;
      border-color: transparent;
      background: #3e3e3e;
      color: #ccc;
    }

    .url-bar .url-text[readonly]:focus {
      border-color: transparent;
      background: #3e3e3e;
      color: #ccc;
    }

    .url-bar .reload-btn,
    .url-bar .nav-btn {
      flex-shrink: 0;
      width: 28px;
      height: 28px;
      border: 1px solid #4b4b4b;
      border-radius: 999px;
      background: #3a3a3a;
      color: #ddd;
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
    }

    .url-bar .reload-btn:hover,
    .url-bar .nav-btn:hover {
      background: #4a4a4a;
    }

    .url-bar .reload-btn:active,
    .url-bar .nav-btn:active {
      transform: scale(0.97);
    }

    .url-bar .title-text {
      font-size: 11px;
      color: #888;
      flex-shrink: 0;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .screenshot-area {
      position: relative;
      overflow: auto;
      background: #1a1a1a;
      cursor: default;
    }

    .screenshot-area img {
      display: block;
      width: 100%;
      height: auto;
      image-rendering: auto;
    }

    .screenshot-area .placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: #666;
      font-size: 14px;
    }

    .loading-bar {
      position: absolute;
      top: 0;
      left: 0;
      height: 2px;
      background: #4fc3f7;
      animation: loading 1.5s ease-in-out infinite;
      display: none;
    }

    .loading-bar.active {
      display: block;
    }

    @keyframes loading {
      0% { width: 0%; }
      50% { width: 70%; }
      100% { width: 100%; opacity: 0; }
    }
  </style>

  <div class="browser-chrome">
    <div class="url-bar">
      <button id="back-btn" class="nav-btn" title="Back" aria-label="Back" disabled hidden>←</button>
      <button id="forward-btn" class="nav-btn" title="Forward" aria-label="Forward" disabled hidden>→</button>
      <span id="lock" class="lock">🔒</span>
      <input id="url-text" class="url-text" value="about:blank" readonly aria-readonly="true" tabindex="-1" />
      <button id="reload-btn" class="reload-btn" title="Reload" aria-label="Reload">↻</button>
      <span id="title-text" class="title-text"></span>
    </div>
    <div id="screenshot-area" class="screenshot-area">
      <div id="loading-bar" class="loading-bar"></div>
      <div id="placeholder" class="placeholder">${sessionId ? 'Waiting for navigation...' : 'No active browser session.'}</div>
      <img id="screenshot" style="display:none" alt="Browser screenshot" />
    </div>
  </div>
`;

const els = {
  lock: document.getElementById('lock') as HTMLSpanElement,
  urlText: document.getElementById('url-text') as HTMLInputElement,
  reloadBtn: document.getElementById('reload-btn') as HTMLButtonElement,
  titleText: document.getElementById('title-text') as HTMLSpanElement,
  screenshotArea: document.getElementById('screenshot-area') as HTMLDivElement,
  loadingBar: document.getElementById('loading-bar') as HTMLDivElement,
  placeholder: document.getElementById('placeholder') as HTMLDivElement,
  screenshot: document.getElementById('screenshot') as HTMLImageElement,
};

let currentUrl = initialUrl;
let lastVersion = -1;

function updateUrlBar(url: string, title?: string) {
  currentUrl = url;
  els.urlText.value = url;
  if (title) {
    els.titleText.textContent = title;
  }

  // Hide lock icon for about:blank
  if (url === 'about:blank') {
    els.lock.style.display = 'none';
    return;
  }
  els.lock.style.display = '';

  // Update lock icon
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') {
      els.lock.textContent = '🔒';
      els.lock.className = 'lock';
    } else {
      els.lock.textContent = '🔓';
      els.lock.className = 'lock insecure';
    }
  } catch {
    els.lock.textContent = '🔓';
    els.lock.className = 'lock insecure';
  }
}

// reflect initial url from query params in the chrome
updateUrlBar(initialUrl);

function refreshScreenshot(fresh = false) {
  const ts = Date.now();
  const src = `/api/browser/${sessionId}/screenshot?t=${ts}${fresh ? '&fresh' : ''}`;
  els.loadingBar.classList.add('active');

  els.screenshot.onload = () => {
    els.placeholder.style.display = 'none';
    els.screenshot.style.display = 'block';
    els.loadingBar.classList.remove('active');
  };
  els.screenshot.onerror = () => {
    els.loadingBar.classList.remove('active');
  };
  els.screenshot.src = src;
}

// Disable reload button when no session
if (!sessionId) {
  els.reloadBtn.disabled = true;
}

els.reloadBtn.addEventListener('click', () => {
  refreshScreenshot(true);
});

// User-side back/forward and URL entry are intentionally disabled for browser-view.

function clearDisplay() {
  els.screenshot.style.display = 'none';
  els.placeholder.style.display = 'flex';
  els.placeholder.textContent = 'Browser closed.';
  updateUrlBar('about:blank');
  els.titleText.textContent = '';
}

// ── SSE subscription for live updates ─────────────────────────────────

if (sessionId) {
  const MAX_SSE_ERRORS = 5;
  let sseErrorCount = 0;
  const evtSource = new EventSource(`/api/browser/${sessionId}/events`);

  evtSource.onmessage = (e) => {
    // Reset error counter on successful message
    if (sseErrorCount > 0) {
      els.placeholder.style.display = 'none';
    }
    sseErrorCount = 0;
    try {
      const data = JSON.parse(e.data) as { url: string; title: string; version: number };
      // Skip if we've already processed this version
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
      els.placeholder.textContent = 'Reconnecting...';
      els.placeholder.style.display = 'flex';
    }
    if (sseErrorCount >= MAX_SSE_ERRORS) {
      evtSource.close();
      els.placeholder.textContent = 'Connection lost. Session may have ended.';
      els.placeholder.style.display = 'flex';
      els.screenshot.style.display = 'none';
    }
  };
}

// User click signaling disabled by default.

// ── Register with App Protocol (for state queries + manual commands) ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const yaar = (window as any).yaar;
if (yaar?.app?.register) {
  yaar.app.register({
    appId: 'browser-view',
    name: 'Browser View',
    state: {
      manifest: {
        description: 'App capabilities',
        handler: () => ({
          state: ['currentUrl'],
          commands: ['refresh', 'clear', 'navigate'],
        }),
      },
      currentUrl: {
        description: 'Currently displayed URL',
        handler: () => currentUrl,
      },
    },
    commands: {
      refresh: {
        description: 'Refresh screenshot and optionally update URL bar',
        params: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            title: { type: 'string' },
          },
        },
        handler: (p?: { url?: string; title?: string }) => {
          if (p?.url) updateUrlBar(p.url, p.title);
          refreshScreenshot();
          return { ok: true, currentUrl };
        },
      },
      clear: {
        description: 'Clear the browser display',
        params: { type: 'object', properties: {} },
        handler: async () => {
          clearDisplay();
          return { ok: true };
        },
      },
      navigate: {
        description: 'Navigate the browser to a URL',
        params: {
          type: 'object',
          properties: {
            url: { type: 'string' },
          },
          required: ['url'],
        },
        handler: (p: { url: string }) => {
          const y = (window as any).yaar;
          y?.app?.sendInteraction?.({ event: 'navigate_request', url: p.url });
          return { ok: true, url: p.url };
        },
      },
    },
  });
}
