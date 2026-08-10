/**
 * The two binary-safe storage primitives.
 *
 * Both exist because the flat tree could not hold binary. `yaar://storage/` wrote
 * `payload.content` through as a string while `yaar://apps/{id}/storage/` decoded
 * `encoding: 'base64'` first, so the *same bytes* written through the two spellings
 * of the same tree produced a PNG on one path and a text file full of base64 on the
 * other — with no error at any layer. The round-trip assertions below are the point:
 * a corrupt write that reports success is the failure mode being pinned.
 *
 * `copy` is the primitive that lets a file cross between the trees without its bytes
 * passing through whoever asked for the move.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import {
  copyStorageBytes,
  decodeWriteContent,
  storagePathForUri,
} from '../handlers/storage-bytes.js';
import { resolvePath, storageWrite, storageDelete } from '../storage/storage-manager.js';

// Written into the real storage root under `temp/`, which is the documented scratch
// prefix — STORAGE_DIR is fixed at import time and env is process-global, so a
// per-test root would leak into every other file in the shared unit process.
const SCRATCH = `temp/__storage-bytes-test-${process.pid}`;

/** A 1×1 PNG — a real binary payload with bytes that are not valid UTF-8. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');

afterAll(async () => {
  await storageDelete(SCRATCH);
});

describe('storagePathForUri', () => {
  it('maps both spellings of app storage to the same path', () => {
    expect(storagePathForUri('yaar://apps/notes/storage/x.png')).toBe('apps/notes/x.png');
    expect(storagePathForUri('yaar://storage/apps/notes/x.png')).toBe('apps/notes/x.png');
  });

  it('maps a flat path to itself', () => {
    expect(storagePathForUri('yaar://storage/shared/anima/dragon.png')).toBe(
      'shared/anima/dragon.png',
    );
  });

  it('refuses traversal and non-storage URIs', () => {
    expect(storagePathForUri('yaar://storage/../config/credentials.json')).toBeNull();
    expect(storagePathForUri('yaar://apps/notes/storage/../../vault/keys.json')).toBeNull();
    expect(storagePathForUri('yaar://session/browser')).toBeNull();
    expect(storagePathForUri('yaar://apps/notes/db/items')).toBeNull();
  });
});

describe('decodeWriteContent', () => {
  it('passes text through untouched', () => {
    const decoded = decodeWriteContent({ content: 'hello' });
    expect(decoded).toEqual({ content: 'hello' });
  });

  it('decodes base64 to bytes', () => {
    const decoded = decodeWriteContent({ content: PNG_BASE64, encoding: 'base64' });
    expect((decoded as { content: Buffer }).content).toBeInstanceOf(Buffer);
    expect((decoded as { content: Buffer }).content.equals(PNG_BYTES)).toBe(true);
  });

  it('rejects malformed base64 instead of silently dropping bytes', () => {
    // Buffer.from(x, 'base64') does not throw on junk — it skips what it cannot
    // parse, which is exactly how a truncated upload lands on disk as a short file.
    const decoded = decodeWriteContent({ content: 'not valid base64!!', encoding: 'base64' });
    expect(decoded).toHaveProperty('error');
  });

  it('requires content to be a string', () => {
    expect(decodeWriteContent({ content: 42 })).toHaveProperty('error');
  });
});

describe('copyStorageBytes', () => {
  it('copies a binary file byte-for-byte between the two trees', async () => {
    const sourcePath = `${SCRATCH}/source.png`;
    await storageWrite(sourcePath, PNG_BYTES);

    const destPath = `${SCRATCH}/copied.png`;
    const result = await copyStorageBytes(`yaar://storage/${sourcePath}`, destPath);
    expect(result).toEqual({ bytes: PNG_BYTES.length });

    const written = Buffer.from(await Bun.file(resolvePath(destPath)!.absolutePath).arrayBuffer());
    expect(written.equals(PNG_BYTES)).toBe(true);
  });

  it('reports a missing source rather than writing an empty file', async () => {
    const destPath = `${SCRATCH}/never.png`;
    const result = await copyStorageBytes(`yaar://storage/${SCRATCH}/absent.png`, destPath);
    expect(result).toHaveProperty('error');
    expect(await Bun.file(resolvePath(destPath)!.absolutePath).exists()).toBe(false);
  });

  it('refuses a source that is not a storage URI', async () => {
    const result = await copyStorageBytes('yaar://session/browser', `${SCRATCH}/x.png`);
    expect(result).toHaveProperty('error');
  });

  it('refuses a traversing source', async () => {
    const result = await copyStorageBytes(
      'yaar://storage/../config/credentials.json',
      `${SCRATCH}/stolen.json`,
    );
    expect(result).toHaveProperty('error');
  });
});
