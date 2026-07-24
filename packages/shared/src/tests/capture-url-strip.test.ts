/**
 * The capture helper's "strip every url() except data: URIs" sanitize pass.
 *
 * The screenshot pipeline renders a DOM clone through a foreignObject-as-image, so
 * any non-data url() in the clone taints the canvas — the pass rewrites those to
 * `none`. The load-bearing subtlety: `getComputedStyle().cssText` emits url() values
 * WITH double quotes (`url("data:...")`), and an earlier pattern put the optional
 * quote BEFORE the negative lookahead (`["']?(?!data:)`). The engine then matched the
 * quote as zero-width, evaluated `(?!data:)` at the `"` (which is not `data:`, so it
 * passed), and stripped the very data-URI background it was meant to keep — blank
 * `background-image`, a false debugging trail. The fix moves the quote inside the
 * lookahead. This pins both directions so it can't regress.
 *
 * The regex is embedded in the injected ES5 string, so we lift the real literal out
 * of the shipped script rather than re-declaring a copy that could drift.
 */
import { describe, it, expect } from 'bun:test';
import { IFRAME_CAPTURE_HELPER_SCRIPT } from '../iframe-scripts/capture.js';

/** The actual `urlNotData` RegExp as it ships inside the capture script. */
function shippedUrlStripper(): RegExp {
  // Evaluate the exact `/.../g` literal from the source so the test tracks the real
  // pattern (the script string double-escapes backslashes for the template literal).
  const m = IFRAME_CAPTURE_HELPER_SCRIPT.match(/var urlNotData = (\/.*?\/g);/);
  if (!m)
    throw new Error('urlNotData literal not found in capture script — did it move or get renamed?');
  return new Function('return ' + m[1])() as RegExp;
}

function strip(css: string): string {
  const re = shippedUrlStripper();
  return css.replace(re, 'none');
}

describe('capture url() sanitize pass', () => {
  it('keeps a double-quoted data: URI (the form getComputedStyle emits)', () => {
    const css = 'background-image: url("data:image/png;base64,AAAA")';
    expect(strip(css)).toBe(css);
  });

  it('keeps a single-quoted data: URI', () => {
    const css = "background-image: url('data:image/png;base64,AAAA')";
    expect(strip(css)).toBe(css);
  });

  it('keeps an unquoted data: URI', () => {
    const css = 'background-image: url(data:image/png;base64,AAAA)';
    expect(strip(css)).toBe(css);
  });

  it('keeps a data: URI with leading whitespace inside url()', () => {
    const css = 'background-image: url( "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" )';
    expect(strip(css)).toBe(css);
  });

  it('strips a quoted remote URL (would taint the canvas)', () => {
    const out = strip('background-image: url("https://example.com/bg.png")');
    expect(out).toBe('background-image: none');
    expect(out).not.toContain('example.com');
  });

  it('strips an unquoted remote URL', () => {
    const out = strip('background-image: url(https://example.com/bg.png)');
    expect(out).toBe('background-image: none');
  });

  it('strips a remote URL but keeps a data: URI in the same declaration block', () => {
    const out = strip(
      '.a{background:url("https://x.com/a.png")} .b{background:url("data:image/png;base64,AAAA")}',
    );
    expect(out).toContain('data:image/png;base64,AAAA');
    expect(out).not.toContain('x.com');
  });
});
