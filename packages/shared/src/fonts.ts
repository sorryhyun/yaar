/**
 * The wire contract of `yaar://system/fonts` — what the server answers and what
 * the app SDK (`fonts.faces()` / `fonts.inline()`) hands back.
 *
 * One declaration, two consumers. `packages/server/src/features/fonts` builds
 * these shapes; the app-facing `@bundled/yaar` declarations in
 * `packages/compiler/src/bundled-types/index.d.ts` restate them under `Yaar*`
 * names (that file is sliced verbatim into what an agent reads, so it cannot
 * import), and `bundled-types-parity.test.ts` proves the restatement is
 * field-for-field identical. Add a field here and that test names the copy
 * that fell behind.
 */

/** One font file the server serves, and what CSS asks for to get it. */
export interface ServedFontFace {
  family: string;
  /** CSS `font-weight` this file answers for. */
  weight: number;
  style: 'normal' | 'italic';
  /** Where the full face can be fetched, same-origin and unauthenticated. */
  url: string;
  /** True when the family is monospaced — what a code block should ask for. */
  mono: boolean;
}

/** A family and the weights it is served in. */
export interface FontFamilySummary {
  family: string;
  mono: boolean;
  weights: number[];
}

/** `read('yaar://system/fonts')`. */
export interface FontCatalog {
  families: FontFamilySummary[];
  faces: ServedFontFace[];
  /** `@font-face` rules pointing at the full files, by URL. */
  css: string;
}

/** Vertical metrics of a face, in font units. */
export interface FontMetrics {
  unitsPerEm: number;
  /** Typographic ascent/descent in font units; descent is negative. */
  ascent: number;
  descent: number;
  capHeight: number;
  /** [xMin, yMin, xMax, yMax] in font units. */
  bbox: [number, number, number, number];
}

/** `invoke('yaar://system/fonts', request)`. */
export interface FontSubsetRequest {
  /** Characters to cover. Duplicates and whitespace are harmless. */
  text: string;
  /** Family to subset, as the catalog reports it. Defaults to the first proportional family served. */
  family?: string;
  /**
   * CSS weights to cover, e.g. `[400, 700]`. Each is resolved by CSS font
   * matching against the files served, so asking for 500 gets whichever face a
   * browser would pick. Defaults to `[400]`.
   */
  weights?: number[];
  /**
   * Also return the raw CFF table, base64'd, for a PDF `/FontFile3`. Roughly
   * doubles the response; only a caller embedding glyphs in a PDF wants it.
   */
  outlineTable?: boolean;
}

/** One subsetted face in a {@link FontSubsetResult}. */
export interface FontSubsetFace {
  family: string;
  /** The weight *asked for*, so a caller can key its CSS by it. */
  weight: number;
  /** The weight actually served, when CSS matching resolved to a different file. */
  servedWeight: number;
  style: 'normal' | 'italic';
  /** PostScript-style name for a PDF `/BaseFont`. */
  baseFont: string;
  /** The subsetted face as a `data:` URL — an `@font-face` `src`. */
  dataUrl: string;
  /** Subset size in bytes, before base64. */
  bytes: number;
  /** Glyphs carried, excluding `.notdef`. */
  glyphs: number;
  outlines: 'cff' | 'glyf';
  /** Base64 `CFF ` table when `outlineTable` was asked for and the face is CFF. */
  outlineTableBase64?: string;
  /** Requested character -> glyph id. A character the face lacks is absent. */
  gids: Record<string, number>;
  /** Requested character -> advance width, in font units. */
  advances: Record<string, number>;
  metrics: FontMetrics;
}

/** What `invoke('yaar://system/fonts', …)` answers. */
export interface FontSubsetResult {
  /** `@font-face` rules carrying the subsets inline, ready to paste. */
  css: string;
  faces: FontSubsetFace[];
  /**
   * Characters no returned face has a glyph for.
   *
   * Reported rather than thrown: what to do about them (leave them in the
   * raster, draw them from another family, drop them) is a decision only the
   * caller can make, and one uncovered emoji should not cost a whole page.
   */
  missing: string[];
}
