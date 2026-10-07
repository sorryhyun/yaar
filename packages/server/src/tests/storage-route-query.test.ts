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

describe('POST /api/storage/{path}?append=true', () => {
  it('creates the file on the first append and grows it on the next', async () => {
    const path = `${SCRATCH}/rec/clip.webm`;
    const first = await call('POST', `/api/storage/${path}?append=true`, 'abc');
    expect(first?.status).toBe(200);
    expect(((await first!.json()) as { size: number }).size).toBe(3);

    const second = await call('POST', `/api/storage/${path}?append=true`, 'def');
    expect(((await second!.json()) as { size: number }).size).toBe(6);
    expect(await Bun.file(resolvePath(path)!.absolutePath).text()).toBe('abcdef');
  });

  it('leaves a plain write a replace', async () => {
    const path = `${SCRATCH}/rec/replace.txt`;
    await call('POST', `/api/storage/${path}?append=true`, 'old');
    await call('POST', `/api/storage/${path}`, 'new');
    expect(await Bun.file(resolvePath(path)!.absolutePath).text()).toBe('new');
  });

  it('refuses any value but true, and writes nothing', async () => {
    const path = `${SCRATCH}/rec/bad.txt`;
    const res = await call('POST', `/api/storage/${path}?append=1`, 'x');
    expect(res?.status).toBe(400);
    expect(await exists(path)).toBe(false);
  });

  it('is still a stray parameter on DELETE', async () => {
    const res = await call('DELETE', `/api/storage/${SCRATCH}/rec/clip.webm?append=true`);
    expect(res?.status).toBe(400);
    expect(await exists(`${SCRATCH}/rec/clip.webm`)).toBe(true);
  });
});

// #158: a stored .wav went out as application/octet-stream, and an iframe window
// pointed at it showed nothing — a top-level load only plays what it is told is media.
describe('GET /api/storage/{path} media Content-Type', () => {
  it.each([
    ['clip.wav', 'audio/wav'],
    ['clip.ogg', 'audio/ogg'],
    ['clip.flac', 'audio/flac'],
    ['clip.m4a', 'audio/mp4'],
    ['clip.webm', 'video/webm'],
  ])('serves %s as %s', async (name, type) => {
    await call('POST', `/api/storage/${SCRATCH}/media/${name}`, 'bytes');
    const res = await call('GET', `/api/storage/${SCRATCH}/media/${name}`);
    expect(res?.headers.get('content-type')).toBe(type);
  });
});

// #169: a rendered video over the 50 MB body cap was refused after minutes of work. A
// write now streams to disk under its own ceiling; going over it still writes nothing.
describe('POST /api/storage/{path} write ceiling', () => {
  const MB = 1024 * 1024;
  const previous = process.env.YAAR_MAX_STORAGE_WRITE_MB;

  afterAll(() => {
    if (previous === undefined) delete process.env.YAAR_MAX_STORAGE_WRITE_MB;
    else process.env.YAAR_MAX_STORAGE_WRITE_MB = previous;
  });

  function streamOf(totalBytes: number, chunkBytes = 256 * 1024): ReadableStream<Uint8Array> {
    let sent = 0;
    return new ReadableStream({
      pull(controller) {
        if (sent >= totalBytes) return controller.close();
        const n = Math.min(chunkBytes, totalBytes - sent);
        sent += n;
        controller.enqueue(new Uint8Array(n).fill(120));
      },
    });
  }

  function post(path: string, body: ReadableStream<Uint8Array>, headers?: Record<string, string>) {
    const req = new Request(`http://localhost:8000/api/storage/${path}`, {
      method: 'POST',
      body,
      headers,
    });
    return handleFileRoutes(req, new URL(req.url));
  }

  async function siblings(dir: string) {
    const res = await call('GET', `/api/storage/${dir}?list=true`);
    return ((await res!.json()) as { path: string }[]).map((e) => e.path.split('/').pop());
  }

  it('writes a streamed body larger than the old 50 MB cap', async () => {
    process.env.YAAR_MAX_STORAGE_WRITE_MB = '1024';
    const path = `${SCRATCH}/big/render.mp4`;
    const res = await post(path, streamOf(51 * MB, 4 * MB));
    expect(res?.status).toBe(200);
    expect(Bun.file(resolvePath(path)!.absolutePath).size).toBe(51 * MB);
  });

  it('refuses a declared size over the ceiling with the numbers, and keeps the old file', async () => {
    process.env.YAAR_MAX_STORAGE_WRITE_MB = '1';
    const path = `${SCRATCH}/cap/declared.bin`;
    await call('POST', `/api/storage/${path}`, 'original');

    const res = await post(path, streamOf(2 * MB), { 'content-length': String(2 * MB) });
    expect(res?.status).toBe(413);
    const { error } = (await res!.json()) as { error: string };
    expect(error).toContain('2.0 MB exceeds the 1.0 MB storage write limit');
    expect(error).toContain('Nothing was written');
    expect(error).toContain('YAAR_MAX_STORAGE_WRITE_MB');
    expect(await Bun.file(resolvePath(path)!.absolutePath).text()).toBe('original');
  });

  it('stops a stream that runs over, leaving no partial file behind', async () => {
    process.env.YAAR_MAX_STORAGE_WRITE_MB = '1';
    const path = `${SCRATCH}/cap/streamed.bin`;
    await call('POST', `/api/storage/${path}`, 'original');

    const res = await post(path, streamOf(3 * MB));
    expect(res?.status).toBe(413);
    expect(await Bun.file(resolvePath(path)!.absolutePath).text()).toBe('original');
    expect(await siblings(`${SCRATCH}/cap`)).not.toContainEqual(expect.stringContaining('.part-'));
  });

  it('writes an empty body as an empty file', async () => {
    const path = `${SCRATCH}/cap/empty.txt`;
    const res = await call('POST', `/api/storage/${path}`, '');
    expect(res?.status).toBe(200);
    expect(await exists(path)).toBe(true);
    expect(Bun.file(resolvePath(path)!.absolutePath).size).toBe(0);
  });
});
