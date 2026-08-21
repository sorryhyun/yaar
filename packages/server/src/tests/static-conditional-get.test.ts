/**
 * Conditional GET on the frontend static path (`http/routes/static.ts`).
 *
 * Asserts against the predicates rather than `handleStaticRoutes`, for the reason
 * documented on `cacheControl`: the handler resolves `FRONTEND_DIST` at module load, and
 * pointing that override at a fixture from here would race `features/fonts` in the same
 * `--parallel` process.
 *
 * One case is not about our code at all — `Range` — and is here deliberately. Bun turns a
 * `Range` header on a `BunFile` response into a `206` itself, which is why `static.ts`
 * carries no range handling; this pins that so a future change to how the response is
 * constructed cannot quietly cost it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  cacheControl,
  fsValidators,
  embeddedValidators,
  staticResponse,
} from '../http/routes/static.js';

let dir: string;
let assetPath: string;

const GET = (headers: Record<string, string> = {}) =>
  new Request('http://localhost:8000/main-a1b2c3d4.js', { headers });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'yaar-static-'));
  assetPath = join(dir, 'main-a1b2c3d4.js');
  writeFileSync(assetPath, 'console.log("hello");');
  // A whole second, so the value survives the truncation Last-Modified imposes.
  const when = new Date('2026-08-21T12:00:00.000Z');
  utimesSync(assetPath, when, when);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('cacheControl', () => {
  it('lets a content-hashed build output be cached forever', () => {
    expect(cacheControl('/main-a1b2c3d4.js')).toBe('public, max-age=31536000, immutable');
    expect(cacheControl('/chunk-0f9e8d7c6b5a.css')).toBe('public, max-age=31536000, immutable');
    expect(cacheControl('/main-a1b2c3d4.js.map')).toBe('public, max-age=31536000, immutable');
  });

  it('makes the fixed-name assets revalidate — the webfonts above all', () => {
    // The 10.5 MB this whole change exists for. A hash-shaped name is the only thing
    // that earns `immutable`, and `-Rg` is not one.
    expect(cacheControl('/NanumSquareNeoOTF-Rg.otf')).toBe('no-cache');
    expect(cacheControl('/D2Coding.ttf')).toBe('no-cache');
    expect(cacheControl('/index.html')).toBe('no-cache');
    expect(cacheControl('/')).toBe('no-cache');
  });
});

describe('staticResponse — filesystem branch', () => {
  it('carries the validators and the type on a plain GET', async () => {
    const file = Bun.file(assetPath);
    const res = staticResponse(GET(), file, assetPath, fsValidators(file));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/javascript');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('ETag')).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    expect(res.headers.get('Last-Modified')).toBe('Fri, 21 Aug 2026 12:00:00 GMT');
    expect(await res.text()).toBe('console.log("hello");');
  });

  it('answers 304 to the ETag it just handed out, and repeats the validators', async () => {
    const file = Bun.file(assetPath);
    const first = staticResponse(GET(), file, assetPath, fsValidators(file));
    const etag = first.headers.get('ETag')!;

    const second = staticResponse(
      GET({ 'If-None-Match': etag }),
      file,
      assetPath,
      fsValidators(file),
    );

    expect(second.status).toBe(304);
    expect(second.body).toBeNull();
    // A 304 that dropped these would leave the *next* request with nothing to revalidate.
    expect(second.headers.get('ETag')).toBe(etag);
    expect(second.headers.get('Last-Modified')).toBe(first.headers.get('Last-Modified'));
    expect(second.headers.get('Cache-Control')).toBe(first.headers.get('Cache-Control'));
  });

  it('honours a weak/strong mismatch and a list, and refuses a stale ETag', () => {
    const file = Bun.file(assetPath);
    const v = fsValidators(file)!;
    const strong = v.etag.slice(2); // same entity, spelled without the W/

    const run = (inm: string) =>
      staticResponse(GET({ 'If-None-Match': inm }), file, assetPath, fsValidators(file)).status;

    expect(run(v.etag)).toBe(304);
    expect(run(strong)).toBe(304);
    expect(run(`W/"deadbeef-1", ${v.etag}`)).toBe(304);
    expect(run('*')).toBe(304);
    expect(run('W/"deadbeef-1"')).toBe(200);
  });

  it('uses If-Modified-Since only when no ETag was offered', () => {
    const file = Bun.file(assetPath);
    const run = (headers: Record<string, string>) =>
      staticResponse(GET(headers), file, assetPath, fsValidators(file)).status;

    expect(run({ 'If-Modified-Since': 'Fri, 21 Aug 2026 12:00:00 GMT' })).toBe(304);
    expect(run({ 'If-Modified-Since': 'Sat, 22 Aug 2026 00:00:00 GMT' })).toBe(304);
    expect(run({ 'If-Modified-Since': 'Thu, 20 Aug 2026 00:00:00 GMT' })).toBe(200);
    expect(run({ 'If-Modified-Since': 'not a date' })).toBe(200);
    // RFC 9110: a present If-None-Match settles it, and a stale one means "send it".
    expect(
      run({
        'If-None-Match': 'W/"deadbeef-1"',
        'If-Modified-Since': 'Sat, 22 Aug 2026 00:00:00 GMT',
      }),
    ).toBe(200);
  });

  it('still gets Range for free from Bun, headers and all', async () => {
    const file = Bun.file(assetPath);
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => staticResponse(req, file, assetPath, fsValidators(file)),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/main-a1b2c3d4.js`, {
        headers: { Range: 'bytes=0-6' },
      });
      expect(res.status).toBe(206);
      expect(res.headers.get('Content-Range')).toBe('bytes 0-6/21');
      expect(res.headers.get('ETag')).toMatch(/^W\//);
      expect(await res.text()).toBe('console');
    } finally {
      server.stop(true);
    }
  });

  it('serves unconditionally rather than guessing when the file has no usable stat', () => {
    const res = staticResponse(GET(), Bun.file(assetPath), assetPath, null);
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toBeNull();
    expect(res.headers.get('Last-Modified')).toBeNull();
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });
});

describe('embeddedValidators — bundled exe branch', () => {
  it('takes a strong ETag from the content hash Bun mints into the bunfs path', () => {
    const v = embeddedValidators('/$bunfs/root/main-6m6v52et.js');
    expect(v.etag).toBe('"main-6m6v52et.js"');
    // Strong: the name is a hash of the bytes, verified by rebuilding a fixture with
    // different content at the same length and watching the suffix change.
    expect(v.etag.startsWith('W/')).toBe(false);
  });

  it('sends no Last-Modified, because an embedded file reports a year-144680 sentinel', () => {
    const v = embeddedValidators('/$bunfs/root/index.html');
    expect(v.lastModified).toBeUndefined();

    const res = staticResponse(GET(), Bun.file(assetPath), '/index.html', v);
    expect(res.headers.get('Last-Modified')).toBeNull();
    expect(res.headers.get('ETag')).toBe('"index.html"');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
  });

  it('round-trips its own ETag to a 304', () => {
    const v = embeddedValidators('/$bunfs/root/main-6m6v52et.js');
    const res = staticResponse(
      GET({ 'If-None-Match': '"main-6m6v52et.js"' }),
      Bun.file(assetPath),
      '/main-6m6v52et.js',
      v,
    );
    expect(res.status).toBe(304);
  });
});
