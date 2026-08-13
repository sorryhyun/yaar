// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * The fonts YAAR ships, in the two forms an app actually needs them.
 *
 * An app can already load the platform's webfonts the ordinary way — they are
 * served from the site root, and the compiler's injected `@font-face` block
 * means an app's own DOM gets them for free. This module is for the case where
 * that is not enough, which is any moment an app renders its own DOM to a
 * *picture*:
 *
 *   DOM -> SVG `foreignObject` -> `img` -> canvas
 *
 * Chrome draws that SVG in **secure static mode**. It reaches nothing: not the
 * page's stylesheets, not the network, and not a webfont by URL. The only font
 * such an image will load is an `@font-face` whose `src` is a `data:` URL — and
 * a whole face is ~1.6 MB, which is not something to inline per page. So the
 * bytes have to be subsetted first, and subsetting them in the iframe means
 * downloading the full face and writing an OpenType reader and a CFF subsetter.
 *
 * `inline()` is that work, done on the server, which already has the file open.
 * It hands back the `@font-face` block ready to paste, and — for a caller that
 * is also writing a PDF over the top of that raster — the glyph ids, advances
 * and metrics needed to paint the same glyphs as vectors.
 *
 * **The two must come from one call.** A raster laid out with one font and text
 * placed with another drifts: NanumSquareNeo and the system Hangul fallback are
 * ~1.8% apart on Hangul and ~10% on Latin, which is lines of drift down a page.
 * That is why `css` and `gids` are fields of the same result rather than two
 * functions you could accidentally call with different arguments.
 *
 * No permission is needed. The font files are already served unauthenticated
 * (`isStaticAsset`), so a grant here would guard nothing.
 */

import { y } from './verbs.js';

const FONTS_URI = 'yaar://system/fonts';

export interface YaarServedFace {
  family: string;
  /** CSS `font-weight` this file answers for. */
  weight: number;
  style: 'normal' | 'italic';
  /** Where the full face can be fetched, same-origin. */
  url: string;
  /** True when the family is monospaced — what a code block should ask for. */
  mono: boolean;
}

export interface YaarFontCatalog {
  families: Array<{ family: string; mono: boolean; weights: number[] }>;
  faces: YaarServedFace[];
  /** `@font-face` rules pointing at the full files, by URL. */
  css: string;
}

export interface YaarFontMetrics {
  unitsPerEm: number;
  /** Typographic ascent/descent in font units; descent is negative. */
  ascent: number;
  descent: number;
  capHeight: number;
  /** [xMin, yMin, xMax, yMax] in font units. */
  bbox: [number, number, number, number];
}

export interface YaarInlinedFace {
  family: string;
  /** The weight you asked for — key your CSS by this. */
  weight: number;
  /** The weight actually served, when CSS matching landed on another file. */
  servedWeight: number;
  style: 'normal' | 'italic';
  /** PostScript-style name for a PDF `/BaseFont`. */
  baseFont: string;
  /** The subsetted face as a `data:` URL. */
  dataUrl: string;
  bytes: number;
  /** Glyphs carried, excluding `.notdef`. */
  glyphs: number;
  outlines: 'cff' | 'glyf';
  /** Base64 `CFF ` table, when `outlineTable` was asked for. */
  outlineTableBase64?: string;
  /** Character -> glyph id. A character the face lacks is absent. */
  gids: Record<string, number>;
  /** Character -> advance width, in font units. */
  advances: Record<string, number>;
  metrics: YaarFontMetrics;
}

export interface YaarInlinedFonts {
  /** `@font-face` rules carrying the subsets inline. Paste into the SVG's `<style>`. */
  css: string;
  faces: YaarInlinedFace[];
  /**
   * Characters no returned face has a glyph for.
   *
   * Not an error — what to do about them (leave them in the raster, draw them
   * from another family, drop them) is a decision only the caller can make.
   */
  missing: string[];
}

export interface InlineFontsOptions {
  /** Family to subset. Defaults to the first proportional family served. */
  family?: string;
  /**
   * CSS weights to cover, e.g. `[400, 700]`. Each is resolved by CSS font
   * matching against the files served, so asking for 500 gets whichever face a
   * browser would pick. Defaults to `[400]`.
   */
  weights?: number[];
  /**
   * Also return the raw CFF table for a PDF `/FontFile3`. Roughly doubles the
   * response; only a caller embedding glyphs in a PDF wants it.
   */
  outlineTable?: boolean;
}

/** The faces this build serves, with the by-URL `@font-face` rules. */
export async function faces(): Promise<YaarFontCatalog> {
  return y.read(FONTS_URI);
}

/**
 * Subset the platform's faces down to `text` and return them inline.
 *
 * ```ts
 * const { css, missing } = await fonts.inline(page.innerText, { weights: [400, 700] });
 * const svg = `<svg …><foreignObject …><style>${appCss}${css}</style>${xhtml}</foreignObject></svg>`;
 * ```
 *
 * Pass the *whole* page's text, not a sample: a character left out is a
 * character the picture renders in a fallback face. Duplicates and whitespace
 * cost nothing — only distinct characters count, up to 5000 per call.
 */
export async function inline(
  text: string,
  opts: InlineFontsOptions = {},
): Promise<YaarInlinedFonts> {
  return y.invoke(FONTS_URI, {
    text,
    ...(opts.family ? { family: opts.family } : {}),
    ...(opts.weights ? { weights: opts.weights } : {}),
    ...(opts.outlineTable ? { outlineTable: true } : {}),
  });
}

/**
 * `@font-face` rules pointing at the full files, for a *measuring* pass.
 *
 * Measure against these, rasterise with `inline()`: the subset keeps every glyph
 * index and every metrics table byte-identical to the full face, so
 * measurements taken here stay valid for the font that actually gets embedded.
 */
export async function faceCss(family?: string): Promise<string> {
  const catalog = await faces();
  if (!family) return catalog.css;
  // Filtering here rather than asking the server for it: the catalog is small,
  // cheap, and a caller usually wants both this and `faces` anyway.
  return catalog.faces
    .filter((face) => face.family === family)
    .map(
      (face) =>
        `@font-face{font-family:'${face.family}';font-weight:${face.weight};` +
        `font-style:${face.style};src:url(${face.url}) ` +
        `format('${face.url.endsWith('.otf') ? 'opentype' : 'truetype'}');}`,
    )
    .join('');
}

export const fonts = { faces, faceCss, inline };
