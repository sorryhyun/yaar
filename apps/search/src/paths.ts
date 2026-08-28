export {};

// Directory names whose contents are generated rather than written: bundler output,
// installed dependencies, VCS internals, coverage reports. Matched as a whole path
// segment at any depth, since a project may nest its build under a subdirectory.
//
// A source directory that happens to share one of these names is collateral — that is
// the trade the escape hatch exists for, and it is the right default: one line of a
// minified bundle is thousands of characters wide, so a handful of stray dist/ hits
// crowds real matches out of a result far more effectively than they would be missed.
//
// Kept identical to Dev Tools' `lib/paths.ts` so the two searches hide the same set.
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
 * Whether this path is build output rather than source — the set a broad search should
 * skip unless it was asked for generated output on purpose.
 *
 * Only the directory segments are tested against the name set, so a *file* called
 * `build.ts` is source while `build/x.ts` is not.
 *
 * Callers pass the path RELATIVE TO THE SEARCH SCOPE, which is what makes descending
 * into a bundle its own opt-in: scoped to `.../dist`, grep returns `index.html` and
 * nothing here matches, so an explicitly built scope searches normally.
 */
export function isGeneratedPath(path: string): boolean {
  const segments = path.split('/');
  if (segments.slice(0, -1).some((segment) => GENERATED_DIRS.has(segment))) return true;
  return GENERATED_FILE.test(segments[segments.length - 1] ?? '');
}
