# App Development Guide

In YAAR, you tell the AI what to build and it creates the app. TypeScript authoring, compilation, preview, and desktop deployment are all handled by the AI through the devtools app — and finished apps can be [published to the shared marketplace](#publishing-to-the-marketplace) for anyone to install.

> [한국어 버전](../ko/app-development.md)

This guide is the app **author's** manual. Three neighbours own the rest and are not restated
here: [`apps/CLAUDE.md`](../../apps/CLAUDE.md) (design tokens, Solid gotchas, links in and out of
an app), [`docs/reference/uri_reference.md`](../reference/uri_reference.md) (every `yaar://` door
and verb), and [`docs/reference/app_protocol_reference.md`](../reference/app_protocol_reference.md)
(wire shapes, postMessage frames, server internals). Build and verify commands live in the
`app-dev` skill.

## Development Flow

```
"Make me a Tetris game"

    ↓  AI opens devtools app window
    ↓  Writes code via app protocol commands
    ↓  Compiles via devtools compile command
    ↓  Previews in iframe window
    ↓  Deploys to desktop via devtools deploy command

🎮 Tetris icon appears on the desktop
```

Users don't need to write code. The AI writes TypeScript through the devtools app, compiles with Bun, previews the result, and deploys it as an app. Built apps are bundled into a single self-contained HTML file — all libraries, CSS, and code are inlined, so they can run independently in any browser with zero dependencies.

Every step is a devtools protocol command, driven with `app_command` / `app_query`:

| Step | What it does |
|---|---|
| **Write** | Creates source files — `src/main.ts` plus whatever else the app needs |
| **Compile** | Bun bundles from `src/main.ts` into one self-contained HTML file, and extracts `dist/protocol.json` from the source AST |
| **Preview** | Opens an iframe window on the compiled output |
| **Deploy** | Copies the build to `apps/{appId}/` and writes `app.json`; the icon appears on the desktop immediately |

Deploy is the step with consequences worth knowing:

- It is **destructive** — it overwrites source and deletes files no longer present — so it
  snapshots the app first ([Per-app version history](#per-app-version-history)).
- It closes any window still running the previous build, and drops the app agent's cached profile
  so its next turn is built from the new `protocol.json`. Both would otherwise keep serving the
  code the deploy just replaced. The deploying window itself is spared, so an app can deploy
  itself; the closed handles come back as `closedWindows`.
- There is no doc file for it to write. `read('yaar://apps/{appId}')` assembles the effective
  manifest at call time and `describe` assembles the manual; the `agent/prompt.md` /
  `agent/hint.md` / `agent/SKILL.md` you hand-authored are picked up from the app directory as-is
  and carried through clone and deploy.

For the full command list, `describe('yaar://apps/devtools')` — the manifest is generated from the
app's own `protocol.json`.

### Editing Existing Apps — clone → edit → compile → deploy

The AI clones an existing app's source into the devtools workspace, makes edits, recompiles, and redeploys with the same appId to overwrite in-place.

### Standalone preview — driving one app without the desktop

When you are verifying *one app* — especially over CDP, from a test, or from another
agent — the whole desktop is the wrong harness: you fight window management, you
cannot reach into a cross-origin app iframe, and the app's own automation hook is two
frames down. Open the app as a top-level page instead:

```
http://localhost:8000/api/dev/preview/{appId}
```

This serves the deployed app's `dist/index.html` with its **real iframe token injected**, so
token-gated SDK calls (`appStorage`, `appDb`, `/api/ml-weights`, the verb SDK) work exactly as
they do in a window. The identity is the app's own — permissions and `bundles` come off its
`app.json`, never from the request — so a preview cannot pass anything the deployed app would be
refused.

```js
// Anything speaking CDP: Playwright, Puppeteer, claude-in-chrome, …
navigate('http://localhost:8000/api/dev/preview/ocr');
javascript_tool("await window.__ocr.readSample()"); // the app's own automation hook
```

Notes:

- **Host-only.** The route hands out an app's token, so — like `POST /api/iframe-token` — it is
  refused to app iframes. In `REMOTE=1` the caller must already hold the remote token.
- **`localhost`, not `127.0.0.1`.** With app-origin isolation on, `127.0.0.1` *is* the app origin
  and a token-less request carrying it is refused by design. A top-level navigation there is
  redirected automatically, but a `fetch` of the preview URL is not.
- Session-scoped verbs (windows, notifications) bind to the running desktop's session when one is
  connected. With no desktop up, the app still gets its storage, its db, and its gated HTTP doors.
- The app must be **deployed** and compiled. For an uncompiled project in the devtools workspace,
  compile first — `POST /api/dev/compile` returns a `previewUrl`.

Driving either surface end to end: [`docs/guides/headless_driving.md`](./headless_driving.md).

## URI Verbs

All operations use 5 generic verbs (`read`, `list`, `invoke`, `delete`, `describe`) on `yaar://` URIs. The full door-by-door table is [`docs/reference/uri_reference.md`](../reference/uri_reference.md); what an app author needs is below.

> **Note:** `yaar://session/*` is **session-agent-only** — it is the session principal's private namespace and is not reachable by apps via `POST /api/verb`, regardless of `app.json` permissions (apps cannot self-grant it). This includes `yaar://session/browser` (the session agent's door to the user's *real* browser); apps that need browsing use `@bundled/yaar-web` → the headless sandbox instead.

### Apps — `yaar://apps/`

Four facts about this door, all detailed in
[URI Reference → Apps](../reference/uri_reference.md#apps--yaarappsappid):

- **`describe` is the manual, `read` is the current value.** `describe('yaar://apps/{appId}')`
  answers "what is this app and how do I drive it": identity, `agent/SKILL.md` when it ships one,
  permissions, and a **table of contents** for the protocol — the names of the state keys and
  commands with the URIs that serve each in full. `read` answers "what is installed here": the
  effective manifest.
- **The protocol is its own resource**, `yaar://apps/{appId}/protocol` — `list` for the index,
  `read` for the manifest, `read …/protocol/commands/{name}` for one command. It is not inlined
  into `describe`, because identity is a fixed ~10 KB while a 52-command manifest is 41.8 KB and
  growing, and past the CLI's inline-result threshold the combined answer is *gone* rather than
  merely expensive.
- **`read`'s capability fields are post-grant.** `subagents` and `streams` are the intersection of
  what `app.json` declares with what the user approved at install (`config/app-grants.json`). An
  app holding `yaar-dev` can rewrite its own manifest, so the declaration is a request and the
  grant is the ceiling.
- **`yaar://apps/{appId}/state/…` and `/commands/…` are not addressable** on any verb. Protocol
  state belongs to a running window — `yaar://windows/{windowId}/state/{key}`. `storage/`, `db/`,
  and `agents/` sub-paths keep all five verbs.

`invoke` on `yaar://apps/{appId}` takes `set_badge` (`{ count }`, `0` clears), `install`, `clone`,
`publish`, `publish_prepare`, `publish_confirm`, `publish_cancel` — see
[Publishing to the Marketplace](#publishing-to-the-marketplace). `delete` uninstalls.

### App Config — `yaar://config/app/`

| Verb | URI | Description |
|------|-----|-------------|
| `invoke` | `yaar://config/app/{appId}`, `{ config }` | Save app config/credentials |
| `read` | `yaar://config/app/{appId}` | Read app config |
| `delete` | `yaar://config/app/{appId}` | Remove app config |

### Skills — `yaar://skills/`

| Verb | URI | Description |
|------|-----|-------------|
| `list` | `yaar://skills` | List available skill topics |
| `read` | `yaar://skills/{topic}` | Load reference docs (`components`, `config`, `marketplace`, `remote`) |

## Publishing to the Marketplace

Deploy puts an app on *your* desktop. Publishing pushes it to the shared YAAR marketplace so anyone can install it. The full lifecycle is **write → compile → deploy → publish**, and installing is the mirror image on someone else's machine. The Market Apps app (🛒, `apps/market-apps`) is the front door for both directions; the AI can also drive every step through `yaar://apps/{appId}` verbs.

**Publisher identity is a Google ID token** — a JWT signed by Google that asserts your email, verified against Google's public keys. No API key, no shared secret, no device registry. Sign in from the Market Apps window; YAAR opens the system browser at Google's consent screen (PKCE over a loopback redirect to `/api/auth/google/callback`) and requests only the `openid email` scope. The **refresh token** is the only thing persisted locally (in the config dir); ID tokens live an hour and are minted on demand. The exchange is routed through the marketplace (`MARKET_URL/api/auth/exchange`) because Google's Desktop-client token endpoint requires a `client_secret` that an open-source app installed on user machines has nowhere safe to keep — YAAR does the half it can, the marketplace adds the secret, and only tokens come back. Auth routes are host/bundled-only (`http/routes/auth.ts`).

**What gets published** is a tar.gz of the app directory, entries prefixed `{appId}/` — the same shape `GET /api/apps/{id}/download` produces, so the round trip is symmetric. It excludes `dist/` (the marketplace ships *source* and YAAR compiles on install) and macOS cruft (`.DS_Store`, `._*`). Secrets aren't a concern: credentials live under `config/{appId}.json`, never inside `apps/{appId}/` (see [Credential Management](#credential-management)).

The marketplace commits the app into its own git repo, so publishing is queued rather than instant — "live in ~1 minute". The app id must match `^[a-z][a-z0-9-]*$`, and two names are reserved on top of that shape: `self` (the pronoun every app writes to address its own namespace) and anything starting with `preview--` (a devtools preview's identity). `appIdRefusal` in `packages/server/src/features/apps/roots.ts` is the one definition, checked wherever an id is claimed — deploy, install, publish.

**Bump `"version"` in `app.json` before you publish.** The marketplace refuses a version that is not strictly newer, and YAAR checks the same thing locally *before* packaging so you hear it without waiting on an upload. The check is best-effort and fail-open: an unreachable catalog or a never-published app lets the publish through, and the marketplace is the backstop.

```
// One phase — package the current on-disk state and upload it.
invoke('yaar://apps/{appId}', { action: 'publish' })
// → { published: true, appId, commit, files, message }

// Two phases — freeze the exact bytes, show the user, then upload *those* bytes.
invoke('yaar://apps/{appId}', { action: 'publish_prepare' })
// → { prepared: true, publicationId, appId, version, byteLength, artifactSha256, ... }
invoke('yaar://apps/{appId}', { action: 'publish_confirm', publicationId })
invoke('yaar://apps/{appId}', { action: 'publish_cancel', publicationId })
```

Single-phase uploads retry up to 3 times on transient upstream failures — safe because nothing is committed until the whole upload lands. Between `prepare` and `confirm`, YAAR watches for **source drift**: if `src/` or `app.json` changed, `confirm` refuses with `{ published: false, status: 'drift_detected', ... }` and lists the changed files. Re-prepare, or pass `acknowledgeDrift: true` to ship the frozen bytes anyway. Other non-fatal states (`expired`, `not_found`) come back the same structured way. Prepared publications are swept after 15 minutes. Drift is detected by content-hashing `src/` and `app.json`, not by re-tarring — the gzip stream stamps an mtime and so is never byte-identical even when nothing changed.

### Installing & uninstalling

```
invoke('yaar://http', { url: '<MARKET_URL>/api/apps' })   // browse the catalog
invoke('yaar://apps/{appId}', { action: 'install' })      // download + install
delete('yaar://apps/{appId}')                             // uninstall
list('yaar://apps')                                       // list installed
```

`<MARKET_URL>` is the marketplace origin (server env var `MARKET_URL`). `install` downloads the tarball, extracts it, and — because the marketplace ships source — compiles the app locally. Fresh installs land in the git-ignored user-apps root so they never pollute the tracked bundled tree; re-installing an app already present updates it in place. Bundled `"kind": "system"` apps can't be replaced from the marketplace. If the app declares `permissions`, the user is prompted to approve them before the install completes.

The AI reaches all of this through `read('yaar://skills/marketplace')`, which documents the live marketplace API with `MARKET_URL` substituted in.

## Bundled Libraries

Available via `@bundled/*` imports — no npm install needed. The authoritative list is `BUNDLED_LIBRARIES` in `packages/compiler/src/bundled/registry.ts`, also served at `GET /api/dev/bundled-libraries`.

| Library | Import Path | Purpose |
|---------|------------|---------|
| solid-js | `@bundled/solid-js` | Reactive UI (createSignal, createEffect, Show, For, etc.) |
| solid-js/html | `@bundled/solid-js/html` | `html` tagged templates (no JSX) |
| solid-js/web | `@bundled/solid-js/web` | `render`, DOM helpers |
| solid-js/store | `@bundled/solid-js/store` | Nested reactive stores: `createStore`, plus `produce` (mutable draft for deep updates), `reconcile` (merge fresh data while keeping row identity), `unwrap` (raw object for JSON/storage) |
| uuid | `@bundled/uuid` | ID generation |
| lodash | `@bundled/lodash` | Utilities (debounce, cloneDeep, groupBy, etc.) |
| date-fns | `@bundled/date-fns` | Date handling |
| anime.js | `@bundled/anime` | Animation |
| Three.js | `@bundled/three` | 3D graphics |
| Three.js addons | `@bundled/three/addons` | Curated `examples/jsm`: `GLTFLoader`/`GLTFExporter` (glTF + GLB — never hand-roll a reader), `OBJLoader`/`MTLLoader`/`STLLoader`/`SVGLoader`, `FontLoader` + `TextGeometry`, `OrbitControls`/`MapControls`/`PointerLockControls`/`TransformControls`, `BufferGeometryUtils`/`SkeletonUtils`. The Draco/KTX2/meshopt loaders are deliberately absent — they fetch a decoder from a path a single-file app has nowhere to serve from |
| cannon-es | `@bundled/cannon-es` | 3D physics engine |
| xlsx | `@bundled/xlsx` | Spreadsheet parsing/generation |
| Chart.js | `@bundled/chart.js` | Charts and graphs |
| D3 | `@bundled/d3` | Data visualization |
| Matter.js | `@bundled/matter-js` | 2D physics engine |
| Tone.js | `@bundled/tone` | Audio/music synthesis |
| mediabunny | `@bundled/mediabunny` | Media files: read/write/convert mp4, webm, mp3, wav. Frame-accurate encoding decoupled from real time — use it instead of `MediaRecorder` + `canvas.captureStream()`, which drops frames under load and cannot read an existing file. Needs WebCodecs; call `getFirstEncodableVideoCodec([...])` before encoding. ~0.66 MB |
| PixiJS | `@bundled/pixi.js` | 2D WebGL rendering |
| marked | `@bundled/marked` | Markdown → HTML |
| Mermaid | `@bundled/mermaid` | Text → diagrams (flowchart, sequence, class, state, ER, gantt, mindmap…). Use `renderMermaid(src)`, which themes to the design tokens and returns sanitized SVG — do not sanitize it again. ~3.3 MB, so import it only in apps that draw diagrams |
| Prism | `@bundled/prismjs` | Syntax highlighting |
| DOMPurify | `@bundled/dompurify` | HTML sanitization — call it through `sanitizeHtml` from `@bundled/yaar`, not directly |
| Zod (Mini) | `@bundled/zod` | Validating untrusted/persisted JSON at trust boundaries (functional Mini API) |
| mammoth | `@bundled/mammoth` | `.docx` → HTML |
| diff | `@bundled/diff` | Text diffing |
| diff2html | `@bundled/diff2html` | Rendered diff views |

```typescript
import { v4 as uuid } from '@bundled/uuid';
import { debounce } from '@bundled/lodash';
import anime from '@bundled/anime';
```

### Gated SDKs

Some `@bundled/*` SDKs require explicit opt-in via the `"bundles"` field in `app.json`. The compiler will reject the import if not declared.

| SDK | Import Path | Purpose | Required `bundles` value |
|-----|------------|---------|------------------------|
| Dev Tools | `@bundled/yaar-dev` | `compile()`, `typecheck()`, `deploy()`, `bundledLibraries()`, and per-app version history: `gitHistory()`, `gitDiff()`, `gitRestore()`, `gitCheckpoint()` | `"yaar-dev"` |
| Browser | `@bundled/yaar-web` | `open()`, `click()`, `type()`, `extract()`, etc. | `"yaar-web"` |
| ML runtime | `@bundled/yaar-ml` | In-browser model inference (WebGPU/wasm): `session()`, `run()`, `capabilities()`, `fetchWeights()` | `"yaar-ml"` |

See [`docs/guides/yaar_ml_runtime.md`](./yaar_ml_runtime.md) for the ML runtime's capabilities, memory limits, and "what fits" guidance.

```json
{ "bundles": ["yaar-dev"], "permissions": ["yaar://storage/", "yaar://apps/"] }
```

The base `@bundled/yaar` SDK (verbs, storage, app protocol, utilities) remains available to all apps without declaration.

### Per-app version history

Every deploy is snapshotted first. Each app gets its own shadow git repo whose **work-tree is the app directory**, which is what makes "the app boundary" a boundary git enforces rather than one we filter for. The repo metadata lives in git-ignored `storage/app-git/<appId>.git`, never inside the app: the user's own repo never sees a nested `.git` and their history is never polluted with agent commits. `dist/` and `credentials.json` are excluded.

- `gitDiff` takes two bases. `against: "snapshot"` (default) compares the app's files to a commit in its own history — *what changed since the last deploy* — and works for every app. `against: "repo"` compares against the user's own git repo, and is read-only and bundled-apps-only, since `user-apps/` is git-ignored.
- `gitRestore(appId, ref)` rolls an app back and rebuilds it. It snapshots first and appends the rollback as a new commit rather than moving `HEAD`, so history is append-only and a restore is itself undoable.
- Writing another app's directory (`deploy`, `gitRestore`, `gitCheckpoint`) is restricted to bundled apps — a marketplace app declaring `"bundles": ["yaar-dev"]` may only modify itself.

## TypeScript Notes

`apps/tsconfig.json` compiles all apps in a single program, so a `src/main.ts` with no top-level
`import` or `export` is treated as a script and its top-level names collide with every other app's.
Any app that imports from `@bundled/*` — which is every app that calls `defineApp` — is already a
module. Add `export {};` only to a file that imports nothing.

## UI Chrome & Headless Primitives

The compiler injects a `y-*` utility/chrome layer into every compiled app — colors, spacing, layout, buttons, and a **document-app chrome family** (app bar, title field, formatting toolbar, status bar). Reuse these instead of hand-writing CSS: they cost zero extra bytes (the CSS ships with every app regardless), recolor with the theme, and are advertised to app agents automatically. **Never hardcode colors** — always use `var(--yaar-*)`. The class list is in [`apps/CLAUDE.md`](../../apps/CLAUDE.md#design-tokens); the chrome-vs-content rules and the exception registry are in [`docs/architecture/design_system.md`](../architecture/design_system.md).

### Document-app skeleton

Word-, slides-, and file-style apps share the same surface: an identity bar, an inline-editable title, a formatting toolbar, and a save-status chip. Paste this skeleton and fill in your own brand and buttons — the classes carry all the styling:

```typescript
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';

render(() => html`
  <div class="y-app">
    <!-- Identity bar: brand + title field + primary actions -->
    <div class="y-appbar">
      <div class="y-brand">
        <span class="y-brand-badge">W</span>
        <span class="y-brand-name">My App</span>
      </div>
      <div class="y-doc-field">
        <input class="y-doc-input" type="text" placeholder="Untitled" />
      </div>
      <div class="y-appbar-actions">
        <button class="y-tbtn y-tbtn-text y-tbtn-primary" title="Save (Ctrl+S)">Save</button>
      </div>
    </div>

    <!-- Formatting toolbar: groups (y-tgroup) separated by y-tsep -->
    <div class="y-editbar">
      <div class="y-tgroup">
        <select class="y-tselect" title="Style">
          <option>Paragraph</option>
        </select>
      </div>
      <div class="y-tsep"></div>
      <div class="y-tgroup">
        <button class="y-tbtn" title="Bold">B</button>
        <button class="y-tbtn y-tbtn-active" title="Italic">I</button>
      </div>
    </div>

    <!-- Your content region here -->
    <div class="y-scroll" style="position:absolute; inset:0; top:auto"></div>

    <!-- Status bar: stats on the left, a save-status chip on the right -->
    <div class="y-statusbar">
      <span>0 words</span>
      <span class="y-chip y-chip-muted">Saved</span>
    </div>
  </div>
`, document.getElementById('app')!);
```

Chrome classes: `y-appbar` / `y-appbar-actions`, `y-brand` / `-badge` / `-name`, `y-doc-field` / `y-doc-icon` / `y-doc-input`, `y-editbar`, `y-tgroup` / `y-tsep`, `y-tbtn` (`-text` / `-primary` / `-active`), `y-tlabel`, `y-tselect`, `y-statusbar`, `y-chip` (`-warning` / `-muted`). A collapsible sidebar/overlay uses the `y-nav-*` family (`y-nav-root`, `y-nav-panel`, `y-nav-hover-zone`, `y-nav-pin`, `y-nav-resizer`, …). The skeleton is intentionally a **snippet, not a component** — the chrome you copy is short and yours to edit.

### Headless behavior primitives

State machines that apps kept re-implementing live in `@bundled/yaar` as **headless** primitives — they return state and handlers, and your app owns the markup. All are tree-shaken, so apps that don't import them pay nothing.

| Primitive | What it owns |
|---|---|
| `createCollapsiblePanel({ pinKey, closeDelayMs })` | Hover-expand + pin sidebar. `expanded()`, `pinned()`, `open()`, `scheduleClose()`, `close()`, `cancelClose()`, `togglePin()`, `setPin(v)`, `setResizing(active)`. Pin state persists when `pinKey` is given. Two predicates cover reasons the panel doesn't own: `canOpen` is consulted by `open()` (return `false` while a drag from elsewhere sweeps the rail), `holdOpen` when the fold *fires* (return `true` while a field inside has focus, then `scheduleClose()` on blur) |
| `createAutosave(save, { debounceMs })` | Dirty / debounced-save / status lifecycle. `save` returns `true` on success — `false` keeps the doc dirty. An `editSeq` guard means a save that started before the latest edit never clears the dirty flag. `markDirty(value)` on input, `flush(true)` on Ctrl+S, `statusLabel()` → `"Saving…"` \| `"Saved 14:22"` \| `"Not saved"` for a `y-chip` |
| `createPersistedSignal(path, fallback, opts?)` | A Solid signal auto-synced to `appStorage` through `trySave`. Lighter than `createAutosave` when there is no save-status to show |
| `createStaleGuard()` | The generation counter that keeps a slow response from overwriting a newer one |
| `createKeyState(opts?)` | Held-key tracking for a game loop — the continuous-input counterpart to declarative `keybindings` |

```typescript
import { createStaleGuard, createKeyState } from '@bundled/yaar';

const guard = createStaleGuard();
async function loadPost(id: string) {
  const fresh = guard.begin();   // supersedes anything already in flight
  const post = await fetchPost(id);
  if (!fresh()) return;          // a newer load started; drop this response
  setState('post', post);
}
// guard.latest() joins the current generation without superseding it;
// guard.invalidate() bumps with no fetch attached, dropping everything in flight.

const keys = createKeyState({ preventDefault: ['arrowup', 'arrowdown', ' '] });
function frame(dt: number) {
  if (keys.has('w') || keys.has('arrowup')) player.y -= speed * dt;   // layout-typed key
  if (keys.has('KeyD')) player.x += speed * dt;                        // physical key
}
```

`createKeyState` gets the fiddly parts right by default: OS auto-repeat is ignored, held state clears on window blur and tab-hide (alt-tabbing with `w` held must not leave the player running), releases are keyed by `e.code` so a modifier changing `e.key` mid-hold (Alt+W reports `∑` on macOS) can never stick a key, and presses landing in an editable element are skipped (`ignoreEditable: false` opts out). `keys.dispose()` from `onClose`. Rule of thumb: discrete action (pause, rotate) → declarative `keybindings`; continuous movement → `createKeyState` in your `requestAnimationFrame` loop.

Three things about `createPersistedSignal` that have each cost a bug:

- **`revive` runs before the value reaches the signal** — the place to clamp a stored width, migrate a renamed key, or `z.safeParse` JSON an older version wrote. It also runs on the **fallback** when nothing is stored, so keep it total; if it throws, the fallback is used and the failure is logged.
- **Await the third element before a one-shot side effect.** The signal starts at the fallback and updates when the load lands — invisible for a value that is only *rendered*, and not invisible for a value that decides something done once. `await readyPromise` resolves with the value the signal then holds; it never rejects, and a set that landed before the load still wins.

  ```typescript
  const [conceptMode, setConceptMode, conceptModeReady] = createPersistedSignal(
    'preferences/concept-mode.json', false,
  );
  onMount(async () => {
    await conceptModeReady;      // otherwise the first fetch always sees `false`
    void loadFeed(conceptMode());
  });
  ```

- **Pass `debounceMs` when it is bound to a text input.** It writes on every set, which is right for the toggle it usually holds. An `onInput` handler fires per keystroke — per composition step under an IME — so a five-letter Korean name was a dozen writes and a dozen session-log lines for one field. `debounceMs: 400` collapses the burst; a pending write is flushed when the page is hidden, so closing mid-debounce still saves. The signal itself is never delayed, only the write.

## Runtime Constraints

Compiled apps run in a **browser iframe sandbox**. They are subject to these hard constraints:

- **No Node.js APIs** — No `fs`, `process`, `child_process`, `net`, etc. This is a browser environment.
- **No server processes** — Apps cannot listen on ports, spawn servers, or run background daemons.
- **No OAuth flows** — OAuth code-for-token exchange requires a server-side `client_secret`. Iframe apps cannot safely perform this. Use the API-based app pattern instead (see below).
- **Cross-origin HTTP goes through the proxy** — Use `httpFetch` from `@bundled/yaar` and declare `yaar://http` in `app.json`. See [Making HTTP Requests](#making-http-requests).
- **No localStorage/IndexedDB** — Use `appStorage` from `@bundled/yaar` for persistence (server-side, survives across sessions).
- **Self-contained** — Apps must not depend on external servers, localhost services, or infrastructure outside the iframe.

## Rendering Untrusted HTML

Any HTML an app did not author itself — a Markdown file from storage, a scraped page, an
RSS feed body, a GitHub README, content round-tripped through `appStorage` — must pass
through **`sanitizeHtml` from `@bundled/yaar`** before it reaches the DOM. Apps run in an
iframe, but that iframe holds the app's own storage, credentials, and protocol channel to
its agent; an injected script owns all of it.

Every rich-content pipeline follows this order:

1. parse the Markdown or source content;
2. **sanitize the complete fragment**;
3. perform app-specific DOM rewrites on the sanitized fragment;
4. insert the result;
5. attach behavior with event listeners — never inline event attributes.

```typescript
import { sanitizeHtml } from '@bundled/yaar';

const clean = sanitizeHtml(marked.parse(source) as string);
const doc = new DOMParser().parseFromString(clean, 'text/html');
rewriteRelativeLinks(doc);       // app logic, on already-safe HTML
el.innerHTML = doc.body.innerHTML;
attachImageFallbacks(el);        // addEventListener, after insertion
```

Steps 2 and 3 are in that order for a reason. Sanitizing first means no unsafe source attribute survives into your rewriting pass; rewriting after means the app can mint known-safe URLs and attributes without weakening the default policy. Reversing them hands your rewriter attacker-controlled input. Step 5 matters just as much: DOMPurify strips `onerror`/`onload`/`onclick` unconditionally, so a generated `img.setAttribute('onerror', …)` fallback silently stops working once you add the sanitizer — register a real `addEventListener('error', handler, { once: true })` on the inserted node instead.

Sanitize at one choke point per pipeline, ideally where foreign content first enters app state, so every downstream sink is safe by construction. Two overlapping policies are worse than one: the next editor will weaken one assuming the other covers it.

`sanitizeHtml(dirty)` with no options is the default policy — DOMPurify's own defaults (which already strip scripts, event handlers, and `javascript:`/`data:` URLs) plus the one deviation every YAAR app makes: `form` and its controls are forbidden. They are on DOMPurify's default `ALLOWED_TAGS`, which is right for a general-purpose sanitizer and wrong for an app iframe, where no foreign content has a legitimate reason to post and a form can navigate the frame or phish against the app's chrome. Pass an options object (`allowedTags`, `allowedAttr`, `forbidTags`, `forbidAttr`) only when the content type genuinely needs a different allowlist — a printable document needs inline `style` that prose rendering does not — and comment the reasoning next to it. The no-forms correction applies to DOMPurify's *default* allowlist; once you pass `allowedTags`, your list is the whole policy and nothing is subtracted behind your back.

Do not call `@bundled/dompurify` directly, and do not hand-roll a sanitizer — element denylists plus `^on` attribute stripping miss `<svg>`/`<math>` mutation-XSS, `srcset`, `formaction`, and `xlink:href`. Three more edges:

- **Relative URLs survive verbatim** — `sanitizeHtml` neither strips nor absolutizes them, so an app that needs them resolved rewrites the *sanitized* output, per step 3. A **link** href is the exception: declare `"links": { "base": "https://origin.example" }` in `app.json` and the link guard resolves anchors against that site when clicked. It governs clicks only — an `<img src>` still has to be rewritten. See [`apps/CLAUDE.md`](../../apps/CLAUDE.md#links-out-of-an-app).
- **`USE_PROFILES` overrides `ALLOWED_TAGS`; it does not intersect with it.** Adding `USE_PROFILES: { html: true }` to a config that already has an explicit `ALLOWED_TAGS` *replaces* your list with DOMPurify's much broader HTML profile — a policy that looks strictly tighter can silently start passing `<form action="//evil">`.
- **Test sanitizers against jsdom or a real browser, never happy-dom.** DOMPurify checks `isSupported` and silently becomes a no-op when the host DOM is too incomplete, so under happy-dom a `javascript:` href sails through while happy-dom's own parser drops benign `<table>`/`<pre>` wrappers — false passes and false failures in one green run. Assert on what must *not* survive (`<script>`, `<iframe>`, `<object>`, `<form>`, SVG-wrapped script, `javascript:` URLs, inline `on*=`) **and** on what must (tables, code blocks, images, links); a sanitizer that strips everything passes the first half perfectly.

### Interpolating text, not markup

`sanitizeHtml` cleans markup you mean to *render*. Text you mean to *show* — a commit
message, a filename, a search query dropped into a template literal — needs `escapeHtml`
from the same module:

```typescript
import { escapeHtml } from '@bundled/yaar';

el.innerHTML = `<li title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</li>`;
```

It always covers `& < > " '`. Three of the six apps that hand-rolled this escaped only `& < >` — safe in a text node, and not in `title="${…}"`, where a lone `"` ends the attribute and everything after it is markup. Which context a call site sits in is exactly what changes when someone edits the template, so there is no cheaper variant worth keeping. Escaping for an XML *document* is a different grammar (`&apos;` rather than `&#39;`); a DOCX or SVG serializer keeps its own.

## Making HTTP Requests

Use `httpFetch` from `@bundled/yaar`, and declare `yaar://http` in `app.json`. Without the permission, cross-origin requests are refused with a 403 (both `"yaar://http"` and `"yaar://http/"` work).

```typescript
import { httpFetch } from '@bundled/yaar';

const res = await httpFetch('https://api.example.com/items?page=2');
if (!res.ok) throw new Error(`Request failed: ${res.status}`);
const items = await res.json();
```

It is `fetch`. You get a standard `Response` — `json()`, `text()`, `blob()`, `arrayBuffer()`, and real `Headers` (so upstream rate-limit and session headers stay readable). Binary bodies survive intact.

| | Cross-origin | Same-origin / relative |
|---|---|---|
| Route | YAAR's server-side proxy | direct, with the iframe token |
| CORS | not applicable — the server makes the call | normal browser rules |
| Requires `yaar://http` | yes | no |
| Cookies | jar scoped to (session, app) | the iframe's own |

Cross-origin requests are also subject to SSRF validation, the domain allowlist (the user is prompted once per new domain), a 10 MB response cap, and a 30-second timeout. `redirect: 'manual'` is honored; `redirect: 'error'` is not representable and falls back to `'follow'`.

**Prefer `httpFetch` over `invoke('yaar://http', …)`.** The verb form returns YAAR's internal envelope rather than a `Response`, so hand-rolling a type around it re-types an internal contract you don't own. Keep the verb form for agent-side code, where there is no `window.fetch` to patch.

**If your app has a login, clear the cookie jar on logout.** Proxy cookies live server-side, keyed by (session, app), and nothing else clears them until the iframe token expires — so clearing your own stored session only makes the app *look* logged out while later requests keep carrying the upstream session. `await del('yaar://http')` clears only the calling app's jar; the key comes from your own token, never from a payload, so one app cannot log another out.

Service-specific concerns — pagination, rate limiting, JSON-RPC framing, auth refresh — stay in your app. `httpFetch` normalizes transport only.

## Anti-Patterns

Common mistakes to avoid when building apps:

- **Don't build OAuth clients as compiled apps** — token exchange needs a server-side `client_secret`. Build an API-based app instead, with a user-provided personal access token stored via `invoke('yaar://config/app/{appId}', { config })`.
- **Don't assume external servers are running** — there is no backend at `localhost:3000` or any other port, and no hardcoded localhost URL survives being served from another host.
- **Don't hand-roll the proxy response envelope** — use `httpFetch`. See [Making HTTP Requests](#making-http-requests).
- **Don't swallow a failed save** — `catch { /* ignore */ }` around `appStorage.save()` makes data loss invisible while the UI says "Saved". See [Never swallow a failed save](#never-swallow-a-failed-save).
- **Don't duck-type JSON you read back** — a broken app then renders as a fresh one. See [Never trust a read either](#never-trust-a-read-either--validate-at-the-boundary).
- **Don't put unsanitized HTML in `innerHTML`, and don't hand-roll a sanitizer** — see [Rendering Untrusted HTML](#rendering-untrusted-html).
- **Don't generate inline event attributes** — `setAttribute('onerror', …)` is stripped by any sanitizer, so the behavior disappears the moment the pipeline is secured. Use `addEventListener` on the inserted node.
- **Don't re-implement SDK helpers** — the `@bundled/yaar` surface is listed under [SDK helpers](#sdk-helpers); `debounce`/`throttle` come from `@bundled/lodash`. In particular, don't hand-roll a canvas re-encode (`toWebP`), a DOM → image pipeline (`rasterize`), or font subsetting (`fonts.inline`) — each is a short call wrapping several silent failure modes.
- **Never use native `alert()` / `confirm()` / `prompt()`** — they block the page and any agent driving it. See [Dialog helpers](#dialog-helpers).

### Right Pattern for External Service Integration

```
Option A: API-based app (preferred for API wrappers)
  apps/recent-papers/agent/prompt.md → describes the arXiv API, query flow
  User provides an API key → stored via invoke('yaar://config/app/{appId}', { config })
  AI calls the service API via invoke('yaar://http', ...) → renders in windows

Option B: Compiled app + AI-mediated API (for rich UI)
  Compiled iframe app handles UI/display only
  AI agent handles external API calls via MCP tools
  App Protocol bridges the two:
    invoke(uri, { action: 'app_query' }) → display data from AI to app
    invoke(uri, { action: 'app_command' }) → user actions from app to AI
```

## Agent Prompt Customization

Each app gets its own **app agent** when a user interacts with it. Three files in the app's directory feed three different readers at three different moments:

| File | Role | When to use |
|------|------|-------------|
| `agent/prompt.md` | **Replaces** the generic base prompt entirely | Apps needing precise agent behavior (e.g., devtools IDE) |
| `agent/hint.md` | Injected into the **monitor agent's** system prompt | Routing hints so the orchestrator knows when/how to use the app |
| `agent/SKILL.md` | Returned by `describe('yaar://apps/{appId}')` | The manual for *whoever asks* — workflows and ordering constraints the protocol can't state |

Only the first two are injected into a prompt; `SKILL.md` is read on demand or not at all. There is no append tier — **one file, one meaning.**

Either way the `protocol.json` manifest is appended: state keys as a name + description list, and each command as a call signature built from its `params` schema — `readFile(path: string|string[], startLine?: number, …)`, with `?` on optional params and enums spelled out. That section is appended regardless of which prompt a turn uses, so **neither prompt needs to restate a command's params** — one that does will drift from the schema the app validates against. `describe()` still returns the full schema when per-param descriptions matter.

All three paths are configurable in `app.json` — `"agent": { "prompt": "agent/prompt.md", "hint": "agent/hint.md", "skill": "agent/SKILL.md" }` — but those are the *defaults*, so most apps never set the field. An absolute or traversing override is ignored in favor of the default: `app.json` is writable by any app holding `yaar-dev`, and these paths become file reads. A missing `agent/hint.md` falls back to a legacy root `HINT.md` with an `[apps]` warning naming the new path; root `AGENTS.md` has no such fallback, deliberately (see below).

### agent/hint.md (orchestrator context)

Injected into the **monitor (orchestrator) agent's** system prompt: it tells the orchestrator when to route tasks to the app. Hints auto-sync with installed apps — uninstalling the app removes the hint. Use it for app-dependent orchestration guidance that would otherwise go stale in a static system prompt:

```markdown
Use the devtools app for all app development tasks. The devtools app agent
is a specialist with direct access to the project filesystem, compiler,
and type checker.
```

### agent/prompt.md (full control)

The app agent's entire system prompt is replaced with this file. Use it when the agent needs a specific workflow (devtools: typecheck → compile → deploy), when you want to state anti-patterns and domain rules, or when the generic prompt's behavior guidelines don't fit. Since it replaces the base prompt, you must document the available tools (`describe`, `query`, `command`, `relay`) yourself. (`protocol.json`, and a "Controllable Apps" section when `controls` is set, are still appended automatically.)

### agent/SKILL.md (the manual anyone can ask for)

`describe('yaar://apps/{appId}')` returns identity, `SKILL.md`, and the protocol's table of contents. Write in `SKILL.md` only what a generated protocol cannot say: the order commands must run in, the workflow that ties three of them together, when *not* to reach for this app.

Never restate a command or state name as a heading or a bullet subject — the protocol is served from `yaar://apps/{appId}/protocol` and regenerated on every deploy, so a restatement is a sentence that will disagree with the schema next to it. `bun run check:apps` warns on it (`skill-restates-protocol`, advisory — a name inside a workflow sentence like "run `compile` before `deploy`" is exactly what the file is for, so the check names what it matched and lets you judge).

### AGENTS.md (the coding agent's doc)

`AGENTS.md` at the app's root is a different file with a different reader: it's the conventional name a coding agent looks for when *editing* a directory, and devtools is that agent. YAAR reads it for nothing. Put in it what the source cannot say for itself — architecture, invariants, why a thing is hand-rolled, what breaks if you change it. An app of any size wants one; small apps don't need it. [`apps/devtools/AGENTS.md`](../../apps/devtools/AGENTS.md) is the worked example.

The line between it and `agent/prompt.md` is the reader, not the topic. "`src/gizmo.ts` is hand-rolled because the bundled one drops pointer capture" is `AGENTS.md`. "call `addPrimitive` with `{ kind: 'box' }` before setting a material" is `agent/prompt.md`. Never restate a command signature in either. An app that ships `AGENTS.md` hoping it is a prompt gets the generic base plus its manifest, and an `[apps]` notice saying to copy it to `agent/prompt.md` if that is what it meant.

Clone and deploy carry it like any other source file, so it round-trips: an app you clone into devtools arrives with its `AGENTS.md`, and one you write there survives the deploy.

### Example structure

```
apps/my-app/
├── AGENTS.md        # (Optional) instructions for a coding agent editing this app — never read at runtime
├── agent/
│   ├── prompt.md    # Full custom agent prompt (optional, advanced)
│   ├── hint.md      # Monitor agent routing hint (optional)
│   └── SKILL.md     # Manual returned by describe('yaar://apps/my-app') (optional)
├── app.json         # Metadata, permissions, protocol manifest
├── index.html       # Compiled app (if compiled)
└── src/             # Source code (if compiled)
```

## `app.json` Reference

**Source:** `packages/server/src/features/apps/discovery.ts`

The app's **id is its folder name**. `app.json` is parsed leniently — unknown fields and wrong-typed values are silently ignored, so a typo fails quietly.

| Field | Type | Purpose |
|-------|------|---------|
| `name` | `string` | Display name |
| `icon` | `string` | Emoji. An `icon.{png,jpg,svg,…}` file in the app folder overrides it |
| `description` | `string` | Shown in launchers; also given to the agent |
| `version` | `string` | Bumped before every publish — the marketplace refuses a version that isn't newer |
| `author` | `string` | Informational |
| `run` | `string` | Iframe entry — `dist/index.html`, or a `yaar://apps/{id}/…` URI |
| `kind` | `"system"` | Marks a protected/auto-trusted app. **Bundled apps only** — ignored for installed apps |
| `createShortcut` | `boolean` | `false` hides the app from the launcher (`"hidden": true` is a synonym) |
| `permissions` | `(string \| { uri, verbs? })[]` | Pre-granted URI permissions, e.g. `"yaar://storage/"` or `{ "uri": "yaar://http", "verbs": ["read"] }` |
| `bundles` | `string[]` | Opt in to gated SDKs (`yaar-dev`, `yaar-web`, `yaar-ml`). The compiler rejects the import without it |
| `agentType` | `string` | Override the agent profile used for this app's agent |
| `agent` | `{ prompt?, hint?, skill? }` | Override the default paths for this app's agent docs |
| `links` | `{ base }` | The site relative hrefs in this app's rendered content belong to — the link guard resolves anchors against it. See [`apps/CLAUDE.md`](../../apps/CLAUDE.md#links-out-of-an-app) |
| `messaging` | `"all"` | Lets the app agent `direct_message` other apps/windows, not just monitor/user |
| `controls` | `(string \| { appId, commands?, background? })[]` | Other apps this app may drive. A target with no window on the caller's monitor gets one opened; `background: true` opens it minimized. **Bundled apps only** |
| `streams` | `string[]` | Streamable sources this app may subscribe to (`"agents"`). **Approved at install** |
| `subagents` | `{ max: number }` | Ceiling on [sub-agents](#sub-agents-personas) this app may spawn per monitor. Clamped to 16; a non-integer or `≤ 0` reads as "none". **Approved at install** |
| `variant` | `"widget" \| "panel"` | Window variant |
| `dockEdge` | `"top" \| "bottom"` | Dock the window to a screen edge |
| `frameless` | `boolean` | Drop the window chrome |
| `windowStyle` | `object` | CSS overrides applied to the window |
| `defaultWidth` / `defaultHeight` | `number` | Initial window size in px |

One gotcha that falls out of that leniency: the folder name is always the id, and there is no `id`/`appId` field here. The `id` passed to `defineApp()` in your source is a separate thing, *is* used, and must match the folder.

## App Types

### Compiled Apps

Built by the AI: write → compile → deploy. Runs in an iframe.

```
apps/falling-blocks/
├── agent/
│   └── prompt.md    # Optional — only if the app needs the agent to know more than its manifest
├── app.json         # { "icon": "🎮", "name": "Falling Blocks" }
├── index.html       # Compiled single HTML
└── src/             # Source code
    ├── main.ts
    └── styles.css
```

### API-based Apps

Apps that call external APIs: no compiled source, just `app.json` and an `agent/prompt.md` describing the endpoints, auth flow, and workflows. List APIs like `POST /api/v1/posts`, `GET /feed`; when a user says "show my feed", the AI calls the API and renders results in a window.

```
apps/moltbook/
├── app.json
└── agent/
    └── prompt.md    # API endpoints, auth flow, workflows
```

### Manual prompt-only Apps

The same shape, written by hand rather than generated — `app.json` plus `agent/prompt.md` in `apps/`, no source at all.

## App Protocol

Compiled apps can communicate bidirectionally with AI agents via the **App Protocol**. Apps declare their capabilities (state queries, commands) in a manifest, and the agent discovers them at runtime to read state or execute commands.

```
Agent → MCP tool → WebSocket → postMessage → Iframe App
Iframe App → postMessage → WebSocket → MCP tool returns
```

### Registering in Your App — `defineApp()`

`src/main.ts` ends in exactly one `export default defineApp({...})`. That call is the app:
it registers the protocol (once, at module scope, before the view mounts), mounts the view,
and normalizes whatever a command throws into an `AppCommandError`. An app never calls
`render()` itself.

```typescript
// src/store.ts
import { createSignal } from '@bundled/solid-js';
export const [items, setItems] = createSignal<string[]>([]);

// src/main.ts
import { defineApp } from '@bundled/yaar';
import * as z from '@bundled/zod';
import { items, setItems } from './store';
import { App } from './app';

export default defineApp({
  id: 'my-app',            // must equal the app's folder name — the build checks
  name: 'My App',
  state: {
    items: {
      description: 'Current list of items',
      get: () => [...items()],          // read signal, return copy
    },
  },
  commands: {
    addItem: {
      description: 'Add an item',
      params: z.object({ text: z.string() }),
      replay: 'never',                  // appends — don't re-run it on iframe remount
      run: (p) => {                     // p is typed { text: string }, already validated
        setItems([...items(), p.text]); // immutable signal write, no render() needed
        return { ok: true };
      },
    },
  },
  view: App,               // Solid component — or { mount(el) } for an imperative app
});
```

- **`state.get` / `commands.run`** are the handlers; everything else (`description`,
  `params`, `returns`, `aliases`, `events`, `onClose`, `onCapture`) keeps its name.
- **Schemas.** `params`/`returns`/`schema` take a Zod schema (`@bundled/zod`, the Zod Mini
  functional API) or a plain JSON Schema literal. Zod is preferred and is the single source
  of truth: it types `run`'s parameter, validates the call *before* `run` sees it — including
  the declared types, which the raw bridge never checked — and folds into
  `dist/protocol.json` at build time via `z.toJSONSchema()`. `run` receives the parsed value,
  so defaults and coercions have already been applied.
- **`describe`.** Any `state` or `commands` entry may carry an optional `describe()` returning a
  string, answered only when something asks for it —
  `describe('yaar://windows/{id}/state/{key}')`. Use it for what the static `description`
  cannot say because it changes: `describe: () => \`${rows().length} rows; a row is { id, title,
  done }\``. It never rides in the manifest, so the cheap call stays cheap.
- **`replay`.** The server re-sends recorded commands when a window's iframe remounts.
  Declare `replay: 'never'` on any command whose effect must not be applied twice (appends,
  sends, deletes); omit it for idempotent ones.
- **`view`.** A Solid component is mounted with `render`; an imperative app that owns its own
  DOM passes `{ mount(el) { ... } }` and may return a teardown, which runs on window close
  after `onClose`.
- **`keybindings`.** Declarative keyboard shortcuts mapping a combo to a declared command
  name: `keybindings: { ArrowRight: 'nextPage', 'Ctrl+s': 'save' }`. The grammar is
  `[Ctrl+][Meta+][Alt+][Shift+]Key` with `KeyboardEvent.key` names, case-insensitive; `Ctrl`
  also matches `Cmd`. The bound command runs with no params, so its `params` must be absent or
  all-optional. Dispatch happens inside the iframe while the window has focus; combos without
  Ctrl/Meta/Alt are suppressed when an editable element has focus, so a bare `ArrowRight` never
  steals cursor movement from an input. The build rejects a binding to an undeclared command, an
  unparseable combo, two spellings of one chord, and the shell's reserved combos (`Shift+Tab`,
  `Ctrl+1-9`, `Ctrl+W`, `Ctrl+R`, `F5`). Bindings appear in the manifest, so agents can tell
  users about them — and the shell reads them back: an app that binds the `w` key at all keeps
  its window when the user presses Ctrl+W, which otherwise closes the topmost one. For a shortcut that needs an argument, use the imperative
  `onShortcut(combo, handler)` from `@bundled/yaar`; for held-key movement, `createKeyState`.
- **Splitting up.** `state`/`commands` maps may live in other modules and be spread in — see
  [Splitting a protocol by domain](#splitting-a-protocol-by-domain). The `export default`
  itself must stay in `src/main.ts`: that is what the build reads back to fold Zod schemas.

`defineApp` is the only way to register: the iframe SDK's registration entry is private and this is its one caller. A second `defineApp()` in the same window throws rather than silently overwriting the first. The former low-level `app.register()` is removed, and a leftover call fails the build with the migration in the message.

### `defineAppCommand` — infer `run`'s params from the schema

A command declares its parameter shape twice: once as the `params` schema the agent reads,
once as `run`'s TypeScript type. Inside a `defineApp({...})` literal the two are already tied
together — `defineApp` derives each `run`'s parameter from the `params` written at that call
site, so `p.txt` against a schema that says `text` is a compile error.

`defineAppCommand` restores that for a command declared *outside* the literal:

```typescript
// src/protocol/items.ts
import { defineAppCommand } from '@bundled/yaar';
import * as z from '@bundled/zod';

export const itemCommands = {
  addItem: defineAppCommand({
    description: 'Add an item',
    params: z.object({ text: z.string() }),
    run: (p) => setItems([...items(), p.txt]),
    //                                   ^^^ compile error: did you mean 'text'?
  }),
};
```

It is a runtime no-op — an identity function — so `dist/protocol.json` and everything the agent sees are unchanged. It exists purely to make the compiler check `run`.

It accepts a Zod schema (preferred — it also validates the call) or a JSON Schema literal. From JSON Schema it infers `enum`, the scalar types, `array` + `items`, and `object` + `properties`/`required`, nested arbitrarily; keys absent from `required` infer optional, and an `object` with only `additionalProperties` infers a `Record`. `anyOf`, `oneOf`, `$ref` and other keywords infer as `unknown` — annotate that parameter explicitly, or leave the command as a plain object literal, which reaches the manifest identically.

Keep the call shape literal — `defineAppCommand({ ... })` wrapping an inline object. The build-time protocol extractor is a source parser, not an evaluator: it steps over a single identifier call to find the descriptor, and a computed callee fails the build.

#### Splitting a protocol by domain

A `commands` or `state` map may be assembled from descriptor maps that live in other files.
The extractor follows relative imports and spreads, so this reaches `dist/protocol.json`
intact:

```typescript
// src/commands/files.ts
export const fileCommands = {
  readFile: { description: 'Read a file', params: { ... }, run: (p: { path: string }) => ... },
};

// src/main.ts
import { fileCommands } from './commands/files';
import { gitCommands } from './commands/git';

export default defineApp({
  id: 'devtools',
  name: 'DevTools',
  commands: { ...fileCommands, ...gitCommands },
  view: App,
});
```

One inference caveat, and it is silent: a command spread in from another module is extracted into the manifest exactly as an inline one, but its `run` parameter widens to a free-form bag — no error, just weaker types. Wrap those descriptors in `defineAppCommand`, annotate the parameters yourself, or keep the commands you want inference for inline.

The limit is static resolvability, and it is enforced rather than tolerated: a spread of a **call result** (`...buildCommands()`), a descriptor imported from an npm package, a `${...}` template description, or a missing `description` fails the compile with a `file:line:col`. That is deliberate — a command the extractor skipped would still work at runtime while being invisible to every agent, which is the one outcome worse than a broken build.

#### When handlers need a runtime context

Static resolvability and a per-registration context pull in opposite directions: descriptor
maps must be top-level `const`s, so they cannot close over a factory parameter, and hoisting
them into `buildCommands(ctx)` produces exactly the call result the extractor refuses.
`createProtocolContext` is the seam — the descriptors stay static, the context is installed at
registration time, and handlers reach it through the accessor:

```typescript
// src/protocol/context.ts
import { createProtocolContext } from '@bundled/yaar';

export const { set: setProtocolContext, get: ctx } =
  createProtocolContext<ProtocolContext>('slides-lite');

// src/protocol/deck.ts — a plain const, so the extractor reads it
export const deckCommands = {
  setDeck: {
    description: 'Replace the whole deck',
    params: { ... },
    run: (p: { deck: Deck }) => ctx().setDeck(p.deck),
  },
};

// src/main.ts
export default defineApp({
  id: 'slides-lite',
  name: 'Slides',
  commands: { ...deckCommands },
  // The imperative escape hatch: the context exists only once the editor is built,
  // and `mount` is the first moment that is true.
  view: {
    mount(el) {
      const editor = createEditor(el);
      setProtocolContext(editor.protocolContext);
      return () => editor.destroy();
    },
  },
});
```

`defineApp` registers before it mounts, so the context is installed *after* registration — which is fine, because a descriptor only reaches `ctx()` when a command actually runs. The tradeoff: the context becomes module state shared by every descriptor, which suits an app that registers once per document (the normal case). Both edges are loud rather than silent — `get()` before `set()` throws, and `set()` twice with a *different* context throws rather than quietly retargeting the first registration's handlers.

### Talking Back to the Agent

`defineApp`'s `state`/`commands` are how the agent reads *you*. These are how you reach the agent — full signatures in [`app_protocol_reference.md`](../reference/app_protocol_reference.md#iframe-sdk):

```typescript
// Free-form message to the agent, typically after a user action inside the iframe.
app.sendInteraction('User clicked Save');
app.sendInteraction({ instructions: 'Summarize this', toMonitor: true, selection: text });

// Fire-and-forget event on a channel declared in defineApp({ events }).
// Undeclared or unsubscribed channels are dropped server-side.
defineApp({ /* ... */ events: { 'item-added': { description: 'A new item was added' } } });
app.emit('item-added', { text: 'Buy milk' });

// Hooks on the defineApp() config.
defineApp({ /* ... */
  onClose: () => saveDraft(editor().value),          // window about to be destroyed
  onCapture: () => sceneCanvas.toDataURL('image/png'),  // OS captures the window
});
```

- `sendInteraction` takes a string, or an object with `instructions` and `toMonitor` (route to the monitor agent instead of this window's app agent) plus arbitrary payload fields.
- `app.emit(channel, payload, { wakeAgent: true })` also wakes **this app's own agent** — how an app hands back the result of background work the agent started and stopped waiting for, so the agent can end its turn instead of blocking. It never creates an agent, and the decision is per emit rather than a standing subscription, because the same event raised by the app's own UI should wake nobody.
- `onCapture` returns a data-URL image to use instead of the default full-window screenshot (DOM + live canvas pixels composited), or `null` to fall back. May be async. Useful when the default capture can't see your content — a WebGL canvas without `preserveDrawingBuffer`, or state rendered outside the viewport.

### MCP Tools

An agent drives a *running* app through its window URI. The verb table (`describe`, `list`, `read` on `…/state/{key}`, `invoke` on `…/commands/{key}`) is in [URI Reference → Windows](../reference/uri_reference.md#windows--yaarwindowswindowid); the payload rules and the scoped app-agent tools are in [`app_protocol_reference.md`](../reference/app_protocol_reference.md#invocation). Three things worth knowing here:

- The sub-path spellings and the `action` spellings (`app_query`, `app_command`) run the same executor — the first names the key in the URI, the second in the payload. An agent meeting an app for the first time either `describe`s the window or calls `app_query` with a bare window URI; both return the manifest.
- `invoke('yaar://windows/{id}/commands/{key}', { …params })` takes the params *as* the payload. Pass an **array** to run the command once per element, in order.
- `invoke('yaar://windows/{id}', { action: 'message', message })` lets a **monitor agent delegate to the app agent** — it queues a task through `AppTaskProcessor` exactly like a user message, creating the app agent on demand.

```
invoke('yaar://windows/slides-lite', { action: 'app_query' })
invoke('yaar://windows/slides-lite', { action: 'app_query', stateKey: 'slideCount' })
invoke('yaar://windows/slides-lite', { action: 'app_command', command: 'setActiveIndex', params: { index: 2 } })
invoke('yaar://windows/slides-lite', { action: 'message', message: 'Summarize this deck' })
```

## Credential Management

App config/credentials are stored at `config/{appId}.json` (git-ignored).

```
config/
└── moltbook.json    # { "api_key": "moltbook_xxx" }
```

- `invoke('yaar://config/app/moltbook', { config: { api_key: "..." } })` — save
- `read('yaar://config/app/moltbook')` — read
- `delete('yaar://config/app/moltbook')` — remove

## App-Scoped Storage

Each app gets its own folder at `storage/apps/{appId}/`. Apps use `self` as a shorthand — the server resolves it to the real appId from the iframe token. No permission declaration is needed; an app's own storage, database, and sub-agents are granted to it automatically.

**It is a scoped tree, not a hidden one.** `yaar://apps/self/storage/x.json` and `yaar://storage/apps/{appId}/x.json` are two spellings of the same file. What the scope buys is that **no other installed app can reach it**: a market app declaring `yaar://storage/` is capped to the shared tree at install time (`capForeignAppStorage` in `http/uri-match.ts`), so it keeps the commons and loses the reach into `apps/`. What it does *not* buy is secrecy — the user sees a folder on disk, the Storage app and any other app shipped with YAAR hold the whole tree, and monitor/session agents address it directly. Put your app's own state here; don't put anything here on the theory that nothing else will look.

### From App Code (`@bundled/yaar`)

```typescript
import { appStorage } from '@bundled/yaar';

await appStorage.save('data.json', JSON.stringify({ key: 'value' }));   // throws on failure
const saved = await appStorage.trySave('data.json', json);              // false on failure
const data = await appStorage.readJson<{ key: string }>('data.json');
const text = await appStorage.read('data.json');
const binary = await appStorage.readBinary('image.png');  // { data, mimeType, encoding }
const blob = await appStorage.readBlob('image.png');      // handles the encoding branch
const files = await appStorage.list();  // [{ path, isDirectory, uri, mimeType?, size?, modifiedAt? }]
await appStorage.remove('data.json');
```

- `list()` is **shallow** — direct children only; recurse yourself to walk subdirectories. `size` and `modifiedAt` are optional (a directory has no size), and they come from the listing itself, so "how big is this asset" needs no extra read. `size` is bytes on disk; a JSON file read back and re-serialized will not match it exactly.
- `readBinary` returns `encoding: 'base64' | 'text'` — check it before you `atob`, or use `readBlob`.
- **`readBlob()` on a PDF does not return the PDF bytes.** It takes no options, so the server's page-rasterization opt-in (`pdfPages`) can never fire through this path; the default branch returns the ASCII string `PDF document with N page(s), N bytes.` wrapped in a Blob. For raw bytes, fetch the REST URL — app-scoped files live at `/api/storage/apps/{appId}/{path}`.

### Never swallow a failed save

A `try { await appStorage.save(...) } catch { /* ignore */ }` around an autosave turns
data loss into silence: the app keeps showing "Saved", the user keeps typing, and nothing
reaches disk. Reach for `trySave()` instead — it logs the failure, toasts it (at most once
per 5s per path, so a failing autosave doesn't spam), and resolves `false` so the caller
can *withhold* its success UI:

```typescript
// Bad — the "Saved" chip lies whenever the write fails.
try { await appStorage.save('draft.json', json); } catch { /* ignore */ }
setDirty(false);

// Good — stay dirty when the write didn't land.
if (await appStorage.trySave('draft.json', json, { label: 'draft' })) {
  setDirty(false);
}
```

`label` names the data in the toast (`Couldn't save draft: …`). Pass `onError` to replace the toast with your own surface — an inline status line, say; failures are logged either way, so `onError` never costs you the console trace. `createPersistedSignal()` routes its writes through `trySave` and takes the same options, so a signal that stops persisting says so. Keep `save()` where the caller genuinely handles the throw — an agent-facing command handler, where an `AppCommandError` is the right outcome.

### Never trust a read either — validate at the boundary

The mirror image of a swallowed save is a swallowed *read*. `readJsonOr(path, fallback)` answers "the file isn't there" and "the file is garbage" with the same value, so a truncated write, an older build's shape, and a first run become one state: a broken app renders identically to a fresh one, and the user's real preferences are gone with no trace.

Persisted JSON is **untrusted input** — written by an older version of your app, hand-edited through the storage app, truncated by a crashed write, or produced by another instance running concurrently. So is anything arriving from an HTTP response, an SSE frame, a `read()` of a `yaar://config/*` file, a user-picked file, or an `evaluate()` round-trip through a page.

Validate with `@bundled/zod` — **Zod Mini**, the functional API (`z.optional(x)`, `z.safeParse(Schema, value)`), not standard Zod's method chaining. Put the schemas in a `src/schema.ts` with a header saying *which* boundaries they guard. Use `z.looseObject` so a field added by a newer build survives a round-trip through an older one, and validate only the fields the app actually reads:

```typescript
// src/schema.ts
import * as z from '@bundled/zod';

export const PrefsSchema = z.looseObject({
  playbackRate: z.optional(z.number()),
  lastUrl: z.optional(z.string()),
});
```

```typescript
// Good — "missing" is quiet, "malformed" is loud, and both still render.
import { safeParseOr } from '@bundled/yaar';

const raw = await appStorage.readJsonOr<unknown>('prefs.json', undefined);
const prefs = safeParseOr(PrefsSchema, raw, DEFAULTS, { label: 'prefs.json' });
```

`safeParseOr` **is** that rule: `undefined` — nothing stored, first run — takes the fallback silently, while a value that is present and wrong takes the same fallback and logs the schema's own issues. When logging is not the right answer at that boundary, pass `onInvalid` — it receives the issues and runs **instead of** the default console line, so a throw inside it reaches the caller (a parse-or-throw boundary needs no separate helper), a poll can count failures instead of writing one line per tick, and a case where the fallback would mislead can toast.

The rule is one line: **degraded-by-design must be distinguishable from broken.** A missing file is normal and stays silent; a malformed one is logged with `parsed.error.issues`, and toasted if the user would otherwise be misled about what they are looking at. Never toast from a poll or a subscription callback — log every failure, but surface only the *transition* into failure.

**Use `readJsonOr`, not `readJson` in a `try/catch`.** They look equivalent from inside the app — both end with the fallback — but only `readJsonOr` tells the *server* that absence was expected, by sending `missingOk` on the read. A caught failure is still a failure the session recorded: before that option existed, an app whose console stayed perfectly clean added one session error per optional config file per mount, and on a first run that was the great majority of every error the log held. The same applies to a bare `read()` you were going to wrap — pass `{ missingOk: true }` and check for `null` instead.

Two more edges:

- Write the `z.safeParse` by hand when the failure branch needs something one fallback can't express — per-field recovery, or validating an array element-wise so one bad row doesn't reject the rest. Prefer per-field recovery when the fields are independent: a drifted `playbackRate` should not cost the user their `lastStoragePath`.
- For anything persisted through `createPersistedSignal`, `revive` is where the `safeParse` goes. It also runs on the **fallback**, so a schema the fallback itself fails fires an error on every fresh install; and `revive` validates and migrates, it does not *reinterpret* — clamping a stored value against the current window belongs on the read, or a transiently narrow window overwrites the user's preference for good.

### SDK helpers

`@bundled/yaar` ships the small helpers apps otherwise rewrite. Prefer them over inlining — three renderings in particular must not disagree between two windows on one screen, which is why `formatBytes`/`formatDuration`/`formatClock` are SDK functions rather than a per-app choice (the audit that added them found four byte formatters with four unit ladders and six clock formatters, half hardcoding a locale the user never picked).

```typescript
import {
  errMsg, showToast, withLoading, tryToast, wait, AppCommandError,
  formatBytes, formatDuration, formatClock, downloadBlob, blobToDataUrl, toWebP,
} from '@bundled/yaar';

errMsg(e);                       // not: e instanceof Error ? e.message : String(e)
showToast('Deleted', 'success'); // 'info' | 'success' | 'error', auto-dismissing
await wait(200);                 // not: new Promise(r => setTimeout(r, 200))

// Sets loading true, runs fn, routes a throw to onError, always clears loading.
await withLoading(setLoading, () => fetchIssues(), (msg) => showToast(msg, 'error'));

// The whole try/catch/log/toast block: returns the value, or undefined if it threw.
await tryToast(() => deleteRepo(name), { success: 'Deleted' });

throw new AppCommandError('No document open');   // report failure to the agent

formatBytes(2_097_152);                    // '2.0 MB'  — binary steps, one decimal above bytes
formatDuration(3787);                      // '1:03:07' — hours only when there are hours
formatClock(Date.now());                   // '15:04:05' — 24-hour, locale separators
formatClock(savedAt, { seconds: false });  // '15:04', for a "Saved 15:04" label

downloadBlob(new Blob([csv]), 'report.csv');   // objectURL + <a download> + revoke
const dataUrl = await blobToDataUrl(file);     // FileReader, promisified
const encoded = await toWebP(bitmap, { quality: 0.8, maxSize: 2048 });  // null if unsupported
```

`withLoading` and `tryToast` are orthogonal — one owns a loading flag, the other owns the error toast; nest them when an action needs both. `debounce`/`throttle` come from `@bundled/lodash`. Calendar *dates* are deliberately absent — date style is a legitimate per-app choice, and `@bundled/date-fns` is bundled for it. For an image you are about to store or show, prefer `toWebP` over `blobToDataUrl`: it is the bitmap → canvas → `convertToBlob` round-trip including the check that the encoder did not quietly fall back to PNG, and it hands back both the data URL and the raw base64 that `appStorage.save(..., 'base64')` wants. It returns `null` rather than throwing, so the fallback is `if (!encoded) keepTheOriginal()`.

### Rasterizing your own DOM

There is exactly one way to get pixels out of laid-out HTML in a browser sandbox with no
rendering library bundled — `DOM → SVG foreignObject → img → canvas` — and it is four
lines to write and about six ways to get wrong, each of which fails *quietly*: a blank
picture, a picture in the wrong font, or a canvas that throws when you read it back.

```typescript
import { rasterize, downloadBlob } from '@bundled/yaar';

const { blob, fonts, skippedImages } = await rasterize(pageEl, { css: exportCss, scale: 2 });
downloadBlob(blob, 'page.png');
// fonts.missing — characters no face covered; skippedImages — sources that wouldn't inline.
// Both are reported rather than thrown: one bad glyph should not cost the whole picture.
```

The element must be **in the document and laid out** — `position:fixed; left:-99999px` is the usual trick, since a `display:none` subtree has no metrics and rasterises as nothing. It is cloned, so your live DOM is untouched.

The one thing you must supply is `css`. Chrome draws that SVG in **secure static mode**: the subtree reaches no page stylesheet, no `--yaar-*` tokens, and no network, so anything not stated in `css` is simply missing from the picture. Everything else the SDK handles — inlining `<img>` sources as `data:` URLs, serialising as well-formed XML (a Markdown renderer's `<br>` would otherwise abort the parse), avoiding the `blob:` URL that taints the canvas, painting a background before a JPEG encode turns transparency black, and putting the font stack on the subtree's root rather than on `body`, which does not exist inside a `foreignObject`.

### The platform's fonts (`fonts`)

Your app's own DOM gets YAAR's webfont for free. A *picture* of that DOM does not: the SVG rasteriser cannot fetch a font at all, and honours only an `@font-face` whose `src` is a `data:` URL. A whole face is ~1.6 MB, so it has to be subsetted first — which used to mean an app shipping its own OpenType reader and CFF subsetter.

```typescript
import { fonts } from '@bundled/yaar';

const { css, faces, missing } = await fonts.inline(pageEl.textContent, {
  weights: [400, 700],       // resolved by CSS font matching against what's served
  outlineTable: true,        // + raw CFF bytes, only if you're writing a PDF
});
```

`rasterize` calls this for you; call it directly when you drive the SVG yourself, or when you also need `faces[n].gids` / `advances` / `metrics` to paint the *same* glyphs as vectors over the raster. Take both from one call: a raster laid out with one font under text placed with another drifts ~10% on Latin, which is lines down a page. `fonts.faces()` lists what this build serves — currently `NanumSquareNeo` (proportional, four weights) and `D2Coding` (monospace). `fonts.faceCss(family)` gives by-URL rules for a *measuring* pass; the subset keeps every glyph index and metrics table identical, so measurements against the full face stay valid. No permission needed.

### Dialog helpers

Never use native `alert()` / `confirm()` / `prompt()` — they look foreign, block the whole
page, and freeze any agent driving the browser. `@bundled/yaar` ships promise-based
replacements styled with the built-in `y-modal` classes (Escape cancels, Enter confirms,
backdrop click dismisses). The replacement for `alert()` is `showToast` — a one-button
modal only steals focus to say something a toast already says:

```typescript
import { showConfirm, showPrompt, showToast } from '@bundled/yaar';

showToast('Export finished.', 'success');

if (await showConfirm(`Delete "${name}"?`, { danger: true, okLabel: 'Delete' })) {
  await remove(name);
}

const title = await showPrompt('New document name:', { initial: 'Untitled' });
if (title !== null) create(title);
```

For custom modals beyond these, compose the same classes yourself: `y-overlay` > `y-modal` > `y-modal-title` / `y-modal-msg` / `y-modal-actions`.

### From Agent (MCP Tools)

```
invoke('yaar://apps/my-app/storage/data.json', { action: 'write', content: '...' })
read('yaar://apps/my-app/storage/data.json')
list('yaar://apps/my-app/storage/')
describe('yaar://apps/my-app/storage/data.json')
delete('yaar://apps/my-app/storage/data.json')
```

`describe` on a storage path describes **that path**: an error when it isn't there, `{ kind: 'directory', entries, totalSize, verbs }` for a folder, `{ kind: 'file', size, modifiedAt, mimeType, verbs }` for a file (a PDF adds its page count and the `pdfText` / `pdfPages` read options). The bare `…/storage` root is the exception — it answers with the app-storage manual plus a root entry count. The same shape answers for `yaar://storage/…`; they are two spellings of one directory tree. A `list` of a directory that does not exist is an **error**, not an empty success — except a namespace root: an app's `storage/` exists from the moment the app does, so listing it before anything is written is empty rather than missing.

Full server-side surface (write/copy/edit/grep payloads, mounts, REST routes, PDF options): [`docs/reference/storage_api_reference.md`](../reference/storage_api_reference.md).

## Shared Storage (`yaar://storage/shared/`)

App storage is private; `yaar://storage/shared/` is the commons — where apps hand files to each other (an image generated in one app, a deck exported by another, a dataset a notebook computed). **Every app can read and write it without declaring anything.** There is no `permissions` entry to add; adding one grants nothing and the install dialog drops it.

Publish under your own app id, one directory per producer. `sharedStorage` *is* that directory, so it isn't a `const SHARED_DIR = 'shared/anima'` in every app that publishes. **Which directory is yours the server decides**, from the iframe token — paths go out as `shared/self/…`, like `apps/self` — so a devtools preview writes to its own directory instead of the shipped app's, and none of this needs `defineApp` to have run first:

```typescript
import { sharedStorage, storage } from '@bundled/yaar';

// Copy a file already in storage into the commons — the copy happens server-side.
const { uri } = await sharedStorage.publish('yaar://apps/self/storage/generated/x.png', {
  as: 'dragon.png',
});                                                // → yaar://storage/shared/anima/dragon.png

await sharedStorage.save('renders/final.png', blob);  // names are subpaths
const mine = await sharedStorage.list();              // this app's commons directory
img.src = sharedStorage.url('renders/final.png');     // carries the iframe token

// The raw API reaches anywhere in storage — including what someone *else* published.
const png = await storage.read('shared/anima/dragon.png', { as: 'blob' });
const published = await storage.list('shared');
```

> **Prefer `publish()` over read-then-`save()`.** `from` is a reference, not bytes, so the file never travels through the iframe — and once an agent asks about it, never through a model context. A 550KB PNG round-tripped as base64 costs that on every hop.

`sharedStorage` names are relative to your own directory; a name naming *another* app's directory, or another top-level tree (`apps/`, `mounts/`, …), is refused rather than nested inside this one — use the raw `storage` API to reach those deliberately. Three properties follow from the commons being a commons rather than a grant:

- **It is not scoped to anyone.** Any app can read, overwrite or delete anything under `shared/`. Data that must stay yours belongs in `appStorage`, which no other *installed* app can reach. The per-producer directory is tidiness, not a boundary.
- **It is a staging area.** The user prunes it; a file published last week may be gone. An app that needs an asset at runtime should keep its own copy.
- **It does not widen anything else.** `storage/apps/{id}/` is a sibling subtree, so the commons never reaches another app's own tree.

### One file, four names (`storagePath`)

A stored file is spelled differently by each layer that hands it to you, and all four
name the same bytes:

| Spelling | Where it comes from |
|---|---|
| `shared/anima/dragon.png` | a `storage.list` entry, another app's publish confirmation |
| `yaar://storage/shared/anima/dragon.png` | a verb result, an agent, an `app.json` permission |
| `yaar://apps/self/storage/x.png` | `appStorage`, an agent naming your own tree |
| `/api/storage/shared/anima/dragon.png` | an HTTP route, an `<img src>` you built earlier |

**Every `storage.*` method accepts all four**, so a reference you were handed can go straight into `read`/`save`/`list`/`remove`/`url` with no unwrapping. Reach for `storagePath` only when you need the path *itself*:

```typescript
import { storage, storagePath } from '@bundled/yaar';

// "Is this a stored file or a remote URL?" — null means not storage.
const path = storagePath(slide.image);
img.src = path ? storage.url(path) : slide.image;
```

Two rules, both of which have cost real bugs:

- **Never hand-roll the parsing.** Recognising only the flat spelling is how a deck ends up with an image the editor shows and the export leaves blank — the namespaced URI passes through verbatim and becomes a request for a directory named `yaar:`.
- **Never hand-build a `/api/storage/…` URL.** Only `storage.url()` carries the iframe token in the query string, which is the sole way a subresource fetch (`<img>`, `<video>`, CSS `url()`) can present one. A hand-built URL is refused as unauthenticated the moment app-origin isolation is on, and reaches the element as an indistinguishable load failure.

`null` from `storagePath` means "not a storage reference" (a remote URL, a `data:` URL, another kind of `yaar://` resource) or a path containing `..`. It does **not** mean forbidden — an agent may have delegated a single file to your window, a grant no code in the iframe can see, so a path outside your own trees still resolves and the server decides. `self` is left unexpanded for the same reason: the server resolves it against the calling app, and under a devtools preview that is `preview--{id}`, not your app id.

## App-Scoped Database (`appDb`)

For structured records, each app also gets a SQLite database at `storage/apps/{appId}/data.db`. Unlike `appStorage`, it supports queries, counting, pagination, and full-text search server-side — no load-all-JSON-and-filter. Binary blobs and simple single files stay on `appStorage`. Design, filter-to-SQL translation, and the full storage-type breakdown: [`app_db_reference.md`](../reference/app_db_reference.md).

```typescript
import { appDb } from '@bundled/yaar';

interface Note { title: string; tags: string[] }
const notes = appDb.collection<Note>('notes');

const id = await notes.insert({ title: 'Hello', tags: ['intro'] }); // → generated _id
await notes.insertMany([{ title: 'A', tags: [] }, { title: 'B', tags: [] }]);

const one = await notes.get(id);                  // → doc | null (has _id, _created_at, _updated_at)
const page = await notes.find(
  { tags: 'intro' },                              // Mongo-style filter, fields AND together
  { sort: { _created_at: -1 }, limit: 20, offset: 0 },
);
const hits = await notes.search('hello world');   // FTS5 full-text search, best matches first

await notes.update(id, { title: 'Updated' });     // shallow merge
await notes.remove(id);
await notes.removeWhere({ tags: 'draft' });       // filter must be non-empty
const n = await notes.count({ tags: 'intro' });

await appDb.collections();                        // → ['notes', ...]
await appDb.drop('notes');                        // delete collection + documents

// A Solid signal that tracks a query. docs() re-renders on mutations made through
// these helpers; external changes (agent, another window) arrive via a verb subscription.
const [docs, { insert, update, remove, refresh }] = appDb.createReactiveCollection<Note>(
  'notes', { sort: { _created_at: -1 }, limit: 50 },
);
```

Filters take exact match, array-contains (same syntax as scalar equality), `$gt`/`$gte`/`$lt`/`$lte`, `$ne` (which also matches docs missing the field), `$in`, `$exists`, and dotted paths into nested objects — [`app_db_reference.md`](../reference/app_db_reference.md#filter-syntax) has the table.

### From Agent (MCP Tools)

The agent can query app data directly — no need to load whole files:

```
list('yaar://apps/memo/db')                                            → collection names
read('yaar://apps/memo/db/notes')                                      → recent documents
read('yaar://apps/memo/db/notes/{id}')                                 → one document
invoke('yaar://apps/memo/db/notes', { action: 'find', filter: { tags: 'important' }, limit: 5 })
invoke('yaar://apps/memo/db/notes', { action: 'search', query: 'quarterly report' })
invoke('yaar://apps/memo/db/notes', { action: 'insert', doc: { ... } })  → { _id }
invoke('yaar://apps/memo/db/notes/{id}', { action: 'update', patch: { ... } })
invoke('yaar://apps/memo/db/notes', { action: 'count' })                 → { count }
delete('yaar://apps/memo/db/notes/{id}')                                 → remove document
delete('yaar://apps/memo/db/notes')                                      → drop collection
```

## Sub-agents (Personas)

An app that declares `"subagents": { "max": N }` can spawn up to N AI instances from its iframe, each with a system prompt the app supplies at runtime and each its own provider session with its own conversation memory. This is what lets one app run several distinct characters *at once* instead of one agent role-playing them in turn.

They are the bottom tier of [the agent tree](../architecture/agent_tree.md): they hold **no YAAR verbs, no permissions, and no principal**, so a runtime-supplied prompt never gets YAAR's hands. Full verb surface, limits, and response shapes: [URI Reference](../reference/uri_reference.md#app-sub-agents--yaarappsselfagents).

```jsonc
{
  "subagents": { "max": 4 },  // the manifest key; the wire still says personaId
  "streams": ["agents"]       // required to watch them
}
```

The `yaar://apps/self/` namespace is auto-granted — no `permissions` entry. **Both lines are requests, not grants, for an app that was installed rather than bundled.** A bundled manifest ships with the release and is honored as written; an installed app's is itemized in the install dialog, and the user's answer is recorded in `config/app-grants.json` and applied as a **ceiling** — raise `max` in a later manifest and you get the granted number until the user approves the new one. An app installed before this existed holds nothing until it is updated or reinstalled. (`controls` is different, and still bundled-only.) The retired `"personas"` spelling is no longer read: a manifest still using it logs an `[apps]` warning and refuses spawns with a message naming the rename.

### Spawn, message, stream

```typescript
import { invoke, list, del, stream } from '@bundled/yaar';

const { personaId, instanceId, streamUri, reused } = await invoke('yaar://apps/self/agents', {
  action: 'spawn',
  personaId: 'alice',
  systemPrompt: 'You are Alice, a botanist who answers in short, dry sentences.',
});

// Frames arrive as the turn generates: start | text | thinking | tool | usage | done | error.
// The `done` frame carries the turn's final text.
const stop = await stream(streamUri, (frame) => render(frame), {
  kinds: ['start', 'text', 'thinking', 'done', 'error'],
});

// Returns as soon as the turn is *queued* — fire all four and they generate concurrently.
await invoke(`yaar://apps/self/agents/${personaId}`, { action: 'message', content: 'Hi!' });

await invoke(`yaar://apps/self/agents/${personaId}`, { action: 'interrupt' });
await list('yaar://apps/self/agents');   // → { max, personas: [...] }
await del(`yaar://apps/self/agents/${personaId}`);
```

Three consequences worth designing around:

- **Await the stream, not the verb.** `message` resolves when the turn is queued, so the answer only exists on the stream. Give each turn a watchdog: a character that never produces a frame should cost one slow turn, not hang the room.
- **Spawn is idempotent, and deliberately does not update the prompt.** An iframe reload re-runs your spawn calls; the personas from before are still alive with their memory intact and come back with `reused: true`. Since the prompt is replayed every turn, rewriting it under a live conversation would rewrite who the persona has been all along — `delete` and respawn to recast.
- **`message` rejects rather than queues while a persona is mid-turn.** The refusal carries `busy: true` on the envelope. Your app is the scheduler; only it knows whether a second message is a follow-up worth waiting for or a race worth dropping.

### Giving a persona tools

The one capability a sub-agent may be given is a channel back into **your own app's iframe**,
dressed in tool names you declare at spawn:

```typescript
await invoke('yaar://apps/self/agents', {
  action: 'spawn',
  personaId: 'alice',
  systemPrompt,
  tools: [
    { name: 'skip', description: 'Decline this turn — you have nothing to add.' },
    { name: 'memorize', description: 'Save a lasting fact you learned about someone.',
      input: { fact: 'string' } },
  ],
});
```

Alice calling `memorize` dispatches the protocol command `persona:memorize` to your app's active window with params `{ fact, personaId: 'alice' }` — the server stamps `personaId` **last**, so a model cannot answer as another character. Whatever your handler returns becomes the tool result:

```typescript
export default defineApp({
  id: 'my-app',
  commands: {
    'persona:memorize': {
      description: 'Called by a character recording a lasting fact about someone.',
      params: z.object({ personaId: z.string(), fact: z.string() }),
      replay: 'never',
      run: async (p) => ({ recorded: await saveFact(p.personaId, p.fact) }),
    },
  },
});
```

`persona:*` commands are hidden from the app agent's `describe`/manifest — their spawn-time descriptions are written for a character, not an operator, and one description string cannot serve both audiences.

Why tools rather than output sentinels: a `skip` tool *is* the signal, where `[[skip]]` in the text is a parse hoping to be one. And a lookup like `recall` cannot be a sentinel at all — it needs its result fed back mid-generation, which only the tool loop provides.

Limits and edges: 12 tools, 6 000 chars across all names/descriptions (they are replayed every turn), 20 000 chars of system prompt. Tool names match `[A-Za-z][A-Za-z0-9_]{0,47}`; `input` values are `"string" | "number" | "boolean" | "object" | "array"`. No open window makes a tool call return an **error result** — the turn continues, and a persona deciding to remember something never launches a window. Omitting `tools` connects no MCP server at all.

### Lifecycle and persistence

Sub-agents are reclaimed when your app's last window on that monitor closes, when the monitor is removed, or on explicit `delete` — and none survive the session. **Persistence is your app's job** (`appDb`/`appStorage`); a respawned persona gets its history replayed in its system prompt or first message. `subagents.max` is per (monitor, app) and clamped to 16; each persona also takes a global `MAX_AGENTS` slot, so `spawn` can fail with "no provider slot" even under your own cap.

**Reference consumer:** `chitchats`, which ships from the market rather than `apps/` (rooms that take turns; characters get `skip`, `memorize`, and — when their memory file has chunks — `recall`, whose description carries the memory index so the backstory is retrieved rather than replayed every turn). Being a market app it holds `subagents` by the user's install-time approval rather than by shipping in the tree.
