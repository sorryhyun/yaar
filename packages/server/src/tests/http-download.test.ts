/**
 * `invoke yaar://http` with `saveTo` — the download path, and the size guard around it.
 *
 * The reported failure (issue #90) was two halves of one mistake: a single 10MB ceiling
 * enforced with no idea what the caller asked for. `saveTo` exists precisely so a body
 * never has to fit anywhere but disk, and it was rejected by the cap meant to keep base64
 * out of a transcript; and a `HEAD`, which carries no body at all, was rejected for the
 * `content-length` describing the `GET` nobody made.
 *
 * Everything here runs against a real loopback server rather than a mocked `performFetch`,
 * because the claims are about bytes moving — that a body larger than the inline cap
 * reaches the file intact, and that a transfer which dies halfway leaves nothing behind.
 */

import { describe, it, expect, afterAll } from 'bun:test';
import { performFetch, MAX_RESPONSE_SIZE, MAX_DOWNLOAD_SIZE } from '../features/http/fetch.js';
import { runWithAgentContext } from '../agents/agent-context.js';
import { initRegistry } from '../handlers/index.js';
import { addAllowedDomain } from '../features/config/domains.js';
import { storageList, storageDelete } from '../storage/storage-manager.js';
import { STORAGE_DIR } from '../config.js';
import type { VerbResult } from '../handlers/uri-registry.js';
import type { SessionId } from '../session/types.js';

/** Comfortably past the inline cap, and cheap to produce. */
const BIG_BYTES = MAX_RESPONSE_SIZE + 1024 * 1024;
const CHUNK = Buffer.alloc(1024 * 1024, 0x41);

/**
 * A body delivered in 1MB pieces, optionally dying partway through.
 *
 * `failAfter` errors the stream rather than closing it short: Bun's server rewrites the
 * content-length of a body that simply ends early, so a clean close is indistinguishable
 * from a complete response and does not reproduce a dropped transfer.
 */
function bigStream(failAfter?: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (failAfter !== undefined && sent >= failAfter) {
        controller.error(new Error('upstream went away'));
        return;
      }
      if (sent >= BIG_BYTES) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(CHUNK));
      sent += CHUNK.length;
    },
  });
}

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    const headers = {
      'content-type': 'application/pdf',
      'content-length': String(BIG_BYTES),
    };
    // HEAD is answered by the same handler: the point of the test is that it advertises a
    // content-length it does not deliver, which is exactly what a real server does.
    if (req.method === 'HEAD') return new Response(null, { headers });
    if (path === '/truncated')
      return new Response(bigStream(2 * CHUNK.length), {
        headers: { 'content-type': headers['content-type'] },
      });
    if (path === '/big') return new Response(bigStream(), { headers });
    return new Response('ok', { headers: { 'content-type': 'text/plain' } });
  },
});
const url = (path: string) => `http://localhost:${server.port}${path}`;

afterAll(() => server.stop(true));

const asMonitor = (payload: Record<string, unknown>) =>
  runWithAgentContext(
    { agentId: 'agent-dl', sessionId: 'ses-http-dl' as SessionId, role: 'monitor' as const },
    () => initRegistry().execute('invoke', 'yaar://http', payload) as Promise<VerbResult>,
  );

const textOf = (r: VerbResult) => r.content.map((c) => ('text' in c ? c.text : '')).join('\n');

/** Any `.part-*` sibling left in storage — the stream's temp file, which must never survive. */
async function leftoverPartials(dir: string): Promise<string[]> {
  const listed = await storageList(dir);
  return (listed.entries ?? []).map((e) => e.path).filter((p) => p.includes('.part-'));
}

describe('saveTo is not bound by the inline response cap', () => {
  it('writes a body larger than MAX_RESPONSE_SIZE straight to storage', async () => {
    await addAllowedDomain('localhost');
    await storageDelete('downloads/big.pdf');

    const result = await asMonitor({ url: url('/big'), saveTo: 'downloads/big.pdf' });
    expect(result.isError).toBeUndefined();
    const envelope = result.structuredContent as Record<string, unknown>;
    expect(envelope.saved).toEqual({ uri: 'yaar://storage/downloads/big.pdf', bytes: BIG_BYTES });
    expect(envelope.body).toBeUndefined();

    // The file on disk is the whole body, not a truncated prefix.
    const file = Bun.file(`${STORAGE_DIR}/downloads/big.pdf`);
    expect(file.size).toBe(BIG_BYTES);
    expect(await leftoverPartials('downloads')).toEqual([]);

    await storageDelete('downloads/big.pdf');
  }, 30_000);

  it('still refuses the same body inline, where the cap is about the transcript', async () => {
    await addAllowedDomain('localhost');

    const result = await asMonitor({ url: url('/big') });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Response too large (max 10MB)');
  });

  it('gives the download path a much larger ceiling than the inline one', () => {
    expect(MAX_DOWNLOAD_SIZE).toBeGreaterThan(MAX_RESPONSE_SIZE);
  });
});

describe('HEAD is judged by its own body, which is empty', () => {
  it('succeeds against a resource whose content-length exceeds the cap', async () => {
    await addAllowedDomain('localhost');

    const result = await asMonitor({ url: url('/big'), method: 'HEAD' });
    expect(result.isError).toBeUndefined();
    const envelope = result.structuredContent as Record<string, unknown>;
    expect(envelope.status).toBe(200);
    expect((envelope.headers as Record<string, string>)['content-length']).toBe(String(BIG_BYTES));
  });
});

describe('a download that dies halfway leaves nothing behind', () => {
  it('reports the failure and writes no file at the destination', async () => {
    await addAllowedDomain('localhost');
    await storageDelete('downloads/truncated.pdf');

    const result = await asMonitor({
      url: url('/truncated'),
      saveTo: 'downloads/truncated.pdf',
    });
    expect(result.isError).toBe(true);

    // Neither the destination nor the stream's temp file survives — a half-written PDF is
    // indistinguishable from a whole one to everything downstream of `read`.
    const listed = await storageList('downloads');
    const names = (listed.entries ?? []).map((e) => e.path);
    expect(names).not.toContain('downloads/truncated.pdf');
    expect(await leftoverPartials('downloads')).toEqual([]);
  }, 30_000);

  it('creates no directory for a request that never produces bytes', async () => {
    await addAllowedDomain('localhost');

    const result = await asMonitor({
      url: 'http://localhost:1/never',
      saveTo: 'nowhere/never.bin',
    });
    expect(result.isError).toBe(true);
    expect((await storageList('nowhere')).success).toBe(false);
  });
});

describe('performFetch size ceiling', () => {
  it('honours a per-request maxResponseSize and names it in the refusal', async () => {
    await addAllowedDomain('localhost');

    await expect(performFetch(url('/big'), { maxResponseSize: 1024 * 1024 })).rejects.toThrow(
      'Response too large (max 1MB)',
    );
  });

  it('hands every chunk to a sink instead of buffering, and counts them', async () => {
    await addAllowedDomain('localhost');

    let seen = 0;
    const result = await performFetch(url('/big'), {
      maxResponseSize: MAX_DOWNLOAD_SIZE,
      sink: (chunk) => {
        seen += chunk.length;
      },
    });
    expect(seen).toBe(BIG_BYTES);
    expect(result.bytesStreamed).toBe(BIG_BYTES);
    expect(result.body).toBe('');
    expect(result.bytes).toBeUndefined();
  }, 30_000);
});
