/**
 * Pixel dimensions from an image's header bytes — PNG, JPEG, WebP and GIF — without decoding
 * it. A texture's size is the one fact about it a model summary wants, and a decoder would
 * cost more than the rest of the summary together.
 */

export interface ImageHeader {
  mimeType: string;
  width: number;
  height: number;
}

export function readImageHeader(b: Uint8Array): ImageHeader | null {
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { mimeType: 'image/png', width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return jpeg(b);
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return webp(b);
  if (b.length >= 10 && ascii(b, 0, 4) === 'GIF8') {
    return { mimeType: 'image/gif', width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
  }
  return null;
}

function jpeg(b: Uint8Array): ImageHeader | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return {
        mimeType: 'image/jpeg',
        height: (b[i + 5] << 8) | b[i + 6],
        width: (b[i + 7] << 8) | b[i + 8],
      };
    }
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return null;
}

function webp(b: Uint8Array): ImageHeader | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ') {
    return {
      mimeType: 'image/webp',
      width: (b[26] | (b[27] << 8)) & 0x3fff,
      height: (b[28] | (b[29] << 8)) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    return {
      mimeType: 'image/webp',
      width: 1 + (((b[22] & 0x3f) << 8) | b[21]),
      height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)),
    };
  }
  if (chunk === 'VP8X') {
    return {
      mimeType: 'image/webp',
      width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
      height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
    };
  }
  return null;
}

function u32be(b: Uint8Array, at: number): number {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
}

function ascii(b: Uint8Array, at: number, len: number): string {
  return String.fromCharCode(...b.subarray(at, at + len));
}
