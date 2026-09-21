/**
 * The capture helper: DOM → foreignObject-as-image screenshot pipeline.
 *
 * Grouped here because all four groups below pin the same kind of bug: something that
 * only reproduces against the real shipped script (an ES5 string injected into an app
 * iframe), not against a DOM-shim reproduction, because happy-dom applies no stylesheets
 * and its CSSOM doesn't match a real browser's. Each `describe` documents its own incident.
 */
import { describe, it, expect } from 'bun:test';
import { captureScale, CAPTURE_TARGET_EDGE, MAX_CAPTURE_SCALE } from '../capture-scale.js';
import { IFRAME_CAPTURE_HELPER_SCRIPT } from '../iframe-scripts/capture.js';

/** Source with `//` line comments dropped — the assertions are about code, not prose. */
function shippedCode(): string {
  return IFRAME_CAPTURE_HELPER_SCRIPT.split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
}

describe('capture canvas → img swap', () => {
  // `defaultCapture` composites live canvas pixels by discarding each cloned <canvas>
  // and putting a freshly created <img> in its place. That <img> starts with no class
  // and no id, so the cloned `<head><style>` — the route every *other* element's styling
  // takes into the foreignObject — matches nothing on it. The swap used to assign only
  // the clone's inline `cssText`, on the premise that it "already carries the canvas's
  // layout box"; that is true only for a canvas positioned by a `style=""` attribute.
  // A canvas positioned by a stylesheet rule (`.overlay { position: absolute }`, the
  // ordinary spelling) lost every bit of it and fell back to static positioning, landing
  // in normal document flow roughly its own height below the element it overlays.
  //
  // The live page was never wrong — only the picture, and only for canvases, which is
  // what made it expensive: agents judge app state from this capture, and a selection
  // mask or tracing guide rendered *beside* its canvas instead of *over* it reads as an
  // app bug. See GitHub issue #88, and #73 for the neighbouring failure this must not
  // be "fixed" back into (enumerating computed style over every node in the document).
  //
  // The behaviour under test is class-based cascade resolution through `getComputedStyle`,
  // and happy-dom applies no stylesheets, so a DOM-shim test would pass against the bug —
  // hence grepping the shipped script instead.

  /** The allowlist as the shipped script actually declares it. */
  function swapProps(): string[] {
    const decl = /var CANVAS_SWAP_PROPS = \[([\s\S]*?)\];/.exec(shippedCode());
    if (!decl) throw new Error('CANVAS_SWAP_PROPS is gone — the swap has no allowlist to check');
    return [...decl[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  }

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

describe('capture clone styling', () => {
  // The capture helper must never assign `getComputedStyle(el).cssText` onto a clone.
  //
  // A loop doing exactly that used to run over every cloned element, under the name
  // `inlineStyles` and the stated intent of resolving custom properties and color-mix()
  // for the foreignObject render. CSSOM defines the `cssText` *getter* as the empty
  // string on a computed declaration (individual properties like `.width` still resolve
  // — it is specifically the shorthand serialization that is empty), so the loop assigned
  // `''` to every element and erased the inline `style` attribute `cloneNode(true)` had
  // faithfully copied. A box sized by `el.style.width = '320px'` screenshotted at its
  // content size while the live DOM measured 320px, and the response carried no `reason`
  // and no `degraded` — a plausible, wrong picture, which is the worst kind for an agent
  // reading a screenshot to judge app state.
  //
  // Class-based styling was never affected: the clone carries `<head><style>` into the
  // foreignObject and the SVG document applies it. That is also why the inlining was
  // unnecessary in the first place, and why the fix is to not do it rather than to do it
  // correctly — the correct version enumerates ~500 properties per node into the
  // serialized SVG, freezes layout, and re-applies transforms. See GitHub issue #73.
  //
  // The failure was a live-browser CSSOM behavior no DOM shim reproduces (happy-dom's
  // `cssText` is not empty), so a behavioral test would pass against the bug — grepping
  // the shipped script is the honest test here.

  it('never assigns a computed cssText onto the clone', () => {
    // Any `... = [window.]getComputedStyle(...).cssText`, however the target is spelled.
    const assignsComputedCssText = /=\s*(?:window\.)?getComputedStyle\([^)]*\)\s*\.cssText/;
    expect(shippedCode()).not.toMatch(assignsComputedCssText);
  });

  it('carries the cloned canvas inline style onto its replacement <img>', () => {
    // The one legitimate cssText write, and the clearest witness that clone-side
    // inline style is load-bearing: a canvas positioned or sized by `style=` keeps
    // that box after the swap. Under the wipe this copied the empty string.
    // (Layered under the computed positioning allowlist — see the canvas-swap describe above.)
    expect(shippedCode()).toContain('img.style.cssText = cloneCanvas.style.cssText');
  });

  it('still relies on the cloned <style> blocks it must not strip', () => {
    // Styling reaches the foreignObject only through these. Removing <style> the way
    // <link> is removed would take class-based styling down with it.
    const code = shippedCode();
    expect(code).toContain('querySelectorAll(\'link[rel="stylesheet"]\')');
    expect(code).not.toMatch(/querySelectorAll\('style'\)[\s\S]{0,200}\.remove\(\)/);
  });
});

describe('captureScale', () => {
  // A capture is sized for the model that reads it, not for the screen it came from.
  //
  // The phone shell is ~412 CSS px wide, and both captures used to render one image pixel
  // per CSS pixel (the window capture) or one per device pixel (the monitor capture, where
  // `make claude-dev-mobile` resizes a real window and so leaves `devicePixelRatio` at 1).
  // Either way an agent asking what is on screen got a 412-pixel-wide picture of an
  // interface drawn in 11px type — legible to a person sitting in front of it at 3× the
  // density, illegible in the image.
  //
  // The two implementations cannot share code — one of them is an ES5 string injected into
  // an app iframe — so what is checked below (in "the injected capture script") is that they
  // cannot disagree: the numbers in the shipped script are the exported constants, interpolated.

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

describe('capture url() sanitize pass', () => {
  // The capture helper's "strip every url() except data: URIs" sanitize pass.
  //
  // The screenshot pipeline renders a DOM clone through a foreignObject-as-image, so
  // any non-data url() in the clone taints the canvas — the pass rewrites those to
  // `none`. The load-bearing subtlety: `getComputedStyle().cssText` emits url() values
  // WITH double quotes (`url("data:...")`), and an earlier pattern put the optional
  // quote BEFORE the negative lookahead (`["']?(?!data:)`). The engine then matched the
  // quote as zero-width, evaluated `(?!data:)` at the `"` (which is not `data:`, so it
  // passed), and stripped the very data-URI background it was meant to keep — blank
  // `background-image`, a false debugging trail. The fix moves the quote inside the
  // lookahead. This pins both directions so it can't regress.
  //
  // The regex is embedded in the injected ES5 string, so we lift the real literal out
  // of the shipped script rather than re-declaring a copy that could drift.

  /** The actual `urlNotData` RegExp as it ships inside the capture script. */
  function shippedUrlStripper(): RegExp {
    // Evaluate the exact `/.../g` literal from the source so the test tracks the real
    // pattern (the script string double-escapes backslashes for the template literal).
    const m = IFRAME_CAPTURE_HELPER_SCRIPT.match(/var urlNotData = (\/.*?\/g);/);
    if (!m)
      throw new Error(
        'urlNotData literal not found in capture script — did it move or get renamed?',
      );
    return new Function('return ' + m[1])() as RegExp;
  }

  function strip(css: string): string {
    const re = shippedUrlStripper();
    return css.replace(re, 'none');
  }

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
