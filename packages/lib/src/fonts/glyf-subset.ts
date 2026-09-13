/**
 * TrueType subsetter: `glyf` + `loca` + the glyphs you want -> a smaller `glyf`
 * and the `loca` that addresses it.
 *
 * The counterpart to `cff-subset.ts`, and it exists for the same reason that one
 * does: a face has to be small enough to inline as a `data:` URL. The two are
 * kept apart rather than unified because they share no bytes -- CFF is a nest of
 * DICTs with self-referential offsets, `glyf` is a flat array behind an index --
 * and `otf.ts` already says which of them a face needs.
 *
 * ## Indices are preserved, always
 *
 * There is no renumbering mode here, unlike the CFF side. `cmap`, `hmtx`, `GPOS`
 * and `GSUB` all address glyphs by index, and this subset is meant to be dropped
 * back into the original file with those tables untouched (`rebuildSfnt`). A
 * dropped glyph therefore keeps its index and gets a zero-length span in `loca`,
 * which is how TrueType spells "no outline" -- the same encoding a space uses.
 *
 * ## Composites pull their components in
 *
 * A composite glyph is a list of references to other glyphs. Keeping the
 * composite and dropping what it points at would render it as nothing, so
 * `expandComposites` walks the references transitively before anything is
 * written. Depth is bounded by the glyph count, so a font whose composites
 * reference each other in a cycle terminates rather than hanging.
 *
 * ## `loca` is always written long
 *
 * The short format stores offsets halved, so it cannot address a `glyf` past
 * 128 KB and it forces every glyph onto an even boundary. Writing the long
 * format unconditionally costs 2 bytes per glyph and removes both constraints --
 * but `head.indexToLocFormat` has to agree, which is why this module returns a
 * patched `head` rather than leaving the caller to remember.
 */

/** Composite-glyph component flags, from the `glyf` table spec. */
const ARG_1_AND_2_ARE_WORDS = 0x0001;
const WE_HAVE_A_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;

/** Glyph ids a composite glyph references directly. Empty for a simple glyph. */
function componentsOf(glyph: Uint8Array): number[] {
  // Fewer than 10 bytes is not even a glyph header, and a non-negative contour
  // count is a simple glyph — neither references anything.
  if (glyph.length < 10) return [];
  const view = new DataView(glyph.buffer, glyph.byteOffset, glyph.byteLength);
  if (view.getInt16(0) >= 0) return [];

  const out: number[] = [];
  let p = 10;
  for (;;) {
    // A truncated component list is a malformed glyph; stop rather than read past it.
    if (p + 4 > glyph.length) break;
    const flags = view.getUint16(p);
    out.push(view.getUint16(p + 2));
    p += 4;
    p += flags & ARG_1_AND_2_ARE_WORDS ? 4 : 2;
    if (flags & WE_HAVE_A_SCALE) p += 2;
    else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) p += 4;
    else if (flags & WE_HAVE_A_TWO_BY_TWO) p += 8;
    if (!(flags & MORE_COMPONENTS)) break;
  }
  return out;
}

/** Close a glyph set over composite references. */
function expandComposites(
  wanted: Set<number>,
  glyphAt: (gid: number) => Uint8Array,
  numGlyphs: number,
): Set<number> {
  const kept = new Set(wanted);
  const queue = Array.from(wanted);
  while (queue.length) {
    const gid = queue.pop()!;
    if (gid < 0 || gid >= numGlyphs) continue;
    for (const component of componentsOf(glyphAt(gid))) {
      if (kept.has(component) || component >= numGlyphs) continue;
      kept.add(component);
      queue.push(component);
    }
  }
  return kept;
}

export interface GlyfSubset {
  glyf: Uint8Array;
  /** Long-format `loca`: `numGlyphs + 1` big-endian uint32 offsets. */
  loca: Uint8Array;
  /** `head` with `indexToLocFormat` forced to long, to match `loca`. */
  head: Uint8Array;
  /** Glyph ids that kept their outline, ascending — composites included. */
  gids: number[];
}

/**
 * Keep the outlines of `wanted` (plus anything they reference), drop the rest.
 *
 * `.notdef` is always kept: it is glyph 0 by definition, and it is what a
 * renderer draws for a character the subset does not cover.
 */
export function subsetGlyf(
  glyf: Uint8Array,
  loca: Uint32Array,
  head: Uint8Array,
  wanted: Iterable<number>,
): GlyfSubset {
  const numGlyphs = loca.length - 1;
  const glyphAt = (gid: number): Uint8Array => glyf.subarray(loca[gid], loca[gid + 1]);

  const requested = new Set<number>([0]);
  for (const gid of wanted) {
    if (Number.isInteger(gid) && gid >= 0 && gid < numGlyphs) requested.add(gid);
  }
  const kept = expandComposites(requested, glyphAt, numGlyphs);

  // Sized first so the output is written once rather than grown. Each glyph is
  // padded to 4 bytes: the spec only requires alignment in the short format, but
  // some rasterisers still assume it and the cost is at most 3 bytes per glyph.
  const pad = (n: number): number => (n + 3) & ~3;
  let total = 0;
  for (const gid of kept) total += pad(glyphAt(gid).length);

  const out = new Uint8Array(total);
  const offsets = new Uint32Array(numGlyphs + 1);
  let cursor = 0;
  for (let gid = 0; gid < numGlyphs; gid++) {
    offsets[gid] = cursor;
    if (!kept.has(gid)) continue;
    const glyph = glyphAt(gid);
    // A glyph with no contours is stored as zero bytes, not as an empty header,
    // so an already-blank glyph costs nothing to keep.
    if (glyph.length === 0) continue;
    out.set(glyph, cursor);
    cursor += pad(glyph.length);
  }
  offsets[numGlyphs] = cursor;

  const locaBytes = new Uint8Array((numGlyphs + 1) * 4);
  const locaView = new DataView(locaBytes.buffer);
  for (let i = 0; i <= numGlyphs; i++) locaView.setUint32(i * 4, offsets[i]);

  const headBytes = new Uint8Array(head);
  new DataView(headBytes.buffer).setInt16(50, 1);

  return {
    glyf: out.subarray(0, cursor),
    loca: locaBytes,
    head: headBytes,
    gids: Array.from(kept).sort((a, b) => a - b),
  };
}
