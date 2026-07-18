/**
 * The document model.
 *
 * An edit is never baked into pixels here — `Doc` is a plain serializable
 * description of *what* the edits are, and `render.ts` derives the pixels from
 * it. That is what makes undo a state pop rather than a bitmap stack, and what
 * lets an agent read the current crop with `query('document')` instead of being
 * blind to the edit it just made.
 *
 * `applyCommand` is the ONLY way a Doc changes. The crop-drag handler and the
 * protocol `crop` command both route through it; if a UI interaction ever writes
 * state directly, the agent's view and the user's view drift apart.
 */

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
  return parts.join(' · ');
}
