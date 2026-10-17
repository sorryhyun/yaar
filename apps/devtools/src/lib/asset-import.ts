export {};

// Decisions behind copyFile's two import doors — storage and another app's source —
// kept apart from the I/O so the rules can be pinned without a storage round trip.

/** Formats a WebP re-encode can be asked to shrink. WebP and SVG are already the target. */
const RECOMPRESSIBLE = new Set(['png', 'jpg', 'jpeg', 'bmp']);

/**
 * The subset re-encoded when the caller did not say. PNG is left out: it is lossless,
 * and the PNGs worth importing are pixel art and UI sprites, which a lossy encode
 * smears. JPEG is already lossy and BMP is uncompressed, so both are worth the trade.
 */
const RECOMPRESSED_BY_DEFAULT = new Set(['jpg', 'jpeg', 'bmp']);

function extOf(path: string): string {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export interface AssetImportPlan {
  /** Where the original bytes land when no WebP is written. */
  path: string;
  /** Where a WebP lands, or null when the import is a straight byte copy. */
  webpPath: string | null;
  /**
   * The WebP is kept even when it came out larger: the destination's name already
   * promises WebP, so falling back to the original would put other bytes under it.
   */
  webpRequired: boolean;
}

/**
 * Where a storage import lands, and whether it is re-encoded on the way.
 *
 * The invariant is that a file's bytes match its extension — the bundler picks the
 * data: URI's MIME type from the name, so WebP bytes under `.png` ship mislabelled.
 * So a WebP is only ever written under a `.webp` name: either the caller named one, or
 * the destination was defaulted (`renamed`) and may follow the bytes. An explicit
 * non-WebP `to` copies the original, and explicitly asking to recompress into one is
 * refused rather than quietly not done.
 */
export function planAssetImport(
  sourcePath: string,
  destination: string,
  opts: { recompress?: boolean; renamed?: boolean } = {},
): AssetImportPlan {
  const plain = { path: destination, webpPath: null, webpRequired: false };
  const sourceExt = extOf(sourcePath);
  if (opts.recompress === false || !RECOMPRESSIBLE.has(sourceExt)) return plain;

  if (extOf(destination) === 'webp')
    return { path: destination, webpPath: destination, webpRequired: true };

  const wants = opts.recompress === true || RECOMPRESSED_BY_DEFAULT.has(sourceExt);
  if (!wants) return plain;
  if (opts.renamed) {
    const webpPath = /\.[^./]+$/.test(destination)
      ? destination.replace(/\.[^./]+$/, '.webp')
      : `${destination}.webp`;
    return { path: destination, webpPath, webpRequired: false };
  }
  if (opts.recompress === true)
    throw new Error(
      `recompress writes WebP, and \`to\` (${destination}) is not a .webp name. Name it ` +
        '.webp, or omit `to` and the import is renamed to match its bytes.',
    );
  return plain;
}

/**
 * An installed app's own file named as `yaar://apps/{id}/{path}`, or null when the
 * reference is anything else — including `yaar://apps/{id}/storage/...`, which is that
 * app's storage tree and goes through the storage door.
 */
export function appSourceRef(ref: string): { appId: string; path: string } | null {
  const m = /^yaar:\/\/apps\/([a-z][a-z0-9-]*)\/(.+)$/.exec(ref.trim());
  if (!m || m[1] === 'self') return null;
  const path = m[2]!.replace(/^\/+/, '');
  if (!path || path === 'storage' || path.startsWith('storage/')) return null;
  return { appId: m[1]!, path };
}

/** Decoded size of a base64 string, without decoding it. */
export function base64ByteLength(base64: string): number {
  const clean = base64.replace(/\s+/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}
