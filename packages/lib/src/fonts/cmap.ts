/**
 * A `cmap` that maps only the characters a subset kept.
 *
 * The subsetters empty a dropped glyph's outline but keep its index, so the
 * original `cmap` would go on claiming every character the full face had. A
 * browser trusts that claim: a character outside the subset would pick this
 * face and render as an empty glyph instead of falling back to the next family
 * in the stack. Rewriting `cmap` to the kept characters makes the subset say
 * what it can draw. Glyph ids are unchanged, so layout of the kept characters
 * is not.
 *
 * Format 4 serves the BMP under (0,3) and (3,1); format 12 is added under (0,4)
 * and (3,10) only when a kept character lies above it. Each segment is a run of
 * consecutive code points with consecutive glyph ids, so `idDelta` alone maps
 * it and no `glyphIdArray` is needed.
 */

interface Run {
  start: number;
  end: number;
  gid: number;
}

function runs(entries: [number, number][]): Run[] {
  const out: Run[] = [];
  for (const [cp, gid] of entries) {
    const last = out[out.length - 1];
    if (last && cp === last.end + 1 && gid === last.gid + (cp - last.start)) last.end = cp;
    else out.push({ start: cp, end: cp, gid });
  }
  return out;
}

function format4(bmp: Run[]): Uint8Array {
  // The mandatory last segment maps 0xFFFF to .notdef.
  const segs = [...bmp, { start: 0xffff, end: 0xffff, gid: 0 }];
  const segCount = segs.length;
  const length = 16 + segCount * 8;
  if (length > 0xffff) throw new Error(`cmap format 4 overflow: ${segCount} segments`);
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  let searchRange = 2;
  let entrySelector = 0;
  while (searchRange * 2 <= segCount * 2) {
    searchRange *= 2;
    entrySelector++;
  }
  view.setUint16(0, 4);
  view.setUint16(2, length);
  view.setUint16(6, segCount * 2);
  view.setUint16(8, searchRange);
  view.setUint16(10, entrySelector);
  view.setUint16(12, segCount * 2 - searchRange);
  const ends = 14;
  const starts = ends + segCount * 2 + 2;
  const deltas = starts + segCount * 2;
  segs.forEach((seg, i) => {
    view.setUint16(ends + i * 2, seg.end);
    view.setUint16(starts + i * 2, seg.start);
    // .notdef for the sentinel: 0xFFFF + 1 wraps to 0.
    view.setUint16(deltas + i * 2, seg.start === 0xffff ? 1 : (seg.gid - seg.start) & 0xffff);
  });
  // idRangeOffset[] stays zero.
  return out;
}

function format12(all: Run[]): Uint8Array {
  const out = new Uint8Array(16 + all.length * 12);
  const view = new DataView(out.buffer);
  view.setUint16(0, 12);
  view.setUint32(4, out.length);
  view.setUint32(12, all.length);
  all.forEach((run, i) => {
    const at = 16 + i * 12;
    view.setUint32(at, run.start);
    view.setUint32(at + 4, run.end);
    view.setUint32(at + 8, run.gid);
  });
  return out;
}

/** Build a `cmap` table for these code point -> glyph id pairs. */
export function buildCmap(map: Map<number, number>): Uint8Array {
  const entries = Array.from(map).sort((a, b) => a[0] - b[0]);
  const all = runs(entries);
  const bmp = runs(entries.filter(([cp]) => cp < 0xffff));
  const sub4 = format4(bmp);
  const sub12 = entries.some(([cp]) => cp > 0xffff) ? format12(all) : null;

  // Records sorted by (platformID, encodingID), as the spec requires.
  const records: [number, number, 'f4' | 'f12'][] = sub12
    ? [
        [0, 3, 'f4'],
        [0, 4, 'f12'],
        [3, 1, 'f4'],
        [3, 10, 'f12'],
      ]
    : [
        [0, 3, 'f4'],
        [3, 1, 'f4'],
      ];
  const header = 4 + records.length * 8;
  const at4 = header;
  const at12 = at4 + sub4.length;
  const out = new Uint8Array(at12 + (sub12?.length ?? 0));
  const view = new DataView(out.buffer);
  view.setUint16(2, records.length);
  records.forEach(([platform, encoding, which], i) => {
    view.setUint16(4 + i * 8, platform);
    view.setUint16(6 + i * 8, encoding);
    view.setUint32(8 + i * 8, which === 'f4' ? at4 : at12);
  });
  out.set(sub4, at4);
  if (sub12) out.set(sub12, at12);
  return out;
}
