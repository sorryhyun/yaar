/**
 * Load the `typescript` module at runtime, or null when it is unavailable.
 *
 * `typescript` is a devDependency and is absent in bundled-exe mode, so the
 * specifier is assembled at runtime to defeat the bundler's static import scan.
 * Every caller must handle `null` — the guards degrade to no-ops there, and the
 * protocol extractor falls back to its text scanner.
 *
 * The result is memoized, including the failure: a missing module does not
 * become available later, and retrying costs a rejected dynamic import per file.
 */
let cached: typeof import('typescript') | null | undefined;

export async function loadTypeScript(): Promise<typeof import('typescript') | null> {
  if (cached !== undefined) return cached;
  const specifier = ['type', 'script'].join('');
  try {
    const mod = (await import(specifier)) as {
      default?: typeof import('typescript');
    } & typeof import('typescript');
    cached = mod.default ?? mod;
  } catch {
    cached = null;
  }
  return cached;
}
