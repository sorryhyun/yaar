# App Development Guide

In YAAR, you tell the AI what to build and it creates the app. TypeScript authoring, compilation, preview, and desktop deployment are all handled by the AI through the devtools app.

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

> **Note:** `yaar://session/*` is **session-agent-only** — it is the session principal's private namespace and is not reachable by apps via `POST /api/verb`, regardless of `app.json` permissions (apps cannot self-grant it). This includes `yaar://session/browser` (the session agent's door to the user's *real* browser); apps that need browsing use `@bundled/yaar-web` → the headless sandbox instead. See `docs/session_agent_browser_design.md`.

### Devtools App

App development (write, edit, compile, typecheck, deploy, clone) is handled through the **devtools app** via App Protocol commands. The devtools app runs in an iframe window and exposes these operations as protocol commands. The AI opens the devtools window and interacts with it using `app_command` and `app_query`.

See the devtools app's `SKILL.md` for the full list of available commands.

### Apps — `yaar://apps/`

| Verb | URI | Description |
|------|-----|-------------|
| `list` | `yaar://apps` | List all installed apps |
| `read` | `yaar://apps/{appId}` | Load an app's SKILL.md |
| `invoke` | `yaar://apps/{appId}`, `{ action: "set_badge", count }` | Set badge count on app icon |
| `delete` | `yaar://apps/{appId}` | Uninstall app |

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

## Runtime Constraints

Compiled apps run in a **browser iframe sandbox**. They are subject to these hard constraints:

- **No Node.js APIs** — No `fs`, `process`, `child_process`, `net`, etc. This is a browser environment.
- **No server processes** — Apps cannot listen on ports, spawn servers, or run background daemons.
- **No OAuth flows** — OAuth code-for-token exchange requires a server-side `client_secret`. Iframe apps cannot safely perform this. Use the API-based app pattern instead (see below).
- **Browser `fetch()` subject to CORS** — Direct cross-origin requests will be blocked. Use `yaar.invoke('yaar://http', { url, ... })` to proxy requests through the server.
- **No localStorage/IndexedDB** — Use `appStorage` from `@bundled/yaar` for persistence (server-side, survives across sessions).
- **Self-contained** — Apps must not depend on external servers, localhost services, or infrastructure outside the iframe.

## Anti-Patterns

Common mistakes to avoid when building apps:

- **Don't build OAuth clients as compiled apps** — OAuth requires server-side token exchange with a `client_secret`. Instead, build an API-based app (SKILL.md only) where the user provides a personal access token, stored via `invoke('yaar://config/app/{appId}', { config })`.
- **Don't assume external servers are running** — There is no backend at `localhost:3000` or any other port. Apps must be fully self-contained.
- **Don't replicate server functionality in iframe** — If the app needs to call external APIs that require auth, the AI agent should handle HTTP calls via `invoke('yaar://http', { url, method?, headers?, body? })` and relay data via App Protocol.
- **Don't hardcode localhost URLs** — Apps run on whatever host YAAR is served from.
- **Don't swallow a failed save** — `catch { /* ignore */ }` around `appStorage.save()` makes data loss invisible while the UI still says "Saved". Use `appStorage.trySave()` and gate the success UI on its result. See [Never swallow a failed save](#never-swallow-a-failed-save).
- **Don't re-implement SDK helpers** — `errMsg`, `showToast`, `withLoading`, `wait` are exported by `@bundled/yaar`; `debounce` by `@bundled/lodash`.

### Right Pattern for External Service Integration

```
Option A: API-based app (preferred for API wrappers)
  apps/github/SKILL.md → describes GitHub API, auth flow
  User provides PAT → stored via invoke('yaar://config/app/{appId}', { config })
  AI calls GitHub API via invoke('yaar://http', ...) → renders in windows

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
- `id` (`apps/github`) and `appId` (`apps/memo`, `apps/music-maker`) — the folder name is always the id. The `appId` passed to `app.register()` in your source is a separate thing and *is* used.

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
identifier call to find the descriptor, so a spread descriptor or a computed callee will
make it skip the command and silently drop it from `dist/protocol.json`.

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

### MCP Tools

| Tool | Description |
|------|-------------|
| `invoke('yaar://windows/{id}', { action: 'app_query', key })` | Read structured data from app by state key (use `"manifest"` to discover capabilities) |
| `invoke('yaar://windows/{id}', { action: 'app_command', command, params })` | Execute a command on the app |
| `invoke('yaar://windows/{id}', { action: 'message', message })` | Send a message to the app agent (monitor → app agent delegation). Fire-and-forget — same code path as user interaction. |

The agent first calls `app_query` with a bare window URI to discover capabilities (manifest), then uses `app_query` and `app_command` with resource URIs to interact.

The `message` action lets **monitor agents delegate tasks to app agents** via the window URI. It queues a task through `AppTaskProcessor` exactly like a user `WINDOW_MESSAGE`, creating the app agent on demand if needed. Combine with `subscribe` to get notified when the app agent completes.

### Example: Excel Lite

```
invoke('yaar://windows/excel-lite', { action: 'app_query' })
invoke('yaar://windows/excel-lite', { action: 'app_query', key: 'cells' })
invoke('yaar://windows/excel-lite', { action: 'app_command', command: 'setCells', params: { cells: { "A1": "Hello" } } })
invoke('yaar://windows/excel-lite', { action: 'message', message: 'Summarize column A' })
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
