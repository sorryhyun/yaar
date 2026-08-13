/**
 * Just enough OpenType to place and subset glyphs.
 *
 * Deliberately stops at the container: it reads the tables needed to *position*
 * text (cmap, hmtx, head, hhea, maxp, OS/2) and hands the outline table to
 * whichever subsetter owns it -- `cff-subset.ts` for `OTTO` files, which carry
 * PostScript outlines in a `CFF ` table, and `glyf-subset.ts` for TrueType
 * files, which carry quadratic outlines in `glyf` addressed through `loca`.
 *
 * Which of the two a face uses is not a detail a caller should have to know, so
 * `outlines` names it once and `lib/fonts/index.ts` branches on that alone.
 *
 * Reading is done over a `DataView` rather than by expanding tables into maps:
 * a Korean face maps tens of thousands of code points and a subset request
 * touches a few hundred.
 */

export interface TableRecord {
  offset: number;
  length: number;
}

/** Which table carries the glyph outlines, and therefore which subsetter applies. */
export type OutlineFormat = 'cff' | 'glyf';

export interface OpenTypeFont {
  bytes: Uint8Array;
  view: DataView;
  tables: Map<string, TableRecord>;
  outlines: OutlineFormat;
  unitsPerEm: number;
  numGlyphs: number;
  /** Typographic ascent/descent in font units; descent is negative. */
  ascent: number;
  descent: number;
  capHeight: number;
  /** [xMin, yMin, xMax, yMax] in font units. */
  bbox: [number, number, number, number];
  /** True when the face declares itself monospaced (`post.isFixedPitch`). */
  fixedPitch: boolean;
  /** Glyph id for a code point; 0 (.notdef) when the font has no glyph. */
  gidFor(cp: number): number;
  /** Advance width in font units. */
  advance(gid: number): number;
  /** The raw `CFF ` table, or null for a TrueType-flavoured file. */
  cff(): Uint8Array | null;
  /**
   * `loca` as absolute `glyf` offsets, or null for a CFF file.
   *
   * Returned decoded rather than raw because `loca` is the one table whose
   * width depends on another (`head.indexToLocFormat`), and every reader of it
   * would otherwise repeat that branch.
   */
  loca(): Uint32Array | null;
  glyf(): Uint8Array | null;
}

function tag(view: DataView, at: number): string {
  return String.fromCharCode(
    view.getUint8(at),
    view.getUint8(at + 1),
    view.getUint8(at + 2),
    view.getUint8(at + 3),
  );
}

/**
 * Build a code-point -> glyph lookup from the best available cmap subtable.
 *
 * Format 12 is preferred where present because it covers the whole code space;
 * format 4 is the BMP-only fallback every font has.
 */
function buildCmap(view: DataView, base: number): (cp: number) => number {
  const count = view.getUint16(base + 2);
  let best = -1;
  let bestScore = -1;
  let bestFormat = 0;

  for (let i = 0; i < count; i++) {
    const rec = base + 4 + i * 8;
    const platform = view.getUint16(rec);
    const encoding = view.getUint16(rec + 2);
    const offset = base + view.getUint32(rec + 4);
    const format = view.getUint16(offset);
    // Unicode full repertoire beats Unicode BMP beats anything else.
    let score = -1;
    if (
      format === 12 &&
      ((platform === 3 && encoding === 10) || (platform === 0 && encoding >= 4))
    ) {
      score = 3;
    } else if (format === 4 && ((platform === 3 && encoding === 1) || platform === 0)) {
      score = 2;
    } else if (format === 4 || format === 12) {
      score = 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = offset;
      bestFormat = format;
    }
  }

  if (best < 0) return () => 0;

  if (bestFormat === 12) {
    const groups = view.getUint32(best + 12);
    return (cp) => {
      let lo = 0;
      let hi = groups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const g = best + 16 + mid * 12;
        const start = view.getUint32(g);
        const end = view.getUint32(g + 4);
        if (cp < start) hi = mid - 1;
        else if (cp > end) lo = mid + 1;
        else return view.getUint32(g + 8) + (cp - start);
      }
      return 0;
    };
  }

  const segX2 = view.getUint16(best + 6);
  const endBase = best + 14;
  const startBase = endBase + segX2 + 2;
  const deltaBase = startBase + segX2;
  const rangeBase = deltaBase + segX2;
  return (cp) => {
    if (cp > 0xffff) return 0;
    for (let s = 0; s < segX2 / 2; s++) {
      if (cp > view.getUint16(endBase + s * 2)) continue;
      const start = view.getUint16(startBase + s * 2);
      if (cp < start) return 0;
      const rangeOffset = view.getUint16(rangeBase + s * 2);
      const delta = view.getInt16(deltaBase + s * 2);
      if (rangeOffset === 0) return (cp + delta) & 0xffff;
      const at = rangeBase + s * 2 + rangeOffset + (cp - start) * 2;
      const gid = view.getUint16(at);
      return gid === 0 ? 0 : (gid + delta) & 0xffff;
    }
    return 0;
  };
}

export function parseOpenType(buffer: ArrayBuffer): OpenTypeFont {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const numTables = view.getUint16(4);
  const tables = new Map<string, TableRecord>();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    tables.set(tag(view, rec), {
      offset: view.getUint32(rec + 8),
      length: view.getUint32(rec + 12),
    });
  }

  const need = (name: string): TableRecord => {
    const rec = tables.get(name);
    if (!rec) throw new Error(`Font is missing the required '${name}' table.`);
    return rec;
  };

  const head = need('head').offset;
  const hhea = need('hhea').offset;
  const maxp = need('maxp').offset;
  const hmtx = need('hmtx').offset;

  const unitsPerEm = view.getUint16(head + 18) || 1000;
  const numGlyphs = view.getUint16(maxp + 4);
  const numberOfHMetrics = view.getUint16(hhea + 34);
  const indexToLocFormat = view.getInt16(head + 50);

  // The outline table is what a subsetter dispatches on, so a face carrying
  // neither is refused here rather than half a pipeline later.
  const outlines: OutlineFormat = tables.has('CFF ')
    ? 'cff'
    : tables.has('glyf') && tables.has('loca')
      ? 'glyf'
      : (() => {
          throw new Error("Font has neither a 'CFF ' table nor 'glyf'/'loca'.");
        })();

  const os2 = tables.get('OS/2');
  let capHeight = Math.round(unitsPerEm * 0.7);
  if (os2 && view.getUint16(os2.offset) >= 2 && os2.length >= 90) {
    const value = view.getInt16(os2.offset + 88);
    if (value > 0) capHeight = value;
  }

  const post = tables.get('post');
  const fixedPitch = post ? view.getUint32(post.offset + 12) !== 0 : false;

  const gidFor = buildCmap(view, need('cmap').offset);

  return {
    bytes,
    view,
    tables,
    outlines,
    unitsPerEm,
    numGlyphs,
    ascent: view.getInt16(hhea + 4),
    descent: view.getInt16(hhea + 6),
    capHeight,
    bbox: [
      view.getInt16(head + 36),
      view.getInt16(head + 38),
      view.getInt16(head + 40),
      view.getInt16(head + 42),
    ],
    fixedPitch,
    gidFor,
    advance(gid) {
      // Trailing glyphs share the last entry's advance; only the side bearing
      // varies, and that is stored separately.
      const index = Math.min(gid, numberOfHMetrics - 1);
      if (index < 0) return unitsPerEm;
      return view.getUint16(hmtx + index * 4);
    },
    cff() {
      const rec = tables.get('CFF ');
      return rec ? bytes.subarray(rec.offset, rec.offset + rec.length) : null;
    },
    loca() {
      const rec = tables.get('loca');
      if (!rec) return null;
      // Short format stores offsets halved, so every read is doubled back.
      const out = new Uint32Array(numGlyphs + 1);
      for (let i = 0; i <= numGlyphs; i++) {
        out[i] =
          indexToLocFormat === 0
            ? view.getUint16(rec.offset + i * 2) * 2
            : view.getUint32(rec.offset + i * 4);
      }
      return out;
    },
    glyf() {
      const rec = tables.get('glyf');
      return rec ? bytes.subarray(rec.offset, rec.offset + rec.length) : null;
    },
  };
}
