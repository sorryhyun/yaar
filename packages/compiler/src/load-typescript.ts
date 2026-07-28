/**
 * Load the `typescript` module at runtime, or null when it is unavailable.
 *
 * `typescript` is a devDependency, so in a plain server install it may be absent;
 * the specifier is assembled at runtime to defeat the bundler's static import
 * scan and let a missing module degrade to null instead of failing the build.
 * Every caller must handle `null` — the guards degrade to no-ops there.
 *
 * The bundled exe is the exception: `build/exe-bundle.js` statically imports
 * `typescript` into the generated entry (so Bun embeds it) and stashes the
 * module on `globalThis.__YAAR_TYPESCRIPT`. The runtime-assembled import below
 * is invisible to Bun's compiler, so without the stash the exe would fall back
 * to the schema fold for every app, reading each manifest by running the app
 * rather than from its AST.
 *
 * The result is memoized, including the failure: a missing module does not
 * become available later, and retrying costs a rejected dynamic import per file.
 */
let cached: typeof import('typescript') | null | undefined;

export async function loadTypeScript(): Promise<typeof import('typescript') | null> {
  // The degraded paths only run where `typescript` is absent, which is nowhere a
  // developer can reach — so they were only ever exercised by the users who hit
  // them. This makes that environment reproducible on demand, and is checked
  // ahead of the memo so it works whatever ran first.
  if (process.env.YAAR_NO_TYPESCRIPT === '1') return null;

  if (cached !== undefined) return cached;

  // Bundled-exe path: typescript was embedded at build time (see build/exe-bundle.js).
  const embedded = (globalThis as Record<string, unknown>).__YAAR_TYPESCRIPT;
  if (embedded) {
    cached = embedded as typeof import('typescript');
    return cached;
  }

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
