# App Development Guide

In YAAR, you tell the AI what to build and it creates the app. TypeScript authoring, compilation, preview, and desktop deployment are all handled by the AI through the devtools app — and finished apps can be [published to the shared marketplace](#publishing-to-the-marketplace) for anyone to install.

> [한국어 버전](../ko/app-development.md)

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

## URI Verbs

All operations use 5 generic verbs (`read`, `list`, `invoke`, `delete`, `describe`) on `yaar://` URIs.

> **Note:** `yaar://session/*` is **session-agent-only** — it is the session principal's private namespace and is not reachable by apps via `POST /api/verb`, regardless of `app.json` permissions (apps cannot self-grant it). This includes `yaar://session/browser` (the session agent's door to the user's *real* browser); apps that need browsing use `@bundled/yaar-web` → the headless sandbox instead.

### Devtools App

App development (write, edit, compile, typecheck, deploy, clone) is handled through the **devtools app** via App Protocol commands. The devtools app runs in an iframe window and exposes these operations as protocol commands. The AI opens the devtools window and interacts with it using `app_command` and `app_query`.

For the full list of available commands, `describe('yaar://apps/devtools')` — the manifest is generated from the app's own `protocol.json`.

### Apps — `yaar://apps/`

| Verb | URI | Description |
|------|-----|-------------|
| `list` | `yaar://apps` | List all installed apps |
| `describe` | `yaar://apps/{appId}` | The app's **manual** — name/description/icon, its `protocol.json` verbatim (less `persona:*` commands), its `agent/SKILL.md` when it ships one, permissions, and this door's verbs + `invoke` actions |
| `read` | `yaar://apps/{appId}` | The app's **effective manifest** — id, name, kind, source, version, author, `isCompiled`/`hasProtocol`/`hasConfig`, permissions, `bundles`, `controls`, `subagents`, `streams`, `messaging`, `variant`, `dockEdge` |
| `invoke` | `yaar://apps/{appId}`, `{ action, ... }` | Run an app action (see below) |
| `delete` | `yaar://apps/{appId}` | Uninstall app |

**describe = the manual, read = the current value.** `describe` answers "what is this app and how do I drive it"; `read` answers "what is installed here". Returning `protocol.json` whole from `describe` carries no drift risk because it is a build artifact — the compiler writes it from the source AST and deploy re-derives and diffs it — which is exactly the objection that retired the previous, hand-written protocol restatement.

`read`'s capability fields are **post-grant**: `subagents` and `streams` are the intersection of what `app.json` declares with what the user approved at install (`config/app-grants.json`), not what the file says. An app holding `yaar-dev` can rewrite its own manifest, so reporting the declaration would report a ceiling the app doesn't have.

`yaar://apps/{appId}/state/…` and `/commands/…` are **not addressable** on any verb, and the handler refuses them by name. Protocol state belongs to a running window — `yaar://windows/{windowId}/state/{key}`. `storage/`, `db/`, and `agents/` sub-paths are unaffected.

**`invoke` actions on `yaar://apps/{appId}`** (`handlers/apps/app-resource.ts`):

| Action | Payload | Description |
|--------|---------|-------------|
| `set_badge` | `{ count }` | Set (or clear, when `0`) the badge on the app icon |
| `install` | — | Download + install the app from the marketplace |
| `clone` | — | Copy the app's source into the devtools workspace for editing |
| `publish` | — | Single-phase publish of the app's current on-disk state |
| `publish_prepare` | — | Two-phase publish, step 1: freeze bytes, return a `publicationId` + summary |
| `publish_confirm` | `{ publicationId, acknowledgeDrift? }` | Step 2: upload the frozen bytes |
| `publish_cancel` | `{ publicationId }` | Discard a prepared publication |

See [Publishing to the Marketplace](#publishing-to-the-marketplace) for the full publish flow.

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

## Development Workflow in Detail

All development operations are performed through the **devtools app** via App Protocol commands. The AI opens the devtools window and uses `app_command` to write, compile, and deploy code.

### Step 1: Write Code

The AI sends write/edit commands to the devtools app to create source files.

- Supports multiple files (`src/main.ts`, `src/utils.ts`, ...)

### Step 2: Compile

The AI sends a compile command to the devtools app.

- Bundles from `src/main.ts` entry point via Bun
- Produces a **single self-contained HTML file** with embedded JS
- Returns preview URL via `/api/dev/` routes

### Step 3: Preview

The AI opens an iframe window to preview the compiled result immediately.

### Step 4: Deploy

The AI sends a deploy command to the devtools app.

- Copies compiled HTML to `apps/{appId}/`
- Writes `app.json`. Reading the app back (`read('yaar://apps/{appId}')`) returns the effective manifest, and `describe` returns `protocol.json` plus `agent/SKILL.md` — both assembled at call time, so there's no doc file for deploy to write; the `agent/prompt.md`/`agent/hint.md`/`agent/SKILL.md` you hand-authored are picked up from the app directory as-is and carried through clone and deploy
- Icon appears on desktop immediately
- Closes any window still running the previous build, and drops the app agent's cached
  profile so its next turn is built from the new `protocol.json`. Both would otherwise
  keep serving the code the deploy just replaced. The deploying window itself is spared,
  so an app can deploy itself; the closed handles come back as `closedWindows`
- `appProtocol`: Mark app as supporting App Protocol (auto-detected from HTML if not set)
- `fileAssociations`: Map file extensions to app_command calls for file opening

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

This serves the deployed app's `dist/index.html` with its **real iframe token
injected**, so token-gated SDK calls (`appStorage`, `appDb`, `/api/ml-weights`, the
verb SDK) work exactly as they do in a window. The identity is the app's own — the
permissions and `bundles` come off its `app.json`, never from the request — so a
preview cannot pass anything the deployed app would be refused, and it runs under the
same `connect-src 'self'` CSP.

```js
// Anything speaking CDP: Playwright, Puppeteer, claude-in-chrome, …
navigate('http://localhost:8000/api/dev/preview/ocr');
javascript_tool("await window.__ocr.readSample()"); // the app's own automation hook
```

Notes:

- **Host-only.** The route hands out an app's token, so — like `POST /api/iframe-token`
  — it is refused to app iframes. In `REMOTE=1` the caller must already hold the
  remote token.
- **`localhost`, not `127.0.0.1`.** With app-origin isolation on (the default in local
  mode), `127.0.0.1` *is* the app origin and a token-less request carrying it is
  refused by design. A top-level navigation there is redirected to `localhost`
  automatically, so this mostly self-corrects — but a `fetch` of the preview URL
  against `127.0.0.1` will not.
- Session-scoped verbs (windows, notifications) bind to the running desktop's session
  when one is connected. With no desktop up, the app still gets its storage, its db,
  and its gated HTTP doors — those are keyed on the app, not the session.
- The app must be **deployed** and compiled (`dist/index.html` present). For an
  uncompiled project in the devtools workspace, compile first — `POST /api/dev/compile`
  returns a `previewUrl` under `/api/storage/…`.

## Publishing to the Marketplace

Deploy puts an app on *your* desktop. Publishing pushes it to the shared YAAR marketplace so anyone can install it. The full lifecycle is **write → compile → deploy → publish**, and installing is the mirror image on someone else's machine.

The Market Apps app (🛒, `apps/market-apps`) is the front door for both directions — browse and install others' apps, sign in, and publish your own. The AI can also drive every step directly through `yaar://apps/{appId}` verbs.

### Publisher identity — sign in with Google

Publishing is authenticated by a **Google ID token**: a JWT signed by Google that asserts your email, which the marketplace verifies against Google's public keys. There is no API key, no shared secret, and no device registry — the email proves itself.

- **Sign in** from the Market Apps window ("Sign in to publish"). YAAR opens the system browser at Google's consent screen (PKCE over a loopback redirect to this server's `/api/auth/google/callback`), then exchanges the code for tokens. Only the `openid email` scope is requested — publishing authorizes against your email, not any Google API.
- The **refresh token** is the durable half and is the only thing persisted locally (in the config dir). ID tokens live an hour and are minted on demand, cached in memory only.
- The token exchange is routed through the marketplace (`MARKET_URL/api/auth/exchange`) because Google's Desktop-client token endpoint requires a `client_secret` that an open-source app installed on user machines has nowhere safe to keep. YAAR does the half it can (open consent, hold the PKCE verifier, receive the code); the marketplace adds the secret and calls Google. Only tokens come back.

Auth routes live on YAAR's own origin and are host/bundled-only — `GET /api/auth/google/status`, `POST /api/auth/google/login`, `POST /api/auth/google/logout` (`http/routes/auth.ts`).

### What gets published

Publishing uploads a **tar.gz of the app directory**, entries prefixed `{appId}/` — the same shape `GET /api/apps/{id}/download` produces, so the round trip is symmetric. The archive excludes:

- **`dist/`** — the marketplace ships *source* and YAAR compiles on install. Uploading build output would only bloat the archive and let it go stale against the source.
- **macOS cruft** — `.DS_Store` and `._*` AppleDouble sidecars, at any depth.

App secrets are not a concern here because they don't live in the app directory in the first place: credentials are stored separately under `config/{appId}.json` (git-ignored, see [Credential Management](#credential-management)), never inside `apps/{appId}/`.

The marketplace commits the app into its own git repo, so publishing is queued rather than instant — the response says "live in ~1 minute", once the redeploy lands. The app id must match `^[a-z][a-z0-9-]*$`.

### Version policy — bump before you publish

The marketplace refuses a version that is not strictly newer than what it already serves, and YAAR checks the same thing locally *before* packaging so you hear "bump the version" without waiting on an upload it would only reject. Bump `"version"` in `app.json` (semver) for every update. The check is best-effort and fail-open: if the catalog is unreachable or the app was never published, the publish is allowed and the marketplace is the backstop.

In the Market Apps UI, the Publish button disables itself with a "vX already published" tooltip when it can prove the local version isn't newer.

### Single-phase publish

Package the app's current on-disk state and upload it in one call — no window in which the source can change underneath you:

```
invoke('yaar://apps/{appId}', { action: 'publish' })
// → { published: true, appId, commit, files, message }
```

Transient upstream failures (429/5xx, dropped connections) are retried up to 3 times with backoff — safe because nothing is committed until the whole upload lands.

### Two-phase publish (freeze → confirm)

When you want to show the user exactly what will ship and get an explicit confirmation, use the two-phase flow. `prepare` freezes the exact bytes and hashes the source; `confirm` uploads *those frozen bytes*, never a fresh re-tar:

```
invoke('yaar://apps/{appId}', { action: 'publish_prepare' })
// → { prepared: true, publicationId, appId, version, byteLength, artifactSha256, ... }

invoke('yaar://apps/{appId}', { action: 'publish_confirm', publicationId })
// → { published: true, appId, commit, files, message }
```

Between the two calls, YAAR watches for **source drift**: if `src/` or `app.json` changed since `prepare`, `confirm` refuses with `{ published: false, status: 'drift_detected', ... }` and lists the changed files. Re-prepare, or pass `acknowledgeDrift: true` to ship the originally frozen bytes anyway. Other non-fatal states (`expired`, `not_found`) come back the same structured way rather than as hard errors. Prepared publications are swept after 15 minutes; discard one early with:

```
invoke('yaar://apps/{appId}', { action: 'publish_cancel', publicationId })
```

Source drift is detected by content-hashing `src/` and `app.json` (deterministic), not by re-tarring — the gzip stream stamps an mtime and so is never byte-identical even when nothing changed.

### Installing & uninstalling

```
invoke('yaar://http', { url: '<MARKET_URL>/api/apps' })   // browse the catalog
invoke('yaar://apps/{appId}', { action: 'install' })      // download + install
delete('yaar://apps/{appId}')                             // uninstall
list('yaar://apps')                                       // list installed
```

`<MARKET_URL>` is the marketplace origin (server env var `MARKET_URL`). `install` downloads the tarball, extracts it, and — because the marketplace ships source — compiles the app locally. Fresh installs land in the git-ignored user-apps root so they never pollute the tracked bundled tree; re-installing an app already present updates it in place. Bundled `"kind": "system"` apps can't be replaced from the marketplace. If the app declares `permissions`, the user is prompted to approve them before the install completes.

The AI reaches all of this through the `yaar://skills/marketplace` reference topic (`read('yaar://skills/marketplace')`), which documents the live marketplace API with `MARKET_URL` substituted in.

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

### Per-app version history

Deploy is destructive — it overwrites source and deletes files no longer present — so every deploy is snapshotted first. Each app gets its own shadow git repo whose **work-tree is the app directory**, which is what makes "the app boundary" a boundary git enforces rather than one we filter for. The repo metadata lives in git-ignored `storage/app-git/<appId>.git`, never inside the app: the user's own repo never sees a nested `.git` and their history is never polluted with agent commits. `dist/` and `credentials.json` are excluded.

`gitDiff` takes two bases. `against: "snapshot"` (default) compares the app's files to a commit in its own history — *what changed since the last deploy* — and works for every app. `against: "repo"` compares against the user's own git repo — *what changed relative to what the user committed* — and is read-only and bundled-apps-only, since `user-apps/` is git-ignored.

`gitRestore(appId, ref)` rolls an app back and rebuilds it. It snapshots the current state first and appends the rollback as a new commit rather than moving `HEAD`, so history is append-only and a restore is itself undoable.

Writing another app's directory (`deploy`, `gitRestore`, `gitCheckpoint`) is restricted to bundled apps — a marketplace app that declares `"bundles": ["yaar-dev"]` may only modify itself.

**app.json:**
```json
{
  "bundles": ["yaar-dev"],
  "permissions": ["yaar://storage/", "yaar://apps/"]
}
```

**Usage:**
```typescript
import { compile, typecheck, deploy } from '@bundled/yaar-dev';
import { open, click, extract } from '@bundled/yaar-web';
```

The base `@bundled/yaar` SDK (verbs, storage, app protocol, utilities) remains available to all apps without declaration.

## TypeScript Notes

Every app's `src/main.ts` must include `export {};` at the top of the file. Because `apps/tsconfig.json` compiles all apps in a single program, files without this are treated as scripts by TypeScript, causing top-level variable name collisions across apps.

```typescript
export {};

import { createSignal } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';

const [count, setCount] = createSignal(0);
render(() => html`<button onClick=${() => setCount(c => c + 1)}>Clicked ${() => count()} times</button>`, document.getElementById('app')!);
```

If you already `import` from `@bundled/*` or other modules, the file is already a module and no extra `export {};` is needed.

## UI Chrome & Headless Primitives

The compiler injects a `y-*` utility/chrome layer into every compiled app — colors, spacing, layout, buttons, and a **document-app chrome family** (app bar, title field, formatting toolbar, status bar). Reuse these instead of hand-writing CSS: they cost zero extra bytes (the CSS ships with every app regardless), recolor with the theme, and are advertised to app agents automatically. **Never hardcode colors** — always use `var(--yaar-*)`. The full class list is in `packages/frontend`/`shared` design docs; see [`docs/architecture/design_system.md`](../architecture/design_system.md) for the chrome-vs-content rules and the exception registry.

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

Chrome classes: `y-appbar` / `y-appbar-actions`, `y-brand` / `-badge` / `-name`, `y-doc-field` / `y-doc-icon` / `y-doc-input`, `y-editbar`, `y-tgroup` / `y-tsep`, `y-tbtn` (`-text` / `-primary` / `-active`), `y-tlabel`, `y-tselect`, `y-statusbar`, `y-chip` (`-warning` / `-muted`). A collapsible sidebar/overlay uses the `y-nav-*` family (`y-nav-root`, `y-nav-panel`, `y-nav-hover-zone`, `y-nav-pin`, `y-nav-resizer`, …).

The skeleton is intentionally a **snippet, not a component**. The chrome you copy is short and yours to edit.

### Headless behavior primitives

Two state machines that document apps kept re-implementing now live in `@bundled/yaar` as **headless** primitives — they return state and handlers, and your app owns the markup. Both are tree-shaken, so apps that don't import them pay nothing.

**`createCollapsiblePanel`** — the hover-expand + pin sidebar/overlay. Visible while pinned or hovered, with a grace period before folding so a brief cursor exit doesn't flicker it shut; pin state persists to `appStorage` when `pinKey` is given, and `setResizing(true)` suppresses auto-close while a width handle is dragged. Two predicates cover reasons the panel doesn't own: `canOpen` is consulted by `open()` (return `false` while a drag that began elsewhere is sweeping across the rail — the pending fold is still cancelled), and `holdOpen` is consulted when the fold *fires* (return `true` while a field inside the panel has focus, then call `scheduleClose()` again once it blurs).

```typescript
import { createCollapsiblePanel } from '@bundled/yaar';

const panel = createCollapsiblePanel({ pinKey: 'nav.pinned', closeDelayMs: 280 });
// panel.expanded() / pinned(), open(), scheduleClose(), close(), cancelClose(),
// togglePin(), setPin(v), setResizing(active)
// Wire your own pointer handlers: onMouseEnter=panel.open, onMouseLeave=panel.scheduleClose
```

**`createAutosave`** — the dirty / debounced-save / save-status lifecycle. Wraps a `save` (returning `true` on success; `false` keeps the doc dirty) with a debounce and an `editSeq` guard, so a save that started before the latest edit never clears the dirty flag. `statusLabel()` yields `"Saving…"` | `"Saved 14:22"` | `"Not saved"` — pair it with a `y-chip`.

```typescript
import { createAutosave } from '@bundled/yaar';

const autosave = createAutosave(
  (value: string) => appStorage.trySave('draft.txt', value),  // false ⇒ stays dirty
  { debounceMs: 800 },
);
// autosave.markDirty(value) on input; autosave.flush(true) on Ctrl+S;
// bind the status chip to autosave.statusLabel()
```

For plain persistence without a save-status machine, `createPersistedSignal` (a Solid signal auto-synced to `appStorage` through `trySave`) is the lighter choice. Its `revive` option runs on the loaded value before it reaches the signal — the place to clamp a stored width against the current window, migrate a renamed key, or `z.safeParse` JSON an older version wrote in another shape. It also runs on the fallback when nothing is stored, so keep it total; if it throws, the fallback is used and the failure is logged.

**Bind it to a text input and pass `debounceMs`.** It writes on every set by default, which is right for the toggle it usually holds — a set is a click. An `onInput` handler is not a click: it fires per keystroke, and under an IME per composition step, so a five-letter Korean name was a dozen writes, a dozen disk hits, and a dozen lines in the session log for one field. `debounceMs: 400` collapses the burst into one write, and a pending write is flushed when the page is hidden or unloaded, so closing the window mid-debounce still saves. The signal itself is never delayed — only the write.

**`createStaleGuard`** — the generation counter that keeps a slow response from overwriting a newer one.

```typescript
import { createStaleGuard } from '@bundled/yaar';

const guard = createStaleGuard();

async function loadPost(id: string) {
  const fresh = guard.begin();   // supersedes anything already in flight
  const post = await fetchPost(id);
  if (!fresh()) return;          // a newer load started; drop this response
  setState('post', post);
}
// guard.latest() joins the current generation without superseding it (a secondary
// fetch cancelled by the next begin() but not cancelling its siblings);
// guard.invalidate() bumps with no fetch attached, dropping everything in flight.
```

**`createKeyState`** — held-key tracking for continuous input, the input half of a game loop.
Declarative `keybindings` and `onShortcut` fire discrete actions on keydown; smooth movement
instead samples held state every animation frame:

```typescript
import { createKeyState } from '@bundled/yaar';

const keys = createKeyState({ preventDefault: ['arrowup', 'arrowdown', ' '] });

function frame(dt: number) {
  if (keys.has('w') || keys.has('arrowup')) player.y -= speed * dt;
  if (keys.has('d') || keys.has('arrowright')) player.x += speed * dt;
}
// keys.has('KeyW') matches the physical key on any layout; keys.has('w') matches
// what the layout typed. keys.dispose() from onClose removes the listeners.
```

It gets the fiddly parts right by default: OS auto-repeat is ignored, held state clears on
window blur and tab-hide (alt-tabbing with `w` held must not leave the player running
forever), releases are keyed by `e.code` so a modifier changing `e.key` mid-hold (Alt+W
reports `∑` on macOS) can never leave a stuck key, and presses landing in an editable
element are skipped (typing "w" into a chat box doesn't move the player; pass
`ignoreEditable: false` to opt out). The rule of thumb for game input: discrete action
(pause, inventory, rotate) → declarative `keybindings`, agent-visible and validated;
continuous movement → `createKeyState` + your `requestAnimationFrame` loop.

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

Steps 2 and 3 are in that order for a reason. Sanitizing first means no unsafe source
attribute survives into your rewriting pass; rewriting after means the app can mint
known-safe URLs and attributes without weakening the default policy. Reversing them
hands your rewriter attacker-controlled input.

Step 5 matters just as much. DOMPurify strips `onerror`/`onload`/`onclick`
unconditionally, so a generated `img.setAttribute('onerror', '...')` fallback will
silently stop working after you add the sanitizer. Register a real
`addEventListener('error', handler, { once: true })` on the inserted node instead.

Sanitize at one choke point per pipeline, ideally where foreign content first enters app
state, so that every downstream sink is safe by construction. Two overlapping policies are
worse than one: the next editor will weaken one assuming the other covers it.

`sanitizeHtml(dirty)` with no options is the default policy: DOMPurify's own defaults —
which already strip scripts, event handlers, and `javascript:`/`data:` URLs — plus the one
deviation every YAAR app makes. `form` and its controls are on DOMPurify's default
`ALLOWED_TAGS`, which is right for a general-purpose sanitizer and wrong for an app iframe:
no foreign content YAAR renders has a legitimate reason to post, and a form inside the
iframe can navigate it or phish against the app's chrome. The `FORBID_TAGS` list encoding
that deviation lives in one place.

Pass an options object (`allowedTags`, `allowedAttr`, `forbidTags`, `forbidAttr`) only when
the content type genuinely needs a different allowlist — a printable document needs inline
`style` that prose rendering does not — and comment the reasoning next to it. The no-forms
correction applies to DOMPurify's *default* allowlist; once you pass `allowedTags`, your
list is the whole policy and nothing is subtracted from it behind your back. That is why an
explicit allowlist must simply not name a form control it doesn't want.

Do not call `@bundled/dompurify` directly, and do not hand-roll a sanitizer. Element
denylists and `^on` attribute stripping miss `<svg>`/`<math>` mutation-XSS, `srcset`,
`formaction`, and `xlink:href`. Relative URLs survive `sanitizeHtml` verbatim — it neither
strips nor absolutizes them — so an app that needs them resolved rewrites the *sanitized*
output, per step 3 above.

### Interpolating text, not markup

`sanitizeHtml` cleans markup you mean to *render*. Text you mean to *show* — a commit
message, a filename, a search query dropped into a template literal — needs `escapeHtml`
from the same module:

```typescript
import { escapeHtml } from '@bundled/yaar';

el.innerHTML = `<li title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</li>`;
```

It always covers `& < > " '`. Three of the six apps that hand-rolled this escaped only
`& < >` — safe in a text node, and not in `title="${…}"`, where a lone `"` ends the
attribute and everything after it is markup. Which context a call site sits in is exactly
what changes when someone edits the template, so there is no cheaper variant worth keeping.
Escaping for an XML *document* is a different grammar (`&apos;` rather than `&#39;`); a
DOCX or SVG serializer keeps its own.

### Two traps that make a sanitizer look like it works

**`USE_PROFILES` overrides `ALLOWED_TAGS`; it does not intersect with it.** Adding
`USE_PROFILES: { html: true }` to a config that already has an explicit `ALLOWED_TAGS`
list *replaces* your list with DOMPurify's much broader HTML profile. A policy that looks
strictly tighter can silently start passing `<form action="//evil"><input name=pw>`. If
you have an explicit `ALLOWED_TAGS`, that alone already confines output to those tags —
SVG and MathML elements are absent by construction.

**Test sanitizers against jsdom or a real browser, never happy-dom.** DOMPurify checks
`isSupported` and silently becomes a no-op when the host DOM is too incomplete, so under
happy-dom a `javascript:` href sails through untouched while happy-dom's own parser drops
benign `<table>`/`<ul>`/`<pre>` wrappers. The result is false passes and false failures in
the same run — a test suite that proves nothing while looking green.

Always assert on what must *not* survive (`<script>`, `<iframe>`, `<object>`, `<form>`,
SVG-wrapped script, `javascript:` URLs, inline `on*=`) **and** on what must survive
(tables, code blocks, images, links). A sanitizer that strips everything passes the first
half of that list perfectly.

## Making HTTP Requests

Use `httpFetch` from `@bundled/yaar`, and declare `yaar://http` in `app.json`.

```typescript
import { httpFetch } from '@bundled/yaar';

const res = await httpFetch('https://api.example.com/items?page=2');
if (!res.ok) throw new Error(`Request failed: ${res.status}`);
const items = await res.json();
```

It is `fetch`. You get a standard `Response` — `json()`, `text()`, `blob()`,
`arrayBuffer()`, and real `Headers` (so upstream rate-limit and session headers stay
readable). Binary bodies survive intact.

What the platform does underneath:

| | Cross-origin | Same-origin / relative |
|---|---|---|
| Route | YAAR's server-side proxy | direct, with the iframe token |
| CORS | not applicable — the server makes the call | normal browser rules |
| Requires `yaar://http` | yes | no |
| Cookies | jar scoped to (session, app) | the iframe's own |

Cross-origin requests are also subject to SSRF validation, the domain allowlist (the
user is prompted once per new domain), a 10 MB response cap, and a 30-second timeout.
`redirect: 'manual'` is honored; `redirect: 'error'` is not representable and falls
back to `'follow'`.

**Declare the permission.** Without `"yaar://http"` in your `app.json` `permissions`,
cross-origin requests are refused with a 403. Both `"yaar://http"` and `"yaar://http/"`
work.

```json
{ "permissions": ["yaar://http"] }
```

**Prefer `httpFetch` over `invoke('yaar://http', …)`.** The verb form returns YAAR's
internal envelope rather than a `Response`, so hand-rolling a type around it re-types an
internal contract you don't own. Keep the verb form for agent-side code, where there is
no `window.fetch` to patch.

**If your app has a login, clear the cookie jar on logout.** Cookies the proxy stores
live server-side, keyed by (session, app), and nothing else clears them until the iframe
token expires — so clearing your own stored session only makes the app *look* logged out
while later requests keep carrying the upstream session.

```typescript
import { del } from '@bundled/yaar';

export async function logout() {
  await clearMyStoredSession();
  await del('yaar://http');   // drop the proxy's cookies for this app
}
```

`del('yaar://http')` clears only the calling app's jar — the key comes from your own
token, never from a payload, so one app cannot log another out.

Service-specific concerns — pagination, rate limiting, JSON-RPC framing, auth refresh —
stay in your app. `httpFetch` normalizes transport only.

## Anti-Patterns

Common mistakes to avoid when building apps:

- **Don't build OAuth clients as compiled apps** — OAuth requires server-side token exchange with a `client_secret`. Instead, build an API-based app (`app.json` + `agent/prompt.md`, no compiled source) where the user provides a personal access token, stored via `invoke('yaar://config/app/{appId}', { config })`.
- **Don't assume external servers are running** — There is no backend at `localhost:3000` or any other port. Apps must be fully self-contained.
- **Don't hand-roll the proxy response envelope** — Use `httpFetch` and the standard `Response` it returns. Declaring your own `{ ok, status, body }` interface around `invoke('yaar://http')` re-types an internal contract you don't own. See [Making HTTP Requests](#making-http-requests).
- **Don't hardcode localhost URLs** — Apps run on whatever host YAAR is served from.
- **Don't swallow a failed save** — `catch { /* ignore */ }` around `appStorage.save()` makes data loss invisible while the UI still says "Saved". Use `appStorage.trySave()` and gate the success UI on its result. See [Never swallow a failed save](#never-swallow-a-failed-save).
- **Don't re-implement SDK helpers** — `errMsg`, `showToast`, `showConfirm`, `showPrompt`, `withLoading`, `tryToast`, `wait`, `safeParseOr`, `sanitizeHtml`, `escapeHtml`, `toWebP`, `downloadBlob`, `blobToDataUrl`, `formatBytes`, `formatDuration`, `formatClock`, `createStaleGuard`, `createPersistedSignal`, `createCollapsiblePanel`, `createAutosave`, `createKeyState` are exported by `@bundled/yaar`; `debounce` by `@bundled/lodash`. Never use native `alert()`/`confirm()`/`prompt()` — they block the page (and any agent driving it); reach for `showToast` where you would have alerted.
- **Don't hand-roll a canvas re-encode** — `toWebP(source, { quality, maxSize })` from `@bundled/yaar` is the bitmap → canvas → `convertToBlob` round-trip, including the check that the encoder did not quietly fall back to PNG and the chunked base64 conversion a storage write needs. It returns `null` (never throws) when the browser cannot do it, so the fallback is `if (!encoded) keepTheOriginal()`. No `@bundled/*` package ships a WebP codec — Chromium already has one; this is the boilerplate around it.
- **Don't put unsanitized HTML in `innerHTML`** — `marked.parse()` does not escape raw HTML, and neither does an RSS feed, a scraped page, or a file read from storage. Run it through `sanitizeHtml` from `@bundled/yaar` first — not `@bundled/dompurify` directly. See [Rendering Untrusted HTML](#rendering-untrusted-html).
- **Don't duck-type JSON you read back** — `readJsonOr` answers "the file is missing" and "the file is garbage" with the same fallback, so a broken app renders as a fresh one. Validate persisted and external JSON with a `@bundled/zod` schema and log the failure. See [Never trust a read either](#never-trust-a-read-either--validate-at-the-boundary).
- **Don't hand-roll a sanitizer** — see [the rule above](#rendering-untrusted-html) for what an element denylist plus `^on` attribute stripping misses.
- **Don't generate inline event attributes** — `setAttribute('onerror', ...)` is stripped by any sanitizer, so the behavior it encodes disappears the moment the pipeline is secured. Use `addEventListener` on the inserted node.

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

Only the first two are injected into a prompt; `SKILL.md` is read on demand or not at all.

There is no append tier — **one file, one meaning.** Without `agent/prompt.md`, the agent gets the generic base prompt, and either way the `protocol.json` manifest is appended: state keys as a name + description list, and each command as a call signature built from its `params` schema — `readFile(path: string|string[], startLine?: number, …)`, with `?` on optional params and enums spelled out as their values. That manifest section is appended regardless of which prompt a given turn uses, so neither the generated prompt nor a hand-written `agent/prompt.md` needs to restate a command's params — one that does will drift from the schema the app actually validates against. `describe()` still returns the full schema when per-param descriptions matter.

All three paths are configurable in `app.json`:

```json
"agent": { "prompt": "agent/prompt.md", "hint": "agent/hint.md", "skill": "agent/SKILL.md" }
```

These are the *defaults*, applied when `agent` is absent, so most apps never need to set the field — only an app relocating its docs does. An absolute or traversing override is ignored in favor of the default: `app.json` is writable by any app holding `yaar-dev`, and these paths become file reads.

**Back-compat:** if `agent/hint.md` is absent, the server falls back to a legacy root `HINT.md` and logs a `[apps]` warning naming the new path. This exists for apps written before the rename (including some market-installed apps) — write new apps at the `agent/` paths.

Root `AGENTS.md` has **no** such fallback, deliberately: it is the coding agent's doc (below), and one file cannot be both an app's architecture notes and its runtime persona. An app that shipped `AGENTS.md` as its prompt gets the generic base plus its manifest, and a `[apps]` notice saying to copy it to `agent/prompt.md` if that is what it meant.

### agent/hint.md (orchestrator context)

Unlike `agent/prompt.md`, which configures the **app agent**, `agent/hint.md` is injected into the **monitor (orchestrator) agent's** system prompt. This tells the orchestrator when to route tasks to the app. Hints auto-sync with installed apps — uninstalling the app removes the hint.

Use this for app-dependent orchestration guidance that would otherwise go stale in a static system prompt. Example:

```markdown
Use the devtools app for all app development tasks. The devtools app agent
is a specialist with direct access to the project filesystem, compiler,
and type checker.
```

### agent/prompt.md (full control)

The agent's entire system prompt is replaced with the contents of `agent/prompt.md`. Use this when:
- The agent needs a specific workflow (e.g., devtools: typecheck → compile → deploy)
- You want to define anti-patterns, gotchas, or domain-specific rules
- The generic prompt's behavior guidelines don't fit

Since `agent/prompt.md` replaces the base prompt, you must document the available tools (`describe`, `query`, `command`, `relay`) yourself if the agent needs to know about them. (`protocol.json`, and a "Controllable Apps" section when `controls` is set, are still appended automatically.)

### agent/SKILL.md (the manual anyone can ask for)

`describe('yaar://apps/{appId}')` returns `protocol.json` verbatim *and* `SKILL.md`, in one payload. Write in `SKILL.md` only what a generated protocol cannot say: the order commands must run in, the workflow that ties three of them together, when *not* to reach for this app.

Never restate a command or state name as a heading or a bullet subject — `describe` returns both documents side by side, so a restatement is a sentence sitting next to the schema it will disagree with after the next deploy. That is why the previous SKILL.md was deleted; returning the two together is what makes the duplication cheap to prohibit, and `bun run check:apps` warns on it (`skill-restates-protocol`, advisory — a name inside a workflow sentence like "run `compile` before `deploy`" is exactly what the file is for, so the check names what it matched and lets you judge).

Not to be confused with the `SKILLS/` directory in [`docs/architecture/shell_to_userland.md`](../architecture/shell_to_userland.md): that is a namespaced set of topics reached by `read('yaar://skills/{appId}/{topic}')`. One file returned by `describe` versus many read on demand — they compose, but the names are one letter apart.

### AGENTS.md (the coding agent's doc)

`AGENTS.md` at the app's root is a different file with a different reader: it's the conventional name a coding agent looks for when *editing* a directory, and devtools is that agent. YAAR reads it for nothing. Put in it what the source cannot say for itself — architecture, invariants, why a thing is hand-rolled, what breaks if you change it. An app of any size wants one; small apps don't need it.

The line between it and `agent/prompt.md` is the reader, not the topic. "`src/gizmo.ts` is hand-rolled because the bundled one drops pointer capture" is `AGENTS.md`. "call `addPrimitive` with `{ kind: 'box' }` before setting a material" is `agent/prompt.md`. Never restate a command signature in either — `protocol.json` is generated and appended automatically, so a hand-written copy is one deploy away from being wrong.

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
| `version` | `string` | Informational |
| `author` | `string` | Informational |
| `run` | `string` | Iframe entry — `dist/index.html`, or a `yaar://apps/{id}/…` URI |
| `kind` | `"system"` | Marks a protected/auto-trusted app. **Bundled apps only** — ignored for installed apps |
| `createShortcut` | `boolean` | `false` hides the app from the launcher (`"hidden": true` is a synonym) |
| `permissions` | `(string \| { uri, verbs? })[]` | Pre-granted URI permissions, e.g. `"yaar://storage/"` or `{ "uri": "yaar://http", "verbs": ["read"] }` |
| `bundles` | `string[]` | Opt in to gated SDKs (`yaar-dev`, `yaar-web`, `yaar-ml`). The compiler rejects the import without it |
| `agentType` | `string` | Override the agent profile used for this app's agent |
| `agent` | `{ prompt?, hint?, skill? }` | Override the default paths (`agent/prompt.md`, `agent/hint.md`, `agent/SKILL.md`) for this app's agent docs |
| `messaging` | `"all"` | Lets the app agent `direct_message` other apps/windows, not just monitor/user |
| `controls` | `(string \| { appId, commands? , background? })[]` | Other apps this app may drive. A target with no window on the caller's monitor gets one opened; `background: true` opens it minimized. **Bundled apps only** |
| `streams` | `string[]` | Streamable sources this app may subscribe to (`"agents"`). **Approved at install** |
| `subagents` | `{ max: number }` | Ceiling on [sub-agents](#sub-agents-personas) this app may spawn per monitor. Clamped to 16; a non-integer or `≤ 0` reads as "none". **Approved at install** |
| `fileAssociations` | `{ extensions, command, paramKey }[]` | Open matching files by invoking a protocol command |
| `variant` | `"widget" \| "panel"` | Window variant |
| `dockEdge` | `"top" \| "bottom"` | Dock the window to a screen edge |
| `frameless` | `boolean` | Drop the window chrome |
| `windowStyle` | `object` | CSS overrides applied to the window |
| `defaultWidth` / `defaultHeight` | `number` | Initial window size in px |

One gotcha that falls out of that leniency:

- `id` and `appId` (`apps/memo`, `apps/mcp-manager`) — the folder name is always the id. The `id` passed to `defineApp()` in your source is a separate thing, *is* used, and must match.

## App Types

### Compiled Apps

Built by the AI: write → compile → deploy. Runs in iframe.

```
apps/falling-blocks/
├── agent/
│   └── prompt.md    # Optional — only if the app needs the agent to know more than its manifest
├── app.json         # { "icon": "🎮", "name": "Falling Blocks" }
├── index.html       # Compiled single HTML
└── src/             # Source code (keepSource: true)
    ├── main.ts
    └── styles.css
```

### API-based Apps

Apps that call external APIs. Describe the API in `agent/prompt.md` and the AI handles the calls.

```
apps/moltbook/
├── app.json
└── agent/
    └── prompt.md    # API endpoints, auth flow, workflows
```

List APIs like `POST /api/v1/posts`, `GET /feed` in `agent/prompt.md`. When a user says "show my feed", the AI calls the API and renders results in a window.

### Manual prompt-only Apps

You can also create apps manually with no compiled source — just `app.json` plus an `agent/prompt.md` in `apps/`.

```
apps/weather/
├── app.json
└── agent/
    └── prompt.md    # API docs, auth, workflows
```

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
  id: 'my-app',            // must equal app.json's appId — the build checks
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

- **`state.get` / `commands.run`** replace `handler`; everything else (`description`,
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
  done }\``. It never rides in the manifest, so the cheap call stays cheap; omit it and the
  static `description` is the answer.
- **`replay`.** The server re-sends recorded commands when a window's iframe remounts.
  Declare `replay: 'never'` on any command whose effect must not be applied twice (appends,
  sends, deletes); omit it for idempotent ones.
- **`view`.** A Solid component is mounted with `render`; an imperative app that owns its own
  DOM passes `{ mount(el) { ... } }` and may return a teardown, which runs on window close
  after `onClose`.
- **`keybindings`.** Declarative keyboard shortcuts, mapping a combo to a declared command
  name: `keybindings: { ArrowRight: 'nextPage', 'Ctrl+s': 'save' }`. The combo grammar is
  `[Ctrl+][Meta+][Alt+][Shift+]Key` with `KeyboardEvent.key` names, case-insensitive;
  `Ctrl` also matches `Cmd`. The bound command runs with no params, so its `params` must be
  absent or all-optional. Dispatch happens inside the iframe while the window has focus;
  combos without Ctrl/Meta/Alt are suppressed when an editable element has focus, so a bare
  `ArrowRight` never steals cursor movement from an input. The build rejects a binding to an
  undeclared command, an unparseable combo, two spellings of one chord, and the shell's
  reserved combos (`Shift+Tab`, `Ctrl+1-9`, `Ctrl+W`, `Ctrl+R`, `F5`). Bindings appear in
  `dist/protocol.json` and the manifest, so agents can tell users about them. For a shortcut
  that needs an argument or does not correspond to a command, use the imperative
  `onShortcut(combo, handler)` from `@bundled/yaar` instead. Both fire discrete actions on
  keydown — for held-key movement (WASD in a game loop), use `createKeyState` instead of
  binding movement commands to keys.
- **Splitting up.** `state`/`commands` maps may live in other modules and be spread in — see
  [Splitting a protocol by domain](#splitting-a-protocol-by-domain). The `export default`
  itself must stay in `src/main.ts`: that is what the build reads back to fold Zod schemas.

`defineApp` is the only way to register: the iframe SDK's registration entry is private and
this is its one caller. A second `defineApp()` in the same window throws rather than silently
overwriting the first.

> **Migrating off `app.register()`.** The low-level `app.register({...})` call and its
> `AppRegistration` / `AppStateDescriptor` / `AppCommandDescriptor` types are gone, as is
> `defineCommand`. An app that still calls `register()` fails the build with the migration in
> the message. To port one: `appId` becomes `id`, each `state` entry's `handler` becomes
> `get`, each command's `handler` becomes `run`, and the whole call becomes the
> `export default` of `src/main.ts`. Registration timing and mounting stop being the app's
> problem — drop any `onMount()` wrapper and any `render()` call of your own.

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

It is a runtime no-op — an identity function — so `dist/protocol.json` and everything the
agent sees are unchanged. It exists purely to make the compiler check `run`.

It accepts a Zod schema (preferred — it also validates the call) or a JSON Schema literal.
From a JSON Schema it infers: `enum` (as a literal union), `string` / `number` / `integer` /
`boolean` / `null`, `array` + `items`, and `object` + `properties` / `required`, nested
arbitrarily. Keys absent from `required` are inferred optional. An `object` with no
`properties` but an `additionalProperties` schema is a dictionary: `{ type: 'object',
additionalProperties: { type: 'string' } }` infers `Record<string, string>`. A bare
`{ type: 'object' }` infers `Record<string, unknown>`.

What it doesn't: `anyOf`, `oneOf`, `$ref` and other keywords infer as `unknown`. Annotate
that `run` parameter explicitly, or leave the command as a plain object literal — descriptors
without the wrapper still reach the manifest exactly the same way, and the two forms mix
freely within one `commands` block.

Keep the call shape literal — `defineAppCommand({ ... })` wrapping an inline object. The
build-time protocol extractor is a source parser, not an evaluator: it steps over a single
identifier call to find the descriptor, and a computed callee fails the build.

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

One inference caveat, and it is silent: `defineApp` derives each `run`'s parameter type from
the `params` schema **at the call site**. A command spread in from another module is
extracted into the manifest exactly as an inline one, but its `run` parameter widens to a
free-form bag — no error, just weaker types. Wrap those descriptors in `defineAppCommand`
(above), annotate the parameters yourself, or keep the commands you want inference for inline
in the `defineApp({...})` literal.

The limit is static resolvability, and it is enforced rather than tolerated: a spread of a
**call result** (`...buildCommands()`), a descriptor imported from an npm package, a
`${...}` template description, or a missing `description` fails the compile with a
`file:line:col`. That is deliberate — a command the extractor skipped would still work at
runtime while being invisible to every agent, which is the one outcome worse than a broken
build.

#### When handlers need a runtime context

Static resolvability and a per-registration context pull in opposite directions: descriptor
maps must be top-level `const`s, so they cannot close over the parameter of a
`registerProtocol(ctx)`, and hoisting them into a `buildCommands(ctx)` factory produces
exactly the call result the extractor refuses. `createProtocolContext` is the seam — the
descriptors stay static, the context is installed at registration time, and handlers reach
it through the accessor:

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

`defineApp` registers before it mounts, so the context is installed *after* registration —
which is fine, because a descriptor only reaches `ctx()` when a command actually runs.

The tradeoff is real and worth stating: the context becomes module state shared by every
descriptor, so this suits an app that registers once per document — which is the normal
case. Both edges are loud rather than silent: `get()` before `set()` throws instead of
returning `undefined`, and `set()` twice with a *different* context throws instead of
quietly retargeting the first registration's handlers.

### Talking Back to the Agent

`defineApp`'s `state`/`commands` are how the agent reads *you*. These three APIs are how you reach the agent. See [`docs/reference/app_protocol_reference.md`](../reference/app_protocol_reference.md) for full signatures.

**`app.sendInteraction(description)`** — push a free-form message to the agent, typically after a user action inside the iframe. Takes a string, or an object with `instructions` and `toMonitor` (route to the monitor agent instead of this window's app agent) plus arbitrary payload fields.

```typescript
app.sendInteraction('User clicked Save');
app.sendInteraction({ instructions: 'Summarize this', toMonitor: true, selection: text });
```

**`app.emit(channel, payload)`** — fire-and-forget event on a channel declared in `defineApp({ events })`. Delivered only to agents that subscribed; undeclared or unsubscribed channels are dropped server-side.

```typescript
defineApp({ /* ... */ events: { 'item-added': { description: 'A new item was added' } } });
app.emit('item-added', { text: 'Buy milk' });
```

**`onClose`** — an optional hook on the `defineApp()` config, invoked when the window is about to be destroyed. Use it to flush unsaved state.

```typescript
defineApp({ /* ... */ onClose: () => saveDraft(editor().value) });
```

**`onCapture`** — an optional hook on the `defineApp()` config, called when the OS captures the window (e.g. an agent reads it). Return a data-URL image to use instead of the default full-window screenshot (DOM + live canvas pixels composited); return `null` to fall back. May be async. Useful when the default capture can't see your content — e.g. a WebGL canvas without `preserveDrawingBuffer`, or state that renders outside the viewport.

```typescript
defineApp({ /* ... */ onCapture: () => sceneCanvas.toDataURL('image/png') });
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `describe('yaar://windows/{id}')` | That window's manual — its live manifest (`source: 'live'`), or the app's on-disk `protocol.json` when the iframe hasn't registered (`source: 'manifest'`) |
| `list('yaar://windows/{id}')` | That window's state keys and commands, as sub-path URIs — each command's description prefixed with its signature |
| `read('yaar://windows/{id}/state/{key}')` | One state value |
| `invoke('yaar://windows/{id}/commands/{key}', { ...params })` | Run one command — the payload *is* its params (`action`, `params` and `timeoutMs` are reserved *unless the command declares one of them*, in which case it is that param). Pass an **array** of params to run it once per element, in order |
| `describe('yaar://windows/{id}/{state,commands}/{key}')` | One key's documentation — the app's computed `describe()` if it has one, else the manifest's description. A command also carries its `signature`, a rendered `invoke` example, and its `schema` |
| `invoke('yaar://windows/{id}', { action: 'app_query', stateKey })` | Read structured data from app by state key (use `"manifest"` to discover capabilities) |
| `invoke('yaar://windows/{id}', { action: 'app_command', command, params })` | Execute a command on the app |
| `invoke('yaar://windows/{id}', { action: 'message', message })` | Send a message to the app agent (monitor → app agent delegation). Fire-and-forget — same code path as user interaction. |

The sub-path spellings and the `action` spellings run the same executor; the first names the key in the URI, the second in the payload. An agent meeting an app for the first time either `describe`s the window or calls `app_query` with a bare window URI (both return the manifest), then reads state and runs commands.

The `message` action lets **monitor agents delegate tasks to app agents** via the window URI. It queues a task through `AppTaskProcessor` exactly like a user `WINDOW_MESSAGE`, creating the app agent on demand if needed. Combine with `subscribe` to get notified when the app agent completes.

### Example: Slides Lite

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

Each app has isolated file storage at `storage/apps/{appId}/`. Apps use `self` as a shorthand — the server resolves it to the real appId from the iframe token.

### From App Code (`@bundled/yaar`)

```typescript
import { appStorage } from '@bundled/yaar';

// Write a file — throws on failure
await appStorage.save('data.json', JSON.stringify({ key: 'value' }));

// Write a file — reports failure and resolves false instead of throwing
const saved = await appStorage.trySave('data.json', JSON.stringify({ key: 'value' }));

// Read as JSON
const data = await appStorage.readJson<{ key: string }>('data.json');

// Read as text
const text = await appStorage.read('data.json');

// Read binary (returns { data, mimeType, encoding: 'base64' | 'text' })
// Check `encoding` before decoding — only base64 payloads should be atob()'d.
// Prefer readBlob(), which handles the branch for you.
const binary = await appStorage.readBinary('image.png');

// List files (returns [{ path, isDirectory, uri, mimeType?, size?, modifiedAt? }])
// Shallow — direct children only. Recurse yourself to walk subdirectories.
const files = await appStorage.list();

// Delete a file
await appStorage.remove('data.json');
```

> **`size` and `modifiedAt` are optional on a listing entry.** A directory has no `size`, and neither field is present if the server predates them. They come from the listing itself, so "how big is this asset" and "which file did I touch last" need no extra read — which is what makes an audit of, say, total inlined asset bytes cheap. `size` is the bytes on disk; a JSON file read back through `readJson` and re-serialized will not match it exactly.

> **`readBlob()` on a PDF does not return the PDF bytes.** `readBlob()` takes no options, so the server's page-rasterization opt-in (`pdfPages`) can never fire through this path; the default branch returns the ASCII string `PDF document with N page(s), N bytes.` wrapped in a Blob (`packages/server/src/storage/storage-manager.ts`). To get raw bytes, fetch the REST URL directly — app-scoped files live at `/api/storage/apps/{appId}/{path}`.

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

`label` names the data in the toast (`Couldn't save draft: …`). Pass `onError` to replace
the toast with your own surface — an inline status line, say. Failures are logged either
way, so `onError` never costs you the console trace:

```typescript
await appStorage.trySave('draft.json', json, {
  onError: (message) => setSaveStateText(`Not saved — ${message}`),
});
```

`createPersistedSignal()` routes its writes through `trySave` and takes the same
`label` / `onError` options, so a signal that stops persisting says so.

Keep `save()` where the caller genuinely handles the throw — propagating to an agent-facing
command handler, for instance, where an `AppCommandError` is the right outcome.

### Never trust a read either — validate at the boundary

The mirror image of a swallowed save is a swallowed *read*. `readJsonOr(path, fallback)`
answers "the file isn't there" and "the file is garbage" with the same value, so this:

```typescript
// Bad — a truncated write, an older build's shape, and a first run are one state.
const prefs = await appStorage.readJsonOr<Prefs>('prefs.json', DEFAULTS);
```

renders a broken app identically to a fresh one, and the user's real preferences are gone
with no trace anywhere. Persisted JSON is **untrusted input**: it was written by an older
version of your app, hand-edited through the storage app, truncated by a crashed write, or
produced by another instance running concurrently. So is anything arriving from an HTTP
response, an SSE frame, a `read()` of a `yaar://config/*` file, a user-picked file, or an
`evaluate()` round-trip through a page.

Validate it with `@bundled/zod` — **Zod Mini**, the functional API (`z.optional(x)`,
`z.safeParse(Schema, value)`), not the method chaining of standard Zod. Put the schemas in
a `src/schema.ts` with a header saying *which* boundaries they guard. Use `z.looseObject`
so a field added by a newer build survives a round-trip through an older one, and validate
only the fields the app actually reads:

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

`safeParseOr` **is** that rule: `undefined` — nothing stored, first run — takes the fallback
silently, while a value that is present and wrong takes the same fallback and logs the
schema's own issues. It was the single most-copied block in the fleet (82 `safeParse` call
sites across 22 apps), which is why it now lives in the SDK.

When logging is *not* the right answer at that boundary, pass `onInvalid` — it receives the
schema's issues and runs **instead of** the default console line:

```typescript
// The call must fail rather than degrade: an onInvalid that throws reaches the
// caller, so a parse-or-throw boundary needs no separate helper.
return safeParseOr(ResponseSchema, await res.json(), undefined, {
  onInvalid: (issues) => {
    console.error(`GET ${path} failed validation`, issues);
    throw new Error('The service returned an unexpected response.');
  },
});

// A poll: one line per tick is how a real signal gets tuned out.
safeParseOr(StateSchema, stored, undefined, { onInvalid: () => noteSyncFailure() });

// The fallback would mislead — an empty allow-list looks like a valid one.
safeParseOr(DomainsSchema, raw, undefined, {
  onInvalid: (issues) => { console.error(issues); showToast('Config is malformed', 'error'); },
});
```

Write the `z.safeParse` by hand only when the failure branch needs something the single
fallback cannot express — per-field recovery, or validating an array element-wise so one
bad row does not reject the rest.

The rule is one line: **degraded-by-design must be distinguishable from broken.** A missing
file is normal and stays silent; a malformed one is logged with `parsed.error.issues`, and
toasted if the user would otherwise be misled about what they are looking at. Never toast
from a poll or a subscription callback — log every failure, but surface only the
*transition* into failure, or you replace one silent bug with a wall of toasts.

For anything persisted through `createPersistedSignal`, `revive` is where the `safeParse`
goes — it runs on the loaded value before it reaches the signal, and the SDK logs (never
swallows) if it throws. Two things to get right there: it also runs on the **fallback**
when nothing is stored, so a schema the fallback itself fails will fire an error on every
fresh install; and `revive` validates and migrates, it does not *reinterpret* — clamping a
stored value against the current window belongs on the read, not on the load, or a
transiently narrow window overwrites the user's preference for good.

When the parse fails, prefer per-field recovery over rejecting the whole record if the
fields are independent: a drifted `playbackRate` should not cost the user their
`lastStoragePath`. Reject wholesale only when the fields are load-bearing together.

### Error handling helpers

`@bundled/yaar` ships the small helpers apps otherwise rewrite. Prefer them over inlining:

```typescript
import { errMsg, showToast, withLoading, tryToast, wait, createStaleGuard, AppCommandError } from '@bundled/yaar';

errMsg(e);                       // not: e instanceof Error ? e.message : String(e)
showToast('Deleted', 'success'); // 'info' | 'success' | 'error', auto-dismissing
await wait(200);                 // not: new Promise(r => setTimeout(r, 200))

// A slow response must never overwrite a newer one — not: a hand-rolled `gen` counter.
const guard = createStaleGuard();
const fresh = guard.begin();
const data = await load();
if (!fresh()) return;

// Sets loading true, runs fn, routes a throw to onError, always clears loading.
await withLoading(setLoading, () => fetchIssues(), (msg) => showToast(msg, 'error'));

// The whole try/catch/log/toast block: returns the value, or undefined if it threw.
await tryToast(() => deleteRepo(name), { success: 'Deleted' });

// Throw from a command handler to report failure to the agent.
throw new AppCommandError('No document open');
```

`withLoading` and `tryToast` are orthogonal — one owns a loading flag, the other owns the
error toast. Nest them when an action needs both: `withLoading(setBusy, () => tryToast(...))`.

`debounce` / `throttle` come from `@bundled/lodash` — don't hand-roll them.

### Formatting and file helpers

Three renderings must not disagree between two windows on one screen, so they are SDK
functions rather than a per-app choice — the audit that added them found four byte
formatters with four unit ladders and six clock formatters, half of them hardcoding a
locale the user never picked:

```typescript
import { formatBytes, formatDuration, formatClock, downloadBlob, blobToDataUrl } from '@bundled/yaar';

formatBytes(2_097_152);          // '2.0 MB'  — binary steps, one decimal above bytes
formatDuration(3787);            // '1:03:07' — hours only when there are hours
formatClock(Date.now());         // '15:04:05' — 24-hour, locale separators
formatClock(savedAt, { seconds: false });  // '15:04', for a "Saved 15:04" label

downloadBlob(new Blob([csv]), 'report.csv');   // objectURL + <a download> + revoke
const dataUrl = await blobToDataUrl(file);     // FileReader, promisified
```

Calendar *dates* are deliberately not here — date style is a legitimate per-app choice, and
`@bundled/date-fns` is bundled for it. For an image you are about to store or show, prefer
`toWebP` over `blobToDataUrl`: it re-encodes and hands back both the data URL and the raw
base64 that `appStorage.save(..., 'base64')` wants.

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

For custom modals beyond these, compose the same classes yourself: `y-overlay` >
`y-modal` > `y-modal-title` / `y-modal-msg` / `y-modal-actions`.

### From Agent (MCP Tools)

```
invoke('yaar://apps/my-app/storage/data.json', { action: 'write', content: '...' })
read('yaar://apps/my-app/storage/data.json')
list('yaar://apps/my-app/storage/')
describe('yaar://apps/my-app/storage/data.json')
delete('yaar://apps/my-app/storage/data.json')
```

`describe` on a storage path describes **that path**: an error when it isn't there, `{ kind: 'directory', entries, totalSize, verbs }` for a folder, `{ kind: 'file', size, modifiedAt, mimeType, verbs }` for a file (a PDF adds its page count and the `pdfText` / `pdfPages` read options). The bare `…/storage` root is the exception — it answers with the app-storage manual plus a root entry count, which is what a caller landing there is actually asking. The same shape answers for `yaar://storage/…`; they are two spellings of one directory tree.

A `list` of a directory that does not exist is an **error**, not an empty success — the two used to be indistinguishable. A namespace root is the exception both ways: an app's `storage/` exists from the moment the app does (the directory is only created by the first write), so listing it before anything is written is empty rather than missing.

## App-Scoped Database (`appDb`)

For structured records, each app also gets a SQLite database at `storage/apps/{appId}/data.db`
(design: [`docs/guides/sqlite.md`](./sqlite.md)). Unlike `appStorage`, it supports queries,
counting, pagination, and full-text search server-side — no more load-all-JSON-and-filter.
Binary blobs and simple single files should stay on `appStorage` — see the design doc above for the full storage-type breakdown.

No permission declaration needed — an app's own storage, database, and personas are
granted to it automatically.

### From App Code (`@bundled/yaar`)

```typescript
import { appDb } from '@bundled/yaar';

interface Note { title: string; tags: string[] }
const notes = appDb.collection<Note>('notes');

const id = await notes.insert({ title: 'Hello', tags: ['intro'] }); // → generated _id
await notes.insertMany([{ title: 'A', tags: [] }, { title: 'B', tags: [] }]);

const one = await notes.get(id);                    // → doc | null (has _id, _created_at, _updated_at)
const page = await notes.find(
  { tags: 'intro' },                                // filter (see syntax below)
  { sort: { _created_at: -1 }, limit: 20, offset: 0 },
);
const hits = await notes.search('hello world');     // FTS5 full-text search, best matches first

await notes.update(id, { title: 'Updated' });       // shallow merge
await notes.remove(id);
await notes.removeWhere({ tags: 'draft' });         // filter must be non-empty
const n = await notes.count({ tags: 'intro' });

await appDb.collections();                          // → ['notes', ...]
await appDb.drop('notes');                          // delete collection + documents
```

**Filter syntax** (Mongo-style, fields AND together):

```typescript
{ status: 'active' }                 // exact match
{ tags: 'intro' }                    // array contains (same syntax as scalar equality)
{ age: { $gt: 18 } }                 // $gt / $gte / $lt / $lte
{ name: { $ne: 'admin' } }           // not equal (also matches docs missing the field)
{ kind: { $in: ['a', 'b'] } }        // one of
{ avatar: { $exists: true } }        // field presence
{ 'author.name': 'kim' }             // dotted paths reach into nested objects
```

**Reactive binding** — a Solid signal that tracks a query:

```typescript
const [docs, { insert, update, remove, refresh }] = appDb.createReactiveCollection<Note>(
  'notes',
  { sort: { _created_at: -1 }, limit: 50 },
);
// docs() re-renders on mutations made through these helpers; external changes
// (agent, another window) arrive via a verb subscription.
```

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

An app that declares `"subagents": { "max": N }` can spawn up to N AI instances from
its iframe, each with a system prompt the app supplies at runtime and each its own provider
session with its own conversation memory. This is what lets one app run several distinct
characters *at once* instead of one agent role-playing them in turn.

They are the bottom tier of [the agent tree](../architecture/agent_tree.md): they hold **no YAAR
verbs, no permissions, and no principal**, so a runtime-supplied prompt never gets YAAR's hands.
Full verb surface, limits, and response shapes: [URI Reference](../reference/uri_reference.md#app-sub-agents--yaarappsselfagents).

```jsonc
{
  "subagents": { "max": 4 },  // the manifest key; the wire still says personaId
  "streams": ["agents"]       // required to watch them
}
```

The `yaar://apps/self/` namespace is auto-granted — no `permissions` entry.

> **`"personas"` is retired.** It was an accepted alias for `subagents` and is no longer read.
> The *wire* is unchanged — `personaId` in the URI, the spawn param, and every response body — so
> only `app.json` changes. A manifest still using the old key logs an `[apps]` warning at read and
> refuses spawns with a message naming the rename, rather than behaving as if nothing was declared.

**Both lines are requests, not grants, for an app that was installed rather than bundled.** A
bundled manifest ships with the release and is honored as written. An installed app's is itemized
in the install dialog ("run up to 4 AI personas of its own…"), and the user's answer is recorded in
`config/app-grants.json` and applied as a **ceiling** — raise `max` in a later manifest and you get
the granted number until the user approves the new one. So a market app that declares `subagents` gets
them, but only once someone said yes; an app already installed before this existed holds nothing
until it is updated or reinstalled. (`controls` is different, and still bundled-only.)

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

- **Await the stream, not the verb.** `message` resolves when the turn is queued, so the answer
  only exists on the stream. Give each turn a watchdog: a character that never produces a frame
  should cost one slow turn, not hang the room.
- **Spawn is idempotent, and deliberately does not update the prompt.** An iframe reload re-runs
  your spawn calls; the personas from before are still alive with their memory intact and come
  back with `reused: true`. Since the prompt is replayed every turn, rewriting it under a live
  conversation would rewrite who the persona has been all along — `delete` and respawn to recast.
- **`message` rejects rather than queues while a persona is mid-turn.** The refusal carries
  `busy: true` on the envelope. Your app is the scheduler; only it knows whether a second
  message is a follow-up worth waiting for or a race worth dropping.

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

Alice calling `memorize` dispatches the protocol command `persona:memorize` to your app's active
window with params `{ fact, personaId: 'alice' }` — the server stamps `personaId` **last**, so a
model cannot answer as another character. Whatever your handler returns becomes the tool result:

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

`persona:*` commands are hidden from the app agent's `describe`/manifest — their spawn-time
descriptions are written for a character, not an operator, and one description string cannot
serve both audiences.

Why tools rather than output sentinels: a `skip` tool *is* the signal, where `[[skip]]` in the
text is a parse hoping to be one. And a lookup like `recall` cannot be a sentinel at all — it
needs its result fed back mid-generation, which only the tool loop provides.

Limits and edges: 12 tools, 6 000 chars across all names/descriptions (they are replayed every
turn), 20 000 chars of system prompt. Tool names match `[A-Za-z][A-Za-z0-9_]{0,47}`; `input`
values are `"string" | "number" | "boolean" | "object" | "array"`. No open window makes a tool
call return an **error result** — the turn continues, and a persona deciding to remember
something never launches a window. Omitting `tools` connects no MCP server at all.

### Lifecycle and persistence

Sub-agents are reclaimed when your app's last window on that monitor closes, when the monitor is
removed, or on explicit `delete` — and none survive the session. **Persistence is your app's
job** (`appDb`/`appStorage`); a respawned persona gets its history replayed in its system prompt
or first message. `subagents.max` is per (monitor, app) and clamped to 16; each persona also takes
a global `MAX_AGENTS` slot, so `spawn` can fail with "no provider slot" even under your own cap.

**Reference consumer:** `chitchats`, which now ships from the market rather than `apps/` (rooms
that take turns; characters get `skip`, `memorize`, and — when their memory file has chunks —
`recall`, whose description carries the memory index so the backstory is retrieved rather than
replayed every turn). Being a market app it holds `subagents` by the user's install-time approval
rather than by shipping in the tree.
