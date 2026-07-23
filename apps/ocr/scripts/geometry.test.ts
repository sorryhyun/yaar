/**
 * Unit tests for the DB post-processing geometry.
 *
 *   bun test apps/ocr/scripts/geometry.test.ts
 *
 * These live outside `src/` on purpose: `apps/tsconfig.json` typechecks `*​/src/**` with
 * `types: []`, so a file importing `bun:test` from there would fail the app typecheck.
 *
 * The point of testing this layer is that it is the only part of detection that fails
 * *silently*. A wrong min-area rect does not throw — it hands the recognizer a skewed
 * crop, and the model dutifully reads confident nonsense out of it. Every expectation
 * below is hand-computed, not captured from a run.
 */
import { describe, expect, test } from 'bun:test';
import {
  binarize,
  boxScore,
  componentBoundaries,
  convexHull,
  dbBoxes,
  minAreaRect,
  orderQuad,
  quadBounds,
  quadAngle,
  quadOf,
  readingOrder,
  unclip,
  type DbOptions,
  type Point,
} from '../src/geometry';

const near = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(tol);

describe('convexHull', () => {
  test('drops interior and collinear points', () => {
    const square: Point[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 5, y: 5 }, // interior
      { x: 5, y: 0 }, // collinear on an edge
    ];
    const hull = convexHull(square);
    expect(hull.length).toBe(4);
    expect(hull.map((p) => `${p.x},${p.y}`).sort()).toEqual(['0,0', '0,10', '10,0', '10,10']);
  });

  test('collinear input collapses to its two extremes', () => {
    const hull = convexHull([
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 5, y: 0 },
    ]);
    expect(hull.length).toBe(2);
    expect(hull.map((p) => p.x).sort((a, b) => a - b)).toEqual([0, 5]);
  });
});

describe('minAreaRect', () => {
  test('axis-aligned rectangle keeps its own sides', () => {
    const rect = minAreaRect([
      { x: 2, y: 3 },
      { x: 12, y: 3 },
      { x: 12, y: 7 },
      { x: 2, y: 7 },
    ])!;
    near(rect.cx, 7);
    near(rect.cy, 5);
    near(Math.max(rect.w, rect.h), 10);
    near(Math.min(rect.w, rect.h), 4);
    // Either side may be the "w" depending on which hull edge won; the rect must be
    // axis-aligned either way.
    near(Math.abs(Math.sin(2 * rect.angle)), 0);
  });

  test('a 45° diamond gets a rotated rect, not its bounding box', () => {
    // Corners of a square rotated 45°: half-diagonals of 5, so side = 5√2 ≈ 7.071 and
    // area 50 — against 100 for the axis-aligned bounding box.
    const rect = minAreaRect([
      { x: 0, y: 0 },
      { x: 5, y: 5 },
      { x: 10, y: 0 },
      { x: 5, y: -5 },
    ])!;
    near(rect.cx, 5, 1e-9);
    near(rect.cy, 0, 1e-9);
    near(rect.w * rect.h, 50, 1e-9);
    near(rect.w, Math.sqrt(50), 1e-9);
    near(Math.abs(Math.cos(4 * rect.angle)), 1); // a multiple of 45°
  });

  test('an oblique bar is measured along the bar, not along the axes', () => {
    // A 3-4-5 slope: a 20-long, 6-wide bar at atan2(3,4).
    const ux = 0.8;
    const uy = 0.6;
    const vx = -0.6;
    const vy = 0.8;
    const centre = { x: 30, y: 40 };
    const points = [
      [-10, -3],
      [10, -3],
      [10, 3],
      [-10, 3],
    ].map(([u, v]) => ({
      x: centre.x + u * ux + v * vx,
      y: centre.y + u * uy + v * vy,
    }));

    const rect = minAreaRect(points)!;
    near(rect.cx, centre.x, 1e-9);
    near(rect.cy, centre.y, 1e-9);
    near(Math.max(rect.w, rect.h), 20, 1e-9);
    near(Math.min(rect.w, rect.h), 6, 1e-9);
  });

  test('degenerate inputs do not throw', () => {
    expect(minAreaRect([])).toBeNull();
    const dot = minAreaRect([{ x: 4, y: 9 }])!;
    expect(dot).toEqual({ cx: 4, cy: 9, w: 0, h: 0, angle: 0 });
    const line = minAreaRect([
      { x: 0, y: 0 },
      { x: 6, y: 0 },
    ])!;
    near(Math.max(line.w, line.h), 6);
    near(Math.min(line.w, line.h), 0);
  });
});

describe('orderQuad', () => {
  test('returns top-left, top-right, bottom-right, bottom-left', () => {
    const quad = orderQuad([
      { x: 10, y: 8 }, // bottom-right
      { x: 0, y: 8 }, // bottom-left
      { x: 0, y: 2 }, // top-left
      { x: 10, y: 2 }, // top-right
    ]);
    expect(quad).toEqual([
      { x: 0, y: 2 },
      { x: 10, y: 2 },
      { x: 10, y: 8 },
      { x: 0, y: 8 },
    ]);
  });

  test('quad[0]→quad[1] runs along the text, for a tilted box', () => {
    // 10° below horizontal: reading direction must still be the long side.
    const angle = (10 * Math.PI) / 180;
    const quad = quadOf({ cx: 50, cy: 50, w: 40, h: 8, angle });
    const dx = quad[1].x - quad[0].x;
    const dy = quad[1].y - quad[0].y;
    near(Math.hypot(dx, dy), 40, 1e-9);
    near(Math.atan2(dy, dx), angle, 1e-9);
  });
});

describe('unclip', () => {
  test('grows by area × ratio / perimeter on every side', () => {
    // 10×4 → area 40, perimeter 28, distance = 40 × 1.4 / 28 = 2.
    const grown = unclip({ cx: 0, cy: 0, w: 10, h: 4, angle: 0 }, 1.4);
    near(grown.w, 14);
    near(grown.h, 8);
    near(grown.cx, 0);
    near(grown.angle, 0);
  });

  test('a degenerate box is left alone rather than made infinite', () => {
    const flat = unclip({ cx: 1, cy: 1, w: 0, h: 0, angle: 0 }, 1.4);
    expect(flat.w).toBe(0);
  });
});

describe('boxScore', () => {
  test('averages the raw probabilities inside the quad only', () => {
    // Left half 0.9, right half 0.1, in a 10×10 map.
    const prob = new Float32Array(100);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) prob[y * 10 + x] = x < 5 ? 0.9 : 0.1;
    }
    const left = boxScore(prob, 10, 10, [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 9 },
      { x: 0, y: 9 },
    ]);
    near(left, 0.9, 1e-6);

    const both = boxScore(prob, 10, 10, [
      { x: 0, y: 0 },
      { x: 9, y: 0 },
      { x: 9, y: 9 },
      { x: 0, y: 9 },
    ]);
    near(both, 0.5, 1e-6);
  });
});

describe('componentBoundaries', () => {
  const maskFrom = (rows: string[]) => {
    const w = rows[0].length;
    const mask = new Uint8Array(w * rows.length);
    rows.forEach((row, y) => {
      for (let x = 0; x < w; x++) mask[y * w + x] = row[x] === '#' ? 1 : 0;
    });
    return { mask, w, h: rows.length };
  };

  test('separates blobs and keeps diagonal touches together', () => {
    const { mask, w, h } = maskFrom([
      '##...',
      '.#...',
      '..#..', // diagonally attached to the blob above — one component
      '.....',
      '#....', // separate
    ]);
    const { components, truncated } = componentBoundaries(mask, w, h, 100);
    expect(truncated).toBe(false);
    expect(components.length).toBe(2);
    expect(components.map((c) => c.length).sort()).toEqual([1, 4]);
  });

  test('the interior of a solid blob is not a boundary point', () => {
    const { mask, w, h } = maskFrom(['.....', '.###.', '.###.', '.###.', '.....']);
    const { components } = componentBoundaries(mask, w, h, 100);
    expect(components.length).toBe(1);
    expect(components[0].length).toBe(8); // 3×3 minus its centre
  });

  test('honours max_candidates and says it truncated', () => {
    const { mask, w, h } = maskFrom(['#.#.#', '.....', '#.#.#']);
    const { components, truncated } = componentBoundaries(mask, w, h, 2);
    expect(components.length).toBe(2);
    expect(truncated).toBe(true);
  });
});

describe('dbBoxes', () => {
  const options: DbOptions = {
    thresh: 0.2,
    boxThresh: 0.45,
    unclipRatio: 1.4,
    maxCandidates: 3000,
    scaleX: 1,
    scaleY: 1,
    destWidth: 64,
    destHeight: 64,
  };

  /** A 64×64 map with a filled axis-aligned rectangle of probability `p`. */
  const mapWith = (x0: number, y0: number, x1: number, y1: number, p = 0.95) => {
    const prob = new Float32Array(64 * 64);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) prob[y * 64 + x] = p;
    }
    return prob;
  };

  test('a solid bar becomes one box, unclipped by the expected amount', () => {
    // Boundary pixel centres span 20..39 × 10..19 → a 19×9 rect (OpenCV convention).
    // area 171, perimeter 56, distance = 171 × 1.4 / 56 = 4.275 → 27.55 × 17.55,
    // centred at (29.5, 14.5): x spans 15.725..43.275 → 16..43, y spans 5.725..23.275
    // → 6..23. Rounding each corner independently is why the height comes out 17 and
    // not 18 — the same thing upstream's per-corner `round` does.
    const { boxes, truncated } = dbBoxes(mapWith(20, 10, 39, 19), 64, 64, options);
    expect(truncated).toBe(false);
    expect(boxes.length).toBe(1);

    const bounds = quadBounds(boxes[0].quad);
    expect(bounds.x).toBe(16);
    expect(bounds.y).toBe(6);
    expect(bounds.w).toBe(27);
    expect(bounds.h).toBe(17);
    near(boxes[0].score, 0.95, 1e-5);
  });

  test('a box whose pixels only just clear the threshold is dropped by box_thresh', () => {
    // 0.3 > thresh 0.2, so it binarizes — but its mean is below box_thresh 0.45.
    const { boxes } = dbBoxes(mapWith(20, 10, 39, 19, 0.3), 64, 64, options);
    expect(boxes.length).toBe(0);
  });

  test('a blob thinner than min_size is dropped before it is ever scored', () => {
    // Two pixels tall → a 19×1 rect, short side below 3.
    const { boxes } = dbBoxes(mapWith(20, 10, 39, 11), 64, 64, options);
    expect(boxes.length).toBe(0);
  });

  test('boxes are scaled back to source pixels and clamped to the image', () => {
    const scaled = dbBoxes(mapWith(20, 10, 39, 19), 64, 64, {
      ...options,
      scaleX: 2,
      scaleY: 2,
      destWidth: 128,
      destHeight: 128,
    });
    const bounds = quadBounds(scaled.boxes[0].quad);
    expect(bounds.x).toBe(31); // 15.725 × 2 = 31.45
    expect(bounds.w).toBe(56); // 43.275 × 2 = 86.55 → 87
    for (const p of scaled.boxes[0].quad) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(128);
    }
  });

  test('binarize is a strict threshold', () => {
    const mask = binarize(new Float32Array([0.1, 0.19, 0.21, 1]), 0.2);
    expect(Array.from(mask)).toEqual([0, 0, 1, 1]);
  });
});

describe('readingOrder', () => {
  const line = (x: number, y: number, w = 100, h = 20) => ({ x, y, w, h });

  test('groups a page into lines, top to bottom, left to right within each', () => {
    // Fed in scrambled order, with a slight baseline wobble between the two halves of
    // the first line — the case a naive sort-by-y gets wrong.
    const boxes = [line(300, 102), line(20, 200), line(20, 100), line(300, 202)];
    expect(readingOrder(boxes)).toEqual([
      [2, 0],
      [1, 3],
    ]);
  });

  test('lines that barely touch stay apart', () => {
    // 4px of overlap between 20px-tall boxes — under the half-height threshold.
    expect(readingOrder([line(0, 0), line(0, 16)])).toEqual([[0], [1]]);
  });

  test('two columns read across the gutter — the documented limitation', () => {
    // Left column at x=0, right column at x=500, same two baselines. Column detection
    // is out of scope, so this reads L1 R1 / L2 R2 rather than L1 L2 / R1 R2. Pinned
    // here so the behaviour is a known trade-off rather than a surprise.
    const boxes = [line(0, 0), line(500, 0), line(0, 40), line(500, 40)];
    expect(readingOrder(boxes)).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  test('no boxes, no groups', () => {
    expect(readingOrder([])).toEqual([]);
  });
});

describe('quadAngle', () => {
  test('reports the reading direction, not the rect axis', () => {
    // A rect whose axis was found pointing "backwards": the same rectangle as one at
    // -8°, but with its min-area-rect angle at 172°. The ordered quad has to resolve
    // that to -8°, because the overlay and the protocol both draw with this number.
    const backwards = { cx: 100, cy: 50, w: 200, h: 20, angle: Math.PI - 0.1396 };
    const degrees = (quadAngle(quadOf(backwards)) * 180) / Math.PI;
    near(degrees, -8, 0.01);
  });

  test('agrees with a forward-pointing rect', () => {
    const forward = { cx: 100, cy: 50, w: 200, h: 20, angle: 0.1396 };
    near((quadAngle(quadOf(forward)) * 180) / Math.PI, 8, 0.01);
  });
});
