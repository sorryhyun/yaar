/**
 * A storage write names its file in the URL path, and only there.
 *
 * `POST /api/storage/upload?path=shared/claude/x.png` used to write a file literally
 * named `upload` at the storage root and answer `{ ok: true, path: 'upload' }` — the
 * query string parsed fine and nothing read it. A success naming a different file than
 * the caller meant is the failure mode pinned here: the route now refuses the request,
 * and writes nothing.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { handleFileRoutes } from '../http/routes/files.js';
import { resolvePath, storageDelete } from '../storage/storage-manager.js';

// The documented scratch prefix in the real storage root (see storage-bytes.test.ts).
const SCRATCH = `temp/__storage-route-query-${process.pid}`;

afterAll(async () => {
  await storageDelete(SCRATCH);
});

function call(method: string, path: string, body?: string) {
  const req = new Request(`http://localhost:8000${path}`, { method, body });
  return handleFileRoutes(req, new URL(req.url));
}

async function exists(path: string) {
  const resolved = resolvePath(path);
  return resolved ? Bun.file(resolved.absolutePath).exists() : false;
}

describe('POST/DELETE /api/storage/{path} query strings', () => {
  it('refuses ?path= rather than writing to the URL segment', async () => {
    const res = await call('POST', `/api/storage/${SCRATCH}/upload?path=shared/x.png`, 'bytes');
    expect(res?.status).toBe(400);
    const { error } = (await res!.json()) as { error: string };
    expect(error).toContain("'path'");
    expect(error).toContain('/api/storage/{path}');
    expect(await exists(`${SCRATCH}/upload`)).toBe(false);
  });

  it('names every stray parameter once', async () => {
    const res = await call('POST', `/api/storage/${SCRATCH}/a.txt?path=x&overwrite=1&path=y`, 'a');
    const { error } = (await res!.json()) as { error: string };
    expect(error).toContain("'path', 'overwrite'");
  });

  it('refuses a stray parameter on DELETE too', async () => {
    const res = await call('DELETE', `/api/storage/${SCRATCH}/a.txt?path=elsewhere.txt`);
    expect(res?.status).toBe(400);
  });

  it('still accepts the credential parameters', async () => {
    // Local mode ignores `token`; the point is that the gate does not count it as stray.
    const res = await call('POST', `/api/storage/${SCRATCH}/ok.txt?token=abc`, 'hello');
    expect(res?.status).toBe(200);
    expect(await Bun.file(resolvePath(`${SCRATCH}/ok.txt`)!.absolutePath).text()).toBe('hello');
  });

  it('leaves GET query strings alone', async () => {
    const res = await call('GET', `/api/storage/${SCRATCH}/ok.txt?v=123`);
    expect(res?.status).toBe(200);
  });
});
