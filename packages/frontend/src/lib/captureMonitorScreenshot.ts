/**
 * Captures a full monitor screenshot with the drawing overlay composited on top.
 *
 * The drawing canvas is registered by DrawingOverlay on mount so that the
 * capture can be triggered from anywhere (e.g. the send flow).
 */
import { PALETTE_DARK } from '@yaar/shared';
import { tryIframeSelfCapture } from '@/store';

let drawingCanvas: HTMLCanvasElement | null = null;

export function registerDrawingCanvas(canvas: HTMLCanvasElement | null) {
  drawingCanvas = canvas;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * Desktop background color for the capture. Every output must be opaque: a
 * transparent WebP is composited onto black by most viewers (including model
 * image ingestion), which turns a failed capture into a "black screenshot".
 */
function desktopBackgroundColor(): string {
  const bg = window.getComputedStyle(document.body).backgroundColor;
  if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') return bg;
  return PALETTE_DARK.bg;
}

// Tags whose computed style is irrelevant to rendering — skipped when inlining.
const SKIP_STYLE_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'IFRAME', 'HEAD']);

/**
 * Serialize an element's computed style to a cssText string.
 * `getComputedStyle().cssText` is empty in Chrome, so properties must be
 * enumerated one by one. Assigning the built string once per element is far
 * cheaper than per-property setProperty calls.
 */
function computedCssText(el: Element): string {
  const cs = window.getComputedStyle(el);
  let text = '';
  for (let i = 0; i < cs.length; i++) {
    const prop = cs[i];
    text += `${prop}:${cs.getPropertyValue(prop)};`;
  }
  return text;
}

/**
 * Copy live form state onto the clone as attributes.
 *
 * cloneNode(true) copies attributes, not IDL properties, so a value assigned in
 * JS (`input.value = x`, or a React `value=` binding) is absent from the clone
 * and the screenshot shows empty fields over a populated UI — the command
 * palette's own text included. Mirrors `inlineFormState` in the iframe capture
 * helper (`@yaar/shared/iframe-scripts/capture.ts`); that copy is an injected
 * ES5 string and cannot import this one.
 *
 * Index-paired against the original, so it must run while the two trees are
 * still identical.
 */
export function inlineFormState(clone: HTMLElement, original: HTMLElement) {
  // Only the tags handled below, so both trees pair on the same element set.
  const SEL = 'input, textarea, option';
  const originals = original.querySelectorAll(SEL);
  const clones = clone.querySelectorAll(SEL);
  for (let i = 0; i < originals.length && i < clones.length; i++) {
    const o = originals[i];
    const c = clones[i];
    if (o instanceof HTMLInputElement && c instanceof HTMLInputElement) {
      const type = (o.getAttribute('type') || o.type || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        // The attribute is defaultChecked; the property is the live state.
        if (o.checked) c.setAttribute('checked', '');
        else c.removeAttribute('checked');
      } else if (type === 'file') {
        // No settable serialization — the browser paints its own chrome.
        continue;
      } else if (type === 'password') {
        // Same pixels the browser draws (dots) without carrying the secret
        // into the serialized clone.
        c.setAttribute('value', '•'.repeat(o.value.length));
      } else {
        c.setAttribute('value', o.value);
      }
    } else if (o instanceof HTMLTextAreaElement && c instanceof HTMLTextAreaElement) {
      // A textarea renders its child text, not a value attribute.
      c.textContent = o.value;
    } else if (o instanceof HTMLOptionElement && c instanceof HTMLOptionElement) {
      // Carries which option the closed <select> displays.
      if (o.selected) c.setAttribute('selected', '');
      else c.removeAttribute('selected');
    }
  }
}

// XML 1.0 forbids C0 controls other than tab/LF/CR, plus U+FFFE/U+FFFF.
// eslint-disable-next-line no-control-regex -- matching them is the point
const XML_BAD_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g;
// After lone highs are gone, every remaining high starts a valid pair — so a
// low is legitimate iff a high precedes it: keep pairs, drop bare lows.
const LOW_OR_PAIR = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uDC00-\uDFFF]/g;
// Conservative ASCII XML Name. No colon: a colon in a null-namespace node's
// qualified name is a fake prefix the serializer will emit unbound. Genuinely
// namespaced nodes (inline SVG, xlink:href) carry a real namespaceURI and are
// left alone — the serializer declares those bindings itself.
const VALID_XML_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

function cleanXmlText(s: string): string {
  return s
    .replace(XML_BAD_CHARS, '')
    .replace(LONE_HIGH_SURROGATE, '')
    .replace(LOW_OR_PAIR, (m) => (m.length === 2 ? m : ''));
}

/**
 * Make the clone XML-serializable. XMLSerializer does not guarantee well-formed
 * XML for an HTML-parsed tree, and the SVG-as-image load is an XML parse — so
 * markup the live DOM renders fine (an `html`-renderer window's content, say)
 * can still fail the whole snapshot: comments containing `--`, fake-namespace
 * elements like `<o:p>` from Word paste, attribute names that are not XML
 * Names, control characters outside the XML range. Mirrors `scrubForXml` in
 * the iframe capture helper (`@yaar/shared/iframe-scripts/capture.ts`); that
 * copy is an injected ES5 string and cannot import this one.
 *
 * Mutates only the clone; must run after the index-paired passes.
 */
export function scrubForXml(root: HTMLElement) {
  // Comments render nothing and PIs don't exist in sane HTML — drop both.
  // Numeric whatToShow: NodeFilter is not a global in every DOM (happy-dom).
  const walker = document.createTreeWalker(root, 192 /* COMMENT | PI */);
  const junk: Node[] = [];
  while (walker.nextNode()) junk.push(walker.currentNode);
  for (const node of junk) node.parentNode?.removeChild(node);

  // Reverse order so an invalid element nested in another is unwrapped first.
  const els = root.querySelectorAll('*');
  for (let i = els.length - 1; i >= 0; i--) {
    const el = els[i];
    const ns = el.namespaceURI;
    if ((ns == null || ns === XHTML_NS) && !VALID_XML_NAME.test(el.nodeName)) {
      // Unwrap: keep the content, lose the unserializable tag.
      const parent = el.parentNode;
      if (!parent) continue;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
      continue;
    }
    for (let j = el.attributes.length - 1; j >= 0; j--) {
      const a = el.attributes[j];
      if (a.namespaceURI == null && a.name !== 'xmlns' && !VALID_XML_NAME.test(a.name)) {
        el.removeAttributeNode(a);
      } else if (a.value) {
        const cleaned = cleanXmlText(a.value);
        if (cleaned !== a.value) a.value = cleaned;
      }
    }
  }

  const textWalker = document.createTreeWalker(root, 4 /* SHOW_TEXT */);
  while (textWalker.nextNode()) {
    const t = textWalker.currentNode;
    const cleaned = cleanXmlText(t.nodeValue ?? '');
    if (cleaned !== t.nodeValue) t.nodeValue = cleaned;
  }
}

/**
 * Capture the full page body via foreignObject SVG.
 *
 * External stylesheets never load inside an SVG-as-image context, so every
 * element's computed style is inlined — this also bakes in resolved CSS
 * custom properties, color-mix(), etc. Style inlining must happen BEFORE any
 * nodes are removed from the clone: querySelectorAll on the original and the
 * clone only pair up index-by-index while the two trees are still identical.
 */
async function captureBodyViaForeignObject(dpr: number): Promise<HTMLCanvasElement | null> {
  try {
    const docEl = document.documentElement;
    const w = docEl.clientWidth;
    const h = docEl.clientHeight;
    if (w <= 0 || h <= 0) return null;

    const clone = docEl.cloneNode(true) as HTMLElement;

    const originals = docEl.querySelectorAll('*');
    const clones = clone.querySelectorAll('*');
    clone.style.cssText = computedCssText(docEl);
    for (let i = 0; i < originals.length && i < clones.length; i++) {
      const c = clones[i] as HTMLElement;
      if (!c.style || SKIP_STYLE_TAGS.has(c.tagName)) continue;
      c.style.cssText = computedCssText(originals[i]);
    }
    inlineFormState(clone, docEl);

    // Now safe to drop non-renderable nodes (iframes are composited separately
    // from their self-captures; stylesheets can't load in this context anyway).
    for (const el of clone.querySelectorAll('script, iframe, link[rel="stylesheet"], noscript')) {
      el.remove();
    }
    // Last mutation before serializing: markup the HTML parser tolerated but
    // XML rejects would otherwise fail the whole snapshot load.
    scrubForXml(clone);

    const serializer = new XMLSerializer();
    const xhtml = serializer.serializeToString(clone);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      `<foreignObject width="100%" height="100%">${xhtml}</foreignObject></svg>`;

    // data: URI, NOT a blob URL — Chrome taints the canvas when a
    // foreignObject SVG loaded from a blob URL is drawn into it, which makes
    // the later toDataURL() throw and silently degrades to strokes-only.
    // The same SVG as a data: URI stays clean.
    const dataUri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

    const img = await loadImage(dataUri);
    const canvas = document.createElement('canvas');
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.drawImage(img, 0, 0, w, h);
    return canvas;
  } catch {
    return null;
  }
}

/** Strokes-only fallback, composited over an opaque desktop background. */
function strokesFallback(): string | null {
  if (!drawingCanvas) return null;
  const canvas = document.createElement('canvas');
  canvas.width = drawingCanvas.width;
  canvas.height = drawingCanvas.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return drawingCanvas.toDataURL('image/webp', 1.0);
  ctx.fillStyle = desktopBackgroundColor();
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(drawingCanvas, 0, 0);
  return canvas.toDataURL('image/webp', 1.0);
}

/**
 * Captures the full monitor (document.body) with iframe contents and drawing
 * overlay composited on top.  Returns a WebP data URL.
 *
 * Falls back to the drawing strokes over a solid background if body capture fails.
 */
export async function captureMonitorScreenshot(): Promise<string | null> {
  if (!drawingCanvas) return null;

  try {
    const dpr = window.devicePixelRatio || 1;

    // Pre-capture visible iframes via self-capture (canvas/svg/DOM foreignObject)
    const iframes = document.querySelectorAll('iframe');
    const iframeCaptures: { rect: DOMRect; dataUrl: string }[] = [];

    await Promise.all(
      Array.from(iframes).map(async (iframe) => {
        if (!iframe.contentWindow) return;
        const rect = iframe.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        const { imageData } = await tryIframeSelfCapture(iframe, 2000);
        if (imageData) {
          iframeCaptures.push({ rect, dataUrl: imageData });
        }
      }),
    );

    const screenshot = await captureBodyViaForeignObject(dpr);
    if (!screenshot) return strokesFallback();

    const compositeCanvas = document.createElement('canvas');
    compositeCanvas.width = screenshot.width;
    compositeCanvas.height = screenshot.height;
    const ctx = compositeCanvas.getContext('2d');
    if (!ctx) return strokesFallback();

    ctx.fillStyle = desktopBackgroundColor();
    ctx.fillRect(0, 0, compositeCanvas.width, compositeCanvas.height);
    ctx.drawImage(screenshot, 0, 0);

    // Overlay iframe captures at their screen positions
    for (const { rect, dataUrl } of iframeCaptures) {
      const img = await loadImage(dataUrl);
      ctx.drawImage(img, rect.left * dpr, rect.top * dpr, rect.width * dpr, rect.height * dpr);
    }

    // Overlay drawing strokes on top
    ctx.drawImage(
      drawingCanvas,
      0,
      0,
      drawingCanvas.width,
      drawingCanvas.height,
      0,
      0,
      screenshot.width,
      screenshot.height,
    );
    return compositeCanvas.toDataURL('image/webp', 1.0);
  } catch {
    return strokesFallback();
  }
}
