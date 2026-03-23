# App SDK DX Improvement Plan

## Problem

Apps in `apps/` re-implement the same patterns repeatedly. The agent (devtools) also copies these patterns when building new apps, compounding boilerplate. The SDK (`@bundled/yaar`) provides low-level primitives but lacks the convenience layer that every app ends up writing.

## Tiers

### Tier 1 — Tiny wins (done)

No new concepts, just extract what every app already writes.

| Addition | What it kills | Files touched |
|----------|---------------|---------------|
| `showToast(msg, type?, ms?)` | 6+ copy-pasted implementations across apps | `shims/yaar.ts`, `bundled-types/index.d.ts` |
| `errMsg(e)` | `err instanceof Error ? err.message : String(err)` everywhere | same |
| `appStorage.readJsonOr(path, fallback)` | `try { read() } catch { defaults }` on every first-run | same |

Migration: update `AGENTS.md` so the devtools agent uses the new APIs by default and stops generating the old patterns.

### Tier 2 — Small helpers (next)

| Addition | What it kills | Complexity |
|----------|---------------|------------|
| `appStorage.readBlob(path): Blob` | `atob` → `charCodeAt` → `Uint8Array` dance (28 files) | Small |
| `withLoading(setLoading, setError, fn)` | The 8-line try/loading/catch/error/finally skeleton | Small |
| `onShortcut(combo, handler)` with auto-cleanup | 5+ apps with manual `window.addEventListener('keydown', ...)` | Small |

### Tier 3 — Medium ergonomics (later)

| Addition | What it kills | Complexity |
|----------|---------------|------------|
| `createPersistedSignal(key, default)` | Manual save/load + JSON round-trip for every persisted signal | Medium — needs Solid.js `createEffect` integration |
| `createAsyncResource(fetcher)` | Manual `[loading, error, data]` signal triplet + try/catch | Medium — similar to Solid's `createResource` |
| Schema builder for protocol params | Hand-written JSON Schema in every `protocol.ts` | Medium |
| Export `createStore` from `@bundled/solid-js/store` | Signal explosion (10-20 loose signals per app) | Tiny config change, but migration is medium |

### Tier 4 — Structural (future)

| Idea | Impact |
|------|--------|
| Standardized command return type `{ ok, data?, error? }` with diff/change info | Agent can reason about what changed |
| Pre-built Solid.js component library (`@bundled/yaar-ui`) wrapping `y-*` classes | Agent stops re-creating modal/toolbar/sidebar components |
| Global keyboard shortcut registry with conflict detection | Apps register shortcuts, system handles conflicts |

## Non-goals

- Don't break existing apps — all additions are additive
- Don't force migration — old patterns still work
- Don't add abstractions that only one app would use
