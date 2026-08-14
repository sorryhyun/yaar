import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createSession, SessionLogger } from '../logging/session-logger.js';
import { parseSessionMessages, readSessionBlob } from '../logging/session-reader.js';
import { BLOB_THRESHOLD_BYTES, hashContent, isBlobRef } from '../logging/blobs.js';
import { parseHistoryUri } from '../lib/yaar-uri-server.js';
import type { ParsedMessage } from '../logging/types.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'yaar-blobs-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A logger writing into a session directory of this test's own. */
async function makeLogger(): Promise<{ logger: SessionLogger; dir: string; id: string }> {
  const info = await createSession('claude', root);
  return { logger: new SessionLogger(info), dir: info.directory, id: info.sessionId };
}

async function readEntries(dir: string): Promise<ParsedMessage[]> {
  return parseSessionMessages(await Bun.file(join(dir, 'messages.jsonl')).text());
}

const big = (marker: string) => marker.repeat(BLOB_THRESHOLD_BYTES + 1);

describe('session log blob offloading', () => {
  it('draws the inline/offload line at exactly the threshold', async () => {
    const { logger, dir } = await makeLogger();
    logger.logToolResult('read', 'a'.repeat(BLOB_THRESHOLD_BYTES), 'tu-1', 'monitor-0');
    logger.logToolResult('read', 'b'.repeat(BLOB_THRESHOLD_BYTES + 1), 'tu-2', 'monitor-0');
    await logger.dispose();

    const [atLimit, overLimit] = await readEntries(dir);
    expect(atLimit.contentRef).toBeUndefined();
    expect(overLimit.contentRef).toBeDefined();
  });

  it('measures the threshold in bytes, not characters', async () => {
    const { logger, dir } = await makeLogger();
    // Well under the threshold as characters, well over it once UTF-8 encoded.
    logger.logToolResult('read', '가'.repeat(BLOB_THRESHOLD_BYTES / 2), 'tu-1', 'monitor-0');
    await logger.dispose();

    const [entry] = await readEntries(dir);
    expect(entry.contentRef).toBeDefined();
  });

  it('keeps small results inline', async () => {
    const { logger, dir } = await makeLogger();
    logger.logToolResult('read', 'small enough', 'tu-1', 'monitor-0');
    await logger.dispose();

    const [entry] = await readEntries(dir);
    expect(entry.content).toBe('small enough');
    expect(entry.contentRef).toBeUndefined();
    // No blob directory is created when nothing needed offloading.
    expect(await readdir(dir)).not.toContain('blobs');
  });

  it('offloads a large result and serves the exact bytes back', async () => {
    const { logger, dir, id } = await makeLogger();
    const content = big('x');
    logger.logToolResult('read', content, 'tu-1', 'monitor-0');
    await logger.dispose();

    const [entry] = await readEntries(dir);
    expect(entry.content).toBeUndefined();
    expect(entry.contentRef?.sha256).toBe(hashContent(content));
    expect(entry.contentRef?.bytes).toBe(content.length);
    expect(entry.contentRef?.preview).toStartWith('xxx');

    // The whole point: the bytes come back byte-identical, from the hash alone.
    expect(await readSessionBlob(id, entry.contentRef!.sha256, root)).toBe(content);
  });

  it('stores one blob no matter how many times the same result repeats', async () => {
    const { logger, dir, id } = await makeLogger();
    const content = big('y');
    // The measured pattern this exists for: an app re-reading one unchanged resource.
    for (let i = 0; i < 50; i++) logger.logToolResult('read', content, `tu-${i}`, 'monitor-0');
    await logger.dispose();

    const entries = await readEntries(dir);
    expect(entries).toHaveLength(50);
    expect(new Set(entries.map((e) => e.contentRef?.sha256)).size).toBe(1);
    expect(await readdir(join(dir, 'blobs'))).toHaveLength(1);
    expect(await readSessionBlob(id, entries[0].contentRef!.sha256, root)).toBe(content);
  });

  it('gives changed bytes a different ref, so the log shows the change', async () => {
    const { logger, dir } = await makeLogger();
    logger.logToolResult('read', big('a'), 'tu-1', 'monitor-0');
    logger.logToolResult('read', big('b'), 'tu-2', 'monitor-0');
    await logger.dispose();

    const [first, second] = await readEntries(dir);
    expect(first.contentRef!.sha256).not.toBe(second.contentRef!.sha256);
    expect(await readdir(join(dir, 'blobs'))).toHaveLength(2);
  });

  it('writes the blob before the line that references it', async () => {
    const { logger, dir, id } = await makeLogger();
    logger.logToolResult('read', big('z'), 'tu-1', 'monitor-0');
    await logger.flush();

    // After a flush every ref in the log must already resolve — a reader tailing the
    // JSONL must never see a pointer to bytes that are not there yet.
    for (const entry of await readEntries(dir)) {
      if (!entry.contentRef) continue;
      expect(await readSessionBlob(id, entry.contentRef.sha256, root)).not.toBeNull();
    }
  });

  it('records a verb result, offloading it when large', async () => {
    const { logger, dir, id } = await makeLogger();
    const envelope = { ok: true, text: big('q') };
    logger.logVerbResult('iframe:devtools', envelope, { durationMs: 12 });
    await logger.dispose();

    const [entry] = await readEntries(dir);
    expect(entry.type).toBe('verb_result');
    expect(entry.toolName).toBe('iframe:devtools');
    expect(entry.durationMs).toBe(12);
    expect(JSON.parse((await readSessionBlob(id, entry.contentRef!.sha256, root))!)).toEqual(
      envelope,
    );
  });

  it('carries a data URL by its media type rather than a preview of base64', async () => {
    const { logger, dir } = await makeLogger();
    logger.logToolResult('read', `data:image/png;base64,${'A'.repeat(4000)}`, 'tu-1', 'monitor-0');
    await logger.dispose();

    const [entry] = await readEntries(dir);
    expect(entry.contentRef?.mimeType).toBe('image/png');
    expect(entry.contentRef?.preview).toBeUndefined();
  });

  it('survives a result that JSON.stringify alone would throw on', async () => {
    const { logger, dir } = await makeLogger();
    const cyclic: Record<string, unknown> = { note: 'x'.repeat(BLOB_THRESHOLD_BYTES) };
    cyclic.self = cyclic;
    logger.logVerbResult('iframe:app', cyclic);
    await logger.dispose();

    const [entry] = await readEntries(dir);
    expect(entry.type).toBe('verb_result');
    expect(entry.contentRef).toBeDefined();
  });
});

describe('yaar://history blob URIs', () => {
  it('parses a blob URI', () => {
    expect(parseHistoryUri('yaar://history/2026-01-01_00-00-00/blobs/abc123')).toEqual({
      sessionId: '2026-01-01_00-00-00',
      subPath: 'blobs',
      blobRef: 'abc123',
    });
  });

  it('rejects a third segment under a sub-path that takes no name', () => {
    expect(parseHistoryUri('yaar://history/s1/messages/extra')).toBeNull();
    expect(parseHistoryUri('yaar://history/s1/blobs/a/b')).toBeNull();
  });

  it('refuses a blob name that is not a hex digest', async () => {
    const { id } = await makeLogger();
    // The traversal this guards: a name that is not exactly a digest never becomes a path.
    expect(isBlobRef('../../../etc/passwd')).toBe(false);
    expect(await readSessionBlob(id, '../../../etc/passwd', root)).toBeNull();
    expect(await readSessionBlob(id, 'not-a-hash', root)).toBeNull();
  });
});
