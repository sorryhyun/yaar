export {};

// Pure path helpers and file-kind predicates. No signals, no I/O, no
// @bundled/yaar — unit-testable as-is.

export function projectPath(projectId: string, sub?: string): string {
  return sub ? `projects/${projectId}/${sub}` : `projects/${projectId}`;
}

/**
 * The window id a project's preview is addressed by.
 *
 * Namespaced by project on purpose: left to the server the id is slugged from the window
 * title, which is the project name — so previewing a clone of `ai-chat` produced the id
 * `ai-chat` and last-write-wins registration silently replaced the *running* app's window
 * record. It lives here, and not inline at the one place that opens the window, because a
 * project's preview outlives that call: deleting the project has to close a window it
 * never opened, and it can only name it by rebuilding the same id.
 */
export function previewWindowIdFor(projectId: string): string {
  return `devtools-preview-${projectId}`;
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

// What the bundler inlines as a data: URI when a module imports it. Broader than
// BINARY_EXT because SVG belongs here and not there: it is text the editor should let
// you edit, and still an asset an import turns into a data: URI.
const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|wasm|mp3|wav)$/i;

/**
 * The `import` line that turns a file in the project into an inlined asset, or null
 * when the path is not one the bundler would inline.
 *
 * Only files under `src/` qualify: the import specifier is written relative to
 * `src/main.ts`, which is where the caller is being told to paste it, and a path
 * outside `src/` has no stable spelling from there.
 */
export function assetImportLine(destination: string): string | null {
  if (!destination.startsWith('src/') || !ASSET_EXT.test(destination)) return null;
  const name = destination.split('/').pop() ?? destination;
  const varName =
    name
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => c.toUpperCase())
      .replace(/^[^a-zA-Z_$]+/, '') || 'asset';
  return `import ${varName} from '${destination.replace(/^src\//, './')}';`;
}
