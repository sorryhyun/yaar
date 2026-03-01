# App Development Guide

## Workflow

To create a new app from scratch:
1. `write_ts(path: "src/main.ts", content: "...")` — creates a new sandbox, returns sandboxId
2. `deploy(sandbox: sandboxId, appId: "my-app")` — auto-compiles, installs to `apps/`, appears on desktop

To edit an existing app:
1. `clone(appId)` — copies source into a new sandbox, returns sandboxId
2. Edit with `write_ts` or `apply_diff_ts` using that sandboxId
3. `deploy` back to the same appId

Optional: use `compile(sandbox)` separately if you want a preview URL before deploying.

## Sandbox Structure

Entry point is `src/main.ts`. Split code into multiple files (e.g., `src/utils.ts`, `src/renderer.ts`) and import them from main.ts — avoid putting everything in one file.

## Bundled Libraries

Available via `@bundled/*` imports (no npm install needed):

{{BUNDLED_LIBRARIES}}

Example:
```ts
import { v4 as uuid } from '@bundled/uuid';
import anime from '@bundled/anime';
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

## `@bundled/yaar` — Reactive DOM Library

Tiny reactive library for building apps without manual DOM manipulation.

```ts
import { signal, computed, effect, batch, h, mount, list, Toast } from '@bundled/yaar';
```

**API:**

| Function | Description |
|----------|-------------|
| `signal(initial)` | Reactive value. `sig()` reads, `sig(val)` writes, `sig.value`, `sig.peek()` |
| `computed(fn)` | Derived signal, auto-recomputes on dependency change |
| `effect(fn)` | Side effect, re-runs on tracked signal change. Returns dispose. |
| `batch(fn)` | Batch signal writes into one update |
| `h(tag, props?, ...children)` | Hyperscript. Tag supports `.class#id`. Reactive children via `() => val` |
| `mount(element, container?)` | Append to `#app` (default) |
| `list(container, items$, renderFn, key?)` | Reactive list with key-based reconciliation |
| `Toast.show(msg, type?, duration?)` | Toast notification (info/success/error) |

**Example: Todo App**

```ts
import { signal, h, mount, list, Toast } from '@bundled/yaar';

type Todo = { id: number; text: string; done: boolean };
const todos = signal<Todo[]>([]);
let nextId = 1;

function addTodo(text: string) {
  todos([...todos(), { id: nextId++, text, done: false }]);
  Toast.show('Added!', 'success');
}

function toggle(id: number) {
  todos(todos().map(t => t.id === id ? { ...t, done: !t.done } : t));
}

const input = h('input.y-input', {
  placeholder: 'What needs doing?',
  onKeydown: (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.target as HTMLInputElement).value.trim()) {
      addTodo((e.target as HTMLInputElement).value.trim());
      (e.target as HTMLInputElement).value = '';
    }
  },
});

const listEl = h('div.y-flex-col.y-gap-2.y-scroll.y-flex-1');
list(listEl, todos, (todo) =>
  h('div.y-card.y-flex-between', null,
    h('span', {
      style: { textDecoration: () => todo.done ? 'line-through' : 'none' },
      className: () => todo.done ? 'y-text-dim' : '',
    }, todo.text),
    h('button.y-btn.y-btn-sm.y-btn-ghost', { onClick: () => toggle(todo.id) },
      todo.done ? '↩' : '✓',
    ),
  ),
  (t) => t.id,
);

mount(h('div.y-app.y-p-3.y-gap-3', null,
  h('h2.y-text-lg.y-font-bold', null, 'Todos'),
  input,
  listEl,
  h('div.y-text-sm.y-text-muted', null, () => {
    const done = todos().filter(t => t.done).length;
    return `${done}/${todos().length} completed`;
  }),
));
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

- **Don't guess API endpoints** — Only use endpoints from `skill("host_api")`. If an endpoint isn't listed there, it doesn't exist. Never try multiple speculative URL patterns hoping one works.
- **Don't build OAuth clients as compiled apps** — OAuth requires server-side token exchange with a `client_secret`. Instead, build an API-based app (SKILL.md only) where the user provides a personal access token, stored via `apps_write_config`.
- **Don't assume external servers are running** — There is no backend at `localhost:3000` or any other port. Apps must be fully self-contained.
- **Don't replicate server functionality in iframe** — If the app needs to call external APIs that require auth, the AI agent should handle HTTP calls via `http_get`/`http_post` MCP tools and relay data via App Protocol.
- **Don't hardcode localhost URLs** — Apps run on whatever host YAAR is served from.

### Right Pattern for External Service Integration

```
Option A: API-based app (preferred for API wrappers)
  apps/github/SKILL.md → describes GitHub API, auth flow
  User provides PAT → stored via apps_write_config
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
