import * as z from '@bundled/zod';
import { setShowScreenshot, setPlaceholderText, updateUrlBar } from './store';
import { withToken } from './token';
import { BrowserEventSchema } from './schema';

let _refreshScreenshot: () => void = () => {};

/**
 * Must be called before connectSSE().
 * Provides the DOM-dependent refreshScreenshot callback from actions.ts,
 * breaking the potential circular dependency.
 */
export function initSSE(onRefresh: () => void): void {
  _refreshScreenshot = onRefresh;
}

let currentEvtSource: EventSource | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastVersion = -1;

const MAX_SSE_ERRORS = 5;

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
    import('./actions').then(({ screenshotEl }) => {
      if (!screenshotEl) return;
      const ts = Date.now();
      const img = new Image();
      img.onload = () => {
        screenshotEl.src = img.src;
        setShowScreenshot(true);
      };
      img.src = withToken(`/api/browser/${bid}/screenshot?t=${ts}`);
    });
  }, 200);
}

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
  // A broken server would produce one unusable frame per update, so the warning
  // is emitted once per connection rather than per frame.
  let warnedMalformed = false;
  const evtSource = new EventSource(withToken(`/api/browser/${bid}/events`));
  currentEvtSource = evtSource;
  startPolling(bid);

  evtSource.onmessage = (e) => {
    if (sseErrorCount > 0) {
      setPlaceholderText('Waiting for navigation...');
    }
    sseErrorCount = 0;

    let raw: unknown;
    try {
      raw = JSON.parse(e.data);
    } catch (err) {
      if (!warnedMalformed) {
        warnedMalformed = true;
        console.warn('[browser] SSE frame is not JSON; ignoring this and any like it.', err);
      }
      return;
    }

    // Validate before trusting: `version` orders the frames and `url` goes
    // straight into the URL bar, so a frame we can't read is skipped loudly
    // rather than writing `undefined` over a URL the user can see.
    const parsed = z.safeParse(BrowserEventSchema, raw);
    if (!parsed.success) {
      if (!warnedMalformed) {
        warnedMalformed = true;
        console.warn(
          '[browser] SSE frame did not match the expected shape; ignoring this and any like it.',
          parsed.error.issues,
        );
      }
      return;
    }

    const data = parsed.data;
    if (data.version <= lastVersion) return;
    lastVersion = data.version;

    if (data.url) updateUrlBar(data.url, data.title);
    _refreshScreenshot();
  };

  evtSource.onerror = () => {
    sseErrorCount++;
    if (sseErrorCount === 1) {
      setPlaceholderText('Reconnecting...');
      setShowScreenshot(false);
    } else if (sseErrorCount >= MAX_SSE_ERRORS) {
      // Too many consecutive errors — give up (screenshot already hidden)
      evtSource.close();
      setPlaceholderText('Connection lost. Session may have ended.');
    }
  };
}
