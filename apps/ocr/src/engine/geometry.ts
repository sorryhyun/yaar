// DB (Differentiable Binarization) post-processing: probability map → text boxes.
//
// PaddleOCR does this with OpenCV and pyclipper. Neither exists in the browser and
// neither is in @bundled/*, so the four pieces they provide — connected components,
// convex hull, minAreaRect, and polygon offset — are written out here.
//
// Everything in this file is pure: numbers in, numbers out, no DOM and no model. That
// is deliberate — it is the only part of the detection pipeline that can be tested
// without a GPU, and a min-area rect that is subtly wrong does not throw, it hands the
// recognizer a skewed crop that decodes to plausible garbage. See
// scripts/geometry.test.ts.
//
// The reference is PaddleX's `DBPostProcess.boxes_from_bitmap` (box_type "quad", the
// default), transliterated including its filter order and its two different minimum
// side lengths.

export interface Point {
  x: number;
  y: number;
}

/** Centre, side lengths, and rotation of the long axis in radians. */
export interface RotatedRect {
  cx: number;
  cy: number;
  w: number;
  h: number;
  angle: number;
}

/** A detected text box: the quad the crop is taken from, plus its DB score. */
export interface DetBox {
  /** Corners in [top-left, top-right, bottom-right, bottom-left] order. */
  quad: Point[];
  rect: RotatedRect;
  /** Mean probability inside the *pre-unclip* rect — DB's `box_score_fast`. */
  score: number;
}

export interface DbOptions {
  /** Probability above which a pixel counts as text. */
  thresh: number;
  /** Mean-probability floor for a whole box. */
  boxThresh: number;
  /** How far to grow each box; DB's `unclip_ratio`. */
  unclipRatio: number;
  /** Upstream's cap on how many components are considered at all. */
  maxCandidates: number;
  /** Scale from map pixels back to source pixels, per axis. */
  scaleX: number;
  scaleY: number;
  /** Source image size, for clamping. */
  destWidth: number;
  destHeight: number;
}

/** Shortest side a rect must have to survive, before and after unclipping. */
const MIN_SIZE = 3;

export function binarize(prob: Float32Array, thresh: number): Uint8Array {
  const mask = new Uint8Array(prob.length);
  for (let i = 0; i < prob.length; i++) mask[i] = prob[i] > thresh ? 1 : 0;
  return mask;
}

/**
 * Boundary points of every 8-connected foreground component.
 *
 * OpenCV's `findContours` is replaced by flood fill plus a boundary test because the
 * only thing downstream wants is each blob's convex hull, and the hull of a blob's
 * border pixels is the hull of the blob. Ordering the border into a traced contour —
 * the hard part of Suzuki — would be work thrown away one function later.
 *
 * One deliberate difference: upstream passes `RETR_LIST`, which also returns the
 * *inner* contours of holes (the inside of an "o"). Those become boxes that are then
 * filtered by size and score. Only outer boundaries appear here, so a handful of
 * doomed candidates are never generated.
 *
 * Coordinates are pixel centres, matching OpenCV's contour convention: a one-pixel
 * wide blob measures 0, not 1, across.
 */
export function componentBoundaries(
  mask: Uint8Array,
  width: number,
  height: number,
  maxCandidates: number,
): { components: Point[][]; truncated: boolean } {
  const seen = new Uint8Array(mask.length);
  const components: Point[][] = [];
  // Indices, not points: the frontier of a full-width blob can be large, and a typed
  // array keeps that a flat allocation rather than a few hundred thousand objects.
  const stack = new Int32Array(mask.length);

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    if (components.length >= maxCandidates) return { components, truncated: true };

    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    const boundary: Point[] = [];

    while (top > 0) {
      const index = stack[--top];
      const x = index % width;
      const y = (index - x) / width;

      // 4-neighbour test for "is this pixel on the border", 8-neighbour walk for
      // connectivity — the same asymmetry OpenCV uses, and what keeps diagonally
      // touching glyph strokes in one component.
      const edge =
        x === 0 ||
        y === 0 ||
        x === width - 1 ||
        y === height - 1 ||
        !mask[index - 1] ||
        !mask[index + 1] ||
        !mask[index - width] ||
        !mask[index + width];
      if (edge) boundary.push({ x, y });

      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const n = ny * width + nx;
          if (mask[n] && !seen[n]) {
            seen[n] = 1;
            stack[top++] = n;
          }
        }
      }
    }

    if (boundary.length) components.push(boundary);
  }

  return { components, truncated: false };
}

/**
 * Convex hull, counter-clockwise in a y-down coordinate system, collinear points
 * dropped. Andrew's monotone chain.
 */
export function convexHull(points: Point[]): Point[] {
  if (points.length < 3) return points.slice();

  const sorted = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Point, a: Point, b: Point) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const build = (input: Point[]): Point[] => {
    const chain: Point[] = [];
    for (const p of input) {
      while (chain.length >= 2 && cross(chain[chain.length - 2], chain[chain.length - 1], p) <= 0) {
        chain.pop();
      }
      chain.push(p);
    }
    chain.pop(); // shared with the other chain's first point
    return chain;
  };

  // Collinear input degenerates to the two extreme points, which is what a
  // one-pixel-tall blob should produce — a zero-height rect, filtered by `min_size`.
  const hull = build(sorted).concat(build(sorted.slice().reverse()));
  return hull.length >= 2 ? hull : sorted;
}

/**
 * Smallest-area enclosing rectangle.
 *
 * By the rotating-calipers theorem one side of that rectangle is flush with a hull
 * edge, so trying every hull edge and keeping the best is exact. Projecting all hull
 * points per edge makes it O(h²) rather than the O(h) the calipers proper achieve, but
 * h is a text blob's hull — tens of points — and the projection version has no state
 * machine to get wrong.
 */
export function minAreaRect(points: Point[]): RotatedRect | null {
  if (points.length === 0) return null;
  const hull = convexHull(points);
  if (hull.length === 1) return { cx: hull[0].x, cy: hull[0].y, w: 0, h: 0, angle: 0 };

  let best: {
    area: number;
    ux: number;
    uy: number;
    u0: number;
    u1: number;
    v0: number;
    v1: number;
  } | null = null;

  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-12) continue;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;

    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const p of hull) {
      const u = p.x * ux + p.y * uy;
      const v = -p.x * uy + p.y * ux;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }

    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, ux, uy, u0, u1, v0, v1 };
  }

  if (!best) return { cx: hull[0].x, cy: hull[0].y, w: 0, h: 0, angle: 0 };

  const cu = (best.u0 + best.u1) / 2;
  const cv = (best.v0 + best.v1) / 2;
  return {
    cx: cu * best.ux - cv * best.uy,
    cy: cu * best.uy + cv * best.ux,
    w: best.u1 - best.u0,
    h: best.v1 - best.v0,
    angle: Math.atan2(best.uy, best.ux),
  };
}

/** The four corners of a rect, in no particular order. */
function corners(rect: RotatedRect): Point[] {
  const ux = Math.cos(rect.angle);
  const uy = Math.sin(rect.angle);
  const hw = rect.w / 2;
  const hh = rect.h / 2;
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([du, dv]) => ({
    x: rect.cx + du * ux - dv * uy,
    y: rect.cy + du * uy + dv * ux,
  }));
}

/**
 * Order four corners as [top-left, top-right, bottom-right, bottom-left].
 *
 * PaddleOCR's `get_mini_boxes` rule, kept verbatim: sort by x, then within each pair
 * the higher point (smaller y) is the top one. It is what makes `quad[0]→quad[1]` the
 * text's reading direction, which is what the crop transform relies on.
 */
export function orderQuad(points: Point[]): Point[] {
  const p = points.slice().sort((a, b) => a.x - b.x);
  const [i1, i4] = p[1].y > p[0].y ? [0, 1] : [1, 0];
  const [i2, i3] = p[3].y > p[2].y ? [2, 3] : [3, 2];
  return [p[i1], p[i2], p[i3], p[i4]];
}

export function quadOf(rect: RotatedRect): Point[] {
  return orderQuad(corners(rect));
}

/**
 * The tilt of a box, in radians, measured along its reading direction.
 *
 * Not the same as `rect.angle`, and this is the one to report or draw with. A
 * min-area rect's axis is whichever hull edge won, so a line tilted 8° up can come
 * back as an axis pointing 172° — the same rectangle, traversed the other way.
 * `orderQuad` resolves that ambiguity by putting the visual top-left first, so the
 * quad's own first edge is the only unambiguous statement of which way the text runs.
 */
export function quadAngle(quad: Point[]): number {
  return Math.atan2(quad[1].y - quad[0].y, quad[1].x - quad[0].x);
}

/**
 * Grow a box the way DB's `unclip` does.
 *
 * Upstream offsets a *polygon* with pyclipper and re-fits a min-area rect to the
 * result — but the polygon it offsets is already the min-area rect (`box_type: quad`,
 * the default; only the `poly` path offsets the raw contour). Offsetting a rectangle
 * by `d` with round joins yields a rounded rectangle whose min-area rect is exactly
 * `(w + 2d) × (h + 2d)`, so growing the rect directly is not an approximation of
 * upstream here — it is the same answer without the polygon library.
 */
export function unclip(rect: RotatedRect, ratio: number): RotatedRect {
  const perimeter = 2 * (rect.w + rect.h);
  if (perimeter <= 0) return rect;
  const distance = (rect.w * rect.h * ratio) / perimeter;
  return { ...rect, w: rect.w + 2 * distance, h: rect.h + 2 * distance };
}

/** True when `p` is inside (or on the edge of) a convex polygon wound either way. */
function insideConvex(poly: Point[], px: number, py: number): boolean {
  let positive = false;
  let negative = false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const side = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
    if (side > 0) positive = true;
    else if (side < 0) negative = true;
    if (positive && negative) return false;
  }
  return true;
}

/**
 * Mean probability inside a quad — DB's `box_score_fast`.
 *
 * Deliberately reads the raw probability map rather than the binarized mask: a box
 * whose pixels only just cleared `thresh` scores near 0.2 and is dropped, while the
 * mask would score it 1.0. That is the whole point of the threshold pair.
 */
export function boxScore(prob: Float32Array, width: number, height: number, quad: Point[]): number {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const xmin = Math.max(0, Math.min(Math.floor(Math.min(...xs)), width - 1));
  const xmax = Math.max(0, Math.min(Math.ceil(Math.max(...xs)), width - 1));
  const ymin = Math.max(0, Math.min(Math.floor(Math.min(...ys)), height - 1));
  const ymax = Math.max(0, Math.min(Math.ceil(Math.max(...ys)), height - 1));

  let sum = 0;
  let count = 0;
  for (let y = ymin; y <= ymax; y++) {
    for (let x = xmin; x <= xmax; x++) {
      if (!insideConvex(quad, x, y)) continue;
      sum += prob[y * width + x];
      count++;
    }
  }
  return count ? sum / count : 0;
}

/**
 * Probability map → boxes in source-image pixels.
 *
 * The filter order is upstream's and matters: score is measured on the box *before*
 * unclipping (an unclipped box includes background, which would drag every score down
 * toward the threshold), and the minimum side is checked twice with two different
 * values — 3 before unclipping, 5 after.
 */
export function dbBoxes(
  prob: Float32Array,
  width: number,
  height: number,
  options: DbOptions,
): { boxes: DetBox[]; truncated: boolean } {
  const mask = binarize(prob, options.thresh);
  const { components, truncated } = componentBoundaries(mask, width, height, options.maxCandidates);

  const boxes: DetBox[] = [];
  for (const boundary of components) {
    const rect = minAreaRect(boundary);
    if (!rect) continue;
    if (Math.min(rect.w, rect.h) < MIN_SIZE) continue;

    const quad = quadOf(rect);
    const score = boxScore(prob, width, height, quad);
    if (score < options.boxThresh) continue;

    const grown = unclip(rect, options.unclipRatio);
    if (Math.min(grown.w, grown.h) < MIN_SIZE + 2) continue;

    const scaled = scaleRect(grown, options);
    boxes.push({
      quad: quadOf(scaled).map((p) => ({
        x: Math.max(0, Math.min(Math.round(p.x), options.destWidth)),
        y: Math.max(0, Math.min(Math.round(p.y), options.destHeight)),
      })),
      rect: scaled,
      score,
    });
  }

  return { boxes, truncated };
}

/**
 * Map a rect from probability-map pixels to source-image pixels.
 *
 * The two axes scale independently (the resize rounds each side to a multiple of 32,
 * so the ratios differ slightly), which a rotated rect cannot express exactly — a
 * non-uniform scale of a rotated rectangle is a parallelogram. The two ratios differ
 * by well under a percent in practice, so the angle is carried through unchanged and
 * each side scaled by its dominant axis.
 */
function scaleRect(rect: RotatedRect, options: DbOptions): RotatedRect {
  const { scaleX, scaleY } = options;
  const cos = Math.abs(Math.cos(rect.angle));
  const sin = Math.abs(Math.sin(rect.angle));
  return {
    cx: rect.cx * scaleX,
    cy: rect.cy * scaleY,
    w: rect.w * (cos * scaleX + sin * scaleY),
    h: rect.h * (cos * scaleY + sin * scaleX),
    angle: rect.angle,
  };
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Group boxes into visual lines, each ordered left to right, the groups top to bottom.
 *
 * Detection returns boxes in whatever order the components were scanned in, which for
 * a page is close to random. Two boxes belong to the same line when their vertical
 * extents overlap by more than half the shorter one — a threshold that tolerates the
 * baseline wobble of real text without merging adjacent lines.
 *
 * **Column detection is out of scope.** Two side-by-side columns overlap vertically,
 * so their lines pair up and read across the gutter, and a group's band grows as boxes
 * join it, so a tall box can chain two bands together. Both are visible in the output
 * rather than hidden: the caller gets the groups, and the app says so in SKILL.md.
 * Fixing it properly means whitespace/gutter analysis, which is its own feature.
 */
export function readingOrder(boxes: Bounds[]): number[][] {
  const byBand = boxes
    .map((_, i) => i)
    .sort(
      (a, b) =>
        boxes[a].y + boxes[a].h / 2 - (boxes[b].y + boxes[b].h / 2) || boxes[a].x - boxes[b].x,
    );

  const groups: { top: number; bottom: number; items: number[] }[] = [];
  for (const i of byBand) {
    const box = boxes[i];
    const top = box.y;
    const bottom = box.y + box.h;
    const home = groups.find((g) => {
      const overlap = Math.min(bottom, g.bottom) - Math.max(top, g.top);
      return overlap > 0.5 * Math.min(box.h, g.bottom - g.top);
    });
    if (home) {
      home.items.push(i);
      home.top = Math.min(home.top, top);
      home.bottom = Math.max(home.bottom, bottom);
    } else {
      groups.push({ top, bottom, items: [i] });
    }
  }

  groups.sort((a, b) => a.top - b.top);
  for (const g of groups) g.items.sort((a, b) => boxes[a].x - boxes[b].x);
  return groups.map((g) => g.items);
}

/** Axis-aligned bounds of a quad — what the UI overlay and reading order use. */
export function quadBounds(quad: Point[]): { x: number; y: number; w: number; h: number } {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
