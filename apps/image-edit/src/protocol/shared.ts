import { outputSize, type Doc } from '../core/doc';
import { maskBounds } from '../core/mask';
import { doc } from '../store';

export const FORMATS = ['png', 'jpeg', 'webp'] as const;

export function requireDoc(): Doc {
  const d = doc();
  if (!d) throw new Error('No image is open. Call `open` first.');
  return d;
}

/** What the agent sees after every command — enough to plan the next one. */
export function docSummary(d: Doc) {
  return {
    name: d.base.name,
    sourceSize: { w: d.base.w, h: d.base.h },
    outputSize: outputSize(d),
    crop: d.crop,
    rotate: d.rotate,
    flipX: d.flipX,
    flipY: d.flipY,
    resize: d.resize,
    filters: d.filters,
    selection: selectionSummary(d),
    hasCutout: d.removed != null,
    strokes: d.strokes.length,
  };
}

/**
 * Selection reported as a count and a bounding box, never as the mask itself —
 * a megapixel byte array is useless to an agent and would dominate every
 * response. The bounding box is what `cropToSelection` would use.
 */
export function selectionSummary(d: Doc) {
  if (!d.selection) return null;
  return {
    pixels: d.selection.count,
    percent: Number(((d.selection.count / (d.base.w * d.base.h)) * 100).toFixed(2)),
    bounds: maskBounds(d.selection),
  };
}
