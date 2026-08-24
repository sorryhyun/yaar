export {};

// The compile verdict, as one pure reducer over the two facts that make it up.
//
// It lives here rather than inline at either call site because there are two: the
// `compileStatus` state key and the `compile` command's own `status` field. They have
// to answer identically — a caller who polls the state after a compile must not land on
// a cleaner verdict than the compile itself reported.

export type BundleStatus = 'idle' | 'compiling' | 'success' | 'error';
export type TypecheckState = 'unknown' | 'clean' | 'errors';
export type CompileStatus = 'idle' | 'compiling' | 'success' | 'unchecked' | 'error';

/**
 * Combine the bundler's verdict with type checking's.
 *
 * `unchecked` is a third answer, not a shade of `success`. Bun strips types and builds
 * straight through type errors, so "it bundled" and "it type checks" are separate facts,
 * and "it built and nobody checked the bytes as they now stand" is the state that once
 * waved a project with six live type errors through as clean. Preserve it in any change
 * here, and keep it surfacing under that word.
 */
export function resolveCompileStatus(
  bundle: BundleStatus,
  typecheck: TypecheckState,
): CompileStatus {
  // A bundle that never succeeded decides it alone: there is nothing to be clean about.
  // Only "it built" leaves the question open for type checking to answer.
  if (bundle !== 'success') return bundle;
  if (typecheck === 'unknown') return 'unchecked';
  return typecheck === 'errors' ? 'error' : 'success';
}
