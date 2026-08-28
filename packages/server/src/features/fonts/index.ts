/**
 * Turning "these characters, in this family" into faces an app can inline.
 *
 * The shape of what comes back is set by the two things a caller does with it,
 * and it has to be *one* answer to both or they drift apart:
 *
 *  - `css` goes into a rasteriser (an SVG `foreignObject`, a print stylesheet)
 *    as an `@font-face` block whose `src` is a `data:` URL, because that is the
 *    only kind of font an SVG-as-image will load;
 *  - `gids` / `advances` / `metrics` / `outlineTable` go into a PDF writer that
 *    paints the same glyphs as vectors on top of that raster.
 *
 * Handing those two different fonts is the failure this whole subsystem exists
 * to prevent, so they are cut from the same subset in the same call.
 */

import type { FontSubsetFace, FontSubsetRequest, FontSubsetResult } from '@yaar/shared';
import { subsetFace } from '../../lib/fonts/index.js';
import { listFaces, listFamilies, loadFace, matchWeight, type ServedFace } from './catalog.js';

export { listFaces, listFamilies, matchWeight, resetFontCatalogForTest } from './catalog.js';
export type { ServedFace } from './catalog.js';

/**
 * Distinct characters one request may ask for.
 *
 * A subset is bounded by the text on a page, and a few thousand distinct
 * characters is already a dense Korean document. The ceiling is here to stop a
 * caller that passes a whole corpus by mistake from turning one verb call into
 * a multi-megabyte response, and it refuses rather than truncates — a silently
 * shortened character set would come back as tofu in the middle of a page with
 * nothing to explain it.
 */
export const MAX_SUBSET_CHARS = 5000;

/** Faces one request may ask for at once — four weights is the whole family. */
export const MAX_SUBSET_WEIGHTS = 8;

/**
 * The request and result are the wire contract in `@yaar/shared`, restated
 * for the app SDK in the compiler's `bundled-types/index.d.ts`. The local names
 * stay for the server's own callers.
 */
export type SubsetRequest = FontSubsetRequest;
export type SubsetFaceResult = FontSubsetFace;
export type SubsetResult = FontSubsetResult;

/** Thrown for a request this module refuses. Callers turn it into a verb error. */
export class FontRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FontRequestError';
  }
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** A PostScript name has no spaces, and a PDF `/BaseFont` is a bare name. */
function baseFontName(face: ServedFace): string {
  return `${face.family.replace(/\s+/g, '')}-${face.weight}`;
}

function faceCss(family: string, weight: number, style: string, src: string): string {
  return (
    `@font-face{font-family:'${family}';font-weight:${weight};` + `font-style:${style};src:${src};}`
  );
}

/** `@font-face` rules pointing at the *full* files, by URL — for a measuring pass. */
export function urlFaceCss(family?: string): string {
  return listFaces()
    .filter((face) => !family || face.family === family)
    .map((face) =>
      faceCss(
        face.family,
        face.weight,
        face.style,
        `url(${face.url}) format('${face.url.endsWith('.otf') ? 'opentype' : 'truetype'}')`,
      ),
    )
    .join('');
}

/**
 * Subset every requested weight down to `text`.
 *
 * A weight that resolves to no file, or whose file will not parse, is skipped
 * rather than failing the request — the caller still gets the weights that did
 * work, and `missing` still names what nothing covered.
 */
export async function subsetForText(request: SubsetRequest): Promise<SubsetResult> {
  const chars = new Set(Array.from(request.text ?? ''));
  if (chars.size === 0) throw new FontRequestError('Provide `text` — there is nothing to subset.');
  if (chars.size > MAX_SUBSET_CHARS) {
    throw new FontRequestError(
      `Too many distinct characters: ${chars.size} (limit ${MAX_SUBSET_CHARS}). Subset per page rather than per document.`,
    );
  }

  const families = listFamilies();
  if (!families.length) throw new FontRequestError('This build serves no fonts.');
  const family = request.family ?? families.find((f) => !f.mono)?.family ?? families[0].family;
  if (!families.some((f) => f.family === family)) {
    throw new FontRequestError(
      `Unknown font family "${family}". Served: ${families.map((f) => f.family).join(', ')}.`,
    );
  }

  const weights = request.weights?.length ? request.weights : [400];
  if (weights.length > MAX_SUBSET_WEIGHTS) {
    throw new FontRequestError(
      `Too many weights: ${weights.length} (limit ${MAX_SUBSET_WEIGHTS}).`,
    );
  }

  const faces: SubsetFaceResult[] = [];
  const covered = new Set<string>();
  // Two requested weights can resolve to one file (300 and 400 both land on
  // Regular when Light is absent). Subsetting it twice would embed the same
  // bytes twice, so the file is done once and the CSS names it for each weight.
  const byUrl = new Map<string, SubsetFaceResult>();

  for (const weight of weights) {
    const served = matchWeight(family, weight);
    if (!served) continue;

    const done = byUrl.get(served.url);
    if (done) {
      faces.push({ ...done, weight });
      continue;
    }

    const font = await loadFace(served);
    if (!font) continue;

    const subset = subsetFace(font, chars);
    for (const ch of Object.keys(subset.gids)) covered.add(ch);

    const mime = subset.outlines === 'cff' ? 'font/otf' : 'font/ttf';
    const result: SubsetFaceResult = {
      family: served.family,
      weight,
      servedWeight: served.weight,
      style: served.style,
      baseFont: baseFontName(served),
      dataUrl: `data:${mime};base64,${base64(subset.bytes)}`,
      bytes: subset.bytes.length,
      glyphs: subset.glyphs,
      outlines: subset.outlines,
      ...(request.outlineTable && subset.outlineTable
        ? { outlineTableBase64: base64(subset.outlineTable) }
        : {}),
      gids: subset.gids,
      advances: subset.advances,
      metrics: subset.metrics,
    };
    byUrl.set(served.url, result);
    faces.push(result);
  }

  if (!faces.length) {
    throw new FontRequestError(
      `No usable face for "${family}" at weight(s) ${weights.join(', ')}.`,
    );
  }

  const css = faces
    .map((face) =>
      faceCss(
        face.family,
        face.weight,
        face.style,
        // The format hint has to follow the outlines, not the family: a browser
        // that trusts it will refuse a TrueType file announced as 'opentype'.
        `url(${face.dataUrl}) format('${face.outlines === 'cff' ? 'opentype' : 'truetype'}')`,
      ),
    )
    .join('');

  return {
    css,
    faces,
    missing: Array.from(chars).filter((ch) => !covered.has(ch)),
  };
}
