/**
 * Writes through `yaar://storage/…` wake the subscribers `/api/verb/subscribe` handed out.
 *
 * The subscribe door has always accepted `yaar://storage/shared/<path>` on a plain read
 * gate and answered with a subscriptionId, but only the app-storage door
 * (`yaar://apps/{id}/storage/…`) and appDb ever called `notifyChange` — so a subscription
 * on the commons, the one place apps publish for each other, was a callback that never
 * fired. The REST route the iframe storage SDK actually writes through notified nobody,
 * not even app-storage subscribers.
 *
 * Pinned here: every writing door notifies on success and not on failure, the ping crosses
 * sessions (storage is one tree on disk), and an app's private storage wakes subscribers
 * under either of its two spellings.
 */
import { describe, it, expect, afterAll, afterEach, beforeEach } from 'bun:test';
import { ResourceRegistry } from '../handlers/uri-registry.js';
import { registerStorageHandlers } from '../handlers/storage.js';
import { deleteStorage, invokeStorage } from '../handlers/apps/storage-resource.js';
import { handleFileRoutes } from '../http/routes/files.js';
import { handleVerbRoutes } from '../http/routes/verb.js';
import { generateIframeToken } from '../http/iframe-tokens.js';
import { subscriptionRegistry } from '../http/subscriptions.js';
import { actionEmitter } from '../session/action-emitter.js';
import { resolvePath, storageDelete, storageWrite } from '../storage/storage-manager.js';

const SHARED = `shared/__storage-subs-${process.pid}`;
const APP_ID = `__storage-subs-app-${process.pid}`;
const SESSION_A = 'sess-storage-subs-a';
const SESSION_B = 'sess-storage-subs-b';

const registry = new ResourceRegistry();
registerStorageHandlers(registry);

/** Subscription id → every URI it was pinged with. */
let pings: Map<string, string[]>;
let subIds: string[];
const listener = (e: { event: unknown }) => {
  const { subscriptionId, uri } = e.event as { subscriptionId?: string; uri?: string };
  if (!subscriptionId || !uri) return;
  pings.set(subscriptionId, [...(pings.get(subscriptionId) ?? []), uri]);
};

function sub(uri: string, sessionId = SESSION_A): string {
  const id = subscriptionRegistry.subscribe('tok', 'win-1', sessionId, uri);
  subIds.push(id);
  return id;
}

function rest(method: string, path: string, body?: string, token?: string) {
  const headers: Record<string, string> = token ? { 'x-iframe-token': token } : {};
  const req = new Request(`http://localhost:8000${path}`, { method, body, headers });
  return handleFileRoutes(req, new URL(req.url));
}

/** The shape `invokeStorage`/`deleteStorage` read — only `sourceUri` matters. */
function appUri(path: string) {
  return {
    kind: 'storage' as const,
    absolutePath: resolvePath(`apps/${APP_ID}/${path}`)?.absolutePath ?? '',
    readOnly: false,
    sourceUri: `yaar://apps/${APP_ID}/storage/${path}`,
    apiPath: `/api/storage/apps/${APP_ID}/${path}`,
  };
}

beforeEach(() => {
  pings = new Map();
  subIds = [];
  actionEmitter.on('verb-subscription', listener);
});

afterEach(() => {
  actionEmitter.off('verb-subscription', listener);
  for (const id of subIds) subscriptionRegistry.unsubscribe(id);
});

afterAll(async () => {
  await storageDelete(SHARED);
  await storageDelete(`apps/${APP_ID}`);
});

describe('the yaar://storage verb door', () => {
  it('wakes a prefix subscriber on write, edit, copy and delete', async () => {
    const id = sub(`yaar://storage/${SHARED}/`);

    await registry.execute('invoke', `yaar://storage/${SHARED}/a.txt`, {
      action: 'write',
      content: 'hello',
    });
    await registry.execute('invoke', `yaar://storage/${SHARED}/a.txt`, {
      action: 'edit',
      old_string: 'hello',
      new_string: 'bye',
    });
    await registry.execute('invoke', `yaar://storage/${SHARED}/b.txt`, {
      action: 'copy',
      from: `yaar://storage/${SHARED}/a.txt`,
    });
    await registry.execute('delete', `yaar://storage/${SHARED}/a.txt`);

    expect(pings.get(id)).toEqual([
      `yaar://storage/${SHARED}/a.txt`,
      `yaar://storage/${SHARED}/a.txt`,
      `yaar://storage/${SHARED}/b.txt`,
      `yaar://storage/${SHARED}/a.txt`,
    ]);
  });

  it('stays quiet for a failed write and for an action that writes nothing', async () => {
    const id = sub(`yaar://storage/${SHARED}/`);
    await storageWrite(`${SHARED}/g.txt`, 'needle');

    const failed = await registry.execute('invoke', `yaar://storage/${SHARED}/missing.txt`, {
      action: 'edit',
      old_string: 'x',
      new_string: 'y',
    });
    expect(failed.isError).toBe(true);
    await registry.execute('invoke', `yaar://storage/${SHARED}/`, {
      action: 'grep',
      pattern: 'needle',
    });

    expect(pings.get(id)).toBeUndefined();
  });

  it('reaches every session, since every session reads the same file', async () => {
    const inA = sub(`yaar://storage/${SHARED}/x.json`, SESSION_A);
    const inB = sub(`yaar://storage/${SHARED}/x.json`, SESSION_B);

    await registry.execute('invoke', `yaar://storage/${SHARED}/x.json`, {
      action: 'write',
      content: '{}',
    });

    expect(pings.get(inA)).toHaveLength(1);
    expect(pings.get(inB)).toHaveLength(1);
  });
});

describe('POST/DELETE /api/storage/{path}', () => {
  it('wakes subscribers on write, append and delete', async () => {
    const id = sub(`yaar://storage/${SHARED}/rest/`);

    expect((await rest('POST', `/api/storage/${SHARED}/rest/w.txt`, 'one'))?.status).toBe(200);
    expect(
      (await rest('POST', `/api/storage/${SHARED}/rest/w.txt?append=true`, 'two'))?.status,
    ).toBe(200);
    expect((await rest('DELETE', `/api/storage/${SHARED}/rest/w.txt`))?.status).toBe(200);

    expect(pings.get(id)).toEqual([
      `yaar://storage/${SHARED}/rest/w.txt`,
      `yaar://storage/${SHARED}/rest/w.txt`,
      `yaar://storage/${SHARED}/rest/w.txt`,
    ]);
  });

  it("delivers one app's shared/self write to another app subscribed through the door", async () => {
    // The issue's own scenario: a reader subscribes from its iframe, a writer publishes
    // with the storage SDK (which is this REST route), and the reader is told.
    const reader = generateIframeToken('win-reader', SESSION_A, { appId: 'reader' });
    const writer = generateIframeToken('win-writer', SESSION_B, { appId: 'writer' });
    const subReq = new Request('http://localhost:8000/api/verb/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-iframe-token': reader },
      body: JSON.stringify({ action: 'subscribe', uri: 'yaar://storage/shared/writer/' }),
    });
    const subRes = await handleVerbRoutes(subReq, new URL(subReq.url));
    expect(subRes?.status).toBe(200);
    const { subscriptionId } = (await subRes!.json()) as { subscriptionId: string };
    subIds.push(subscriptionId);

    try {
      const res = await rest('POST', '/api/storage/shared/self/feed.json', '[]', writer);
      expect(res?.status).toBe(200);
      expect(pings.get(subscriptionId)).toEqual(['yaar://storage/shared/writer/feed.json']);
    } finally {
      await storageDelete('shared/writer');
    }
  });
});

describe("an app's private storage, under both spellings", () => {
  it('wakes the namespaced subscriber for a write through the flat door, and back', async () => {
    const namespaced = sub(`yaar://apps/${APP_ID}/storage/`);
    const flat = sub(`yaar://storage/apps/${APP_ID}/`);

    await registry.execute('invoke', `yaar://storage/apps/${APP_ID}/via-flat.json`, {
      action: 'write',
      content: '{}',
    });
    await invokeStorage(appUri('via-app.json'), { action: 'write', content: '{}' });

    // Each subscriber hears the change in the spelling it subscribed under.
    expect(pings.get(namespaced)).toEqual([
      `yaar://apps/${APP_ID}/storage/via-flat.json`,
      `yaar://apps/${APP_ID}/storage/via-app.json`,
    ]);
    expect(pings.get(flat)).toEqual([
      `yaar://storage/apps/${APP_ID}/via-flat.json`,
      `yaar://storage/apps/${APP_ID}/via-app.json`,
    ]);
  });

  it('still wakes a namespace-root subscriber when the whole namespace is deleted', async () => {
    await storageWrite(`apps/${APP_ID}/doomed.json`, '{}');
    const id = sub(`yaar://apps/${APP_ID}/storage/`);

    const result = await deleteStorage(appUri(''));
    expect(result?.isError).toBeFalsy();

    // Exactly once: a notified URI ending in `/` is its own first prefix, and the
    // registry's walk used to collect the exact-match subscriber a second time.
    expect(pings.get(id)).toEqual([`yaar://apps/${APP_ID}/storage/`]);
  });
});
