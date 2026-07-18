/**
 * The source layer: base image + cutouts + brush strokes, at full source
 * resolution.
 *
 * This exists so that crop/rotate/flip/resize/filters keep working exactly as
 * they did. `render.ts` used to draw the raw <img>; now it draws this layer
 * instead and every downstream transform is untouched. Compositing after the
 * crop would have meant strokes and cutouts moving when the crop changed.
 *
 * Both caches are keyed by identity, not by value. A Doc is replaced wholesale
 * on every edit but `strokes` and `removed` keep their references unless the
 * command actually changed them — so dragging a brightness slider re-renders
 * without rebuilding a 12MP layer on every frame.
 */

import type { Doc, Stroke } from './doc';
import type { Mask } from './mask';

let baseCache: { img: CanvasImageSource; canvas: HTMLCanvasElement; data: ImageData | null } | null =
  null;

/** The decoded image on a canvas at source resolution, cached per image. */
function baseCanvas(doc: Doc, img: CanvasImageSource): HTMLCanvasElement {
  if (baseCache && baseCache.img === img) return baseCache.canvas;
  const canvas = document.createElement('canvas');
  canvas.width = doc.base.w;
  canvas.height = doc.base.h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx) ctx.drawImage(img, 0, 0, doc.base.w, doc.base.h);
  baseCache = { img, canvas, data: null };
  return canvas;
}

/**
 * Source pixels for the magic wand. Cached — a wand click on a 12MP image would
 * otherwise re-read 48MB from the GPU every time the tolerance changed.
 *
 * Throws a SecurityError for a cross-origin image; callers translate it, since
 * the raw message says nothing about what the user should do instead.
 */
export function baseImageData(doc: Doc, img: CanvasImageSource): ImageData {
  const canvas = baseCanvas(doc, img);
  if (baseCache?.data) return baseCache.data;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas unavailable.');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  if (baseCache) baseCache.data = data;
  return data;
}

/** Opaque where selected, transparent elsewhere — a destination-out stencil. */
function maskToCanvas(mask: Mask): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = mask.w;
  canvas.height = mask.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const out = ctx.createImageData(mask.w, mask.h);
  const d = out.data;
  for (let p = 0; p < mask.data.length; p++) {
    if (mask.data[p]) d[p * 4 + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  return canvas;
}

/** Replay one stroke in source coordinates. */
export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  if (!stroke.points.length) return;
  ctx.save();
  ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = Math.max(1, stroke.size);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (stroke.points.length === 1) {
    // A click with no drag is a dot, not a zero-length line — which strokes
    // nothing at all and looks like the tool is broken.
    const p = stroke.points[0];
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(0.5, stroke.size / 2), 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (let i = 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

let layerCache: {
  img: CanvasImageSource;
  removed: Mask | null;
  strokes: Stroke[];
  canvas: HTMLCanvasElement;
} | null = null;

/**
 * What the renderer should sample. Returns the raw image untouched when there
 * is nothing to composite, so an unedited document costs no extra canvas.
 */
export function sourceLayer(doc: Doc, img: CanvasImageSource): CanvasImageSource {
  if (!doc.removed && doc.strokes.length === 0) return img;

  if (
    layerCache &&
    layerCache.img === img &&
    layerCache.removed === doc.removed &&
    layerCache.strokes === doc.strokes
  ) {
    return layerCache.canvas;
  }

  const canvas = document.createElement('canvas');
  canvas.width = doc.base.w;
  canvas.height = doc.base.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return img;

  ctx.drawImage(img, 0, 0, doc.base.w, doc.base.h);

  if (doc.removed) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(maskToCanvas(doc.removed), 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  }

  // Strokes go on after the cutout, so painting back into a removed region
  // restores it rather than being silently clipped away.
  for (const stroke of doc.strokes) drawStroke(ctx, stroke);

  layerCache = { img, removed: doc.removed, strokes: doc.strokes, canvas };
  return canvas;
}

/** Drop caches when a new image is opened, so the old bitmap can be collected. */
export function resetLayerCache(): void {
  baseCache = null;
  layerCache = null;
}
