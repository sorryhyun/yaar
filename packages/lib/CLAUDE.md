# @yaar/lib

The utilities YAAR uses that are **not about YAAR**.

Everything here is bytes-in/bytes-out or process-shaped. None of it knows what a session, a
monitor, a window, an app or an agent is; none of it has ever heard of an OS Action. It was
`packages/server/src/lib/` until the boundary the server's own CLAUDE.md described in prose —
"standalone utilities with no server internal dependencies" — became something the module
graph enforces rather than something a reviewer has to remember.

## The rule

A module belongs here if it can be described without the word "YAAR", and if its only imports
are node/bun built-ins, `@yaar/shared`, third-party packages, and other `@yaar/lib` modules.

It does **not** belong here if it reads `config/`, resolves a storage path, knows an access
tier, or needs the server's logger. Those are decisions about *this* application, and the
inversion is always the same shape: take the answer as a parameter and let the server pass it.
Two live examples —

- `pdf/poppler-pdf.ts` takes `binDir`. It cannot tell a source checkout from a bundled exe;
  `IS_BUNDLED_EXE` is the server's fact. `packages/server/src/features/pdf.ts` binds it once
  so no call site has to remember.
- `tunnel/config.ts`'s `loadTunnelConfig(configDir)` takes the directory. Where YAAR keeps its
  config is YAAR's question; the parser only wants a path — which is also what lets its test
  point at a temp dir without touching the environment.

Nothing here may import from `@yaar/server`. That is the whole point, and the dependency
direction is one-way forever.

## Contents

| Path | What |
| --- | --- |
| `archive/` | zip (hand-written on `node:zlib`: CRC-checked, inflate capped at the declared size, ZIP64) and tar/tar.gz (`Bun.Archive` behind a bounded gunzip) — list, read one entry, build. Every limit is the caller's; nothing here writes entries to disk |
| `download/` | Chunked, resumable HTTP download to a file |
| `fonts/` | OpenType/CFF/glyf subsetting — the byte-level half. The catalog of served faces is the server's `features/fonts/` |
| `freedpi/` | Loopback CONNECT proxy that fragments TLS past SNI-matching DPI. On by default; `YAAR_FREEDPI=0` turns it off |
| `pdf/` | PDF rasterization and text extraction via poppler |
| `termux/` | Termux:API client (notification, clipboard, share sheet, toast) — every call timed, because a missing Termux:API app makes the commands hang rather than fail |
| `tls/` | Self-signed loopback certificate (via `openssl`) + its Chromium SPKI hash, for a local h2 socket |
| `tunnel/` | Tailscale Serve tunnel driver and `config/tunnel.json` parsing |
| `ytdlp/` | Optional yt-dlp binary wrapper — discovered on PATH, never bundled |
| `errors.ts` | `errMessage(unknown)` |
| `ids.ts` | `genId` / `genStamp` |
| `image.ts` | Data-URL parsing, and `toWebPForModel()` — the re-encode applied on the way into a model context |
| `open-url.ts` | Open a URL in the user's browser |
| `pick-directory.ts` | Native directory picker |
| `ssrf.ts` | URL validation and `safeFetch` with redirect following |

`ssrf.ts` and `freedpi/` import each other on purpose: the guard that keeps the bypass from
widening SSRF lives with the resolver that needs it, and the bypass is what `safeFetch` routes
through. See `freedpi/resolve.ts`'s header.

## Commands

```bash
bun run --filter @yaar/lib build      # tsc -p tsconfig.build.json → dist/ (no tests emitted)
bun run --filter @yaar/lib typecheck  # tsc --noEmit, tests included
bun run --filter @yaar/lib test       # bun test src (colocated *.test.ts count too; dist/ is ignored)
bun run --filter @yaar/lib dev        # tsc --watch → dist/; the server runs against dist/, so keep this up under make dev
bun run --filter @yaar/lib lint
```

Consumers resolve `dist/`, so a stale build is a stale import — `prebuild`/`pretest`/
`pretypecheck` run `scripts/build/ensure-deps-built.ts shared`, and the server's own
`pretest`/`pretypecheck` name `lib` so it rebuilds this package before running.

## Conventions

- ESM, `.js` extensions on every relative import.
- TypeScript strict. `declaration: true` — this package's `.d.ts` is its API.
- Subpath exports (`@yaar/lib/ssrf`, `@yaar/lib/fonts`, …) are the way in. The root barrel
  exists for a consumer that wants several at once; prefer the subpath, it reads better at the
  import site and it keeps the module graph honest about what depends on what.
- Tests live in `src/tests/` and import relative paths within the package. A test that needs a
  server helper is a test that belongs in the server.
