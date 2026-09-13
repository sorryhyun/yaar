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

// Directory names whose contents are generated rather than written: bundler output,
// installed dependencies, VCS internals, coverage reports. Matched as a whole path
// segment at any depth, since a project may nest its build under a subdirectory.
//
// A source directory that happens to share one of these names is collateral — that is
// the trade the escape hatch exists for, and it is the right default: one line of a
// minified bundle is thousands of characters wide, so a handful of stray dist/ hits
// crowds real matches out of a result far more effectively than they would be missed.
const GENERATED_DIRS = new Set([
  'dist',
  'build',
  'out',
  'node_modules',
  'coverage',
  '.git',
  '.cache',
  '.next',
  '.output',
]);

// Generated files that sit outside a generated directory: minified bundles and the
// source maps emitted beside them.
const GENERATED_FILE = /\.(min\.(js|css)|map)$/i;

/**
 * Whether this path is build output rather than source — the set a project-wide search
 * should skip unless it was asked for generated output on purpose.
 *
 * Only the directory segments are tested against the name set, so a *file* called
 * `build.ts` is source while `build/x.ts` is not.
 */
export function isGeneratedPath(path: string): boolean {
  const segments = path.split('/');
  if (segments.slice(0, -1).some((segment) => GENERATED_DIRS.has(segment))) return true;
  return GENERATED_FILE.test(segments[segments.length - 1] ?? '');
}

// Extensions whose bytes are not meaningfully countable as text — skip metadata
// rather than report the size of a base64/garbled decode. `.gltf` is deliberately
// absent for the same reason `.svg` is: it is a JSON document worth reading.
const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|wasm|mp3|wav|glb|bin)$/i;

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

/**
 * A caller-supplied path resolved inside the project root, or null when it climbs out.
 *
 * `.` and an inner `..` are resolved rather than refused, so `src/../app.json` names the
 * file it plainly means; only a `..` past the root is null. Callers turn null into a
 * refusal worded differently from "not found" — the two once shared one message, so a
 * refused read could not be told from a missing file. Leading and doubled slashes are
 * dropped, since a path pasted from a listing tends to bring one.
 */
export function normalizeProjectPath(raw: string): string | null {
  const out: string[] = [];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment !== '..') {
      out.push(segment);
      continue;
    }
    if (out.length === 0) return null;
    out.pop();
  }
  return out.join('/');
}

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const dirName = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/**
 * Up to `limit` of the `existing` paths a missing `target` was plausibly meant to be, best
 * first: a case-only difference, the same file name in another directory, the same stem
 * with another extension, then whatever sits in the directory the target named.
 */
export function nearbyPaths(target: string, existing: readonly string[], limit = 5): string[] {
  const name = baseName(target);
  const stem = name.replace(/\.[^.]+$/, '').toLowerCase();
  const dir = dirName(target);
  const groups = [
    existing.filter((p) => p.toLowerCase() === target.toLowerCase()),
    existing.filter((p) => baseName(p) === name),
    existing.filter(
      (p) =>
        baseName(p)
          .replace(/\.[^.]+$/, '')
          .toLowerCase() === stem,
    ),
    existing.filter((p) => dirName(p) === dir),
  ];
  const out: string[] = [];
  for (const group of groups)
    for (const p of group) if (p !== target && !out.includes(p)) out.push(p);
  return out.slice(0, limit);
}

/**
 * A glob as an anchored RegExp over a whole project-relative path.
 *
 * `*` and `?` stop at `/`; `**` crosses directories, and `**` + `/` also matches zero of
 * them, so `**` + `/*.ts` includes root files while `*.ts` is the root only. `{a,b}` is
 * alternation. Throws on an unclosed `{`.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      re += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') {
      depth++;
      re += '(?:';
    } else if (c === '}' && depth > 0) {
      depth--;
      re += ')';
    } else if (c === ',' && depth > 0) re += '|';
    else re += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
  }
  if (depth > 0) throw new Error(`unclosed "{" in glob: ${glob}`);
  return new RegExp(`^${re}$`);
}

// What an import turns into a data: URI. Broader than BINARY_EXT because SVG and glTF
// JSON belong here and not there: text the editor should let you edit, and still assets.
//
// The bundler itself inlines ANY extension it has no code loader for — measured:
// `.glb` -> `data:model/gltf-binary`, `.gltf` -> `data:model/gltf+json`, `.bin` ->
// `data:application/octet-stream`, with `dist/` still holding index.html alone. So this
// list is not the bundler's capability; it is the set devtools vouches for by offering an
// import line. An extension missing from it still builds. It was once the other way round
// — an unlisted extension emitted an unserved sibling file — and a stale copy of this list
// is why `.glb` was reported as unsupported long after it worked.
const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|wasm|mp3|wav|glb|gltf|bin)$/i;

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
