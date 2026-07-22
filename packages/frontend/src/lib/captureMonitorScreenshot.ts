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

    // Now safe to drop non-renderable nodes (iframes are composited separately
    // from their self-captures; stylesheets can't load in this context anyway).
    for (const el of clone.querySelectorAll('script, iframe, link[rel="stylesheet"], noscript')) {
      el.remove();
    }

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
