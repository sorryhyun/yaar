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
import {
  handleMediaProxyRoutes,
  parseReferer,
  playlistProxyUrl,
} from '../http/routes/media-proxy.js';
import {
  isPlaylistText,
  looksLikePlaylist,
  rewritePlaylist,
} from '../features/http/hls-playlist.js';
import {
  DECLARED_LENGTH_HEADER,
  forwardedHeaders,
  limitStream,
  safeContentType,
} from '../features/http/stream-proxy.js';
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

describe('forwardedHeaders', () => {
  it('carries the declared length where Bun will not drop it', () => {
    // Bun sends a ReadableStream body chunked and discards a Content-Length set on it, so
    // the copy under DECLARED_LENGTH_HEADER is the one a caller can check truncation by.
    const out = forwardedHeaders(
      new Headers({ 'content-length': '6400000', 'content-range': 'bytes 0-6399999/9000000' }),
    );
    expect(out[DECLARED_LENGTH_HEADER]).toBe('6400000');
    expect(out['content-length']).toBe('6400000');
    expect(out['content-range']).toBe('bytes 0-6399999/9000000');
  });

  it('omits the length when fetch will have decoded the body it describes', () => {
    const out = forwardedHeaders(
      new Headers({ 'content-length': '1000', 'content-encoding': 'gzip', etag: '"a"' }),
    );
    expect(out[DECLARED_LENGTH_HEADER]).toBeUndefined();
    expect(out['content-length']).toBeUndefined();
    expect(out.etag).toBe('"a"');
    expect(
      forwardedHeaders(new Headers({ 'content-length': '1000', 'content-encoding': 'identity' }))[
        DECLARED_LENGTH_HEADER
      ],
    ).toBe('1000');
  });

  it('omits a length that is absent or not a number', () => {
    expect(forwardedHeaders(new Headers({}))[DECLARED_LENGTH_HEADER]).toBeUndefined();
    expect(
      forwardedHeaders(new Headers({ 'content-length': 'abc' }))[DECLARED_LENGTH_HEADER],
    ).toBeUndefined();
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

describe('HLS playlists', () => {
  const proxy = (u: string) => `P(${u})`;

  it('recognizes a playlist by type or by path', () => {
    expect(looksLikePlaylist('application/vnd.apple.mpegurl', 'https://a.com/x')).toBe(true);
    expect(looksLikePlaylist('application/x-mpegURL; charset=utf-8', 'https://a.com/x')).toBe(true);
    expect(looksLikePlaylist('audio/mpegurl', 'https://a.com/x')).toBe(true);
    expect(looksLikePlaylist('text/plain', 'https://a.com/hls/index.m3u8')).toBe(true);
    expect(looksLikePlaylist('video/mp2t', 'https://a.com/seg-1.ts')).toBe(false);
    expect(looksLikePlaylist(null, 'https://a.com/v.mp4?x=.m3u8')).toBe(false);
    expect(isPlaylistText('\uFEFF#EXTM3U\n')).toBe(true);
    expect(isPlaylistText('<html>403</html>')).toBe(false);
  });

  it('rewrites URI lines against the playlist URL, relative and absolute', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
      '360p/index.m3u8?sig=abc',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000',
      '/abs/720p.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=4000000',
      'https://cdn2.example.com/1080p.m3u8',
    ].join('\n');
    const out = rewritePlaylist(text, 'https://cdn.example.com/v/master.m3u8', proxy).split('\n');
    expect(out[0]).toBe('#EXTM3U');
    expect(out[1]).toBe('#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360');
    expect(out[2]).toBe('P(https://cdn.example.com/v/360p/index.m3u8?sig=abc)');
    expect(out[4]).toBe('P(https://cdn.example.com/abs/720p.m3u8)');
    expect(out[6]).toBe('P(https://cdn2.example.com/1080p.m3u8)');
  });

  it('rewrites URI attributes of tags, and leaves key systems and comments alone', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/en.m3u8"',
      '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://k1"',
      '# a comment with URI="x"',
      '#EXTINF:4.0,',
      'seg-1.ts',
      '',
    ].join('\r\n');
    const out = rewritePlaylist(text, 'https://c.com/p/media.m3u8', proxy).split('\n');
    expect(out[1]).toBe('#EXT-X-KEY:METHOD=AES-128,URI="P(https://c.com/p/key.bin)",IV=0x1');
    expect(out[2]).toBe('#EXT-X-MAP:URI="P(https://c.com/p/init.mp4)",BYTERANGE="720@0"');
    expect(out[3]).toBe(
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="P(https://c.com/p/audio/en.m3u8)"',
    );
    expect(out[4]).toBe('#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://k1"');
    expect(out[5]).toBe('# a comment with URI="x"');
    expect(out[7]).toBe('P(https://c.com/p/seg-1.ts)');
  });

  it('names the proxy relatively, carrying referer and both tokens', () => {
    const reqUrl = new URL(
      'http://localhost:8000/api/media-proxy?url=x&__yaar_token=T1&token=R1&referer=https%3A%2F%2Fsite.com%2F',
    );
    const req = new Request(reqUrl.href);
    const out = playlistProxyUrl('https://c.com/a b.ts?q="1"', 'https://site.com/', req, reqUrl);
    expect(out.startsWith('media-proxy?')).toBe(true);
    // A URI attribute is quoted, so the proxy URL must never contain a raw quote.
    expect(out).not.toContain('"');
    const back = new URL(out, reqUrl);
    expect(back.pathname).toBe('/api/media-proxy');
    expect(back.searchParams.get('url')).toBe('https://c.com/a b.ts?q="1"');
    expect(back.searchParams.get('referer')).toBe('https://site.com/');
    expect(back.searchParams.get('__yaar_token')).toBe('T1');
    expect(back.searchParams.get('token')).toBe('R1');
  });

  it('carries a header-borne iframe token into the query, where the next fetch can send it', () => {
    const reqUrl = new URL('http://localhost:8000/api/media-proxy?url=x');
    const req = new Request(reqUrl.href, { headers: { 'x-iframe-token': 'H1' } });
    const back = new URL(playlistProxyUrl('https://c.com/s.ts', null, req, reqUrl), reqUrl);
    expect(back.searchParams.get('__yaar_token')).toBe('H1');
    expect(back.searchParams.has('referer')).toBe(false);
    expect(back.searchParams.has('token')).toBe(false);
  });
});
