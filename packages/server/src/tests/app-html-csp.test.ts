/**
 * The CSP app HTML is served under, across the origin boundary.
 *
 * The bug this covers: with app-origin isolation on, an installed app's document is
 * served from `127.0.0.1` while its SDKs address the desktop origin handed to them
 * as `__yaar_api`. Under a flat `connect-src 'self'` the browser refused every one
 * of those calls — including the fetch proxy's own POST to `/api/fetch`, which is
 * the only way an app reaches anything external at all.
 */
import { describe, it, expect } from 'bun:test';
import { appHtmlCsp } from '../http/csp.js';
import { APP_ORIGIN_ISOLATION, getPort } from '../config.js';

const csp = (host?: string) =>
  appHtmlCsp(new Request('http://localhost:8000/x.html', { headers: host ? { host } : {} }));

/** One directive's source list, or undefined when the policy omits the directive. */
const directiveOf = (policy: string, name: string): string | undefined =>
  policy
    .split(';')
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(name + ' '))
    ?.slice(name.length)
    .trim();

describe('appHtmlCsp', () => {
  it('always confines an app to the origin that served it', () => {
    expect(csp('localhost:8000')).toStartWith("connect-src 'self'");
  });

  it('never names an origin off loopback, whatever Host claims', () => {
    // Host is client-controlled: honored blindly it would let a request widen its own
    // page's CSP to an attacker's origin.
    const policy = csp('evil.example.com:8000');
    expect(policy).not.toContain('evil.example.com');
    if (APP_ORIGIN_ISOLATION) {
      expect(policy).toContain(`http://localhost:${getPort()}`);
    }
  });

  it.if(APP_ORIGIN_ISOLATION)('lets an isolated app reach the desktop origin', () => {
    // The app document is on 127.0.0.1 ('self'); its backend is localhost.
    const policy = csp('127.0.0.1:8000');
    expect(policy).toContain('http://localhost:8000');
    expect(policy).toContain('http://127.0.0.1:8000');
  });

  it.if(APP_ORIGIN_ISOLATION)('names the port the browser addressed, not the API port', () => {
    // A dev server in front of the API (vite on 5173) serves the document on its own
    // port; a policy naming the API's port would block every call the page makes.
    expect(csp('localhost:5173')).toContain('http://127.0.0.1:5173');
  });

  it.if(!APP_ORIGIN_ISOLATION)('names no host beyond self when isolation is off', () => {
    for (const d of ['connect-src', 'script-src', 'worker-src']) {
      const directive = directiveOf(csp('localhost:8000'), d);
      expect(directive).toBeTruthy();
      expect(directive).not.toMatch(/https?:\/\//);
    }
  });

  it('lets an app fetch its own object URLs', () => {
    // `'self'` does not cover blob:/data: — unlisted, `fetch(URL.createObjectURL(b))`
    // is refused, which silently blanked every proxied image out of a window capture.
    const connect = directiveOf(csp('localhost:8000'), 'connect-src')!;
    expect(connect).toContain('blob:');
    expect(connect).toContain('data:');
  });

  // `connect-src` governs fetch/XHR/WebSocket/sendBeacon and nothing else. Without the
  // directives below, an app reached any host it liked with a `<script src>` — walking
  // straight around the fetch proxy and its domain allowlist.
  it('confines script loading to the same origin', () => {
    const script = directiveOf(csp('localhost:8000'), 'script-src');
    expect(script).toBeTruthy();
    expect(script).toContain("'self'");
  });

  it("keeps the app's own code runnable", () => {
    // Not conservatism: the compiled wrapper emits four inline <script> tags, and the
    // yaar-ml shim reaches ORT through `new Function`. Both relax only *how* an app runs
    // code it already ships — the host list is what this directive is actually for.
    const script = directiveOf(csp('localhost:8000'), 'script-src')!;
    expect(script).toContain("'unsafe-inline'");
    expect(script).toContain("'unsafe-eval'");
  });

  it("names worker-src so workers don't fall through to an unset default-src", () => {
    // onnxruntime spawns `ort-wasm-proxy-worker` from its own /api/ml-runtime/ URL, and a
    // bundled library shipping a worker has only a blob: URL to spawn from.
    const worker = directiveOf(csp('localhost:8000'), 'worker-src')!;
    expect(worker).toContain("'self'");
    expect(worker).toContain('blob:');
  });

  it('seals the channels no app has a use for', () => {
    // Each is an exfil path `connect-src` never covered: a cross-origin form POST carries
    // a body out, and a <base> rewrites every relative URL on the page.
    const policy = csp('localhost:8000');
    for (const name of ['object-src', 'base-uri', 'form-action']) {
      expect(directiveOf(policy, name)).toBe("'none'");
    }
  });

  it.if(APP_ORIGIN_ISOLATION)(
    'widens every host list to the boundary, not just connect-src',
    () => {
      // A directive that disagreed with connect-src would only produce a confusing break:
      // the other origin is the same server, behind the same access checks.
      const policy = csp('127.0.0.1:8000');
      for (const name of ['connect-src', 'script-src', 'worker-src']) {
        expect(directiveOf(policy, name)).toContain(`http://localhost:${getPort()}`);
      }
    },
  );
});
