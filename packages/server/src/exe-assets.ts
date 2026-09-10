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
 * Candidate roots for the executable's virtual filesystem, most trustworthy first.
 *
 * An embedded file's `name` is relative to the mount, so `` `${root}/${name}` `` is the path
 * `Bun.file()` opens — but only for the *right* root, and which one that is cannot be read
 * off a single expression:
 *
 *  - `import.meta.dir` is the mount for a plain `--compile` build, on every platform. It is
 *    listed first for that reason, and it is why a bare `/$bunfs/root` literal must never be
 *    the only answer: on Windows the mount is `B:\~BUN\root`, and hardcoding the POSIX
 *    spelling is what broke the Windows binary once — every asset resolved to a path that
 *    cannot open and the exe 404’d its own frontend, `@bundled/*` libraries and ML runtime
 *    alike. (Mixing separators the other way is fine: Bun opens `B:\~BUN\root/frontend/x`.)
 *  - Under `--bytecode` it is *wrong*: bytecode output is CommonJS, and the conversion bakes
 *    `import.meta.dir` to the **build machine's source directory**, which does not exist on
 *    the user's machine. `Bun.embeddedFiles` is still correct and complete there — only the
 *    path spelling is lost — so the two known mounts follow as candidates.
 *
 * `resolveEmbeddedRoot()` picks between them by *opening a real embedded file*, so a wrong
 * candidate is rejected rather than trusted. Order still matters: `import.meta.dir` wins
 * whenever it works, which keeps the platform-agnostic answer ahead of the literals.
 */
const EMBEDDED_ROOT_CANDIDATES = [import.meta.dir, '/$bunfs/root', 'B:\\~BUN\\root'];

/**
 * The mount the running binary actually reads embedded files from.
 *
 * Probes each candidate against a non-empty embedded entry and returns the first that
 * opens. Throws if none does: every consumer of the three globals treats a miss as "read
 * from disk instead", so a silently unresolved mount degrades into a binary that 404s its
 * own frontend and shows up only as a blank window — the exact failure this module exists
 * to prevent. Better to refuse to boot with the reason attached.
 *
 * Never reached outside the exe: `Bun.embeddedFiles` is empty there, and the caller returns
 * before asking.
 */
function resolveEmbeddedRoot(): string {
  // A zero-length entry cannot tell a resolving root from a missing file, since both
  // report size 0 — so probe with a file that has bytes.
  const probe = Bun.embeddedFiles.find((f) => f.size > 0) as File | undefined;
  if (!probe) return EMBEDDED_ROOT_CANDIDATES[0]!;

  for (const root of EMBEDDED_ROOT_CANDIDATES) {
    try {
      if (Bun.file(`${root}/${probe.name}`).size > 0) return root;
    } catch {
      // Unopenable candidate; try the next.
    }
  }
  throw new Error(
    `Cannot locate the embedded asset mount. ${Bun.embeddedFiles.length} file(s) are ` +
      `compiled in (probed "${probe.name}"), but none of ` +
      `${EMBEDDED_ROOT_CANDIDATES.map((c) => JSON.stringify(c)).join(', ')} opens it.`,
  );
}

/**
 * Every embedded file under `prefix/`, keyed by the rest of its path.
 *
 * Returns an empty object when the prefix embedded nothing, which is how a build without
 * `dist/bundled-libs` stays distinguishable from one that has it.
 */
function embeddedUnder(prefix: string, root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of Bun.embeddedFiles) {
    const name = (file as File).name;
    if (!name.startsWith(`${prefix}/`)) continue;
    out[name.slice(prefix.length + 1)] = `${root}/${name}`;
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

  // Outside the exe there is nothing to publish, and no mount to resolve.
  if (Bun.embeddedFiles.length === 0) return;
  const root = resolveEmbeddedRoot();

  // Frontend keys are *URL* paths, rooted — `static.ts` looks up `/index.html`, and
  // `config/assets.ts` is called with `/NanumSquareNeoOTF-Rg.otf`.
  const frontend: Record<string, string> = {};
  for (const [rest, path] of Object.entries(embeddedUnder(EMBEDDED_ASSET_DIRS.frontend, root))) {
    frontend[`/${rest}`] = path;
  }
  globals.__YAAR_EMBEDDED_FRONTEND = frontend;

  // Library keys are import names without the extension: `uuid`, `solid-js/html` — the
  // shape `prebundle-libs.js` writes the files under and `bundled/plugins.ts` looks up.
  const libs: Record<string, string> = {};
  for (const [rest, path] of Object.entries(embeddedUnder(EMBEDDED_ASSET_DIRS.bundledLibs, root))) {
    if (!rest.endsWith('.js')) continue;
    libs[rest.slice(0, -'.js'.length)] = path;
  }
  // Only when there is something to resolve: `bundled/plugins.ts` reads the *presence* of
  // this global as "running inside the exe", and an empty map would claim libraries are
  // embedded while resolving none of them.
  if (Object.keys(libs).length > 0) globals.__YAAR_BUNDLED_LIBS = libs;

  // ML keys are bare artifact file names, which is what `/api/ml-runtime/:name` receives.
  globals.__YAAR_ML_RUNTIME = embeddedUnder(EMBEDDED_ASSET_DIRS.mlRuntime, root);
}
