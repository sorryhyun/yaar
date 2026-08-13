/**
 * One face + the characters you need -> a font file carrying only those glyphs.
 *
 * This is the seam the two outline formats meet at, and the only place a caller
 * has to know they exist: `subsetFace` reads `font.outlines` and hands the work
 * to `cff-subset.ts` or `glyf-subset.ts`, then puts the result back into a
 * complete OpenType file with `rebuildSfnt`. Bytes in, bytes out — no
 * filesystem, no HTTP, no notion of which faces the platform ships. That lives
 * in `features/fonts/`.
 *
 * ## Why a whole file comes back, not just the outlines
 *
 * The subset has two consumers that lay text out *independently*: a CSS
 * `@font-face` (so a rasteriser draws real glyphs) and PDF `/FontFile3` bytes
 * (so an exporter paints them as vectors on top). If those two came from
 * different fonts, the boxes drawn in the picture would be laid out to different
 * metrics than the text placed over them — NanumSquareNeo and the system Hangul
 * fallback are ~1.8% apart on Hangul and ~10% on Latin, which is lines of drift
 * down a page. So both get the same bytes: the file for the `@font-face`, and
 * `outlineTable` (the raw `CFF `) for the PDF.
 *
 * ## Why the glyph ids come back too
 *
 * A PDF content stream addresses glyphs by id, not by character, so an embedder
 * needs the mapping. It cannot recompute it: `cmap` is inside the bytes it was
 * just handed, and parsing a font to write a PDF is exactly the work this module
 * exists to stop every app from repeating. `advances` rides along for the same
 * reason — a `/W` array is the other half of placing a glyph.
 */

import type { OpenTypeFont, OutlineFormat } from './otf.js';
import { subsetCff } from './cff-subset.js';
import { subsetGlyf } from './glyf-subset.js';
import { rebuildSfnt } from './sfnt.js';

export { parseOpenType, type OpenTypeFont, type OutlineFormat } from './otf.js';

export interface FaceMetrics {
  unitsPerEm: number;
  /** Typographic ascent/descent in font units; descent is negative. */
  ascent: number;
  descent: number;
  capHeight: number;
  /** [xMin, yMin, xMax, yMax] in font units. */
  bbox: [number, number, number, number];
}

export interface FaceSubset {
  /** A complete OpenType file — load it as a CSS `@font-face`. */
  bytes: Uint8Array;
  /**
   * The raw `CFF ` table, for a PDF `/FontFile3`. Null for a TrueType face,
   * whose outlines a PDF embeds as `/FontFile2` — the whole `bytes` file.
   */
  outlineTable: Uint8Array | null;
  outlines: OutlineFormat;
  /** Glyphs whose outlines survived, excluding the mandatory `.notdef`. */
  glyphs: number;
  /** Requested character -> glyph id. Characters the face lacks are absent. */
  gids: Record<string, number>;
  /** Requested character -> advance width, in font units. */
  advances: Record<string, number>;
  metrics: FaceMetrics;
}

export function faceMetrics(font: OpenTypeFont): FaceMetrics {
  return {
    unitsPerEm: font.unitsPerEm,
    ascent: font.ascent,
    descent: font.descent,
    capHeight: font.capHeight,
    bbox: font.bbox,
  };
}

/**
 * Subset `font` down to the glyphs `chars` needs.
 *
 * Glyph indices are preserved in both formats, which is what lets `cmap`,
 * `hmtx`, `GPOS` and `GSUB` be carried over untouched — so the subset lays text
 * out identically to the full face a caller measured against, and a PDF can go
 * on addressing glyphs by the numbers it already has.
 *
 * A character the face has no glyph for is simply absent from `gids`; it is not
 * an error, because the caller's fallback for it (leave it in the raster, draw
 * it from another face) is a decision this module cannot make.
 */
export function subsetFace(font: OpenTypeFont, chars: Iterable<string>): FaceSubset {
  const gids: Record<string, number> = {};
  const advances: Record<string, number> = {};
  const wanted = new Set<number>();

  for (const ch of chars) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    const gid = font.gidFor(cp);
    if (gid <= 0) continue;
    gids[ch] = gid;
    advances[ch] = font.advance(gid);
    wanted.add(gid);
  }

  if (font.outlines === 'cff') {
    const cff = font.cff();
    if (!cff) throw new Error("Font claims CFF outlines but has no 'CFF ' table.");
    const subset = subsetCff(cff, wanted, { preserveIndices: true });
    return {
      bytes: rebuildSfnt(font, new Map([['CFF ', subset.bytes]])),
      outlineTable: subset.bytes,
      outlines: 'cff',
      glyphs: wanted.size,
      gids,
      advances,
      metrics: faceMetrics(font),
    };
  }

  const glyf = font.glyf();
  const loca = font.loca();
  const head = font.tables.get('head');
  if (!glyf || !loca || !head) {
    throw new Error("Font claims TrueType outlines but is missing 'glyf', 'loca' or 'head'.");
  }
  const subset = subsetGlyf(
    glyf,
    loca,
    font.bytes.subarray(head.offset, head.offset + head.length),
    wanted,
  );
  return {
    bytes: rebuildSfnt(
      font,
      new Map([
        ['glyf', subset.glyf],
        ['loca', subset.loca],
        // `loca` is written long unconditionally, and `head.indexToLocFormat` is
        // what tells a reader so — a stale `head` would misread every offset.
        ['head', subset.head],
      ]),
    ),
    outlineTable: null,
    outlines: 'glyf',
    // Composites pull their components in, so the count is what survived, not
    // what was asked for.
    glyphs: Math.max(0, subset.gids.length - 1),
    gids,
    advances,
    metrics: faceMetrics(font),
  };
}
