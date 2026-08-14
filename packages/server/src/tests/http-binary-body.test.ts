/**
 * `invoke yaar://http` — what a model gets back when the response is bytes.
 *
 * The reported failure (issue #78) was a JPEG served as `application/octet-stream`,
 * returned to a monitor agent as a full base64 `body` under `ok: true`: unreadable,
 * already paid for, and indistinguishable from success. Two things had to be true to fix
 * it — the bytes have to be recognized as an image *without* believing the content-type,
 * and everything else has to stop being inlined at all.
 *
 * The unit cases pin the sniffing and shaping decisions; the last block runs the whole
 * verb against a real loopback server, because the one thing worth proving is that the
 * agent and the app get *different* shapes out of the same `invoke`.
 */

import { describe, it, expect, afterAll } from 'bun:test';
import {
  planResponseBody,
  sniffImageMime,
  MAX_INLINE_IMAGE_BYTES,
} from '../features/http/binary-body.js';
import { runWithAgentContext } from '../agents/agent-context.js';
import { initRegistry } from '../handlers/index.js';
import { addAllowedDomain } from '../features/config/domains.js';
import { storageRead, storageDelete } from '../storage/storage-manager.js';
import type { VerbResult } from '../handlers/uri-registry.js';
import type { SessionId } from '../session/types.js';

const HINT = 'Re-run with { saveTo: "downloads/<name>" }.';

/** Bytes that start like the named format and are long enough to sniff. */
function fake(format: 'jpeg' | 'png' | 'gif' | 'webp', size = 64): Buffer {
  const buf = Buffer.alloc(size, 0x20);
  if (format === 'jpeg') buf.set([0xff, 0xd8, 0xff, 0xe0], 0);
  if (format === 'png') buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  if (format === 'gif') buf.write('GIF89a', 0, 'latin1');
  if (format === 'webp') {
    buf.write('RIFF', 0, 'latin1');
    buf.write('WEBP', 8, 'latin1');
  }
  return buf;
}

const textOf = (r: VerbResult) => r.content.map((c) => ('text' in c ? c.text : '')).join('\n');

describe('sniffImageMime', () => {
  it('identifies a JPEG served as application/octet-stream — the reported case', () => {
    expect(sniffImageMime(fake('jpeg'), 'application/octet-stream')).toBe('image/jpeg');
  });

  it('identifies each format from its magic bytes, ignoring the declared type', () => {
    expect(sniffImageMime(fake('png'), '')).toBe('image/png');
    expect(sniffImageMime(fake('gif'), 'application/binary')).toBe('image/gif');
    expect(sniffImageMime(fake('webp'), '')).toBe('image/webp');
  });

  it('falls back to a declared image type when the bytes are too short to identify', () => {
    expect(sniffImageMime(Buffer.from([0x01, 0x02]), 'image/png; charset=binary')).toBe(
      'image/png',
    );
  });

  it('is null for bytes that are not an image', () => {
    expect(sniffImageMime(Buffer.alloc(64), 'application/octet-stream')).toBeNull();
    expect(sniffImageMime(Buffer.alloc(64), 'application/pdf')).toBeNull();
  });

  it('does not claim SVG — it is text, and the text path already carries it', () => {
    expect(sniffImageMime(Buffer.from('<svg xmlns="http://x"/>'), 'image/svg+xml')).toBeNull();
  });
});

describe('planResponseBody', () => {
  it('returns text bodies unchanged', async () => {
    const plan = await planResponseBody(
      Buffer.from('<h1>hi</h1>'),
      'text/html; charset=utf-8',
      HINT,
    );
    expect(plan).toEqual({ kind: 'text', text: '<h1>hi</h1>' });
  });

  it('turns a mistyped JPEG into an image block, not a base64 string', async () => {
    const plan = await planResponseBody(fake('jpeg'), 'application/octet-stream', HINT);
    expect(plan.kind).toBe('image');
    if (plan.kind !== 'image') throw new Error('unreachable');
    expect(plan.mimeType).toBe('image/jpeg');
    expect(plan.data).toBe(fake('jpeg').toString('base64'));
    // The note has to say the type was not taken from the header, or the next reader
    // of a wrong content-type has no way to tell what happened.
    expect(plan.note).toContain('identified from its bytes');
  });

  it('omits a non-image binary body, with its size and a way out', async () => {
    const plan = await planResponseBody(Buffer.alloc(9000), 'application/pdf', HINT);
    expect(plan.kind).toBe('omitted');
    if (plan.kind !== 'omitted') throw new Error('unreachable');
    expect(plan.hint).toContain('application/pdf');
    expect(plan.hint).toContain('9000 bytes');
    expect(plan.hint).toContain(HINT);
  });

  it('omits an image over the inline limit rather than blowing the result budget', async () => {
    const plan = await planResponseBody(
      fake('png', MAX_INLINE_IMAGE_BYTES + 1024),
      'image/png',
      HINT,
    );
    expect(plan.kind).toBe('omitted');
    if (plan.kind !== 'omitted') throw new Error('unreachable');
    expect(plan.hint).toContain('inline limit');
    expect(plan.hint).toContain(HINT);
  });

  it('inlines an image right at the limit', async () => {
    const plan = await planResponseBody(fake('png', MAX_INLINE_IMAGE_BYTES), 'image/png', HINT);
    expect(plan.kind).toBe('image');
  });
});

describe('invoke yaar://http — the saveTo gate', () => {
  const asIframe = (fn: () => Promise<unknown>) =>
    runWithAgentContext(
      { agentId: 'iframe:reader', sessionId: 'ses-http-test' as SessionId, appId: 'reader' },
      fn,
    );

  const asMonitor = (fn: () => Promise<unknown>) =>
    runWithAgentContext(
      { agentId: 'agent-1', sessionId: 'ses-http-test' as SessionId, role: 'monitor' },
      fn,
    );

  const invoke = (payload: Record<string, unknown>) =>
    initRegistry().execute('invoke', 'yaar://http', payload) as Promise<VerbResult>;

  it('refuses saveTo from an app iframe instead of ignoring it', async () => {
    const result = (await asIframe(() =>
      invoke({ url: 'https://example.com/x.jpg', saveTo: 'x.jpg' }),
    )) as VerbResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('session and monitor agents');
  });

  it('refuses a saveTo that is a URI rather than a relative path', async () => {
    const result = (await asMonitor(() =>
      invoke({ url: 'https://example.com/x.jpg', saveTo: 'yaar://storage/x.jpg' }),
    )) as VerbResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('relative to yaar://storage/');
  });

  it('refuses a saveTo that escapes the storage root', async () => {
    for (const saveTo of ['../x.jpg', '/etc/passwd', '   ']) {
      const result = (await asMonitor(() =>
        invoke({ url: 'https://example.com/x.jpg', saveTo }),
      )) as VerbResult;
      expect(result.isError).toBe(true);
    }
  });
});

/**
 * The whole path, over a real socket.
 *
 * Loopback is deliberately allowed through SSRF (`isLoopback` in lib/ssrf.ts), so the
 * fetch, the sniff, the shaping and the storage write can all be exercised for real
 * rather than around a mocked `performFetch` — which is the only way to catch the two
 * callers diverging, since it is the *same* `invoke` serving both.
 */
describe('invoke yaar://http — end to end over loopback', () => {
  const jpeg = fake('jpeg', 512);
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      // Served with the wrong content-type on purpose: this is the reported shape.
      if (path === '/photo')
        return new Response(jpeg, { headers: { 'content-type': 'application/octet-stream' } });
      if (path === '/blob')
        return new Response(Buffer.alloc(4096), { headers: { 'content-type': 'application/pdf' } });
      return new Response('<h1>hi</h1>', { headers: { 'content-type': 'text/html' } });
    },
  });
  const url = (path: string) => `http://localhost:${server.port}${path}`;

  afterAll(() => server.stop(true));

  const run = (ctx: 'monitor' | 'iframe', payload: Record<string, unknown>) =>
    runWithAgentContext(
      ctx === 'monitor'
        ? { agentId: 'agent-e2e', sessionId: 'ses-http-e2e' as SessionId, role: 'monitor' as const }
        : { agentId: 'iframe:reader', sessionId: 'ses-http-e2e' as SessionId, appId: 'reader' },
      () => initRegistry().execute('invoke', 'yaar://http', payload) as Promise<VerbResult>,
    );

  it('hands an agent an image block for a mistyped JPEG, and an app the base64 body', async () => {
    await addAllowedDomain('localhost');

    const forAgent = await run('monitor', { url: url('/photo') });
    expect(forAgent.isError).toBeUndefined();
    const image = forAgent.content.find((c) => c.type === 'image');
    expect(image).toBeDefined();
    expect(image && 'mimeType' in image ? image.mimeType : null).toBe('image/jpeg');
    expect(textOf(forAgent)).not.toContain(jpeg.toString('base64'));

    // The app contract is the reason this is a caller-shaped decision and not a global
    // one: `responseFromProxyPayload` decodes exactly this envelope back into a Response.
    const forApp = await run('iframe', { url: url('/photo') });
    const envelope = forApp.structuredContent as Record<string, unknown>;
    expect(envelope.bodyEncoding).toBe('base64');
    expect(envelope.body).toBe(jpeg.toString('base64'));
  });

  it('omits a non-image binary body for an agent but keeps it for an app', async () => {
    await addAllowedDomain('localhost');

    const forAgent = (await run('monitor', { url: url('/blob') })).structuredContent as Record<
      string,
      unknown
    >;
    expect(forAgent.bodyOmitted).toBe(true);
    expect(forAgent.bodyBytes).toBe(4096);
    expect(forAgent.body).toBeUndefined();
    expect(String(forAgent.hint)).toContain('saveTo');

    const forApp = (await run('iframe', { url: url('/blob') })).structuredContent as Record<
      string,
      unknown
    >;
    expect(forApp.bodyEncoding).toBe('base64');
    expect(String(forApp.body).length).toBeGreaterThan(0);
  });

  it('leaves text bodies identical for both callers', async () => {
    await addAllowedDomain('localhost');

    const forAgent = (await run('monitor', { url: url('/page') })).structuredContent as Record<
      string,
      unknown
    >;
    const forApp = (await run('iframe', { url: url('/page') })).structuredContent as Record<
      string,
      unknown
    >;
    expect(forAgent.body).toBe('<h1>hi</h1>');
    expect(forApp.body).toBe('<h1>hi</h1>');
    expect(forApp.bodyEncoding).toBeUndefined();
  });

  it('saveTo writes the real bytes to storage and returns the path instead of a body', async () => {
    await addAllowedDomain('localhost');
    await storageDelete('downloads/photo.jpg');

    const result = await run('monitor', { url: url('/photo'), saveTo: 'downloads/photo.jpg' });
    const envelope = result.structuredContent as Record<string, unknown>;
    expect(envelope.body).toBeUndefined();
    expect(envelope.saved).toEqual({ uri: 'yaar://storage/downloads/photo.jpg', bytes: 512 });

    // Round-trip: the stored file is what the storage door will hand back as an image.
    const stored = await storageRead('downloads/photo.jpg');
    expect(stored.success).toBe(true);
    expect(stored.images?.[0]?.data).toBe(jpeg.toString('base64'));

    await storageDelete('downloads/photo.jpg');
  });
});
