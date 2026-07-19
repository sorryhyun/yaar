/**
 * Integration tests: the HTTP access chokepoint (Slice 2 — F-19, F-20, F-21).
 *
 * These are the acceptance criteria, as tests:
 *   - an app iframe with no declared permissions cannot read another app's storage
 *   - it cannot flip `allowAllDomains`
 *   - it cannot read another session's transcript
 *   - an app agent cannot obtain `session-principal` by setting a header
 *   - a gated SDK's HTTP door is shut unless app.json declared the bundle
 *
 * Remote-mode auth (F-20) is exercised in remote-auth.test.ts, which has to set
 * REMOTE=1 before config.ts is imported.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import {
  isUriAllowed,
  requireBundle,
  requireHost,
  requirePermission,
  resolvePrincipal,
  storageUriFor,
  type Principal,
} from '@yaar/server/http/access';
import { generateIframeToken } from '@yaar/server/http/iframe-tokens';
import { getAgentToken, resolveAgentToken, revokeAgentToken } from '@yaar/server/mcp/agent-tokens';
import { makeRequest } from '../helpers/fetch-harness.js';

const HOST: Principal = { kind: 'host' };

/** A token for an app carrying exactly the storage self-grant every app gets. */
function appToken(appId: string, extra: Partial<Parameters<typeof generateIframeToken>[2]> = {}) {
  return generateIframeToken(`win-${appId}`, 'ses-test', {
    appId,
    permissions: ['yaar://apps/self/storage/'],
    ...extra,
  });
}

// ── storageUriFor: the HTTP path → URI mapping the whole gate rests on ──────

describe('storageUriFor', () => {
  it('maps an app-scoped path to the app-scoped URI, not the flat storage one', () => {
    // These name the same file on disk. Only the app-scoped spelling is the one an
    // app holds a permission for — get this wrong and every app loses its own storage
    // (or gains every other app's).
    expect(storageUriFor(HOST, 'apps/notes/todo.json')).toBe('yaar://apps/notes/storage/todo.json');
  });

  it('resolves apps/self against the calling app', () => {
    const principal = resolvePrincipal(
      new Request('http://x/api/storage/apps/self/todo.json', {
        headers: { 'x-iframe-token': appToken('notes') },
      }),
      new URL('http://x/api/storage/apps/self/todo.json'),
    ) as Principal;
    expect(storageUriFor(principal, 'apps/self/todo.json')).toBe(
      'yaar://apps/notes/storage/todo.json',
    );
  });

  it('leaves a non-app path in the flat storage namespace', () => {
    expect(storageUriFor(HOST, 'documents/paper.pdf')).toBe('yaar://storage/documents/paper.pdf');
  });

  it('refuses traversal that would escape the app namespace', () => {
    // apps/notes/../evil/secrets.json resolves to another app's storage while looking
    // like it names this app's own.
    const result = storageUriFor(HOST, 'apps/notes/../evil/secrets.json');
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });
});

// ── The permission gate ────────────────────────────────────────────────────

describe('requirePermission', () => {
  const notes: Principal = {
    kind: 'app',
    appId: 'notes',
    sessionId: 'ses-test',
    windowId: 'win-1',
    permissions: ['yaar://apps/self/storage/'],
    systemApp: false,
    bundles: [],
    streams: [],
    token: 't',
  };

  it('lets an app read its own storage', () => {
    expect(requirePermission(notes, 'yaar://apps/notes/storage/todo.json', 'read')).toBeNull();
  });

  it("refuses an app another app's storage", () => {
    const denied = requirePermission(notes, 'yaar://apps/vault/storage/secrets.json', 'read');
    expect(denied?.status).toBe(403);
  });

  it('refuses yaar://session/* to a non-system app even if it declares it', () => {
    // The self-grant is the point: a marketplace app cannot vote itself into the
    // session principal's namespace by listing it in app.json.
    const selfGranted: Principal = { ...notes, permissions: ['yaar://session/'] };
    expect(requirePermission(selfGranted, 'yaar://session/browser', 'invoke')?.status).toBe(403);
  });

  it('admits a bundled system app to yaar://session/*', () => {
    const system: Principal = {
      ...notes,
      systemApp: true,
      permissions: ['yaar://session/'],
    };
    expect(requirePermission(system, 'yaar://session/browser', 'invoke')).toBeNull();
  });

  it('does not confine the host', () => {
    expect(requirePermission(HOST, 'yaar://apps/vault/storage/secrets.json', 'read')).toBeNull();
  });

  it('honours per-verb restrictions', () => {
    const readOnly: Principal = {
      ...notes,
      permissions: [{ uri: 'yaar://storage/', verbs: ['read'] }],
    };
    expect(requirePermission(readOnly, 'yaar://storage/x.txt', 'read')).toBeNull();
    expect(requirePermission(readOnly, 'yaar://storage/x.txt', 'delete')?.status).toBe(403);
  });

  // ── The flat spelling of app storage ──
  //
  // `yaar://storage/apps/{id}/…` names the same file as `yaar://apps/{id}/storage/…`.
  // Permissions are written against the second, so the first is canonicalized before
  // matching — otherwise `yaar://storage/` is prefix-matched straight onto every
  // other app's storage, which thirteen bundled apps declare.

  const broadStorage: Principal = { ...notes, permissions: ['yaar://storage/'] };

  it("refuses another app's storage spelled through the flat tree", () => {
    const denied = requirePermission(
      broadStorage,
      'yaar://storage/apps/vault/credentials.json',
      'read',
    );
    expect(denied?.status).toBe(403);
  });

  it('still admits the flat tree proper', () => {
    expect(requirePermission(broadStorage, 'yaar://storage/media/logo.png', 'read')).toBeNull();
    // "apps" itself is a directory in the flat tree, not an app's storage.
    expect(requirePermission(broadStorage, 'yaar://storage/apps', 'list')).toBeNull();
  });

  it('lets an app reach its own storage through the flat spelling', () => {
    expect(requirePermission(notes, 'yaar://storage/apps/notes/todo.json', 'read')).toBeNull();
    expect(requirePermission(notes, 'yaar://storage/apps/self/todo.json', 'read')).toBeNull();
  });

  it('canonicalizes the grant side too', () => {
    const flatGrant: Principal = { ...notes, permissions: ['yaar://storage/apps/vault/'] };
    // Either spelling of the same explicit grant matches either spelling of the URI.
    expect(requirePermission(flatGrant, 'yaar://apps/vault/storage/x.json', 'read')).toBeNull();
    expect(requirePermission(flatGrant, 'yaar://storage/apps/vault/x.json', 'read')).toBeNull();
    expect(requirePermission(flatGrant, 'yaar://storage/apps/other/x.json', 'read')?.status).toBe(
      403,
    );
  });

  it('refuses a traversing storage URI outright', () => {
    const denied = requirePermission(
      broadStorage,
      'yaar://storage/apps/notes/../vault/credentials.json',
      'read',
    );
    expect(denied?.status).toBe(403);
  });

  it('does not let a prefix permission match a sibling by string prefix', () => {
    // "yaar://storage/photos/" must not admit "yaar://storage/photos-private/x"
    expect(
      isUriAllowed('yaar://storage/photos-private/x', 'read', ['yaar://storage/photos/']),
    ).toBe(false);
  });
});

describe('requireHost / requireBundle', () => {
  const app: Principal = {
    kind: 'app',
    appId: 'notes',
    sessionId: 'ses-test',
    windowId: 'win-1',
    permissions: [],
    systemApp: false,
    bundles: ['yaar-web'],
    streams: [],
    token: 't',
  };

  it('keeps apps out of host-only routes', () => {
    expect(requireHost(app)?.status).toBe(403);
    expect(requireHost(HOST)).toBeNull();
  });

  it('admits a declared bundle and refuses an undeclared one', () => {
    expect(requireBundle(app, 'yaar-web')).toBeNull();
    expect(requireBundle(app, 'yaar-dev')?.status).toBe(403);
  });
});

// ── The copy primitive's second gate ───────────────────────────────────────
//
// `invoke { action: 'copy', from }` reads one URI and writes another. The gate on
// the request's own `uri` covers only the write, so the source needs its own `read`
// check — otherwise an app permitted to write its own storage can name any source
// and pull the bytes in, which is a read grant over the whole tree spelled as a
// write.

describe('POST /api/verb — copy checks its source', () => {
  let token: string;
  beforeAll(() => {
    token = appToken('notes');
  });

  const copy = (from: unknown) =>
    makeRequest('/api/verb', {
      method: 'POST',
      headers: { 'x-iframe-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({
        verb: 'invoke',
        uri: 'yaar://apps/self/storage/pulled.png',
        payload: { action: 'copy', from },
      }),
    });

  it('refuses a source the app could not have read directly', async () => {
    expect((await copy('yaar://apps/vault/storage/credentials.json')).status).toBe(403);
    // ...including through the flat spelling of the same file.
    expect((await copy('yaar://storage/apps/vault/credentials.json')).status).toBe(403);
  });

  it('admits a source the app may read', async () => {
    // Its own storage. The file does not exist, so the handler will report that —
    // what matters here is that the request got past the gate.
    const res = await copy('yaar://apps/self/storage/original.png');
    expect(res.status).not.toBe(403);
  });

  it('rejects a copy with no source', async () => {
    expect((await copy(undefined)).status).toBe(400);
  });
});

// ── resolvePrincipal ───────────────────────────────────────────────────────

describe('resolvePrincipal', () => {
  it('treats a request with no token as the host', () => {
    const p = resolvePrincipal(
      new Request('http://x/api/storage/a'),
      new URL('http://x/api/storage/a'),
    );
    expect((p as Principal).kind).toBe('host');
  });

  it('refuses an invalid token rather than promoting it to host', () => {
    // This was the bug: an expired or bogus token fell through to "treat as host",
    // so a token that stopped checking out gained full access instead of losing it.
    const p = resolvePrincipal(
      new Request('http://x/api/storage/a', { headers: { 'x-iframe-token': 'not-a-real-token' } }),
      new URL('http://x/api/storage/a'),
    );
    expect(p).toBeInstanceOf(Response);
    expect((p as Response).status).toBe(403);
  });

  it('accepts the token as a query param, for subresources that cannot set headers', () => {
    const token = appToken('browser');
    const url = new URL(`http://x/api/browser/b1/screenshot?__yaar_token=${token}`);
    const p = resolvePrincipal(new Request(url.toString()), url) as Principal;
    expect(p.kind).toBe('app');
    expect(p.kind === 'app' && p.appId).toBe('browser');
  });
});

// ── Routes: the acceptance criteria, end to end ────────────────────────────

describe('an app iframe cannot reach past its own permissions', () => {
  let token: string;
  beforeAll(() => {
    token = appToken('notes');
  });

  it("cannot read another app's storage", async () => {
    const res = await makeRequest('/api/storage/apps/vault/secrets.json', {
      headers: { 'X-Iframe-Token': token },
    });
    expect(res.status).toBe(403);
  });

  it("cannot write another app's storage", async () => {
    const res = await makeRequest('/api/storage/apps/vault/secrets.json', {
      method: 'POST',
      headers: { 'X-Iframe-Token': token },
      body: 'pwned',
    });
    expect(res.status).toBe(403);
  });

  it('cannot flip allowAllDomains', async () => {
    const res = await makeRequest('/api/domains', {
      method: 'PATCH',
      headers: { 'X-Iframe-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowAllDomains: true }),
    });
    expect(res.status).toBe(403);
  });

  it('cannot read a session transcript', async () => {
    const res = await makeRequest('/api/sessions/ses-someone-else/transcript', {
      headers: { 'X-Iframe-Token': token },
    });
    expect(res.status).toBe(403);
  });

  it('cannot mint itself a token for another app', async () => {
    const res = await makeRequest('/api/iframe-token', {
      method: 'POST',
      headers: { 'X-Iframe-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ windowId: 'w', sessionId: 's', appId: 'process-explorer' }),
    });
    expect(res.status).toBe(403);
  });

  it('cannot change settings', async () => {
    const res = await makeRequest('/api/settings', {
      method: 'PATCH',
      headers: { 'X-Iframe-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'codex' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('gated SDK doors check the bundle declaration, not just the compiler', () => {
  it('refuses /api/dev/* to an app that did not declare yaar-dev', async () => {
    const res = await makeRequest('/api/dev/compile', {
      method: 'POST',
      headers: { 'X-Iframe-Token': appToken('notes'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  it('refuses /api/browser to an app that did not declare yaar-web', async () => {
    const res = await makeRequest('/api/browser', {
      method: 'POST',
      headers: { 'X-Iframe-Token': appToken('notes'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'open', url: 'http://example.com' }),
    });
    expect(res.status).toBe(403);
  });

  it('refuses a browser screenshot to an app that did not declare yaar-web', async () => {
    const res = await makeRequest(`/api/browser/b1/screenshot?__yaar_token=${appToken('notes')}`);
    expect(res.status).toBe(403);
  });

  it('lets an app that declared yaar-dev through the door', async () => {
    // Not a 403 — it gets as far as the handler, which is all this asserts.
    const res = await makeRequest('/api/dev/compile', {
      method: 'POST',
      headers: {
        'X-Iframe-Token': appToken('devtools', { bundles: ['yaar-dev'] }),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).not.toBe(403);
  });
});

// ── F-21: the MCP principal is a credential, not a claim ───────────────────

describe('MCP agent tokens', () => {
  it('binds a token to the agent it was minted for', () => {
    const token = getAgentToken('agent-monitor-1');
    expect(resolveAgentToken(token)).toBe('agent-monitor-1');
  });

  it('is stable across calls, so provider configs do not churn', () => {
    expect(getAgentToken('agent-a')).toBe(getAgentToken('agent-a'));
  });

  it('does not resolve a token it never issued', () => {
    // The whole point: an agent cannot name another agent to become it. Previously
    // `x-agent-id: <session agent>` was enough.
    expect(resolveAgentToken(crypto.randomUUID())).toBeNull();
  });

  it('gives different agents different tokens', () => {
    expect(getAgentToken('agent-b')).not.toBe(getAgentToken('agent-c'));
  });

  it('stops resolving a revoked agent', () => {
    const token = getAgentToken('agent-gone');
    revokeAgentToken('agent-gone');
    expect(resolveAgentToken(token)).toBeNull();
  });

  it('refuses an MCP request presenting an unknown agent token', async () => {
    const { initMcpServer, getMcpToken } = await import('@yaar/server/mcp/server');
    await initMcpServer();

    // Holding the shared bearer token is no longer enough to *be* somebody. Codex puts
    // that token in the app-server's environment, so this is the exact request a model
    // with shell access could forge.
    const res = await makeRequest('/mcp/verbs', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${getMcpToken()}`,
        'x-agent-token': crypto.randomUUID(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(403);
  });
});
