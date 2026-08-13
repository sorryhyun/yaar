/**
 * Delegated storage grants: a file an agent names *to* an app becomes readable by it.
 *
 * The hole: a monitor agent reads any `yaar://storage/…`; an app iframe is confined to
 * its app.json `permissions`. So the most ordinary instruction in the system — open this
 * app on this file — ended in `403 Not permitted: read yaar://storage/…` from inside the
 * app, on a path the agent had just handed it. See features/window/delegated-grants.ts.
 *
 * These tests pin the four narrowings that keep the fix from being an escalation: only a
 * caller that outranks the app delegates, only exact files, only `read`, and only until
 * the window closes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { OSAction } from '@yaar/shared';
import { WindowStateRegistry } from '../session/window-state.js';
import {
  collectDelegatableUris,
  grantsFromPayload,
  mayDelegateGrants,
  undelegatedUris,
} from '../features/window/delegated-grants.js';
import {
  requirePermission,
  resolvePrincipal,
  setUndelegatedUriResolver,
  setWindowGrantResolver,
} from '../http/access.js';
import { generateAppIframeToken } from '../http/iframe-tokens.js';
import { runWithAgentContext } from '../agents/agent-context.js';

const FILE = 'yaar://storage/files/report.md';
const SIBLING = 'yaar://storage/files/private.md';

function createAppWindow(reg: WindowStateRegistry, windowId: string, monitorId = '0') {
  reg.handleAction(
    {
      type: 'window.create',
      windowId,
      title: windowId,
      bounds: { x: 0, y: 0, w: 500, h: 400 },
      content: { renderer: 'iframe', data: '/api/apps/notes' },
      appId: 'notes',
    } as unknown as OSAction,
    monitorId,
  );
}

/** The principal an app iframe presents on `POST /api/verb`, gate and all. */
async function appPrincipal(windowId: string, monitorId = '0') {
  const token = await generateAppIframeToken(windowId, 'sess-1', {
    appId: 'notes',
    permissions: [], // declares nothing beyond the automatic self-grants
    monitorId,
  });
  const req = new Request('http://127.0.0.1:8000/api/verb', {
    headers: { 'x-iframe-token': token },
  });
  const principal = resolvePrincipal(req, new URL(req.url));
  if (principal instanceof Response) throw new Error('principal was denied');
  return principal;
}

describe('collecting delegatable URIs', () => {
  it('takes a parameter whose whole value is the URI, spaces and all', () => {
    const found = collectDelegatableUris({ path: 'yaar://storage/files/my report.md' });
    expect([...found]).toEqual(['yaar://storage/files/my report.md']);
  });

  it('finds one embedded in a launch URL’s query string', () => {
    const found = collectDelegatableUris('yaar://apps/notes?file=yaar://storage/files/report.md');
    expect([...found]).toEqual([FILE]);
  });

  it('reaches into nested params and both storage spellings', () => {
    const found = collectDelegatableUris({
      open: [{ src: FILE }, { src: 'yaar://apps/anima/storage/generated/dragon.png' }],
    });
    expect([...found].sort()).toEqual(['yaar://apps/anima/storage/generated/dragon.png', FILE]);
  });

  it('refuses a directory — a prefix grant is a foothold, not a file', () => {
    expect([...collectDelegatableUris({ dir: 'yaar://storage/files/' })]).toEqual([]);
  });

  it('refuses a traversing path, which names no resource', () => {
    expect([...collectDelegatableUris({ p: 'yaar://storage/files/../../etc/keys' })]).toEqual([]);
  });

  it('ignores everything that is not storage', () => {
    const found = collectDelegatableUris({
      a: 'yaar://config/domains',
      b: 'yaar://apps/notes',
      c: 'https://example.test/x.md',
    });
    expect([...found]).toEqual([]);
  });
});

describe('who may delegate', () => {
  it('a monitor agent may — it is unconfined and naming the file on purpose', () => {
    runWithAgentContext({ agentId: 'monitor-0', role: 'monitor' }, () => {
      expect(mayDelegateGrants()).toBe(true);
      expect(grantsFromPayload({ path: FILE })).toEqual([{ uri: FILE, verbs: ['read'] }]);
    });
  });

  it('an app agent may not — naming a path is not the same as having been given one', () => {
    runWithAgentContext({ agentId: 'app-notes', role: 'app' }, () => {
      expect(mayDelegateGrants()).toBe(false);
      expect(grantsFromPayload({ path: FILE })).toEqual([]);
    });
  });

  it('an app iframe may not, even driving another window through yaar://windows/', () => {
    // The iframe verb route sets appId and no role at all, which is why the gate checks
    // both — this is the self-grant `invoke('yaar://windows/x', {action:'app_command'})`
    // would otherwise be for any app declaring `yaar://windows/`.
    runWithAgentContext({ agentId: 'iframe:devtools', appId: 'devtools' }, () => {
      expect(mayDelegateGrants()).toBe(false);
      expect(grantsFromPayload({ path: FILE })).toEqual([]);
    });
  });
});

describe('the grant at the access gate', () => {
  let reg: WindowStateRegistry;

  beforeEach(() => {
    reg = new WindowStateRegistry();
    createAppWindow(reg, 'notes');
    setWindowGrantResolver((_sessionId, windowId, monitorId) =>
      reg.getWindowGrants(windowId, monitorId),
    );
  });

  afterEach(() => setWindowGrantResolver(() => []));

  it('denies the file before anything is delegated — the bug this guards', async () => {
    const principal = await appPrincipal('notes');
    expect(requirePermission(principal, FILE, 'read')?.status).toBe(403);
  });

  it('allows it once an agent has named it to that window', async () => {
    reg.grantWindowAccess('notes', [{ uri: FILE, verbs: ['read'] }], '0');
    const principal = await appPrincipal('notes');
    expect(requirePermission(principal, FILE, 'read')).toBeNull();
  });

  it('grants that file only, and only for reading', async () => {
    reg.grantWindowAccess('notes', [{ uri: FILE, verbs: ['read'] }], '0');
    const principal = await appPrincipal('notes');
    expect(requirePermission(principal, SIBLING, 'read')?.status).toBe(403);
    expect(requirePermission(principal, FILE, 'invoke')?.status).toBe(403);
    expect(requirePermission(principal, FILE, 'delete')?.status).toBe(403);
  });

  it('does not leak to another window of the same app', async () => {
    reg.grantWindowAccess('notes', [{ uri: FILE, verbs: ['read'] }], '0');
    createAppWindow(reg, 'notes-2');
    const principal = await appPrincipal('notes-2');
    expect(requirePermission(principal, FILE, 'read')?.status).toBe(403);
  });

  it('survives the token being re-minted, as a remount does', async () => {
    reg.grantWindowAccess('notes', [{ uri: FILE, verbs: ['read'] }], '0');
    // A fresh token for the same window: the grant lives on the window, not the token,
    // which is the whole reason it is stored there.
    const principal = await appPrincipal('notes');
    expect(requirePermission(principal, FILE, 'read')).toBeNull();
  });

  it('is revoked when the window closes', async () => {
    reg.grantWindowAccess('notes', [{ uri: FILE, verbs: ['read'] }], '0');
    reg.handleAction({ type: 'window.close', windowId: 'notes' } as OSAction, '0');
    const principal = await appPrincipal('notes');
    expect(requirePermission(principal, FILE, 'read')?.status).toBe(403);
  });

  it('accumulates rather than replaces across calls, and does not duplicate', async () => {
    reg.grantWindowAccess('notes', [{ uri: FILE, verbs: ['read'] }], '0');
    reg.grantWindowAccess('notes', [{ uri: FILE, verbs: ['read'] }], '0');
    reg.grantWindowAccess('notes', [{ uri: SIBLING, verbs: ['read'] }], '0');
    expect(reg.getWindowGrants('notes', '0')).toEqual([
      { uri: FILE, verbs: ['read'] },
      { uri: SIBLING, verbs: ['read'] },
    ]);
    const principal = await appPrincipal('notes');
    expect(requirePermission(principal, SIBLING, 'read')).toBeNull();
  });

  it('finds a grant recorded under the raw id before the window was registered', async () => {
    const fresh = new WindowStateRegistry();
    setWindowGrantResolver((_s, windowId, monitorId) => fresh.getWindowGrants(windowId, monitorId));
    // create.ts records before the emit — at that moment there is no window to resolve.
    fresh.grantWindowAccess('notes', [{ uri: FILE, verbs: ['read'] }], '0');
    createAppWindow(fresh, 'notes');
    const principal = await appPrincipal('notes');
    expect(requirePermission(principal, FILE, 'read')).toBeNull();
  });
});

/**
 * The refusal narrowing 1 produces, told apart from an ordinary one.
 *
 * Both are 403s and both were the same sentence, so an agent could not distinguish "this
 * app was never granted the path" from "the caller that named it to you is an app-role
 * principal and cannot delegate" — the second being what devtools' `previewCommand` relay
 * hits. It cost a real audit two round trips and nearly recorded a correct permission
 * removal as a regression. The rule is unchanged here; only the sentence is.
 */
describe('telling the two 403s apart', () => {
  let reg: WindowStateRegistry;

  beforeEach(() => {
    reg = new WindowStateRegistry();
    createAppWindow(reg, 'notes');
    setWindowGrantResolver((_s, windowId, monitorId) => reg.getWindowGrants(windowId, monitorId));
    setUndelegatedUriResolver((_s, windowId, uri, monitorId) =>
      reg.wasUndelegated(uri, windowId, monitorId),
    );
  });

  afterEach(() => {
    setWindowGrantResolver(() => []);
    setUndelegatedUriResolver(() => false);
  });

  it('an app-role caller’s payload records what it could not hand over', () => {
    runWithAgentContext({ agentId: 'app-devtools', role: 'app' }, () => {
      expect(grantsFromPayload({ uri: FILE })).toEqual([]);
      expect(undelegatedUris({ uri: FILE })).toEqual([FILE]);
    });
  });

  it('a caller that may delegate records nothing — it granted the file instead', () => {
    runWithAgentContext({ agentId: 'monitor-0', role: 'monitor' }, () => {
      expect(undelegatedUris({ uri: FILE })).toEqual([]);
    });
  });

  it('names the relay in the refusal, and only for the path that was named', async () => {
    reg.noteUndelegatedUris('notes', [FILE], '0');
    const principal = await appPrincipal('notes');

    const relayed = requirePermission(principal, FILE, 'read');
    expect(relayed?.status).toBe(403);
    expect(await relayed!.text()).toMatch(/cannot delegate grants/);

    // The ordinary refusal is untouched: nothing named this one, so nothing is claimed.
    const ordinary = requirePermission(principal, SIBLING, 'read');
    expect(ordinary?.status).toBe(403);
    expect(await ordinary!.text()).not.toMatch(/cannot delegate/);
  });

  it('matches across dialects, since the app may ask in the other one', async () => {
    // The caller wrote the flat spelling; the app asks with the namespaced one.
    runWithAgentContext({ agentId: 'app-devtools', role: 'app' }, () => {
      reg.noteUndelegatedUris(
        'notes',
        undelegatedUris({ p: 'yaar://storage/apps/anima/x.png' }),
        '0',
      );
    });
    const principal = await appPrincipal('notes');
    const denied = requirePermission(principal, 'yaar://apps/anima/storage/x.png', 'read');
    expect(await denied!.text()).toMatch(/cannot delegate grants/);
  });

  it('says nothing extra once the file is actually granted', async () => {
    reg.noteUndelegatedUris('notes', [FILE], '0');
    reg.grantWindowAccess('notes', [{ uri: FILE, verbs: ['read'] }], '0');
    const principal = await appPrincipal('notes');
    expect(requirePermission(principal, FILE, 'read')).toBeNull();
  });

  it('is dropped with the window, like the grants', async () => {
    reg.noteUndelegatedUris('notes', [FILE], '0');
    reg.handleAction({ type: 'window.close', windowId: 'notes' } as OSAction, '0');
    const principal = await appPrincipal('notes');
    const denied = requirePermission(principal, FILE, 'read');
    expect(await denied!.text()).not.toMatch(/cannot delegate/);
  });
});
