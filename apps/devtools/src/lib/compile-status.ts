export {};

// The compile verdict, as one pure reducer over the two facts that make it up. Shared by
// the `compileStatus` state key and the `compile` command's `status` field, which must
// answer identically.

export type BundleStatus = 'idle' | 'compiling' | 'success' | 'error';
export type TypecheckState = 'unknown' | 'clean' | 'errors';
export type CompileStatus = 'idle' | 'compiling' | 'success' | 'unchecked' | 'error';

/**
 * Combine the bundler's verdict with type checking's.
 *
 * `unchecked` is a third answer, not a shade of `success`: "it built and nobody checked
 * the code as it now stands" (see AGENTS.md, compileStatus). Preserve it in any change
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
