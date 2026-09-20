/**
 * How many image pixels a screen capture draws per CSS pixel.
 *
 * Both captures — a window's `__screenshot` (`iframe-scripts/capture.ts`) and the whole
 * monitor (the frontend's `captureMonitorScreenshot`) — render a `foreignObject` SVG into
 * a canvas. That render is resolution-independent: text and vector chrome come out of it
 * at whatever size the canvas is, so a larger canvas is *more detail*, not an upscale of
 * a small picture. Only raster content already inlined into the clone (a snapshotted
 * `<canvas>`, an inlined `<img>`) is resampled, and those carry their own backing-store
 * resolution, which is typically higher than their CSS box to begin with.
 *
 * A capture used to render at 1 CSS pixel per image pixel (the window capture) or at the
 * display's `devicePixelRatio` (the monitor capture). Both are the wrong unit for an image
 * whose only reader is a model: on the phone shell the viewport is ~412 CSS px wide, so an
 * agent asking what is on screen got a 412-pixel-wide picture and had to read 11px type out
 * of it; on a HiDPI desktop the same rule produced a 3840px image, every pixel above the
 * cap below being bytes nothing downstream looks at.
 *
 * So the unit is the picture's own long edge, not the device's.
 */

/**
 * The long edge to aim for.
 *
 * 1568 is where Anthropic's vision stack resizes a larger image to, so it is simultaneously
 * the most detail a model can use and the point past which more pixels only cost upload
 * time and tokens. The server's CDP screenshots already downscale to it
 * (`MODEL_SCREENSHOT_MAX_EDGE` in `lib/browser/session.ts`); this is the same number read
 * from the other side — what to scale *up* to when the screen is smaller than the model can
 * see.
 */
export const CAPTURE_TARGET_EDGE = 1568;

/**
 * The most a capture will magnify.
 *
 * Without a ceiling a small window (a 300×200 palette, say) would render at 5× — real
 * detail, but five times the encode cost for a picture whose content is a handful of
 * words. 3× covers the phone shell (412×915 → 1.7×) and every window large enough for an
 * agent to be reading in the first place.
 */
export const MAX_CAPTURE_SCALE = 3;

/**
 * The scale for a capture of a `width`×`height` CSS-pixel box.
 *
 * Never below 1: a capture that shrinks the screen is the failure this exists to prevent,
 * and a viewport already wider than {@link CAPTURE_TARGET_EDGE} is left at its own
 * resolution rather than resampled down — the model's own resize does that better than a
 * canvas does, and downscaling here would throw away detail the API would have kept for a
 * tall narrow screen whose *short* edge still matters.
 */
export function captureScale(width: number, height: number): number {
  const edge = Math.max(width, height);
  if (!(edge > 0)) return 1;
  return Math.min(MAX_CAPTURE_SCALE, Math.max(1, CAPTURE_TARGET_EDGE / edge));
}
