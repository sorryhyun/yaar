/**
 * An iframe token is its own credential at the remote-auth gate.
 *
 * This is what makes app-origin isolation possible over a remote transport. An app's
 * SDK calls never carried the remote token in a header — they only passed the gate
 * because `extractToken` reads it out of `Referer`, and that worked solely because
 * apps were *same-origin* with the desktop. Put an app on its own origin (two Tailscale
 * Serve ports) and the default referrer policy trims `Referer` to a bare origin: the
 * token in it is gone, and every call an isolated app makes would 401.
 *
 * So the gate accepts the iframe token itself — a narrower credential than the remote
 * token: server-minted, bound to one window and app, expiring, and still subject to the
 * whole permission gate in `access.ts` once past here.
 *
 * `hasValidIframeToken` rather than `checkHttpAuth` because `IS_REMOTE` is fixed at
 * module load; the predicate is the honest unit under test.
 */
import { describe, it, expect } from 'bun:test';
import { hasValidIframeToken } from '../http/auth.js';
import { generateAppIframeToken } from '../http/iframe-tokens.js';

function present(headers: Record<string, string> = {}, query = '') {
  const req = new Request(`http://127.0.0.1:8000/api/verb${query}`, { headers });
  return hasValidIframeToken(req, new URL(req.url));
}

describe('hasValidIframeToken', () => {
  it('accepts the header the app SDK sends', async () => {
    const token = await generateAppIframeToken('win-1', 'sess-1', { appId: 'notes' });
    expect(present({ 'x-iframe-token': token })).toBe(true);
  });

  it('accepts the query parameter a header-less subresource rides on', async () => {
    // <img src>, EventSource: no way to set a header, so `access.ts` reads
    // `__yaar_token` — and the auth gate has to honor the same spelling or the asset
    // 401s before anything gets to look at it.
    const token = await generateAppIframeToken('win-1', 'sess-1', { appId: 'notes' });
    expect(present({}, `?__yaar_token=${encodeURIComponent(token)}`)).toBe(true);
  });

  it('refuses an anonymous caller', () => {
    expect(present()).toBe(false);
  });

  it('refuses a token that does not check out', () => {
    // A forged or expired token is not a weaker identity, it is no identity — the same
    // rule access.ts applies. Falling through to "treat as host" is the bug this
    // codebase already fixed once.
    expect(present({ 'x-iframe-token': 'not-a-real-token' })).toBe(false);
  });
});
