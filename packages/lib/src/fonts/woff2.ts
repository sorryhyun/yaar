/**
 * Wrap an OpenType file as WOFF2.
 *
 * Only the null transform: every table goes into the compressed stream as it
 * is, which is all a CFF face can get anyway (WOFF2's transforms are for `glyf`,
 * `loca` and `hmtx`). Brotli over the concatenated tables does the work, and on
 * a Hangul subset that is most of the gain. A TrueType face is written with
 * `glyf` and `loca` marked null-transformed (version 3), which decoders accept.
 *
 * Spec: https://www.w3.org/TR/WOFF2/
 */

import { brotliCompressSync, constants } from 'node:zlib';

/** The table tags WOFF2 encodes in the flags byte instead of spelling out. */
const KNOWN_TAGS = (
  'cmap|head|hhea|hmtx|maxp|name|OS/2|post|cvt |fpgm|glyf|loca|prep|CFF |VORG|EBDT|' +
  'EBLC|gasp|hdmx|kern|LTSH|PCLT|VDMX|vhea|vmtx|BASE|GDEF|GPOS|GSUB|EBSC|JSTF|MATH|' +
  'CBDT|CBLC|COLR|CPAL|SVG |sbix|acnt|avar|bdat|bloc|bsln|cvar|fdsc|feat|fmtx|fvar|' +
  'gvar|hsty|just|lcar|mort|morx|opbd|prop|trak|Zapf|Silf|Glat|Gloc|Feat|Sill'
).split('|');

/** UIntBase128: big-endian groups of 7 bits, high bit set on all but the last. */
function base128(n: number): number[] {
  const out = [n & 0x7f];
  for (n = Math.floor(n / 128); n > 0; n = Math.floor(n / 128)) out.unshift((n & 0x7f) | 0x80);
  return out;
}

function readDirectory(view: DataView): [string, { offset: number; length: number }][] {
  const tables: [string, { offset: number; length: number }][] = [];
  const count = view.getUint16(4);
  for (let i = 0; i < count; i++) {
    const rec = 12 + i * 16;
    let tag = '';
    for (let c = 0; c < 4; c++) tag += String.fromCharCode(view.getUint8(rec + c));
    tables.push([tag, { offset: view.getUint32(rec + 8), length: view.getUint32(rec + 12) }]);
  }
  // The directory order is the stream order.
  return tables.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

export function sfntToWoff2(sfnt: Uint8Array): Uint8Array {
  const sfntView = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const tables = readDirectory(sfntView);

  const directory: number[] = [];
  let streamLength = 0;
  let sfntSize = 12 + tables.length * 16;
  for (const [tag, rec] of tables) {
    const known = KNOWN_TAGS.indexOf(tag);
    // Transform version 3 is the null transform for glyf/loca; 0 is for everything else.
    const version = tag === 'glyf' || tag === 'loca' ? 3 : 0;
    directory.push((version << 6) | (known < 0 ? 63 : known));
    if (known < 0) for (let c = 0; c < 4; c++) directory.push(tag.charCodeAt(c));
    directory.push(...base128(rec.length));
    streamLength += rec.length;
    sfntSize += (rec.length + 3) & ~3;
  }

  const stream = new Uint8Array(streamLength);
  let at = 0;
  for (const [, rec] of tables) {
    stream.set(sfnt.subarray(rec.offset, rec.offset + rec.length), at);
    at += rec.length;
  }
  const compressed = brotliCompressSync(stream, {
    params: {
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_FONT,
      [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
      [constants.BROTLI_PARAM_SIZE_HINT]: stream.length,
    },
  });

  const headerSize = 48;
  const length = (headerSize + directory.length + compressed.length + 3) & ~3;
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x774f4632); // 'wOF2'
  view.setUint32(4, sfntView.getUint32(0)); // flavor
  view.setUint32(8, length);
  view.setUint16(12, tables.length);
  view.setUint32(16, sfntSize);
  view.setUint32(20, compressed.length);
  view.setUint16(24, 1); // majorVersion
  // minorVersion and the metadata/private block fields stay zero.
  out.set(directory, headerSize);
  out.set(compressed, headerSize + directory.length);
  return out;
}
