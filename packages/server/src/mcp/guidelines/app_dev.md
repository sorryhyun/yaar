# App Development Guide

## Workflow

To create a new app from scratch:
1. `write_ts(path: "src/main.ts", content: "...")` — creates a new sandbox, returns sandboxId
2. `compile(sandbox: sandboxId)` — bundles to HTML, returns preview URL
3. `deploy(sandbox: sandboxId, appId: "my-app")` — installs to `apps/`, appears on desktop

To edit an existing app:
1. `clone(appId)` — copies source into a new sandbox, returns sandboxId
2. Edit with `write_ts` or `apply_diff_ts` using that sandboxId
3. `compile` → `deploy` back to the same appId

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
// Read
const data = await yaar.storage.read('scores.json', { as: 'json' });
// Get URL for display
const imgUrl = yaar.storage.url('photos/cat.png');
```

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

## App Protocol

To make a deployed app controllable by the agent — so it can read app state and send commands — define an App Protocol. Without it, the app is a static iframe the agent cannot interact with after creation.

`window.yaar.app` is auto-injected at runtime (no import needed). The agent discovers your app's manifest, then queries state or sends commands at any time.

### Registration

Call `register()` **at the end of main.ts** after all DOM setup is complete. Always guard with a null check:

```ts
const appApi = (window as any).yaar?.app;
if (appApi) {
  appApi.register({
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
    handler: () => [...items],  // return a copy, not the original
  },
  selection: {
    description: 'Currently selected item id or null',
    handler: () => selectedId,
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
      items.push({ id: nextId++, title: p.title, priority: p.priority ?? 0 });
      render();
      return { ok: true, id: nextId - 1 };
    },
  },
  clear: {
    description: 'Remove all items',
    params: { type: 'object', properties: {} },
    handler: () => {
      items.length = 0;
      render();
      return { ok: true };
    },
  },
}
```

- Handlers can be sync or async
- Return `{ ok: true, ...extraData }` on success
- Throw on error — the SDK catches and reports it to the agent
- `params` uses JSON Schema format: `{ type: 'object', properties: { ... }, required: [...] }`

### Sending Interactions

Call `sendInteraction()` to proactively notify the agent about user actions:

```ts
window.yaar.app.sendInteraction('User clicked save button');
window.yaar.app.sendInteraction({ event: 'cell_select', row: 3, col: 'A' });
```

The interaction is delivered to the window's agent as a `WINDOW_MESSAGE`. Use for significant events the agent should know about — user selections, button clicks, mode changes, etc.
