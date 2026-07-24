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
  image: { data: string; mimeType: string },
): ReadBlock[] {
  const kb = Math.round((image.data.length * 3) / 4 / 1024);
  if ((image.data.length * 3) / 4 > MAX_INLINE_IMAGE_BYTES) {
    return [
      {
        type: 'text',
        text: `── ${path} ──\n(image, ${kb}KB — too large to inline; use readFile({ openInEditor: true }) to view it)`,
      },
    ];
  }
  return [
    { type: 'text', text: `── ${path} (image, ${kb}KB) ──` },
    { type: 'image', data: image.data, mimeType: image.mimeType },
  ];
}
