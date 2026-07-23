// Detected quad → an upright bitmap the recognizer can read.
//
// PaddleOCR perspective-warps the quad (`get_rotate_crop_image`, cv2.warpPerspective).
// The quads here come from a min-area *rectangle*, so the transform that undoes them
// is a pure affine — rotate, scale, translate — which Canvas 2D does natively and on
// the GPU. A homography would only differ for genuinely perspective-distorted text (a
// photo of a sign at an angle), and would need a WebGL pass to run at all.
import type { Point } from './geometry';

/** Below this the quad is treated as upright and cropped with a plain drawImage. */
const AXIS_ALIGNED_RADIANS = 0.0087; // 0.5°

/** Taller than this ratio and the text is vertical; upstream rotates it to read. */
const VERTICAL_RATIO = 1.5;

const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

/**
 * Cut `quad` out of `src` as an upright canvas.
 *
 * `quad` is in [top-left, top-right, bottom-right, bottom-left] order, so quad[0]→[1]
 * is the reading direction and quad[0]→[3] is down the line's height.
 */
export function cropQuad(src: CanvasImageSource, quad: Point[]): HTMLCanvasElement {
  const width = Math.max(
    1,
    Math.round(Math.max(distance(quad[0], quad[1]), distance(quad[3], quad[2]))),
  );
  const height = Math.max(
    1,
    Math.round(Math.max(distance(quad[0], quad[3]), distance(quad[1], quad[2]))),
  );

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('could not get a 2D context to crop a line');
  // Anything the quad reaches for outside the image reads as page, not as ink.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const angle = Math.atan2(quad[1].y - quad[0].y, quad[1].x - quad[0].x);
  if (Math.abs(angle) < AXIS_ALIGNED_RADIANS) {
    // The overwhelmingly common case. Worth its own path: this one only touches the
    // pixels inside the box, where the transform below hands the whole image to the
    // rasterizer and lets it clip.
    ctx.drawImage(src, quad[0].x, quad[0].y, width, height, 0, 0, width, height);
    return maybeRotate(canvas);
  }

  // Map source → crop: x' = u·(p − q0), y' = v·(p − q0), with u along the text and v
  // down the line. Canvas applies x' = a·x + c·y + e, y' = b·x + d·y + f, so the two
  // unit vectors go in transposed — this is the inverse of "place the crop into the
  // page", which is the direction drawImage needs.
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const vx = -uy;
  const vy = ux;
  ctx.setTransform(
    ux,
    vx,
    uy,
    vy,
    -(ux * quad[0].x + uy * quad[0].y),
    -(vx * quad[0].x + vy * quad[0].y),
  );
  ctx.drawImage(src, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return maybeRotate(canvas);
}

/**
 * Stand a vertical line up, the way upstream's `np.rot90` does.
 *
 * The recognizer squashes whatever it is given to 48px tall, so a column of vertical
 * text would arrive as an unreadable smear. Upstream's rule — rotate when the crop is
 * at least 1.5× taller than it is wide — is kept as-is, including the direction
 * (counter-clockwise), since that is what its training data was built with.
 */
function maybeRotate(crop: HTMLCanvasElement): HTMLCanvasElement {
  if (crop.height / crop.width < VERTICAL_RATIO) return crop;

  const rotated = document.createElement('canvas');
  rotated.width = crop.height;
  rotated.height = crop.width;
  const ctx = rotated.getContext('2d', { willReadFrequently: true });
  if (!ctx) return crop;
  // (x, y) → (y, w − x): a quarter turn counter-clockwise.
  ctx.setTransform(0, -1, 1, 0, 0, crop.width);
  ctx.drawImage(crop, 0, 0);
  return rotated;
}
