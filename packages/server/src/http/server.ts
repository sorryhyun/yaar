/**
 * HTTP fetch handler — CORS, auth, MCP dispatch, route dispatch.
 *
 * Returns a function compatible with Bun.serve({ fetch }).
 * WebSocket upgrade is handled here too: when path is /ws, we return undefined
 * to signal to the caller that server.upgrade() should be called instead.
 */

import { handleMcpRequest, CORE_SERVERS, type McpServerName } from '../mcp/server.js';
import { getPort, IS_REMOTE, APP_ORIGIN_ISOLATION } from '../config.js';
import { desktopRedirectTarget, runOnAppOriginSocket } from './origin-boundary.js';

let _devReloadHandler: (() => Response) | null = null;

/** Register the SSE handler for dev live-reload. Called by dev-bundler.ts. */
export function registerDevReloadHandler(handler: () => Response): void {
  _devReloadHandler = handler;
}
import { checkHttpAuth, checkWsAuth } from './auth.js';
import { prepareWsData, type WsData } from '../websocket/server.js';
import { generateConnectionId } from '../session/broadcast-center.js';
import {
  handleApiRoutes,
  handleAuthRoutes,
  handleBridgeRoutes,
  handleBrowserRoutes,
  handleDevRoutes,
  handleFileRoutes,
  handleMlRuntimeRoutes,
  handleProxyRoutes,
  handleSessionRoutes,
  handleSettingsRoutes,
  handleShortcutRoutes,
  handleStaticRoutes,
  handleVerbRoutes,
} from './routes/index.js';
import { validateIframeToken } from './iframe-tokens.js';
import { extractIframeToken, requireBundledApp } from './access.js';
import { PUBLIC_ENDPOINTS as API_PUBLIC } from './routes/api.js';
import { PUBLIC_ENDPOINTS as AUTH_PUBLIC } from './routes/auth.js';
import { PUBLIC_ENDPOINTS as BRIDGE_PUBLIC } from './routes/bridge.js';
import { PUBLIC_ENDPOINTS as BROWSER_PUBLIC } from './routes/browser.js';
import { PUBLIC_ENDPOINTS as DEV_PUBLIC } from './routes/dev.js';
import { PUBLIC_ENDPOINTS as FILES_PUBLIC } from './routes/files.js';
import { PUBLIC_ENDPOINTS as ML_RUNTIME_PUBLIC } from './routes/ml-runtime.js';
import { PUBLIC_ENDPOINTS as PROXY_PUBLIC } from './routes/proxy.js';
import { PUBLIC_ENDPOINTS as SESSIONS_PUBLIC } from './routes/sessions.js';
import { PUBLIC_ENDPOINTS as SETTINGS_PUBLIC } from './routes/settings.js';
import { PUBLIC_ENDPOINTS as SHORTCUTS_PUBLIC } from './routes/shortcuts.js';
import { PUBLIC_ENDPOINTS as VERB_PUBLIC } from './routes/verb.js';

// Build a set of { method, regex } from all route files' PUBLIC_ENDPOINTS.
// Path patterns like `/api/storage/{path}` become `/api/storage/.+`.
// Static routes (/health, frontend assets) are always allowed.

interface PublicRoute {
  method: string;
  pattern: RegExp;
}

function buildPublicRoutes(): PublicRoute[] {
  const all = [
    ...API_PUBLIC,
    ...AUTH_PUBLIC,
    ...BRIDGE_PUBLIC,
    ...BROWSER_PUBLIC,
    ...DEV_PUBLIC,
    ...FILES_PUBLIC,
    ...ML_RUNTIME_PUBLIC,
    ...PROXY_PUBLIC,
    ...SESSIONS_PUBLIC,
    ...SETTINGS_PUBLIC,
    ...SHORTCUTS_PUBLIC,
    ...VERB_PUBLIC,
  ];
  return all.map((ep) => {
    const pathOnly = ep.path.split('?')[0];
    // Convert {param} placeholders to .+ and anchor
    const regexStr = '^' + pathOnly.replace(/\{[^}]+\}/g, '[^/]+') + '(/.*)?$';
    return { method: ep.method, pattern: new RegExp(regexStr) };
  });
}

const publicRoutes = buildPublicRoutes();

function isPublicRoute(method: string, pathname: string): boolean {
  if (pathname === '/health') return true;
  // Frontend static files (served by static.ts) are always public
  if (!pathname.startsWith('/api/') && !pathname.startsWith('/mcp/')) return true;

  return publicRoutes.some((r) => r.method === method && r.pattern.test(pathname));
}

export interface FetchHandlerOptions {
  /**
   * This handler serves the **app-origin socket** (`http/origin-boundary.ts`).
   *
   * Under a `proxy-port` boundary the two public origins are two Tailscale Serve
   * ports pointed at two local sockets, and *which socket a request arrived on* is
   * the only unspoofable way to tell which origin the browser addressed — `Host`
   * and `X-Forwarded-*` come from the proxy. Giving each socket its own handler is
   * how that fact reaches `resolvePrincipal`, however deep in a route it runs.
   */
  appOriginSocket?: boolean;
}

export function createFetchHandler(options: FetchHandlerOptions = {}) {
  const handle = createFetchHandlerInner();
  if (!options.appOriginSocket) return handle;
  return (req: Request, server: import('bun').Server<WsData>) =>
    runOnAppOriginSocket(() => handle(req, server));
}

/**
 * `?quality=` / `?maxWidth=` on the screencast upgrade, clamped.
 *
 * The values reach `Page.startScreencast`, so they are bounded here rather than
 * passed on as typed: quality outside 1–100 is a CDP error, and a `maxWidth`
 * larger than the viewport just means Chrome ignores it while the parameter
 * still looks honored.
 */
function clampedStreamParams(url: URL): {
  screencastQuality?: number;
  screencastMaxWidth?: number;
} {
  const read = (name: string, lo: number, hi: number): number | undefined => {
    const raw = url.searchParams.get(name);
    if (raw === null) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : undefined;
  };
  const quality = read('quality', 1, 100);
  const maxWidth = read('maxWidth', 100, 4096);
  return {
    ...(quality !== undefined ? { screencastQuality: quality } : {}),
    ...(maxWidth !== undefined ? { screencastMaxWidth: maxWidth } : {}),
  };
}

function createFetchHandlerInner() {
  return async (req: Request, server: import('bun').Server<WsData>) => {
    const url = new URL(req.url, `http://localhost:${getPort()}`);

    // WebSocket upgrade — auth + upgrade happen here, handlers in websocket config
    if (url.pathname === '/ws') {
      const { authorized, data } = prepareWsData(url);
      if (!authorized) {
        return new Response('Unauthorized', { status: 401 });
      }
      const success = server.upgrade(req, { data });
      if (success) return undefined; // Bun handles the rest
      return new Response('WebSocket upgrade failed', { status: 500 });
    }

    // Live browser screencast (pre-P0 spike) — the `browser` app dials this to receive
    // CDP frames and send the human's pointer/key events back. A WebSocket cannot carry
    // a header any more than `<img src>` can, so the app's iframe token rides as
    // `?__yaar_token=`, exactly as the screenshot and SSE routes beside it do.
    const screencastMatch = url.pathname.match(/^\/api\/browser\/([a-zA-Z0-9_-]+)\/screencast$/);
    if (screencastMatch) {
      const auth = requireBundledApp(req, url, 'yaar-web');
      if (auth instanceof Response) return auth;
      const data: WsData = {
        kind: 'screencast',
        connectionId: generateConnectionId(),
        sessionId: auth.sessionId,
        monitorId: auth.monitorId ?? null,
        browserId: decodeURIComponent(screencastMatch[1]),
        ...clampedStreamParams(url),
      };
      const success = server.upgrade(req, { data });
      if (success) return undefined;
      return new Response('Screencast upgrade failed', { status: 500 });
    }

    // YAAR Bridge WebSocket — the companion extension dials out to here (see extension/).
    if (url.pathname === '/bridge') {
      if (!checkWsAuth(url)) {
        return new Response('Unauthorized', { status: 401 });
      }
      const data: WsData = {
        kind: 'bridge',
        connectionId: generateConnectionId(),
        sessionId: null,
        monitorId: null,
      };
      const success = server.upgrade(req, { data });
      if (success) return undefined;
      return new Response('Bridge upgrade failed', { status: 500 });
    }

    // App-origin isolation: pin the desktop to its own origin. Isolated apps live on
    // the app origin, and resolvePrincipal refuses a token-less request that carries
    // it — so the desktop must never live there, or its own (legitimately token-less)
    // requests would be refused too. A top-level *document* navigation that lands on
    // the app origin is the human's desktop; send it back. App iframe documents
    // (Sec-Fetch-Dest: iframe) carry a token and are left alone; so are API/asset
    // calls (not documents).
    if (req.method === 'GET' && req.headers.get('sec-fetch-dest') === 'document') {
      const target = desktopRedirectTarget(url);
      if (target) return new Response(null, { status: 302, headers: { Location: target } });
    }

    const origin = req.headers.get('origin');
    const corsHeaders: Record<string, string> = {};

    if (IS_REMOTE) {
      if (origin) {
        corsHeaders['Access-Control-Allow-Origin'] = origin;
        corsHeaders['Access-Control-Allow-Methods'] = 'GET, POST, PATCH, DELETE, OPTIONS';
        corsHeaders['Access-Control-Allow-Headers'] =
          'Content-Type, Authorization, X-Iframe-Token, X-Yaar-Client';
        corsHeaders['Access-Control-Allow-Credentials'] = 'true';
      }
    } else {
      // Local mode: whitelist localhost origins (same-origin requests won't have Origin header)
      const allowedOrigins = [`http://localhost:${getPort()}`];
      // App-origin isolation (Stage 1): installed apps are served from the sibling
      // loopback alias, so their SDK's cross-origin calls to the desktop API carry
      // that Origin and must be allowed. Both aliases resolve to this same loopback
      // socket, so widening the allowlist to the sibling adds no new reachability.
      if (APP_ORIGIN_ISOLATION) {
        allowedOrigins.push(`http://127.0.0.1:${getPort()}`);
      }
      if (origin && allowedOrigins.includes(origin)) {
        corsHeaders['Access-Control-Allow-Origin'] = origin;
        corsHeaders['Access-Control-Allow-Methods'] = 'GET, POST, PATCH, DELETE, OPTIONS';
        corsHeaders['Access-Control-Allow-Headers'] = 'Content-Type, X-Iframe-Token, X-Yaar-Client';
        corsHeaders['Access-Control-Allow-Credentials'] = 'true';
      }
    }

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Auth gate (no-op when !IS_REMOTE; /health always exempt)
    const authResponse = checkHttpAuth(req, url);
    if (authResponse) return withCors(authResponse, corsHeaders);

    // Phase A: Sec-Fetch-Dest check — browser-enforced, cannot be spoofed.
    // Catches iframe document loads (initial page load in <iframe>).
    const secFetchDest = req.headers.get('sec-fetch-dest');
    if (secFetchDest === 'iframe' && !isPublicRoute(req.method, url.pathname)) {
      return withCors(
        Response.json({ error: 'Route not available to iframe apps' }, { status: 403 }),
        corsHeaders,
      );
    }

    // Phase B: Iframe-scoped token check — catches fetch() calls from within iframes.
    // A route not on the iframe allowlist is refused outright; the routes that *are*
    // on it then run the permission check in http/access.ts. This is the coarse gate,
    // not the only one.
    //
    // "Presenting a token" is `extractIframeToken`'s definition and nobody else's.
    // This gate used to read the header alone, so an `<img src>` or `EventSource`
    // carrying `?__yaar_token=` — the only way a subresource can carry one — skipped
    // the allowlist entirely and met only the fine-grained gates behind it. Every
    // legitimate query-param consumer (`/api/storage/{path}`, `/api/pdf/{path}/{page}`,
    // `/api/apps/{appId}/{path}`, `/api/browser/{id}/screenshot`, `/api/browser/{id}/events`)
    // is on the allowlist; tests/iframe-token-extraction.test.ts holds one row per consumer.
    const iframeToken = extractIframeToken(req, url);
    if (iframeToken) {
      const tokenEntry = validateIframeToken(iframeToken);

      // An invalid or expired token used to fall through here and be handled as a
      // *host* request — so an app whose token had merely aged out silently gained
      // full access instead of losing it. Presenting a token is a claim of identity;
      // a claim that doesn't check out is refused, not promoted.
      if (!tokenEntry) {
        return withCors(
          Response.json({ error: 'Invalid or expired iframe token' }, { status: 403 }),
          corsHeaders,
        );
      }

      if (!isPublicRoute(req.method, url.pathname)) {
        return withCors(
          Response.json({ error: 'Route not available to iframe apps' }, { status: 403 }),
          corsHeaders,
        );
      }
      // Per-app route scoping: block cross-app static file access
      if (tokenEntry.appId && url.pathname.startsWith('/api/apps/')) {
        const appsMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\//);
        if (appsMatch && appsMatch[1] !== tokenEntry.appId) {
          return withCors(
            Response.json({ error: 'Cross-app access denied' }, { status: 403 }),
            corsHeaders,
          );
        }
      }
    }

    // MCP endpoints for tool calls (/mcp/system, /mcp/window, /mcp/apps, /mcp/basic, ...)
    const mcpMatch = url.pathname.match(/^\/mcp\/(\w+)$/);
    if (mcpMatch && (req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE')) {
      const serverName = mcpMatch[1] as McpServerName;
      if ((CORE_SERVERS as readonly string[]).includes(serverName)) {
        const response = await handleMcpRequest(req, serverName);
        return withCors(response, corsHeaders);
      }
    }

    if (_devReloadHandler && url.pathname === '/dev-reload') {
      return _devReloadHandler();
    }

    // Route dispatch — short-circuit on first match
    const apiResponse = await handleApiRoutes(req, url);
    if (apiResponse) return withCors(apiResponse, corsHeaders);

    const googleAuthResponse = await handleAuthRoutes(req, url);
    if (googleAuthResponse) return withCors(googleAuthResponse, corsHeaders);

    const shortcutResponse = await handleShortcutRoutes(req, url);
    if (shortcutResponse) return withCors(shortcutResponse, corsHeaders);

    const sessionResponse = await handleSessionRoutes(req, url);
    if (sessionResponse) return withCors(sessionResponse, corsHeaders);

    const settingsResponse = await handleSettingsRoutes(req, url);
    if (settingsResponse) return withCors(settingsResponse, corsHeaders);

    const proxyResponse = await handleProxyRoutes(req, url);
    if (proxyResponse) return withCors(proxyResponse, corsHeaders);

    const bridgeResponse = await handleBridgeRoutes(req, url);
    if (bridgeResponse) return withCors(bridgeResponse, corsHeaders);

    const browserResponse = await handleBrowserRoutes(req, url);
    if (browserResponse) return withCors(browserResponse, corsHeaders);

    const devResponse = await handleDevRoutes(req, url);
    if (devResponse) return withCors(devResponse, corsHeaders);

    const verbResponse = await handleVerbRoutes(req, url);
    if (verbResponse) return withCors(verbResponse, corsHeaders);

    const mlRuntimeResponse = await handleMlRuntimeRoutes(req, url);
    if (mlRuntimeResponse) return withCors(mlRuntimeResponse, corsHeaders);

    const fileResponse = await handleFileRoutes(req, url);
    if (fileResponse) return withCors(fileResponse, corsHeaders);

    const staticResponse = await handleStaticRoutes(req, url);
    if (staticResponse) return withCors(staticResponse, corsHeaders);

    return withCors(Response.json({ error: 'Not found' }, { status: 404 }), corsHeaders);
  };
}

function withCors(response: Response, corsHeaders: Record<string, string>): Response {
  if (Object.keys(corsHeaders).length === 0) return response;
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}
