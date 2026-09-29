/**
 * `sniffImageMediaType` / `captureForModel` — a capture's type read off its bytes.
 *
 * A canvas asked for `image/webp` on WebKit returns PNG, and the server used to stamp
 * `image/webp` on whatever came back. What is pinned here is the one property that matters
 * downstream: the type handed on always describes the bytes handed on.
 */
import { describe, it, expect } from 'bun:test';
import { crc32, deflateSync } from 'node:zlib';
import { captureForModel, sniffImageMediaType } from '../image.js';

/** A PNG chunk: length, type, data, CRC over type + data. */
function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
  return out;
}

/** A 64×64 opaque RGB PNG with some texture, so a WebP re-encode has something to win on. */
async function png(): Promise<Buffer> {
  const w = 64;
  const h = 64;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1); // filter byte 0 (none) leads each row
    for (let x = 0; x < w; x++)
      raw.set([(x * 4) % 256, (y * 4) % 256, (x * y) % 256], row + 1 + x * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit, truecolor, deflate, no filter, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

describe('sniffImageMediaType', () => {
  it('reads each format off its magic number', async () => {
    const pngBytes = await png();
    expect(sniffImageMediaType(pngBytes)).toBe('image/png');
    const webp = Buffer.from(await new Bun.Image(pngBytes).webp().buffer());
    expect(sniffImageMediaType(webp)).toBe('image/webp');
    expect(sniffImageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageMediaType(Buffer.from('GIF89a'))).toBe('image/gif');
  });

  it('does not take a RIFF container for WebP unless it says WEBP', () => {
    expect(sniffImageMediaType(Buffer.from('RIFF\0\0\0\0WAVEfmt '))).toBeNull();
    expect(sniffImageMediaType(Buffer.from('not an image'))).toBeNull();
    expect(sniffImageMediaType(new Uint8Array(0))).toBeNull();
  });
});

describe('captureForModel', () => {
  it('re-encodes a PNG capture, and labels what it returns by what it is', async () => {
    const out = await captureForModel((await png()).toString('base64'));
    expect(sniffImageMediaType(Buffer.from(out.data, 'base64'))).toBe(out.mimeType as never);
  });

  it('passes a WebP capture through untouched', async () => {
    const webp = Buffer.from(await new Bun.Image(await png()).webp().buffer()).toString('base64');
    expect(await captureForModel(webp)).toEqual({ data: webp, mimeType: 'image/webp' });
  });
});
