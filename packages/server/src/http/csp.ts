/**
 * The Content-Security-Policy app HTML is served under.
 *
 * `connect-src 'self'` is the whole policy: an app may talk to the origin it was
 * served from and nowhere else, so every external call has to go through the fetch
 * proxy, where the domain allowlist applies.
 *
 * Under app-origin isolation that one directive is too tight. The app document is
 * served from the app alias (`127.0.0.1`) while its baked-in SDKs address the
 * desktop origin (`localhost`) handed to them as `__yaar_api` — so `'self'` blocks
 * the app from reaching its own backend, `/api/fetch` included. Both loopback
 * aliases at the serving port are named, which keeps the policy correct whichever
 * side of the boundary the document was served from.
 *
 * Widening to the sibling alias grants no new reach: both names resolve to this
 * same loopback socket, and every route behind them still runs the iframe-token and
 * permission checks in `http/access.ts`.
 */

import { APP_ORIGIN_ISOLATION, APP_ORIGIN_HOST, DESKTOP_ORIGIN_HOST, getPort } from '../config.js';

const BASE = "connect-src 'self'";

/**
 * The port the browser addressed, taken from `Host` so a proxied dev server (vite
 * on 5173 in front of the API) names the port the document actually came from.
 * That header is client-controlled, so it is honored only when it names a loopback
 * host with a numeric port — anything else falls back to the configured port. The
 * widening therefore can never leave loopback, where both origins already live.
 */
function servingPort(req: Request): number {
  const match = req.headers.get('host')?.match(/^([a-zA-Z0-9.-]+):(\d{1,5})$/);
  if (match && (match[1] === DESKTOP_ORIGIN_HOST || match[1] === APP_ORIGIN_HOST)) {
    return Number(match[2]);
  }
  return getPort();
}

export function appHtmlCsp(req: Request): string {
  if (!APP_ORIGIN_ISOLATION) return BASE;
  const port = servingPort(req);
  return `${BASE} http://${DESKTOP_ORIGIN_HOST}:${port} http://${APP_ORIGIN_HOST}:${port}`;
}
