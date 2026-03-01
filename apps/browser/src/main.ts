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

    .browser-chrome {
      display: grid;
      grid-template-rows: auto 1fr;
      height: 100vh;
    }

    .url-bar {
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
      border-radius: 16px;
    }

    .url-bar .title-text {
      flex-shrink: 0;
      max-width: 200px;
    }

    .screenshot-area {
      position: relative;
      overflow: auto;
      background: var(--yaar-bg);
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
    }

    .loading-bar {
      position: absolute;
      top: 0;
      left: 0;
      height: 2px;
      background: var(--yaar-accent);
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

  <div class="browser-chrome y-app">
    <div class="url-bar y-flex y-gap-2 y-px-2 y-surface y-border-b">
      <button id="back-btn" class="y-btn y-btn-sm y-btn-ghost" title="Back" aria-label="Back">←</button>
      <button id="forward-btn" class="y-btn y-btn-sm y-btn-ghost" title="Forward" aria-label="Forward">→</button>
      <span id="lock" class="lock">🔒</span>
      <input id="url-text" class="url-text y-input" value="about:blank" />
      <button id="reload-btn" class="y-btn y-btn-sm y-btn-ghost" title="Reload" aria-label="Reload">↻</button>
      <span id="title-text" class="title-text y-text-xs y-text-muted y-truncate"></span>
    </div>
    <div id="screenshot-area" class="screenshot-area">
      <div id="loading-bar" class="loading-bar"></div>
      <div id="placeholder" class="placeholder y-text-muted y-text-sm">${sessionId ? 'Waiting for navigation...' : 'No active browser session.'}</div>
      <img id="screenshot" style="display:none" alt="Browser screenshot" />
    </div>
  </div>
`;

const els = {
  backBtn: document.getElementById('back-btn') as HTMLButtonElement,
  forwardBtn: document.getElementById('forward-btn') as HTMLButtonElement,
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

// ── Back / Forward buttons ───────────────────────────────────────────

els.backBtn.addEventListener('click', () => {
  const y = (window as any).yaar;
  y?.app?.sendInteraction?.({ event: 'navigate_back' });
});

els.forwardBtn.addEventListener('click', () => {
  const y = (window as any).yaar;
  y?.app?.sendInteraction?.({ event: 'navigate_forward' });
});

// ── Editable URL bar ─────────────────────────────────────────────────

els.urlText.addEventListener('focus', () => {
  els.urlText.select();
});

els.urlText.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    let url = els.urlText.value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }
    els.urlText.value = url;
    els.urlText.blur();
    const y = (window as any).yaar;
    y?.app?.sendInteraction?.({ event: 'navigate_request', url });
  }
});

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
    appId: 'browser',
    name: 'Browser',
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
