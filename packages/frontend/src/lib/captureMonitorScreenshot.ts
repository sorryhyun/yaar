/**
 * Captures a full monitor screenshot with the drawing overlay composited on top.
 *
 * The drawing canvas is registered by DrawingOverlay on mount so that the
 * capture can be triggered from anywhere (e.g. the send flow).
 */
import html2canvas from 'html2canvas';
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
 * Captures the full monitor (document.body) with iframe contents and drawing
 * overlay composited on top.  Returns a WebP data URL.
 *
 * Falls back to the raw drawing canvas if html2canvas fails.
 */
export async function captureMonitorScreenshot(): Promise<string | null> {
  if (!drawingCanvas) return null;

  try {
    const dpr = window.devicePixelRatio || 1;

    // Pre-capture visible iframes (html2canvas can't render them)
    const iframes = document.querySelectorAll('iframe');
    const iframeCaptures: { rect: DOMRect; dataUrl: string }[] = [];

    await Promise.all(
      Array.from(iframes).map(async (iframe) => {
        if (!iframe.contentWindow) return;
        const rect = iframe.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        // Tier 1: self-capture (canvas/svg content inside the iframe)
        const selfData = await tryIframeSelfCapture(iframe, 500);
        if (selfData) {
          iframeCaptures.push({ rect, dataUrl: selfData });
          return;
        }

        // Tier 2: html2canvas on same-origin content document
        try {
          const doc = iframe.contentDocument;
          if (doc?.documentElement) {
            const canvas = await html2canvas(doc.documentElement, {
              useCORS: true,
              logging: false,
              scale: dpr,
              width: iframe.clientWidth || undefined,
              height: iframe.clientHeight || undefined,
            });
            iframeCaptures.push({ rect, dataUrl: canvas.toDataURL('image/webp', 0.9) });
          }
        } catch {
          // Cross-origin — can't capture, will appear blank
        }
      }),
    );

    const screenshot = await html2canvas(document.body, {
      ignoreElements: (element) => element === drawingCanvas,
      useCORS: true,
      logging: false,
      scale: dpr,
    });

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
