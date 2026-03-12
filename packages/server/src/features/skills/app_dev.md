# App Development Guide

## Workflow

To create a new app from scratch:
1. `invoke('yaar://sandbox/new/src/main.ts', { action: 'write', content: '...' })` — creates a new sandbox, returns `{ sandboxId }`
2. `invoke('yaar://sandbox/{sandboxId}', { action: 'deploy', appId: 'my-app' })` — auto-compiles, installs to `apps/`, appears on desktop

To edit an existing app:
1. `invoke('yaar://sandbox/new', { action: 'clone', uri: 'yaar://apps/{appId}' })` — copies source into a new sandbox, returns sandboxId
2. Edit with `invoke('yaar://sandbox/{sandboxId}/path', { action: 'edit', old_string: '...', new_string: '...' })` or `action: 'write'` for full replacement
3. `invoke('yaar://sandbox/{sandboxId}', { action: 'deploy', appId: '...' })` back to the same appId

Optional: use `invoke('yaar://sandbox/{sandboxId}', { action: 'compile' })` separately if you want a preview URL before deploying.

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

## Verb API

Available at runtime via `window.yaar` (auto-injected, no import needed). Uses the same `yaar://` URI pattern the agent uses via MCP tools — one mental model for both agent and app code.

| Method | Description |
|--------|-------------|
| `invoke(uri, payload?)` | Execute an action on a resource |
| `read(uri)` | Read a resource's current value |
| `list(uri)` | List child resources under a URI |
| `describe(uri)` | Get resource description, supported verbs, and invoke schema |
| `delete(uri)` | Delete a resource |

Each method returns a `Promise<{ content: Array<{ type, text?, data?, mimeType? }>, isError? }>`.

**Allowed URI prefixes:** `yaar://browser/`, `yaar://apps/self/storage/`, `yaar://windows`. Other URIs return 403.

Apps use `self` as the appId — the server resolves it to the real appId from the iframe token, so apps can only access their own namespace.

**Error handling:** Methods throw on network errors or when the server returns an error. Always use `.catch()` or try/catch.

```ts
try {
  const result = await yaar.invoke('yaar://browser/tab1', { action: 'open', url });
  const text = result.content[0]?.text;
} catch (err) {
  console.error('Verb call failed:', err.message);
}
```

### Storage (`yaar://apps/self/storage/`)

App-scoped persistent storage. Files are stored on disk at `storage/apps/{appId}/`.

```ts
// Write
await yaar.invoke('yaar://apps/self/storage/scores.json', {
  action: 'write',
  content: JSON.stringify(data),
});

// Read (throws on 404 — always handle missing files)
const result = await yaar.read('yaar://apps/self/storage/scores.json').catch(() => null);
const data = result ? JSON.parse(result.content[0].text) : defaults;

// List directory
const files = await yaar.list('yaar://apps/self/storage/');

// Delete
await yaar.delete('yaar://apps/self/storage/old-data.json');

// Get URL for <a>/<img>/etc. (convenience — still available on legacy API)
const imgUrl = yaar.storage.url('photos/cat.png');
```

### Windows (`yaar://windows`) — Read-Only

Read other windows' content. Apps cannot modify other windows.

```ts
// List all windows
const result = await yaar.list('yaar://windows');
// → content[0].text: [{ id: "win-notes", title: "Notes", renderer: "markdown" }, ...]

// Read a window's content
const result = await yaar.read('yaar://windows/win-notes');
// → content[0].text: { id: "win-notes", title: "Notes", content: "# Hello..." }
```

### Browser (`yaar://browser/`)

Headless Chrome automation.

```ts
// Open a page in headless Chrome
const result = await yaar.invoke('yaar://browser/my-tab', {
  action: 'open',
  url: 'https://example.com',
});

// Read the current browser tab content
const page = await yaar.read('yaar://browser/my-tab');

// List open browser sessions
const sessions = await yaar.list('yaar://browser');
```

### Legacy APIs

`window.yaar.storage.*` and `window.yaar.windows.*` still work but are internally reimplemented over the verb API. Prefer verb URIs for new code.

| Legacy | Verb equivalent |
|--------|-----------------|
| `yaar.storage.save(path, data)` | `yaar.invoke('yaar://apps/self/storage/' + path, { action: 'write', content: data })` |
| `yaar.storage.read(path)` | `yaar.read('yaar://apps/self/storage/' + path)` |
| `yaar.storage.list(dir)` | `yaar.list('yaar://apps/self/storage/' + dir)` |
| `yaar.storage.remove(path)` | `yaar.delete('yaar://apps/self/storage/' + path)` |
| `yaar.storage.url(path)` | No verb equivalent — use `yaar.storage.url()` directly |
| `yaar.windows.read(id)` | `yaar.read('yaar://windows/' + id)` |
| `yaar.windows.list()` | `yaar.list('yaar://windows')` |

## HTTP Proxy APIs

Iframe apps are subject to CORS. Two server-side proxies bypass this:

### `/api/fetch` — Raw HTTP Proxy

For simple HTTP requests (API calls, HTML scraping of server-rendered pages):

```ts
const res = await fetch('/api/fetch', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: 'https://example.com/api/data',
    method: 'GET',                          // optional, default GET
    headers: { 'Accept': 'application/json' }, // optional, forwarded to target
    body: '...',                            // optional, for POST/PUT
  }),
});
const data = await res.json();
// → { ok: true, status: 200, statusText: "OK", headers: {...}, body: "..." }
// Binary responses: body is base64, bodyEncoding: "base64"
```

- First request to a new domain triggers a user permission dialog
- `Referer` headers targeting the upstream site are forwarded (useful for sites that check referer)
- Max response: 10MB, timeout: 30s

### `/api/browse` — Headless Chrome Proxy

For JS-rendered pages (SPAs, dynamic content). Navigates a real browser and extracts content:

```ts
const res = await fetch('/api/browse', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: 'https://example.com/spa-page',
    extract: 'text',                         // "text" | "html" | "screenshot"
    selector: '.main-content',               // optional CSS selector
    waitUntil: 'networkidle',                // optional: "load" | "domcontentloaded" | "networkidle"
  }),
});
const data = await res.json();
// text/html → { ok, url, title, text, links, forms }
// screenshot → { ok, url, title, screenshot: "<base64>", format: "webp" }
```

- Requires Chrome/Edge on the server (returns 503 if unavailable)
- Same domain allowlist as `/api/fetch`
- Each request gets a temporary browser tab (cleaned up after)
- Timeout: 30s

### When to Use Which

| Scenario | Use |
|----------|-----|
| REST API calls, JSON endpoints | `/api/fetch` |
| Server-rendered HTML scraping | `/api/fetch` + `DOMParser` |
| JS-rendered SPA content | `/api/browse` |
| Page screenshots / visual capture | `/api/browse` with `extract: "screenshot"` |

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

## Runtime Constraints

Compiled apps run in a **browser iframe sandbox**. They are subject to these hard constraints:

- **No Node.js APIs** — No `fs`, `process`, `child_process`, `net`, etc. This is a browser environment.
- **No server processes** — Apps cannot listen on ports, spawn servers, or run background daemons.
- **No OAuth flows** — OAuth code-for-token exchange requires a server-side `client_secret`. Iframe apps cannot safely perform this. Use the API-based app pattern instead (see below).
- **Browser `fetch()` subject to CORS** — Direct cross-origin requests will be blocked. Use `/api/fetch` (raw HTTP proxy) or `/api/browse` (headless Chrome) to bypass CORS. See **HTTP Proxy APIs** above.
- **No localStorage/IndexedDB** — Use `window.yaar.storage` for persistence (server-side, survives across sessions).
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
- **Don't guess API endpoints** — Only use endpoints from `read('yaar://skills/host_api')`. If an endpoint isn't listed there, it doesn't exist. Never try multiple speculative URL patterns hoping one works.
- **Don't build OAuth clients as compiled apps** — OAuth requires server-side token exchange with a `client_secret`. Instead, build an API-based app (SKILL.md only) where the user provides a personal access token, stored via `invoke('yaar://config/app/{appId}', { ... })`.
- **Don't assume external servers are running** — There is no backend at `localhost:3000` or any other port. Apps must be fully self-contained.
- **Don't replicate server functionality in iframe** — If the app needs to call external APIs that require auth, the AI agent should handle HTTP calls via `http_get`/`http_post` MCP tools and relay data via App Protocol.
- **Don't hardcode localhost URLs** — Apps run on whatever host YAAR is served from.

### Right Pattern for External Service Integration

```
Option A: API-based app (preferred for API wrappers)
  apps/github/SKILL.md → describes GitHub API, auth flow
  User provides PAT → stored via invoke('yaar://config/app/{appId}', { ... })
  AI calls GitHub API via http_get/http_post → renders in windows

Option B: Compiled app + AI-mediated API (for rich UI)
  Compiled iframe app handles UI/display only
  AI agent handles external API calls via MCP tools
  App Protocol bridges the two:
    app_query → display data from AI to app
    app_command → user actions from app to AI
```

## Related Skills

- `read('yaar://skills/host_api')` — REST endpoints available to iframe apps
- `read('yaar://skills/app_protocol')` — Bidirectional agent-iframe communication (state, commands, interactions)
