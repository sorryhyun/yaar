/**
 * CFF subsetter: original `CFF ` table + the glyphs you want -> a new `CFF `
 * table containing only those glyphs.
 *
 * Pure and standalone on purpose -- bytes in, bytes out, no DOM, no PDF, no
 * filesystem. It can be exercised and checked on its own, which is the whole
 * correctness argument for a subsetter.
 *
 * ## Why this is tractable at all
 *
 * A general CFF subsetter is a big piece of work. NanumSquareNeo -- the face
 * this was written against, and the one the platform serves -- is not the
 * general case, and measuring it first is what made the scope honest:
 *
 * - It is CID-keyed, but `FDArray` holds exactly **one** Font DICT, so there is
 *   no per-glyph FD mapping to rebuild -- `FDSelect` collapses to a single range.
 * - There are **zero** global subroutines, so no global subr renumbering.
 * - Local subrs are a rounding error next to `CharStrings` (which is 99.99% of
 *   the table), so they are copied verbatim. Indices and the subr bias are
 *   therefore unchanged, which means **charstrings never have to be parsed** --
 *   by far the largest saving, and the reason this is ~300 lines instead of
 *   thousands.
 * - `charset` is identity (CID == GID), so a glyph keeps its CID and a PDF
 *   content stream can address it by the same number as in the source font.
 *
 * ## Offsets
 *
 * DICT operands are variable-length, so changing an offset can change how many
 * bytes it occupies and shift everything after it. Every offset written here is
 * forced to the 5-byte `29` form, which makes each rebuilt DICT a fixed size --
 * so the layout can be measured once with placeholders and then rewritten with
 * real values, with no iteration to a fixed point.
 */

/** DICT operators this module rewrites. Everything else is copied byte for byte. */
const OP_CHARSET = 15;
const OP_CHARSTRINGS = 17;
const OP_PRIVATE = 18;
const OP_SUBRS = 19;
const OP_FDARRAY = 1236;
const OP_FDSELECT = 1237;

interface CffIndex {
  start: number;
  end: number;
  count: number;
  items: Uint8Array[];
}

interface DictEntry {
  op: number;
  /** The operand bytes exactly as they appeared, so reals survive a rebuild. */
  operands: Uint8Array;
  values: number[];
}

function readIndex(data: Uint8Array, start: number): CffIndex {
  const count = (data[start] << 8) | data[start + 1];
  if (count === 0) return { start, end: start + 2, count: 0, items: [] };

  const offSize = data[start + 2];
  const offsetsAt = start + 3;
  const at = (i: number): number => {
    let value = 0;
    for (let b = 0; b < offSize; b++) value = value * 256 + data[offsetsAt + i * offSize + b];
    return value;
  };
  // Offsets are 1-based from the byte *before* the data block.
  const dataAt = offsetsAt + (count + 1) * offSize - 1;
  const items: Uint8Array[] = [];
  for (let i = 0; i < count; i++) items.push(data.subarray(dataAt + at(i), dataAt + at(i + 1)));
  return { start, end: dataAt + at(count), count, items };
}

function writeIndex(items: Uint8Array[]): Uint8Array {
  if (!items.length) return new Uint8Array([0, 0]);

  const total = items.reduce((n, item) => n + item.length, 0);
  const offSize = total + 1 < 0x100 ? 1 : total + 1 < 0x10000 ? 2 : total + 1 < 0x1000000 ? 3 : 4;
  const out = new Uint8Array(3 + (items.length + 1) * offSize + total);
  out[0] = items.length >> 8;
  out[1] = items.length & 0xff;
  out[2] = offSize;

  let offset = 1;
  let cursor = 3;
  const putOffset = (value: number) => {
    for (let b = offSize - 1; b >= 0; b--)
      out[cursor + b] = (value >> (8 * (offSize - 1 - b))) & 0xff;
    cursor += offSize;
  };
  putOffset(offset);
  for (const item of items) {
    offset += item.length;
    putOffset(offset);
  }
  for (const item of items) {
    out.set(item, cursor);
    cursor += item.length;
  }
  return out;
}

function parseDict(data: Uint8Array): DictEntry[] {
  const entries: DictEntry[] = [];
  let operandStart = 0;
  let values: number[] = [];
  let p = 0;

  while (p < data.length) {
    const b0 = data[p];
    if (b0 <= 21) {
      let op = b0;
      let next = p + 1;
      if (b0 === 12) {
        op = 1200 + data[p + 1];
        next = p + 2;
      }
      entries.push({ op, operands: data.subarray(operandStart, p), values });
      values = [];
      p = next;
      operandStart = p;
    } else if (b0 === 28) {
      values.push((((data[p + 1] << 8) | data[p + 2]) << 16) >> 16);
      p += 3;
    } else if (b0 === 29) {
      values.push((data[p + 1] << 24) | (data[p + 2] << 16) | (data[p + 3] << 8) | data[p + 4]);
      p += 5;
    } else if (b0 === 30) {
      // Real number: nibble-encoded, terminated by 0xf. The value is never
      // needed here -- only its bytes, which are copied through untouched.
      p++;
      while (p < data.length) {
        const byte = data[p++];
        if ((byte & 0x0f) === 0x0f || byte >> 4 === 0x0f) break;
      }
      values.push(0);
    } else if (b0 >= 32 && b0 <= 246) {
      values.push(b0 - 139);
      p += 1;
    } else if (b0 >= 247 && b0 <= 250) {
      values.push((b0 - 247) * 256 + data[p + 1] + 108);
      p += 2;
    } else if (b0 >= 251 && b0 <= 254) {
      values.push(-(b0 - 251) * 256 - data[p + 1] - 108);
      p += 2;
    } else {
      p += 1;
    }
  }
  return entries;
}

/** An integer in the fixed 5-byte form, so a rebuilt DICT never changes size. */
function int32Operand(value: number): Uint8Array {
  return new Uint8Array([
    29,
    (value >> 24) & 0xff,
    (value >> 16) & 0xff,
    (value >> 8) & 0xff,
    value & 0xff,
  ]);
}

function operatorBytes(op: number): Uint8Array {
  return op >= 1200 ? new Uint8Array([12, op - 1200]) : new Uint8Array([op]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Rebuild a DICT, replacing the operands of the operators named in `overrides`
 * and copying every other entry's bytes verbatim.
 */
function rebuildDict(entries: DictEntry[], overrides: Map<number, number[]>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const replacement = overrides.get(entry.op);
    if (replacement) {
      for (const value of replacement) parts.push(int32Operand(value));
    } else {
      parts.push(entry.operands);
    }
    parts.push(operatorBytes(entry.op));
  }
  return concat(parts);
}

/**
 * charset format 2 as a single identity range: glyph i has CID i.
 *
 * Five bytes for the whole font, and it is exactly right whenever glyph indices
 * are preserved -- which is the mode that keeps `cmap`, `GPOS` and `hmtx` valid.
 */
function buildIdentityCharset(glyphCount: number): Uint8Array {
  const nLeft = Math.max(0, glyphCount - 2);
  return new Uint8Array([2, 0, 1, nLeft >> 8, nLeft & 0xff]);
}

/** charset format 0: one CID per glyph, `.notdef` implied. */
function buildCharset(gids: number[]): Uint8Array {
  const out = new Uint8Array(1 + (gids.length - 1) * 2);
  out[0] = 0;
  for (let i = 1; i < gids.length; i++) {
    // CID == original GID for this font, so a glyph keeps its identity and the
    // PDF can go on addressing it by its original number.
    out[1 + (i - 1) * 2] = gids[i] >> 8;
    out[2 + (i - 1) * 2] = gids[i] & 0xff;
  }
  return out;
}

/** FDSelect format 3, collapsed to one range because FDArray has one entry. */
function buildFdSelect(glyphCount: number): Uint8Array {
  const out = new Uint8Array(8);
  out[0] = 3;
  out[1] = 0;
  out[2] = 1; // one range
  out[3] = 0;
  out[4] = 0; // first glyph
  out[5] = 0; // font dict index
  out[6] = glyphCount >> 8;
  out[7] = glyphCount & 0xff;
  return out;
}

export interface CffInfo {
  isCID: boolean;
  glyphCount: number;
  charsetFormat: number;
  /** CID of each glyph, by glyph index. */
  cids: number[];
  fdArrayCount: number;
  hasFdSelect: boolean;
  charStrings: Uint8Array[];
}

/**
 * Read a CFF table back into its structure.
 *
 * Exists so `subsetCff` can be checked against its own output -- parse the
 * result, confirm the glyphs that survived are the ones asked for and that
 * their charstrings are byte-identical to the source. That check is the whole
 * correctness argument for a subsetter, and it needs no PDF and no DOM.
 */
export function inspectCff(cff: Uint8Array): CffInfo {
  const headerSize = cff[2];
  const nameIndex = readIndex(cff, headerSize);
  const topIndex = readIndex(cff, nameIndex.end);
  const stringIndex = readIndex(cff, topIndex.end);
  const gsubrIndex = readIndex(cff, stringIndex.end);
  void gsubrIndex;

  const entries = parseDict(topIndex.items[0]);
  const value = (op: number): number[] | undefined => entries.find((e) => e.op === op)?.values;

  const charStringsOffset = value(OP_CHARSTRINGS)?.[0] ?? 0;
  const charStrings = readIndex(cff, charStringsOffset);
  const fdArrayOffset = value(OP_FDARRAY)?.[0];
  const fdArrayCount = fdArrayOffset === undefined ? 0 : readIndex(cff, fdArrayOffset).count;

  const cids = new Array<number>(charStrings.count).fill(0);
  const charsetOffset = value(OP_CHARSET)?.[0] ?? 0;
  let charsetFormat = -1;
  // Offsets 0-2 are the predefined charsets, which carry no table.
  if (charsetOffset > 2) {
    charsetFormat = cff[charsetOffset];
    let glyph = 1;
    let p = charsetOffset + 1;
    if (charsetFormat === 0) {
      while (glyph < charStrings.count) {
        cids[glyph++] = (cff[p] << 8) | cff[p + 1];
        p += 2;
      }
    } else if (charsetFormat === 1 || charsetFormat === 2) {
      const wide = charsetFormat === 2;
      while (glyph < charStrings.count) {
        const first = (cff[p] << 8) | cff[p + 1];
        const left = wide ? (cff[p + 2] << 8) | cff[p + 3] : cff[p + 2];
        p += wide ? 4 : 3;
        for (let i = 0; i <= left && glyph < charStrings.count; i++) cids[glyph++] = first + i;
      }
    }
  }

  return {
    isCID: entries.some((e) => e.op === 1230),
    glyphCount: charStrings.count,
    charsetFormat,
    cids,
    fdArrayCount,
    hasFdSelect: value(OP_FDSELECT) !== undefined,
    charStrings: charStrings.items,
  };
}

export interface CffSubset {
  bytes: Uint8Array;
  /** Included glyph ids, ascending. Unchanged CIDs -- address them as-is. */
  gids: number[];
}

export interface SubsetOptions {
  /**
   * Keep every glyph index, emitting an empty outline for the ones dropped.
   *
   * Costs one byte plus an INDEX offset per unused glyph, and buys something
   * the renumbering mode cannot: `cmap`, `hmtx`, `GPOS` and `GSUB` all address
   * glyphs by index, so preserving indices means the *rest of the OpenType
   * file can be reused untouched*. That is what makes the subset loadable as a
   * CSS `@font-face` as well as embeddable in the PDF -- and both have to agree,
   * because the raster underlay and the vector text are laid out separately.
   *
   * It also keeps `GPOS` kerning intact, so Latin metrics match the full font
   * the measuring frame used.
   */
  preserveIndices?: boolean;
}

/** An empty charstring: `endchar` and nothing else. */
const EMPTY_CHARSTRING = new Uint8Array([14]);

export function subsetCff(
  cff: Uint8Array,
  wanted: Iterable<number>,
  options: SubsetOptions = {},
): CffSubset {
  const headerSize = cff[2];
  const nameIndex = readIndex(cff, headerSize);
  const topIndex = readIndex(cff, nameIndex.end);
  const stringIndex = readIndex(cff, topIndex.end);
  const gsubrIndex = readIndex(cff, stringIndex.end);

  const topEntries = parseDict(topIndex.items[0]);
  const find = (op: number): number[] | null => {
    const hit = topEntries.find((e) => e.op === op);
    return hit ? hit.values : null;
  };

  const charStringsOffset = find(OP_CHARSTRINGS)?.[0];
  const fdArrayOffset = find(OP_FDARRAY)?.[0];
  if (charStringsOffset === undefined || fdArrayOffset === undefined) {
    throw new Error('Not a CID-keyed CFF: no CharStrings or FDArray in the top DICT.');
  }
  const charStrings = readIndex(cff, charStringsOffset);

  const fdArray = readIndex(cff, fdArrayOffset);
  if (fdArray.count !== 1) {
    throw new Error(`Expected a single Font DICT, found ${fdArray.count}.`);
  }
  const fontEntries = parseDict(fdArray.items[0]);
  const privateSpec = fontEntries.find((e) => e.op === OP_PRIVATE)?.values;
  if (!privateSpec || privateSpec.length < 2) {
    throw new Error('Font DICT has no Private entry.');
  }
  const [privateSize, privateOffset] = privateSpec;
  const privateEntries = parseDict(cff.subarray(privateOffset, privateOffset + privateSize));

  // Local subrs live inside the Private DICT's span, addressed relative to it.
  const subrsRelative = privateEntries.find((e) => e.op === OP_SUBRS)?.values?.[0];
  let localSubrs: Uint8Array = new Uint8Array(0);
  if (subrsRelative !== undefined) {
    const subrsIndex = readIndex(cff, privateOffset + subrsRelative);
    localSubrs = cff.subarray(subrsIndex.start, subrsIndex.end);
  }

  // .notdef is mandatory and must stay glyph 0.
  const gids = Array.from(new Set([0, ...wanted]))
    .filter((g) => Number.isInteger(g) && g >= 0 && g < charStrings.count)
    .sort((a, b) => a - b);

  const nameRaw = cff.subarray(nameIndex.start, nameIndex.end);
  const stringRaw = cff.subarray(stringIndex.start, stringIndex.end);
  const gsubrRaw = cff.subarray(gsubrIndex.start, gsubrIndex.end);

  const keepIndices = options.preserveIndices === true;
  const glyphCount = keepIndices ? charStrings.count : gids.length;
  const kept = new Set(gids);

  const charsetBytes = keepIndices ? buildIdentityCharset(glyphCount) : buildCharset(gids);
  const fdSelectBytes = buildFdSelect(glyphCount);
  const charStringsBytes = keepIndices
    ? writeIndex(charStrings.items.map((item, gid) => (kept.has(gid) ? item : EMPTY_CHARSTRING)))
    : writeIndex(gids.map((g) => charStrings.items[g]));

  // Sizes first, with placeholder offsets. Every rewritten operand is the
  // fixed 5-byte integer form, so these lengths are already final.
  const privatePlaceholder = rebuildDict(
    privateEntries,
    subrsRelative === undefined ? new Map() : new Map([[OP_SUBRS, [0]]]),
  );
  const fontPlaceholder = rebuildDict(fontEntries, new Map([[OP_PRIVATE, [0, 0]]]));
  const fdArrayPlaceholder = writeIndex([fontPlaceholder]);
  const topPlaceholder = rebuildDict(
    topEntries,
    new Map([
      [OP_CHARSET, [0]],
      [OP_CHARSTRINGS, [0]],
      [OP_FDARRAY, [0]],
      [OP_FDSELECT, [0]],
    ]),
  );
  const topIndexPlaceholder = writeIndex([topPlaceholder]);

  let cursor = headerSize;
  cursor += nameRaw.length;
  cursor += topIndexPlaceholder.length;
  cursor += stringRaw.length;
  cursor += gsubrRaw.length;
  const charsetAt = cursor;
  cursor += charsetBytes.length;
  const fdSelectAt = cursor;
  cursor += fdSelectBytes.length;
  const charStringsAt = cursor;
  cursor += charStringsBytes.length;
  const fdArrayAt = cursor;
  cursor += fdArrayPlaceholder.length;
  const privateAt = cursor;

  const privateBytes = rebuildDict(
    privateEntries,
    // Local subrs go straight after the Private DICT, so the relative offset is
    // simply the DICT's own length.
    subrsRelative === undefined ? new Map() : new Map([[OP_SUBRS, [privatePlaceholder.length]]]),
  );
  const fontBytes = rebuildDict(
    fontEntries,
    new Map([[OP_PRIVATE, [privateBytes.length, privateAt]]]),
  );
  const fdArrayBytes = writeIndex([fontBytes]);
  const topBytes = rebuildDict(
    topEntries,
    new Map([
      [OP_CHARSET, [charsetAt]],
      [OP_CHARSTRINGS, [charStringsAt]],
      [OP_FDARRAY, [fdArrayAt]],
      [OP_FDSELECT, [fdSelectAt]],
    ]),
  );
  const topIndexBytes = writeIndex([topBytes]);

  // The fixed-width operand trick is the whole reason a single pass is enough;
  // if it ever stops holding, every offset above is silently wrong.
  if (
    topIndexBytes.length !== topIndexPlaceholder.length ||
    fdArrayBytes.length !== fdArrayPlaceholder.length ||
    privateBytes.length !== privatePlaceholder.length
  ) {
    throw new Error('CFF subset layout shifted after offsets were filled in.');
  }

  const header = new Uint8Array(headerSize);
  header.set(cff.subarray(0, headerSize));
  header[3] = 4; // absolute offsets are written 4 bytes wide

  return {
    bytes: concat([
      header,
      nameRaw,
      topIndexBytes,
      stringRaw,
      gsubrRaw,
      charsetBytes,
      fdSelectBytes,
      charStringsBytes,
      fdArrayBytes,
      privateBytes,
      localSubrs,
    ]),
    gids,
  };
}
