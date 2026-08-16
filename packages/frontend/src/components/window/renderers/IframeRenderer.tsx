/**
 * IframeRenderer - Embeds external websites in a window.
 *
 * Detects CSP/X-Frame-Options blocking and reports back to the AI.
 */
import { memo, useEffect, useRef, useState, useCallback } from 'react';
import {
  IFRAME_IME_GUARD_SCRIPT,
  IFRAME_CAPTURE_HELPER_SCRIPT,
  IFRAME_STORAGE_SDK_SCRIPT,
  IFRAME_FETCH_PROXY_SCRIPT,
  IFRAME_APP_PROTOCOL_SCRIPT,
  IFRAME_CONTEXTMENU_SCRIPT,
  IFRAME_NOTIFICATIONS_SDK_SCRIPT,
  IFRAME_WINDOWS_SDK_SCRIPT,
  IFRAME_VERB_SDK_SCRIPT,
} from '@yaar/shared';
import { resolveAssetUrl, getRemoteConnection } from '@/lib/api';
import { useDesktopStore } from '@/store';
import styles from '@/styles/window/renderers.module.css';

interface IframeRendererProps {
  data: string | { url: string; sandbox?: string };
  requestId?: string;
  iframeToken?: string;
  /**
   * App-origin isolation (docs/guides/remote_mode.md). When set, render this
   * app from a distinct origin so it is cross-origin to the desktop, and hand it
   * the desktop origin as `__yaar_api` so its SDK still reaches the backend across
   * that boundary. The server refuses a token-less request that carries the app
   * origin, so an isolated app can no longer pass as the host.
   */
  isolateOrigin?: boolean;
  /**
   * The origin to isolate *to*, when the server had to name it: a remote transport
   * publishes the two origins as two ports on one hostname (`https://box.ts.net` and
   * `https://box.ts.net:8443`), and nothing here can compute the second from the
   * first. Absent, we derive the sibling loopback alias locally — which only the
   * browser can do correctly, since the desktop's port is not necessarily the API's.
   */
  appOrigin?: string;
  /**
   * Set when this frame hosts an app, which is what makes a *second* load event
   * meaningful: an app document that gets replaced takes every injected script with
   * it (see `navigatedAway`). A plain web page in a window browses in place, and
   * must keep doing so.
   */
  appId?: string;
  onRenderSuccess?: () => void;
  onRenderError?: (error: string, url: string) => void;
}

type LoadState = 'loading' | 'loaded' | 'error';

/**
 * The sandbox applied to an app-origin-isolated (cross-origin) app frame.
 *
 * Written *subtractively*, on purpose. `sandbox` drops every capability and you
 * re-add tokens, so a curated minimal set is a foot-gun: the one capability you
 * forget is the next silent render bug (this is exactly how the DC-comics gallery
 * lost its images once — a tightening starved a flow nobody re-added). So we re-add
 * everything an unsandboxed cross-origin frame already had and withhold *only* the
 * top-navigation family. The single behavioral delta is: an isolated app can no
 * longer point `window.top.location` at a phishing page and swap the whole desktop
 * out from under the user (docs/guides/remote_mode.md).
 *
 * `allow-same-origin` is what keeps the app its own `127.0.0.1` origin — so
 * localStorage, cookies, its own `blob:` object-URLs, and the cross-origin `fetch`
 * to `__yaar_api` all keep working; drop it and *that* is what reintroduces the
 * DC-comics class of breakage. It is safe here precisely because the frame is
 * cross-origin to the desktop: it cannot reach `window.parent` to delete its own
 * sandbox attribute, the escape that makes `allow-scripts allow-same-origin`
 * dangerous on a *same-origin* frame.
 *
 * Deliberately absent: `allow-top-navigation`,
 * `allow-top-navigation-by-user-activation`,
 * `allow-top-navigation-to-custom-protocols`. No app legitimately navigates the
 * top window — the top window *is* the desktop — and none in `apps/` does (a CI
 * grep guards that).
 */
export const ISOLATED_APP_SANDBOX = [
  'allow-scripts',
  'allow-same-origin',
  'allow-forms',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-modals',
  'allow-downloads',
  'allow-pointer-lock',
  'allow-orientation-lock',
  'allow-presentation',
  'allow-storage-access-by-user-activation',
].join(' ');

/**
 * The app origin — the `127.0.0.1` loopback alias on the current port — or null
 * when the desktop isn't on `localhost` (a LAN IP / remote tunnel, or already on
 * `127.0.0.1`), where isolation has no meaning here.
 *
 * The assignment is pinned, not symmetric (Stage 2): the desktop lives on
 * `localhost` and apps on `127.0.0.1`. The server enforces exactly that — it
 * refuses a token-less request carrying the `127.0.0.1` origin, and redirects a
 * desktop document that lands there back to localhost — so we must never serve an
 * app onto the desktop's own alias. Both aliases resolve to the same local socket,
 * so this only changes the browser-visible origin, not what host is reached.
 */
function siblingLoopbackOrigin(): string | null {
  const { protocol, hostname, port } = window.location;
  if (hostname !== 'localhost') return null;
  return `${protocol}//127.0.0.1${port ? `:${port}` : ''}`;
}

// Check if URL is same-origin (relative path or same host)
function isSameOrigin(url: string): boolean {
  if (url.startsWith('/')) return true;
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin === window.location.origin) return true;
    // In remote mode, treat the backend server as same-origin
    const conn = getRemoteConnection();
    if (conn) {
      const serverOrigin = new URL(conn.serverUrl).origin;
      if (parsed.origin === serverOrigin) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * The host the loading overlay names, or null when it should just say "Loading…".
 *
 * A hostname is the useful thing to name for an embedded external site, and pure
 * noise for local content: every app and every stored file is served off the
 * desktop's own socket, so a window opening `yaar://apps/memo` announced itself as
 * "Loading 127.0.0.1..." — or "localhost", or the tailnet host in remote mode,
 * depending on which alias origin isolation put that frame on. The window's title
 * bar already names the app, so local content needs no target at all.
 *
 * Takes the *resolved* URL rather than the finished one: an isolated app is moved
 * onto the sibling loopback alias afterwards, which would read as cross-origin here.
 */
function loadingHost(resolvedUrl: string): string | null {
  if (isSameOrigin(resolvedUrl)) return null;
  try {
    return new URL(resolvedUrl, window.location.origin).hostname || null;
  } catch {
    return null;
  }
}

function IframeRenderer({
  data,
  requestId,
  iframeToken,
  isolateOrigin,
  appOrigin: serverAppOrigin,
  appId,
  onRenderSuccess,
  onRenderError,
}: IframeRendererProps) {
  const rawUrl = typeof data === 'string' ? data : data.url;
  const resolved = resolveAssetUrl(rawUrl);
  const sessionId = useDesktopStore((s) => s.sessionId);
  const customSandbox = typeof data === 'object' ? data.sandbox : undefined;

  // The desktop's own origin — the API base an isolated app is handed as __yaar_api.
  // Remote mode's `serverUrl` is the desktop origin; locally it is this page.
  const desktopOrigin = getRemoteConnection()?.serverUrl ?? window.location.origin;

  // App-origin isolation: resolve to the app origin, only when the server marked this
  // app (source:'user'). Either the server named the origin (a remote transport that
  // publishes both), or we derive the sibling loopback alias from a same-origin path.
  // Null means "not isolated" and every path below falls back to same-origin behavior.
  const appOrigin = !isolateOrigin
    ? null
    : (serverAppOrigin ??
      (!getRemoteConnection() && resolved.startsWith('/') ? siblingLoopbackOrigin() : null));

  // Lock sessionId at mount time so late CONNECTION_STATUS doesn't re-render the iframe.
  // If sessionId isn't available yet, pick it up once and freeze.
  const sessionIdRef = useRef(sessionId);
  if (!sessionIdRef.current && sessionId) {
    sessionIdRef.current = sessionId;
  }

  // Append sessionId and iframeToken to same-origin iframe URLs.
  // sessionId: used by the fetch proxy script for domain permission dialogs
  // iframeToken: read by the verb SDK at init time (before handleLoad injects __YAAR_TOKEN__)
  const url = (() => {
    const sid = sessionIdRef.current;
    // Isolated app: build an absolute URL on the app origin, and hand the app the
    // desktop origin as __yaar_api so its baked-in SDK calls the backend across the
    // boundary. The token still rides in the query (the app reads it there), as does
    // the remote token that `resolveAssetUrl` already appended in remote mode — the
    // path+query is carried over wholesale and only the origin is swapped.
    if (appOrigin) {
      try {
        const u = new URL(resolved, desktopOrigin);
        if (sid && !u.searchParams.has('sessionId')) u.searchParams.set('sessionId', sid);
        if (iframeToken && !u.searchParams.has('__yaar_token')) {
          u.searchParams.set('__yaar_token', iframeToken);
        }
        if (!u.searchParams.has('__yaar_api')) {
          u.searchParams.set('__yaar_api', new URL(desktopOrigin).origin);
        }
        return `${appOrigin}${u.pathname}${u.search}`;
      } catch {
        return resolved;
      }
    }
    if (!isSameOrigin(resolved)) return resolved;
    try {
      const u = new URL(resolved, window.location.origin);
      if (sid && !u.searchParams.has('sessionId')) {
        u.searchParams.set('sessionId', sid);
      }
      if (iframeToken && !u.searchParams.has('__yaar_token')) {
        u.searchParams.set('__yaar_token', iframeToken);
      }
      // Return pathname + search to keep it relative
      return u.pathname + u.search;
    } catch {
      return resolved;
    }
  })();
  // For same-origin content (local apps), don't sandbox - it's trusted
  // For cross-origin, apply sandbox to prevent escape attacks
  // allow-same-origin: lets the site access its own localStorage/cookies (required by most sites)
  // allow-scripts: lets the site run JavaScript
  // allow-forms: lets the site submit forms
  //
  // An isolated app is cross-origin, so the browser already blocks its `window.parent`
  // DOM/memory reach and the server refuses its token-less requests. The one thing an
  // unsandboxed cross-origin frame could still do is navigate the top window
  // (`window.top.location`) and swap the desktop for a phishing page. ISOLATED_APP_SANDBOX
  // withholds exactly the top-navigation family and keeps every other capability, so that
  // redirect is the only behavior that changes (docs/guides/remote_mode.md).
  const sandbox = appOrigin
    ? (customSandbox ?? ISOLATED_APP_SANDBOX)
    : (customSandbox ??
      (isSameOrigin(url) ? undefined : 'allow-scripts allow-forms allow-same-origin'));

  const loadingTarget = loadingHost(resolved);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const reportedRef = useRef(false);
  /**
   * Where an app frame went when it stopped being the app.
   *
   * An app frame is same-origin and unsandboxed, and no sandbox token governs a
   * frame navigating *itself* — the `allow-top-navigation` family only governs the
   * top-level context — so a plain `<a href>`, a form submit, a `location.href` or a
   * meta refresh in app-rendered HTML replaces the app document and every injected
   * script with it. Nothing threw and nothing logged: the app just stopped answering
   * the protocol, which reads from the outside as a crash.
   *
   * The bridge's link guard (`iframe-scripts/app-protocol.ts`) prevents the common
   * cause. This catches the rest, and catches them for apps built before that guard
   * existed, because it needs nothing from inside the frame: a *second* load event on
   * a frame whose document is no longer the app's is the whole signal.
   *
   * `href` is null when the frame walked off to another origin — the destination is
   * then unreadable by definition, and that unreadability is itself the proof.
   */
  const [navigatedAway, setNavigatedAway] = useState<{ href: string | null } | null>(null);

  const reportError = useCallback(
    (message: string) => {
      if (reportedRef.current) return;
      reportedRef.current = true;
      setLoadState('error');
      setErrorMessage(message);
      onRenderError?.(message, url);
    },
    [onRenderError, url],
  );

  // Reset state when URL changes
  useEffect(() => {
    setLoadState('loading');
    setErrorMessage('');
    setNavigatedAway(null);
    reportedRef.current = false;
  }, [url]);

  // Listen for CSP violations and handle timeout fallback
  useEffect(() => {
    const handleSecurityViolation = (e: SecurityPolicyViolationEvent) => {
      // Check if this violation is related to our iframe
      if (e.blockedURI) {
        try {
          if (url.includes(new URL(e.blockedURI).hostname)) {
            reportError(`Site blocked iframe embedding (CSP: ${e.violatedDirective})`);
          }
        } catch {
          // Invalid URL in blockedURI, ignore
        }
      }
    };

    document.addEventListener('securitypolicyviolation', handleSecurityViolation);

    // Fallback: If iframe hasn't loaded after timeout, assume it's blocked
    const timeoutId = setTimeout(() => {
      // Use ref to check current state without causing re-renders
      const iframe = iframeRef.current;
      if (iframe && !reportedRef.current) {
        try {
          // This will throw for cross-origin, but if iframe didn't load at all,
          // contentWindow might be null or document might be about:blank
          const doc = iframe.contentDocument;
          if (doc && doc.location.href === 'about:blank') {
            reportError('Site may have blocked iframe embedding (X-Frame-Options or CSP)');
          }
        } catch {
          // Cross-origin - can't check, assume it loaded if no CSP error was caught
        }
      }
    }, 3000);

    return () => {
      document.removeEventListener('securitypolicyviolation', handleSecurityViolation);
      clearTimeout(timeoutId);
    };
  }, [url, reportError]);

  /**
   * A load event after the app's first one. Tell a reload (`location.reload()`, a
   * devtools preview rebuilding itself) apart from the app document being replaced,
   * and only report the latter.
   *
   * Scoped to a same-origin app frame, because that is the only one whose document
   * this can read *and* is expected to stay readable. For an origin-isolated app the
   * frame is cross-origin from the first load, so a reload and a walk-off are
   * indistinguishable from here and nothing is claimed either way.
   */
  const checkNavigatedAway = () => {
    // `appOrigin` is set only for an isolated app — always cross-origin, never readable.
    if (!appId || appOrigin) return;

    const frame = iframeRef.current;
    const win = frame?.contentWindow;
    if (!win) return; // Nothing to read, so nothing to claim.

    let href: string | null = null;
    let unreadable = false;
    try {
      href = win.location.href;
    } catch {
      // A same-origin frame whose location has become unreadable *is* a frame on
      // another origin now. Unreadability is the proof, and it is the loudest case:
      // an external link is exactly what walks an app off its own origin.
      unreadable = true;
    }
    const samePage = (a: string, b: string) => {
      try {
        const ua = new URL(a, window.location.origin);
        const ub = new URL(b, window.location.origin);
        return ua.origin === ub.origin && ua.pathname === ub.pathname;
      } catch {
        return a === b;
      }
    };
    if (!unreadable) {
      if (!href || href === 'about:blank') return;
      if (samePage(href, url)) return; // The app reloaded itself; still the app.
    }

    const where = unreadable ? 'another origin' : (href ?? 'another origin');
    setNavigatedAway({ href: unreadable ? null : href });
    console.warn(
      `[IframeRenderer] app "${appId}" navigated its own frame to ${where}. ` +
        'The app document and every script in it (the app protocol bridge included) are gone. ' +
        'Links in app-rendered HTML should carry target="_blank" or be handled by the app.',
    );
    onRenderError?.(`App "${appId}" navigated away to ${where}`, href ?? url);
  };

  const handleLoad = () => {
    // A load event once this frame is already `loaded` is a second document in the
    // same frame — the signal below. Everything under it is first-load setup.
    if (loadState === 'loaded') {
      checkNavigatedAway();
      return;
    }

    // iframe loaded event fired - but this doesn't mean content loaded successfully
    // CSP blocks happen before this, X-Frame-Options might show error page
    // Check reportedRef to avoid reporting success after an error was already reported
    if (loadState === 'loading' && !reportedRef.current) {
      // For same-origin iframes, detect HTTP error responses (404, 500, etc.)
      // The server returns JSON like {"error":"File not found"} for errors
      const iframe = iframeRef.current;
      if (iframe && isSameOrigin(url)) {
        try {
          const doc = iframe.contentDocument;
          const body = doc?.body?.textContent?.trim();
          if (body) {
            const parsed = JSON.parse(body);
            if (parsed && typeof parsed.error === 'string') {
              reportError(parsed.error);
              return;
            }
          }
        } catch {
          // Not JSON or cross-origin — continue normally
        }
      }

      setLoadState('loaded');

      // Inject capture helper into same-origin iframes (non-compiler-generated ones)
      if (iframe) {
        try {
          const doc = iframe.contentDocument;
          // Inject iframe token before SDK scripts so they can include it in requests
          if (doc && iframeToken && !doc.querySelector('script[data-yaar-token]')) {
            const tokenScript = doc.createElement('script');
            tokenScript.setAttribute('data-yaar-token', '1');
            tokenScript.textContent = `window.__YAAR_TOKEN__=${JSON.stringify(iframeToken)};`;
            doc.head.appendChild(tokenScript);
          }
          // First — the guard must be listening before any app code registers handlers
          if (doc && !doc.querySelector('script[data-yaar-ime-guard]')) {
            const imeScript = doc.createElement('script');
            imeScript.setAttribute('data-yaar-ime-guard', '1');
            imeScript.textContent = IFRAME_IME_GUARD_SCRIPT;
            doc.head.appendChild(imeScript);
          }
          if (doc && !doc.querySelector('script[data-yaar-capture]')) {
            const script = doc.createElement('script');
            script.setAttribute('data-yaar-capture', '1');
            script.textContent = IFRAME_CAPTURE_HELPER_SCRIPT;
            doc.head.appendChild(script);
          }
          // Verb SDK must come before storage/windows SDKs (they depend on it)
          if (doc && !doc.querySelector('script[data-yaar-verb]')) {
            const verbScript = doc.createElement('script');
            verbScript.setAttribute('data-yaar-verb', '1');
            verbScript.textContent = IFRAME_VERB_SDK_SCRIPT;
            doc.head.appendChild(verbScript);
          }
          if (doc && !doc.querySelector('script[data-yaar-storage]')) {
            const storageScript = doc.createElement('script');
            storageScript.setAttribute('data-yaar-storage', '1');
            storageScript.textContent = IFRAME_STORAGE_SDK_SCRIPT;
            doc.head.appendChild(storageScript);
          }
          if (doc && !doc.querySelector('script[data-yaar-fetch-proxy]')) {
            const fetchProxyScript = doc.createElement('script');
            fetchProxyScript.setAttribute('data-yaar-fetch-proxy', '1');
            fetchProxyScript.textContent = IFRAME_FETCH_PROXY_SCRIPT;
            doc.head.appendChild(fetchProxyScript);
          }
          if (doc && !doc.querySelector('script[data-yaar-app-protocol]')) {
            const appProtocolScript = doc.createElement('script');
            appProtocolScript.setAttribute('data-yaar-app-protocol', '1');
            appProtocolScript.textContent = IFRAME_APP_PROTOCOL_SCRIPT;
            doc.head.appendChild(appProtocolScript);
          }
          if (doc && !doc.querySelector('script[data-yaar-contextmenu]')) {
            const contextMenuScript = doc.createElement('script');
            contextMenuScript.setAttribute('data-yaar-contextmenu', '1');
            contextMenuScript.textContent = IFRAME_CONTEXTMENU_SCRIPT;
            doc.head.appendChild(contextMenuScript);
          }
          if (doc && !doc.querySelector('script[data-yaar-notifications]')) {
            const notifScript = doc.createElement('script');
            notifScript.setAttribute('data-yaar-notifications', '1');
            notifScript.textContent = IFRAME_NOTIFICATIONS_SDK_SCRIPT;
            doc.head.appendChild(notifScript);
          }
          if (doc && !doc.querySelector('script[data-yaar-windows]')) {
            const windowsScript = doc.createElement('script');
            windowsScript.setAttribute('data-yaar-windows', '1');
            windowsScript.textContent = IFRAME_WINDOWS_SDK_SCRIPT;
            doc.head.appendChild(windowsScript);
          }
          // Push current notification state to the newly loaded iframe
          const notifs = useDesktopStore.getState().notifications;
          const items = Object.values(notifs);
          iframe.contentWindow?.postMessage({ type: 'yaar:notifications-update', items }, '*');
        } catch (e) {
          // Cross-origin — can't inject, capture helper must be baked in
          console.warn(
            `[IframeRenderer] Cross-origin iframe, cannot inject scripts: url=${url}`,
            e,
          );
        }
      }

      // Only report success if we have a requestId (meaning server is waiting for feedback)
      if (requestId) {
        reportedRef.current = true;
        onRenderSuccess?.();
      }
    }
  };

  const handleError = () => {
    reportError('Failed to load iframe content');
  };

  if (navigatedAway) {
    return (
      <div className={styles.iframeError}>
        <div className={styles.iframeErrorIcon}>↪️</div>
        <div className={styles.iframeErrorTitle}>This app navigated away</div>
        <div className={styles.iframeErrorMessage}>
          {navigatedAway.href ? (
            <>
              A link or redirect replaced the app with <code>{navigatedAway.href}</code>, so the app
              is no longer running in this window.
            </>
          ) : (
            'A link or redirect sent this frame to another site, so the app is no longer running in this window.'
          )}
        </div>
        <button
          type="button"
          className={styles.iframeErrorButton}
          onClick={() => {
            // Unmounting the card remounts a fresh <iframe> at `url`, which is what
            // actually re-fetches the app: the element never changed `src`.
            setNavigatedAway(null);
            setLoadState('loading');
            reportedRef.current = false;
          }}
        >
          Reload app
        </button>
        {navigatedAway.href && (
          <a
            href={navigatedAway.href}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.iframeErrorLink}
          >
            Open that page in a new tab →
          </a>
        )}
      </div>
    );
  }

  if (loadState === 'error') {
    return (
      <div className={styles.iframeError}>
        <div className={styles.iframeErrorIcon}>🚫</div>
        <div className={styles.iframeErrorTitle}>Cannot embed this site</div>
        <div className={styles.iframeErrorMessage}>{errorMessage}</div>
        <a href={url} target="_blank" rel="noopener noreferrer" className={styles.iframeErrorLink}>
          Open in new tab →
        </a>
      </div>
    );
  }

  return (
    <div className={styles.iframeContainer}>
      {loadState === 'loading' && (
        <div className={styles.iframeLoading}>
          <div className={styles.iframeLoadingSpinner} />
          <span>{loadingTarget ? `Loading ${loadingTarget}…` : 'Loading…'}</span>
        </div>
      )}
      <iframe
        ref={iframeRef}
        src={url}
        className={styles.iframe}
        {...(sandbox ? { sandbox } : {})}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        // @ts-expect-error React doesn't recognize lowercase HTML attribute
        allowtransparency="true"
        loading="lazy"
        title="Embedded content"
        onLoad={handleLoad}
        onError={handleError}
      />
    </div>
  );
}

export const MemoizedIframeRenderer = memo(IframeRenderer);
