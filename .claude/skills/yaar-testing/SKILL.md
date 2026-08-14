---
name: yaar-testing
description: Running and writing tests in the YAAR monorepo. Use when running bun test, writing or modifying *.test.ts files, or debugging a test failure or partition refusal.
paths:
  - "**/*.test.ts"
  - "scripts/test/**"
---

# YAAR testing

## Commands

- Per-package: `bun run --filter @yaar/<pkg> test` — `<pkg>` is `frontend`, `server`, `shared`,
  `compiler`, or `tests` (the integration/security package). Each has its own `test` script in
  its `package.json`.
- Single path from repo root: `bun test <path>`. Works for any path that is *one* partition
  (see below); a mixed path is refused.
- Full run: `bun run test` (root `package.json`, = `bun run --filter '*' test`) — what CI runs
  (`.github/workflows/checks.yml`, job `check`).
- `packages/server` alone fans out further: its `test` script is
  `bun run scripts/run-tests.ts`, not a plain `bun test` — it globs every `*.test.ts` under
  `src/`, groups by partition, and spawns one process per group concurrently. Don't `cd` into
  `packages/server` and run bare `bun test src/tests`; use the package's own `test` script.

## Partitioning

Some test files cannot share a Bun process with others — not "should not," the run reports
wrong results (confidently) if they do. Three reasons, all measured, not assumed:
`REMOTE=1`/`IS_REMOTE` is a module-load constant so remote-mode assertions are only real if
pinned for the whole process; `mock.module` is process-global with no teardown, so one file's
stub leaks into every other file sharing its process; and some suites (`src/tests/loopback/`,
`src/tests/realfs/`) own real sockets/git state and are sequential-only. The rule lives in
`scripts/test/partitions.ts` (`partitionOf`); `scripts/test/partition-guard.ts` is a `Bun.plugin`
preload that watches what a process actually loads and kills the run — with both offending files
and the correct command for each — the moment a second partition appears in one process. It's
wired via `bunfig.toml` (root) and `packages/server/bunfig.toml`. Full incident history and
rationale: `scripts/test/partitions.ts` header.

If a run is refused, don't fight it — run the printed commands separately, or use
`bun run test` / the package's own `test` script, which already partition correctly.

## Env pinning

Every `bun test` preloads `scripts/test/env.ts` first (root `bunfig.toml`, and
`packages/server/bunfig.toml`), so a run describes the code, not the machine it happens to run
on. It scrubs every `YAAR_*` var (except the `YAAR_TEST_*` runner-control prefix) plus the
documented non-prefixed knobs (`REMOTE`, `PORT`, `PROVIDER`, `MAX_AGENTS`, etc.), points
`YAAR_CONFIG`/`YAAR_STORAGE`/`YAAR_SESSION_LOGS` at fresh temp dirs (cleaned up on process exit),
and sets `YAAR_SKIP_DOTENV=1` so the root `.env` can't reintroduce anything. `YAAR_TEST_REMOTE=1`
is the one sanctioned opt-in for a remote-mode process — inferred automatically for anything
under `src/tests/remote/`.

## happy-dom caveats (frontend package)

- happy-dom loads no stylesheets and runs no CSS, animations, or layout. Never assert on visual
  behavior (computed styles, layout, animation state) in a frontend test — verify it in a real
  browser instead.
- `DOMPurify`'s `sanitize()` misbehaves under happy-dom — it strips `div`/`pre`/`p` elements that
  survive in a real browser. Never assert on sanitized HTML output in `bun test`; if you need to
  verify sanitization, do it manually in a browser.

## Server package specifics

`bun run test` in `packages/server` is `scripts/run-tests.ts`. It globs **every** `*.test.ts` under
`src/` (colocated files included — which is why `tsconfig.build.json` excludes `**/*.test.ts`), groups them by
`scripts/test/partitions.ts`, and spawns one process per group, concurrently. The partitions:

1. `units` — one `--parallel` process for the plain unit/component tests.
2. `remote` — `src/tests/remote/`, with `REMOTE=1` pinned for the whole process (`IS_REMOTE` is a
   module-load constant, so remote-gate assertions are vacuous in a local-mode process).
3. `loopback` — `src/tests/loopback/`, the real stack end to end with exactly two fakes
   (`FakeClient` for the browser, `ScriptedProvider` for the model); sequential, binds real
   sockets. See `tests/loopback/harness/boot.ts`'s header for the deadlock it exists to catch.
4. `realfs` — `src/tests/realfs/`, real `git` over a shared fixture dir. (The *integration* suite
   is the separate `@yaar/tests` package.)
5. one process per file that calls `mock.module` — the stub is process-global with no teardown.

Three rules follow:

- **A test never depends on the machine it runs on.** If a behavior is decided by an env var,
  a `config/` file, or a path, pin it in the test (or add it to the scrub list in
  `scripts/test/env.ts`) rather than inheriting whatever the developer has. A suite that only
  passes on a clean checkout is a suite that will fail on someone's laptop and pass in review.
- **Never add `mock.module` under `src/tests/loopback/`.** The harness substitutes through real
  seams instead: the provider via `ContextPool`'s `acquireProvider`, the logger via the
  `sessionLogger` option, the deadlines via `setDeadlinesForTest()` (`config.ts`), the config
  dir via `YAAR_CONFIG`.
- **Assert against the narrowest module that holds the behavior.** A test that stubs the
  `profiles/index.js` barrel stubs everything the barrel re-exports; a test that asserts on real
  behavior should import the concrete module (`profiles/model-tiers.js`), not the barrel.

Server→client waits (`ANSWER_EVENT_TYPES` in `@yaar/shared`) each get a loopback row: a wait the
client can only answer over a socket the server is holding is a deadlock waiting to happen.
