/**
 * The document model.
 *
 * An edit is never baked into pixels here — `Doc` is a plain description of
 * *what* the edits are, and `render.ts` derives the pixels from it. That is what
 * makes undo a state pop rather than a bitmap stack, and what lets an agent read
 * the current crop with `query('document')` instead of being blind to the edit
 * it just made.
 *
 * Selection, cutout and brush strokes follow the same rule. Strokes are stored
 * as point lists in SOURCE coordinates and replayed by the renderer, so a stroke
 * drawn on a fit-to-window preview still exports at full resolution — drawing
 * into the preview bitmap would have baked the preview's scale into the result.
 * Masks are the one non-JSON part of a Doc; they are treated as immutable and
 * shared by reference across history entries.
 *
 * `applyCommand` is the ONLY way a Doc changes. The crop-drag handler and the
 * protocol `crop` command both route through it; if a UI interaction ever writes
 * state directly, the agent's view and the user's view drift apart.
 */

import {
  createMask,
  invertMask,
  maskBounds,
  unionMask,
  type Mask,
} from './mask';

/** A rectangle in source-image pixel coordinates, before any rotation. */
export type Rect = { x: number; y: number; w: number; h: number };

export type Rotation = 0 | 90 | 180 | 270;

/** Percentages (100 = unchanged), except `blur` which is pixels at full resolution. */
export type Filters = {
  brightness: number;
  contrast: number;
  saturation: number;
  blur: number;
};

export const DEFAULT_FILTERS: Filters = {
  brightness: 100,
  contrast: 100,
  saturation: 100,
  blur: 0,
};

/** One brush stroke, in source pixels. `erase` punches through to transparency. */
export type Stroke = {
  color: string;
  size: number;
  erase: boolean;
  points: Array<{ x: number; y: number }>;
};

export type Doc = {
  base: { src: string; name: string; w: number; h: number };
  /** null = the whole image. Always in source pixels, independent of rotation. */
  crop: Rect | null;
  rotate: Rotation;
  flipX: boolean;
  flipY: boolean;
  /** Overrides the derived output size when set. */
  resize: { w: number; h: number } | null;
  filters: Filters;
  /** The active selection, or null. Source-space, immutable. */
  selection: Mask | null;
  /** Pixels made transparent by "remove selection". Accumulates across removals. */
  removed: Mask | null;
  /** Replayed onto the source layer, in order, before crop/rotate/filters. */
  strokes: Stroke[];
};

export type Command =
  | { type: 'crop'; rect: Rect }
  | { type: 'uncrop' }
  | { type: 'rotate'; degrees: number }
  | { type: 'flip'; axis: 'horizontal' | 'vertical' }
  | { type: 'resize'; width?: number; height?: number; lockAspect?: boolean }
  | { type: 'unresize' }
  | { type: 'filter'; values: Partial<Filters> }
  | { type: 'resetFilters' }
  | { type: 'setSelection'; mask: Mask | null }
  | { type: 'invertSelection' }
  | { type: 'cropToSelection' }
  | { type: 'removeSelection' }
  | { type: 'restoreRemoved' }
  | { type: 'draw'; stroke: Stroke }
  | { type: 'clearStrokes' }
  | { type: 'reset' };

export function createDoc(base: Doc['base']): Doc {
  return {
    base,
    crop: null,
    rotate: 0,
    flipX: false,
    flipY: false,
    resize: null,
    filters: { ...DEFAULT_FILTERS },
    selection: null,
    removed: null,
    strokes: [],
  };
}

/** The source rect actually sampled — the crop, or the whole image. */
export function sourceRect(doc: Doc): Rect {
  return doc.crop ?? { x: 0, y: 0, w: doc.base.w, h: doc.base.h };
}

/**
 * Final output dimensions: crop, then the 90-degree rotation swap, then an
 * explicit resize if one is set. Export and preview both size from this.
 */
export function outputSize(doc: Doc): { w: number; h: number } {
  const src = sourceRect(doc);
  let w = src.w;
  let h = src.h;
  if (doc.rotate === 90 || doc.rotate === 270) [w, h] = [h, w];
  if (doc.resize) return { w: doc.resize.w, h: doc.resize.h };
  return { w: Math.round(w), h: Math.round(h) };
}

function clampRect(rect: Rect, doc: Doc): Rect {
  const x = clamp(Math.round(rect.x), 0, doc.base.w - 1);
  const y = clamp(Math.round(rect.y), 0, doc.base.h - 1);
  return {
    x,
    y,
    w: clamp(Math.round(rect.w), 1, doc.base.w - x),
    h: clamp(Math.round(rect.h), 1, doc.base.h - y),
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function normalizeRotation(deg: number): Rotation {
  const snapped = (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
  return snapped as Rotation;
}

/** Pure. Returns a new Doc; never mutates the input. */
export function applyCommand(doc: Doc, cmd: Command): Doc {
  switch (cmd.type) {
    case 'crop':
      // A new crop invalidates an explicit resize — the user asked for a
      // different region, not for that region stretched to the old dimensions.
      return { ...doc, crop: clampRect(cmd.rect, doc), resize: null };

    case 'uncrop':
      return { ...doc, crop: null, resize: null };

    case 'rotate':
      return { ...doc, rotate: normalizeRotation(doc.rotate + cmd.degrees) };

    case 'flip':
      return cmd.axis === 'horizontal'
        ? { ...doc, flipX: !doc.flipX }
        : { ...doc, flipY: !doc.flipY };

    case 'resize': {
      const natural = outputSize(doc);
      // Aspect ratio comes from the pre-resize output, so repeated resizes
      // don't compound rounding drift from an already-resized value.
      const src = sourceRect(doc);
      let aw = src.w;
      let ah = src.h;
      if (doc.rotate === 90 || doc.rotate === 270) [aw, ah] = [ah, aw];
      const aspect = aw / ah;

      let w = cmd.width;
      let h = cmd.height;
      if (cmd.lockAspect ?? true) {
        if (w != null && h == null) h = Math.round(w / aspect);
        else if (h != null && w == null) w = Math.round(h * aspect);
      }
      w = w ?? natural.w;
      h = h ?? natural.h;
      return { ...doc, resize: { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) } };
    }

    case 'unresize':
      return { ...doc, resize: null };

    case 'filter':
      return { ...doc, filters: { ...doc.filters, ...cmd.values } };

    case 'resetFilters':
      return { ...doc, filters: { ...DEFAULT_FILTERS } };

    case 'setSelection':
      // An empty mask is stored as null so "is anything selected" is one check.
      return { ...doc, selection: cmd.mask && cmd.mask.count > 0 ? cmd.mask : null };

    case 'invertSelection': {
      // Inverting nothing selects everything, which is what the toggle should
      // do when the user inverts before making a selection.
      const current = doc.selection ?? createMask(doc.base.w, doc.base.h);
      const next = invertMask(current);
      return { ...doc, selection: next.count > 0 ? next : null };
    }

    case 'cropToSelection': {
      if (!doc.selection) return doc;
      const bounds = maskBounds(doc.selection);
      if (!bounds) return doc;
      // Crop to the bounding box AND clear everything outside the mask itself.
      // A wand or lasso selection is almost never rectangular, so the bounding
      // box alone leaves the unselected corners fully opaque — the user asked to
      // isolate a subject and got the subject plus a rectangle of background.
      // Reusing `removed` rather than baking pixels keeps this undoable and lets
      // the existing destination-out compositing carry the alpha through every
      // later rotate, flip, resize and filter.
      const outside = invertMask(doc.selection);
      return {
        ...doc,
        crop: clampRect(bounds, doc),
        resize: null,
        removed: outside.count > 0 ? unionMask(doc.removed, outside) : doc.removed,
        // Ants tracing the region we just cropped to read as "nothing happened".
        selection: null,
      };
    }

    case 'removeSelection': {
      if (!doc.selection) return doc;
      // Clear the selection afterwards: leaving marching ants around a region
      // that is now transparent reads as "nothing happened".
      return { ...doc, removed: unionMask(doc.removed, doc.selection), selection: null };
    }

    case 'restoreRemoved':
      return { ...doc, removed: null };

    case 'draw':
      return { ...doc, strokes: [...doc.strokes, cmd.stroke] };

    case 'clearStrokes':
      return { ...doc, strokes: [] };

    case 'reset':
      return createDoc(doc.base);
  }
}

/** Human-readable one-liner for the status bar. */
export function describeDoc(doc: Doc): string {
  const out = outputSize(doc);
  const parts = [`${out.w}x${out.h}`];
  if (doc.crop) parts.push('cropped');
  if (doc.rotate) parts.push(`${doc.rotate} deg`);
  if (doc.flipX) parts.push('flip-h');
  if (doc.flipY) parts.push('flip-v');
  if (doc.resize) parts.push('resized');
  const f = doc.filters;
  if (f.brightness !== 100 || f.contrast !== 100 || f.saturation !== 100 || f.blur !== 0)
    parts.push('filtered');
  if (doc.selection) parts.push(`${doc.selection.count.toLocaleString()} px selected`);
  if (doc.removed) parts.push('cutout');
  if (doc.strokes.length) parts.push(`${doc.strokes.length} stroke${doc.strokes.length > 1 ? 's' : ''}`);
  return parts.join(' · ');
}
