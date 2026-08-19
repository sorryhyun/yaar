/**
 * A <canvas> swapped for an <img> must keep the box it was painted in.
 *
 * `defaultCapture` composites live canvas pixels by discarding each cloned <canvas>
 * and putting a freshly created <img> in its place. That <img> starts with no class
 * and no id, so the cloned `<head><style>` — the route every *other* element's styling
 * takes into the foreignObject — matches nothing on it. The swap used to assign only
 * the clone's inline `cssText`, on the premise that it "already carries the canvas's
 * layout box"; that is true only for a canvas positioned by a `style=""` attribute.
 * A canvas positioned by a stylesheet rule (`.overlay { position: absolute }`, the
 * ordinary spelling) lost every bit of it and fell back to static positioning, landing
 * in normal document flow roughly its own height below the element it overlays.
 *
 * The live page was never wrong — only the picture, and only for canvases, which is
 * what made it expensive: agents judge app state from this capture, and a selection
 * mask or tracing guide rendered *beside* its canvas instead of *over* it reads as an
 * app bug. See GitHub issue #88, and #73 for the neighbouring failure this must not
 * be "fixed" back into (enumerating computed style over every node in the document).
 *
 * Grepping the shipped script, as in capture-inline-style.test.ts: the behaviour under
 * test is class-based cascade resolution through `getComputedStyle`, and happy-dom
 * applies no stylesheets, so a DOM-shim test would pass against the bug.
 */
import { describe, it, expect } from 'bun:test';
import { IFRAME_CAPTURE_HELPER_SCRIPT } from '../iframe-scripts/capture.js';

/** Source with `//` line comments dropped — the assertions are about code, not prose. */
function shippedCode(): string {
  return IFRAME_CAPTURE_HELPER_SCRIPT.split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
}

/** The allowlist as the shipped script actually declares it. */
function swapProps(): string[] {
  const decl = /var CANVAS_SWAP_PROPS = \[([\s\S]*?)\];/.exec(shippedCode());
  if (!decl) throw new Error('CANVAS_SWAP_PROPS is gone — the swap has no allowlist to check');
  return [...decl[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
}

describe('capture canvas → img swap', () => {
  it('carries the properties that decide where the box lands', () => {
    // Exactly the reported failure: without `position` the overlay is static, and
    // without the insets it is at the wrong offset even when it is not.
    expect(swapProps()).toEqual(
      expect.arrayContaining([
        'position',
        'top',
        'right',
        'bottom',
        'left',
        'z-index',
        'transform',
      ]),
    );
  });

  it('stays an allowlist rather than an enumeration', () => {
    // #73's rejected fix was ~500 properties per node. This runs on the handful of
    // canvases in a page, and only stays cheap while it is short and explicit.
    const props = swapProps();
    expect(props.length).toBeLessThan(30);
    expect(props).not.toContain('all');
  });

  it('reads the computed style of the live canvas, not of the clone', () => {
    // The clone is detached from the document, so it has no computed style to read —
    // asking it would return initial values and silently reintroduce the bug.
    const code = shippedCode();
    expect(code).toMatch(/getComputedStyle\(origCanvas\)/);
    expect(code).not.toMatch(/getComputedStyle\(cloneCanvas\)/);
    // And the call site must hand over the original, not just the clone it replaces.
    expect(code).toContain('styleSwappedImage(img, origCanvases[i], cc)');
  });

  it('applies each allowlisted property onto the replacement <img>', () => {
    // A list nothing reads would pass every assertion above.
    expect(shippedCode()).toMatch(/img\.style\.setProperty\(prop, value\)/);
  });

  it('sizes the replacement to the canvas border box', () => {
    // The computed `width` resolves to the *content* box, so an <img> given it measures
    // narrower than a bordered canvas and shifts whatever is laid out beside it.
    const code = shippedCode();
    expect(code).toContain("img.style.setProperty('box-sizing', 'border-box')");
    expect(code).toMatch(/setProperty\('width', origCanvas\.offsetWidth \+ 'px'\)/);
    expect(code).toMatch(/setProperty\('height', origCanvas\.offsetHeight \+ 'px'\)/);
  });
});
