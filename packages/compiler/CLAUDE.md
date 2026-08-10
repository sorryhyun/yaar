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
│   ├── fold-schemas.ts    # Runs a defineApp app in a Worker to read Zod schemas (and the whole manifest, without `typescript`)
│   └── dedupe-schemas.ts  # Post-pass: repeated subschemas → one protocol-level `$defs` (content-neutral, idempotent)
├── bundled-types/
│   └── index.d.ts         # Type declarations for all @bundled/* imports
└── shims/
    ├── yaar/              # Main SDK, split into internal modules (index.ts is the only entry)
    │   ├── index.ts       # Barrel — the entire @bundled/yaar public surface
    │   ├── verbs.ts       # window.yaar global, read/invoke/list/describe/del/subscribe, stream, httpFetch
    │   ├── app-storage.ts # appStorage (yaar://apps/self/storage/*)
    │   ├── app-db.ts      # appDb + CollectionHandle (yaar://apps/self/db/*)
    │   ├── dialogs.ts     # showConfirm / showPrompt (no showAlert — showToast covers it)
    │   ├── ui.ts          # showToast, onShortcut, createKeyState, withLoading, tryToast, errMsg, wait, createStaleGuard, AppCommandError, defineAppCommand
    │   ├── sanitize.ts    # sanitizeHtml — the one DOMPurify policy (defaults + no forms) — and escapeHtml
    │   ├── boundary.ts    # safeParseOr — parse untrusted JSON, log, fall back (absence stays silent; `onInvalid` replaces the log)
    │   ├── standard-schema.ts # internal: isStandardSchema + describeIssues, shared by defineApp and safeParseOr
    │   ├── files.ts       # downloadBlob, blobToDataUrl
    │   ├── format.ts      # formatBytes, formatDuration, formatClock — one rendering per value, OS-wide
    │   ├── image.ts       # toWebP — the canvas re-encode round-trip apps kept hand-rolling
    │   ├── define-app.ts  # defineApp() — registration timing, mounting, error contract, Zod params validation, keybinding dispatch, per-key describe()
    │   └── reactive.ts    # createPersistedSignal, createCollapsiblePanel, createAutosave
    ├── yaar-dev.ts        # Gated SDK: compile, typecheck, deploy, per-app git history (requires bundles: ["yaar-dev"])
    ├── yaar-web.ts        # Gated SDK: browser automation (requires bundles: ["yaar-web"])
    ├── yaar-ml.ts         # Gated SDK: in-browser model inference via onnxruntime-web (requires bundles: ["yaar-ml"])
    ├── anime.ts           # v3→v4 easing name compat wrapper
    ├── mammoth.ts         # CommonJS default-export workaround (see below)
    ├── mediabunny.ts      # re-export barrel workaround (see below)
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

A descriptor's optional `describe()` is the one field deliberately outside that agreement. It is
a runtime handler like `get`/`run` — answered per key on demand
(`describe('yaar://windows/{id}/state/{key}')`), so it reaches neither manifest and the extractor
skips it with the other functions. A doc computed from live data on every manifest read would
make the cheapest call the most expensive.

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

That stub also makes one failure inevitable, so it is named rather than left as a stack:
`createElement` returns an inert proxy, and `@bundled/solid-js/html` compiles its template
eagerly, so an `` html`` `` evaluated at **module scope** throws on import — the author saw eight
lines of bundled Solid internals at a line in a throwaway worker bundle, naming neither Zod nor
Solid nor the stub. `explainImportFailure` tests for Solid's own `createTemplate` frame (which is
why the fold builds unminified) and puts the cause and both fixes ahead of the stack. Keep it
that narrow: an app whose *own* code calls `createElement` at module scope gets the generic
message, because this advice would not help it.

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

### Shared subschemas (`protocol/dedupe-schemas.ts`)

The manual an agent reads has a hard ceiling nobody here controls: past ~50 KB the Claude CLI
stops delivering a tool result inline and replaces it with a path on disk, which a verbs-only
monitor agent cannot open. The failure is total, not gradual. Most of the excess is
*restatement* — one texture-slot shape appeared 5× inside a single `setMaterial` and ~15×
across studio-3d's protocol — so this pass hoists any subschema stated twice into one
protocol-level `$defs` and points at it. It runs in `extract-protocol-dir.ts`, after **both**
readers, so a JSON-literal app that hand-duplicates a shape is folded like a Zod one, and the
compile and `deploy.ts`'s re-derivation cannot disagree.

Its counterpart is one option in the fold: `toJSONSchema(..., { reused: 'ref' })`, which is
zod's own within-schema dedup. Zod names its defs `__schema0` and puts them in a `$defs` local
to one descriptor — whose pointers would resolve against the wrong root once the descriptor
sits inside protocol.json — so this pass promotes and renames them. The two ship together.

Four rules, each with a failure behind it (full rationale in the file header):

- **A descriptor's top-level schema is never hoisted.** The iframe bridge rejects a bad call by
  reading `params.properties`/`params.required` straight off it, and `renderSignature` reads the
  same two. Behind a pointer both become "declares nothing" — weaker validation, no error.
- **Refs are protocol-relative** (`#/$defs/name`); the manifest is the schema document.
- **Renaming and orphan-pruning read `$ref` generically**, not through the schema-aware walk, so
  a pointer in a position this file does not recognize is never left dangling. Counting and
  substitution stay schema-aware — treating a `properties` map or an `examples` entry as a
  schema is how a dedup pass corrupts a manifest.
- **Idempotent, and lossless byte-for-byte.** `resolveSchemaRefs` (exported for the tests) is
  the contract as code: resolve every ref and the input comes back, property order included.

Names are derived from the shape (`x_y_z`, `uri_repeat_offset_etc`) because the reader is a
model and the name is documentation. Anything under ~120 bytes stays inline — a pointer costs
about what it would save. Consumers must resolve: server-side that is
`server/src/lib/schema-refs.ts`, threaded into `command-signature.ts` and into the per-command
`describe`, which attaches the defs its slice reaches so the slice stands alone.

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
  and lab curate a short static failure message (`'Failed to add'`) rather than surfacing
  `errMsg(e)`, and `tryToast` can only toast the latter — 2 of ~15 sites fit across those
  two apps. One of `formatClock`'s six was a formatter with no callers. A grep tells you
  how many places have the same silhouette; only reading them tells you how many have the
  same contract, and only the second number belongs in this argument.
- **No new `BUNDLED_LIBRARIES` entry without a concrete first consumer.** Registry entries
  are prebundled into the standalone exe, so a speculative one costs artifact bytes
  permanently and narrows nothing. The reverse direction is cheap: one line plus a `.d.ts`
  block, the moment an app actually needs it.

Both exist because the surface that had to be pruned — `showAlert`, `clsx`, `konva`, `p5`,
all at zero consumers — got there through locally reasonable set-completion ("we have
confirm and prompt, so add alert") and anticipation ("someone will draw canvas graphics"),
not through anyone deciding to add dead weight. The bar is the cheaper check.

Two SDK exports are **frozen** rather than pruned, and should not grow without the demand
that was missing the first time: `appDb` (168 lines, 9 methods, 2 consumers — kept because
a document store is a capability, not a convenience) and `createAutosave` (a ~68-line
dirty/saveFailed/editSeq machine with 1 consumer; if a second app skips it *because* of
that weight, shrink it to what slides-lite uses rather than defending the API).

## Bundled Libraries

`getBundledLibraryDetail(name)` (in `bundled/describe-library.ts`) backs the agent-facing
`describeBundledLibrary`. It slices the `declare module '@bundled/<name>…'` blocks out of
`bundled-types/index.d.ts` and prepends the `Yaar*` declarations they reference, transitively —
see `describe-library.ts`'s header comment for why transitive resolution matters.

Two rules about `bundled-types/index.d.ts` itself:

- **In-block comments in bare `export * from 'pkg'` blocks are part of the tool's output; keep
  them accurate.** A bare re-export tells the agent nothing (it cannot open the upstream package),
  so the `solid-js` blocks name what lives in each entry point and which export to reach for —
  including that **Solid does not diff**, so `produce` (not an Immer-style copy) is the right
  store-update primitive. `@bundled/mediabunny` carries the same kind of block.
- Beyond real modules it serves **pseudo-libraries** — describable but not importable.
  `design-tokens` returns `describeDesignTokens()` generated from `YAAR_DESIGN_TOKENS_CSS`; the
  same list feeds the App Authoring Contract in `server/agents/profiles/app-agent.ts`, so what the
  compiler *rejects* and what it *tells agents exists* come from one source (asserted by a test).

30+ libraries available via `@bundled/*` — no npm install needed in apps:
- **UI:** `@bundled/solid-js`, `@bundled/solid-js/web`, `@bundled/solid-js/html`, `@bundled/solid-js/store`
- **Utils:** `@bundled/uuid`, `@bundled/lodash`, `@bundled/date-fns`
- **Graphics:** `@bundled/three`, `@bundled/pixi.js`, `@bundled/cannon-es`, `@bundled/matter-js`
- **Data:** `@bundled/chart.js`, `@bundled/d3`, `@bundled/diff`, `@bundled/diff2html`, `@bundled/xlsx`, `@bundled/marked`, `@bundled/mermaid`, `@bundled/mammoth`, `@bundled/prismjs`, `@bundled/dompurify`
- **Validation:** `@bundled/zod` (Zod Mini — functional API, tree-shakeable)
- **Animation:** `@bundled/anime` (with v3 compat shim)
- **Audio:** `@bundled/tone`
- **Media files:** `@bundled/mediabunny` (read/write/convert mp4, webm, mp3, wav — the container+codec layer the browser doesn't expose; needs WebCodecs to en/decode)
- **YAAR SDKs:** `@bundled/yaar`, `@bundled/yaar-dev` (gated), `@bundled/yaar-web` (gated), `@bundled/yaar-ml` (gated — in-browser ONNX/WebGPU inference)

## Shims

Shims wrap npm packages with compatibility fixes or SDK wrappers. **Every shim file carries a
header comment with its full rationale — read it before changing or removing one.**

- **`yaar/`** — the SDK, a thin wrapper over the `window.yaar` global. Split into internal modules
  for ownership; `index.ts` is the sole entry (`BUNDLED_SHIMS` points at it), there are no
  `@bundled/yaar/*` subpath imports, and the declared type surface stays a single
  `declare module '@bundled/yaar'` in `bundled-types/index.d.ts`. The barrel is the export
  inventory; three exports worth calling out: `sanitizeHtml` is the single DOMPurify policy (apps
  must not import `@bundled/dompurify` directly), `toWebP` is the canvas re-encode round-trip
  (no `@bundled/*` package ships a WebP codec because Chromium already has one — what apps kept
  rewriting was the boilerplate around it), and `defineAppCommand`/`createProtocolContext`
  exist for descriptors declared outside the `defineApp({...})` literal (see Protocol Extraction).
- **`yaar-dev.ts`** — posts to `/api/dev/<action>` for compile/typecheck/deploy, plus per-app version history backed by a shadow git repo per app
- **`yaar-web.ts`** — posts to `/api/browser` for CDP browser automation
- **`anime.ts`** — normalizes v3 easing names (`easeOutCubic` → `outCubic`) for anime.js v4
- **`mermaid.ts`** — lazy init, serialized renders, forced `securityLevel: 'strict'` (output is
  already sanitized — do **not** pass it through `sanitizeHtml`, which strips the SVG's `<style>`
  block), suppressed error rendering, live-token theming. Each decision's incident is in the shim
  header.
- **`uuid.ts`, `zod.ts`, `lodash.ts`, `pixi.ts`, `mediabunny.ts`** — one shared Bun defect:
  **a pure re-export barrel collapses when prebundled directly** (Bun emits the `export { … }`
  list with the bindings dropped; the build still succeeds and the breakage surfaces later in exe
  mode — mediabunny's 0.66 MB collapsed to a 5.3 KB stub that built green). Routing through a shim
  makes the package an inner module Bun materializes first. Any new barrel library needs the same
  treatment, and the prebundle-completeness test catches it automatically.
- **`dompurify.ts`** — same indirection, different defect: the one library that is both a
  prebundle *entrypoint* and a *dependency* of every app compile in the same process, which Bun
  does not survive (spurious `EISDIR` on later builds; two days of CI-only failures). The shim
  demotes `purify.es.mjs` to an inner module in both builds; a `prebundle-completeness.test.ts`
  case pins the entrypoint to the shim because the failure reproduces only most of the time.
- **`mammoth.ts`** — same asymmetry as the barrels, reached through CJS interop: mammoth is
  CommonJS typed `export = mammoth`, so the default import is the *only* spelling that
  typechecks, and it is exactly the one the prebundled artifact dropped (named exports only, no
  `default`). Dev resolves the npm file and Bun synthesizes the default; the exe resolves the
  artifact and an installed app died with `No matching export in "bundled-lib:mammoth" for import
  "default"`. **A library's declared default is now probed** — the completeness test derives which
  libraries promise one from the `.d.ts` and default-imports those artifacts, because a namespace
  import never asks for `default` and so never saw this.

## Build Manifest & Staleness

`isAppStale(appPath)` compares current source/app.json SHA-256 hashes against `dist/.build-manifest.json`. Apps recompile only when stale or compiler version bumps (`COMPILER_VERSION`).

## Key Patterns

- **Lazy SDK caching:** SDK scripts minified on first compile, reused for all subsequent compiles
- **One read per compile:** `compileTypeScript` creates an `AppSourceCache` and threads it through the token guard, the bundler's source hook, and protocol extraction — three full reads of `src/` became one (80 of 134 reads avoided on `apps/devtools`). It is scoped to the call: a cache that outlived a compile would hand `dev.ts`'s recompile the previous edit's source, green all the way
- **Refusal over omission:** protocol extraction fails the build rather than emitting a manifest it had to guess around
- **`</script` escaping:** `generateHtmlWrapper` escapes `</script` sequences in JS to prevent premature tag closing
- **Deterministic hashing:** Source hash computed from sorted file list for consistent staleness detection
- **Path normalization:** `toForwardSlash()` used throughout for Windows compatibility with Bun.build
