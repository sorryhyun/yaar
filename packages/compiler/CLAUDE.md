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
├── design-tokens.ts       # YAAR_DESIGN_TOKENS_CSS + describeDesignTokens()/…Brief() (generated token reference, two tiers)
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
│   ├── fold-schemas.ts    # Runs a defineApp app in a Worker to read Zod schemas (and the whole manifest, without `typescript`)
│   └── dedupe-schemas.ts  # Post-pass: repeated subschemas → one protocol-level `$defs` (content-neutral, idempotent)
├── bundled-types/
│   └── index.d.ts         # Type declarations for all @bundled/* imports
└── shims/
    ├── yaar/              # Main SDK, split into internal modules (index.ts is the only entry)
    │   ├── index.ts       # Barrel — the entire @bundled/yaar public surface
    │   ├── verbs.ts       # window.yaar global, read/invoke/list/describe/del/subscribe, stream, httpFetch
    │   ├── app-storage.ts # appStorage (yaar://apps/self/storage/*)
    │   ├── shared-storage.ts # sharedStorage — the commons, scoped to shared/{appId}/ (+ publish, a server-side copy)
    │   ├── app-identity.ts # setAppId/getAppId — the app's own id, recorded by defineApp for shared-storage.ts
    │   ├── app-db.ts      # appDb + CollectionHandle (yaar://apps/self/db/*)
    │   ├── dialogs.ts     # showConfirm / showPrompt (no showAlert — showToast covers it)
    │   ├── ui.ts          # showToast, onShortcut, createKeyState, withLoading, tryToast, errMsg, wait, createStaleGuard, AppCommandError, defineAppCommand
    │   ├── sanitize.ts    # sanitizeHtml — the one DOMPurify policy (defaults + no forms) — and escapeHtml
    │   ├── boundary.ts    # safeParseOr — parse untrusted JSON, log, fall back (absence stays silent; `onInvalid` replaces the log)
    │   ├── standard-schema.ts # internal: isStandardSchema + describeIssues, shared by defineApp and safeParseOr
    │   ├── files.ts       # downloadBlob, blobToDataUrl
    │   ├── format.ts      # formatBytes, formatDuration, formatClock — one rendering per value, OS-wide
    │   ├── image.ts       # toWebP — the canvas re-encode round-trip apps kept hand-rolling
    │   ├── fonts.ts       # fonts.faces/faceCss/inline — YAAR's faces, subsetted server-side into a data: URL @font-face
    │   ├── rasterize.ts   # rasterize() — DOM → SVG foreignObject → canvas, with the six quiet failures closed
    │   ├── define-app.ts  # defineApp() — registration timing, mounting, error contract, Zod params validation, keybinding dispatch, per-key describe()
    │   └── reactive.ts    # createPersistedSignal, createCollapsiblePanel, createAutosave
    ├── yaar-dev.ts        # Gated SDK: compile, typecheck, deploy, per-app git history (requires bundles: ["yaar-dev"])
    ├── yaar-web.ts        # Gated SDK: browser automation (requires bundles: ["yaar-web"])
    ├── yaar-ml.ts         # Gated SDK: in-browser model inference via onnxruntime-web (requires bundles: ["yaar-ml"])
    ├── anime.ts           # v3→v4 easing name compat wrapper
    ├── mammoth.ts         # CommonJS default-export workaround
    ├── mediabunny.ts      # re-export barrel workaround
    ├── mermaid.ts         # lazy init, token theming, forced strict mode, serialized renders
    ├── dompurify.ts       # keeps purify.es.mjs off the entrypoint slot
    ├── uuid.ts            # re-export barrel workaround
    ├── zod.ts             # re-export barrel workaround for zod/mini
    ├── lodash.ts          # re-export barrel workaround for lodash-es
    └── pixi.ts            # re-export barrel workaround for pixi.js
```

## Compilation Flow

1. **Entry:** `compileTypeScript(sandboxPath, options)` — expects `src/main.ts`
2. **Token guard:** `scanTokens()` over every `src/**/*.{ts,tsx,css}` — fails the build before bundling if any `var(--yaar-*)` can never resolve
3. **Bundle:** `Bun.build()` with 4 plugins resolves imports, transforms CSS, fixes solid-js/html closing tags, and runs the solid-html + mount guards
4. **SDK injection:** 10 iframe SDK scripts (ime-guard, capture, storage, verbs, fetch-proxy, app-protocol, contextmenu, notifications, windows, console) minified once and cached. `contextmenu` is baked rather than injected because `IframeRenderer`'s injection only reaches a same-origin frame, and an origin-isolated app is not one — without it such an app forwards none of the shell's reserved shortcuts (Shift+Tab, Ctrl+1-9, Ctrl+W)
5. **Protocol extraction:** AST parse of `export default defineApp({...})` for state/command/event descriptors → `dist/protocol.json`, then a gate that fails the build on anything unresolvable
6. **HTML wrap:** `generateHtmlWrapper()` creates self-contained HTML with design tokens CSS + SDK `<script>` + `window.__yaar_manifest__` + app `<script type="module">`
7. **Manifest:** Write `dist/.build-manifest.json` with source hash, app.json hash, compiler version

Extraction runs *after* bundling (so genuine build errors keep precedence) and *before* the
HTML wrap, because the wrapper carries the extracted manifest back into the page.

## Protocol Extraction

The manifest an agent reads is built from source at compile time, while the manifest the
app actually serves is built at runtime by the iframe SDK from the same `defineApp({...})`
config. **Those two must agree.** The failure that matters is one-sided: a command that runs
fine but never reaches `dist/protocol.json` is invisible to agents while every build signal
stays green — one real incident shrank 29 commands to 3. Hence the standing rule for this
subsystem: **refusal over omission.** Silence is the one answer it must never give.

A descriptor's optional `describe()` is the one field deliberately outside that agreement — it is
a runtime handler like `get`/`run`, answered per key on demand, so it reaches neither manifest and
the extractor skips it with the other functions.

`protocol/extract-protocol-dir.ts` is the entry point and picks between two implementations:

| | the AST reader (`extract-protocol-ast.ts` over `protocol-extractor.ts` / `protocol-module-graph.ts`) | `fold-schemas.ts` |
|---|---|---|
| When | `typescript` loads (normal builds) | a `defineApp` app whose schema is not a constant, or any `defineApp` app with no `typescript` |
| Reach | follows relative imports, `...spreads`, `const` refs, `as const` | whatever the app actually evaluates to |
| Values | constant-folds `+` concatenation anywhere, including inside `params` | `z.toJSONSchema()` of the running schema |
| Unresolvable | **hard build error with `file:line:col`** | **hard build error naming the descriptor path** |

Set `YAAR_NO_TYPESCRIPT=1` to reproduce a no-`typescript` environment on a dev machine. No shipped
configuration reaches that path: the exe embeds `typescript` (`build/exe-bundle.js`) and a repo
install gets it as a devDependency.

`app.register({...})` is **removed**, and both readers refuse it by name rather than reporting
"declares no protocol" — both raise the same `APP_REGISTER_REMOVED_MESSAGE`, so an author cannot
tell which environment answered.

Because the AST path resolves spreads, **descriptor maps may be split across files by domain** —
`commands: { ...fileCommands, ...gitCommands }` where each map lives in its own module. This is
what the extractor exists to allow; `apps/devtools/src/protocol/` is the reference case.

What it refuses, always with a location: a spread of a call result, a descriptor imported
from a package (resolution is deliberately app-local), a `${...}` template description, a
missing `description`, a method shorthand, a non-constant `params`/`schema` (outside
`defineApp`), and **two commands reachable by the same name or alias**. One bad entry
rejects the **whole** manifest — a partial manifest is the failure mode, not a consolation prize.

### Zod schemas (`protocol/fold-schemas.ts`)

`defineApp` accepts a Zod schema wherever a JSON-Schema literal goes. `z.object({...})` is a
builder chain, not a constant, so the static evaluator *defers* it — records the descriptor path
and lets the fold resolve it — rather than erroring. Deferral is sound because `defineApp`'s config
is reachable at runtime as the entry module's default export.

The fold builds the app together with a generated entry that imports `@bundled/zod`, prepends
browser-global stubs, and runs the result in a **Worker**. Three consumers, one artifact:
`dist/protocol.json` gets the folded JSON Schema; `window.__yaar_manifest__` carries the same bytes
back into the page; and the app keeps the schema object and validates each call through its
Standard Schema `~standard.validate`, so `run` receives the **parsed** value.

Without `typescript` the fold produces the whole manifest rather than just the deferred schemas,
which is what lets a `defineApp` app build at all in that environment. A `fold-schemas.test.ts`
case asserts both readers return the identical manifest for one app.

Three rules exist because breaking them produces a manifest that *disagrees with the runtime and
says nothing about it* — worse than a failed build, since every signal stays green. **The full
reasoning for each, plus why the Worker's `window`/`document` stubs are load-bearing and what
`explainImportFailure` exists to catch, is `fold-schemas.ts`'s header.**

- **Which `defineApp`.** The call must be the SDK's, and its result must be the entry module's default export. An app declaring its own `defineApp` is not matched. The mirror rule guards the removed shape: only a call whose receiver *resolves* to the SDK's `app` object is refused as a leftover registration — `Chart.register(...)` ships in a bundled app today, so the name is not the test.
- **Which wrappers are transparent.** `defineAppCommand({...})` is stepped over because the shim's is the identity function. Any callee this app *declares* must prove it — resolve to `(d) => d` or equivalent — including one named `defineAppCommand`.
- **Which bindings are readable.** `const` only, and lexical scope is honored. A `let`, a parameter, or a destructured binding is unreadable and errors rather than falling back to a same-named module binding.

### Shared subschemas (`protocol/dedupe-schemas.ts`)

The manual an agent reads has a hard ceiling nobody here controls, and most of the excess is
*restatement* — one texture-slot shape appeared 5× inside a single `setMaterial`. This pass hoists
any subschema stated twice into one protocol-level `$defs` and points at it. It runs in
`extract-protocol-dir.ts` after **both** readers, so a JSON-literal app that hand-duplicates a
shape is folded like a Zod one, and the compile and `deploy.ts`'s re-derivation cannot disagree.
Its counterpart is one option in the fold: `toJSONSchema(..., { reused: 'ref' })`.

Four rules, **each with the failure behind it in the file header**:

- **A descriptor's top-level schema is never hoisted.** The iframe bridge and `renderSignature` read `params.properties`/`required` straight off it; behind a pointer both become "declares nothing".
- **Refs are protocol-relative** (`#/$defs/name`); the manifest is the schema document.
- **Renaming and orphan-pruning read `$ref` generically**, so a pointer in an unrecognized position is never left dangling. Counting and substitution stay schema-aware.
- **Idempotent, and lossless byte-for-byte.** `resolveSchemaRefs` (exported for the tests) is the contract as code.

Names are derived from the shape because the reader is a model and the name is documentation.
Anything under ~120 bytes stays inline. **Consumers must resolve** — server-side that is
`server/src/lib/schema-refs.ts`.

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
  the *render target*, not to element lookups in general.
- **Tokens:** the known set is parsed out of `YAAR_DESIGN_TOKENS_CSS`. A token the app
  declares itself is legal, and so is `var(--yaar-x, fallback)` — a fallback is exactly
  how you opt out. Suggestions rank by *segment overlap* before edit distance.
- **Guard messages must be ASCII**: those raised from a Bun plugin pass through an error
  path that mangles non-ASCII bytes (an em dash arrives as `â`). The rule, the walk, the
  snippet, and the `path:line:col` / `problem:` / `fix:` rendering live once in
  `guards/guard-report.ts`. Each guard keeps its own headline — parameterized, not unified.

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
`new Audio()`. Covers `ASSET_MIME_TYPES`; `*.png`-style ambient declarations in
`bundled-types/index.d.ts` keep typecheck green. Written as a plugin because Bun's
`loader: { '.png': 'dataurl' }` is silently a no-op in the *programmatic* bundler (1.3.14).
Inlined bytes cost ~33%; `LARGE_BUNDLE_WARN_BYTES` (5MB) warns on the total.

**`solidHtmlSourcePlugin()`** — reads each TypeScript source once, rewrites `</${Component}>` to `</>` (closing tags cause expression index misalignment in solid-js/html), then fails the build on `html` templates that would silently drop text or throw a stackless `SyntaxError`. The fast gate intentionally recognizes the current literal `` html` `` spelling and does not trace the tag's import. `typescript` is absent in exe mode, so validation no-ops there while the rewrite still runs.

Bundled-library resolution logs are quiet by default. Set `YAAR_DEBUG_BUNDLED_LIBS=1` to print plugin initialization, resolution strategy, and resolved filesystem paths.

**`typecheckSandbox(path, { bundles })`** — runs the real TypeScript JS entry through Bun and removes ambient declarations for gated SDKs not present in `app.json` `bundles`. Compile and typecheck therefore reject the same unauthorized `@bundled/yaar-*` imports.

## Adding to the Agent-Facing Surface

Two standing bars, because everything this package exports is read by an app-authoring
agent before it is called by an app:

- **No new `@bundled/yaar` export without 3+ existing hand-rolled call sites in the app
  fleet.** `describeBundledLibrary('yaar')` already returns ~940 lines (~9k tokens) — the
  largest single describe payload — and every export lengthens the list an agent reads
  before writing a line. A helper below the bar makes the ones above it harder to find.
  The last additions cleared it by a wide margin and are the calibration to argue against:
  `safeParseOr` (82 call sites / 22 apps), `tryToast` (~50), `escapeHtml` (6, three of them
  attribute-unsafe), `downloadBlob`/`blobToDataUrl` (6 and 4), `formatBytes`/`formatDuration`/
  `formatClock` (4, 3 and 6, all rendering the same value differently).

  **Count the call sites by contract, not by shape.** The adoption pass that exercised
  those seven found the audit had overcounted wherever it matched a *shape*: `tryToast`'s
  ~50 `try/await/catch/showToast` blocks are ~38 real adoptions, because configurations
  and lab curate a short static failure message rather than surfacing `errMsg(e)`. One of
  `formatClock`'s six was a formatter with no callers. A grep tells you how many places
  have the same silhouette; only reading them tells you how many have the same contract,
  and only the second number belongs in this argument.
- **No new `BUNDLED_LIBRARIES` entry without a concrete first consumer.** Registry entries
  are prebundled into the standalone exe, so a speculative one costs artifact bytes
  permanently and narrows nothing. The reverse direction is cheap: one line plus a `.d.ts`
  block, the moment an app actually needs it.

Both exist because the surface that had to be pruned — `showAlert`, `clsx`, `konva`, `p5`,
all at zero consumers — got there through locally reasonable set-completion ("we have
confirm and prompt, so add alert") and anticipation, not through anyone deciding to add
dead weight. The bar is the cheaper check.

Two SDK exports are **frozen** rather than pruned, and should not grow without the demand
that was missing the first time: `appDb` (168 lines, 9 methods, 2 consumers — kept because
a document store is a capability, not a convenience) and `createAutosave` (a ~68-line
dirty/saveFailed/editSeq machine with 1 consumer; if a second app skips it *because* of
that weight, shrink it to what slides-lite uses rather than defending the API).

## Bundled Libraries

**`BUNDLED_LIBRARIES` in `bundled/registry.ts` is the authoritative list** — also served at
`GET /api/dev/bundled-libraries`, and linted against the docs by
`scripts/check/doc-freshness.ts`. Don't keep a copy here — the enumerated, lint-checked list for
readers is [`docs/guides/app-development.md`](../../docs/guides/app-development.md), and the root
[`CLAUDE.md`](../../CLAUDE.md#compiler--bundled-libraries) carries the category summary.

`getBundledLibraryDetail(name)` (in `bundled/describe-library.ts`) backs the agent-facing
`describeBundledLibrary`. It slices the `declare module '@bundled/<name>…'` blocks out of
`bundled-types/index.d.ts` and prepends the `Yaar*` declarations they reference, transitively —
see that file's header for why transitive resolution matters.

Two rules about `bundled-types/index.d.ts` itself:

- **In-block comments in bare `export * from 'pkg'` blocks are part of the tool's output; keep
  them accurate.** A bare re-export tells the agent nothing (it cannot open the upstream package),
  so the `solid-js` blocks name what lives in each entry point and which export to reach for —
  including that **Solid does not diff**, so `produce` (not an Immer-style copy) is the right
  store-update primitive. `@bundled/mediabunny` carries the same kind of block.
- Beyond real modules it serves **pseudo-libraries** — describable but not importable.
  `design-tokens` returns `describeDesignTokens()` generated from `YAAR_DESIGN_TOKENS_CSS`. Its
  short form, `describeDesignTokensBrief()`, is what the App Authoring Contract embeds in
  `server/agents/profiles/app-agent.ts` — so the always-on copy carries every token *name* while
  values and the long class tail stay one describe away. Both tiers come from the same parse, and
  a test asserts **both** advertise every token the guard accepts, so what the compiler *rejects*
  and what it *tells agents exists* cannot diverge in either tier.

## Shims

Shims wrap npm packages with compatibility fixes or SDK wrappers. **Every shim file carries a
header comment with its full rationale — read it before changing or removing one.** Two clusters
are worth knowing about before you add a library:

- **`shims/yaar/`** — the SDK, a thin wrapper over the `window.yaar` global. Split into internal
  modules for ownership; `index.ts` is the sole entry (`BUNDLED_SHIMS` points at it), there are no
  `@bundled/yaar/*` subpath imports, and the declared type surface stays a single
  `declare module '@bundled/yaar'` in `bundled-types/index.d.ts`. Three exports worth calling out:
  `sanitizeHtml` is the single DOMPurify policy (apps must not import `@bundled/dompurify`
  directly), `toWebP` is the canvas re-encode round-trip, and
  `defineAppCommand`/`createProtocolContext` exist for descriptors declared outside the
  `defineApp({...})` literal (see Protocol Extraction).
- **The barrel-collapse cluster** (`uuid`, `zod`, `lodash`, `pixi`, `mediabunny`, and by
  variation `mammoth` and `dompurify`) — one shared Bun defect: **a pure re-export barrel
  collapses when prebundled directly.** The build still succeeds and the breakage surfaces later
  in exe mode (mediabunny's 0.66 MB collapsed to a 5.3 KB stub that built green). Routing through
  a shim makes the package an inner module Bun materializes first. **Any new barrel library needs
  the same treatment**, and `prebundle-completeness.test.ts` catches it automatically — including
  the default-export variant, since a library's declared default is now probed.

The remaining shims (`anime`, `mermaid`, `yaar-dev`, `yaar-web`, `yaar-ml`) are per-library
adaptations; each header states its incident.

## Build Manifest & Staleness

`isAppStale(appPath)` compares current source/app.json SHA-256 hashes against `dist/.build-manifest.json`. Apps recompile only when stale or compiler version bumps (`COMPILER_VERSION`).

## Key Patterns

- **Lazy SDK caching:** SDK scripts minified on first compile, reused for all subsequent compiles
- **One read per compile:** `compileTypeScript` creates an `AppSourceCache` and threads it through the token guard, the bundler's source hook, and protocol extraction — three full reads of `src/` became one. It is scoped to the call: a cache that outlived a compile would hand `dev.ts`'s recompile the previous edit's source, green all the way
- **Refusal over omission:** protocol extraction fails the build rather than emitting a manifest it had to guess around
- **`</script` escaping:** `generateHtmlWrapper` escapes `</script` sequences in JS to prevent premature tag closing
- **Deterministic hashing:** Source hash computed from sorted file list for consistent staleness detection
- **Path normalization:** `toForwardSlash()` used throughout for Windows compatibility with Bun.build
