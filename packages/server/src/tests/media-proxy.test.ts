/**
 * `/api/media-proxy` and the stream helper behind it (and behind `/api/ml-weights`).
 *
 * The route fetches a caller-named URL and serves the bytes on YAAR's own origin, so
 * what matters is who reaches it (the `yaar-media` bundle, as a real app), what it will
 * forward (a validated `referer`, nothing else), and that the stream it hands back is
 * bounded — by bytes and by stalls — without mistaking a paused `<video>` for a dead
 * upstream. Every refusal asserts its reason, not just its status: a bare 403 passes
 * for whichever gate happened to fire first.
 */
import { describe, it, expect } from 'bun:test';
import { handleMediaProxyRoutes, parseReferer } from '../http/routes/media-proxy.js';
import { limitStream, safeContentType } from '../features/http/stream-proxy.js';
import { generateIframeToken } from '../http/iframe-tokens.js';

function get(query: string, token?: string) {
  const req = new Request(`http://localhost:8000/api/media-proxy${query}`, {
    headers: token ? { 'x-iframe-token': token } : {},
  });
  return handleMediaProxyRoutes(req, new URL(req.url));
}

function tokenWith(bundles: string[]): string {
  return generateIframeToken('win-media', 'sess-1', { appId: 'media-app', bundles });
}

async function errorOf(res: Response | null): Promise<[number, string]> {
  if (!res) throw new Error('route did not match');
  const body = (await res.json()) as { error: string };
  return [res.status, body.error];
}

describe('media-proxy gate', () => {
  it('ignores other paths', async () => {
    const req = new Request('http://localhost:8000/api/media-proxy-other');
    expect(await handleMediaProxyRoutes(req, new URL(req.url))).toBeNull();
  });

  it('refuses a caller with no iframe token — the door is for apps', async () => {
    const [status, error] = await errorOf(await get('?url=https://example.com/a.mp4'));
    expect(status).toBe(403);
    expect(error).toContain('iframe token');
  });

  it('refuses an app that did not declare yaar-media', async () => {
    const [status, error] = await errorOf(
      await get('?url=https://example.com/a.mp4', tokenWith(['yaar-ml'])),
    );
    expect(status).toBe(403);
    expect(error).toContain('"yaar-media"');
  });

  it('accepts the token as a query parameter, since a media element cannot set headers', async () => {
    // Past the gate, the missing url is what refuses it.
    const [status, error] = await errorOf(
      await get(`?__yaar_token=${encodeURIComponent(tokenWith(['yaar-media']))}`),
    );
    expect(status).toBe(400);
    expect(error).toContain('"url"');
  });

  it('runs the SSRF check before anything leaves the machine', async () => {
    const token = tokenWith(['yaar-media']);
    for (const target of ['http://169.254.169.254/latest', 'file:///etc/passwd']) {
      const res = await get(`?url=${encodeURIComponent(target)}`, token);
      expect(res?.status).toBe(400);
    }
  });

  it('refuses a malformed or non-http referer', async () => {
    const token = tokenWith(['yaar-media']);
    const url = encodeURIComponent('https://example.com/a.mp4');
    for (const referer of ['not a url', 'javascript:alert(1)']) {
      const [status, error] = await errorOf(
        await get(`?url=${url}&referer=${encodeURIComponent(referer)}`, token),
      );
      expect(status).toBe(400);
      expect(error).toContain('referer');
    }
  });

  it('rejects non-GET methods', async () => {
    const req = new Request('http://localhost:8000/api/media-proxy?url=https://example.com/a', {
      method: 'POST',
      headers: { 'x-iframe-token': tokenWith(['yaar-media']) },
    });
    // The gate runs first; streamProxy owns the method check once past it.
    const res = await handleMediaProxyRoutes(req, new URL(req.url));
    expect(res?.status).toBe(405);
  });
});

describe('parseReferer', () => {
  it('passes absent values through as null and normalizes a valid URL', () => {
    expect(parseReferer(null)).toBeNull();
    expect(parseReferer('')).toBeNull();
    expect(parseReferer('https://gelbooru.com')).toBe('https://gelbooru.com/');
  });
});

describe('safeContentType', () => {
  it('neutralizes types a browser would render or run on our origin', () => {
    for (const t of [
      'text/html',
      'text/html; charset=utf-8',
      'application/xhtml+xml',
      'image/svg+xml',
      'application/javascript',
      'text/javascript',
      'text/xml',
      'text/css',
    ]) {
      expect(safeContentType(t)).toBe('application/octet-stream');
    }
    expect(safeContentType(null)).toBe('application/octet-stream');
  });

  it('keeps media and binary types', () => {
    expect(safeContentType('video/mp4')).toBe('video/mp4');
    expect(safeContentType('audio/webm; codecs=opus')).toBe('audio/webm; codecs=opus');
    expect(safeContentType('application/octet-stream')).toBe('application/octet-stream');
  });
});

function chunks(sizes: number[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= sizes.length) return controller.close();
      controller.enqueue(new Uint8Array(sizes[i++]));
    },
  });
}

describe('limitStream', () => {
  it('passes a body under the ceiling through unchanged', async () => {
    const out = limitStream(chunks([4, 4, 2]), 10, 1000, new AbortController());
    expect((await new Response(out).arrayBuffer()).byteLength).toBe(10);
  });

  it('errors once streamed bytes pass the ceiling, whatever Content-Length claimed', async () => {
    const out = limitStream(chunks([6, 6]), 10, 1000, new AbortController());
    await expect(new Response(out).arrayBuffer()).rejects.toThrow('exceeded 10 bytes');
  });

  it('aborts when a single read stalls', async () => {
    const abort = new AbortController();
    const hung = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    const reader = limitStream(hung, 10, 20, abort).getReader();
    void reader.read();
    await new Promise((r) => setTimeout(r, 60));
    expect(abort.signal.aborted).toBe(true);
  });

  it('does not treat a consumer that stops pulling as a stall', async () => {
    const abort = new AbortController();
    const reader = limitStream(chunks([1, 1, 1]), 10, 20, abort).getReader();
    await reader.read();
    // A full <video> buffer: nobody asks for the next chunk for a while.
    await new Promise((r) => setTimeout(r, 60));
    expect(abort.signal.aborted).toBe(false);
    reader.releaseLock();
  });

  it('cancels upstream when the consumer goes away', async () => {
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      pull: (c) => c.enqueue(new Uint8Array(1)),
      cancel: () => {
        cancelled = true;
      },
    });
    const out = limitStream(upstream, 1000, 1000, new AbortController());
    await out.cancel('seek');
    expect(cancelled).toBe(true);
  });
});
