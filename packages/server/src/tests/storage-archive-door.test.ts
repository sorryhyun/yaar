/**
 * The archive actions through `POST /api/verb`, the door an app's iframe uses: real handler code,
 * reached with a real iframe token and a real permission check.
 *
 * storage-archive.test.ts pins the storage layer; this pins that the handlers wire it up — that an
 * archive reads as a folder at the door, that an entry reads as its file, and that `compress` and
 * `extract` take `copy`'s shape (target written, `from` read) including its gate.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { initRegistry } from '../handlers/index.js';
import { handleVerbRoutes } from '../http/routes/verb.js';
import { generateIframeToken } from '../http/iframe-tokens.js';
import { storageDelete } from '../storage/storage-manager.js';
import type { SessionId } from '../session/types.js';

const APP = `archive-door-${process.pid}`;
const ROOT = `yaar://apps/${APP}/storage`;

afterAll(async () => {
  await storageDelete(`apps/${APP}`);
});

/** An app that may use its own storage and nothing else. */
function token(): string {
  return generateIframeToken('win-archive-door', 'sess-archive-door' as SessionId, {
    appId: APP,
    permissions: [`${ROOT}/`],
  });
}

async function verb(
  name: string,
  uri: string,
  payload?: unknown,
): Promise<{ status: number; body: string }> {
  initRegistry();
  const req = new Request('http://localhost:8000/api/verb', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-iframe-token': token() },
    body: JSON.stringify({ verb: name, uri, ...(payload === undefined ? {} : { payload }) }),
  });
  const res = await handleVerbRoutes(req, new URL(req.url));
  if (!res) throw new Error('route did not handle POST /api/verb');
  return { status: res.status, body: await res.text() };
}

describe('archives through the app door', () => {
  it('compresses a folder, lists and reads into the zip, and extracts it', async () => {
    const note = await verb('invoke', `${ROOT}/src/notes/today.md`, {
      action: 'write',
      content: 'buy milk',
    });
    expect(note.status).toBe(200);
    expect(
      (await verb('invoke', `${ROOT}/src/todo.json`, { action: 'write', content: '["milk"]' }))
        .status,
    ).toBe(200);

    const packed = await verb('invoke', `${ROOT}/pack.zip`, {
      action: 'compress',
      from: `yaar://apps/self/storage/src`,
    });
    expect(packed.status).toBe(200);

    const listed = await verb('list', `${ROOT}/pack.zip/src`);
    expect(listed.status).toBe(200);
    expect(listed.body).toContain(`${ROOT}/pack.zip/src/notes`);
    expect(listed.body).toContain(`${ROOT}/pack.zip/src/todo.json`);

    // A read of the archive itself lists it, as a read of a folder would. (This door sends a
    // listing as a bare link array, so the "used list instead" note does not reach the body.)
    const root = await verb('read', `${ROOT}/pack.zip`);
    expect(root.status).toBe(200);
    expect(root.body).toContain(`${ROOT}/pack.zip/src`);

    const entry = await verb('read', `${ROOT}/pack.zip/src/notes/today.md`);
    expect(entry.status).toBe(200);
    expect(entry.body).toContain('buy milk');

    const unpacked = await verb('invoke', `${ROOT}/unpacked`, {
      action: 'extract',
      from: `${ROOT}/pack.zip`,
    });
    expect(unpacked.status).toBe(200);
    const extracted = await verb('read', `${ROOT}/unpacked/src/todo.json`);
    expect(extracted.status).toBe(200);
    expect(extracted.body).toContain('milk');
  });

  it('403s a compress whose sources include storage the app may not read', async () => {
    const res = await verb('invoke', `${ROOT}/stolen.zip`, {
      action: 'compress',
      from: [`${ROOT}/src`, 'yaar://apps/vault/storage/'],
    });
    expect(res.status).toBe(403);
  });
});
