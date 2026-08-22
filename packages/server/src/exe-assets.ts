/**
 * The standalone exe's embedded assets — the one place that says what the build puts in
 * and how the running binary finds it again.
 *
 * `bun build --compile --asset <dir>` embeds a directory tree into the executable,
 * preserving each file's path *under the directory's own basename*: `--asset x/frontend`
 * gives entries named `frontend/index.html`, `frontend/assets/main-abc.js`. That basename
 * is the whole contract between `scripts/build/exe-bundle.js` and this file, which is why
 * both read it from `EMBEDDED_ASSET_DIRS` rather than each spelling it out.
 *
 * This replaced a generated entry point. `exe-bundle.js` used to write a
 * `_build-entry.generated.ts` holding one `import … with { type: "file" }` line per
 * embedded file plus a literal object mapping each one to its `/$bunfs/` path — a few
 * thousand lines of machine-written TypeScript whose only job was to get files into
 * `Bun.embeddedFiles`. `--asset` does that directly, so the maps are built here, at
 * startup, by reading back what is actually in the binary.
 *
 * The *shape* of the three globals is deliberately unchanged: every consumer
 * (`http/routes/static.ts`, `config/assets.ts`, the compiler's
 * `bundled/plugins.ts`) still receives `Record<key, path>` of paths `Bun.file()` can
 * read, and `__YAAR_BUNDLED_LIBS` being defined still doubles as the compiler's
 * "am I inside the exe" test.
 */

/**
 * Directory basenames the build embeds under, and therefore the prefixes on
 * `Bun.embeddedFiles` names at runtime. `exe-bundle.js` creates a link with each of these
 * names and passes it to `--asset`; change one here and the build follows.
 */
export const EMBEDDED_ASSET_DIRS = {
  /** `packages/frontend/dist` — what the desktop is served from. */
  frontend: 'frontend',
  /** `dist/bundled-libs` — the prebundled `@bundled/*` libraries apps compile against. */
  bundledLibs: 'bundled-libs',
  /** The three onnxruntime-web artifacts served at `/api/ml-runtime/`. */
  mlRuntime: 'ml-runtime',
} as const;

/**
 * Root of the executable's virtual filesystem.
 *
 * Everything compiled into the binary — this module included — reports the mount as its
 * `import.meta.dir`, and an embedded file's `name` is relative to exactly that, so
 * `` `${EMBEDDED_ROOT}/${name}` `` is a path `Bun.file()` opens.
 *
 * Read straight off `import.meta.dir`, with no literal beside it, because the mount is not
 * `/$bunfs/root` everywhere: on Windows it is `B:\~BUN\root`. Keeping the POSIX spelling as
 * a fallback is what broke the Windows binary — `startsWith('/$bunfs')` is false there, so
 * every asset resolved to a `/$bunfs/root/…` path that cannot open and the exe 404’d its own
 * frontend, its `@bundled/*` libraries and its ML runtime alike. Mixing the separators back
 * the other way is fine: Bun opens `B:\~BUN\root/frontend/index.html`.
 *
 * There is no on-disk case left to keep a floor for, either — outside the exe
 * `Bun.embeddedFiles` is empty, so `embeddedUnder()` builds no paths and this is never used.
 */
const EMBEDDED_ROOT = import.meta.dir;

/**
 * Every embedded file under `prefix/`, keyed by the rest of its path.
 *
 * Returns an empty object when the prefix embedded nothing, which is how a build without
 * `dist/bundled-libs` stays distinguishable from one that has it.
 */
function embeddedUnder(prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of Bun.embeddedFiles) {
    const name = (file as File).name;
    if (!name.startsWith(`${prefix}/`)) continue;
    out[name.slice(prefix.length + 1)] = `${EMBEDDED_ROOT}/${name}`;
  }
  return out;
}

/**
 * Publish the embedded assets on `globalThis`, before any server module loads.
 *
 * Called from `exe-bundle-entry.ts` and nowhere else: outside the exe `Bun.embeddedFiles`
 * is empty, and the consumers all treat "global absent" as "read from disk instead".
 */
export function installEmbeddedAssetMaps(): void {
  const globals = globalThis as Record<string, unknown>;

  // Frontend keys are *URL* paths, rooted — `static.ts` looks up `/index.html`, and
  // `config/assets.ts` is called with `/NanumSquareNeoOTF-Rg.otf`.
  const frontend: Record<string, string> = {};
  for (const [rest, path] of Object.entries(embeddedUnder(EMBEDDED_ASSET_DIRS.frontend))) {
    frontend[`/${rest}`] = path;
  }
  globals.__YAAR_EMBEDDED_FRONTEND = frontend;

  // Library keys are import names without the extension: `uuid`, `solid-js/html` — the
  // shape `prebundle-libs.js` writes the files under and `bundled/plugins.ts` looks up.
  const libs: Record<string, string> = {};
  for (const [rest, path] of Object.entries(embeddedUnder(EMBEDDED_ASSET_DIRS.bundledLibs))) {
    if (!rest.endsWith('.js')) continue;
    libs[rest.slice(0, -'.js'.length)] = path;
  }
  // Only when there is something to resolve: `bundled/plugins.ts` reads the *presence* of
  // this global as "running inside the exe", and an empty map would claim libraries are
  // embedded while resolving none of them.
  if (Object.keys(libs).length > 0) globals.__YAAR_BUNDLED_LIBS = libs;

  // ML keys are bare artifact file names, which is what `/api/ml-runtime/:name` receives.
  globals.__YAAR_ML_RUNTIME = embeddedUnder(EMBEDDED_ASSET_DIRS.mlRuntime);
}
