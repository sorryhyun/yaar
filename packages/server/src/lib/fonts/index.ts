/**
 * Font subsetting — the byte-level half, with no idea which faces YAAR ships.
 *
 * Reach for `subsetFace`; the format-specific modules underneath it are an
 * implementation detail, exported only because they are separately testable and
 * that is the whole correctness argument for a subsetter.
 *
 * The catalog of served faces, the loading and the caching are `features/fonts/`.
 */

export { parseOpenType, type OpenTypeFont, type OutlineFormat, type TableRecord } from './otf.js';
export { subsetFace, faceMetrics, type FaceSubset, type FaceMetrics } from './subset.js';
export { subsetCff, inspectCff, type CffSubset, type CffInfo } from './cff-subset.js';
export { subsetGlyf, type GlyfSubset } from './glyf-subset.js';
export { rebuildSfnt } from './sfnt.js';
