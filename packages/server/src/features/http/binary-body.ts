/**
 * What a *model* gets handed when `yaar://http` comes back with bytes instead of text.
 *
 * An iframe caller is fine with the base64 envelope: `responseFromProxyPayload`
 * (shared/iframe-scripts/prelude.ts) decodes it back into a real `Response`, so the bytes
 * arrive intact and nothing is wasted. A model has no such decoder. Handed the same
 * envelope it gets a wall of base64 that it cannot render, cannot decode, and has already
 * paid for — and `ok: true, status: 200` says the call succeeded, so nothing signals that
 * the content never arrived.
 *
 * Above a certain size it is not even waste, it is loss: `invoke` declares a 150,000-char
 * result threshold (`mcp/result-size.ts`) and a body over roughly 112 KB inflates past it,
 * at which point the CLI persists the result to a file path that no YAAR principal holds a
 * tool to read. The whole call evaporates.
 *
 * So this module answers two questions for the model-facing branch: are these bytes an
 * image (in which case they can be an image block, the same thing `yaar://storage/` has
 * always done for the same bytes), and are they small enough to be worth inlining at all.
 */

import { toWebPForModel } from '../../lib/image.js';
import { isTextContentType } from './fetch.js';

/**
 * The largest image that goes inline, measured after the WebP re-encode.
 *
 * Not a guess at the model's image budget — that is counted in pixels, not bytes, and
 * `MAX_MCP_OUTPUT_TOKENS` governs it separately. This is the point past which inlining
 * stops being the *helpful* answer: 1 MB of WebP is a photograph well beyond anything a
 * vision model reads more of for the extra bytes, and the caller is better served by a
 * stored path it can open in a window than by a block that crowds out its own turn.
 */
export const MAX_INLINE_IMAGE_BYTES = 1024 * 1024;

/** Image formats identifiable from their first bytes, in the order the checks run. */
const MAGIC: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/png',
    test: (b) =>
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { mime: 'image/gif', test: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  {
    mime: 'image/webp',
    test: (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

/**
 * The image type these bytes actually are, or `null` if they are not an image.
 *
 * The declared content-type is consulted first but is **not** trusted on its own: the
 * report that prompted this (issue #78) was a JPEG served as `application/octet-stream`,
 * and a rule that keyed on `image/*` would have missed the exact case it was written for.
 * Content sniffing is the authority; the header only wins when it names an image type and
 * the bytes are too short to identify.
 */
export function sniffImageMime(bytes: Buffer, declaredContentType = ''): string | null {
  if (bytes.length >= 12) {
    for (const { mime, test } of MAGIC) if (test(bytes)) return mime;
  }
  const declared = declaredContentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return declared.startsWith('image/') && !declared.includes('svg') ? declared : null;
}

/** What the model-facing branch should do with a body, once the bytes are in hand. */
export type BodyPlan =
  | { kind: 'text'; text: string }
  | { kind: 'image'; data: string; mimeType: string; note: string }
  | { kind: 'omitted'; hint: string };

/** Rough token cost of inlining `n` bytes as base64 — 4 chars per 3 bytes, ~4 chars a token. */
const approxTokens = (n: number) => Math.round(n / 3);

/**
 * Decide how a response body reaches a model.
 *
 * Text is unchanged — the same string the base64-free path has always produced. Images
 * become an image block, re-encoded exactly as a storage read would (`toWebPForModel`), so
 * the same bytes now look the same whichever door served them. Everything else is
 * *omitted* rather than truncated: half a base64 string is no more readable than all of it
 * and costs almost as much, so the useful thing to return is the reason and the way out.
 */
export async function planResponseBody(
  bytes: Buffer,
  contentType: string,
  saveToHint: string,
): Promise<BodyPlan> {
  if (isTextContentType(contentType)) return { kind: 'text', text: bytes.toString('utf-8') };

  const imageMime = sniffImageMime(bytes, contentType);
  if (!imageMime) {
    const label = contentType.split(';')[0]?.trim() || 'unknown type';
    return {
      kind: 'omitted',
      hint:
        `Binary response (${label}, ${bytes.length} bytes). The body is omitted: as base64 text ` +
        `it would cost about ${approxTokens(bytes.length)} tokens and still be unreadable. ` +
        saveToHint,
    };
  }

  const encoded = await toWebPForModel(bytes, imageMime);
  if (encoded.data.length > MAX_INLINE_IMAGE_BYTES) {
    return {
      kind: 'omitted',
      hint:
        `Image response (${imageMime}, ${encoded.data.length} bytes) is over the ` +
        `${MAX_INLINE_IMAGE_BYTES}-byte inline limit, so it is omitted rather than sent as an ` +
        `image block. ${saveToHint}`,
    };
  }

  const sniffed =
    imageMime === contentType.split(';')[0]?.trim()
      ? ''
      : ` — served as "${contentType.split(';')[0]?.trim() || 'no content-type'}", identified from its bytes`;
  const transcoded =
    encoded.mimeType === imageMime ? '' : `, re-encoded to ${encoded.mimeType} for this read`;
  return {
    kind: 'image',
    data: encoded.data.toString('base64'),
    mimeType: encoded.mimeType,
    note: `Image body (${imageMime}, ${bytes.length} bytes${sniffed}${transcoded}).`,
  };
}
