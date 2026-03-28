/**
 * Captures a full monitor screenshot with the drawing overlay composited on top.
 *
 * The drawing canvas is registered by DrawingOverlay on mount so that the
 * capture can be triggered from anywhere (e.g. the send flow).
 */
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
 * Capture the full page body via foreignObject SVG.
 * Inlines computed styles on every element so CSS custom properties,
 * color-mix(), grid, etc. render correctly in the SVG context.
 */
async function captureBodyViaForeignObject(dpr: number): Promise<HTMLCanvasElement | null> {
  try {
    const docEl = document.documentElement;
    const w = docEl.clientWidth;
    const h = docEl.clientHeight;
    if (w <= 0 || h <= 0) return null;

    const clone = docEl.cloneNode(true) as HTMLElement;

    // Remove scripts and iframes from clone (not needed for rendering)
    for (const el of clone.querySelectorAll('script, iframe')) el.remove();

    // Inline computed styles to resolve CSS variables, color-mix, etc.
    const originals = docEl.querySelectorAll('*');
    const clones = clone.querySelectorAll('*');
    clone.style.cssText = window.getComputedStyle(docEl).cssText;
    for (let i = 0; i < originals.length && i < clones.length; i++) {
      const c = clones[i] as HTMLElement;
      if (c.style) c.style.cssText = window.getComputedStyle(originals[i]).cssText;
    }

    const serializer = new XMLSerializer();
    const xhtml = serializer.serializeToString(clone);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      `<foreignObject width="100%" height="100%">${xhtml}</foreignObject></svg>`;

    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    try {
      const img = await loadImage(url);
      const canvas = document.createElement('canvas');
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      const ctx = canvas.getContext('2d')!;
      ctx.scale(dpr, dpr);
      ctx.drawImage(img, 0, 0, w, h);
      return canvas;
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return null;
  }
}

/**
 * Captures the full monitor (document.body) with iframe contents and drawing
 * overlay composited on top.  Returns a WebP data URL.
 *
 * Falls back to the raw drawing canvas if body capture fails.
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

        const selfData = await tryIframeSelfCapture(iframe, 2000);
        if (selfData) {
          iframeCaptures.push({ rect, dataUrl: selfData });
        }
      }),
    );

    const screenshot = await captureBodyViaForeignObject(dpr);
    if (!screenshot) {
      // Fallback to raw drawing canvas (strokes only)
      return drawingCanvas.toDataURL('image/webp', 1.0);
    }

    const compositeCanvas = document.createElement('canvas');
    compositeCanvas.width = screenshot.width;
    compositeCanvas.height = screenshot.height;
    const ctx = compositeCanvas.getContext('2d');

    if (ctx) {
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
    }
  } catch {
    // Fallback to raw drawing canvas (strokes only)
    if (drawingCanvas) {
      return drawingCanvas.toDataURL('image/webp', 1.0);
    }
  }

  return null;
}
