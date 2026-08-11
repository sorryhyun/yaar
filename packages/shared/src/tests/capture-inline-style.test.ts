/**
 * The capture helper must never assign `getComputedStyle(el).cssText` onto a clone.
 *
 * A loop doing exactly that used to run over every cloned element, under the name
 * `inlineStyles` and the stated intent of resolving custom properties and color-mix()
 * for the foreignObject render. CSSOM defines the `cssText` *getter* as the empty
 * string on a computed declaration (individual properties like `.width` still resolve
 * — it is specifically the shorthand serialization that is empty), so the loop assigned
 * `''` to every element and erased the inline `style` attribute `cloneNode(true)` had
 * faithfully copied. A box sized by `el.style.width = '320px'` screenshotted at its
 * content size while the live DOM measured 320px, and the response carried no `reason`
 * and no `degraded` — a plausible, wrong picture, which is the worst kind for an agent
 * reading a screenshot to judge app state.
 *
 * Class-based styling was never affected: the clone carries `<head><style>` into the
 * foreignObject and the SVG document applies it. That is also why the inlining was
 * unnecessary in the first place, and why the fix is to not do it rather than to do it
 * correctly — the correct version enumerates ~500 properties per node into the
 * serialized SVG, freezes layout, and re-applies transforms.
 *
 * Grepping the shipped script is the honest test here: the failure was a live-browser
 * CSSOM behavior no DOM shim reproduces (happy-dom's `cssText` is not empty), so a
 * behavioral test would pass against the bug. See GitHub issue #73.
 */
import { describe, it, expect } from 'bun:test';
import { IFRAME_CAPTURE_HELPER_SCRIPT } from '../iframe-scripts/capture.js';

/** Source with `//` line comments dropped — the ban is on code, not on prose about it. */
function shippedCode(): string {
  return IFRAME_CAPTURE_HELPER_SCRIPT.split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
}

describe('capture clone styling', () => {
  it('never assigns a computed cssText onto the clone', () => {
    // Any `... = [window.]getComputedStyle(...).cssText`, however the target is spelled.
    const assignsComputedCssText = /=\s*(?:window\.)?getComputedStyle\([^)]*\)\s*\.cssText/;
    expect(shippedCode()).not.toMatch(assignsComputedCssText);
  });

  it('carries the cloned canvas inline style onto its replacement <img>', () => {
    // The one legitimate cssText write, and the clearest witness that clone-side
    // inline style is load-bearing: a canvas positioned or sized by `style=` keeps
    // that box after the swap. Under the wipe this copied the empty string.
    expect(shippedCode()).toContain('img.style.cssText = cc.style.cssText');
  });

  it('still relies on the cloned <style> blocks it must not strip', () => {
    // Styling reaches the foreignObject only through these. Removing <style> the way
    // <link> is removed would take class-based styling down with it.
    const code = shippedCode();
    expect(code).toContain('querySelectorAll(\'link[rel="stylesheet"]\')');
    expect(code).not.toMatch(/querySelectorAll\('style'\)[\s\S]{0,200}\.remove\(\)/);
  });
});
