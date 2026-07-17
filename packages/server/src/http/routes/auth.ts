/**
 * Google auth routes — marketplace publisher identity.
 *
 * GET  /api/auth/google/status    — { configured, signedIn, email, pending }
 * POST /api/auth/google/login     — open the browser at Google's consent screen
 * GET  /api/auth/google/callback  — Google's redirect target (browser-facing HTML)
 * POST /api/auth/google/logout    — forget the local session
 */

import {
  beginLogin,
  completeLogin,
  getAuthStatus,
  signOut,
} from '../../features/market/google-auth.js';
import { jsonResponse, errorResponse, type EndpointMeta } from '../utils.js';
import { errMessage } from '../../lib/errors.js';

/**
 * Empty on purpose — this is the desktop's identity, not an app resource.
 *
 * An app that could POST /api/auth/google/login could pop a consent screen at a
 * user who never asked for one, and one that could read the callback would hold
 * the publisher credential for every app on the machine. Off the iframe allowlist
 * entirely, so `server.ts` refuses any caller bearing an iframe token.
 */
export const PUBLIC_ENDPOINTS: EndpointMeta[] = [];

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
    try {
      return jsonResponse(await getAuthStatus());
    } catch (err) {
      return errorResponse(errMessage(err));
    }
  }

  if (url.pathname === '/api/auth/google/login' && req.method === 'POST') {
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
    await signOut();
    return jsonResponse({ signedIn: false });
  }

  return null;
}
