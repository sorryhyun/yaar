/**
 * Where a link out of an app lands.
 *
 * An app's links reach the desktop as `yaar:open-url` (the bridge's link guard and the
 * `window.open` shim both route here) and used to become an iframe window
 * unconditionally. That is wrong for every site that refuses framing: `frame-ancestors`
 * and `X-Frame-Options` are the *target's* policy, enforced by the browser on the
 * target's document, and no attribute, sandbox token or header of ours overrides them.
 * The block is not even observable from the embedder — the violation belongs to the
 * framed document and names *our* origin as the blocked one — so the window simply
 * never painted, with a console line as the only trace.
 *
 * So the desktop asks first (`GET /api/embeddable`, which reads the site's headers
 * server-side) and picks the surface that can actually show the page:
 *
 * - framable → an iframe window, exactly as before;
 * - refused → the Browser app, which drives a real page in the server-side Chrome and
 *   frames nothing, so a framing policy has no purchase on it.
 *
 * Every fallback path ends at the iframe window. A probe that fails, a Browser app that
 * is missing or won't mint a token — none of them is a reason for a clicked link to
 * open nothing at all, and the iframe window has its own "Cannot embed this site" card
 * with a way out to a real browser tab.
 */
import { cascadeWindowBounds, WINDOW_PLACEMENT } from '@yaar/shared';
import type { OSAction, WindowBounds } from '@yaar/shared';
import { apiFetch } from '@/lib/api';
import { toWindowKey } from '@/store/helpers';
import { DEFAULT_VIEWPORT_WIDTH, DEFAULT_VIEWPORT_HEIGHT } from '@/constants/layout';
import { getDesktopState, getDesktopStore } from './store-access';
import { sendLocalAppCommand } from './app-protocol-relay';

const BROWSER_APP_ID = 'browser';

/**
 * How long the desktop waits for a verdict before opening the window anyway.
 *
 * The probe costs a round trip to the site, and a link that hangs for it feels broken.
 * Past this point the old behavior — frame it and find out — is the better answer.
 */
const PROBE_TIMEOUT_MS = 3_000;

/** Bounds for a new window on the active monitor, cascaded past the ones already open. */
function nextBounds(monitorId: string, width: number, height: number) {
  const openOnMonitor = Object.values(getDesktopState().windows).filter(
    (win) => win.monitorId === monitorId,
  ).length;
  return cascadeWindowBounds(openOnMonitor, width, height, {
    w: globalThis.innerWidth || DEFAULT_VIEWPORT_WIDTH,
    h: globalThis.innerHeight || DEFAULT_VIEWPORT_HEIGHT,
  });
}

/**
 * Tell the agent about a window the desktop opened on its own. Without this the next
 * thing it reads of the desktop contains a window it cannot account for.
 */
function recordOpened(args: {
  windowId: string;
  windowTitle: string;
  monitorId: string;
  bounds: WindowBounds;
  content: { renderer: 'iframe'; data: string };
  appId?: string;
  details: string;
}) {
  getDesktopStore().setState((s) => ({
    pendingInteractions: [
      ...s.pendingInteractions,
      {
        type: 'window.create' as const,
        timestamp: Date.now(),
        windowId: args.windowId,
        windowTitle: args.windowTitle,
        monitorId: args.monitorId,
        bounds: args.bounds,
        content: args.content,
        ...(args.appId ? { appId: args.appId } : {}),
        details: args.details,
      },
    ],
  }));
}

/**
 * Ask the server whether `href` permits being framed by this desktop.
 *
 * Answers `true` for anything it cannot establish — see the module header. The server
 * caches per URL, so a repeated link costs one local round trip.
 */
async function isEmbeddable(href: string): Promise<boolean> {
  try {
    const res = await apiFetch(`/api/embeddable?url=${encodeURIComponent(href)}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return true;
    const body = (await res.json()) as { embeddable?: boolean; reason?: string };
    if (body.embeddable === false) {
      console.debug(`[open-url] ${href} refuses framing — ${body.reason ?? 'no reason given'}`);
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

/** The installed Browser app, or null. Looked up once — the app list does not move. */
let browserAppPromise: Promise<{ id: string; name: string; run?: string } | null> | null = null;

function getBrowserApp() {
  if (!browserAppPromise) {
    browserAppPromise = apiFetch('/api/apps')
      .then(async (res) => {
        if (!res.ok) throw new Error(`/api/apps failed (${res.status})`);
        const { apps } = (await res.json()) as {
          apps: Array<{ id: string; name: string; run?: string }>;
        };
        return apps.find((a) => a.id === BROWSER_APP_ID) ?? null;
      })
      .catch(() => {
        // A failed lookup must not be remembered as "no Browser app" forever.
        browserAppPromise = null;
        return null;
      });
  }
  return browserAppPromise;
}

/**
 * Show `href` in the Browser app. False when it could not be done, and the caller
 * should fall back to an iframe window.
 *
 * The Browser app is one window per monitor (app windows are keyed by app id), so an
 * already-open one is navigated rather than duplicated — which is also how a desktop
 * browser behaves when a link is handed to it.
 */
async function openInBrowserApp(href: string, title: string): Promise<boolean> {
  const store = getDesktopState();
  const monitorId = store.activeMonitorId;
  const key = toWindowKey(monitorId, BROWSER_APP_ID);

  const existing = store.windows[key];
  if (existing) {
    const actions: OSAction[] = [];
    if (existing.minimized) actions.push({ type: 'window.restore', windowId: BROWSER_APP_ID });
    actions.push({ type: 'window.focus', windowId: BROWSER_APP_ID });
    store.applyActions(actions);
    return sendLocalAppCommand(key, 'open', { url: href });
  }

  const app = await getBrowserApp();
  if (!app?.run) return false;

  const sessionId = getDesktopState().sessionId;
  if (!sessionId) return false;

  // `?url=` is the Browser app's launch parameter — a `yaar://` content URI carries its
  // query through to the served app (see resolveContentUri).
  const runUrl = `${app.run}${app.run.includes('?') ? '&' : '?'}url=${encodeURIComponent(href)}`;

  // A window opened without a token can never call /api/verb, and the Browser app is
  // nothing but verb calls — so a failed mint is a failed launch, not a blank window.
  let iframeToken: string;
  try {
    const res = await apiFetch('/api/iframe-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        windowId: BROWSER_APP_ID,
        sessionId,
        appId: BROWSER_APP_ID,
        monitorId,
      }),
    });
    if (!res.ok) throw new Error(`iframe-token request failed (${res.status})`);
    const { token } = await res.json();
    if (typeof token !== 'string' || !token) throw new Error('iframe-token carried no token');
    iframeToken = token;
  } catch (err) {
    console.warn('[open-url] could not open the Browser app:', err);
    return false;
  }

  const content = { renderer: 'iframe' as const, data: runUrl };
  const bounds = nextBounds(
    monitorId,
    WINDOW_PLACEMENT.defaultWidth,
    WINDOW_PLACEMENT.defaultHeight,
  );
  getDesktopState().applyActions([
    {
      type: 'window.create',
      windowId: BROWSER_APP_ID,
      title: app.name,
      bounds,
      content,
      appId: BROWSER_APP_ID,
      iframeToken,
    },
  ]);
  recordOpened({
    windowId: BROWSER_APP_ID,
    windowTitle: app.name,
    monitorId,
    bounds,
    content,
    appId: BROWSER_APP_ID,
    details: `opened to show ${title}, which refuses to be framed`,
  });
  return true;
}

/** The original behavior: the destination as an iframe window of its own. */
function openIframeWindow(href: string, title: string, sourceWindowId?: string): void {
  const store = getDesktopState();
  const monitorId = store.activeMonitorId;
  const windowId = `link-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const content = { renderer: 'iframe' as const, data: href };
  const bounds = nextBounds(
    monitorId,
    WINDOW_PLACEMENT.defaultWidth,
    WINDOW_PLACEMENT.defaultHeight,
  );

  store.applyActions([{ type: 'window.create', windowId, title, bounds, content }]);
  recordOpened({
    windowId,
    windowTitle: title,
    monitorId,
    bounds,
    content,
    details: sourceWindowId
      ? `opened by a link in window ${sourceWindowId}`
      : 'opened by a link in an app',
  });
}

/**
 * Open a link an app handed the desktop. Resolves once the window exists; callers
 * fire-and-forget.
 */
export async function openExternalUrl(
  raw: string,
  rawTitle: string,
  sourceWindowId?: string,
): Promise<void> {
  // Absolute first: the guard already resolved the href against the app's own base, so
  // a relative value here is some other sender's, and resolving it against the desktop
  // is a guess we only make when there is nothing better.
  let parsed: URL | null = null;
  try {
    parsed = new URL(raw);
  } catch {
    try {
      parsed = new URL(raw, window.location.href);
    } catch {
      return;
    }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;

  const linkText = rawTitle.trim();
  const title = linkText || parsed.hostname || parsed.href;
  const href = parsed.href;

  if (await isEmbeddable(href)) {
    openIframeWindow(href, title, sourceWindowId);
    return;
  }
  if (await openInBrowserApp(href, title)) return;
  openIframeWindow(href, title, sourceWindowId);
}
