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

Apps can communicate bidirectionally with the AI agent via `window.yaar.app` (auto-injected, no import needed).

### Registering Capabilities

Call `register()` to declare what state the agent can query and what commands it can send:

```ts
window.yaar.app.register({
  appId: 'my-app',
  name: 'My App',
  state: {
    selection: {
      description: 'Currently selected item',
      handler: () => ({ row: 3, col: 'A' }),
    },
  },
  commands: {
    setCellValue: {
      description: 'Set value of a cell',
      params: { row: 'number', col: 'string', value: 'string' },
      handler: (params) => {
        // Apply the change and return result
        return { success: true };
      },
    },
  },
});
```

After `register()`, the agent can discover your app's capabilities via its manifest, then query state or send commands at any time.

### Sending Interactions to the Agent

Call `sendInteraction()` to proactively notify the agent about user actions:

```ts
// String description
window.yaar.app.sendInteraction('User selected cell A3');

// Object (auto-serialized to JSON)
window.yaar.app.sendInteraction({ event: 'cell_select', row: 3, col: 'A' });
```

The interaction is delivered to the window's agent as a `WINDOW_MESSAGE`. Use this for events the agent should know about — user selections, button clicks, mode changes, etc.
