import * as z from '@bundled/zod';
import { setShowScreenshot, setPlaceholderText, updateUrlBar, activeBrowserId } from './store';
import { liveMode } from './live/state';
import { eventsUrl, screenshotUrl } from './endpoints';
import { getScreenshotEl } from './dom';
import { refreshScreenshot } from './actions';
import { onNavigated, onPopup } from './adblock';
import { BrowserEventSchema } from './schema';

type BrowserEvent = z.infer<typeof BrowserEventSchema>;

let currentEvtSource: EventSource | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastVersion = -1;

const MAX_SSE_ERRORS = 5;
const POLL_INTERVAL_MS = 200;
const IDLE_TEXT = 'Waiting for navigation...';

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
export function startPolling(browserId: string): void {
  stopPolling();
  // The server has nothing captured for a tab it has just been pointed at, and it
  // answers a capture-less tab with a 404. Asking for a `fresh` one on the first
  // tick makes the server capture instead of refusing — that 404 is the
  // `failed to load <img>: /api/browser/8/screenshot` in the console, and it is
  // cheaper not to make the doomed request than to swallow its error.
  let primed = false;
  pollTimer = setInterval(() => {
    // The id is re-read every tick against the one this poll was started for.
    // clearInterval cannot cancel a request already in flight, so a poll that
    // outlives its own tab switch would keep fetching a tab nobody is watching.
    if (activeBrowserId() !== browserId) return;
    // Live mode pays for one encode per frame already and must never order a
    // second. Belt and braces: every caller is supposed to have stopped us.
    if (liveMode()) return;
    const el = getScreenshotEl();
    if (!el) return;
    // Decoded off-screen first, so the visible <img> never shows a half-loaded frame.
    const img = new Image();
    img.onload = () => {
      el.src = img.src;
      setShowScreenshot(true);
    };
    // A still capture can fail for reasons the next tick fixes by itself (a tab
    // mid-navigation, one that just closed). This is a poll: the retry is 200 ms
    // away, so a failure is not news and must not reach the console unhandled.
    img.onerror = () => {};
    img.src = screenshotUrl(browserId, !primed);
    primed = true;
  }, POLL_INTERVAL_MS);
}

export function disconnectSSE(): void {
  stopPolling();
  if (currentEvtSource) {
    currentEvtSource.close();
    currentEvtSource = null;
  }
}

/**
 * Parse and validate one frame before trusting it: `version` orders the frames and
 * `url` goes straight into the URL bar, so a frame we can't read is skipped loudly
 * rather than writing `undefined` over a URL the user can see.
 *
 * A broken server would produce one unusable frame per update, so `warnOnce` is
 * expected to emit per connection rather than per frame.
 */
function parseFrame(
  raw: string,
  warnOnce: (msg: string, detail: unknown) => void,
): BrowserEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    warnOnce('[browser] SSE frame is not JSON; ignoring this and any like it.', err);
    return null;
  }

  const parsed = z.safeParse(BrowserEventSchema, json);
  if (!parsed.success) {
    warnOnce(
      '[browser] SSE frame did not match the expected shape; ignoring this and any like it.',
      parsed.error.issues,
    );
    return null;
  }
  return parsed.data;
}

export function connectSSE(browserId: string): void {
  disconnectSSE();
  lastVersion = -1;

  let sseErrorCount = 0;
  let warnedMalformed = false;
  const warnOnce = (msg: string, detail: unknown) => {
    if (warnedMalformed) return;
    warnedMalformed = true;
    console.warn(msg, detail);
  };

  const evtSource = new EventSource(eventsUrl(browserId));
  currentEvtSource = evtSource;
  startPolling(browserId);

  evtSource.onmessage = (e) => {
    if (sseErrorCount > 0) {
      setPlaceholderText(IDLE_TEXT);
    }
    sseErrorCount = 0;

    const data = parseFrame(e.data, warnOnce);
    if (!data) return;

    // A popup announcement carries the opener's unchanged version on purpose (it is
    // not a navigation), so it is consumed here, ahead of the gate, and only here.
    if (data.popup) {
      onPopup({ browserId: data.popup.browserId, url: data.popup.url });
      return;
    }

    if (data.version <= lastVersion) return;
    lastVersion = data.version;

    if (data.url) {
      updateUrlBar(data.url, data.title);
      // The only navigation signal this app gets. `onNavigated` de-duplicates,
      // so the repeated frames of one page load cost one injection.
      onNavigated(data.url);
    }
    refreshScreenshot();
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
