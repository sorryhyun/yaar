# Compiler Package

Transforms TypeScript apps into self-contained HTML files using Bun's bundler. Resolves `@bundled/*` imports, injects SDK scripts and design tokens, extracts app protocol manifests.

## Commands

```bash
bun run build            # Build (tsc)
bun run typecheck        # Type check only
bun run dev              # Watch mode
```

## Directory Structure

```
src/
├── index.ts               # Barrel exports
├── compile.ts             # Core: Bun.build() → HTML wrapper with embedded JS + SDKs
├── plugins.ts             # 3 Bun plugins: bundledLibrary, cssFile, solidHtmlClosingTag
├── config.ts              # CompilerConfig (projectRoot, isBundledExe)
├── typecheck.ts           # tsc integration (loose mode, 30s timeout)
├── extract-protocol.ts    # Regex-based protocol manifest extraction from source
├── design-tokens.ts       # YAAR_DESIGN_TOKENS_CSS (variables + utility classes)
├── build-manifest.ts      # SHA-256 source/app.json hashing for staleness detection
├── bundled-types/
│   └── index.d.ts         # Type declarations for all @bundled/* imports
└── shims/
    ├── yaar.ts            # Main SDK: verb functions, appStorage, createPersistedSignal, onShortcut
    ├── yaar-dev.ts        # Gated SDK: compile, typecheck, deploy (requires bundles: ["yaar-dev"])
    ├── yaar-web.ts        # Gated SDK: browser automation (requires bundles: ["yaar-web"])
    └── anime.ts           # v3→v4 easing name compat wrapper
```

## Compilation Flow

1. **Entry:** `compileTypeScript(sandboxPath, options)` — expects `src/main.ts`
2. **Bundle:** `Bun.build()` with 3 plugins resolves imports, transforms CSS, fixes solid-js/html closing tags
3. **SDK injection:** 8 iframe SDK scripts (capture, storage, verbs, fetch-proxy, app-protocol, notifications, windows, console) minified once and cached
4. **HTML wrap:** `generateHtmlWrapper()` creates self-contained HTML with design tokens CSS + SDK `<script>` + app `<script type="module">`
5. **Protocol extraction:** Best-effort regex parse of `.register({...})` for state/command descriptors → `dist/protocol.json`
6. **Manifest:** Write `dist/.build-manifest.json` with source hash, app.json hash, compiler version

## Bun Plugins (`plugins.ts`)

**`bundledLibraryPluginBun(allowedBundles)`** — resolves `@bundled/*` imports with priority:
1. Embedded (`globalThis.__YAAR_BUNDLED_LIBS` for standalone exe)
2. Shim (local wrapper in `shims/`)
3. Browser-aware (reads package.json exports, prefers browser condition)
4. Fallback (`Bun.resolveSync`)
5. Disk (`bundled-libs/` next to exe)

Gating: `yaar-dev` and `yaar-web` require explicit `"bundles"` in app.json. Solid-js imports from bundled libs are intercepted to prevent duplicate module instances.

**`cssFilePlugin()`** — converts `.css` imports to JS that injects a `<style>` element at runtime.

**`solidHtmlClosingTagPlugin()`** — rewrites `</${Component}>` to `</>` in source before bundling (closing tags cause expression index misalignment in solid-js/html).

## Bundled Libraries

30+ libraries available via `@bundled/*` — no npm install needed in apps:
- **UI:** solid-js, solid-js/web, solid-js/html, solid-js/store
- **Utils:** uuid, lodash, date-fns, clsx
- **Graphics:** three, konva, pixi.js, p5, cannon-es, matter-js
- **Data:** chart.js, d3, diff, diff2html, xlsx, marked, mammoth, prismjs
- **Animation:** anime (with v3 compat shim)
- **Audio:** tone
- **YAAR SDKs:** yaar, yaar-dev (gated), yaar-web (gated)

## Shims

Shims wrap npm packages with compatibility fixes or SDK wrappers:

- **`yaar.ts`** — thin wrapper over `window.yaar` global. Exports verb functions (`read`, `invoke`, `list`, `describe`, `del`, `subscribe`), `appStorage` (read/write/list/remove via `yaar://apps/self/storage/*`), `createPersistedSignal` (Solid signal auto-synced to storage), `onShortcut`, `showToast`, `withLoading`, `AppCommandError`
- **`yaar-dev.ts`** — posts to `/api/dev/<action>` endpoints for compile/typecheck/deploy
- **`yaar-web.ts`** — posts to `/api/browser` for CDP browser automation (tabs, navigation, clicks, screenshots, cookies)
- **`anime.ts`** — normalizes v3 easing names (`easeOutCubic` → `outCubic`) for anime.js v4

## Build Manifest & Staleness

`isAppStale(appPath)` compares current source/app.json SHA-256 hashes against `dist/.build-manifest.json`. Apps recompile only when stale or compiler version bumps (`COMPILER_VERSION`).

## Key Patterns

- **Lazy SDK caching:** SDK scripts minified on first compile, reused for all subsequent compiles
- **Best-effort extraction:** Protocol extraction never blocks compilation — fails silently
- **`</script` escaping:** `generateHtmlWrapper` escapes `</script` sequences in JS to prevent premature tag closing
- **Deterministic hashing:** Source hash computed from sorted file list for consistent staleness detection
- **Path normalization:** `toForwardSlash()` used throughout for Windows compatibility with Bun.build
