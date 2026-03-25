# App Development Guide

In YAAR, you tell the AI what to build and it creates the app. TypeScript authoring, compilation, preview, and desktop deployment are all handled by the AI through the devtools app.

> [한국어 버전](ko/app-development.md)

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

### Marketplace — `yaar://market/`

| Verb | URI | Description |
|------|-----|-------------|
| `list` | `yaar://market` | Browse marketplace apps |
| `read` | `yaar://market/{appId}` | Get details for a marketplace app |
| `invoke` | `yaar://market/{appId}`, `{ action: "install" }` | Install app from marketplace |

### Skills — `yaar://skills/`

| Verb | URI | Description |
|------|-----|-------------|
| `list` | `yaar://skills` | List available skill topics |
| `read` | `yaar://skills/{topic}` | Load reference docs (`app_dev`, `components`, `host_api`, `app_protocol`) |

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

Available via `@bundled/*` imports — no npm install needed:

| Library | Import Path | Purpose |
|---------|------------|---------|
| solid-js | `@bundled/solid-js` | Reactive UI (createSignal, createEffect, Show, For, etc.) |
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

```typescript
import { v4 as uuid } from '@bundled/uuid';
import { debounce } from '@bundled/lodash';
import anime from '@bundled/anime';
```

### Gated SDKs

Some `@bundled/*` SDKs require explicit opt-in via the `"bundles"` field in `app.json`. The compiler will reject the import if not declared.

| SDK | Import Path | Purpose | Required `bundles` value |
|-----|------------|---------|------------------------|
| Dev Tools | `@bundled/yaar-dev` | `compile()`, `typecheck()`, `deploy()`, `bundledLibraries()` | `"yaar-dev"` |
| Browser | `@bundled/yaar-web` | `open()`, `click()`, `type()`, `extract()`, etc. | `"yaar-web"` |

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

The agent gets a generic prompt ("You are an AI assistant for the X app...") with `SKILL.md` content appended under an "App Documentation" heading. Good for apps where the default 3-tool behavior (query, command, relay) is sufficient and you just need to add domain knowledge.

### AGENTS.md (full control)

The agent's entire system prompt is replaced with the contents of `AGENTS.md`. Use this when:
- The agent needs a specific workflow (e.g., devtools: typecheck → compile → deploy)
- You want to define anti-patterns, gotchas, or domain-specific rules
- The generic prompt's behavior guidelines don't fit

Since `AGENTS.md` replaces the base prompt, you must document the 3 available tools (`query`, `command`, `relay`) yourself if the agent needs to know about them.

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

Import `app` from `@bundled/yaar` and call `app.register()` with state handlers and command handlers.

```typescript
// src/protocol.ts
import { app } from '@bundled/yaar';
import { items } from './store';

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
      addItem: {
        description: 'Add an item. Params: { text: string }',
        params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        handler: (p: { text: string }) => {
          items([...items(), p.text]);  // immutable signal write, no render() needed
          return { ok: true };
        },
      },
    },
  });
}
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

// Write a file
await appStorage.save('data.json', JSON.stringify({ key: 'value' }));

// Read as JSON
const data = await appStorage.readJson<{ key: string }>('data.json');

// Read as text
const text = await appStorage.read('data.json');

// Read binary (returns { data: base64, mimeType })
const binary = await appStorage.readBinary('image.png');

// List files (returns [{ path, isDirectory, size, modifiedAt }])
const files = await appStorage.list();

// Delete a file
await appStorage.remove('data.json');
```

### From Agent (MCP Tools)

```
invoke('yaar://apps/my-app/storage/data.json', { action: 'write', content: '...' })
read('yaar://apps/my-app/storage/data.json')
list('yaar://apps/my-app/storage/')
delete('yaar://apps/my-app/storage/data.json')
```
