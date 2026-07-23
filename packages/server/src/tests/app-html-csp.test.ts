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
    expect(csp('localhost:8000')).toBe("connect-src 'self' blob: data:");
  });

  it('lets an app fetch its own object URLs', () => {
    // `'self'` does not cover blob:/data: — unlisted, `fetch(URL.createObjectURL(b))`
    // is refused, which silently blanked every proxied image out of a window capture.
    expect(csp('localhost:8000')).toContain('blob:');
    expect(csp('localhost:8000')).toContain('data:');
  });
});
