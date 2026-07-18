/**
 * Selection visualisation: translucent fill plus marching ants.
 *
 * Drawn in CANVAS space, sampled from the source-space mask — not the other way
 * around. Building an overlay bitmap at source resolution and then transforming
 * it would cost 12MP of work per animation frame on a large photo, to produce a
 * few hundred thousand visible pixels.
 *
 * The render transform is affine, so instead of calling `canvasToSource` per
 * pixel we evaluate it at three points, recover the linear coefficients, and
 * walk the mask with two adds per pixel.
 */

import type { Doc } from './doc';
import { canvasToSource } from './geometry';
import type { Mask } from './mask';

/** Above this, ant animation is skipped — the redraw costs more than it adds. */
export const ANIMATE_PIXEL_LIMIT = 2_500_000;

export function renderSelectionOverlay(
  canvas: HTMLCanvasElement,
  doc: Doc,
  mask: Mask | null,
  phase: number,
): void {
  const cw = canvas.width;
  const ch = canvas.height;
  const ctx = canvas.getContext('2d');
  if (!ctx || !cw || !ch) return;

  ctx.clearRect(0, 0, cw, ch);
  if (!mask || mask.count === 0) return;

  const origin = canvasToSource(doc, cw, ch, 0, 0);
  const stepX = canvasToSource(doc, cw, ch, 1, 0);
  const stepY = canvasToSource(doc, cw, ch, 0, 1);
  const ax = stepX.x - origin.x;
  const ay = stepX.y - origin.y;
  const bx = stepY.x - origin.x;
  const by = stepY.y - origin.y;

  const hit = new Uint8Array(cw * ch);
  const md = mask.data;
  const mw = mask.w;
  const mh = mask.h;

  for (let cy = 0; cy < ch; cy++) {
    // Sample at the pixel centre, then march along the row by one column step.
    let sx = origin.x + ax * 0.5 + bx * (cy + 0.5);
    let sy = origin.y + ay * 0.5 + by * (cy + 0.5);
    const row = cy * cw;
    for (let cx = 0; cx < cw; cx++, sx += ax, sy += ay) {
      const mx = Math.floor(sx);
      const my = Math.floor(sy);
      if (mx < 0 || my < 0 || mx >= mw || my >= mh) continue;
      if (md[my * mw + mx]) hit[row + cx] = 1;
    }
  }

  const out = ctx.createImageData(cw, ch);
  const d = out.data;
  for (let cy = 0; cy < ch; cy++) {
    const row = cy * cw;
    for (let cx = 0; cx < cw; cx++) {
      const p = row + cx;
      if (!hit[p]) continue;
      const edge =
        cx === 0 ||
        cy === 0 ||
        cx === cw - 1 ||
        cy === ch - 1 ||
        !hit[p - 1] ||
        !hit[p + 1] ||
        !hit[p - cw] ||
        !hit[p + cw];
      const i = p * 4;
      if (edge) {
        // Alternating 4px runs along x+y; advancing `phase` marches them.
        const light = (((cx + cy + phase) >> 2) & 1) === 0;
        const v = light ? 255 : 0;
        d[i] = v;
        d[i + 1] = v;
        d[i + 2] = v;
        d[i + 3] = 255;
      } else {
        d[i] = 83;
        d[i + 1] = 155;
        d[i + 2] = 245;
        d[i + 3] = 64;
      }
    }
  }
  ctx.putImageData(out, 0, 0);
}
