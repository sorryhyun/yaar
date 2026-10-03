/**
 * The re-encode that happens on the way into a model context.
 *
 * A storage image read and a rasterized PDF page were the two paths still shipping
 * lossless bytes to a vision model. What matters is not just that they now transcode,
 * but the three cases where they must NOT: an animated container, a format already
 * WebP, and bytes that do not decode at all.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { toWebPForModel } from '@yaar/lib/image';
import { STORAGE_DIR } from '../config.js';
import { ensureStorageDir, storageRead } from '../storage/storage-manager.js';
import { makePng } from './helpers/png.js';

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
