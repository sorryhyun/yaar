/**
 * The Content-Security-Policy app HTML is served under.
 *
 * `connect-src 'self'` is the whole policy: an app may talk to the origin it was
 * served from and nowhere else, so every external call has to go through the fetch
 * proxy, where the domain allowlist applies.
 *
 * Under app-origin isolation that one directive is too tight. The app document is
 * served from the *app* origin while its baked-in SDKs address the *desktop* origin
 * handed to them as `__yaar_api` — so `'self'` blocks the app from reaching its own
 * backend, `/api/fetch` included. Naming both sides of the boundary keeps the policy
 * correct whichever one the document came from.
 *
 * Widening to the other side of the boundary grants no new reach: it is the same
 * server, and every route behind either origin still runs the iframe-token and
 * permission checks in `http/access.ts`.
 *
 * `blob:` and `data:` are named because `'self'` does not cover them — CSP matches
 * those schemes only when they are listed literally, so `fetch(blobUrl)` was refused
 * inside every app. That broke window capture on any app that renders proxied images
 * from object URLs (the DC gallery fetches through `yaar://http` to get a Referer,
 * then paints from `URL.createObjectURL`): the capture script inlines each `<img>` by
 * fetching its `src`, the fetch was blocked, and every image landed in the screenshot
 * as a transparent placeholder — so OCR read a page with holes where the art was.
 *
 * Neither scheme is network reach. A `blob:` URL is only fetchable by the origin that
 * created it, and a `data:` URL is bytes the document already holds; both are content
 * the app can read anyway (`FileReader` over the source `Blob`, `atob` over the
 * base64). What the directive confines — which *hosts* an app may talk to — is
 * untouched.
 */

import { APP_ORIGIN_HOST, DESKTOP_ORIGIN_HOST, getPort } from '../config.js';
import { getOriginBoundary } from './origin-boundary.js';

const BASE = "connect-src 'self' blob: data:";

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
  const boundary = getOriginBoundary();
  switch (boundary.mode) {
    case 'off':
      return BASE;
    case 'loopback-alias': {
      const port = servingPort(req);
      return `${BASE} http://${DESKTOP_ORIGIN_HOST}:${port} http://${APP_ORIGIN_HOST}:${port}`;
    }
    case 'proxy-port':
      // Both origins are published addresses the server itself chose — no Host to
      // second-guess, and no dev proxy in front of a tunnel.
      return `${BASE} ${boundary.desktopOrigin} ${boundary.appOrigin}`;
  }
}
