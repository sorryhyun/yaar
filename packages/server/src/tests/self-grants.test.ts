/**
 * An app is granted its own namespace without declaring it.
 *
 * `yaar://apps/self/{storage,db,agents}/` resolve against the token's own appId, so
 * they can only ever name the app asking. Making apps declare them bought no
 * confinement and cost a class of bug that only showed up at runtime: an app that
 * forgot `yaar://apps/self/db/` got a 403 from `appDb` for a database nobody else
 * can see. `SELF_GRANTS` (iframe-tokens.ts) adds all three at mint time.
 *
 * What must stay true is the other half: naming *another* app is still a declared
 * permission, and the sharper gates behind these URIs (persona ownership, the
 * `personas` manifest cap, `streams`) are untouched by the grant.
 */
import { describe, it, expect } from 'bun:test';
import { requirePermission, resolvePrincipal } from '../http/access.js';
import { generateAppIframeToken } from '../http/iframe-tokens.js';

/** Resolve the principal a `POST /api/verb` from this app's iframe would carry. */
function principalFor(token: string) {
  const req = new Request('http://localhost:8000/api/verb', {
    headers: { 'x-iframe-token': token },
  });
  const principal = resolvePrincipal(req, new URL(req.url));
  if (principal instanceof Response) throw new Error('principal was denied');
  return principal;
}

/** An app that declares nothing at all. */
async function bareApp(appId = 'notes') {
  return principalFor(await generateAppIframeToken(`win-${appId}`, 'sess-1', { appId }));
}

describe('self grants', () => {
  it('gives an app with no permissions its own storage, db and personas', async () => {
    const principal = await bareApp();
    for (const uri of [
      'yaar://apps/self/storage/notes.json',
      'yaar://apps/self/db/rooms',
      'yaar://apps/self/agents',
      'yaar://apps/self/agents/alice',
    ]) {
      expect(requirePermission(principal, uri, 'invoke')).toBeNull();
    }
  });

  it('grants the same resources spelled with the app’s real id', async () => {
    const principal = await bareApp();
    expect(requirePermission(principal, 'yaar://apps/notes/db/rooms', 'invoke')).toBeNull();
    // The flat spelling of the same file is canonicalized before matching.
    expect(requirePermission(principal, 'yaar://storage/apps/notes/x.json', 'read')).toBeNull();
  });

  it('does not reach another app’s namespace', async () => {
    const principal = await bareApp();
    for (const uri of [
      'yaar://apps/vault/storage/secrets.json',
      'yaar://apps/vault/db/keys',
      'yaar://apps/vault/agents',
    ]) {
      expect(requirePermission(principal, uri, 'read')?.status).toBe(403);
    }
  });

  it('grants nothing outside the app’s own namespace', async () => {
    const principal = await bareApp();
    expect(requirePermission(principal, 'yaar://storage/media/', 'read')?.status).toBe(403);
    expect(requirePermission(principal, 'yaar://config/domains', 'invoke')?.status).toBe(403);
    expect(requirePermission(principal, 'yaar://session/browser', 'invoke')?.status).toBe(403);
  });

  it('leaves a declared permission list intact rather than replacing it', async () => {
    const token = await generateAppIframeToken('win-memo', 'sess-1', {
      appId: 'memo',
      permissions: ['yaar://storage/'],
    });
    const principal = principalFor(token);
    expect(requirePermission(principal, 'yaar://storage/media/', 'read')).toBeNull();
    expect(requirePermission(principal, 'yaar://apps/self/db/notes', 'invoke')).toBeNull();
  });

  it('grants nothing to a non-app iframe — there is no "self" to resolve', async () => {
    const principal = principalFor(await generateAppIframeToken('win-plain', 'sess-1'));
    expect(requirePermission(principal, 'yaar://apps/self/db/rooms', 'invoke')?.status).toBe(403);
  });
});
