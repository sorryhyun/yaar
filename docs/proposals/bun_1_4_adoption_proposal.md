# Proposal: Bun 1.4 adoption — retiring what the runtime now does for us

**Status:** items 1–3 landed; 4–8 still open. The version bump itself is done (`.bun-version` →
1.4.0, `bun-types` catalog pin → `^1.4.0`, `engines.bun` → `>=1.4.0`).
**Date:** 2026-08-21
**Reference:** [Bun 1.4 release notes](https://bun.com/blog/bun-v1.4)

## Problem

> Written before items 1–3 landed, and kept as the record of *why*. Three of the four bullets
> below are now history: the per-file mock partitions are gone (item 1), two of the three `tar`
> spawns are gone (item 2), and the synthetic entry point is gone (item 3). `static.ts` still
> has the manual MIME table — that is item 5, still open.

Several YAAR subsystems exist to work around gaps in Bun ≤1.3, and each carries a documented
apology for its own existence:

- `scripts/test/partitions.ts` hand-partitions ~80 server test files into per-process groups
  because `mock.module` is process-global with no teardown — running them in one `--parallel`
  process fails 45 of them. A guard preload (`partition-guard.ts`) enforces the split at runtime.
- `features/update/installer.ts:146` shells out to system `tar` with the comment "Bun ships no
  tar reader, and vendoring one to save a spawn would be [not worth it]." Two more `tar` spawns
  live in `features/apps/install.ts` and `features/apps/archive.ts`.
- `scripts/build/exe-bundle.js` generates a synthetic entry point that imports every
  `frontend/dist` file `with { type: "file" }` solely to smuggle them into `Bun.embeddedFiles`.
- `http/routes/static.ts` serves the frontend with a manual MIME table and no
  ETag/304/Range handling at all.

Bun 1.4 ships first-class answers to each: `bun test --isolate`, `Bun.Archive`,
`--compile --asset`, and `Bun.serve` static `{ dir }` routes. Where the runtime now provides
the mechanism, the workaround should shrink to the part that was never about the gap.

The bump alone also buys runtime wins with no code change: ~5× lower idle CPU, 13–48% lower
HTTP-server memory, ~2× faster startup, and a smaller binary for the standalone exe.

## Non-goals

- **`Bun.markdown`** — YAAR renders markdown in the browser (frontend `marked` + DOMPurify)
  and via `@bundled/marked` in apps, not under the Bun runtime. Nothing to adopt.
- **`URLPattern`** — the manual `pathname ===` chain in `http/routes/api.ts` works and is
  greppable; a router rewrite is churn without behavior change.
- **HTTP/3, `Bun.cron`, `Bun.Terminal`** — no current need. The frontend CLI panel is a
  rendered UI, not a PTY; idle sweeps are `setInterval` reapers, not cron.
- **`Bun.WebView`** — the CDP browser lib is deliberately Chrome-shaped (persistent profiles,
  crash-restart with URL replay, idle sweep). A WebKit fallback is a different feature, not
  an adoption item.
- **`.env` auto-load change (breaking in 1.4)** — no effect here: `config/env.ts` bypasses
  Bun's auto-load entirely with its own `PROJECT_ROOT`-anchored loader, for documented
  cwd reasons.
- **`trustedDependencies` narrowing (breaking in 1.4)** — only `canvas` is listed, from the
  npm registry; unaffected.

## Items

### 1. `bun test --isolate`: collapse the mock partitions (high) — **done**

**Today:** `packages/server/scripts/run-tests.ts` spawns one `bun test` process per partition
from `scripts/test/partitions.ts`. The `server:mock:<file>` rule gives *every file that calls
`mock.module` its own process*, because `mock.module` mutates the process-global module
registry with no teardown.

**Bun 1.4:** `--isolate` runs each test file in a fresh global — ESM/CJS registries cleared
between files, `--preload` scripts re-run per file, fake timers no longer leak, leftover
subprocesses killed. This is precisely the isolation the partition system hand-enforces.

**Plan:** a spike, not a rewrite:

1. Run the non-remote server files in one `bun test --parallel --isolate` process and count
   failures against the 45 that motivated the split.
2. If clean (or cheap to make clean), fold `server:mock:*` and `server:units` into one
   isolated partition; `run-tests.ts`'s process pool shrinks accordingly.
3. `server:remote` (env pinned per-process), `server:loopback` (real sockets, sequential),
   and `server:realfs` (real `PROJECT_ROOT`) stay — those partitions exist for reasons
   `--isolate` does not address. `partition-guard.ts` keeps enforcing whatever remains.

**Watch out:** since 1.4, `--parallel` *implies* `--isolate` — so the existing
`server:units` partition already changed behavior with the bump. The full-suite run recorded
below is the first evidence either way.

**Outcome.** The spike came back clean, so the fold happened: `server:mock:*` is gone and
`installsModuleMock` with it, and the server's suite went from **19 processes to 4** (units,
remote, loopback, realfs) at the same 1649 pass / 0 fail. Wall clock did *not* move (≈4.0s
either way — with `MAX_CONCURRENT = 4` the 15 mock processes were already filling idle slots);
the win is that the rule is smaller, not that the run is faster. Four things worth carrying
forward:

- **The evidence.** All 143 unit + mocking files pass in one `--parallel` process, and pass
  again in a single `--isolate` process in sorted *and* reversed order. The same 143 without
  `--isolate` are refused by the guard, which is the control.
- **`--isolate` is named explicitly** in `run-tests.ts` rather than left implied by
  `--parallel`. The units partition now *depends* on isolation for correctness; losing the
  speed flag should not silently cost that.
- **`partitionOf` no longer takes the file's source** — path alone decides it, so the runner
  stopped reading all 143 files just to schedule them.
- **The guard cannot fire inside an isolated process, at all.** Measured: `--isolate` gives
  each file a fresh global, a fresh `process.env` (a value set by file A is invisible to file
  B), and a rewritten `Bun.argv` naming only that file — so there is no channel to hold state
  in and no way to detect the mode. It is a limit rather than a hole: isolation is what
  *removes* the mock-leak and env-pinning hazards (`env.ts` re-runs per file, so its
  `tests/remote/` inference pins `REMOTE=1` for exactly the file that needs it), and what
  remains — loopback's sockets, realfs's shared fixture dir — is a shared-*resource* problem
  no per-process guard could see. Those groups are `parallel: false`, i.e. plain non-isolated
  processes, which is exactly where the guard still works.

Remote was *not* folded in even though `--isolate` demonstrably fixes it too (measured: a
`tests/remote/` file mixed with a unit file gets `REMOTE=1` per file under `--isolate`, and
`REMOTE=0` without it). It is one file, the saving is one process, and leaning on per-file
preload re-execution for `IS_REMOTE` is a subtler contract than the split it would replace.

**Unrelated finding, not fixed here:** `bun test --randomize` fails
`storage-list-names.test.ts` and `app-storage-namespace-delete.test.ts` — their cases share
scratch state and depend on declaration order *within* the file. Reproduces on those two files
alone, so it is nothing to do with partitioning.

### 2. `Bun.Archive`: delete the three `tar` spawns (high) — **two of three**

**Today:** system `tar` via `Bun.spawn` in `features/update/installer.ts:150` (self-update
extract), `features/apps/install.ts` (marketplace install), `features/apps/archive.ts`
(app publish). External-binary dependency, worst on the Windows standalone exe.

**Bun 1.4:** `Bun.Archive` creates/extracts tarballs off the main thread, no system binary.

**Plan:** replace extraction call sites one by one; `installer.ts`'s "Bun ships no tar reader"
comment retires with it. Two constraints:

- `features/apps/publish-staging.ts` stores frozen `.tar.gz` bytes precisely because
  `tar czf` is not byte-deterministic. The frozen-bytes design stays regardless; do not
  switch creation there unless `Bun.Archive` output is verified byte-deterministic.
- Verify `--strip-components=1` behavior (`archive.ts:14`) has an equivalent, or restructure
  the extract-then-move.

**Outcome.** Both *extract* paths are off `tar`. `installer.ts`'s spawn is one
`new Bun.Archive(bytes).extract(into)`, and `apps/archive.ts` is now `extractAppArchive()`.
The creation site (`publish.ts`) stays a spawn — deliberately, see below.

- **There is no `--strip-components` equivalent.** `extract()` cannot drop a component, so
  `extractAppArchive` reads entries via `files()` and writes them. That moves two
  responsibilities onto us: `files()` returns the archive's *raw* entry names (measured:
  `../escaped.txt` and `/tmp/abs.txt` both come back verbatim, whereas `extract()` sanitizes
  them into the destination), so the function refuses an entry that resolves outside the
  staging dir; and `files()` yields regular files only, so symlinks are dropped rather than
  recreated — strictly better than what `tar` did.
- **The tmp file is gone too.** `install.ts` had the download in memory already, so nothing
  writes the tarball to disk on the way to being unpacked.
- **`Bun.Archive` rejects a lazy `Bun.file()`** — "Unrecognized archive format". Both call
  sites hand it materialized bytes; this is commented at each.
- **The Windows drive-letter test retired with the spawn** (`app-install-archive.test.ts`
  asserted no colon reached tar's argv). It now covers the strip, the traversal refusal, and
  the empty-after-strip case.

**Why `packageAppTarball` is still a spawn.** The stated gate was "unless `Bun.Archive` output
is verified byte-deterministic", and it is not: measured on 1.4.0, gzipped output differs
between two runs over identical input (uncompressed output *is* stable), so nothing is gained
there. Two further measurements argue for caution rather than parity: it emits `ustar\0`00
with **regular-file entries only** — no directory members — mode 0644 and a current-clock
mtime. System `tar` reads it fine in both directions, but every byte here crosses to the
marketplace's own server-side extractor, which this repo cannot exercise. Swapping a reader is
reversible in one process; changing what a *published* artifact looks like is not. Revisit
when the far end can be verified.

### 3. `--compile --asset`: simplify exe embedding (high) — **done**

**Today:** `scripts/build/exe-bundle.js` writes a generated entry point importing every
`frontend/dist` / `dist/bundled-libs` / onnxruntime file `with { type: "file" }` so they land
in `Bun.embeddedFiles`, consumed by `static.ts` via `globalThis.__YAAR_EMBEDDED_FRONTEND`.

**Bun 1.4:** `bun build --compile --asset <path>` embeds files or whole directories directly.

**Plan:** swap the generated-entrypoint machinery for `--asset` flags on the existing
`bun build --compile` invocation (`exe-bundle.js:273`), keeping the
`__YAAR_EMBEDDED_FRONTEND` lookup shape in `static.ts` (or simplifying it if the asset API
serves paths directly). Verify on all three exe targets before deleting the old path —
this only ever runs under `IS_BUNDLED_EXE`, so CI won't catch a regression by itself.

**Outcome.** The generated entry point is gone. Two checked-in files replace it:
`packages/server/src/exe-bundle-entry.ts` (the `--compile` entry — sets `__YAAR_TYPESCRIPT`,
installs the asset maps, then `await import('./exe-entry.js')`, the dynamic import still being
what keeps static-import hoisting from beating the globals) and
`packages/server/src/exe-assets.ts` (reads the maps back out of `Bun.embeddedFiles`). The
consumers — `static.ts`, `config/assets.ts`, the compiler's `bundled/plugins.ts` — are
untouched: all three still get `Record<key, path>`, and `__YAAR_BUNDLED_LIBS` being defined
still doubles as the compiler's "am I in the exe" test.

The naming rule is the whole contract, and it needed a staging step. `--asset` names entries
after the **basename of the path given to it**, so `--asset packages/frontend/dist` would
embed everything under `dist/`. `exe-bundle.js` therefore builds a link farm under
`dist/.exe-assets/` whose names come from `EMBEDDED_ASSET_DIRS` (imported by both sides, so
there is one definition) and passes those. Measured, and why it is links rather than copies:
`--asset` **follows a symlink handed to it directly** but **skips one it meets while walking a
directory** — hence symlinks for the two trees and hard links for the three ML artifacts,
which have to sit inside a directory. Nothing copies 24MB of onnxruntime per build.

Verified on a real arm64 binary rather than by inspection: the three key sets it produces are
**identical** to what the generated entry produced (frontend 223, libs 31, ml 3 — diffed
element by element against the old `collectLibFiles`/`collectFiles` logic), the exe boots, the
desktop loads and connects its WebSocket, `[static] loaded embedded frontend assets
assets=223`, and `index.html` / `main-*.js` / an `.otf` / both ORT artifacts all serve 200 with
correct sizes and content types (`ort-wasm-simd-threaded.asyncify.wasm` → 24,254,953 bytes,
`application/wasm`). `typescript` is still compiled in (84 marker symbols in the binary).
Windows-x64, linux-x64 and darwin-x64/arm64 all build clean.

One tsconfig consequence: `src/exe-bundle-entry.ts` is excluded from `tsconfig.build.json`
(it statically imports `typescript`, a devDependency, purely to force it into the binary, so
emitting it into `dist/` would put that import in a plain server install). It is still
typechecked — `tsconfig.json` includes all of `src/**`.

### 4. `bun build --react-compiler` for the frontend (tryable)

`packages/frontend/build.ts` already uses `Bun.build` (it replaced Vite) and does not use
React Compiler. One flag adds inline auto-memoization. Cheap experiment: enable, confirm the
bundle builds and the app behaves, compare bundle size and interaction smoothness. Keep only
if measurably neutral-or-better; revert is one flag.

### 5. `Bun.serve` static `{ dir }` routes for the dev path (tryable)

`http/routes/static.ts`'s filesystem branch gets Content-Type, ETag, Last-Modified, 304, and
Range handling for free — none of which it does today. The bundled-exe branch reads from
`Bun.embeddedFiles` and stays custom, as does the SPA `index.html` fallback. Worth doing when
someone is next in that file; not urgent since the dev server is local.

### 6. `Bun.JSONL` streaming reads for session logs (tryable)

`logging/session-reader.ts:65` reads whole JSONL files into memory and splits on newlines.
`Bun.JSONL.parseChunk()` streams. Only matters for very long sessions; adopt opportunistically
when session-reader is next touched.

### 7. `process.on("memoryPressure")` for the agent tier (tryable)

The OS low-memory notification is a natural extra trigger for what the idle reapers already
do on timers: retire idle app agents (`AppAgentRegistry`), shrink the warm pool, sweep idle
browser sessions. A small listener wired in `lifecycle.ts` that invokes the existing sweeps —
no new mechanism. Needs a real design pass on *which* sweeps are safe to run mid-turn.

### 8. Dev-workflow niceties (no code change)

- `--cpu-prof-md` / `--heap-prof-md` for diagnosing server hot spots without external tooling.
- On the upgrade PR or soon after: `bun dedupe`, `bun prune`, `bun audit fix --dry-run`;
  note `bun update` now reaches transitive deps and respects `--filter`.

## Upgrade mechanics & findings from the bump

- `.bun-version` 1.3.14 → 1.4.0 (CI picks this up via `setup-bun`'s `bun-version-file`);
  `bun-types` catalog pin `^1.3.14` → `^1.4.0`.
- `engines.bun` is `>=1.4.0` as of items 1–3, which put `Bun.Archive` and an
  `--isolate`-dependent test partition into source.
- **bun-types 1.4.0 typing bug:** `overrides.d.ts` declares `off`/`removeListener`
  `("memoryPressure")` overloads directly on `NodeJS.Process`, which *hides* the generic
  `EventEmitter` overloads — so `process.off('warning', fn)` no longer typechecks.
  Worked around with a cast in `session-event-router.test.ts`; worth an upstream issue.
  (This is the same posture as the unicode-escape guard: note the upstream issue, keep the
  local workaround small and commented.)

## Status

- 2026-08-21: bump landed; typecheck clean after the bun-types workaround. Full suite green
  under 1.4.0: 2553 pass / 0 fail / 1 skip across 239 files, all 5 packages — including the
  `server:units` partition now implicitly running `--isolate` via `--parallel`, which is the
  first evidence for item 1's spike.
- 2026-08-21: items 1–3 landed together. Full suite green: 2556 pass / 0 fail / 1 skip across
  239 files (the three extra are `app-install-archive.test.ts`'s new cases); typecheck, lint
  and `format:check` clean; all three exe targets build. Left open by design: the `tar czf`
  in `publish.ts` (item 2, reasons above) and items 4–8.
