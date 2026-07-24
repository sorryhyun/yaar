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

See the devtools app's `SKILL.md` for the full list of available commands.

### Apps — `yaar://apps/`

| Verb | URI | Description |
|------|-----|-------------|
| `list` | `yaar://apps` | List all installed apps |
| `describe` | `yaar://apps/{appId}` | Metadata + protocol manifest (capabilities) |
| `read` | `yaar://apps/{appId}` | Load an app's SKILL.md (manifest appended) |
| `invoke` | `yaar://apps/{appId}`, `{ action, ... }` | Run an app action (see below) |
| `delete` | `yaar://apps/{appId}` | Uninstall app |

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
| `read` | `yaar://skills/{topic}` | Load reference docs (`components`, `config`, `marketplace`) |

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
- Auto-generates `SKILL.md` and `app.json`
- Icon appears on desktop immediately
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

Available via `@bundled/*` imports — no npm install needed. The authoritative list is `BUNDLED_LIBRARIES` in `packages/compiler/src/plugins.ts`, also served at `GET /api/dev/bundled-libraries`.

| Library | Import Path | Purpose |
|---------|------------|---------|
| solid-js | `@bundled/solid-js` | Reactive UI (createSignal, createEffect, Show, For, etc.) |
| solid-js/html | `@bundled/solid-js/html` | `html` tagged templates (no JSX) |
| solid-js/web | `@bundled/solid-js/web` | `render`, DOM helpers |
| solid-js/store | `@bundled/solid-js/store` | Nested reactive stores (`createStore`) |
| uuid | `@bundled/uuid` | ID generation |
| lodash | `@bundled/lodash` | Utilities (debounce, cloneDeep, groupBy, etc.) |
| date-fns | `@bundled/date-fns` | Date handling |
| clsx | `@bundled/clsx` | CSS class composition |
| anime.js | `@bundled/anime` | Animation |
| Konva | `@bundled/konva` | 2D canvas graphics |
| Three.js | `@bundled/three` | 3D graphics |
| cannon-es | `@bundled/cannon-es` | 3D physics engine |
| xlsx | `@bundled/xlsx` | Spreadsheet parsing/generation |
| Chart.js | `@bundled/chart.js` | Charts and graphs |
| D3 | `@bundled/d3` | Data visualization |
| Matter.js | `@bundled/matter-js` | 2D physics engine |
| Tone.js | `@bundled/tone` | Audio/music synthesis |
| PixiJS | `@bundled/pixi.js` | 2D WebGL rendering |
| p5.js | `@bundled/p5` | Creative coding |
| marked | `@bundled/marked` | Markdown → HTML |
| Prism | `@bundled/prismjs` | Syntax highlighting |
| DOMPurify | `@bundled/dompurify` | HTML sanitization (required for untrusted rich content) |
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

The skeleton is intentionally a **snippet, not a component** — the SDK never ships `solid-js/html` templates, because a shared component's props would ossify across every consuming app and drag Solid rendering into the SDK's type surface. The chrome you copy is short and yours to edit.

### Headless behavior primitives

Two state machines that document apps kept re-implementing now live in `@bundled/yaar` as **headless** primitives — they return state and handlers, and your app owns the markup. Both are tree-shaken, so apps that don't import them pay nothing.

**`createCollapsiblePanel`** — the hover-expand + pin sidebar/overlay. Visible while pinned or hovered, with a grace period before folding so a brief cursor exit doesn't flicker it shut; pin state persists to `appStorage` when `pinKey` is given, and `setResizing(true)` suppresses auto-close while a width handle is dragged.

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

For plain persistence without a save-status machine, `createPersistedSignal` (a Solid signal auto-synced to `appStorage` through `trySave`) is the lighter choice.

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
through `@bundled/dompurify` before it reaches the DOM. Apps run in an iframe, but that
iframe holds the app's own storage, credentials, and protocol channel to its agent; an
injected script owns all of it.

Every rich-content pipeline follows this order:

1. parse the Markdown or source content;
2. **sanitize the complete fragment**;
3. perform app-specific DOM rewrites on the sanitized fragment;
4. insert the result;
5. attach behavior with event listeners — never inline event attributes.

```typescript
import DOMPurify from '@bundled/dompurify';

const clean = DOMPurify.sanitize(marked.parse(source) as string);
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

`DOMPurify.sanitize(dirty)` with no options is the default policy, matching the OS shell's
own Markdown and HTML renderers. Pass an options object only when the content type
genuinely needs a different allowlist — a printable document needs inline `style` that
prose rendering does not — and comment the reasoning next to it.

Do not hand-roll a sanitizer. Element denylists and `^on` attribute stripping miss
`<svg>`/`<math>` mutation-XSS, `srcset`, `formaction`, and `xlink:href`.

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
{ "permissions": ["yaar://apps/self/storage/", "yaar://http"] }
```

**Prefer `httpFetch` over `invoke('yaar://http', …)`.** The verb form returns YAAR's
internal envelope rather than a `Response`, and every app that reached for it ended up
hand-writing its own partial copy of that envelope's type — four mutually incompatible
ones across the repo, for a single upstream contract. Keep the verb form for agent-side
code, where there is no `window.fetch` to patch.

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

- **Don't build OAuth clients as compiled apps** — OAuth requires server-side token exchange with a `client_secret`. Instead, build an API-based app (SKILL.md only) where the user provides a personal access token, stored via `invoke('yaar://config/app/{appId}', { config })`.
- **Don't assume external servers are running** — There is no backend at `localhost:3000` or any other port. Apps must be fully self-contained.
- **Don't hand-roll the proxy response envelope** — Use `httpFetch` and the standard `Response` it returns. Declaring your own `{ ok, status, body }` interface around `invoke('yaar://http')` re-types an internal contract you don't own. See [Making HTTP Requests](#making-http-requests).
- **Don't hardcode localhost URLs** — Apps run on whatever host YAAR is served from.
- **Don't swallow a failed save** — `catch { /* ignore */ }` around `appStorage.save()` makes data loss invisible while the UI still says "Saved". Use `appStorage.trySave()` and gate the success UI on its result. See [Never swallow a failed save](#never-swallow-a-failed-save).
- **Don't re-implement SDK helpers** — `errMsg`, `showToast`, `showAlert`, `showConfirm`, `showPrompt`, `withLoading`, `wait` are exported by `@bundled/yaar`; `debounce` by `@bundled/lodash`. Never use native `alert()`/`confirm()`/`prompt()` — they block the page (and any agent driving it).
- **Don't put unsanitized HTML in `innerHTML`** — `marked.parse()` does not escape raw HTML, and neither does an RSS feed, a scraped page, or a file read from storage. Run it through `@bundled/dompurify` first. See [Rendering Untrusted HTML](#rendering-untrusted-html).
- **Don't hand-roll a sanitizer** — an element denylist plus `^on` attribute stripping looks complete and isn't: it misses `<svg>`/`<math>` mutation-XSS, `style`, `srcset`, `formaction`, and `xlink:href`.
- **Don't generate inline event attributes** — `setAttribute('onerror', ...)` is stripped by any sanitizer, so the behavior it encodes disappears the moment the pipeline is secured. Use `addEventListener` on the inserted node.

### Right Pattern for External Service Integration

```
Option A: API-based app (preferred for API wrappers)
  apps/recent-papers/SKILL.md → describes the arXiv API, query flow
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

Each app gets its own **app agent** when a user interacts with it. The agent's system prompt is built from files in the app's directory:

| File | Role | When to use |
|------|------|-------------|
| `SKILL.md` | Appended to a generic base prompt | Most apps — add API docs, usage instructions, domain context |
| `AGENTS.md` | **Replaces** the generic base prompt entirely | Apps needing precise agent behavior (e.g., devtools IDE) |
| `HINT.md` | Injected into the **monitor agent's** system prompt | Routing hints so the orchestrator knows when/how to use the app |

**Priority:** `AGENTS.md` > `SKILL.md`. If both exist, only `AGENTS.md` is used. The `protocol.json` manifest (available state keys and commands) is always appended regardless.

### HINT.md (orchestrator context)

Unlike `SKILL.md` and `AGENTS.md` which configure the **app agent**, `HINT.md` is injected into the **monitor (orchestrator) agent's** system prompt. This tells the orchestrator when to route tasks to the app. Hints auto-sync with installed apps — uninstalling the app removes the hint.

Use this for app-dependent orchestration guidance that would otherwise go stale in a static system prompt. Example:

```markdown
Use the devtools app for all app development tasks. The devtools app agent
is a specialist with direct access to the project filesystem, compiler,
and type checker.
```

### SKILL.md (default)

The agent gets a generic prompt ("You are an AI assistant for the X app...") with `SKILL.md` content appended under an "App Documentation" heading. Good for apps where the default tool behavior (describe, query, command, relay) is sufficient and you just need to add domain knowledge.

### AGENTS.md (full control)

The agent's entire system prompt is replaced with the contents of `AGENTS.md`. Use this when:
- The agent needs a specific workflow (e.g., devtools: typecheck → compile → deploy)
- You want to define anti-patterns, gotchas, or domain-specific rules
- The generic prompt's behavior guidelines don't fit

Since `AGENTS.md` replaces the base prompt, you must document the available tools (`describe`, `query`, `command`, `relay`) yourself if the agent needs to know about them. (`protocol.json`, and a "Controllable Apps" section when `controls` is set, are still appended automatically.)

### Example structure

```
apps/my-app/
├── AGENTS.md       # Full custom agent prompt (optional, advanced)
├── SKILL.md        # App documentation (optional, simpler)
├── HINT.md         # Monitor agent routing hint (optional)
├── app.json        # Metadata, permissions, protocol manifest
├── index.html      # Compiled app (if compiled)
└── src/            # Source code (if compiled)
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
| `messaging` | `"all"` | Lets the app agent `direct_message` other apps/windows, not just monitor/user |
| `controls` | `(string \| { appId, commands? })[]` | Other apps this app may drive. **Bundled apps only** |
| `fileAssociations` | `{ extensions, command, paramKey }[]` | Open matching files by invoking a protocol command |
| `variant` | `"widget" \| "panel"` | Window variant |
| `dockEdge` | `"top" \| "bottom"` | Dock the window to a screen edge |
| `frameless` | `boolean` | Drop the window chrome |
| `windowStyle` | `object` | CSS overrides applied to the window |
| `defaultWidth` / `defaultHeight` | `number` | Initial window size in px |

**Ignored fields seen in the wild** — these parse as unknown keys and do nothing:

- `capture` (`"dom"` / `"canvas"`) — present in 19 bundled apps, read by no current code. It once named a screenshot strategy for a `window.capture` tool that has since been removed; the manifest field outlived it.
- `id` and `appId` (`apps/memo`, `apps/music-maker`) — the folder name is always the id. The `appId` passed to `app.register()` in your source is a separate thing and *is* used.

## App Types

### Compiled Apps

Built by the AI: write → compile → deploy. Runs in iframe.

```
apps/falling-blocks/
├── SKILL.md        # Launch instructions (auto-generated)
├── app.json        # { "icon": "🎮", "name": "Falling Blocks" }
├── index.html      # Compiled single HTML
└── src/            # Source code (keepSource: true)
    ├── main.ts
    └── styles.css
```

### API-based Apps

Apps that call external APIs. Describe the API in SKILL.md and the AI handles the calls.

```
apps/moltbook/
└── SKILL.md        # API endpoints, auth flow, workflows
```

List APIs like `POST /api/v1/posts`, `GET /feed` in SKILL.md. When a user says "show my feed", the AI calls the API and renders results in a window.

### Manual SKILL.md Apps

You can also create apps manually. Just put a `SKILL.md` in `apps/`.

```
apps/weather/
└── SKILL.md    # API docs, auth, workflows
```

## App Protocol

Compiled apps can communicate bidirectionally with AI agents via the **App Protocol**. Apps declare their capabilities (state queries, commands) in a manifest, and the agent discovers them at runtime to read state or execute commands.

```
Agent → MCP tool → WebSocket → postMessage → Iframe App
Iframe App → postMessage → WebSocket → MCP tool returns
```

### Registering in Your App

Import `app` and `defineCommand` from `@bundled/yaar` and call `app.register()` with state handlers and command handlers.

```typescript
// src/store.ts
import { createSignal } from '@bundled/solid-js';
export const [items, setItems] = createSignal<string[]>([]);

// src/protocol.ts
import { app, defineCommand } from '@bundled/yaar';
import { items, setItems } from './store';

export function registerProtocol() {
  app.register({
    appId: 'my-app',
    name: 'My App',
    state: {
      items: {
        description: 'Current list of items',
        handler: () => [...items()],  // read signal, return copy
      },
    },
    commands: {
      addItem: defineCommand({
        description: 'Add an item',
        params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        handler: (p) => {                 // p is inferred as { text: string }
          setItems([...items(), p.text]); // immutable signal write, no render() needed
          return { ok: true };
        },
      }),
    },
  });
}
```

### Typing the registration — `AppRegistration` and friends

`@bundled/yaar` exports the authoring shapes so you don't have to reverse-engineer them
from a runtime failure: `AppRegistration`, `AppStateDescriptor`, `AppCommandDescriptor`,
`AppEventDescriptor`. Annotate a top-level `const` (the extractor follows it) to get
completion and a compile-time error naming any missing field:

```typescript
import { app, type AppRegistration } from '@bundled/yaar';

const registration: AppRegistration = {
  appId: 'my-app',
  name: 'My App',
  state: { items: { description: 'Current items', handler: () => [...items()] } },
  commands: {},
};
//    ^ tsc: a state descriptor missing `handler`, or a registration missing
//      `appId`/`name`, is flagged here — not at runtime.

app.register(registration);
```

`AppStateDescriptor` is the handler-carrying authoring shape — do **not** import the
same-named type from `@yaar/shared`, which is the handler-less *wire manifest* type.

At runtime, `app.register()` also validates the shape and throws an error naming the exact
missing field (e.g. `state["items"] is missing required field "handler"`), so a malformed
registration fails loudly at registration time instead of much later on first invocation.

### `defineCommand` — infer the handler's params from the schema

A command declares its parameter shape twice: once as the `params` JSON Schema the
agent reads, once as the handler's TypeScript type. Nothing keeps the two in sync, so
`handler: (p: { text: string })` will happily compile against a schema that says
`content`, and the mismatch only shows up when an agent calls the command.

`defineCommand` derives the handler's parameter type from the schema, making the schema
the single source of truth:

```typescript
addItem: defineCommand({
  description: 'Add an item',
  params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  handler: (p) => setItems([...items(), p.txt]),
  //                                       ^^^ compile error: did you mean 'text'?
})
```

It is a runtime no-op — an identity function — so `dist/protocol.json` and everything the
agent sees are unchanged. It exists purely to make the compiler check the handler.

What it infers: `enum` (as a literal union), `string` / `number` / `integer` / `boolean` /
`null`, `array` + `items`, and `object` + `properties` / `required`, nested arbitrarily.
Keys absent from `required` are inferred optional. An `object` with no `properties` but an
`additionalProperties` schema is a dictionary: `{ type: 'object', additionalProperties: {
type: 'string' } }` infers `Record<string, string>`. A bare `{ type: 'object' }` infers
`Record<string, unknown>`.

What it doesn't: `anyOf`, `oneOf`, `$ref` and other keywords infer as `unknown`. Annotate
that handler's parameter explicitly, or leave the command as a plain object literal —
descriptors without `defineCommand` still work exactly as before, and the two forms mix
freely within one `commands` block.

Keep the call shape literal — `defineCommand({ ... })` wrapping an inline object. The
build-time protocol extractor is a source parser, not an evaluator: it steps over a single
identifier call to find the descriptor, and a computed callee fails the build.

#### Splitting a protocol by domain

A `commands` or `state` map may be assembled from descriptor maps that live in other files.
The extractor follows relative imports and spreads, so this reaches `dist/protocol.json`
intact:

```typescript
// src/commands/files.ts
export const fileCommands = {
  readFile: defineCommand({ description: 'Read a file', params: { ... }, handler }),
};

// src/protocol.ts
import { fileCommands } from './commands/files';
import { gitCommands } from './commands/git';

app.register({
  appId: 'devtools',
  commands: { ...fileCommands, ...gitCommands },
});
```

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
  setDeck: defineCommand({
    description: 'Replace the whole deck',
    params: { ... },
    handler: (p) => ctx().setDeck(p.deck),
  }),
};

// src/protocol.ts
export function registerProtocol(context: ProtocolContext) {
  setProtocolContext(context); // before app.register()
  app.register({ appId: 'slides-lite', commands: { ...deckCommands } });
}
```

The tradeoff is real and worth stating: the context becomes module state shared by every
descriptor, so this suits an app that registers once per document — which is the normal
case. Both edges are loud rather than silent: `get()` before `set()` throws instead of
returning `undefined`, and `set()` twice with a *different* context throws instead of
quietly retargeting the first registration's handlers.

### Talking Back to the Agent

`app.register()` is how the agent reads *you*. These three APIs are how you reach the agent. See [`docs/reference/app_protocol_reference.md`](../reference/app_protocol_reference.md) for full signatures.

**`app.sendInteraction(description)`** — push a free-form message to the agent, typically after a user action inside the iframe. Takes a string, or an object with `instructions` and `toMonitor` (route to the monitor agent instead of this window's app agent) plus arbitrary payload fields.

```typescript
app.sendInteraction('User clicked Save');
app.sendInteraction({ instructions: 'Summarize this', toMonitor: true, selection: text });
```

**`app.emit(channel, payload)`** — fire-and-forget event on a channel declared in `app.register({ events })`. Delivered only to agents that subscribed; undeclared or unsubscribed channels are dropped server-side.

```typescript
app.register({ /* ... */ events: { 'item-added': { description: 'A new item was added' } } });
app.emit('item-added', { text: 'Buy milk' });
```

**`onClose`** — an optional hook on the `app.register()` config, invoked when the window is about to be destroyed. Use it to flush unsaved state.

```typescript
app.register({ /* ... */ onClose: () => saveDraft(editor().value) });
```

**`onCapture`** — an optional hook on the `app.register()` config, called when the OS captures the window (e.g. an agent reads it). Return a data-URL image to use instead of the default full-window screenshot (DOM + live canvas pixels composited); return `null` to fall back. May be async. Useful when the default capture can't see your content — e.g. a WebGL canvas without `preserveDrawingBuffer`, or state that renders outside the viewport.

```typescript
app.register({ /* ... */ onCapture: () => sceneCanvas.toDataURL('image/png') });
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `invoke('yaar://windows/{id}', { action: 'app_query', key })` | Read structured data from app by state key (use `"manifest"` to discover capabilities) |
| `invoke('yaar://windows/{id}', { action: 'app_command', command, params })` | Execute a command on the app |
| `invoke('yaar://windows/{id}', { action: 'message', message })` | Send a message to the app agent (monitor → app agent delegation). Fire-and-forget — same code path as user interaction. |

The agent first calls `app_query` with a bare window URI to discover capabilities (manifest), then uses `app_query` and `app_command` with resource URIs to interact.

The `message` action lets **monitor agents delegate tasks to app agents** via the window URI. It queues a task through `AppTaskProcessor` exactly like a user `WINDOW_MESSAGE`, creating the app agent on demand if needed. Combine with `subscribe` to get notified when the app agent completes.

### Example: Slides Lite

```
invoke('yaar://windows/slides-lite', { action: 'app_query' })
invoke('yaar://windows/slides-lite', { action: 'app_query', key: 'slideCount' })
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

// List files (returns [{ path, isDirectory, uri, mimeType }])
// Shallow — direct children only. Recurse yourself to walk subdirectories.
const files = await appStorage.list();

// Delete a file
await appStorage.remove('data.json');
```

> **`list()` returns no `size` or `modifiedAt`.** Each entry is `{ path, isDirectory, uri, mimeType }`. If you need file sizes or timestamps, use the REST API (`GET /api/storage/{dir}/?list=true`), which returns `StorageEntry` objects with `size` and `modifiedAt`.

> **`readBlob()` on a PDF returns the first page rendered as PNG, not the PDF bytes.** The server converts PDFs to page images on read (`packages/server/src/handlers/apps.ts`). To get raw bytes, fetch the REST URL directly — app-scoped files live at `/api/storage/apps/{appId}/{path}`.

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

### Error handling helpers

`@bundled/yaar` ships the small helpers apps otherwise rewrite. Prefer them over inlining:

```typescript
import { errMsg, showToast, withLoading, wait, AppCommandError } from '@bundled/yaar';

errMsg(e);                       // not: e instanceof Error ? e.message : String(e)
showToast('Deleted', 'success'); // 'info' | 'success' | 'error', auto-dismissing
await wait(200);                 // not: new Promise(r => setTimeout(r, 200))

// Sets loading true, runs fn, routes a throw to onError, always clears loading.
await withLoading(setLoading, () => fetchIssues(), (msg) => showToast(msg, 'error'));

// Throw from a command handler to report failure to the agent.
throw new AppCommandError('No document open');
```

`debounce` / `throttle` come from `@bundled/lodash` — don't hand-roll them.

### Dialog helpers

Never use native `alert()` / `confirm()` / `prompt()` — they look foreign, block the whole
page, and freeze any agent driving the browser. `@bundled/yaar` ships promise-based
replacements styled with the built-in `y-modal` classes (Escape cancels, Enter confirms,
backdrop click dismisses):

```typescript
import { showAlert, showConfirm, showPrompt } from '@bundled/yaar';

await showAlert('Export finished.', { title: 'Export' });

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
delete('yaar://apps/my-app/storage/data.json')
```

## App-Scoped Database (`appDb`)

For structured records, each app also gets a SQLite database at `storage/apps/{appId}/data.db`
(design: [`docs/guides/sqlite.md`](./sqlite.md)). Unlike `appStorage`, it supports queries,
counting, pagination, and full-text search server-side — no more load-all-JSON-and-filter.
Binary blobs and simple single files should stay on `appStorage`; the two coexist.

Requires `"yaar://apps/self/db/"` in the app's `app.json` permissions.

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
