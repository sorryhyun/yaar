/**
 * yaar://system/ytdlp is bundle-granted: declaring `yaar-media` in app.json `bundles`
 * is the whole grant, exactly like the other gated SDKs (`yaar-dev`, `yaar-web`,
 * `yaar-ml`), and a `permissions` entry naming the URI grants nothing.
 *
 * The rule exists to keep app manifests out of the system namespace entirely — no app
 * token needs to carry a `yaar://system/*` grant, so `system/` never becomes a
 * namespace apps learn to ask for (and users learn to click through). See
 * `namesYtdlpDoor` in http/access.ts.
 *
 * What must stay true around it: `describe` remains metadata-only for every caller,
 * and the gate is scoped to the ytdlp door — the bundle buys nothing anywhere else.
 */
import { describe, it, expect } from 'bun:test';
import { requirePermission, resolvePrincipal } from '../http/access.js';
import { generateIframeToken } from '../http/iframe-tokens.js';

const URI = 'yaar://system/ytdlp';

/** Resolve the principal a `POST /api/verb` from this app's iframe would carry. */
function principalFor(token: string) {
  const req = new Request('http://localhost:8000/api/verb', {
    headers: { 'x-iframe-token': token },
  });
  const principal = resolvePrincipal(req, new URL(req.url));
  if (principal instanceof Response) throw new Error('principal was denied');
  return principal;
}

describe('ytdlp bundle gate', () => {
  it('admits an app declaring the yaar-media bundle, with no permissions at all', () => {
    const principal = principalFor(
      generateIframeToken('win-media', 'sess-1', { appId: 'media-app', bundles: ['yaar-media'] }),
    );
    expect(requirePermission(principal, URI, 'invoke')).toBeNull();
    expect(requirePermission(principal, URI, 'read')).toBeNull();
  });

  it('refuses an app that declares the URI as a permission but not the bundle', () => {
    // The permission list is not consulted for this URI — a manifest entry naming it
    // is dead weight, not a second route to the capability.
    const principal = principalFor(
      generateIframeToken('win-grabby', 'sess-1', { appId: 'grabby', permissions: [URI] }),
    );
    expect(requirePermission(principal, URI, 'invoke')?.status).toBe(403);
    expect(requirePermission(principal, URI, 'read')?.status).toBe(403);
  });

  it('keeps describe metadata-only and refuses the rest for a bare app', () => {
    const principal = principalFor(
      generateIframeToken('win-bare', 'sess-1', { appId: 'bare-app' }),
    );
    expect(requirePermission(principal, URI, 'describe')).toBeNull();
    expect(requirePermission(principal, URI, 'invoke')?.status).toBe(403);
  });

  it('grants nothing beyond the ytdlp door', () => {
    // The bundle is a grant for one URI, not a system-namespace key.
    const principal = principalFor(
      generateIframeToken('win-scope', 'sess-1', { appId: 'media-app', bundles: ['yaar-media'] }),
    );
    expect(requirePermission(principal, 'yaar://system/update', 'invoke')?.status).toBe(403);
    expect(requirePermission(principal, 'yaar://storage/files/x.txt', 'read')?.status).toBe(403);
  });
});
