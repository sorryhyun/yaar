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
 *
 * Ahead of both sits a question neither the site nor the app can answer: **has the user
 * said where links to this site go?** A link to `github.com/owner/repo` framed or browsed
 * is a worse answer than the GitHub app navigating to that repository — but only the user
 * gets to decide that, so the rule lives in `config/hooks.json` as a `link_open` hook
 * (`GET /api/hooks/link`, resolved by `features/config/hooks.ts`) and not in the app's own
 * manifest. An app that declared the site itself would claim it on every desktop it was
 * ever installed on, which is the one thing a link-routing rule must not do.
 *
 * Two rules past that, both about not stranding a click:
 *
 * - **The app's answer decides.** The hook's command returns `{ handled: true }` or the
 *   link continues down the chain below. Anything else — an error, no reply, no such
 *   command — is read as "not mine", because a link that opens nowhere is the outcome
 *   this whole module exists to rule out. A rule for a site is not the ability to show
 *   every URL under it: `github.com/settings` is not a repository.
 * - **A closed app is opened, and closed again if it turns the link down.** The rule used
 *   to apply only while its app happened to be on screen, on the reasoning that a window
 *   opened for a link the app then declines is worse than the placement it replaced. That
 *   traded the feature's main case — a link clicked in some *other* app — for a hazard
 *   that undoes itself: the launch is reverted on `{ handled: false }`, and reported to
 *   the agent only once the app has taken the link. `"launch": false` on the hook opts
 *   out per rule.
 */
import { cascadeWindowBounds, WINDOW_PLACEMENT } from '@yaar/shared';
import type { OSAction, WindowBounds } from '@yaar/shared';
import { apiFetch } from '@/lib/api';
import { toWindowKey } from '@/store/helpers';
import { DEFAULT_VIEWPORT_WIDTH, DEFAULT_VIEWPORT_HEIGHT } from '@/constants/layout';
import { getDesktopState, getDesktopStore } from './store-access';
import {
  runLocalAppCommand,
  sendLocalAppCommand,
  waitForAppWindowReady,
} from './app-protocol-relay';

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

interface InstalledApp {
  id: string;
  name: string;
  run?: string;
}

/** The installed apps. Looked up once — the app list does not move. */
let appsPromise: Promise<InstalledApp[]> | null = null;

function getApps(): Promise<InstalledApp[]> {
  if (!appsPromise) {
    appsPromise = apiFetch('/api/apps')
      .then(async (res) => {
        if (!res.ok) throw new Error(`/api/apps failed (${res.status})`);
        const { apps } = (await res.json()) as { apps: InstalledApp[] };
        return apps;
      })
      .catch(() => {
        // A failed lookup must not be remembered as "nothing is installed" forever.
        appsPromise = null;
        return [];
      });
  }
  return appsPromise;
}

async function getApp(appId: string): Promise<InstalledApp | null> {
  return (await getApps()).find((a) => a.id === appId) ?? null;
}

interface LinkHandler {
  appId: string;
  command: string;
  /** Whether a closed app may be opened to take the link (`"launch": false` opts out). */
  launch: boolean;
}

/** The app a `link_open` hook sends this URL to, or null when the user wired none. */
async function linkHandlerFor(href: string): Promise<LinkHandler | null> {
  try {
    const res = await apiFetch(`/api/hooks/link?url=${encodeURIComponent(href)}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { handler?: Partial<LinkHandler> | null };
    const { appId, command, launch } = body.handler ?? {};
    return appId && command ? { appId, command, launch: launch !== false } : null;
  } catch {
    // No answer is no rule: the link falls to the placement below, which is where every
    // link went before hooks could name a handler.
    return null;
  }
}

/** A window this module opened, in the shape `recordOpened` reports. */
interface LaunchedWindow {
  appId: string;
  name: string;
  monitorId: string;
  bounds: WindowBounds;
  content: { renderer: 'iframe'; data: string };
}

/**
 * Open an app's own window on the active monitor. Null when it could not be done, which
 * every caller treats as "this app did not take the link".
 *
 * Deliberately does *not* report the window to the agent: a launch may still be undone
 * (an app that declines the link is closed again), and a `window.create` interaction for
 * a window that no longer exists is worse than none. Callers record it once the window
 * has earned its place.
 */
async function launchAppWindow(appId: string, runQuery?: string): Promise<LaunchedWindow | null> {
  const app = await getApp(appId);
  if (!app?.run) return null;

  const store = getDesktopState();
  const sessionId = store.sessionId;
  if (!sessionId) return null;
  const monitorId = store.activeMonitorId;

  // A `yaar://` content URI carries its query through to the served app (see
  // resolveContentUri) — which is how the Browser app receives `?url=`.
  const runUrl = runQuery ? `${app.run}${app.run.includes('?') ? '&' : '?'}${runQuery}` : app.run;

  // A window opened without a token can never call /api/verb, and an app is nothing but
  // verb calls — so a failed mint is a failed launch, not a blank window.
  let iframeToken: string;
  try {
    const res = await apiFetch('/api/iframe-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ windowId: appId, sessionId, appId, monitorId }),
    });
    if (!res.ok) throw new Error(`iframe-token request failed (${res.status})`);
    const { token } = await res.json();
    if (typeof token !== 'string' || !token) throw new Error('iframe-token carried no token');
    iframeToken = token;
  } catch (err) {
    console.warn(`[open-url] could not open the ${appId} app:`, err);
    return null;
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
      windowId: appId,
      title: app.name,
      bounds,
      content,
      appId,
      iframeToken,
    },
  ]);
  return { appId, name: app.name, monitorId, bounds, content };
}

/**
 * What an `openUrl` reply has to say for the link to be considered placed: `{ handled:
 * true }`, or a bare `true` from an app that answered in the shorter spelling. Everything
 * else — `{ handled: false }`, an error, a null from a command that never answered — is
 * the same "not mine", and sends the link on down the chain.
 */
function tookTheLink(result: unknown): boolean {
  if (result === true) return true;
  if (typeof result !== 'object' || result === null) return false;
  return (result as { handled?: unknown }).handled === true;
}

/**
 * How long a freshly opened app gets to register before the link goes elsewhere.
 *
 * Bounded because the user is waiting on a click: an app that has not finished its
 * `yaar:app-ready` handshake cannot answer, and past this point the Browser app now beats
 * the right app later.
 */
const APP_LAUNCH_TIMEOUT_MS = 8_000;

/**
 * Hand `href` to the app the user wired it to, opening that app if it is closed. False
 * when nothing took it — see the module header for why a missing rule and a declined URL
 * are the same answer here.
 */
async function openInHookedApp(
  href: string,
  title: string,
  sourceWindowId?: string,
): Promise<boolean> {
  const handler = await linkHandlerFor(href);
  if (!handler) return false;

  // Read the store *after* the await: the window list is a live thing.
  const store = getDesktopState();
  const key = toWindowKey(store.activeMonitorId, handler.appId);

  // Never hand a link back to the window it came from. That app already saw this URL
  // through its own `links.onOpen` hook and let it go, so it is asking for the link to
  // land *somewhere else* — an "open the real page" link out of the app the rule points
  // at is exactly this case, and bouncing it back would make that link unclickable.
  if (key === sourceWindowId) return false;

  // A rule that only applied while its app happened to be on screen was the feature
  // failing in the case it exists for — a link clicked in some other app, with the
  // handler closed. Opening it is what the rule asked for; the undo below is what makes
  // that safe.
  let launched: LaunchedWindow | null = null;
  if (!store.windows[key]) {
    if (!handler.launch) return false;
    launched = await launchAppWindow(handler.appId);
    if (!launched) return false;
    // A command posted before the iframe registers is lost — nothing queues it on this
    // path — so the launch is not complete until the app answers for itself.
    if (!(await waitForAppWindowReady(key, APP_LAUNCH_TIMEOUT_MS))) {
      undoLaunch(launched);
      return false;
    }
  }

  const result = await runLocalAppCommand(key, handler.command, { url: href });
  if (!tookTheLink(result)) {
    // The app has no view for this URL. Leaving the window we just opened would answer a
    // link the user clicked with an app they did not ask for, on top of the placement
    // that does show the page.
    if (launched) undoLaunch(launched);
    return false;
  }

  if (launched) {
    recordOpened({
      windowId: launched.appId,
      windowTitle: launched.name,
      monitorId: launched.monitorId,
      bounds: launched.bounds,
      content: launched.content,
      appId: launched.appId,
      details: `opened to show ${title}, which the user's link_open hook routes here`,
    });
    return true;
  }

  const actions: OSAction[] = [];
  if (store.windows[key]?.minimized)
    actions.push({ type: 'window.restore', windowId: handler.appId });
  actions.push({ type: 'window.focus', windowId: handler.appId });
  store.applyActions(actions);
  return true;
}

/** Close a window this module opened for a link the app then did not take. */
function undoLaunch(launched: LaunchedWindow): void {
  getDesktopState().applyActions([{ type: 'window.close', windowId: launched.appId }]);
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

  // `?url=` is the Browser app's launch parameter: it opens on that page rather than on
  // a blank one, so there is nothing to wait for and no command to send.
  const launched = await launchAppWindow(BROWSER_APP_ID, `url=${encodeURIComponent(href)}`);
  if (!launched) return false;

  recordOpened({
    windowId: launched.appId,
    windowTitle: launched.name,
    monitorId: launched.monitorId,
    bounds: launched.bounds,
    content: launched.content,
    appId: launched.appId,
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

  if (await openInHookedApp(href, title, sourceWindowId)) return;
  if (await isEmbeddable(href)) {
    openIframeWindow(href, title, sourceWindowId);
    return;
  }
  if (await openInBrowserApp(href, title)) return;
  openIframeWindow(href, title, sourceWindowId);
}
