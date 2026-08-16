/**
 * The scheme is optional at the verb doors, and canonical everywhere past them.
 *
 * `read('storage/notes.md')` means `read('yaar://storage/notes.md')`. That is the whole
 * feature, and it is worth a suite only because of where the rewrite has to happen: as the
 * *first* statement at each door, ahead of brace expansion, the permission gate, the
 * tool-call buffer, the subscription key and the registry. Resolve it anywhere later and a
 * permission has matched one spelling while the dispatch used another — which is the class
 * of bug that does not announce itself.
 *
 * So the assertions here are mostly about ordering and about what is *not* rewritten:
 * `http://example.com` handed to a `uri` argument by mistake must stay a broken yaar URI
 * rather than become `yaar://http://example.com` and reach the fetch handler.
 *
 * Layer 2 — bare paths resolved against the caller's position in the agent tree — is a
 * separate change with its own refusals; nothing here consults a principal.
 */
import { describe, it, expect } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/server';
import { resolveShorthandUri } from '../http/access.js';
import { registerVerbTools } from '../handlers/index.js';
import { handleVerbRoutes } from '../http/routes/verb.js';
import { generateIframeToken } from '../http/iframe-tokens.js';
import { subscriptionRegistry } from '../http/subscriptions.js';
import { consumeLastCall } from '../mcp/tool-call-buffer.js';
import type { SessionId } from '../session/types.js';

const SESSION = 'sess-uri-shorthand' as SessionId;

describe('resolveShorthandUri', () => {
  it('prepends the scheme for every authority, bare or with a path', () => {
    expect(resolveShorthandUri('storage/notes.md')).toBe('yaar://storage/notes.md');
    expect(resolveShorthandUri('apps/memo/storage/x.json')).toBe('yaar://apps/memo/storage/x.json');
    expect(resolveShorthandUri('windows/win-3/state/cells')).toBe(
      'yaar://windows/win-3/state/cells',
    );
    expect(resolveShorthandUri('apps')).toBe('yaar://apps');
    expect(resolveShorthandUri('system/update')).toBe('yaar://system/update');
  });

  it('covers the phantom `http` authority, which the shared union deliberately omits', () => {
    // Registered in handlers/http.ts by exact pattern, so it is an authority at the door
    // even though `parseYaarUri` refuses it. Leaving it out of the rule would make
    // `describe('http')` the one spelling shorthand declines.
    expect(resolveShorthandUri('http')).toBe('yaar://http');
    expect(resolveShorthandUri('http/cookies')).toBe('yaar://http/cookies');
  });

  it('never rewrites a real URL, which is the collision the rule exists for', () => {
    // A colon where the rule demands a slash or end-of-string. Without this,
    // `yaar://http://example.com` would dispatch at the fetch handler.
    expect(resolveShorthandUri('http://example.com')).toBe('http://example.com');
    expect(resolveShorthandUri('https://example.com')).toBe('https://example.com');
    expect(resolveShorthandUri('file:///etc/passwd')).toBe('file:///etc/passwd');
  });

  it('leaves an already-canonical URI, a look-alike, and a bare path alone', () => {
    expect(resolveShorthandUri('yaar://storage/notes.md')).toBe('yaar://storage/notes.md');
    expect(resolveShorthandUri('storagey/x')).toBe('storagey/x');
    expect(resolveShorthandUri('systemd/x')).toBe('systemd/x');
    // Layer 1 is authority-anchored only: a bare *path* names nothing yet, and turning it
    // into one is the tier-relative layer's job, not this function's.
    expect(resolveShorthandUri('notes/todo.md')).toBe('notes/todo.md');
    expect(resolveShorthandUri('')).toBe('');
  });

  it('is idempotent — the canonical form is a fixed point', () => {
    for (const uri of ['storage/x', 'http://example.com', 'yaar://apps/memo', 'notes/todo.md']) {
      expect(resolveShorthandUri(resolveShorthandUri(uri))).toBe(resolveShorthandUri(uri));
    }
  });
});

/**
 * The MCP door, driven through `registerVerbTools` rather than the private `exec` wrapper,
 * so what is under test is the path a model's tool call actually takes.
 */
function captureVerbTools(): Map<string, (args: Record<string, unknown>) => Promise<unknown>> {
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const fake = {
    registerTool(
      name: string,
      _meta: unknown,
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) {
      tools.set(name, handler);
    },
  };
  registerVerbTools(fake as unknown as McpServer);
  return tools;
}

describe('the MCP door resolves shorthand before anything downstream sees it', () => {
  const tools = captureVerbTools();

  it('records the canonical URI in the tool-call buffer, not what the model typed', async () => {
    // `consumeLastCall` is what the Claude message-mapper replays into a sub-agent's
    // `task_progress` activity, which carries no tool input of its own. A shorthand URI
    // surfacing there would describe the same call two different ways depending on how it
    // was spelled.
    await tools.get('describe')!({ uri: 'apps' });
    expect(consumeLastCall('describe')).toEqual({ uri: 'yaar://apps', payload: undefined });
  });

  it('dispatches shorthand and canonical to the same handler', async () => {
    const short = JSON.stringify(await tools.get('describe')!({ uri: 'storage' }));
    const long = JSON.stringify(await tools.get('describe')!({ uri: 'yaar://storage' }));
    expect(short).toBe(long);
    consumeLastCall('describe');
    consumeLastCall('describe');
  });

  it('composes with brace expansion, which reads the authority before the brace', async () => {
    const result = (await tools.get('describe')!({ uri: 'storage/{a,b}' })) as {
      content: Array<{ type: string; text?: string }>;
    };
    // `formatBatchResults` interleaves `--- uri ---` headers; both are canonical.
    const text = result.content.map((c) => c.text ?? '').join('\n');
    expect(text).toContain('yaar://storage/a');
    expect(text).toContain('yaar://storage/b');
    expect(text).not.toContain('--- storage/a');
    // Two calls buffered, both canonical.
    expect(consumeLastCall('describe')?.uri).toBe('yaar://storage/b');
    expect(consumeLastCall('describe')?.uri).toBe('yaar://storage/a');
  });

  it('leaves a mistaken real URL to fail as an unresolvable yaar URI', async () => {
    const result = (await tools.get('read')!({ uri: 'http://example.com' })) as {
      isError?: boolean;
      content: Array<{ text?: string }>;
    };
    expect(result.isError).toBe(true);
    // The point is the *absence* of a rewrite: nothing here names `yaar://http`.
    expect(result.content.map((c) => c.text ?? '').join('\n')).not.toContain('yaar://http');
    consumeLastCall('read');
  });
});

function tokenFor(appId: string, permissions: string[]): string {
  return generateIframeToken(`win-${appId}`, SESSION, { appId, permissions });
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

describe('both verb doors accept the same shorthand', () => {
  it('checks the permission against the canonical URI, not the short one', async () => {
    // The grant names the canonical prefix. If the gate ran ahead of the rewrite, the
    // scheme-less string would match no entry and this would 403 — the failure mode that
    // makes rewrite-ordering load-bearing rather than cosmetic. What comes back instead is
    // the handler's own answer for an app that is not installed.
    const res = await post('/api/verb', tokenFor('shorthand-app', ['yaar://apps/']), {
      verb: 'describe',
      uri: 'apps/shorthand-app',
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain('shorthand-app');
  });

  it('denies the short and the canonical spelling in the same words', async () => {
    // The refusal quotes the URI the gate saw. Both spellings quoting the canonical form
    // is the direct evidence that only one string ever reached `requirePermission`.
    const ungranted = tokenFor('shorthand-app', []);
    const short = await post('/api/verb', ungranted, { verb: 'read', uri: 'storage/nope' });
    const long = await post('/api/verb', ungranted, { verb: 'read', uri: 'yaar://storage/nope' });

    expect(short.status).toBe(403);
    expect(await short.text()).toBe(await long.text());
  });

  it('still refuses a brace URI by name, having resolved the scheme first', async () => {
    // Brace expansion is MCP-only. The refusal has to survive the new rewrite, and it
    // should quote what the caller actually sent rather than the rewritten form.
    const res = await post('/api/verb', tokenFor('shorthand-app', ['yaar://storage/']), {
      verb: 'read',
      uri: 'storage/{a,b}',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Brace expansion is MCP-only');
  });

  it('subscribes under the canonical URI, so a producer’s notify reaches it', async () => {
    const res = await post('/api/verb/subscribe', tokenFor('shorthand-sub', ['yaar://storage/']), {
      action: 'subscribe',
      uri: 'storage/inbox/',
    });
    expect(res.status).toBe(200);
    const { subscriptionId } = (await res.json()) as { subscriptionId: string };

    const found = subscriptionRegistry.getSubscribers('yaar://storage/inbox/msg.json');
    expect(found.map((s) => s.id)).toContain(subscriptionId);

    subscriptionRegistry.unsubscribe(subscriptionId);
  });

  it('composes with `self`, which is resolved after the scheme', async () => {
    const res = await post('/api/verb', tokenFor('not-an-installed-app', ['yaar://apps/self/']), {
      verb: 'describe',
      uri: 'apps/self',
    });
    const text = JSON.stringify(await res.json());
    expect(text).toContain('not-an-installed-app');
    expect(text).not.toContain('apps/self');
  });
});
