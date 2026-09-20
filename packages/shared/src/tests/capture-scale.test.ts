/**
 * A capture is sized for the model that reads it, not for the screen it came from.
 *
 * The phone shell is ~412 CSS px wide, and both captures used to render one image pixel
 * per CSS pixel (the window capture) or one per device pixel (the monitor capture, where
 * `make claude-dev-mobile` resizes a real window and so leaves `devicePixelRatio` at 1).
 * Either way an agent asking what is on screen got a 412-pixel-wide picture of an
 * interface drawn in 11px type — legible to a person sitting in front of it at 3× the
 * density, illegible in the image.
 *
 * The two implementations cannot share code — one of them is an ES5 string injected into
 * an app iframe — so what is checked here is that they cannot disagree: the numbers in the
 * shipped script are the exported constants, interpolated.
 */
import { describe, it, expect } from 'bun:test';
import { captureScale, CAPTURE_TARGET_EDGE, MAX_CAPTURE_SCALE } from '../capture-scale.js';
import { IFRAME_CAPTURE_HELPER_SCRIPT } from '../iframe-scripts/capture.js';

describe('captureScale', () => {
  it('magnifies a phone-sized screen up to the edge a model can use', () => {
    const scale = captureScale(412, 915);
    expect(scale).toBeGreaterThan(1);
    expect(Math.round(915 * scale)).toBe(CAPTURE_TARGET_EDGE);
  });

  it('never shrinks a screen that is already larger', () => {
    expect(captureScale(1920, 1080)).toBe(1);
  });

  it('stops magnifying a small window rather than paying 5× to enlarge a palette', () => {
    expect(captureScale(300, 200)).toBe(MAX_CAPTURE_SCALE);
  });

  it('answers 1 for a box with no layout, instead of Infinity', () => {
    expect(captureScale(0, 0)).toBe(1);
    expect(captureScale(NaN, NaN)).toBe(1);
  });
});

describe('the injected capture script', () => {
  it('sizes its canvas by the same rule, with the same numbers', () => {
    expect(IFRAME_CAPTURE_HELPER_SCRIPT).toContain(
      `Math.min(${MAX_CAPTURE_SCALE}, Math.max(1, ${CAPTURE_TARGET_EDGE} / edge))`,
    );
    // The scale has to reach the canvas, not just be computed next to it.
    expect(IFRAME_CAPTURE_HELPER_SCRIPT).toContain('svgToCanvas(svg, w, h, captureScale(w, h),');
    expect(IFRAME_CAPTURE_HELPER_SCRIPT).toContain('c.width = Math.max(1, Math.round(w * scale))');
  });
});
