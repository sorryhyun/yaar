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

import type { FontSubsetRequest, FontCatalog, FontSubsetResult } from '@yaar/shared';
import { y } from './verbs.js';

const FONTS_URI = 'yaar://system/fonts';

// The result shapes are the wire contract in `@yaar/shared`; the `Yaar*` names
// are what apps have imported since the SDK shipped. The app-facing copy with
// doc comments lives in `bundled-types/index.d.ts` (kept in step by
// `bundled-types-parity.test.ts`); this file is `@ts-nocheck`, so these aliases
// only matter to a reader.
export type {
  ServedFontFace as YaarServedFace,
  FontCatalog as YaarFontCatalog,
  FontMetrics as YaarFontMetrics,
  FontSubsetFace as YaarInlinedFace,
  FontSubsetResult as YaarInlinedFonts,
} from '@yaar/shared';
export type InlineFontsOptions = Omit<FontSubsetRequest, 'text'>;

/** The faces this build serves, with the by-URL `@font-face` rules. */
export async function faces(): Promise<FontCatalog> {
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
): Promise<FontSubsetResult> {
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
