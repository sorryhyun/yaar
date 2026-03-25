/**
 * SSE (Server-Sent Events) and polling connection management.
 * Handles real-time screenshot updates from the browser session.
 *
 * Depends only on store.ts — DOM callbacks (refreshScreenshot) are
 * injected via initSSE() to avoid circular imports with actions.ts.
 */
import { setShowScreenshot, setPlaceholderText, updateUrlBar } from './store';

// ── Injected callbacks ───────────────────────────────────────────────

let _refreshScreenshot: () => void = () => {};

/**
 * Must be called before connectSSE().
 * Provides the DOM-dependent refreshScreenshot callback from actions.ts,
 * breaking the potential circular dependency.
 */
export function initSSE(onRefresh: () => void): void {
  _refreshScreenshot = onRefresh;
}

// ── Internal state ──────────────────────────────────────────────────

let currentEvtSource: EventSource | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastVersion = -1;

const MAX_SSE_ERRORS = 5;

// ── Polling ─────────────────────────────────────────────────────────────

export function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Polls the screenshot endpoint at 200 ms for smoother live updates
 * while the SSE connection is active.
 * Note: screenshotEl access is guarded — it may not be mounted yet
 * when polling starts before the first render.
 */
export function startPolling(bid: string): void {
  stopPolling();
  // Import lazily to avoid circular dependency at module evaluation time
  pollTimer = setInterval(() => {
    // Delegate to the injected callback; actions.ts guards screenshotEl internally
    import('./actions').then(({ screenshotEl }) => {
      if (!screenshotEl) return;
      const ts = Date.now();
      const img = new Image();
      img.onload = () => {
        screenshotEl.src = img.src;
        setShowScreenshot(true);
      };
      img.src = `/api/browser/${bid}/screenshot?t=${ts}`;
    });
  }, 200);
}

// ── SSE connection ────────────────────────────────────────────────────

export function disconnectSSE(): void {
  stopPolling();
  if (currentEvtSource) {
    currentEvtSource.close();
    currentEvtSource = null;
  }
}

export function connectSSE(bid: string): void {
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
      _refreshScreenshot();
    } catch {
      // ignore malformed events
    }
  };

  evtSource.onerror = () => {
    sseErrorCount++;
    if (sseErrorCount === 1) {
      // First error: hide screenshot and indicate reconnection attempt
      setPlaceholderText('Reconnecting...');
      setShowScreenshot(false);
    } else if (sseErrorCount >= MAX_SSE_ERRORS) {
      // Too many consecutive errors — give up (screenshot already hidden)
      evtSource.close();
      setPlaceholderText('Connection lost. Session may have ended.');
    }
  };
}
