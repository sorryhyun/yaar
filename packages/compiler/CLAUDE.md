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
├── plugins.ts             # 4 Bun plugins: bundledLibrary, cssFile, solidHtmlTemplateGuard, solidHtmlClosingTag
├── solid-html-guard.ts    # Classifies broken solid-js/html templates (AST-based, fails the build)
├── config.ts              # CompilerConfig (projectRoot, isBundledExe)
├── typecheck.ts           # tsc integration (loose mode, 30s timeout)
├── extract-protocol.ts    # Regex-based protocol manifest extraction from source (sees through `defineCommand({...})`)
├── design-tokens.ts       # YAAR_DESIGN_TOKENS_CSS (variables + utility classes)
├── build-manifest.ts      # SHA-256 source/app.json hashing for staleness detection
├── bundled-types/
│   └── index.d.ts         # Type declarations for all @bundled/* imports
└── shims/
    ├── yaar.ts            # Main SDK: verb functions, appStorage, createPersistedSignal, onShortcut
    ├── yaar-dev.ts        # Gated SDK: compile, typecheck, deploy (requires bundles: ["yaar-dev"])
    ├── yaar-web.ts        # Gated SDK: browser automation (requires bundles: ["yaar-web"])
    ├── yaar-ml.ts         # Gated SDK: in-browser model inference via onnxruntime-web (requires bundles: ["yaar-ml"])
    └── anime.ts           # v3→v4 easing name compat wrapper
```

## Compilation Flow

1. **Entry:** `compileTypeScript(sandboxPath, options)` — expects `src/main.ts`
2. **Bundle:** `Bun.build()` with 3 plugins resolves imports, transforms CSS, fixes solid-js/html closing tags
3. **SDK injection:** 8 iframe SDK scripts (capture, storage, verbs, fetch-proxy, app-protocol, notifications, windows, console) minified once and cached
4. **HTML wrap:** `generateHtmlWrapper()` creates self-contained HTML with design tokens CSS + SDK `<script>` + app `<script type="module">`
5. **Protocol extraction:** Best-effort regex parse of `.register({...})` for state/command descriptors → `dist/protocol.json`. A descriptor may be wrapped in a single identifier call (`defineCommand({...})`) — the parser steps over it. Anything less literal (spread, computed callee) is skipped, so the command silently vanishes from the manifest.
6. **Manifest:** Write `dist/.build-manifest.json` with source hash, app.json hash, compiler version

## Bun Plugins (`plugins.ts`)

**`bundledLibraryPluginBun(allowedBundles)`** — resolves `@bundled/*` imports with priority:
1. Embedded (`globalThis.__YAAR_BUNDLED_LIBS` for standalone exe)
2. Shim (local wrapper in `shims/`)
3. Browser-aware (reads package.json exports, prefers browser condition)
4. Fallback (`Bun.resolveSync`)
5. Disk (`bundled-libs/` next to exe)

Gating: any `yaar-*` extended SDK (`yaar-dev`, `yaar-web`, `yaar-ml`) requires explicit `"bundles"` in app.json. Solid-js imports from bundled libs are intercepted to prevent duplicate module instances.

**`cssFilePlugin()`** — converts `.css` imports to JS that injects a `<style>` element at runtime.

**`solidHtmlTemplateGuardPlugin()`** — fails the build on `html` templates that solid-js/html mis-compiles. `solid-js/html` joins the static parts with a `<!--#-->` marker and feeds generated source to `new Function`, but its parser only emits text nodes from inside a matched-tag callback — so top-level text before the first tag is dropped, and a lone top-level marker yields `.firstChild` with no parent. Finds templates via the TypeScript AST (correct under nesting), classifies them with `classifyTemplate()`, and reports file/line/column plus a fix. `typescript` is a devDependency absent in exe mode, so it is imported through a runtime-assembled specifier and the guard no-ops when unavailable.

**`solidHtmlClosingTagPlugin()`** — rewrites `</${Component}>` to `</>` in source before bundling (closing tags cause expression index misalignment in solid-js/html).

## Bundled Libraries

30+ libraries available via `@bundled/*` — no npm install needed in apps:
- **UI:** `@bundled/solid-js`, `@bundled/solid-js/web`, `@bundled/solid-js/html`, `@bundled/solid-js/store`
- **Utils:** `@bundled/uuid`, `@bundled/lodash`, `@bundled/date-fns`, `@bundled/clsx`
- **Graphics:** `@bundled/three`, `@bundled/konva`, `@bundled/pixi.js`, `@bundled/p5`, `@bundled/cannon-es`, `@bundled/matter-js`
- **Data:** `@bundled/chart.js`, `@bundled/d3`, `@bundled/diff`, `@bundled/diff2html`, `@bundled/xlsx`, `@bundled/marked`, `@bundled/mammoth`, `@bundled/prismjs`
- **Animation:** `@bundled/anime` (with v3 compat shim)
- **Audio:** `@bundled/tone`
- **YAAR SDKs:** `@bundled/yaar`, `@bundled/yaar-dev` (gated), `@bundled/yaar-web` (gated), `@bundled/yaar-ml` (gated — in-browser ONNX/WebGPU inference)

## Shims

Shims wrap npm packages with compatibility fixes or SDK wrappers:

- **`yaar.ts`** — thin wrapper over `window.yaar` global. Exports verb functions (`read`, `invoke`, `list`, `describe`, `del`, `subscribe`), `appStorage` (read/write/list/remove via `yaar://apps/self/storage/*`, plus `trySave` — reports the failure and resolves `false` instead of throwing, so callers can withhold a "Saved" UI), `appDb` (SQLite-backed collections via `yaar://apps/self/db/*` — insert/find/search/update/remove with Mongo-style filters, plus `createReactiveCollection` for a query-tracking Solid signal), `createPersistedSignal` (Solid signal auto-synced to storage via `trySave`), `defineCommand`, `onShortcut`, `showToast`, `withLoading`, `errMsg`, `wait`, `AppCommandError`
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
