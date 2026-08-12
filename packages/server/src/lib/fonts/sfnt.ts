/**
 * Rebuild an OpenType file with some tables replaced.
 *
 * A subset is wanted in two places that lay text out independently: as a CSS
 * `@font-face` (so a rasteriser draws the real face) and as PDF `/FontFile3`
 * bytes (so an exporter can paint glyphs from it). Handing each a different font
 * is what misaligns a code block from the text sitting in it -- NanumSquareNeo
 * and the system Hangul fallback are ~10% apart on Latin, which is several
 * lines' worth of drift down a page.
 *
 * So the subsetted outline table is swapped back into the original file and
 * everything else is carried over untouched. That only works because both
 * subsetters preserve glyph indices: `cmap`, `hmtx`, `GPOS` and `GSUB` all
 * address glyphs by index, and reusing them verbatim is what keeps a browser's
 * layout identical to the full font it was measured against.
 */

import type { OpenTypeFont } from './otf.js';

/**
 * Tables that do not survive.
 *
 * `DSIG` is a digital signature over the original bytes, so keeping it after
 * rewriting the outlines would advertise a signature that no longer verifies.
 * The vertical-metrics tables go for size alone -- these subsets are base64'd
 * into a document, where every byte is paid for again on each page. Nothing
 * about horizontal layout reads them, so dropping them cannot move a glyph.
 */
const DROP = new Set(['DSIG', 'vmtx', 'vhea', 'VORG']);

function checksum(data: Uint8Array): number {
  let sum = 0;
  // A table is checksummed as big-endian uint32s, zero-padded to a multiple of 4.
  for (let i = 0; i < data.length; i += 4) {
    const b0 = data[i] ?? 0;
    const b1 = data[i + 1] ?? 0;
    const b2 = data[i + 2] ?? 0;
    const b3 = data[i + 3] ?? 0;
    sum = (sum + (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0)) >>> 0;
  }
  return sum >>> 0;
}

export function rebuildSfnt(font: OpenTypeFont, replacements: Map<string, Uint8Array>): Uint8Array {
  const tags = Array.from(font.tables.keys())
    .filter((tag) => !DROP.has(tag))
    .sort();

  const bodies = new Map<string, Uint8Array>();
  for (const tag of tags) {
    const replacement = replacements.get(tag);
    if (replacement) {
      bodies.set(tag, replacement);
      continue;
    }
    const rec = font.tables.get(tag)!;
    bodies.set(tag, font.bytes.subarray(rec.offset, rec.offset + rec.length));
  }

  const directorySize = 12 + tags.length * 16;
  let total = directorySize;
  const offsets = new Map<string, number>();
  for (const tag of tags) {
    offsets.set(tag, total);
    // Every table starts on a 4-byte boundary.
    total += (bodies.get(tag)!.length + 3) & ~3;
  }

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  // The sfnt version is what tells a consumer which outline table to look for,
  // so it has to follow the face rather than be assumed: 'OTTO' for PostScript
  // outlines, 1.0 as a fixed-point number for TrueType.
  view.setUint32(0, font.outlines === 'cff' ? 0x4f54544f : 0x00010000);
  view.setUint16(4, tags.length);
  // The binary-search hint fields. Consumers recompute or ignore them, but a
  // wrong power of two upsets strict validators.
  let searchRange = 16;
  let entrySelector = 0;
  while (searchRange * 2 <= tags.length * 16) {
    searchRange *= 2;
    entrySelector++;
  }
  view.setUint16(6, searchRange);
  view.setUint16(8, entrySelector);
  view.setUint16(10, tags.length * 16 - searchRange);

  tags.forEach((tag, i) => {
    const rec = 12 + i * 16;
    const body = bodies.get(tag)!;
    const offset = offsets.get(tag)!;
    for (let c = 0; c < 4; c++) out[rec + c] = tag.charCodeAt(c);
    view.setUint32(rec + 4, checksum(body));
    view.setUint32(rec + 8, offset);
    view.setUint32(rec + 12, body.length);
    out.set(body, offset);
  });

  // head.checkSumAdjustment covers the whole file and is therefore stale the
  // moment anything moves. Zeroing it is the conventional way to say so.
  const headOffset = offsets.get('head');
  if (headOffset !== undefined) view.setUint32(headOffset + 8, 0);

  return out;
}
