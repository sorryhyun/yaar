/**
 * Image utilities: data-URL parsing, and the one re-encode that happens on the way
 * into a model context.
 *
 * Screenshots are already WebP by the time they get here — captured that way on the
 * frontend (`iframe-scripts/capture.ts`) and requested that way over CDP
 * (`lib/browser/session.ts`). The two paths that were not are files read off disk
 * and PDF pages rasterized by poppler, and both feed a *vision model*, not a
 * pixel-diff: a lossless PNG spends context tokens, upload latency and API cost on
 * fidelity nothing downstream can use.
 */

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/**
 * Parse a data URL to extract media type and base64 data.
 */
export function parseDataUrl(dataUrl: string): { mediaType: ImageMediaType; data: string } | null {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/);
  if (!match) return null;
  return {
    mediaType: match[1] as ImageMediaType,
    data: match[2],
  };
}

/**
 * Default quality for a model-bound re-encode.
 *
 * High enough that rasterized PDF text and UI screenshots stay legible, low enough
 * that the saving over PNG is the 60–80% that motivates doing this at all. Deliberately
 * below `SCREENSHOT_QUALITY` (95) in `lib/browser/session.ts`: that one re-encodes an
 * image that is *already* WebP, where the only question is downscaling loss.
 */
const MODEL_WEBP_QUALITY = 85;

/**
 * Formats worth re-encoding for a model.
 *
 * WebP is already the target. GIF is excluded on purpose and not by oversight: a
 * single-frame `Bun.Image` encode cannot round-trip an animation any more than a
 * canvas can, so transcoding one silently throws away every frame but the first.
 * Anything else (SVG, and whatever a future `IMAGE_MIME` entry adds) is left alone
 * rather than guessed at.
 */
const TRANSCODABLE = new Set<string>(['image/png', 'image/jpeg']);

/** An image as it should be handed to a model: bytes plus the type they are now in. */
export interface ModelImage {
  data: Buffer;
  mimeType: string;
}

/**
 * Re-encode an image to WebP for a model context, or return it untouched.
 *
 * Untouched means exactly that — the same Buffer — and happens whenever the re-encode
 * cannot help or cannot be trusted:
 *
 * - the source is not a format we transcode (see {@link TRANSCODABLE});
 * - `Bun.Image` is unavailable or throws (a corrupt file, a codec that declined);
 * - the WebP came out *bigger*, which a small flat-colour PNG genuinely can. Paying
 *   context tokens for a re-encode that lost is worse than shipping the original.
 *
 * The file on disk is never written back. This is a presentation concern: the caller
 * is building a content block, not editing storage.
 */
export async function toWebPForModel(
  data: Buffer,
  mimeType: string,
  quality: number = MODEL_WEBP_QUALITY,
): Promise<ModelImage> {
  if (!TRANSCODABLE.has(mimeType)) return { data, mimeType };
  try {
    const webp = await new Bun.Image(data).webp({ quality }).buffer();
    if (webp.length >= data.length) return { data, mimeType };
    return { data: webp, mimeType: 'image/webp' };
  } catch {
    return { data, mimeType };
  }
}
