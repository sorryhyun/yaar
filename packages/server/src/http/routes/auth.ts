/**
 * Google auth routes — marketplace publisher identity.
 *
 * GET  /api/auth/google/status    — { configured, signedIn, email, pending }
 * POST /api/auth/google/login     — open the browser at Google's consent screen
 * GET  /api/auth/google/callback  — Google's redirect target (browser-facing HTML)
 * POST /api/auth/google/logout    — forget the local session
 * GET  /api/auth/google/me        — { email, apps } from the marketplace (server-side)
 *
 * ── Who may call these ──
 *
 * The desktop host, and **bundled `kind: "system"` apps** (in practice market-apps,
 * which owns the sign-in UI). Every other app is refused. Two reasons an ordinary
 * app must not reach these:
 *
 *   - `login` pops a *real* Google consent screen — a convincing phishing surface
 *     if any app could summon it.
 *   - the publisher credential these routes stand in front of is machine-wide, not
 *     scoped to one app.
 *
 * `systemApp` is derived from the app's own manifest and cannot be self-granted
 * (discovery.ts downgrades `kind: "system"` on anything not bundled), so it is a
 * real trust boundary — the same one `yaar://session/*` uses. The routes are on the
 * iframe allowlist (below) so a system app's `fetch()` reaches them; the per-request
 * `systemApp` check is what keeps every other app out.
 *
 * `callback` is deliberately *not* here: it is a top-level browser navigation from
 * Google (no iframe token, no consent to gate), already exempted from remote-token
 * auth in `auth.ts`, and its credential is the single-use `state`.
 */
import {
  beginLogin,
  completeLogin,
  getAuthStatus,
  signOut,
} from '../../features/market/google-auth.js';
import { fetchMe } from '../../features/market/marketplace.js';
import { resolvePrincipal } from '../access.js';
import { jsonResponse, errorResponse, type EndpointMeta } from '../utils.js';
import { errMessage } from '../../lib/errors.js';

export const PUBLIC_ENDPOINTS: EndpointMeta[] = [
  {
    method: 'GET',
    path: '/api/auth/google/status',
    response: 'JSON',
    description: 'Google sign-in status (host + bundled system apps only).',
  },
  {
    method: 'POST',
    path: '/api/auth/google/login',
    response: 'JSON',
    description: 'Start Google sign-in — opens the consent screen (host + system apps only).',
  },
  {
    method: 'POST',
    path: '/api/auth/google/logout',
    response: 'JSON',
    description: 'Forget the local Google session (host + system apps only).',
  },
  {
    method: 'GET',
    path: '/api/auth/google/me',
    response: 'JSON',
    description:
      'The publisher identity + owned app ids from the marketplace (host + system apps only).',
  },
];

/**
 * Restrict a route to the desktop host and bundled system apps.
 *
 * The host presents no iframe token; a system app presents one whose `systemApp`
 * flag came from its manifest. Any other app — or an invalid token — is refused.
 */
function requireHostOrSystemApp(req: Request, url: URL): Response | null {
  const principal = resolvePrincipal(req, url);
  if (principal instanceof Response) return principal; // invalid/expired token → 403
  if (principal.kind === 'host') return null;
  if (principal.systemApp) return null;
  return errorResponse(
    'Google sign-in is available only to the desktop and bundled system apps.',
    403,
  );
}

/** Minimal browser-facing page — this is the one route a human actually looks at. */
function callbackPage(title: string, message: string, ok: boolean): Response {
  return new Response(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      body {
        font-family: system-ui, -apple-system, sans-serif;
        display: flex; align-items: center; justify-content: center;
        height: 100vh; margin: 0; background: #14161a; color: #e6e8eb;
      }
      .card { text-align: center; max-width: 30rem; padding: 2rem; }
      .icon { font-size: 3rem; }
      h1 { font-size: 1.25rem; font-weight: 600; margin: 1rem 0 0.5rem; }
      p { color: #9aa3ad; margin: 0; line-height: 1.5; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="icon">${ok ? '✅' : '⚠️'}</div>
      <h1>${title}</h1>
      <p>${message}</p>
    </div>
  </body>
</html>`,
    { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

export async function handleAuthRoutes(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/auth/google/')) return null;

  if (url.pathname === '/api/auth/google/status' && req.method === 'GET') {
    const denied = requireHostOrSystemApp(req, url);
    if (denied) return denied;
    try {
      return jsonResponse(await getAuthStatus());
    } catch (err) {
      return errorResponse(errMessage(err));
    }
  }

  if (url.pathname === '/api/auth/google/me' && req.method === 'GET') {
    const denied = requireHostOrSystemApp(req, url);
    if (denied) return denied;
    try {
      return jsonResponse(await fetchMe());
    } catch (err) {
      return errorResponse(errMessage(err));
    }
  }

  if (url.pathname === '/api/auth/google/login' && req.method === 'POST') {
    const denied = requireHostOrSystemApp(req, url);
    if (denied) return denied;
    try {
      return jsonResponse(await beginLogin());
    } catch (err) {
      return errorResponse(errMessage(err), 400);
    }
  }

  if (url.pathname === '/api/auth/google/callback' && req.method === 'GET') {
    // Google reports a user-side refusal here rather than by not redirecting.
    const oauthError = url.searchParams.get('error');
    if (oauthError) {
      return callbackPage('Sign-in cancelled', `Google reported: ${oauthError}`, false);
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) {
      return callbackPage('Sign-in failed', 'The redirect was missing its code or state.', false);
    }

    try {
      const { email } = await completeLogin(code, state);
      return callbackPage(
        'Signed in',
        `You're signed in as ${email}. You can close this tab.`,
        true,
      );
    } catch (err) {
      return callbackPage('Sign-in failed', errMessage(err), false);
    }
  }

  if (url.pathname === '/api/auth/google/logout' && req.method === 'POST') {
    const denied = requireHostOrSystemApp(req, url);
    if (denied) return denied;
    await signOut();
    return jsonResponse({ signedIn: false });
  }

  return null;
}
