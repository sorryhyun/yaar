/**
 * Capturing a frame whose document is an image (a stored `.svg`, `.png`, …) from the host side.
 *
 * Window capture normally asks the frame to draw itself (`iframe-scripts/capture.ts`), but the
 * handler that answers is a `<script>` the renderer appends to the document's `<head>`. An SVG
 * document has no `<head>`, so nothing is ever injected and the request used to time out as a
 * bare `no-response` — which reads as "maybe it had not painted yet, retry", when no retry could
 * ever succeed. An image is also the one kind of document the desktop can draw just as well
 * itself: same-origin storage URLs load into an `<img>` without tainting the canvas.
 */
import { captureScale } from '@yaar/shared';
import type { IframeCaptureResult } from './capture';

/** What the browser serves a stored image as, guessed from its path when the document is unreadable. */
const IMAGE_TYPE_BY_EXTENSION: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
};

/** An image shown as a frame's whole document. */
export interface FrameImage {
  /** The image's MIME type — the document's own, or guessed from the URL's extension. */
  contentType: string;
  /** Where to load the pixels from: a live SVG's serialization, else the document URL. */
  src: string;
  /**
   * Where the image sits in the frame, in the frame's CSS pixels — the box the browser laid
   * the SVG root or the image document's `<img>` out in. Absent for a document this desktop
   * cannot read, which is then fitted to the frame.
   */
  box?: { x: number; y: number; width: number; height: number };
}

/** The frame's document, when it is same-origin to the desktop; null otherwise. */
function readableDocument(iframe: HTMLIFrameElement): Document | null {
  try {
    return iframe.contentDocument;
  } catch {
    return null;
  }
}

function imageTypeOfPath(url: string): string | null {
  try {
    const { pathname } = new URL(url, document.baseURI);
    const ext = pathname.slice(pathname.lastIndexOf('.') + 1).toLowerCase();
    return IMAGE_TYPE_BY_EXTENSION[ext] ?? null;
  } catch {
    return null;
  }
}

function boxOf(el: Element | null): FrameImage['box'] {
  if (!el) return undefined;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0
    ? { x: r.left, y: r.top, width: r.width, height: r.height }
    : undefined;
}

/**
 * The live SVG document, serialized at the size it is shown.
 *
 * Serialized rather than reloaded from its URL so a script-driven SVG is captured as it is now,
 * not as it was first served. The clone is given the shown box as its size (and that box as a
 * `viewBox` when it had none, which is the same user space), so the renderer that rasterizes it
 * at the capture's resolution scales the drawing rather than revealing more of it.
 */
function svgSnapshot(root: Element, box: NonNullable<FrameImage['box']>, scale: number): string {
  const clone = root.cloneNode(true) as Element;
  if (!clone.hasAttribute('viewBox')) {
    clone.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  }
  clone.setAttribute('width', String(Math.round(box.width * scale)));
  clone.setAttribute('height', String(Math.round(box.height * scale)));
  const markup = new XMLSerializer().serializeToString(clone);
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
}

/**
 * The image a frame is showing as its whole document, or null when it shows anything else.
 *
 * A same-origin document answers for itself (`contentType`); a document this desktop cannot
 * read is judged by its URL's extension. A readable document that is *not* an image is never
 * treated as one, whatever its URL ends in — a missing file comes back as an HTML error page.
 */
export function frameImageOf(iframe: HTMLIFrameElement): FrameImage | null {
  const doc = readableDocument(iframe);
  if (doc) {
    const contentType = doc.contentType ?? '';
    if (!contentType.startsWith('image/')) return null;
    const root = doc.documentElement;
    if (contentType === 'image/svg+xml' && root?.localName === 'svg') {
      const box = boxOf(root) ?? {
        x: 0,
        y: 0,
        width: iframe.clientWidth,
        height: iframe.clientHeight,
      };
      const scale = captureScale(iframe.clientWidth, iframe.clientHeight);
      return { contentType, src: svgSnapshot(root, box, scale), box };
    }
    return { contentType, src: doc.URL, box: boxOf(doc.querySelector('img')) };
  }
  const src = iframe.src;
  const contentType = src ? imageTypeOfPath(src) : null;
  return contentType ? { contentType, src } : null;
}

/**
 * The type of a readable document the capture script cannot have been injected into, or null.
 *
 * The renderer appends its scripts to `document.head`; a non-HTML document (SVG, XML) has none,
 * so a capture request to it can only time out. Called once that has happened, to turn the
 * generic `no-response` into a reason that says retrying will not help. An image document is
 * captured host-side before it gets here.
 */
export function handlerlessDocumentType(iframe: HTMLIFrameElement): string | null {
  const doc = readableDocument(iframe);
  if (!doc || doc.head) return null;
  return doc.contentType || 'unknown';
}

/** Where to draw an image in a `width`×`height` frame when its own box is unknown. */
export function fitImageBox(
  naturalWidth: number,
  naturalHeight: number,
  width: number,
  height: number,
): NonNullable<FrameImage['box']> {
  // No intrinsic size (an SVG with only a viewBox) — it fills the frame, as it would there.
  if (!(naturalWidth > 0 && naturalHeight > 0)) return { x: 0, y: 0, width, height };
  // At its own size, shrunk to fit when larger: the picture is for reading the whole image.
  const k = Math.min(1, width / naturalWidth, height / naturalHeight);
  return { x: 0, y: 0, width: naturalWidth * k, height: naturalHeight * k };
}

type LoadedImage = CanvasImageSource & { naturalWidth: number; naturalHeight: number };

export interface ImageCaptureDeps {
  /** Resolves to the loaded image, or null when it failed to load or took too long. */
  loadImage(src: string): Promise<LoadedImage | null>;
  createCanvas(width: number, height: number): HTMLCanvasElement;
}

const IMAGE_LOAD_TIMEOUT_MS = 3000;

const browserDeps: ImageCaptureDeps = {
  loadImage: (src) =>
    new Promise((resolve) => {
      const img = new Image();
      const timer = setTimeout(() => resolve(null), IMAGE_LOAD_TIMEOUT_MS);
      img.onload = () => {
        clearTimeout(timer);
        resolve(img);
      };
      img.onerror = () => {
        clearTimeout(timer);
        resolve(null);
      };
      img.src = src;
    }),
  createCanvas: (width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  },
};

/**
 * Draw a frame's image into a picture of the frame, at the same scale a self-capture uses.
 *
 * Fails with the self-capture script's own reasons: `zero-size` for a frame with no box,
 * `img-load-error` when the image would not load, `taint` when it came from an origin the
 * canvas may not read back (retrying cannot fix either of the last two).
 */
export async function captureFrameImage(
  iframe: HTMLIFrameElement,
  image: FrameImage,
  deps: ImageCaptureDeps = browserDeps,
): Promise<IframeCaptureResult> {
  const width = iframe.clientWidth;
  const height = iframe.clientHeight;
  if (!(width > 0 && height > 0)) return { imageData: null, reason: 'zero-size' };

  const img = await deps.loadImage(image.src);
  if (!img) {
    return {
      imageData: null,
      reason: 'img-load-error',
      detail: `The window shows a ${image.contentType} image that could not be loaded for capture.`,
    };
  }

  const scale = captureScale(width, height);
  const canvas = deps.createCanvas(
    Math.max(1, Math.round(width * scale)),
    Math.max(1, Math.round(height * scale)),
  );
  const ctx = canvas.getContext('2d');
  if (!ctx) return { imageData: null, reason: 'exception', detail: 'No 2D canvas context' };
  const box = image.box ?? fitImageBox(img.naturalWidth, img.naturalHeight, width, height);
  try {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, box.x * scale, box.y * scale, box.width * scale, box.height * scale);
    return { imageData: canvas.toDataURL('image/webp', 0.9) };
  } catch {
    return {
      imageData: null,
      reason: 'taint',
      detail: `The window shows a ${image.contentType} image from an origin the desktop cannot read back.`,
    };
  }
}
