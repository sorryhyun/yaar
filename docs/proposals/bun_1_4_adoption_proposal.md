# Proposal: Bun 1.4 adoption — retiring what the runtime now does for us

**Status:** items 1–4 landed and have been cut from this file — their write-ups are in git
history (and, where it matters at the call site, in code comments). Items 5–8 remain open and
keep their original numbers so earlier references still resolve. The version bump itself is
done (`.bun-version` → 1.4.0, `bun-types` catalog pin → `^1.4.0`, `engines.bun` → `>=1.4.0`).
**Date:** 2026-08-21
**Reference:** [Bun 1.4 release notes](https://bun.com/blog/bun-v1.4)

## Problem

Several YAAR subsystems existed to work around gaps in Bun ≤1.3, each carrying a documented
apology for its own existence. Bun 1.4 shipped first-class answers, and items 1–4 spent them:
the hand-partitioned mock test processes are gone (`--isolate`), two of three `tar` spawns are
gone (`Bun.Archive`), the synthetic exe entry point is gone (`--compile --asset`), and the
frontend is auto-memoized (`--react-compiler`).

What is left is smaller and less load-bearing. `http/routes/static.ts` still serves the frontend
with a manual MIME table and no ETag/304/Range handling at all (item 5); the remaining items are
opportunistic adoptions with no current pain behind them.

The bump alone also bought runtime wins with no code change: ~5× lower idle CPU, 13–48% lower
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
- **`Bun.Archive` for *creating* the published app tarball** — the one part of item 2 left
  undone, and deliberately. Measured on 1.4.0, its gzipped output is not byte-deterministic,
  and it emits regular-file entries only (no directory members). Every byte crosses to the
  marketplace's own server-side extractor, which this repo cannot exercise. `publish.ts` stays
  a `tar czf` spawn until the far end can be verified.

## Items

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

## Standing findings from the bump

- **bun-types 1.4.0 typing bug:** `overrides.d.ts` declares `off`/`removeListener`
  `("memoryPressure")` overloads directly on `NodeJS.Process`, which *hides* the generic
  `EventEmitter` overloads — so `process.off('warning', fn)` no longer typechecks.
  Worked around with a cast in `session-event-router.test.ts`; worth an upstream issue.
  (Same posture as the unicode-escape guard: note the upstream issue, keep the local
  workaround small and commented.) Item 7 would land squarely on this API.
- **`bun test --randomize` fails two storage tests** — `storage-list-names.test.ts` and
  `app-storage-namespace-delete.test.ts` share scratch state and depend on declaration order
  *within* the file. Reproduces on those two files alone, so it is unrelated to partitioning.
  Not fixed.
- **`bun test` does not apply `--react-compiler`.** The flag lives on the two `Bun.build`
  call sites, so the frontend suite cannot catch a compiler-only regression; that class of
  change has to be verified in a real browser.

## Status

- 2026-08-21: bump landed; typecheck clean after the bun-types workaround. Full suite green
  under 1.4.0: 2553 pass / 0 fail / 1 skip across 239 files, all 5 packages.
- 2026-08-21: items 1–3 landed together (test partitions folded 19 processes → 4; both `tar`
  *extract* paths replaced; the generated exe entry point replaced by two checked-in files,
  verified on a real arm64 binary and building clean on all three targets). Full suite green:
  2556 pass / 0 fail / 1 skip across 239 files.
- 2026-08-21: item 4 landed. `reactCompiler: true` on both `Bun.build` call sites —
  `packages/frontend/build.ts` and `packages/server/src/http/dev-bundle-worker.ts`, kept in
  step so a behavior change cannot first appear in a release. 41 functions auto-memoized.
  The bundle grew slightly (+0.82% raw, +1.32% gzip) — `react/compiler-runtime` plus the
  per-function cache scaffolding — so the case rests on runtime behavior, confirmed in a
  browser. Running the stricter `react-hooks` rules the frontend eslint config skips found 8
  violation sites: the compiler declined to compile every refs-during-render and immutability
  one, two `set-state-in-effect` sites (`DesktopStatusBar`, `LoadingScreen`) did compile and
  behave, and the single purity site is in `RecentActionsPanel`, which is exported but never
  mounted.
