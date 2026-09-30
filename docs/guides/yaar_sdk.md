# Building Apps with the YAAR SDK

How to write a YAAR app against `@bundled/yaar`: the entrypoint, the libraries, storage, HTTP,
untrusted content, and talking to the agent. This is a how-to; the precise shapes live in the
references it links, and are not restated here.

Inside YAAR, apps are built by an agent through the **devtools** app. Its agent docs
([`apps/devtools/agent/prompt.md`](../../apps/devtools/agent/prompt.md) and
[`apps/devtools/agent/docs/`](../../apps/devtools/agent/docs/)) are the agent-facing counterpart
of this guide; a rule that belongs in both is stated in both, once per reader.

| For | Read |
|---|---|
| How an app is bundled, compiled, deployed and published; runtime constraints; app types | [`architecture/app_pipeline.md`](../architecture/app_pipeline.md) |
| Every `app.json` field | [`reference/app_manifest_reference.md`](../reference/app_manifest_reference.md) |
| Protocol wire shapes, postMessage frames, `sendInteraction`/`emit`/`onDrop` | [`reference/app_protocol_reference.md`](../reference/app_protocol_reference.md) |
| Every `yaar://` door and verb | [`reference/uri_reference.md`](../reference/uri_reference.md) |
| Storage payloads, mounts, REST routes | [`reference/storage_api_reference.md`](../reference/storage_api_reference.md) |
| `appDb` filters and on-disk schema | [`reference/app_db_reference.md`](../reference/app_db_reference.md) |
| Design tokens, `y-*` classes, Solid gotchas, links out of an app | [`apps/CLAUDE.md`](../../apps/CLAUDE.md) |
| In-browser ML | [`guides/yaar_ml_runtime.md`](./yaar_ml_runtime.md) |
| Build and verify commands | the `app-dev` skill |

Every SDK signature below is declared, with its doc comment, in
`packages/compiler/src/bundled-types/index.d.ts`; that file wins any disagreement with this one.

## Quick start

An app is a folder under `apps/` (or the user-apps root) with an `app.json` and a
`src/main.ts`.

```json
{
  "appId": "tally",
  "name": "Tally",
  "icon": "🔢",
  "description": "A counter the agent can bump",
  "run": "dist/index.html"
}
```

```typescript
// src/main.ts
import { createSignal } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { defineApp } from '@bundled/yaar';
import * as z from '@bundled/zod';
import './styles.css';

const [count, setCount] = createSignal(0);

function App() {
  return html`
    <div class="y-app">
      <button class="y-btn y-btn-primary" onClick=${() => setCount((c) => c + 1)}>
        Clicked ${count} times
      </button>
    </div>
  `;
}

export default defineApp({
  id: 'tally', // must equal app.json's "appId"; the build checks
  name: 'Tally',
  state: { count: { description: 'Current count', get: () => count() } },
  commands: {
    add: {
      description: 'Add n to the count',
      params: z.object({ n: z.number() }),
      replay: 'never',
      run: (p) => setCount((c) => c + p.n),
    },
  },
  view: App,
});
```

`bun run build:apps tally --typecheck` compiles it to `dist/index.html` and extracts
`dist/protocol.json`. Only a source file that imports nothing needs `export {};`: `apps/tsconfig.json`
compiles every app in one program, and a file with no import or export is a script whose names
collide with every other app's.

## URI Verbs

Apps reach the server through five verbs exported from `@bundled/yaar` — `read`, `list`,
`invoke`, `describe`, `del` — on `yaar://` URIs, plus `subscribe` and `stream` for change
notifications and pushed frames. Which door does what is
[`uri_reference.md`](../reference/uri_reference.md); what matters when writing an app:

- **Everything outside your own trees needs a `permissions` entry** in `app.json`, matched by
  prefix, never glob. Without one the call is a 403. `describe` is always allowed, so describe a
  door before writing against it.
- **Granted for being an app, no entry needed:** `yaar://apps/self/…` (your storage, database
  and sub-agents), the commons `yaar://storage/shared/`, and the served fonts.
- **`yaar://session/*` is not reachable from an app**, whatever `app.json` says — only bundled
  `kind: "system"` apps are admitted. That includes `yaar://session/browser`, the user's real
  browser; an app that browses uses `@bundled/yaar-web` and the headless sandbox.
- On a storage or config `read` where absence is expected, pass `{ missingOk: true }`: it answers `null`
  instead of throwing, and a caught throw is still an error the session recorded.

## Bundled Libraries

Import via `@bundled/*`; there is no npm install. The authoritative list is `BUNDLED_LIBRARIES`
in `packages/compiler/src/bundled/registry.ts`, also served at `GET /api/dev/bundled-libraries`.
Devtools' `describeBundledLibrary` returns a library's declarations with their doc comments;
read that before guessing a signature.

| Import | For |
|---|---|
| `@bundled/solid-js` | Reactive UI: `createSignal`, `createEffect`, `Show`, `For` |
| `@bundled/solid-js/html` | `html` tagged templates (no JSX) |
| `@bundled/solid-js/web` | `render` and DOM helpers (`defineApp` mounts for you) |
| `@bundled/solid-js/store` | `createStore`, `produce`, `reconcile`, `unwrap` |
| `@bundled/uuid` | ID generation |
| `@bundled/lodash` | `debounce`, `throttle`, `cloneDeep`, `groupBy` |
| `@bundled/date-fns` | Calendar dates (the SDK deliberately has no date formatter) |
| `@bundled/anime` | Animation |
| `@bundled/three` | 3D graphics |
| `@bundled/three/addons` | Curated `examples/jsm`: glTF/OBJ/STL/SVG loaders, `GLTFExporter`, controls, `TextGeometry`, geometry/skeleton utils. No Draco/KTX2/meshopt (a single-file app has nowhere to serve their decoders from) |
| `@bundled/three/webgpu`, `@bundled/three/tsl` | `WebGPURenderer` and TSL. Needs `"three": "webgpu"` in `app.json`, after which `@bundled/three` itself is the WebGPU build and `WebGLRenderer`/GLSL are gone |
| `@bundled/cannon-es` | 3D physics |
| `@bundled/matter-js` | 2D physics |
| `@bundled/pixi.js` | 2D WebGL |
| `@bundled/chart.js` | Charts |
| `@bundled/d3` | Data visualization |
| `@bundled/xlsx` | Spreadsheets |
| `@bundled/mammoth` | `.docx` → HTML |
| `@bundled/tone` | Audio synthesis |
| `@bundled/mediabunny` | Read/write/convert mp4, webm, mp3, wav, frame-accurate. Use it instead of `MediaRecorder` + `captureStream()`, which drops frames under load. Check `getFirstEncodableVideoCodec([...])` first |
| `@bundled/lucide` | Icons: import by name, render with `icon()` |
| `@bundled/marked` | Markdown. Render through `renderMarkdown`, not `marked.parse` (see [Rendering Untrusted HTML](#rendering-untrusted-html)) |
| `@bundled/mermaid` | Text → diagrams via `renderMermaid(src)`, which returns token-themed, already-sanitized SVG. ~3.3 MB: import it only where diagrams are drawn |
| `@bundled/prismjs` | Syntax highlighting |
| `@bundled/diff`, `@bundled/diff2html` | Text diffing and rendered diffs |
| `@bundled/zod` | Zod **Mini**: validation at trust boundaries and `params` schemas |
| `@bundled/dompurify` | Present for `sanitizeHtml`; never import it directly |
| `@bundled/yaar` | The SDK itself: verbs, storage, `defineApp`, helpers. Always available |

### Gated SDKs

These need a matching `"bundles"` entry in `app.json`; the compiler and typecheck both refuse the
import without it. The bundle is the grant, so there is no `permissions` entry to add.

| Import | `bundles` | For |
|---|---|---|
| `@bundled/yaar-dev` | `yaar-dev` | `compile`, `typecheck`, `findReferences`, `deploy`, `bundledLibraries`, and per-app version history (`gitHistory`/`gitDiff`/`gitRestore`/`gitCheckpoint`) |
| `@bundled/yaar-web` | `yaar-web` | Headless browser automation: `open`, `click`, `type`, `extract` |
| `@bundled/yaar-ml` | `yaar-ml` | In-browser model inference; see [`yaar_ml_runtime.md`](./yaar_ml_runtime.md) |
| `@bundled/yaar-media` | `yaar-media` | `mediaUrl(url, { referer? })` streams big media through the server with Range passthrough; optional yt-dlp audio download into `shared/media/` |

## UI Chrome & Headless Primitives

Every compiled app gets the `y-*` class layer and `--yaar-*` tokens injected. Reuse them rather
than writing CSS: they cost no bytes, follow the theme, and are what the next agent expects.
Never hardcode a color. The class inventory is `packages/shared/src/design/app-css.ts`; the rules
are [`apps/CLAUDE.md`](../../apps/CLAUDE.md#design-tokens) and
[`design_system.md`](../architecture/design_system.md).

### Document-app skeleton

Editors share one shape: an identity bar, an inline title, a formatting toolbar, a status chip.
Copy it and edit; it is a snippet, not a component.

```typescript
function App() {
  return html`
    <div class="y-app">
      <div class="y-appbar">
        <div class="y-brand"><span class="y-brand-badge">W</span><span class="y-brand-name">My App</span></div>
        <div class="y-doc-field"><input class="y-doc-input" type="text" placeholder="Untitled" /></div>
        <div class="y-appbar-actions">
          <button class="y-tbtn y-tbtn-text y-tbtn-primary" title="Save (Ctrl+S)">Save</button>
        </div>
      </div>
      <div class="y-editbar">
        <div class="y-tgroup"><select class="y-tselect"><option>Paragraph</option></select></div>
        <div class="y-tsep"></div>
        <div class="y-tgroup">
          <button class="y-tbtn" title="Bold">B</button>
          <button class="y-tbtn y-tbtn-active" title="Italic">I</button>
        </div>
      </div>
      <div class="y-scroll"><!-- content --></div>
      <div class="y-statusbar"><span>0 words</span><span class="y-chip y-chip-muted">Saved</span></div>
    </div>
  `;
}
```

`y-tbtn` is the 32px transparent toolbar button; `y-btn` is the bordered text button, and is the
wrong one for a toolbar. IDE-dense bars add `y-toolbar-dense` / `y-statusbar-dense`. A
collapsible sidebar uses the `y-nav-*` family, which is already phone-aware (full-bleed panel and
backdrop at ≤768px, 44px targets under a coarse pointer).

### Headless behavior primitives

State machines apps kept re-implementing. They return state and handlers; your app owns the markup.

| Primitive | Owns |
|---|---|
| `createCollapsiblePanel(opts)` | Hover-expand + pin sidebar. `drawer: isNarrow` turns it into a modal drawer on a narrow window |
| `isNarrow()` / `isTouch()` / `createMediaQuery(q)` | Reactive media queries matching the injected stylesheet's |
| `createAutosave(save, opts)` | Dirty flag, debounced save, `statusLabel()` for a `y-chip`. `save` returns `false` to stay dirty |
| `createPersistedSignal(path, fallback, opts)` | A signal synced to `appStorage` |
| `createSharedSignal(key, initial)` | A value every copy of this window shows (a window runs once per connected desktop) |
| `createStaleGuard()` | Drop a slow response that a newer request superseded |
| `createKeyState(opts)` | Held keys for a game loop |

Three things about `createPersistedSignal` that have each cost a bug:

- **`revive` runs before the value reaches the signal** and also on the fallback when nothing is
  stored, so keep it total. It validates and migrates; it does not reinterpret (clamp a stored
  width against the current window on the read, or a narrow window overwrites the preference).
- **Await the third element before a one-shot side effect.** Until the load lands the getter
  returns the fallback, and a request already sent cannot be taken back:
  `onMount(async () => { await modeReady; void loadFeed(mode()); })`.
- **Pass `debounceMs` when it is bound to a text input.** It writes on every set, and `onInput`
  fires per keystroke (per composition step under an IME). A pending write is flushed on hide.

Keys: a discrete action (pause, rotate) is a declarative `keybindings` entry on `defineApp`; one
that needs an argument is `onShortcut(combo, handler)`; continuous movement samples
`createKeyState` every frame. `createKeyState` already ignores auto-repeat, clears on blur and
tab-hide, and skips presses in editable elements.

## Rendering Untrusted HTML

Any HTML the app did not author — Markdown from storage, a scraped page, a feed body, an API
string, anything round-tripped through `appStorage` — goes through **`sanitizeHtml` from
`@bundled/yaar`** before it reaches the DOM. The iframe holds the app's storage, credentials and
protocol channel; an injected script owns all of them.

**For Markdown, use `renderMarkdown` from `@bundled/marked`.** It parses (GFM), sanitizes the whole
fragment, and rewrites links to open outside the app frame. It never throws, and its output is
already safe for `innerHTML`, so do not sanitize it again. `check:apps` flags a hand-rolled
`marked.parse`.

```typescript
el.innerHTML = renderMarkdown(source);
el.innerHTML = renderMarkdown(text, { breaks: true });
```

Every other pipeline runs in this order:

1. parse the source;
2. **sanitize the complete fragment**;
3. rewrite the sanitized fragment (resolve relative URLs, add classes);
4. insert;
5. attach behavior with `addEventListener`, never an inline `on*` attribute.

Sanitizing before rewriting means your rewriter never sees attacker-controlled attributes.
Step 5 matters because the sanitizer strips `onerror`/`onclick` unconditionally, so a generated
`setAttribute('onerror', …)` fallback silently stops working once the pipeline is secured.
Sanitize at one choke point, where foreign content first enters app state; two overlapping
policies invite someone to weaken one assuming the other covers it.

`sanitizeHtml(dirty)` is DOMPurify's defaults plus one YAAR deviation: `form` and its controls are
forbidden. Pass options (`allowedTags`, `allowedAttr`, `forbidTags`, `forbidAttr`) only when the
content genuinely needs a different allowlist, and say why next to the call; once you pass
`allowedTags`, your list is the whole policy. Never import `@bundled/dompurify` directly and never
hand-roll a sanitizer: denylists miss SVG/MathML mutation XSS, `srcset`, `formaction` and
`xlink:href`.

- **Relative URLs survive verbatim.** Rewrite them on the sanitized output. For link clicks only,
  `"links": { "base": "https://origin.example" }` in `app.json` resolves anchors against that
  site ([links out of an app](../../apps/CLAUDE.md#links-out-of-an-app)).
- **A fetched string headed for `href`/`src`** gets a scheme allowlist at the interpolation site:
  strip control and whitespace characters, parse with `new URL()`, allow only `http:`/`https:`.
- **Test a sanitizer in a real browser or jsdom, never happy-dom**, where DOMPurify silently
  becomes a no-op. Assert on what must not survive *and* on what must.

### Interpolating text, not markup

Text you mean to *show* in a template literal — a filename, a commit message, a search query —
goes through `escapeHtml`, which always covers `& < > " '`:

```typescript
el.innerHTML = `<li title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</li>`;
```

Escaping only `& < >` is safe in a text node and not in an attribute, where a lone `"` ends it.
An XML document serializer (DOCX, SVG) keeps its own escaper; the grammar differs.

## Making HTTP Requests

Use `httpFetch` from `@bundled/yaar` and declare `yaar://http` in `app.json`. It is `fetch`: a
standard `Response`, real `Headers`, intact binary bodies.

```typescript
const res = await httpFetch('https://api.example.com/items?page=2');
if (!res.ok) throw new Error(`Request failed: ${res.status}`);
const items = await res.json();
```

| | Cross-origin | Same-origin / relative |
|---|---|---|
| Route | YAAR's server-side proxy | direct, with the iframe token |
| Needs `yaar://http` | yes | no |
| Cookies | a jar per (session, app) | the iframe's own |

Cross-origin requests also pass SSRF validation and the domain allowlist (the user is asked once
per new domain), and are **buffered**: past 10 MB or 30 s they fail. For large media use
`mediaUrl` from `@bundled/yaar-media`, which streams.

- **Prefer `httpFetch` over `invoke('yaar://http', …)`**, which returns YAAR's internal envelope
  rather than a `Response`. The verb form is for agent-side code.
- **Clear the cookie jar on logout** with `await del('yaar://http')`. Proxy cookies live
  server-side, so clearing only your stored session makes the app *look* logged out while later
  requests keep carrying the upstream session. The call clears only your own app's jar.
- There is **no backend of your own**, and no reaching one: the proxy's SSRF guard refuses
  loopback and private-network hosts (the injected `fetch` routes cross-origin calls through the
  same proxy), so a service on the user's machine is unreachable from an app.

Pagination, rate limits and auth refresh stay in your app; `httpFetch` normalizes transport only.

## App Protocol

The protocol is how an agent reads your app's state and runs its commands. The wire shapes and
routing are [`app_protocol_reference.md`](../reference/app_protocol_reference.md); this section is
how to declare it.

### Registering in Your App — `defineApp()`

`src/main.ts` ends in exactly one `export default defineApp({...})`, as in the
[Quick start](#quick-start). That call registers the protocol (once, at module scope, before the
view mounts), mounts the view, and turns anything a command throws into an `AppCommandError` for
the agent. An app never calls `render()` itself, never registers from `onMount`, and a second
`defineApp()` in one window throws. The removed `app.register()` fails the build.

- **`id`** must equal `appId` in `app.json`; the build checks.
- **`state.get` / `commands.run`** are the handlers. Other descriptor fields: `description`,
  `params`, `returns`, `aliases`, and on the definition `events`, `keybindings`, `onClose`,
  `onCapture`.
- **Schemas.** `params` takes a Zod schema (preferred) or a JSON Schema literal. Zod types `run`'s
  parameter, validates the call before `run` sees it, and folds into `dist/protocol.json`. A JSON
  Schema literal is checked for required and unknown keys only, so `type: "string"` still admits a
  number. One exception: the build folds Zod by importing the app in a worker with a stubbed DOM,
  so an app doing module-scope work that stub cannot do (an `` html`` `` template evaluated at
  import, an `AudioContext`, `@bundled/yaar-ml`) must use JSON Schema literals or move that work
  into a function. The compile names this failure.
- **`describe`**: an optional per-entry `describe(): string`, answered only on
  `describe('yaar://windows/{id}/state/{key}')` — for what the static description cannot say
  because it changes (`` () => `${rows().length} rows` ``). It never rides in the manifest.
- **`replay: 'never'`** on any command whose effect must not be applied twice when the iframe
  remounts (appends, sends, deletes, anything that starts a job). Omit it for idempotent ones.
  Set on `defineApp` itself, it is the default for every command that declares none — for an app
  whose state a remount reads back anyway (`createSharedSignal`, `createPersistedSignal`,
  `appDb`), where a replay only re-runs commands on top of state already restored. A command
  that does rebuild something then says `replay: 'always'`.
- **`view`** is a Solid component, or `{ mount(el) { … } }` for an app that owns its DOM; a
  returned function runs on window close, after `onClose`.
- **`keybindings`**: `{ ArrowRight: 'nextPage', 'Ctrl+s': 'save' }` maps a combo to a declared
  command, which runs with no params. Bare keys are suppressed while an editable element has
  focus. The build rejects unknown commands, unparseable combos, duplicate chords, and the shell's
  reserved combos (`Shift+Tab`, `Ctrl+1-9`, `Ctrl+W`, `Ctrl+R`, `F5`).

### `defineAppCommand` — infer `run`'s params from the schema

Inside the `defineApp({...})` literal each `run` is typed from its own `params`. A command declared
in another module and spread in loses that silently: its `run` parameter widens to a free-form
bag. Wrap it:

```typescript
export const itemCommands = {
  addItem: defineAppCommand({
    description: 'Add an item',
    params: z.object({ text: z.string() }),
    run: (p) => setItems([...items(), p.txt]), // compile error: did you mean 'text'?
  }),
};
```

It is the identity function at runtime; the manifest is unchanged. Keep the call shape literal,
`defineAppCommand({ … })` around an inline object, because the extractor steps over it by name.
From a JSON Schema literal it infers enums, scalars, arrays and objects; `anyOf`/`oneOf`/`$ref`
infer as `unknown`.

#### Splitting a protocol by domain

Descriptor maps may live in other files and be spread in:
`commands: { ...fileCommands, ...gitCommands }`. The extractor follows relative imports and
spreads. Everything must stay statically readable: a spread of a call result
(`...buildCommands()`), a descriptor imported from a package, a `${…}` template description, or a
missing `description` fails the compile with `file:line:col`, because a command the extractor
skipped would run but be invisible to every agent. The `export default` itself stays in
`src/main.ts`.

#### When handlers need a runtime context

A top-level descriptor map cannot close over a factory parameter, and `buildCommands(ctx)` is the
call result the extractor refuses. `createProtocolContext` is the seam: descriptors stay static,
the context is set where it first exists (typically inside `view.mount`), and handlers read it.

```typescript
export const { set: setProtocolContext, get: ctx } =
  createProtocolContext<EditorContext>('slides-lite');

export const deckCommands = {
  setDeck: { description: 'Replace the deck', params: DeckParams, run: (p) => ctx().setDeck(p.deck) },
};
```

`get()` before `set()` throws, and so does a second `set()` with a different context.

### Talking Back to the Agent

`state` and `commands` are how the agent reads you. These are how you reach it (full behavior in
[`app_protocol_reference.md` → Iframe SDK](../reference/app_protocol_reference.md#iframe-sdk)):

- `app.sendInteraction(message)` — a string, or `{ instructions, toMonitor, …payload }`, when a
  user action needs an agent response. A user action the app can finish itself should not wake
  anyone; ordinary state changes reach the agent's next turn without it.
- `app.emit(channel, payload)` on a channel declared in `defineApp({ events })`. Add
  `{ wakeAgent: true }` to hand your own agent the result of background work it started and stopped
  waiting for. It never creates an agent. Payloads are capped at ~16K serialized chars; emit a
  handle for anything bigger.
- `app.onDrop({ files, text })` takes window drops away from the agent.
- `onCapture` returns a data-URL image when the default screenshot cannot see your content (a
  WebGL canvas without `preserveDrawingBuffer`).

### Driving an app from an agent

An agent drives a *running* app through its window:
`read('yaar://windows/{id}/state/{key}')`, `invoke('yaar://windows/{id}/commands/{key}', params)`
(an array runs the command once per element), and
`invoke('yaar://windows/{id}', { action: 'message', message })` to hand a monitor's request to the
app's own agent. The verb table is
[URI Reference → Windows](../reference/uri_reference.md#windows--yaarwindowswindowid); the app
agent's scoped tools are [`app_protocol_reference.md` → Invocation](../reference/app_protocol_reference.md#invocation).

## Agent Prompt Customization

Each app gets its own **app agent**. Four optional files feed four readers:

| File | Reader | Use for |
|---|---|---|
| `agent/prompt.md` | The app's own agent, every turn | How to drive the app: workflows, domain concepts, anti-patterns. Appended after the shared intro, so open with what the app *is*, never "You are …" |
| `agent/hint.md` | The monitor agent, every turn | *When* to route work here. 1–3 sentences |
| `agent/SKILL.md` | Whoever calls `describe('yaar://apps/{appId}')` | Workflows and ordering constraints for an outside caller. `describe` lists its `##` headings and `read('yaar://apps/{appId}/skill')` serves it whole, so name sections for what they help with |
| `agent/docs/*.md` | The app agent, on demand | Reference topics. Frontmatter `name` (= filename), `description` written as a trigger (≤150 chars), optional `audience`. Only the index is always loaded |
| `AGENTS.md` (root) | A coding agent editing the app | Module map, invariants, why something is hand-rolled. YAAR never reads it |

- **Never restate the protocol.** The manifest is appended to the app agent's prompt as exact call
  signatures and served beside SKILL.md, so a copy in prose drifts from the schema the app
  validates against. `check:apps` warns when SKILL.md restates a command or state name as a
  heading or bullet subject (`skill-restates-protocol`).
- The line between files is the reader, not the topic. "`src/gizmo.ts` is hand-rolled because the
  bundled control drops pointer capture" is `AGENTS.md`; "call `addPrimitive` before setting a
  material" is `agent/prompt.md` (or a topic, if rarely needed).
- Clone and deploy carry all of these. Paths can be overridden in `app.json`'s `agent` field, but
  the defaults above are what almost every app uses. How the prompt is assembled:
  [`app_agent_prompt.md`](../reference/app_agent_prompt.md).

## Credential Management

User-supplied tokens and per-app config live at `yaar://config/app/{appId}`, stored as
`config/{appId}.json` (git-ignored, outside the app folder, so never published).

```typescript
await invoke('yaar://config/app/moltbook', { config: { api_key: '…' } }); // save
const cfg = await read('yaar://config/app/moltbook');                     // throws until set
const maybe = await read('yaar://config/app/moltbook', { missingOk: true }); // null until set
await del('yaar://config/app/moltbook');
```

`yaar://config/app/{appId}` is an ordinary permission with no implicit self-grant: an app that
reads its own config declares that URI, spelled with its real id, in `app.json`. OAuth
code-for-token exchange cannot happen in an app (it needs a server-side `client_secret`); have the
user supply a personal access token instead. A token kept in `appStorage` needs a real extension
(`token.json`): an extensionless path reads back as a "binary file" placeholder sentence.

## App-Scoped Storage

Each app has its own tree at `storage/apps/{appId}/`, addressed as `yaar://apps/self/storage/…`
and granted automatically. No other *installed* app can reach it; it is not secret from the user,
the Storage app, or agents. Full server surface:
[`storage_api_reference.md`](../reference/storage_api_reference.md).

### From App Code (`@bundled/yaar`)

```typescript
await appStorage.save('data.json', JSON.stringify(data));        // throws on failure
const ok = await appStorage.trySave('data.json', json);           // false on failure
const prefs = await appStorage.readJsonOr<unknown>('prefs.json', undefined);
const text = await appStorage.read('notes.md');
const blob = await appStorage.readBlob('image.png');              // bytes as stored
const entries = await appStorage.list('renders');                 // direct children only
await appStorage.remove('data.json');
await appStorage.save('a.otf', bytesToBase64(buf), { encoding: 'base64' }); // binary
```

A binary write without `encoding: 'base64'` stores the base64 text itself.

### Never swallow a failed save

`try { await appStorage.save(…) } catch {}` around an autosave keeps the app saying "Saved" while
nothing reaches disk. Use `trySave`: it logs, toasts (at most once per 5 s per path), and resolves
`false` so you can withhold the success UI.

```typescript
if (await appStorage.trySave('draft.json', json, { label: 'draft' })) setDirty(false);
```

`label` names the data in the toast; `onError` replaces the toast with your own surface (the log
still happens). `createPersistedSignal` and `createAutosave` route through the same contract. Keep
plain `save()` where the caller genuinely handles the throw, such as a command handler whose
failure should reach the agent.

### Never trust a read either — validate at the boundary

`readJsonOr(path, fallback)` answers "missing" and "garbage" with the same value, so a truncated
write and a first run look identical and the user's data vanishes without a trace. Anything read
back is untrusted: persisted JSON (older builds, hand edits, concurrent instances), HTTP and SSE
responses, `yaar://config/*` reads, user-picked files.

**Degraded-by-design must be distinguishable from broken.** Missing is quiet; malformed takes the
same fallback but is logged, and toasted if the user would otherwise be misled.

```typescript
// src/schema.ts — say which boundaries these guard
export const PrefsSchema = z.looseObject({ playbackRate: z.optional(z.number()) });

const raw = await appStorage.readJsonOr<unknown>('prefs.json', undefined);
const prefs = safeParseOr(PrefsSchema, raw, DEFAULTS, { label: 'prefs.json' });
```

- `@bundled/zod` is Zod Mini: `z.optional(x)`, `z.safeParse(S, v)`, no method chains.
  `z.looseObject` keeps fields a newer build added; validate only what you read.
- `safeParseOr` stays silent for `undefined` and logs a present-but-wrong value. `onInvalid`
  replaces the log line: throw from it for parse-or-throw, or count failures from a poll. Never
  toast from a poll or subscription; surface only the transition into failure.
- **Use `readJsonOr`, not `readJson` in a `try/catch`.** Only `readJsonOr` sends `missingOk`, so
  only it keeps an absent optional file out of the session's error count.
- Hand-roll `z.safeParse` only for per-field recovery or element-wise arrays, so one drifted field
  or row does not cost the rest.

### SDK helpers

`@bundled/yaar` ships the helpers apps kept rewriting. Use them; several exist because two windows
must not render one value two ways.

| Instead of | Use |
|---|---|
| `e instanceof Error ? e.message : String(e)` | `errMsg(e)` |
| `new Promise((r) => setTimeout(r, ms))` | `wait(ms)` |
| a try/catch/toast block | `tryToast(fn, { success })`; `withLoading(setBusy, fn, onError)` owns a loading flag |
| a local byte, duration or clock formatter | `formatBytes`, `formatDuration`, `formatClock` |
| the objectURL/`<a download>` dance | `downloadBlob(blob, name)` |
| `FileReader` / `atob` / `btoa(String.fromCharCode(...))` | `blobToDataUrl`, `dataUrlToBlob`, `base64ToBytes`, `bytesToBase64` |
| a canvas re-encode | `toWebP(source, { quality, maxSize })` — `null`, not a throw, when unsupported |
| hand-written toast HTML | `showToast(msg, 'info' \| 'success' \| 'error')` |
| a failure message for the agent | `throw new AppCommandError(msg)` |

`debounce`/`throttle` come from `@bundled/lodash`; calendar dates from `@bundled/date-fns`.

### Rasterizing your own DOM

`rasterize(el, { css, scale })` is DOM → SVG `foreignObject` → canvas with its quiet failures
closed (image inlining, XML serialization, canvas tainting, JPEG black backgrounds, fonts).

```typescript
const { blob, fonts, skippedImages } = await rasterize(pageEl, { css: exportCss, scale: 2 });
```

The element must be in the document and laid out (`position:fixed; left:-99999px`, not
`display:none`). The picture inherits **nothing**: no page stylesheet, no `--yaar-*` tokens, no
network. Whatever it needs goes in `css`. Missing glyphs and uninlinable images are reported, not
thrown.

### The platform's fonts (`fonts`)

A picture of your DOM cannot fetch a webfont; it honours only a `data:` URL `@font-face`, and a
whole face is ~1.6 MB. `fonts.inline(text, { weights })` subsets YAAR's faces server-side and
returns the CSS plus per-face `gids`, `advances` and `metrics`. `rasterize` calls it for you; call
it directly when you drive the SVG yourself or also place vector text over the raster (take both
from one call, or the layout drifts). `fonts.faces()` lists what is served; `fonts.faceCss()` gives
by-URL rules for a measuring pass. Never ship your own font subsetter.

### Dialog helpers

Never use native `alert()`/`confirm()`/`prompt()`: they block the page and any agent driving it.

```typescript
if (await showConfirm(`Delete "${name}"?`, { danger: true, okLabel: 'Delete' })) await remove(name);
const title = await showPrompt('New document name:', { initial: 'Untitled' }); // null on cancel
showToast('Export finished.', 'success'); // there is no showAlert
```

Custom modals compose the same classes: `y-overlay` > `y-modal` > `y-modal-title` /
`y-modal-msg` / `y-modal-actions`.

### From Agent (MCP Tools)

Agents reach the same tree as `yaar://apps/{appId}/storage/{path}` with `read`, `list`,
`describe`, `delete`, and `invoke` `{ action: 'write', content }`. A `list` of a missing directory
is an error, except the storage root itself. App agents also have `storage:*` built-ins, which an
app can override when its files are renderings of a document.

## Shared Storage (`yaar://storage/shared/`)

The commons, where apps hand files to each other. Every app reads and writes it with no
declaration (adding one grants nothing). Publish under your own directory through
`sharedStorage`, which the server resolves from the iframe token, so a devtools preview writes to
its own directory rather than the shipped app's.

```typescript
const { uri } = await sharedStorage.publish('yaar://apps/self/storage/out/x.png', { as: 'dragon.png' });
await sharedStorage.save('renders/final.png', blob);
img.src = sharedStorage.url('renders/final.png');
const theirs = await storage.read('shared/anima/dragon.png', { as: 'blob' }); // anyone's file
```

- **Prefer `publish()` over read-then-`save()`.** It copies server-side, so the bytes never cross
  the iframe or, later, a model context.
- **The commons is not a boundary.** Any app can overwrite or delete anything in it, and the user
  prunes it. Keep what must stay yours in `appStorage`, and keep your own copy of anything you need
  at runtime.

### One file, four names (`storagePath`)

A stored file arrives spelled four ways: `shared/anima/x.png` (a listing),
`yaar://storage/shared/anima/x.png` (a verb, an agent), `yaar://apps/self/storage/x.png`
(`appStorage`), `/api/storage/shared/anima/x.png` (an HTTP route). **Every `storage.*` method
accepts all four.** Reach for `storagePath(ref)` only when you need the path itself:

```typescript
const path = storagePath(slide.image);
img.src = path ? storage.url(path) : slide.image; // stored file, or a remote URL
```

- **Never hand-parse a storage reference.** Recognising one spelling is how an image shows in the
  editor and exports blank.
- **Never hand-build an `/api/storage/…` URL.** Only `storage.url()` / `sharedStorage.url()` carry
  the iframe token a subresource request needs; a hand-built one fails as an indistinguishable load
  error under app-origin isolation.
- `null` means "not storage" (or a `..` path), not "forbidden": the server decides reach.

## App-Scoped Database (`appDb`)

For structured records, each app also gets a SQLite database at `storage/apps/{appId}/data.db`,
with server-side queries, counts, pagination and full-text search, so nothing loads a whole JSON
file to filter it. Blobs and single files stay in `appStorage`. The full API, filter operators and
on-disk design: [`app_db_reference.md`](../reference/app_db_reference.md).

```typescript
const notes = appDb.collection<Note>('notes');
const id = await notes.insert({ title: 'Hello', tags: ['intro'] });
const page = await notes.find({ tags: 'intro' }, { sort: { _created_at: -1 }, limit: 20 });
const hits = await notes.search('hello world');
const [docs, { insert, update, remove }] = appDb.createReactiveCollection<Note>('notes', { limit: 50 });
```

Agents query it directly at `yaar://apps/{appId}/db/{collection}` (`find`, `search`, `insert`,
`update`, `count` actions), so an app's data never has to be loaded whole into a context.

## Sub-agents (Personas)

An app declaring `"subagents": { "max": N }` can spawn up to N AI instances from its iframe, each
with a system prompt the app supplies and its own conversation memory — several characters at
once rather than one agent role-playing them in turn. They hold no YAAR verbs, permissions or
principal. Add `"streams": ["agents"]` to watch them. For an installed (not bundled) app both lines
are requests the user approves at install, and the approval is a ceiling. Verb surface, limits and
response shapes: [URI Reference](../reference/uri_reference.md#app-sub-agents--yaarappsselfagents);
where they sit in the agent tree:
[`monitor_and_windows_guide.md`](../architecture/monitor_and_windows_guide.md#the-four-laws).

```typescript
const { personaId, streamUri } = await invoke('yaar://apps/self/agents', {
  action: 'spawn', personaId: 'alice', systemPrompt: 'You are Alice, a terse botanist.',
});
const stop = await stream(streamUri, onFrame, { kinds: ['text', 'done', 'error'] });
await invoke(`yaar://apps/self/agents/${personaId}`, { action: 'message', content: 'Hi!' });
```

- **Await the stream, not the verb.** `message` resolves when the turn is queued; the answer is the
  `done` frame. Give each turn a watchdog.
- **Spawn is idempotent and does not update the prompt.** An iframe reload re-runs spawn and gets
  the live persona back (`reused: true`) with its memory. Delete and respawn to recast.
- **`message` rejects while a persona is mid-turn** (`busy: true`). Your app is the scheduler.
- **Persistence is yours.** Sub-agents end with the app's last window on the monitor, the monitor,
  or the session; replay history from `appDb`/`appStorage` into a respawn.

### Giving a persona tools

Pass `tools: [{ name, description, input? }]` at spawn. A call dispatches the protocol command
`persona:{name}` to your app's active window, with `personaId` stamped last so a model cannot
answer as someone else; the handler's return value is the tool result.

```typescript
commands: {
  'persona:memorize': {
    description: 'Called by a character recording a lasting fact.',
    params: z.object({ personaId: z.string(), fact: z.string() }),
    replay: 'never',
    run: async (p) => ({ recorded: await saveFact(p.personaId, p.fact) }),
  },
},
```

`persona:*` commands are hidden from your app agent's manifest. A tool is the right shape for a
signal like `skip` (rather than a `[[skip]]` sentinel in the text) and the only shape for a lookup
like `recall`, whose result must come back mid-generation. With no window open, a tool call returns
an error result and the turn continues.

## Anti-Patterns

- Swallowing a failed save, or reading JSON without validating it — see
  [App-Scoped Storage](#app-scoped-storage).
- Unsanitized HTML in `innerHTML`, a hand-rolled sanitizer, or an inline `on*` attribute — see
  [Rendering Untrusted HTML](#rendering-untrusted-html).
- An OAuth client in an app, a `localhost` backend, or `invoke('yaar://http')` where `httpFetch`
  fits — see [Making HTTP Requests](#making-http-requests) and
  [Credential Management](#credential-management).
- Native `alert`/`confirm`/`prompt` — see [Dialog helpers](#dialog-helpers).
- Re-implementing an SDK helper or a `y-*` class — see [SDK helpers](#sdk-helpers) and
  [UI Chrome](#ui-chrome--headless-primitives).
- Hand-parsing a storage path or hand-building an `/api/storage/` URL — see
  [`storagePath`](#one-file-four-names-storagepath).
