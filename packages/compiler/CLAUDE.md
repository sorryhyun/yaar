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
├── index.ts               # Barrel exports — the whole public surface, deep imports are internal
├── compile.ts             # Core: Bun.build() → HTML wrapper with embedded JS + SDKs
├── typecheck.ts           # tsc integration (loose mode, 30s timeout)
├── config.ts              # CompilerConfig (projectRoot, isBundledExe)
├── paths.ts               # MODULE_ROOT / PACKAGE_ROOT / SHIMS_DIR — the one src-vs-dist derivation
├── load-typescript.ts     # Memoized runtime `import('typescript')`, null in exe mode (YAAR_NO_TYPESCRIPT=1 forces it)
├── design-tokens.ts       # YAAR_DESIGN_TOKENS_CSS + describeDesignTokens() (generated token reference)
├── build/
│   ├── build-app.ts       # buildAppBundle() — the one Bun.build call for an app (compile + fold share it) + formatBuildLogs
│   ├── source-cache.ts    # AppSourceCache — one read of each source file per compile, never across two
│   └── build-manifest.ts  # SHA-256 source/app.json hashing for staleness detection
├── bundled/
│   ├── registry.ts        # BUNDLED_LIBRARIES / BUNDLED_SHIMS / GATED_* / resolveBrowserEntry — data, no Bun API
│   ├── plugins.ts         # 4 Bun plugins: bundledLibrary, cssFile, assetDataUrl, solidHtmlSource
│   ├── describe-library.ts # getBundledLibraryDetail() — slices the .d.ts for an agent (+ design-tokens pseudo-library)
│   └── prebundle.ts       # prebundleLibrary(name) — shared by scripts/build/prebundle-libs.js and the completeness test
├── guards/
│   ├── guard-report.ts    # createAppSourceFile/walk/snippet/format — the shape all three guards share (ASCII rule lives here)
│   ├── solid-html-guard.ts # Classifies broken solid-js/html templates (AST-based, fails the build)
│   ├── mount-guard.ts     # APP_MOUNT_ID + rejects render() into an element the wrapper never emits
│   └── design-token-guard.ts # Rejects var(--yaar-*) names that can never resolve
├── protocol/
│   ├── extract-protocol-dir.ts   # Protocol extraction entry point — picks the AST reader or the fold
│   ├── extract-protocol-ast.ts   # What `defineApp` means: locate the call, build the manifest, public entry points
│   ├── protocol-extractor.ts     # The reader: resolve a name, unwrap a value, flatten an object literal
│   ├── protocol-module-graph.ts  # Specifier resolution + per-module binding index (ModuleScope), ProtocolError
│   └── fold-schemas.ts    # Runs a defineApp app in a Worker to read Zod schemas (and the whole manifest, without `typescript`)
├── bundled-types/
│   └── index.d.ts         # Type declarations for all @bundled/* imports
└── shims/
    ├── yaar/              # Main SDK, split into internal modules (index.ts is the only entry)
    │   ├── index.ts       # Barrel — the entire @bundled/yaar public surface
    │   ├── verbs.ts       # window.yaar global, read/invoke/list/describe/del/subscribe, stream, httpFetch
    │   ├── app-storage.ts # appStorage (yaar://apps/self/storage/*)
    │   ├── app-db.ts      # appDb + CollectionHandle (yaar://apps/self/db/*)
    │   ├── dialogs.ts     # showAlert / showConfirm / showPrompt
    │   ├── ui.ts          # showToast, onShortcut, withLoading, errMsg, wait, createStaleGuard, AppCommandError, defineAppCommand
    │   ├── sanitize.ts    # sanitizeHtml — the one DOMPurify policy (defaults + no forms)
    │   ├── define-app.ts  # defineApp() — registration timing, mounting, error contract, Zod params validation, keybinding dispatch
    │   └── reactive.ts    # createPersistedSignal, createCollapsiblePanel, createAutosave
    ├── yaar-dev.ts        # Gated SDK: compile, typecheck, deploy, per-app git history (requires bundles: ["yaar-dev"])
    ├── yaar-web.ts        # Gated SDK: browser automation (requires bundles: ["yaar-web"])
    ├── yaar-ml.ts         # Gated SDK: in-browser model inference via onnxruntime-web (requires bundles: ["yaar-ml"])
    ├── anime.ts           # v3→v4 easing name compat wrapper
    ├── mermaid.ts         # lazy init, token theming, forced strict mode, serialized renders
    ├── dompurify.ts       # keeps purify.es.mjs off the entrypoint slot (see below)
    ├── uuid.ts            # re-export barrel workaround (see below)
    ├── zod.ts             # re-export barrel workaround for zod/mini (see below)
    ├── lodash.ts          # re-export barrel workaround for lodash-es (see below)
    └── pixi.ts            # re-export barrel workaround for pixi.js (see below)
```

## Compilation Flow

1. **Entry:** `compileTypeScript(sandboxPath, options)` — expects `src/main.ts`
2. **Token guard:** `scanTokens()` over every `src/**/*.{ts,tsx,css}` — fails the build before bundling if any `var(--yaar-*)` can never resolve
3. **Bundle:** `Bun.build()` with 4 plugins resolves imports, transforms CSS, fixes solid-js/html closing tags, and runs the solid-html + mount guards
4. **SDK injection:** 9 iframe SDK scripts (ime-guard, capture, storage, verbs, fetch-proxy, app-protocol, notifications, windows, console) minified once and cached
5. **Protocol extraction:** AST parse of `export default defineApp({...})` for state/command/event descriptors → `dist/protocol.json`, then a gate that fails the build on anything unresolvable (see below)
6. **HTML wrap:** `generateHtmlWrapper()` creates self-contained HTML with design tokens CSS + SDK `<script>` + `window.__yaar_manifest__` + app `<script type="module">`
7. **Manifest:** Write `dist/.build-manifest.json` with source hash, app.json hash, compiler version

Extraction runs *after* bundling (so genuine build errors keep precedence) and *before* the
HTML wrap, because the wrapper carries the extracted manifest back into the page.

## Protocol Extraction

The manifest an agent reads is built from source at compile time, while the manifest the
app actually serves is built at runtime by the iframe SDK from the same `defineApp({...})`
config. **Those two must agree.** The failure that matters is one-sided: a command that runs
fine but never reaches `dist/protocol.json` is invisible to agents while every build signal
stays green — one real incident shrank 29 commands to 3.

`protocol/extract-protocol-dir.ts` is the entry point and picks between two implementations:

| | the AST reader (`extract-protocol-ast.ts` over `protocol-extractor.ts` / `protocol-module-graph.ts`) | `fold-schemas.ts` |
|---|---|---|
| When | `typescript` loads (normal builds) | a `defineApp` app whose schema is not a constant, or any `defineApp` app with no `typescript` |
| Reach | follows relative imports, `...spreads`, `const` refs, `as const` | whatever the app actually evaluates to |
| Values | constant-folds `+` concatenation anywhere, including inside `params` | `z.toJSONSchema()` of the running schema |
| Unresolvable | **hard build error with `file:line:col`** | **hard build error naming the descriptor path** |

Set `YAAR_NO_TYPESCRIPT=1` to reproduce a no-`typescript` environment on a dev machine. A third
reader — a brace-matching text scanner — used to stand there and was removed after it returned
*nothing at all*, with neither error nor warning, for apps that split their descriptor maps
across files with `...spread`. No shipped configuration reaches this path anyway: the exe
embeds `typescript` (`build/exe-bundle.js`) and a repo install gets it as a devDependency.

`app.register({...})` is **removed**, and both readers refuse it by name rather than reporting
"declares no protocol" — the AST path from the call site, the no-`typescript` path from a text
scan. Silence is the one answer this subsystem must never give, and an app whose commands
vanish from the manifest while the build stays green is exactly that. Both raise the same
`APP_REGISTER_REMOVED_MESSAGE`, so an author cannot tell which environment answered.

Because the AST path resolves spreads, **descriptor maps may be split across files by
domain** — `commands: { ...fileCommands, ...gitCommands }` where each map lives in its own
module. This is what the extractor exists to allow; it is why `apps/devtools/src/protocol/`
(build.ts, files.ts, git.ts, introspect.ts, media.ts, preview.ts, projects.ts, read-blocks.ts)
can split its descriptor map across files instead of one large module.

What it refuses, always with a location: a spread of a call result, a descriptor imported
from a package (resolution is deliberately app-local), a `${...}` template description, a
missing `description`, a method shorthand, a non-constant `params`/`schema` (outside
`defineApp`), and **two commands reachable by the same name or alias**. One bad entry
rejects the **whole** manifest — a partial manifest is the failure mode, not a consolation
prize.

### Zod schemas (`protocol/fold-schemas.ts`)

`defineApp` accepts a Zod schema wherever a JSON-Schema literal goes. `z.object({...})` is a
builder chain, not a constant, so the static evaluator *defers* it — records the descriptor
path and lets the fold resolve it — rather than erroring. Deferral is sound because
`defineApp`'s config is reachable at runtime as the entry module's default export, which is
what makes reading a schema back off the running app possible at all.

The fold builds the app together with a generated entry that imports `@bundled/zod` (one zod
instance, guaranteed by the bundler, in exe mode too), prepends browser-global stubs, and runs
the result in a **Worker** — separate globals, and a `terminate()` that stops a runaway module
scope. A subprocess would not work in the bundled exe, where `process.execPath` is the YAAR
binary. The `window` stub is load-bearing: `@bundled/yaar`'s barrel reads `window.yaar` at
module scope, so a compiled entry dies on import without it. `document` is stubbed with
`getElementById → null`, which is what makes `defineApp`'s mount a no-op.

Three consumers, one artifact:

- `dist/protocol.json` gets the folded JSON Schema.
- `window.__yaar_manifest__` carries the same bytes back into the page, so `defineApp` can
  serve JSON Schema to agents without bundling `toJSONSchema` into every app.
- The app keeps the schema object and validates each call through its Standard Schema
  `~standard.validate` — closing the presence-only gap in `app-protocol.ts`, which never
  checked a declared *type*. `run` receives the **parsed** value.

Without `typescript` the fold produces the whole manifest rather than just the deferred
schemas, which is what lets a `defineApp` app build at all in that environment. A
`fold-schemas.test.ts` case asserts both readers return the identical manifest for one app.

Three rules exist because breaking them produces a manifest that *disagrees with the
runtime and says nothing about it* — worse than a failed build, since every signal stays
green:

- **Which `defineApp`.** The call must be the SDK's — a named import from `@bundled/yaar`
  (aliases included) or a `*.defineApp(...)` member call, and its result must be the entry
  module's default export. An app declaring its own `defineApp` is not matched: it resolves
  locally, so it is that app's function. The mirror rule guards the removed shape: `register`
  is a common method name (`Chart.register(...registerables)` ships in a bundled app today),
  so only a call whose receiver *resolves* to the SDK's `app` object — the `app` binding
  imported from `@bundled/yaar` (aliases included), an `app` the app neither declares nor
  imports, or a member chain ending in `.app` — is refused as a leftover registration. An
  app's own `const app = registry` is left alone; the name is not the test.
- **Which wrappers are transparent.** `defineAppCommand({...})` is stepped over because the
  shim's `defineAppCommand` is the identity function — it exists for descriptors declared
  outside the `defineApp({...})` literal, which otherwise lose `run`'s parameter typing. Any
  callee this app *declares* must prove it — resolve to `(d) => d` or equivalent — including
  one named `defineAppCommand`. A wrapper that decorates its argument would otherwise be
  reported pre-decoration.
- **Which bindings are readable.** `const` only, and lexical scope is honored (a local
  shadowing a module binding wins). A `let`, a parameter, or a destructured binding is
  unreadable and errors rather than falling back to a same-named module binding.

## Runtime-Contract Guards

Three defects compile clean, typecheck clean, and then produce a blank or unstyled
window at runtime. They share one shape: **the app asserts a fact about the runtime
environment that the compiler owns but never checked.** Each guard closes one, and
each derives its expectation from the compiler's own output so it cannot drift.

| Guard | Rejects | Why tsc can't |
|---|---|---|
| `guards/solid-html-guard.ts` | `html` templates that drop text or throw a stackless `SyntaxError` | the template is parsed at runtime by `new Function` |
| `guards/mount-guard.ts` | `render(App, document.getElementById('root'))` — any id but `APP_MOUNT_ID` | `getElementById('root')!` is perfectly well-typed |
| `guards/design-token-guard.ts` | `var(--yaar-space-2)` — a token the compiler never defines | CSS custom properties are untyped strings |

- **Mount:** `APP_MOUNT_ID` is the single source of truth — `generateHtmlWrapper` emits
  `<div id="${APP_MOUNT_ID}">` and the guard checks against the same constant. Scoped to
  the *render target* (following one level of variable indirection), not to element
  lookups in general, so an app querying its own `#canvas` or a `DOMParser` document is
  untouched.
- **Tokens:** the known set is parsed out of `YAAR_DESIGN_TOKENS_CSS`. A token the app
  declares itself is legal, and so is `var(--yaar-x, fallback)` — a fallback is exactly
  how you opt out. Suggestions rank by *segment overlap* before edit distance, because
  raw Levenshtein puts `--yaar-bg-hover` closer to `--yaar-border` (5 edits) than to the
  token actually meant, `--yaar-bg-surface-hover` (8).
- Guard messages must be **ASCII**: those raised from a Bun plugin pass through an error
  path that mangles non-ASCII bytes (an em dash arrives as `â`). The rule, the walk, the
  snippet, and the `path:line:col` / `problem:` / `fix:` rendering live once in
  `guards/guard-report.ts`; `guard-report.test.ts` asserts the ASCII half. Each guard keeps
  its own headline (`solid-js/html: 2 broken templates`) — parameterized, not unified.

## Bun Plugins (`bundled/plugins.ts`)

**`bundledLibraryPluginBun(allowedBundles)`** — resolves `@bundled/*` imports with priority:
1. Embedded (`globalThis.__YAAR_BUNDLED_LIBS` for standalone exe)
2. Shim (local wrapper in `shims/`)
3. Browser-aware (reads package.json exports, prefers browser condition)
4. Fallback (`Bun.resolveSync`)
5. Disk (`bundled-libs/` next to exe)

Gating: any `yaar-*` extended SDK (`yaar-dev`, `yaar-web`, `yaar-ml`) requires explicit `"bundles"` in app.json. Solid-js imports from bundled libs are intercepted to prevent duplicate module instances.

**`cssFilePlugin()`** — converts `.css` imports to JS that injects a `<style>` element at runtime.

**`assetDataUrlPlugin()`** — inlines imported binary assets as base64 `data:` URIs, so
`import logo from './logo.png'` yields a string usable in `<img src>`, CSS `url()`, `fetch()`,
`new Audio()`. Covers `ASSET_MIME_TYPES` (images, fonts, wasm, mp3/wav); `*.png`-style ambient
declarations in `bundled-types/index.d.ts` keep typecheck green. Written as a plugin because
Bun's `loader: { '.png': 'dataurl' }` is silently a no-op in the *programmatic* bundler (1.3.14),
emitting an empty string — inlining only works through the HTML-entrypoint pipeline, which YAAR
doesn't use. Inlined bytes cost ~33%; `LARGE_BUNDLE_WARN_BYTES` (5MB) warns on the total.

**`solidHtmlSourcePlugin()`** — reads each TypeScript source once, rewrites `</${Component}>` to `</>` (closing tags cause expression index misalignment in solid-js/html), then fails the build on `html` templates that would silently drop text or throw a stackless `SyntaxError`. Finds templates via the TypeScript AST, classifies them with `classifyTemplate()`, and reports file/line/column plus a fix. The fast gate intentionally recognizes the current literal `html\`` spelling and does not trace the tag's import. `typescript` is absent in exe mode, so validation no-ops there while the rewrite still runs.

Bundled-library resolution logs are quiet by default. Set `YAAR_DEBUG_BUNDLED_LIBS=1` to print plugin initialization, resolution strategy, and resolved filesystem paths.

**`typecheckSandbox(path, { bundles })`** — runs the real TypeScript JS entry through Bun and removes ambient declarations for gated SDKs not present in `app.json` `bundles`. Compile and typecheck therefore reject the same unauthorized `@bundled/yaar-*` imports.

## Bundled Libraries

`getBundledLibraryDetail(name)` (in `bundled/describe-library.ts`) backs the agent-facing
`describeBundledLibrary`. It slices the
`declare module '@bundled/<name>…'` blocks out of `bundled-types/index.d.ts` and prepends the
`Yaar*` declarations they reference, transitively and covering `type` aliases as well as
`interface`s — `register()` is gone, but `defineApp`'s `YaarAppDefinition` -> `YaarAppCommands`
-> `YaarAppRunParams` chain has the same depth. See `describe-library.ts`'s header comment for
why transitive resolution matters here.

A module block that is a bare `export * from 'pkg'` tells the caller nothing, since the
upstream package is not something the agent can open — which is why the four `solid-js` blocks
carry in-block comments naming what lives in each entry point. **Those comments are part of the
tool's output; keep them accurate.** Without them `describeBundledLibrary("solid-js")` returned
four re-export lines, and importing `render`/`html` from `@bundled/solid-js` was the most
common first-compile failure.

Beyond the real `@bundled/*` modules it serves **pseudo-libraries** — describable but not importable.
`design-tokens` is one: the tokens ship as injected CSS, so they have no module and no
`.d.ts`, but an app agent still has to be able to ask what they are. It returns
`describeDesignTokens()`, generated from `YAAR_DESIGN_TOKENS_CSS`. Before it existed the
call fell through to `null`, and devtools' `AGENTS.md` was telling agents to make it — so
the agent asked for the token list, got nothing, and invented Tailwind-shaped names
(`--yaar-space-2`) that render to nothing. Same list feeds the App Authoring Contract in
`server/agents/profiles/app-agent.ts`, so what the compiler *rejects* and what it *tells
agents exists* are generated from one source (asserted by a test).

30+ libraries available via `@bundled/*` — no npm install needed in apps:
- **UI:** `@bundled/solid-js`, `@bundled/solid-js/web`, `@bundled/solid-js/html`, `@bundled/solid-js/store`
- **Utils:** `@bundled/uuid`, `@bundled/lodash`, `@bundled/date-fns`, `@bundled/clsx`
- **Graphics:** `@bundled/three`, `@bundled/konva`, `@bundled/pixi.js`, `@bundled/p5`, `@bundled/cannon-es`, `@bundled/matter-js`
- **Data:** `@bundled/chart.js`, `@bundled/d3`, `@bundled/diff`, `@bundled/diff2html`, `@bundled/xlsx`, `@bundled/marked`, `@bundled/mermaid`, `@bundled/mammoth`, `@bundled/prismjs`, `@bundled/dompurify`
- **Validation:** `@bundled/zod` (Zod Mini — functional API, tree-shakeable)
- **Animation:** `@bundled/anime` (with v3 compat shim)
- **Audio:** `@bundled/tone`
- **YAAR SDKs:** `@bundled/yaar`, `@bundled/yaar-dev` (gated), `@bundled/yaar-web` (gated), `@bundled/yaar-ml` (gated — in-browser ONNX/WebGPU inference)

## Shims

Shims wrap npm packages with compatibility fixes or SDK wrappers:

- **`yaar/`** — thin wrapper over `window.yaar` global. Split into internal modules for ownership; `index.ts` is the sole entry and `BUNDLED_SHIMS` points at it. The split is internal only — there are no `@bundled/yaar/*` subpath imports, and the declared type surface stays a single `declare module '@bundled/yaar'` in `bundled-types/index.d.ts`. Exports verb functions (`read`, `invoke`, `list`, `describe`, `del`, `subscribe`), `appStorage` (read/write/list/remove via `yaar://apps/self/storage/*`, plus `trySave` — reports the failure and resolves `false` instead of throwing, so callers can withhold a "Saved" UI), `appDb` (SQLite-backed collections via `yaar://apps/self/db/*` — insert/find/search/update/remove with Mongo-style filters, plus `createReactiveCollection` for a query-tracking Solid signal), `createPersistedSignal` (Solid signal auto-synced to storage via `trySave`, with a `revive` hook that clamps/migrates/validates the loaded value before it reaches the signal), `createCollapsiblePanel` (headless hover-expand + pin sidebar/overlay state machine — visibility, grace-period fold, persisted pin, resize-suppression; app owns the markup), `createAutosave` (headless dirty/debounced-save/save-status lifecycle with an editSeq guard so a stale save never clears the dirty flag), `defineApp` (the one registration entrypoint), `defineAppCommand` (for a command declared in another module and spread into `defineApp({ commands })` — `defineApp` infers `run`'s parameter only from a `params` at its own call site, so a spread-in command otherwise loses that typing silently), `createProtocolContext` (set-once holder letting statically-declared descriptors reach a context supplied at registration time — the supported alternative to a `buildCommands(ctx)` factory, which the extractor refuses), `onShortcut`, `showToast`, `withLoading`, `errMsg`, `wait`, `createStaleGuard` (the generation counter that keeps a slow response from overwriting a newer one — `begin`/`latest`/`invalidate`), `sanitizeHtml` (the single DOMPurify policy: its defaults plus the no-forms deviation every app was writing by hand; apps must not import `@bundled/dompurify` directly), `AppCommandError`
- **`yaar-dev.ts`** — posts to `/api/dev/<action>` endpoints for compile/typecheck/deploy, plus per-app version history (`gitHistory`, `gitDiff`, `gitRestore`, `gitCheckpoint`) backed by a shadow git repo per app
- **`yaar-web.ts`** — posts to `/api/browser` for CDP browser automation (tabs, navigation, clicks, screenshots, cookies)
- **`anime.ts`** — normalizes v3 easing names (`easeOutCubic` → `outCubic`) for anime.js v4
- **`mermaid.ts`** — the largest bundled library by a factor of ~2.6 (3.3 MB minified against p5's 1.29 MB; externalizing KaTeX, cytoscape and rough.js only reaches 2.41 MB, so there is no cheap trim), and every prebundled artifact is embedded in the exe, so this costs every download whether or not an app draws a diagram. It earns that because it turns diagramming from code generation into text generation, which is what an app agent is actually good at. The shim exists to remove four decisions an app would otherwise make wrong: **nothing runs at module scope** (`initialize()` is deferred to the first render, so an app importing it survives `fold-schemas.ts`'s DOM-stubbed Worker), **renders are serialized** through a promise queue (mermaid's config is a module-global read *during* `render()`, so two concurrent renders with different themes silently share the later theme), **`securityLevel` is forced to `'strict'`** and is not exposed as an option (that is what runs mermaid's own DOMPurify pass and disables HTML labels — so `renderMermaid`'s output is already sanitized, and passing it through `sanitizeHtml` would strip the `<style>` block the SVG needs to theme itself), and **`suppressErrorRendering`** keeps a syntax error from appending mermaid's "Syntax error in text" SVG to `document.body`, outside the app's tree where nothing cleans it up. Theme values are read from the live `--yaar-*` custom properties rather than imported from `tokens.ts`, so a diagram follows whatever tokens are actually in force; `renderMermaid(src, { theme })` overrides them per call for an app with its own palette
- **`uuid.ts`** — uuid's browser entry is a pure `export { default as v4 } from './v4.js'` barrel; bundling it directly makes Bun emit the `export { ... }` statement with every binding dropped, so the prebundled artifact fails later with `uuid:1:8: "h" is not declared in this file`. Importing the bindings and re-exporting them separately gives the bundler real references to follow. Any bundled library that is a pure re-export barrel needs the same treatment.
- **`zod.ts`** — `@bundled/zod` maps to `zod/mini`, whose browser entry is a nested `export * from …` barrel; the same defect makes the prebundled artifact fail with `zod:40:23830: "u6" is not declared in this file`. Routing it through a shim (`import * as z from 'zod/mini'; export * from 'zod/mini'; export { z }`) turns `zod/mini` into an inner module Bun materializes before re-exporting, so both the functional API and the `z` namespace survive. Because the surface is too large to enumerate uuid-style, the fix is the extra layer of indirection rather than an explicit binding list.
- **`lodash.ts`** / **`pixi.ts`** — same barrel defect. `@bundled/lodash` → `lodash-es` (a wall of `export { default as add } from './add.js'`) collapses to a ~4.7 KB stub failing with `lodash:1:8: "Yu" is not declared`; `@bundled/pixi.js` collapses to a ~16 KB stub. Both are fixed with a bare `export * from '<pkg>'` shim — the indirection alone is enough here, and lodash deliberately does **not** re-export the default (monolithic) build so named imports stay tree-shakeable. These three (plus uuid) are caught automatically by the prebundle-completeness test, so a new barrel library fails a test rather than an install.
- **`dompurify.ts`** — same indirection, different Bun defect. dompurify is the one bundled library that is *also* a dependency of other builds in the same process: `@bundled/yaar`'s `sanitizeHtml` imports it, so every app compile loads the same `dist/purify.es.mjs` that `prebundleLibrary('dompurify')` would otherwise bundle as an **entrypoint**. Bun does not survive one file playing both roles — after the prebundle, later `Bun.build()` calls in that process fail with `purify.es.mjs:-1:-1: EISDIR reading file: ".../purify.es.mjs"` on a plain 64 KB regular file. This took CI down for two days as 15 failures in `define-app.test.ts` / `fold-schemas.test.ts`, both of which pass when run alone; the poisoner was `prebundle-completeness.test.ts` earlier in the same `bun test` process. The shim demotes `purify.es.mjs` to an inner module in *both* builds. A test in `prebundle-completeness.test.ts` asserts the prebundle entrypoint stays the shim, because removing it reproduces only most of the time.

## Build Manifest & Staleness

`isAppStale(appPath)` compares current source/app.json SHA-256 hashes against `dist/.build-manifest.json`. Apps recompile only when stale or compiler version bumps (`COMPILER_VERSION`).

## Key Patterns

- **Lazy SDK caching:** SDK scripts minified on first compile, reused for all subsequent compiles
- **One read per compile:** `compileTypeScript` creates an `AppSourceCache` and threads it through the token guard, the bundler's source hook, and protocol extraction — three full reads of `src/` became one (80 of 134 reads avoided on `apps/devtools`). It is scoped to the call: a cache that outlived a compile would hand `dev.ts`'s recompile the previous edit's source, green all the way
- **Refusal over omission:** protocol extraction fails the build rather than emitting a manifest it had to guess around
- **`</script` escaping:** `generateHtmlWrapper` escapes `</script` sequences in JS to prevent premature tag closing
- **Deterministic hashing:** Source hash computed from sorted file list for consistent staleness detection
- **Path normalization:** `toForwardSlash()` used throughout for Windows compatibility with Bun.build
