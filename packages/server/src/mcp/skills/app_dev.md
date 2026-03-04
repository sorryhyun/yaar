# App Development Guide

## Workflow

To create a new app from scratch:
1. `write(uri: "sandbox:///src/main.ts", content: "...")` — creates a new sandbox (triple slash = new sandbox), returns `{ sandboxId }`
2. `deploy(sandbox: sandboxId, appId: "my-app")` — auto-compiles, installs to `apps/`, appears on desktop

To edit an existing app:
1. `clone(appId)` — copies source into a new sandbox, returns sandboxId
2. Edit with `edit(uri: "sandbox://{sandboxId}/path", old_string, new_string)` or `write` for full replacement
3. `deploy` back to the same appId

Optional: use `compile(sandbox)` separately if you want a preview URL before deploying.

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
| `y-scroll` | Styled scrollbar container |
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

## Storage API

Available at runtime via `window.yaar.storage` (auto-injected, no import needed):

| Method | Description |
|--------|-------------|
| `save(path, data)` | Write file (`string \| Blob \| ArrayBuffer \| Uint8Array`) |
| `read(path, opts?)` | Read file (`opts.as`: `'text' \| 'blob' \| 'arraybuffer' \| 'json' \| 'auto'`) |
| `list(dirPath?)` | List directory → `[{path, isDirectory, size, modifiedAt}]` |
| `remove(path)` | Delete file |
| `url(path)` | Get URL string for `<a>`/`<img>`/etc. |

Files are stored in the server's `storage/` directory. Paths are relative (e.g., `"myapp/data.json"`).

```ts
// Save
await yaar.storage.save('scores.json', JSON.stringify(data));
// Read (throws on 404 — always handle missing files)
const data = await yaar.storage.read('scores.json', { as: 'json' }).catch(() => null);
// Get URL for display
const imgUrl = yaar.storage.url('photos/cat.png');
```

**Error handling:** `read()` throws when the file doesn't exist (404). Always use `.catch()` or try/catch to handle missing files gracefully — especially on first launch when no data has been saved yet. Never call `fetch('/api/...')` directly for endpoints not listed in `skill("host_api")` — they don't exist and will 404.

## Deploy

`deploy(sandbox, appId, ...)` creates the app folder in `apps/`, copies compiled files, and generates `SKILL.md` so the app appears on the desktop.

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
- **Browser `fetch()` only** — Apps can make HTTP requests, but they are subject to CORS restrictions. Many APIs will block direct browser requests.
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
- **Don't guess API endpoints** — Only use endpoints from `skill("host_api")`. If an endpoint isn't listed there, it doesn't exist. Never try multiple speculative URL patterns hoping one works.
- **Don't build OAuth clients as compiled apps** — OAuth requires server-side token exchange with a `client_secret`. Instead, build an API-based app (SKILL.md only) where the user provides a personal access token, stored via `set_config(section: "app")`.
- **Don't assume external servers are running** — There is no backend at `localhost:3000` or any other port. Apps must be fully self-contained.
- **Don't replicate server functionality in iframe** — If the app needs to call external APIs that require auth, the AI agent should handle HTTP calls via `http_get`/`http_post` MCP tools and relay data via App Protocol.
- **Don't hardcode localhost URLs** — Apps run on whatever host YAAR is served from.

### Right Pattern for External Service Integration

```
Option A: API-based app (preferred for API wrappers)
  apps/github/SKILL.md → describes GitHub API, auth flow
  User provides PAT → stored via set_config(section: "app")
  AI calls GitHub API via http_get/http_post → renders in windows

Option B: Compiled app + AI-mediated API (for rich UI)
  Compiled iframe app handles UI/display only
  AI agent handles external API calls via MCP tools
  App Protocol bridges the two:
    app_query → display data from AI to app
    app_command → user actions from app to AI
```

## Related Skills

- **host_api** — REST endpoints available to iframe apps
- **app_protocol** — Bidirectional agent-iframe communication (state, commands, interactions)
