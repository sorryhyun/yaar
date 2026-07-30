export {};

// Pure path helpers and file-kind predicates. No signals, no I/O, no
// @bundled/yaar — unit-testable as-is.

export function projectPath(projectId: string, sub?: string): string {
  return sub ? `projects/${projectId}/${sub}` : `projects/${projectId}`;
}

/**
 * Rewrite host-absolute sandbox paths in tool output to project-relative ones.
 *
 * The dev server compiles from disk, so its bundler errors name
 * `/Users/me/yaar/storage/apps/devtools/projects/1785…/src/main.ts:6:25`. Every
 * *input* in this protocol is a project-relative path, so that output could not be
 * pasted back into `editFile` — and it published where the sandbox lives on the
 * host, which is not the caller's business. Anchored on `projects/{id}/` rather than
 * on a storage prefix: the projects segment is this app's own layout, while the
 * prefix above it belongs to whoever configured `YAAR_STORAGE`.
 */
export function relativizeProjectPaths(messages: string[], projectId: string): string[] {
  // The id is digits (Date.now()), so no regex escaping is needed — but it is
  // interpolated, so keep it to what a project id can be.
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) return messages;
  const absolute = new RegExp(`\\S*projects/${projectId}/`, 'g');
  return messages.map((m) => m.replace(absolute, ''));
}

// Extensions whose bytes are not meaningfully countable as text — skip metadata
// rather than report the size of a base64/garbled decode.
const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|wasm|mp3|wav)$/i;

// Raster images the editor renders as a picture. SVG is deliberately absent: it is
// text the user may want to edit, and it highlights fine as markup.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i;

/** Whether this path is a raster image — rendered, never decoded as text. */
export function isImagePath(path: string): boolean {
  return IMAGE_EXT.test(path);
}

/**
 * Whether this path holds bytes that are not text at all. Reading one as text gives
 * mojibake, so the callers that would have shown it say what the file is instead.
 */
export function isBinaryPath(path: string): boolean {
  return BINARY_EXT.test(path);
}
