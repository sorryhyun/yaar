# Proposal: Bun 1.4 adoption — retiring what the runtime now does for us

**Status:** items 1–5 landed and have been cut from this file — their write-ups are in git
history (and, where it matters at the call site, in code comments). Items 6–8 remain open and
keep their original numbers so earlier references still resolve. The version bump itself is
done (`.bun-version` → 1.4.0, `bun-types` catalog pin → `^1.4.0`, root `@types/bun` →
`^1.4.0` so its nested `bun-types` stops pinning 1.3.14, `engines.bun` → `>=1.4.0`).
`tar` is now entirely gone from the repo: item 2 finished by moving tarball *creation* onto
`Bun.Archive` too.
**Date:** 2026-08-21
**Reference:** [Bun 1.4 release notes](https://bun.com/blog/bun-v1.4)

## Problem

Several YAAR subsystems existed to work around gaps in Bun ≤1.3, each carrying a documented
apology for its own existence. Bun 1.4 shipped first-class answers, and items 1–4 spent them:
the hand-partitioned mock test processes are gone (`--isolate`), all three `tar` spawns are
gone (`Bun.Archive`), the synthetic exe entry point is gone (`--compile --asset`), and the
frontend is auto-memoized (`--react-compiler`). Item 5 is the one that went the other way: the
Bun 1.4 feature it named turned out to be structurally wrong for this server, and the *behavior*
it promised was worth having anyway, so `http/routes/static.ts` now answers conditional GETs
itself.

What is left is opportunistic adoption with no current pain behind it.

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

## Items

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
- 2026-08-21: item 2 finished — `packageAppTarball` builds the published app tarball with
  `Bun.Archive` instead of spawning `tar czf`, so no `tar` process is left anywhere in the
  repo. The earlier reservation (its gzip output is not byte-deterministic) was dropped as
  overcautious: nothing in the publish flow ever compared two archives. Integrity is the
  SHA-256 of the *frozen* bytes and drift detection is `computeSourceHash` over `src/`
  content, both unaffected by how the archive is produced. Two shape changes go up with it —
  regular-file entries only (no directory members) and a uniform 0644 mode — which a
  path-creating extractor does not notice; the excludes (`dist/`, `.DS_Store`, `._*`) moved
  from `tar --exclude` patterns into the directory walk.
- 2026-08-21: item 5 landed, but **not** as `{ dir }` routes — measured on 1.4.0, a directory
  route cannot serve this frontend, and `static.ts`'s header records why at the call site. Four
  reasons, any one of them disqualifying: the build is flat, so the only prefix available is
  `/*` (the webfont URLs are baked into `features/fonts`' catalog and thus into app-facing CSS,
  so the namespace cannot simply move); a route preempts `fetch` and a miss is a `404` rather
  than a hand-off, which would take the SPA fallback *and* the `desktopRedirectTarget` check
  that keeps the desktop document off the app origin away from `createFetchHandler`;
  `DirectoryRouteOptions` has no header hook, so responses would lose the CORS headers
  `withCors` attaches; and it pins the directory by fd at `serve()` time, which `dev-bundler.ts`
  invalidates on its first hot rebuild by `rmSync`+`renameSync`-ing a new `dist/` into place —
  every asset `404`s from then on, `statCache: false` no different, and a missing `dist/` throws
  `ENOENT` at boot.
  The premise was also partly wrong: Bun *already* infers `Content-Type` from a `BunFile` and
  already answers `Range` with a `206` on the plain `fetch` path, so the real gap was conditional
  GET alone. That is now implemented for both branches — the exe branch, which no directory route
  could ever have helped, included. Filesystem assets get a weak `size`-`mtime` ETag plus
  `Last-Modified`; embedded assets get a *strong* one from the content hash Bun mints into the
  `/$bunfs/root/main-<hash>.js` path (confirmed content-derived by rebuilding a fixture with
  different bytes at the same length) and no `Last-Modified`, since an embedded file reports the
  sentinel 4503599627370495 — a date in the year 144680. Content-hashed build outputs are
  `immutable`; everything else, the four webfonts above all, is `no-cache` and revalidates.
  Measured end to end through the real fetch handler: a full desktop reload drops from 14.59 MB
  of asset bodies to 0. 11 new tests in `static-conditional-get.test.ts`, one of which caught a
  real defect in the `If-None-Match` list parse (the `W/` prefix was tested before the
  separator's space was trimmed, so every entry after the first compared weak against strong).
  Full suite green: 2576 pass / 0 fail / 1 skip across 241 files.
