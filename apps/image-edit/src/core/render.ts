/**
 * The one renderer.
 *
 * Preview and export call the SAME function — the preview at a fit-to-pane
 * scale, the export at scale 1. Rendering the preview with CSS filters and the
 * export with canvas filters would be two renderers that silently disagree, and
 * the disagreement only shows up in the downloaded file.
 */

import { sourceLayer } from './compose';
import { outputSize, sourceRect, type Doc, type Filters } from './doc';

/** Canvas 2D filter string. `blur` scales with the render scale so preview matches export. */
export function filterString(f: Filters, scale = 1): string {
  const parts: string[] = [];
  if (f.brightness !== 100) parts.push(`brightness(${f.brightness}%)`);
  if (f.contrast !== 100) parts.push(`contrast(${f.contrast}%)`);
  if (f.saturation !== 100) parts.push(`saturate(${f.saturation}%)`);
  if (f.blur > 0) parts.push(`blur(${(f.blur * scale).toFixed(2)}px)`);
  return parts.length ? parts.join(' ') : 'none';
}

/**
 * Draw `doc` into `canvas` at `scale` (1 = full output resolution).
 * Resizes the canvas to match, so callers never set width/height themselves.
 */
export function renderToCanvas(
  canvas: HTMLCanvasElement,
  doc: Doc,
  img: CanvasImageSource,
  scale = 1,
): void {
  const out = outputSize(doc);
  const cw = Math.max(1, Math.round(out.w * scale));
  const ch = Math.max(1, Math.round(out.h * scale));
  canvas.width = cw;
  canvas.height = ch;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const src = sourceRect(doc);
  // Cutouts and brush strokes are composited at source resolution first, so
  // every transform below applies to them exactly as it does to the photo.
  const layer = sourceLayer(doc, img);

  ctx.clearRect(0, 0, cw, ch);
  ctx.save();
  ctx.imageSmoothingQuality = 'high';
  ctx.filter = filterString(doc.filters, scale);

  // Rotate the canvas around its centre, then draw the crop region centred in
  // crop-space dimensions. For 90/270 the destination box is the swapped one,
  // because the rotation puts it back on the canvas's axes.
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate((doc.rotate * Math.PI) / 180);
  ctx.scale(doc.flipX ? -1 : 1, doc.flipY ? -1 : 1);

  let dw = cw;
  let dh = ch;
  if (doc.rotate === 90 || doc.rotate === 270) [dw, dh] = [dh, dw];

  ctx.drawImage(layer, src.x, src.y, src.w, src.h, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

/** Render at full resolution into a detached canvas. */
export function renderFull(doc: Doc, img: CanvasImageSource): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  renderToCanvas(canvas, doc, img, 1);
  return canvas;
}

export type ExportFormat = 'png' | 'jpeg' | 'webp';

const MIME: Record<ExportFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * JPEG has no alpha channel, and left to itself the encoder composites
 * transparent pixels onto BLACK — so a crop-to-selection cutout exports as a
 * subject on a black silhouette. Flatten onto white first, which is what "save
 * this as a JPEG" means to a user. PNG and WebP keep their alpha untouched.
 */
function flattenOntoWhite(src: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext('2d');
  if (!ctx) return src;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(src, 0, 0);
  return out;
}

/** The canvas an export should encode — flattened only for formats without alpha. */
function exportCanvas(doc: Doc, img: CanvasImageSource, format: ExportFormat): HTMLCanvasElement {
  const canvas = renderFull(doc, img);
  return format === 'jpeg' ? flattenOntoWhite(canvas) : canvas;
}

/** Full-resolution export as a data URL. */
export function exportDataUrl(
  doc: Doc,
  img: CanvasImageSource,
  format: ExportFormat,
  quality = 0.92,
): string {
  return exportCanvas(doc, img, format).toDataURL(MIME[format], quality);
}

/** Full-resolution export as a Blob (preferred for downloads — no base64 bloat). */
export function exportBlob(
  doc: Doc,
  img: CanvasImageSource,
  format: ExportFormat,
  quality = 0.92,
): Promise<Blob | null> {
  const canvas = exportCanvas(doc, img, format);
  return new Promise((resolve) => canvas.toBlob(resolve, MIME[format], quality));
}

/** Scale that fits `out` inside the pane, never magnifying past 1:1. */
export function fitScale(out: { w: number; h: number }, paneW: number, paneH: number): number {
  if (!paneW || !paneH || !out.w || !out.h) return 1;
  return Math.min(1, paneW / out.w, paneH / out.h);
}
