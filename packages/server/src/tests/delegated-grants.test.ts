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
} from '../features/window/delegated-grants.js';
import { requirePermission, resolvePrincipal, setWindowGrantResolver } from '../http/access.js';
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
