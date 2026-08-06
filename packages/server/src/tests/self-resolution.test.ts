/**
 * One `self`, spelled once.
 *
 * `yaar://apps/self/…` is the dialect an app writes about itself in, and three
 * places had to expand it: the permission gate (both sides of the match), the
 * `POST /api/verb` dispatch, and — before *storing* the URI — `/api/verb/subscribe`,
 * since a subscription keyed by the `self` spelling never matches the real-id URI a
 * producer notifies with. All three carried their own copy of the rewrite, so a
 * change to the spelling was a three-site edit whose misses fail silently: a verb
 * that 403s on the app's own storage, or a subscription that simply never fires.
 *
 * `resolveSelf`/`namesSelf` (http/access.ts) are now the one copy. What must stay
 * true is that both doors agree — on the expansion *and* on the refusal when there
 * is no appId to expand against.
 */
import { describe, it, expect } from 'bun:test';
import { namesSelf, resolveSelf, storageUriFor, type Principal } from '../http/access.js';
import { handleVerbRoutes } from '../http/routes/verb.js';
import { generateIframeToken } from '../http/iframe-tokens.js';
import { subscriptionRegistry } from '../http/subscriptions.js';
import type { SessionId } from '../session/types.js';

const SESSION = 'sess-self-resolution' as SessionId;

/**
 * A token that declares `yaar://apps/self/` outright rather than relying on
 * `SELF_GRANTS`. With no appId those grants would be meaningless, and the point of
 * the appId-less rows below is to get *past* the permission gate and land on the
 * resolution refusal — which is the branch the two doors have to spell the same way.
 */
function tokenFor(appId?: string): string {
  return generateIframeToken(`win-${appId ?? 'plain'}`, SESSION, {
    appId,
    permissions: ['yaar://apps/self/'],
  });
}

async function post(path: string, token: string, body: Record<string, unknown>): Promise<Response> {
  const req = new Request(`http://localhost:8000${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-iframe-token': token },
    body: JSON.stringify(body),
  });
  const res = await handleVerbRoutes(req, new URL(req.url));
  if (!res) throw new Error(`route did not handle POST ${path}`);
  return res;
}

describe('resolveSelf / namesSelf', () => {
  it('expands both the bare authority and a sub-path', () => {
    expect(resolveSelf('yaar://apps/self', 'notes')).toBe('yaar://apps/notes');
    expect(resolveSelf('yaar://apps/self/storage/todo.json', 'notes')).toBe(
      'yaar://apps/notes/storage/todo.json',
    );
  });

  it('leaves a URI that names no self alone, and never matches a look-alike', () => {
    expect(resolveSelf('yaar://apps/selfie/x', 'notes')).toBe('yaar://apps/selfie/x');
    expect(namesSelf('yaar://apps/selfie/x')).toBe(false);
    expect(namesSelf('yaar://storage/self')).toBe(false);
  });

  it('leaves the URI unexpanded with no appId, which is what namesSelf reports', () => {
    const uri = 'yaar://apps/self/storage/todo.json';
    expect(resolveSelf(uri, undefined)).toBe(uri);
    expect(namesSelf(resolveSelf(uri, undefined))).toBe(true);
    expect(namesSelf(resolveSelf(uri, 'notes'))).toBe(false);
  });

  it('agrees with storageUriFor on the same literal segment', () => {
    // The path flavor: same `self`, different dialect. The two are separate
    // functions on purpose, so this pins the one thing they must share.
    const principal: Principal = {
      kind: 'app',
      appId: 'notes',
      sessionId: SESSION,
      windowId: 'win-notes',
      permissions: [],
      systemApp: false,
      bundles: [],
      streams: [],
      token: 'irrelevant',
    };
    expect(storageUriFor(principal, 'apps/self/todo.json')).toBe(
      'yaar://apps/notes/storage/todo.json',
    );
    expect(resolveSelf('yaar://apps/self/storage/todo.json', 'notes')).toBe(
      'yaar://apps/notes/storage/todo.json',
    );
  });
});

describe('both verb doors resolve self the same way', () => {
  it('subscribes under the real appId, not the self spelling', async () => {
    const res = await post('/api/verb/subscribe', tokenFor('notes'), {
      action: 'subscribe',
      uri: 'yaar://apps/self/storage/',
    });
    expect(res.status).toBe(200);
    const { subscriptionId } = (await res.json()) as { subscriptionId: string };

    // The URI a producer fires with is the real-id one. If the door had stored the
    // `self` spelling, this would find nothing and the app would never be told.
    const found = subscriptionRegistry.getSubscribers('yaar://apps/notes/storage/todo.json');
    expect(found.map((s) => s.id)).toContain(subscriptionId);

    subscriptionRegistry.unsubscribe(subscriptionId);
  });

  it('dispatches the real appId, not the self spelling', async () => {
    // `describe` bypasses the permission list, so what comes back is the handler's
    // own answer for the *resolved* URI — naming an app that is not installed.
    const res = await post('/api/verb', tokenFor('not-an-installed-app'), {
      verb: 'describe',
      uri: 'yaar://apps/self',
    });
    const body = (await res.json()) as { ok: boolean; error?: string; data?: unknown };
    const text = JSON.stringify(body);
    expect(text).toContain('not-an-installed-app');
    expect(text).not.toContain('apps/self');
  });

  it('refuses at both doors when the token names no app to expand against', async () => {
    const token = tokenFor(undefined);

    const main = await post('/api/verb', token, { verb: 'describe', uri: 'yaar://apps/self' });
    expect(main.status).toBe(403);
    expect(await main.text()).toContain('Cannot resolve');

    const sub = await post('/api/verb/subscribe', token, {
      action: 'subscribe',
      uri: 'yaar://apps/self/storage/',
    });
    expect(sub.status).toBe(403);
    expect(await sub.text()).toContain('Cannot resolve');
  });
});
