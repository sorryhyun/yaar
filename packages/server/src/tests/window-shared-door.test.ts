/**
 * `/api/verb/shared` — the value every copy of one window agrees on.
 *
 * A window open on two desktops runs two iframes, each with its own token, and the
 * agent's commands reach only one. What has to hold: a set through one copy's token is
 * what the other copy's token reads, the other copy's subscription is pinged for it, and
 * no other window can see or ping the value.
 */
import { afterEach, describe, it, expect } from 'bun:test';
import { handleVerbRoutes } from '../http/routes/verb.js';
import { generateIframeToken } from '../http/iframe-tokens.js';
import { actionEmitter } from '../session/action-emitter.js';
import { subscriptionRegistry } from '../http/subscriptions.js';
import { windowSharedStore } from '../http/window-shared.js';

const SESSION = 'sess-window-shared';

async function post(path: string, body: unknown, token: string): Promise<Response> {
  const req = new Request(`http://localhost:8000${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-iframe-token': token },
    body: JSON.stringify(body),
  });
  const res = await handleVerbRoutes(req, new URL(req.url));
  if (!res) throw new Error(`route did not handle POST ${path}`);
  return res;
}

async function subscribe(key: string, token: string): Promise<string> {
  const res = await post(
    '/api/verb/subscribe',
    { action: 'subscribe', uri: `yaar://windows/self/shared/${key}` },
    token,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { subscriptionId: string }).subscriptionId;
}

afterEach(() => {
  subscriptionRegistry.clearForSession(SESSION);
  windowSharedStore.clearSession(SESSION);
});

describe('window shared values', () => {
  it("reads through one copy's token what the other copy's token set", async () => {
    const phone = generateIframeToken('win-dev', SESSION, { appId: 'devtools' });
    const companion = generateIframeToken('win-dev', SESSION, { appId: 'devtools' });

    const empty = await post('/api/verb/shared', { action: 'get', key: 'changes' }, phone);
    expect(await empty.json()).toEqual({ value: null, rev: 0 });

    const set = await post(
      '/api/verb/shared',
      { action: 'set', key: 'changes', value: [{ path: 'src/main.ts' }] },
      companion,
    );
    const { rev } = (await set.json()) as { rev: number };
    expect(rev).toBeGreaterThan(0);

    const read = await post('/api/verb/shared', { action: 'get', key: 'changes' }, phone);
    expect(await read.json()).toEqual({ value: [{ path: 'src/main.ts' }], rev });
  });

  it('pings the copies of the writing window, and no other window', async () => {
    const phone = generateIframeToken('win-dev', SESSION, { appId: 'devtools' });
    const companion = generateIframeToken('win-dev', SESSION, { appId: 'devtools' });
    const other = generateIframeToken('win-memo', SESSION, { appId: 'memo' });
    const phoneSub = await subscribe('open', phone);
    const otherSub = await subscribe('open', other);

    const pinged: string[] = [];
    const listener = (e: { event: unknown }) => {
      const id = (e.event as { subscriptionId?: string }).subscriptionId;
      if (id) pinged.push(id);
    };
    actionEmitter.on('verb-subscription', listener);
    try {
      await post('/api/verb/shared', { action: 'set', key: 'open', value: 'a.ts' }, companion);
    } finally {
      actionEmitter.off('verb-subscription', listener);
    }
    expect(pinged).toContain(phoneSub);
    expect(pinged).not.toContain(otherSub);

    const otherRead = await post('/api/verb/shared', { action: 'get', key: 'open' }, other);
    expect(((await otherRead.json()) as { rev: number }).rev).toBe(0);
  });

  it('refuses a key that is not a plain name, and a set without a value', async () => {
    const token = generateIframeToken('win-dev', SESSION, { appId: 'devtools' });
    const badKey = await post('/api/verb/shared', { action: 'get', key: '../x' }, token);
    expect(badKey.status).toBe(400);
    const noValue = await post('/api/verb/shared', { action: 'set', key: 'k' }, token);
    expect(noValue.status).toBe(400);
  });

  it('forgets a window when it is cleared', async () => {
    const token = generateIframeToken('win-dev', SESSION, { appId: 'devtools' });
    await post('/api/verb/shared', { action: 'set', key: 'k', value: 1 }, token);
    windowSharedStore.clearWindow(SESSION, 'win-dev');
    const read = await post('/api/verb/shared', { action: 'get', key: 'k' }, token);
    expect(((await read.json()) as { rev: number }).rev).toBe(0);
  });
});
