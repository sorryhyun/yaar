# App Development Guide

## Workflow

**New app:** write to `yaar://sandbox/new/src/main.ts` → deploy with `action: 'deploy'`
**Edit app:** clone with `action: 'clone', uri: 'yaar://apps/{appId}'` → edit files → deploy back to the same appId
**Preview:** use `action: 'compile'` separately to get a preview URL before deploying

## Sandbox Structure

Entry point is `src/main.ts`. Split code into multiple files (e.g., `src/utils.ts`, `src/renderer.ts`) and import them from main.ts — avoid putting everything in one file.

If the app uses App Protocol, put the `.register()` call in `src/protocol.ts`. The compiler auto-extracts the protocol manifest from `src/main.ts` or `src/protocol.ts` and embeds it into `app.json` at deploy time.

If `main.ts` has no `import` statements, add `export {};` at the top so TypeScript treats it as a module (prevents variable name collisions across apps).

## Recommended File Structure

```
src/
├── main.ts          # Entry point: mount(), onMount(), top-level wiring
├── styles.css       # All CSS (imported via `import './styles.css'`)
├── protocol.ts      # App Protocol registration (if using App Protocol)
├── store.ts         # Signals and shared state
├── types.ts         # Type definitions
└── helpers.ts       # Pure utility functions
```

Split code across files — avoid putting everything in `main.ts`. Import CSS via `import './styles.css'` rather than using inline `css` tags (except for the smallest snippets).

## Bundled Libraries

Available via `@bundled/*` imports (no npm install needed):

{{BUNDLED_LIBRARIES}}

Example:
```ts
import { v4 as uuid } from '@bundled/uuid';
import { animate, createTimeline } from '@bundled/anime';
import { format } from '@bundled/date-fns';
```

## Design Tokens (CSS)

All compiled apps automatically include shared CSS custom properties (`--yaar-*`) and utility classes (`y-*`). No imports needed — they're injected at compile time.

**Key tokens:**

| Token | Value | Usage |
|-------|-------|-------|
| `--yaar-bg` | `#0f1117` | App background |
| `--yaar-bg-surface` | `#161b22` | Card/surface background |
| `--yaar-text` | `#e6edf3` | Primary text |
| `--yaar-text-muted` | `#8b949e` | Secondary text |
| `--yaar-accent` | `#58a6ff` | Links, active states |
| `--yaar-border` | `#30363d` | Borders |
| `--yaar-success` | `#3fb950` | Success states |
| `--yaar-error` | `#f85149` | Error states |
| `--yaar-sp-{1-8}` | 4px increments | Spacing scale |
| `--yaar-radius` | `6px` | Default border radius |

**Utility classes:**

| Class | Description |
|-------|-------------|
| `y-app` | Root container (flex column, full height, themed) |
| `y-flex`, `y-flex-col`, `y-flex-center`, `y-flex-between` | Flex layouts |
| `y-gap-{1-4}` | Gap spacing |
| `y-p-{1-4}`, `y-px-{2-4}`, `y-py-{2-3}` | Padding |
| `y-text-{xs,sm,base,lg,xl}` | Font sizes |
| `y-text-muted`, `y-text-dim`, `y-text-accent` | Text colors |
| `y-card` | Surface with border + padding |
| `y-btn`, `y-btn-primary`, `y-btn-ghost`, `y-btn-sm` | Buttons |
| `y-input` | Text input |
| `y-badge`, `y-badge-success`, `y-badge-error` | Badges |
| `y-spinner`, `y-spinner-lg` | Loading spinner |
| `y-scroll` | Styled scrollbar container (needs a fixed height, e.g. set `height` on `#app`) |
| `y-truncate` | Text ellipsis overflow |

Override any token in your app: `:root { --yaar-accent: #ff6b6b; }`

## `@bundled/solid-js` — Reactive DOM Library

Standard [Solid.js](https://www.solidjs.com/) for reactive UI. Three import paths:

```ts
import { createSignal, createEffect, createMemo, batch, onMount, onCleanup, Show, For } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
```

**CSS:** Prefer `import './styles.css'` over inline styles. The bundler handles CSS imports automatically.

**Toast notifications:** Use the `y-toast` CSS class directly — no library function needed:

```ts
function showToast(msg: string, type: 'info' | 'success' | 'error' = 'info', ms = 3000) {
  const el = document.createElement('div');
  el.className = `y-toast y-toast-${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
```

**Example: Todo App**

```ts
import { createSignal, For } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';

type Todo = { id: number; text: string; done: boolean };
const [todos, setTodos] = createSignal<Todo[]>([]);
let nextId = 1;

function addTodo(text: string) {
  setTodos(prev => [...prev, { id: nextId++, text, done: false }]);
}

function toggle(id: number) {
  setTodos(prev => prev.map(t => t.id === id ? { ...t, done: !t.done } : t));
}

const handleKey = (e: KeyboardEvent) => {
  const input = e.target as HTMLInputElement;
  if (e.key === 'Enter' && input.value.trim()) {
    addTodo(input.value.trim());
    input.value = '';
  }
};

render(() => html`
  <div class="y-app y-p-3 y-gap-3">
    <h2 class="y-text-lg">Todos</h2>
    <input class="y-input" placeholder="What needs doing?" onKeydown=${handleKey} />
    <${For} each=${todos}>${(todo: Todo) => html`
      <div class="y-card todo-item">
        <span class=${() => todo.done ? 'done' : ''}>${todo.text}</span>
        <button class="y-btn y-btn-sm y-btn-ghost" onClick=${() => toggle(todo.id)}>
          ${todo.done ? '↩' : '✓'}
        </button>
      </div>
    `}</${For}>
    <div class="y-text-sm y-text-muted">${() => {
      const done = todos().filter(t => t.done).length;
      return `${done}/${todos().length} completed`;
    }}</div>
  </div>
`, document.getElementById('app')!);
```

## App Protocol

To make a deployed app controllable by the agent — so it can read app state and send commands — define an App Protocol. Without it, the app is a static iframe the agent cannot interact with after creation.

`window.yaar.app` is auto-injected at runtime (no import needed). The agent discovers your app's manifest, then queries state or sends commands at any time.

### Registration

Put the registration in `src/protocol.ts` and call it from main.ts inside `onMount()`. Always guard with a null check:

```ts
// src/protocol.ts
export function registerProtocol() {
  if (!window.yaar?.app) return;

  window.yaar.app.register({
    appId: 'my-app',
    name: 'My App',
    state: { /* ... */ },
    commands: { /* ... */ },
  });
}
```

### State

State keys expose read-only snapshots. Handlers are called on-demand when the agent queries.

```ts
state: {
  items: {
    description: 'All items as an array',
    handler: () => [...items()],  // read signal, return a copy
  },
  selection: {
    description: 'Currently selected item id or null',
    handler: () => selectedId(),  // read signal
  },
}
```

- Handlers can be sync or async (promises are auto-awaited)
- Return JSON-serializable values only (no Date, Map, Set, circular refs)
- Return copies of objects/arrays (`{...obj}`, `[...arr]`) to prevent mutation

### Commands

Commands are actions the agent can trigger. Use JSON Schema for `params`:

```ts
commands: {
  addItem: {
    description: 'Add a new item',
    params: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        priority: { type: 'number' },
      },
      required: ['title'],
    },
    handler: (p: { title: string; priority?: number }) => {
      const id = nextId++;
      items([...items(), { id, title: p.title, priority: p.priority ?? 0 }]);
      return { ok: true, id };
    },
  },
  clear: {
    description: 'Remove all items',
    params: { type: 'object', properties: {} },
    handler: () => {
      items([]);
      return { ok: true };
    },
  },
}
```

- Handlers can be sync or async
- Return `{ ok: true, ...extraData }` on success
- Throw on error — the SDK catches and reports it to the agent
- `params` uses JSON Schema format: `{ type: 'object', properties: { ... }, required: [...] }`
- `aliases` (optional): alternative command names that resolve to this command. Useful when the agent might guess a synonym (e.g., `sendMessage` instead of `addMessage`):

```ts
addMessage: {
  description: 'Add a message to the chat',
  aliases: ['sendMessage', 'postMessage'],
  // ...
}
```

### Sending Interactions

Call `sendInteraction()` to proactively notify the agent about user actions:

```ts
window.yaar.app.sendInteraction('User clicked save button');
window.yaar.app.sendInteraction({ event: 'cell_select', row: 3, col: 'A' });
```

The interaction is delivered to the window's agent as a `WINDOW_MESSAGE`. Use for significant events the agent should know about — user selections, button clicks, mode changes, etc.

## Verb API

Uses the same `yaar://` URI pattern the agent uses via MCP tools — one mental model for both agent and app code.

### `@bundled/yaar` SDK (recommended)

Import typed helpers that auto-parse responses — no manual `result.content[0].text` extraction:

```ts
import { readJson, readText, invokeJson, listJson, invoke, del, storage, subscribe } from '@bundled/yaar';

// Auto-parsed — returns typed data directly
const settings = await readJson<Settings>('yaar://config/settings');
const hooks = await listJson<Hook[]>('yaar://config/hooks') ?? [];
const html = await readText('yaar://windows/win-notes');

// Raw verbs — returns YaarVerbResult (same as window.yaar.*)
await invoke('yaar://config/settings', { theme: 'dark' });
await del('yaar://config/hooks/hook-1');

// Sub-objects
await storage.save('data.json', JSON.stringify(data));
const unsub = await subscribe('yaar://storage/scores.json', () => reload());
```

| Helper | Returns | Description |
|--------|---------|-------------|
| `readJson<T>(uri)` | `T` | Read + JSON.parse |
| `readText(uri)` | `string` | Read + extract text |
| `invokeJson<T>(uri, payload?)` | `T` | Invoke + JSON.parse |
| `invokeText(uri, payload?)` | `string` | Invoke + extract text |
| `listJson<T>(uri)` | `T` | List + JSON.parse |
| `listText(uri)` | `string` | List + extract text |
| `deleteText(uri)` | `string` | Delete + extract text |
| `invoke(uri, payload?)` | `YaarVerbResult` | Raw invoke |
| `read(uri)` | `YaarVerbResult` | Raw read |
| `list(uri)` | `YaarVerbResult` | Raw list |
| `describe(uri)` | `YaarVerbResult` | Raw describe |
| `del(uri)` | `YaarVerbResult` | Raw delete |
| `subscribe(uri, cb)` | `() => void` | Reactive subscription |
| `storage` | `YaarStorage` | `.save()`, `.read()`, `.list()`, `.remove()`, `.url()` |
| `app` | `YaarApp` | `.register()`, `.sendInteraction()` |
| `notifications` | object | `.list()`, `.count()`, `.onChange()` |
| `windows` | object | `.read()`, `.list()` |

### `window.yaar` global (legacy)

Legacy `window.yaar.*` methods are available without imports but prefer `@bundled/yaar`. Allowed URI prefixes: `yaar://browser/`, `yaar://storage/`, `yaar://apps/self/storage/`, `yaar://windows`. Other URIs return 403. Apps use `self` as the appId — the server resolves it to the real appId from the iframe token.

### Storage Scopes

Two storage scopes available via `@bundled/yaar` or `window.yaar`:
- `yaar://storage/` — global persistent storage (`storage/` on disk)
- `yaar://apps/self/storage/` — app-scoped storage (`storage/apps/{appId}/` on disk)

Always handle missing files (read throws on 404). For binary content in `<img src>`, read the base64 result and create a blob URL.

## HTTP Requests

Iframe `fetch()` is subject to CORS. Use `invoke('yaar://http', { url, method?, headers?, body? })` to proxy requests through the server. Response: `{ ok, status, statusText, headers, body }`. Binary responses have `bodyEncoding: "base64"`. First request to a new domain triggers a user permission dialog. For JS-rendered pages, use `yaar://browser` instead.

## Deploy

`invoke('yaar://sandbox/{sandboxId}', { action: 'deploy', appId: '...', ... })` creates the app folder in `apps/`, copies compiled files, and generates `SKILL.md` so the app appears on the desktop.

| Parameter | Default | Notes |
|-----------|---------|-------|
| `name` | Title-cased appId | Display name shown on desktop |
| `icon` | "🎮" | Emoji icon |
| `keepSource` | `true` | Include `src/` so the app can be cloned later |
| `skill` | auto-generated | Custom SKILL.md body. The `## Launch` section with the correct iframe URL is always auto-appended — only write app-specific instructions, usage guides, etc. |
| `appProtocol` | auto-detected | Set explicitly if auto-detection (scanning HTML for `.app.register`) isn't reliable |
| `capture` | `auto` | Screenshot strategy: `canvas` (toDataURL on largest canvas), `dom` (html2canvas), `svg` (serialize largest SVG), `protocol` (app provides screenshot via App Protocol). Default `auto` tries canvas → svg → dom fallback chain. Set this for faster, more reliable captures. |
| `fileAssociations` | none | File types this app can open. Array of `{ extensions: string[], command: string, paramKey: string }`. Each entry maps file extensions to an `app_command` call — `command` is the command name and `paramKey` is the parameter key for the file content. |
| `permissions` | default allowlist | URI prefixes the app iframe can access. Each entry is either a string (all verbs) or `{ uri, verbs }` to restrict verbs. E.g. `["yaar://storage/", { "uri": "yaar://sessions/", "verbs": ["list"] }]`. |

## run_js Sandbox

The `run_js` tool executes code in an isolated Node.js `vm` sandbox. Code runs in an async IIFE — `await` is supported at the top level. Use `return` to return a value.

**Available globals:** `console` (log, info, warn, error, debug — output captured), `fetch`, `Headers`, `Request`, `Response`, `JSON`, `Math`, `Date`, `Object`, `Array`, `String`, `Number`, `Boolean`, `Map`, `Set`, `RegExp`, Error types, `URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `atob`, `btoa`, `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `Promise`, `structuredClone`, `crypto.createHash`.

**NOT available (security):** `process`, `require`, `import`, `setTimeout`, `setInterval`, `eval`, `Function`, `fs`, `child_process`, `os`.

## Runtime Constraints

Compiled apps run in a **browser iframe sandbox**. They are subject to these hard constraints:

- **No Node.js APIs** — No `fs`, `process`, `child_process`, `net`, etc. This is a browser environment.
- **No server processes** — Apps cannot listen on ports, spawn servers, or run background daemons.
- **No OAuth flows** — OAuth code-for-token exchange requires a server-side `client_secret`. Iframe apps cannot safely perform this. Use the API-based app pattern instead (see below).
- **Browser `fetch()` subject to CORS** — Direct cross-origin requests will be blocked. Use `yaar.invoke('yaar://http', { url, ... })` to proxy requests through the server. See **HTTP Requests** above.
- **No localStorage/IndexedDB** — Use `yaar://storage/` verbs for persistence (server-side, survives across sessions).
- **Self-contained** — Apps must not depend on external servers, localhost services, or infrastructure outside the iframe.

## Anti-Patterns

Common mistakes to avoid when building apps:

- **Don't use empty `html` template literals** — `html``\`` (empty tagged template) crashes Solid.js at runtime (`Cannot read properties of undefined (reading 'name')`). The html parser produces 0 nodes and then tries to access `nodes[0].name`. Use `null` instead:
  ```ts
  // BAD — crashes at runtime
  if (loading()) return html``;
  // GOOD
  if (loading()) return null;
  ```
- **Don't rely on `flex: 1` for height inside reactive expressions** — Solid's `html` tagged template inserts invisible comment marker nodes (`<!---->`) around `${() => ...}` reactive expressions. These nodes break CSS flex height chains because they become extra flex children. Use `position: absolute; inset: 0` on the child instead:
  ```css
  /* BAD — child gets no height because comment markers break flex chain */
  .parent { display: flex; flex-direction: column; }
  .child  { flex: 1; }

  /* GOOD — absolute positioning bypasses flex entirely */
  .parent { position: relative; flex: 1; min-height: 0; }
  .child  { position: absolute; inset: 0; }
  ```
- **Don't guess API endpoints** — Only use endpoints from `read('yaar://skills/host_api')`. If an endpoint isn't listed there, it doesn't exist. Never try multiple speculative URL patterns hoping one works.
- **Don't build OAuth clients as compiled apps** — OAuth requires server-side token exchange with a `client_secret`. Instead, build an API-based app (SKILL.md only) where the user provides a personal access token, stored via `invoke('yaar://config/app/{appId}', { ... })`.
- **Don't assume external servers are running** — There is no backend at `localhost:3000` or any other port. Apps must be fully self-contained.
- **Don't replicate server functionality in iframe** — If the app needs to call external APIs that require auth, the AI agent should handle HTTP calls via `invoke('yaar://http', { url, method?, headers?, body? })` and relay data via App Protocol.
- **Don't hardcode localhost URLs** — Apps run on whatever host YAAR is served from.

### Right Pattern for External Service Integration

```
Option A: API-based app (preferred for API wrappers)
  apps/github/SKILL.md → describes GitHub API, auth flow
  User provides PAT → stored via invoke('yaar://config/app/{appId}', { ... })
  AI calls GitHub API via invoke('yaar://http', ...) → renders in windows

Option B: Compiled app + AI-mediated API (for rich UI)
  Compiled iframe app handles UI/display only
  AI agent handles external API calls via MCP tools
  App Protocol bridges the two:
    app_query → display data from AI to app
    app_command → user actions from app to AI
```

## Related Skills

- `read('yaar://skills/host_api')` — REST endpoints available to iframe apps
