export {};

// How `readFile` shapes its response: MIME typing and the text/image content
// blocks the app protocol passes through. Extracted from ./files.ts, which was
// 62 lines of this before its first descriptor.

const MIME_MAP: Record<string, string> = {
  ts: 'text/typescript',
  tsx: 'text/typescript',
  js: 'application/javascript',
  jsx: 'application/javascript',
  json: 'application/json',
  html: 'text/html',
  css: 'text/css',
  md: 'text/markdown',
  txt: 'text/plain',
  svg: 'image/svg+xml',
};

export function getMimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME_MAP[ext] || 'text/plain';
}

/** The block shapes `readFile` returns. Image blocks pass through the app protocol as-is. */
export type ReadBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; text: string; mimeType: string } };

/**
 * Above this an inlined image costs more than it tells anyone — a project asset that
 * big is a mistake worth naming rather than rendering. (Base64 is ~4/3 of the bytes,
 * and the model's own per-image ceiling is near 5MB encoded.)
 */
const MAX_INLINE_IMAGE_BYTES = 3_500_000;

export function imageBlocks(
  path: string,
  images: Array<{ data: string; mimeType: string }>,
  /** What to suggest instead when an image is too big to inline. */
  tooLargeHint = 'use readFile({ openInEditor: true }) to view it',
): ReadBlock[] {
  return images.flatMap((image, i) => {
    const label = images.length > 1 ? `${path} (${i + 1}/${images.length})` : path;
    const kb = Math.round((image.data.length * 3) / 4 / 1024);
    if ((image.data.length * 3) / 4 > MAX_INLINE_IMAGE_BYTES) {
      return [
        {
          type: 'text' as const,
          text: `── ${label} ──\n(image, ${kb}KB — too large to inline; ${tooLargeHint})`,
        },
      ];
    }
    return [
      { type: 'text' as const, text: `── ${label} (image, ${kb}KB) ──` },
      { type: 'image' as const, data: image.data, mimeType: image.mimeType },
    ];
  });
}

/**
 * The shape `read()` hands back when the resource carried image content: the verb
 * SDK splits the envelope into `{ data, images }` instead of returning `data` bare
 * (see `verb-sdk.ts`). Returning that object from a command would JSON-stringify the
 * base64 into a text block — a truncated wall of characters instead of a picture.
 */
export function imagesFromReadResult(
  result: unknown,
): { text: string; images: Array<{ data: string; mimeType: string }> } | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const envelope = result as { data?: unknown; images?: unknown };
  if (!Array.isArray(envelope.images) || envelope.images.length === 0) return null;
  const images = envelope.images.filter(
    (img): img is { data: string; mimeType: string } =>
      !!img &&
      typeof img === 'object' &&
      typeof (img as { data?: unknown }).data === 'string' &&
      typeof (img as { mimeType?: unknown }).mimeType === 'string',
  );
  if (images.length === 0) return null;
  return { text: typeof envelope.data === 'string' ? envelope.data : '', images };
}
