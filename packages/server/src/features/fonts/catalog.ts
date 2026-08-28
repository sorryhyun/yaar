/**
 * The faces YAAR serves, and how to get bytes out of one.
 *
 * The platform has always *published* its webfonts — the frontend loads them by
 * URL, and `isStaticAsset` serves them unauthenticated. What it could not do was
 * hand an app the bytes. That gap is why a slide app ended up carrying its own
 * OpenType reader and CFF subsetter: an SVG image is rasterised in Chrome's
 * secure static mode, where a webfont cannot be *fetched* at all and only a
 * `data:` URL `@font-face` is honoured. A whole face is ~1.6 MB, so inlining one
 * is only practical subsetted, and subsetting needs the bytes.
 *
 * So this module is the catalog and the loader; `lib/fonts/` is the subsetter it
 * feeds; `handlers/fonts.ts` is the door.
 *
 * ## A face nobody shipped is simply absent
 *
 * `listFaces()` filters to files that exist. A build without the monospace
 * family reports a catalog without it and every caller degrades the way it
 * already degrades for a character no face covers — rather than a 500 from a
 * missing file, or a catalog that promises a face the subsetter would then fail
 * on. Dropping the file into `packages/frontend/public/` is the entire install.
 */

import { getFrontendAsset } from '../../config.js';
import { createLogger } from '../../observability/log.js';
import type { FontFamilySummary, ServedFontFace } from '@yaar/shared';
import { parseOpenType, type OpenTypeFont } from '../../lib/fonts/index.js';

const log = createLogger('Fonts');

/** The wire shape (`@yaar/shared`): what `read('yaar://system/fonts')` lists per face. */
export type ServedFace = ServedFontFace;

/**
 * Every face the repo can serve, whether or not its file is present.
 *
 * Order matters only for readability; matching is by family and weight.
 *
 * NanumSquareNeo is CFF-flavoured (`OTTO`) and D2Coding is TrueType, which is
 * not an accident of packaging — it is why `lib/fonts/` carries a subsetter for
 * each. Both are the upstream releases, unconverted: a `.woff2` would have
 * needed a Brotli decompressor before a single byte could be read.
 *
 * **The monospace family ships one weight and the proportional one ships four.**
 * D2Coding is 4.19 MB *per weight* — it covers the full Hangul syllable block,
 * which is the whole reason to prefer it over a Latin-only code face. Bold is
 * another 4.36 MB in the repo forever, and it buys the one case where a code
 * block is set bold. Without it `matchWeight` resolves 700 down to 400, so bold
 * code renders regular rather than falling out of the family — which is the
 * failure that would matter, and it does not happen. Adding it is dropping
 * `D2CodingBold.ttf` beside `D2Coding.ttf`; the row is already written and
 * `listFaces()` picks it up with no other change.
 */
const DECLARED: readonly ServedFace[] = [
  {
    family: 'NanumSquareNeo',
    weight: 300,
    style: 'normal',
    url: '/NanumSquareNeoOTF-Lt.otf',
    mono: false,
  },
  {
    family: 'NanumSquareNeo',
    weight: 400,
    style: 'normal',
    url: '/NanumSquareNeoOTF-Rg.otf',
    mono: false,
  },
  {
    family: 'NanumSquareNeo',
    weight: 700,
    style: 'normal',
    url: '/NanumSquareNeoOTF-Bd.otf',
    mono: false,
  },
  {
    family: 'NanumSquareNeo',
    weight: 800,
    style: 'normal',
    url: '/NanumSquareNeoOTF-Eb.otf',
    mono: false,
  },
  { family: 'D2Coding', weight: 400, style: 'normal', url: '/D2Coding.ttf', mono: true },
  { family: 'D2Coding', weight: 700, style: 'normal', url: '/D2CodingBold.ttf', mono: true },
];

let available: ServedFace[] | undefined;

/** The faces this build can actually serve, in declaration order. */
export function listFaces(): ServedFace[] {
  if (available) return available;
  available = DECLARED.filter((face) => getFrontendAsset(face.url) !== null);
  const missing = DECLARED.length - available.length;
  if (missing > 0)
    log.info('font files absent from this build', { missing, served: available.length });
  return available;
}

/** The families served, each with the weights it has files for. */
export function listFamilies(): FontFamilySummary[] {
  const byFamily = new Map<string, FontFamilySummary>();
  for (const face of listFaces()) {
    const hit = byFamily.get(face.family);
    if (hit) hit.weights.push(face.weight);
    else
      byFamily.set(face.family, { family: face.family, mono: face.mono, weights: [face.weight] });
  }
  return Array.from(byFamily.values());
}

/**
 * Which face a browser would pick for a computed `font-weight`.
 *
 * This has to *mirror* CSS font matching rather than approximate it: a caller
 * embeds whichever face this returns and lays text out with whichever face the
 * browser picked, so a disagreement means one weight drawn and another measured.
 * The rule is CSS Fonts 4 §5.2 for the common case — at or below 500, prefer
 * weights at or below the target, descending; above 500, prefer weights at or
 * above it, ascending; then fall back across the gap.
 */
export function matchWeight(family: string, weight: number): ServedFace | null {
  const faces = listFaces().filter((face) => face.family === family);
  if (!faces.length) return null;

  const target = Number.isFinite(weight) ? weight : 400;
  const below = faces.filter((f) => f.weight <= target).sort((a, b) => b.weight - a.weight);
  const above = faces.filter((f) => f.weight >= target).sort((a, b) => a.weight - b.weight);
  const order = target <= 500 ? [...below, ...above] : [...above, ...below];
  return order[0] ?? null;
}

/**
 * Parsed faces, keyed by URL.
 *
 * Held for the process: the files are read-only build artifacts, and parsing one
 * walks tables a Korean face has tens of thousands of entries in. The parsed
 * object keeps a reference to the whole file (`bytes`), so this is ~1.6 MB per
 * face in exchange for never re-reading one.
 */
const parsed = new Map<string, Promise<OpenTypeFont | null>>();

/** Load and parse one face. Null when the file is absent or unreadable. */
export function loadFace(face: ServedFace): Promise<OpenTypeFont | null> {
  const hit = parsed.get(face.url);
  if (hit) return hit;

  const pending = (async () => {
    const path = getFrontendAsset(face.url);
    if (!path) return null;
    try {
      return parseOpenType(await Bun.file(path).arrayBuffer());
    } catch (err) {
      // Not fatal: the caller degrades to whatever it does for an uncovered
      // character. A broken font file should not take a request down.
      log.warn('could not parse font face', {
        family: face.family,
        weight: face.weight,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  })();
  parsed.set(face.url, pending);
  return pending;
}

/** Drop the caches. Tests only — `getFrontendAsset` is resolved once per file. */
export function resetFontCatalogForTest(): void {
  available = undefined;
  parsed.clear();
}
