# Proposal: Bun 1.4 adoption — retiring what the runtime now does for us

**Status:** proposed. The version bump itself is done (`.bun-version` → 1.4.0, `bun-types`
catalog pin → `^1.4.0`); every item below is a separate follow-up, ordered by expected payoff.
**Date:** 2026-08-21
**Reference:** [Bun 1.4 release notes](https://bun.com/blog/bun-v1.4)

## Problem

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

### 1. `bun test --isolate`: collapse the mock partitions (high)

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

### 2. `Bun.Archive`: delete the three `tar` spawns (high)

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

### 3. `--compile --asset`: simplify exe embedding (high)

**Today:** `scripts/build/exe-bundle.js` writes a generated entry point importing every
`frontend/dist` / `dist/bundled-libs` / onnxruntime file `with { type: "file" }` so they land
in `Bun.embeddedFiles`, consumed by `static.ts` via `globalThis.__YAAR_EMBEDDED_FRONTEND`.

**Bun 1.4:** `bun build --compile --asset <path>` embeds files or whole directories directly.

**Plan:** swap the generated-entrypoint machinery for `--asset` flags on the existing
`bun build --compile` invocation (`exe-bundle.js:273`), keeping the
`__YAAR_EMBEDDED_FRONTEND` lookup shape in `static.ts` (or simplifying it if the asset API
serves paths directly). Verify on all three exe targets before deleting the old path —
this only ever runs under `IS_BUNDLED_EXE`, so CI won't catch a regression by itself.

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
- `engines.bun` stays `>=1.3.0` until the first 1.4-only API lands in source (items 1–3 all
  qualify); raise it to `>=1.4.0` in whichever of those PRs merges first.
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
