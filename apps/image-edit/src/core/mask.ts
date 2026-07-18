/**
 * Selection masks.
 *
 * A Mask is one byte per SOURCE pixel — 1 selected, 0 not. Source space, not
 * canvas space, so a selection survives rotation, flip, crop and resize the
 * same way `Doc.crop` does. Everything here is either pure (returns a new mask)
 * or an explicit in-place stamp used only on a scratch mask during a drag.
 *
 * `count` is carried on the mask rather than recomputed, because the UI asks
 * "is anything selected?" on every reactive read and an O(w*h) scan per read is
 * a real cost on a 12MP image. Any in-place mutation must end with `recount`.
 */

export type Mask = { w: number; h: number; data: Uint8Array; count: number };

export function createMask(w: number, h: number): Mask {
  return { w, h, data: new Uint8Array(w * h), count: 0 };
}

export function cloneMask(m: Mask): Mask {
  return { w: m.w, h: m.h, data: new Uint8Array(m.data), count: m.count };
}

/** Recompute `count` after in-place stamping. */
export function recount(m: Mask): Mask {
  let n = 0;
  const d = m.data;
  for (let i = 0; i < d.length; i++) if (d[i]) n++;
  m.count = n;
  return m;
}

export function invertMask(m: Mask): Mask {
  const out = createMask(m.w, m.h);
  for (let i = 0; i < m.data.length; i++) out.data[i] = m.data[i] ? 0 : 1;
  out.count = m.data.length - m.count;
  return out;
}

export function fullMask(w: number, h: number): Mask {
  const m = createMask(w, h);
  m.data.fill(1);
  m.count = w * h;
  return m;
}

/** Tight bounding box of the selected pixels, or null when nothing is selected. */
export function maskBounds(m: Mask): { x: number; y: number; w: number; h: number } | null {
  let minX = m.w;
  let minY = m.h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < m.h; y++) {
    const row = y * m.w;
    for (let x = 0; x < m.w; x++) {
      if (!m.data[row + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export type CombineMode = 'replace' | 'add' | 'subtract';

/** Merge a freshly computed mask into the existing selection. Pure. */
export function combineMask(base: Mask | null, next: Mask, mode: CombineMode): Mask {
  if (mode === 'replace' || !base) return next;
  const out = createMask(next.w, next.h);
  const a = base.data;
  const b = next.data;
  let count = 0;
  for (let i = 0; i < out.data.length; i++) {
    const v = mode === 'add' ? (a[i] || b[i] ? 1 : 0) : a[i] && !b[i] ? 1 : 0;
    out.data[i] = v;
    if (v) count++;
  }
  out.count = count;
  return out;
}

/** Union, used to accumulate successive "remove selection" cutouts. */
export function unionMask(base: Mask | null, next: Mask): Mask {
  if (!base) return next;
  return combineMask(base, next, 'add');
}

/** In-place filled circle. `value` 1 paints, 0 erases. */
export function stampDisc(m: Mask, cx: number, cy: number, r: number, value: 0 | 1): void {
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(m.w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(m.h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    const row = y * m.w;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      if (dx * dx + dy * dy <= r2) m.data[row + x] = value;
    }
  }
}

/** In-place capsule between two points — one segment of a brush drag. */
export function stampLine(
  m: Mask,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  value: 0 | 1,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  // Step by half the radius: closer spacing is wasted work, wider leaves gaps.
  const step = Math.max(1, r / 2);
  const n = Math.max(1, Math.ceil(dist / step));
  for (let i = 0; i <= n; i++) {
    stampDisc(m, x0 + (dx * i) / n, y0 + (dy * i) / n, r, value);
  }
}

/**
 * Magic wand.
 *
 * Contiguous mode is a scanline flood fill driven by an explicit stack: it
 * pushes one seed per new span rather than one per pixel, so a 12MP image needs
 * a stack of thousands rather than millions of entries. A recursive or
 * per-pixel-stack fill blows the call stack or the heap on exactly the large
 * photos this feature is for.
 *
 * Global mode ignores adjacency and takes every pixel within tolerance.
 */
export function floodSelect(
  img: ImageData,
  seedX: number,
  seedY: number,
  tolerance: number,
  contiguous: boolean,
): Mask {
  const w = img.width;
  const h = img.height;
  const px = img.data;
  const mask = createMask(w, h);

  const sx = Math.max(0, Math.min(w - 1, Math.round(seedX)));
  const sy = Math.max(0, Math.min(h - 1, Math.round(seedY)));
  const si = (sy * w + sx) * 4;
  const sr = px[si];
  const sg = px[si + 1];
  const sb = px[si + 2];
  const sa = px[si + 3];

  // Squared distance over RGBA against a squared threshold — no sqrt in the
  // inner loop, which runs once per pixel examined.
  const t = Math.max(0, tolerance);
  const thresh = 3 * t * t;
  const match = (i: number): boolean => {
    const dr = px[i] - sr;
    const dg = px[i + 1] - sg;
    const db = px[i + 2] - sb;
    const da = px[i + 3] - sa;
    return dr * dr + dg * dg + db * db + da * da <= thresh;
  };

  const data = mask.data;
  let count = 0;

  if (!contiguous) {
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
      if (match(i)) {
        data[p] = 1;
        count++;
      }
    }
    mask.count = count;
    return mask;
  }

  const stack: number[] = [sx, sy];
  while (stack.length) {
    const y = stack.pop() as number;
    const x = stack.pop() as number;
    const row = y * w;
    if (data[row + x] || !match((row + x) * 4)) continue;

    let l = x;
    while (l > 0 && !data[row + l - 1] && match((row + l - 1) * 4)) l--;
    let r = x;
    while (r < w - 1 && !data[row + r + 1] && match((row + r + 1) * 4)) r++;
    for (let i = l; i <= r; i++) {
      data[row + i] = 1;
      count++;
    }

    // Seed the rows above and below once per contiguous run, not per pixel.
    for (let k = 0; k < 2; k++) {
      const ny = k === 0 ? y - 1 : y + 1;
      if (ny < 0 || ny >= h) continue;
      const nrow = ny * w;
      let inRun = false;
      for (let i = l; i <= r; i++) {
        const ok = !data[nrow + i] && match((nrow + i) * 4);
        if (ok && !inRun) {
          stack.push(i, ny);
          inRun = true;
        } else if (!ok) {
          inRun = false;
        }
      }
    }
  }

  mask.count = count;
  return mask;
}
