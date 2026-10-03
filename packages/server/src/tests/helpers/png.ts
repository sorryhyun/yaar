/**
 * A real PNG, built here.
 *
 * `Bun.Image` has no raw-pixel constructor, and a checked-in base64 blob is a fact
 * nobody can inspect. Twenty lines of PNG container is cheaper than either, and the
 * gradient matters: a flat-colour image is exactly the case PNG wins, which would
 * exercise the "keep the original" branch of a re-encode instead of the one under test.
 */
import { deflateSync } from 'zlib';

function pngChunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(Bun.hash.crc32(typed) >>> 0);
  return Buffer.concat([len, typed, crc]);
}

export function makePng(width: number, height: number): Buffer {
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
