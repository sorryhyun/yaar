/**
 * Preview fault rules — `app_faults` on a devtools preview, enforced at the iframe doors.
 *
 * What has to hold: rules can only be set on a preview window; they catch that window's own
 * calls (by the URI as written *and* as resolved, by verb, up to `times`), answer in the
 * shape the calling SDK reads, and outlive the close-and-recreate devtools does on every
 * compile without ever matching a non-preview window. A call the app may not make still
 * gets its real 403, never a simulated failure.
 */
import { afterEach, describe, it, expect } from 'bun:test';
import type { OSAction } from '@yaar/shared';
import { handleVerbRoutes } from '../http/routes/verb.js';
import { handleProxyRoutes } from '../http/routes/proxy.js';
import { generateIframeToken } from '../http/iframe-tokens.js';
import { getSessionHub } from '../session/session-hub.js';
import { runWithAgentContext } from '../agents/agent-context.js';
import { handlePreviewFaults, parseFaultRules } from '../features/window/preview-faults.js';
import type { SessionId } from '../session/types.js';

const SESSION = 'sess-preview-faults' as SessionId;
const PREVIEW = 'devtools-preview-demo';
const PREVIEW_APP = 'preview--demo';

function sessionWithWindows() {
  const session = getSessionHub().getOrCreate(SESSION, {});
  const open = (windowId: string, appId: string) =>
    session.windowState.handleAction(
      {
        type: 'window.create',
        windowId,
        title: windowId,
        bounds: { x: 0, y: 0, w: 100, h: 100 },
        content: { renderer: 'iframe', data: `yaar://apps/${appId}` },
        appId,
      } as OSAction,
      '0',
    );
  open(PREVIEW, PREVIEW_APP);
  open('memo', 'memo');
  return session;
}

function setFaults(windowId: string, rules: unknown) {
  const session = getSessionHub().get(SESSION)!;
  return runWithAgentContext({ agentId: 'test', sessionId: SESSION, monitorId: '0' }, () =>
    handlePreviewFaults(session.windowState, windowId, rules === undefined ? {} : { rules }),
  );
}

function previewToken(): string {
  return generateIframeToken(PREVIEW, SESSION, {
    appId: PREVIEW_APP,
    monitorId: '0',
    // Self storage is added by the real mint path (`SELF_GRANTS`), not by this helper.
    permissions: ['yaar://http', 'yaar://apps/self/storage/'],
  });
}

async function post(
  handler: (req: Request, url: URL) => Promise<Response | null>,
  path: string,
  body: unknown,
  token: string,
  signal?: AbortSignal,
): Promise<Response> {
  const req = new Request(`http://localhost:8000${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-iframe-token': token },
    body: JSON.stringify(body),
    signal,
  });
  const res = await handler(req, new URL(req.url));
  if (!res) throw new Error(`route did not handle POST ${path}`);
  return res;
}

const verb = (body: unknown, token: string, signal?: AbortSignal) =>
  post(handleVerbRoutes, '/api/verb', body, token, signal);

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error?: string }).error ?? '';
}

afterEach(async () => {
  await getSessionHub().remove(SESSION);
});

describe('app_faults', () => {
  it('is refused on a window that is not a devtools preview', () => {
    sessionWithWindows();
    const result = setFaults('memo', [{ match: 'yaar://*', kind: 'fail' }]);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('not a devtools preview');
  });

  it('fails a matching verb call with the envelope the SDK throws, and only that call', async () => {
    sessionWithWindows();
    setFaults(PREVIEW, [
      { match: 'yaar://apps/self/storage/broken/*', kind: 'fail', verbs: ['read'] },
    ]);
    const token = previewToken();

    const faulted = await verb(
      { verb: 'read', uri: 'yaar://apps/self/storage/broken/a.json' },
      token,
    );
    expect(faulted.status).toBe(500);
    const envelope = (await faulted.json()) as { ok: boolean; error: string };
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toContain('Simulated failure');

    const otherPath = await verb(
      { verb: 'read', uri: 'yaar://apps/self/storage/fine.json', payload: { missingOk: true } },
      token,
    );
    expect(await errorOf(otherPath)).not.toContain('Simulated');

    // `verbs` narrows the rule: a list of the same folder goes through.
    const otherVerb = await verb({ verb: 'list', uri: 'yaar://apps/self/storage/broken/' }, token);
    expect(await errorOf(otherVerb)).not.toContain('Simulated');

    const report = setFaults(PREVIEW, undefined);
    expect(report.structuredContent).toMatchObject({ rules: [{ hits: 1 }] });
  });

  it('matches the URI as resolved, not only as the app spelled it', async () => {
    sessionWithWindows();
    setFaults(PREVIEW, [
      {
        match: `yaar://apps/${PREVIEW_APP}/storage/*`,
        kind: 'fail',
        error: 'disk gone',
        status: 507,
      },
    ]);
    const res = await verb(
      { verb: 'read', uri: 'yaar://apps/self/storage/x.json' },
      previewToken(),
    );
    expect(res.status).toBe(507);
    expect(await errorOf(res)).toBe('disk gone');
  });

  it('answers a retryable 503 once, then lets the retry through', async () => {
    sessionWithWindows();
    setFaults(PREVIEW, [
      { match: 'yaar://apps/self/storage/*', kind: 'fail', retryable: true, times: 1 },
    ]);
    const token = previewToken();
    const call = {
      verb: 'read',
      uri: 'yaar://apps/self/storage/x.json',
      payload: { missingOk: true },
    };

    const first = await verb(call, token);
    expect(first.status).toBe(503);
    expect(((await first.json()) as { retryable?: boolean }).retryable).toBe(true);

    const second = await verb(call, token);
    expect(second.status).not.toBe(503);
    expect(await errorOf(second)).not.toContain('Simulated');
  });

  it('stalls a delayed call, then runs it', async () => {
    sessionWithWindows();
    setFaults(PREVIEW, [{ match: 'yaar://apps/self/storage/*', kind: 'delay', delayMs: 60 }]);
    const startedAt = Date.now();
    const res = await verb(
      { verb: 'read', uri: 'yaar://apps/self/storage/x.json', payload: { missingOk: true } },
      previewToken(),
    );
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(55);
    expect(await errorOf(res)).not.toContain('Simulated');
  });

  it('holds a hung call until the client gives up', async () => {
    sessionWithWindows();
    setFaults(PREVIEW, [{ match: 'yaar://apps/self/storage/*', kind: 'hang' }]);
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 30);
    const res = await verb(
      { verb: 'read', uri: 'yaar://apps/self/storage/x.json' },
      previewToken(),
      abort.signal,
    );
    expect(res.status).toBe(504);
  });

  it('fails a matching cross-origin fetch without reaching the network', async () => {
    sessionWithWindows();
    setFaults(PREVIEW, [{ match: 'https://api.example.test/*', kind: 'fail' }]);
    const res = await post(
      handleProxyRoutes,
      '/api/fetch',
      { url: 'https://api.example.test/items' },
      previewToken(),
    );
    expect(res.status).toBe(502);
    expect(await errorOf(res)).toContain('Simulated failure');
  });

  it('never hides a refusal behind a simulated failure', async () => {
    sessionWithWindows();
    setFaults(PREVIEW, [{ match: 'yaar://*', kind: 'fail' }]);
    const res = await verb(
      { verb: 'read', uri: 'yaar://apps/memo/storage/x.json' },
      previewToken(),
    );
    expect(res.status).toBe(403);
  });

  it("applies only to the preview's own calls", async () => {
    sessionWithWindows();
    setFaults(PREVIEW, [{ match: 'yaar://*', kind: 'fail' }]);
    const memo = generateIframeToken('memo', SESSION, {
      appId: 'memo',
      monitorId: '0',
      permissions: ['yaar://apps/self/storage/'],
    });
    const memoRes = await verb(
      { verb: 'read', uri: 'yaar://apps/self/storage/x.json', payload: { missingOk: true } },
      memo,
    );
    expect(await errorOf(memoRes)).not.toContain('Simulated');
  });

  it('survives the preview being re-created under its id, as every compile does', async () => {
    const session = sessionWithWindows();
    setFaults(PREVIEW, [{ match: 'yaar://*', kind: 'fail' }]);
    const { windowState } = session;
    windowState.handleAction({ type: 'window.close', windowId: PREVIEW } as OSAction, '0');
    expect(windowState.getWindowFaults(PREVIEW, '0', () => true)).toEqual([]);

    sessionWithWindows();
    const res = await verb(
      { verb: 'read', uri: 'yaar://apps/self/storage/x.json' },
      previewToken(),
    );
    expect(await errorOf(res)).toContain('Simulated');

    // A window that only borrows the id, running as a real app, is never matched.
    windowState.handleAction({ type: 'window.close', windowId: PREVIEW } as OSAction, '0');
    windowState.handleAction(
      {
        type: 'window.create',
        windowId: PREVIEW,
        title: 'impostor',
        bounds: { x: 0, y: 0, w: 100, h: 100 },
        content: { renderer: 'iframe', data: 'yaar://apps/memo' },
        appId: 'memo',
      } as OSAction,
      '0',
    );
    const impostor = generateIframeToken(PREVIEW, SESSION, {
      appId: 'memo',
      monitorId: '0',
      permissions: ['yaar://apps/self/storage/'],
    });
    const impostorRes = await verb(
      { verb: 'read', uri: 'yaar://apps/self/storage/x.json', payload: { missingOk: true } },
      impostor,
    );
    expect(await errorOf(impostorRes)).not.toContain('Simulated');
  });
});

describe('parseFaultRules', () => {
  it.each([
    [[{ match: '/api/items', kind: 'fail' }], 'must start with yaar://'],
    [[{ match: 'yaar://x', kind: 'explode' }], 'kind must be one of'],
    [[{ match: 'yaar://x', kind: 'delay' }], 'needs delayMs'],
    [[{ match: 'https://x', kind: 'fail', verbs: ['read'] }], 'only applies to a yaar://'],
    [[{ match: 'yaar://x', kind: 'hang', status: 500 }], 'only apply to a "fail" rule'],
    [[{ match: 'yaar://x', kind: 'fail', status: 200 }], 'HTTP error status'],
    ['nope', 'must be an array'],
  ])('refuses %j', (rules, message) => {
    const parsed = parseFaultRules(rules);
    expect('error' in parsed && parsed.error).toContain(message);
  });
});
