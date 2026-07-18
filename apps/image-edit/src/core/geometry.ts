/**
 * Inverse of the render transform.
 *
 * The canvas draws crop-space -> display via translate, rotate, flip. To turn a
 * mouse position back into source pixels we undo those in reverse order. Doing
 * it by hand at the call site is how a crop ends up mirrored the moment someone
 * flips the image, so it lives here with the forward transform it mirrors.
 */

import { sourceRect, type Doc, type Rect } from './doc';

/** Crop-space destination box — swapped for 90/270, matching `renderToCanvas`. */
function destBox(doc: Doc, cw: number, ch: number): { dw: number; dh: number } {
  return doc.rotate === 90 || doc.rotate === 270 ? { dw: ch, dh: cw } : { dw: cw, dh: ch };
}

/** Canvas pixel -> source image pixel. */
export function canvasToSource(
  doc: Doc,
  cw: number,
  ch: number,
  cx: number,
  cy: number,
): { x: number; y: number } {
  // Undo translate.
  let px = cx - cw / 2;
  let py = cy - ch / 2;

  // Undo rotate (forward rotated by +theta, so rotate by -theta).
  const theta = (-doc.rotate * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  [px, py] = [px * cos - py * sin, px * sin + py * cos];

  // Undo flip — its own inverse.
  if (doc.flipX) px = -px;
  if (doc.flipY) py = -py;

  const { dw, dh } = destBox(doc, cw, ch);
  const src = sourceRect(doc);
  return {
    x: src.x + (px + dw / 2) * (src.w / dw),
    y: src.y + (py + dh / 2) * (src.h / dh),
  };
}

/** Two canvas-space corners -> a normalized source-space rect. */
export function dragToSourceRect(
  doc: Doc,
  cw: number,
  ch: number,
  a: { x: number; y: number },
  b: { x: number; y: number },
): Rect {
  const p1 = canvasToSource(doc, cw, ch, a.x, a.y);
  const p2 = canvasToSource(doc, cw, ch, b.x, b.y);
  return {
    x: Math.min(p1.x, p2.x),
    y: Math.min(p1.y, p2.y),
    w: Math.abs(p2.x - p1.x),
    h: Math.abs(p2.y - p1.y),
  };
}
