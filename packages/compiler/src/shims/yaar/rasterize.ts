// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * A picture of your own DOM.
 *
 * There is exactly one way to get pixels out of laid-out HTML in a browser
 * sandbox with no rendering library bundled:
 *
 *   DOM -> SVG `foreignObject` -> `img` -> canvas
 *
 * It is four lines to write and about six ways to get wrong, each of which
 * fails quietly — a blank picture, a picture in the wrong font, a canvas that
 * throws when you read it back. This function is those six, closed:
 *
 * 1. **The subtree inherits nothing.** An SVG image is drawn in secure static
 *    mode: no page stylesheet, no `--yaar-*` tokens, no injected webfont, no
 *    network. Whatever the picture needs has to ship inside it, which is what
 *    `css` is for — and why there is no sensible default for it.
 * 2. **A webfont cannot be fetched, only inlined.** Handled for you: the text is
 *    collected, `fonts.inline()` subsets the faces to it, and the resulting
 *    `@font-face` block is prepended to `css`. Pass `fonts: false` to skip.
 * 3. **The font stack must be on the root of the subtree, not on `body`.** The
 *    `foreignObject` wrapper is a `<div>`; there is no `<body>` in it, so a
 *    `body {}` rule silently does nothing and the picture comes out in the UA
 *    default face. The wrapper here carries the family directly.
 * 4. **The markup must be well-formed XML.** An XML parser rejects `<br>` and an
 *    unclosed `<img>`, both of which any Markdown renderer emits. Hence
 *    `XMLSerializer` rather than reading `innerHTML` back.
 * 5. **Every image must already be a `data:` URL** — see rule 1. Done for you.
 * 6. **A `blob:` URL taints the canvas** on some engines, and a tainted canvas
 *    cannot be read back at all. The SVG goes in as a `data:` URL.
 *
 * The element must be **in the document and laid out** — `position:fixed;
 * left:-99999px` is the usual trick. A `display:none` subtree has no metrics,
 * so it rasterises as nothing.
 */

import { inline as inlineFonts, type YaarInlinedFonts } from './fonts.js';
import { storage, storagePath } from './verbs.js';
import { blobToDataUrl } from './files.js';

export interface RasterizeFontOptions {
  /** Family to embed. Defaults to the first proportional family YAAR serves. */
  family?: string;
  /**
   * Weights to embed. Defaults to the weights the subtree actually computes to,
   * so a page of plain body text pays for one face rather than four.
   */
  weights?: number[];
  /**
   * Characters to cover. Defaults to the subtree's text. Widen it if the picture
   * will later have text drawn over it that is not in the DOM.
   */
  text?: string;
}

export interface RasterizeOptions {
  /**
   * The stylesheet the picture carries. Required in practice: the subtree
   * reaches none of the page's CSS, so anything not stated here is missing from
   * the result.
   */
  css?: string;
  /** Source box in CSS pixels. Defaults to the element's own bounding rect. */
  width?: number;
  height?: number;
  /**
   * Device pixels per CSS pixel. 2 buys real sharpness for CJK and code; the
   * canvas costs `width * height * 4 * scale²` bytes, so rasterise pages one at
   * a time rather than raising this.
   */
  scale?: number;
  /** Output format. Default `image/png`. */
  type?: 'image/png' | 'image/jpeg' | 'image/webp';
  /** Encoder quality, 0–1, for the lossy formats. Default 0.92. */
  quality?: number;
  /**
   * Painted before the subtree.
   *
   * JPEG has no alpha channel, so without this every transparent pixel encodes
   * as **black** rather than white. Defaults to white for `image/jpeg` and to
   * transparent for the formats that can express it.
   */
  background?: string;
  /** Embed YAAR's webfonts as a `data:` URL `@font-face`. `false` to skip. */
  fonts?: RasterizeFontOptions | false;
  /** Rewrite every `<img src>` to a `data:` URL first. Default true. */
  inlineImages?: boolean;
}

export interface RasterizeResult {
  blob: Blob;
  /** The canvas, so a caller wanting pixels does not rasterise twice. */
  canvas: HTMLCanvasElement;
  /** Device pixels. */
  width: number;
  height: number;
  /** What `fonts.inline()` returned, or null when fonts were skipped. */
  fonts: YaarInlinedFonts | null;
  /**
   * Image sources that could not be inlined, so those boxes are empty.
   *
   * Reported rather than thrown: one unreachable image should not cost the whole
   * picture, but a silently empty box is exactly the kind of failure that ships.
   */
  skippedImages: string[];
}

/** Weights the subtree actually computes to, so nothing unused is embedded. */
function usedWeights(root: HTMLElement): number[] {
  const seen = new Set<number>();
  const add = (el: Element) => {
    const raw = getComputedStyle(el as HTMLElement).fontWeight;
    const weight = Number.parseInt(raw, 10);
    seen.add(Number.isFinite(weight) ? weight : 400);
  };
  add(root);
  root.querySelectorAll('*').forEach(add);
  return seen.size ? Array.from(seen).sort((a, b) => a - b) : [400];
}

/**
 * Turn every `<img src>` into a `data:` URL, reporting the ones that could not be.
 *
 * Two kinds of source resolve without a permission: a `yaar://` storage URI, read
 * through the SDK, and the tokenised `/api/storage` URL, which the injected fetch
 * proxy passes straight through because it names the API origin. Anything else is
 * a remote URL, and reaching it needs `yaar://http`.
 */
async function inlineImagesIn(host: HTMLElement): Promise<string[]> {
  const skipped: string[] = [];
  await Promise.all(
    Array.from(host.querySelectorAll('img')).map(async (img) => {
      const src = img.getAttribute('src') || '';
      if (!src || src.startsWith('data:')) return;
      try {
        const path = storagePath(src);
        const blob =
          path === null
            ? await (await fetch(src)).blob()
            : ((await storage.read(path, { as: 'blob' })) as Blob);
        img.setAttribute('src', await blobToDataUrl(blob));
      } catch {
        // The box exports empty rather than failing the picture.
        img.removeAttribute('src');
        skipped.push(src);
      }
    }),
  );
  return skipped;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(
        new Error(
          'The subtree could not be rasterised. The usual cause is markup an XML ' +
            'parser rejects, or a resource the SVG cannot reach — see rule 1.',
        ),
      );
    img.src = url;
  });
}

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error(`Canvas could not be encoded as ${type}.`)),
      type,
      quality,
    );
  });
}

/**
 * Rasterise a laid-out element to an image.
 *
 * ```ts
 * const { blob } = await rasterize(pageEl, { css: exportCss, scale: 2 });
 * downloadBlob(blob, 'page.png');
 * ```
 *
 * The element is cloned, so the live DOM is not touched — the image inlining and
 * the font stack apply to the copy.
 */
export async function rasterize(
  element: HTMLElement,
  opts: RasterizeOptions = {},
): Promise<RasterizeResult> {
  const rect = element.getBoundingClientRect();
  const width = Math.max(1, Math.round(opts.width ?? rect.width));
  const height = Math.max(1, Math.round(opts.height ?? rect.height));
  const scale = opts.scale ?? 2;
  const type = opts.type ?? 'image/png';
  const quality = opts.quality ?? 0.92;
  const background = opts.background ?? (type === 'image/jpeg' ? '#ffffff' : null);

  const clone = element.cloneNode(true) as HTMLElement;
  const skippedImages = opts.inlineImages === false ? [] : await inlineImagesIn(clone);

  let embedded: YaarInlinedFonts | null = null;
  if (opts.fonts !== false) {
    const wanted = opts.fonts ?? {};
    const text = wanted.text ?? element.textContent ?? '';
    if (text.trim()) {
      embedded = await inlineFonts(text, {
        family: wanted.family,
        weights: wanted.weights ?? usedWeights(element),
      });
    }
  }

  // The wrapper is the root of the rasterised subtree, so the font stack goes
  // here — a `body {}` rule in `css` would never match anything (rule 3).
  const wrapper = document.createElement('div');
  if (embedded?.faces.length) {
    wrapper.style.fontFamily = `'${embedded.faces[0].family}'`;
  }
  const style = document.createElement('style');
  style.textContent = (embedded?.css ?? '') + (opts.css ?? '');
  wrapper.append(style, clone);

  const xhtml = new XMLSerializer().serializeToString(wrapper);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width * scale}" height="${height * scale}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    `<foreignObject x="0" y="0" width="${width}" height="${height}">${xhtml}</foreignObject></svg>`;
  const img = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));

  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable.');
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  return {
    blob: await encode(canvas, type, quality),
    canvas,
    width: canvas.width,
    height: canvas.height,
    fonts: embedded,
    skippedImages,
  };
}
