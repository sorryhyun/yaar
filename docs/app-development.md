# App Development Guide

In YAAR, you tell the AI what to build and it creates the app. TypeScript authoring, compilation, preview, and desktop deployment are all handled by the AI via MCP tools.

> [한국어 버전](ko/app-development.md)

## Development Flow

```
"Make me a Tetris game"

    ↓  AI writes code    invoke('yaar://sandbox/new/src/main.ts', { action: "write", content: "..." })
    ↓  Compiles           invoke('yaar://sandbox/{id}', { action: "compile" })
    ↓  Previews in iframe window
    ↓  Deploys to desktop invoke('yaar://sandbox/{id}', { action: "deploy", appId: "tetris", ... })

🎮 Tetris icon appears on the desktop
```

Users don't need to write code. The AI writes TypeScript in a sandbox, compiles with Bun, previews the result, and deploys it as an app. Built apps are bundled into a single self-contained HTML file — all libraries, CSS, and code are inlined, so they can run independently in any browser with zero dependencies.

## MCP Tools

### App Development Tools

| Tool | Description |
|------|-------------|
| `write` | Write files to sandbox (`yaar://sandbox/` URI) |
| `read` | Read sandbox files (`yaar://sandbox/` URI) |
| `list` | List sandbox files (`yaar://sandbox/` URI) |
| `edit` | Apply search-and-replace edits to sandbox files (`yaar://sandbox/` URI) |
| `invoke('yaar://sandbox/{id}', { action: "compile" })` | Bundle `src/main.ts` → single HTML (Bun) |
| `invoke('yaar://sandbox/{id}', { action: "typecheck" })` | Run TypeScript type checking on sandbox code |
| `invoke('yaar://sandbox/{id}', { action: "deploy", appId, ... })` | Deploy compiled app to desktop |
| `invoke('yaar://sandbox/{id}', { action: "clone", uri })` | Clone a deployed app's source into a sandbox for editing |

### Code Execution Tools

| Tool | Description |
|------|-------------|
| `invoke('yaar://sandbox/eval', { code })` | Execute JavaScript in sandboxed VM |

### Reference Tools

| Tool | Description |
|------|-------------|
| `skill` | Load reference docs by topic (`app_dev`, `sandbox`, `components`, `host_api`, `app_protocol`) |

### App Management Tools

| Tool | Description |
|------|-------------|
| `apps_list` | List apps |
| `apps_load_skill` | Load an app's SKILL.md |
| `invoke('yaar://config/app/{appId}', { config })` | Save app config |
| `read('yaar://config/app/{appId}')` | Read app config |
| `delete('yaar://config/app/{appId}')` | Remove app config |
| `market_list` | List apps available in the marketplace |
| `market_get` | Download and install an app from the marketplace |
| `market_delete` | Uninstall an app and its credentials |

## Development Workflow in Detail

### Step 1: Write Code — `write`

```
write(uri: "yaar://sandbox/src/main.ts", content: "...")        // new sandbox auto-created
write(uri: "yaar://sandbox/1739xxx/src/main.ts", content: "...") // write to existing sandbox
```

- Creates files in an isolated sandbox directory
- `yaar://sandbox/{path}` without a sandbox ID auto-generates a new sandbox ID
- Supports multiple files (`src/main.ts`, `src/utils.ts`, ...)

### Step 2: Compile

```
invoke('yaar://sandbox/1739xxx', { action: "compile", title: "My App" })
```

- Bundles from `src/main.ts` entry point via Bun
- Produces a **single self-contained HTML file** with embedded JS
- Returns preview URL: `/api/sandbox/{sandboxId}/dist/index.html`

### Step 3: Preview

The AI opens an iframe window to preview the compiled result immediately.

### Step 4: Deploy

```
invoke('yaar://sandbox/1739xxx', { action: "deploy", appId: "my-app", name: "My App", icon: "🚀", description: "..." })
```

- Copies compiled HTML to `apps/{appId}/`
- Auto-generates `SKILL.md` and `app.json`
- Icon appears on desktop immediately
- `appProtocol`: Mark app as supporting App Protocol (auto-detected from HTML if not set)
- `fileAssociations`: Map file extensions to app_command calls for file opening

### Editing Existing Apps — clone → edit → compile → deploy

```
invoke('yaar://sandbox/new', { action: "clone", uri: "yaar://apps/my-app" })  → returns sandboxId
invoke('yaar://sandbox/{sandboxId}/src/main.ts', { action: "edit", old_string: "...", new_string: "..." })
invoke('yaar://sandbox/{sandboxId}', { action: "compile" })
invoke('yaar://sandbox/{sandboxId}', { action: "deploy", appId: "my-app" })  // same appId overwrites in-place
```

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

## Sandbox Execution Environment

`invoke('yaar://sandbox/eval', { code })` executes code in an isolated VM.

**Available:** JSON, Math, Date, Promise, fetch (domain-restricted), crypto.createHash, TextEncoder/Decoder, typed arrays

**Blocked:** process, require, import, eval, Function, fs, os, setTimeout/setInterval

- Timeout: 100ms–30,000ms (default 5,000ms)
- Allowed fetch domains: managed in `config/curl_allowed_domains.yaml`

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
- **Browser `fetch()` subject to CORS** — Direct cross-origin requests will be blocked. Use `POST /api/fetch` (raw HTTP proxy) or `POST /api/browse` (headless Chrome rendering) to bypass CORS. See the Host API skill for details.
- **No localStorage/IndexedDB** — Use `window.yaar.storage` for persistence (server-side, survives across sessions).
- **Self-contained** — Apps must not depend on external servers, localhost services, or infrastructure outside the iframe.

## Anti-Patterns

Common mistakes to avoid when building apps:

- **Don't build OAuth clients as compiled apps** — OAuth requires server-side token exchange with a `client_secret`. Instead, build an API-based app (SKILL.md only) where the user provides a personal access token, stored via `invoke('yaar://config/app/{appId}', { config })`.
- **Don't assume external servers are running** — There is no backend at `localhost:3000` or any other port. Apps must be fully self-contained.
- **Don't replicate server functionality in iframe** — If the app needs to call external APIs that require auth, the AI agent should handle HTTP calls via `http_get`/`http_post` system tools and relay data via App Protocol.
- **Don't hardcode localhost URLs** — Apps run on whatever host YAAR is served from.

### Right Pattern for External Service Integration

```
Option A: API-based app (preferred for API wrappers)
  apps/github/SKILL.md → describes GitHub API, auth flow
  User provides PAT → stored via invoke('yaar://config/app/{appId}', { config })
  AI calls GitHub API via http_get/http_post → renders in windows

Option B: Compiled app + AI-mediated API (for rich UI)
  Compiled iframe app handles UI/display only
  AI agent handles external API calls via MCP tools
  App Protocol bridges the two:
    invoke(uri, { action: 'app_query' }) → display data from AI to app
    invoke(uri, { action: 'app_command' }) → user actions from app to AI
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

Call `window.yaar.app.register()` with state handlers and command handlers. The SDK script is auto-injected into iframes.

```typescript
// src/protocol.ts
import { items } from './store';

export function registerProtocol() {
  if (!window.yaar?.app) return;

  window.yaar.app.register({
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

The agent first calls `app_query` with a bare window URI to discover capabilities (manifest), then uses `app_query` and `app_command` with resource URIs to interact.

### Example: Excel Lite

```
invoke('yaar://windows/excel-lite', { action: 'app_query' })
invoke('yaar://windows/excel-lite', { action: 'app_query', key: 'cells' })
invoke('yaar://windows/excel-lite', { action: 'app_command', command: 'setCells', params: { cells: { "A1": "Hello" } } })
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
