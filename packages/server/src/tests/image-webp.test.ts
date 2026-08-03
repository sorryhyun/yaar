/**
 * The re-encode that happens on the way into a model context.
 *
 * A storage image read and a rasterized PDF page were the two paths still shipping
 * lossless bytes to a vision model. What matters is not just that they now transcode,
 * but the three cases where they must NOT: an animated container, a format already
 * WebP, and bytes that do not decode at all.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { deflateSync } from 'zlib';
import { rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { toWebPForModel } from '../lib/image.js';
import { STORAGE_DIR } from '../config.js';
import { ensureStorageDir, storageRead } from '../storage/storage-manager.js';

// ── A real PNG, built here ────────────────────────────────────────────────
//
// `Bun.Image` has no raw-pixel constructor, and a checked-in base64 blob is a fact
// nobody can inspect. Twenty lines of PNG container is cheaper than either, and the
// gradient matters: a flat-colour image is exactly the case PNG wins, which would
// exercise the "keep the original" branch instead of the one under test.

function pngChunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(Bun.hash.crc32(typed) >>> 0);
  return Buffer.concat([len, typed, crc]);
}

function makePng(width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw[o++] = (x * 7 + y * 3) % 256;
      raw[o++] = (x * 13 + y * 29) % 256;
      raw[o++] = (x * 3 + y * 11) % 256;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('toWebPForModel', () => {
  it('re-encodes a PNG to WebP when that is smaller', async () => {
    const png = makePng(256, 256);
    const out = await toWebPForModel(png, 'image/png');
    expect(out.mimeType).toBe('image/webp');
    expect(out.data.length).toBeLessThan(png.length);
  });

  it('leaves an image that is already WebP alone', async () => {
    const webp = await new Bun.Image(makePng(64, 64)).webp({ quality: 85 }).buffer();
    const out = await toWebPForModel(webp, 'image/webp');
    expect(out.mimeType).toBe('image/webp');
    expect(out.data).toBe(webp);
  });

  it('leaves a GIF alone — a single-frame encode would drop the animation', async () => {
    const bytes = Buffer.from('GIF89a-stand-in');
    const out = await toWebPForModel(bytes, 'image/gif');
    expect(out.mimeType).toBe('image/gif');
    expect(out.data).toBe(bytes);
  });

  it('hands back the original when the bytes do not decode', async () => {
    const junk = Buffer.from('this is not a png');
    const out = await toWebPForModel(junk, 'image/png');
    expect(out.mimeType).toBe('image/png');
    expect(out.data).toBe(junk);
  });
});

describe('storageRead image branch', () => {
  const name = 'image-webp-test-gradient.png';
  afterAll(async () => {
    await rm(join(STORAGE_DIR, name), { force: true });
  });

  it('returns WebP for a stored PNG, and the stored bytes on request', async () => {
    const png = makePng(256, 256);
    await ensureStorageDir();
    await writeFile(join(STORAGE_DIR, name), png);

    const transcoded = await storageRead(name);
    expect(transcoded.success).toBe(true);
    expect(transcoded.images?.[0].mimeType).toBe('image/webp');
    expect(transcoded.images![0].data.length).toBeLessThan(png.toString('base64').length);
    // The note has to say the bytes are not the stored ones — a caller writing them back
    // out would otherwise silently change the file's format.
    expect(transcoded.content).toContain('re-encoded');

    const raw = await storageRead(name, { rawImage: true });
    expect(raw.images?.[0].mimeType).toBe('image/png');
    expect(raw.images?.[0].data).toBe(png.toString('base64'));
  });
});
