# Proposal: `devtools` App

## Status: Phase 1 Implemented

Phase 1 is complete. The devtools app and server action dispatch are fully additive — the existing sandbox path continues to work unchanged.

## Problem

The `yaar://sandbox/*` URI handler is a God object. Its `describe()` returns the full schema for write, edit, compile, typecheck, deploy, and clone — and this schema is visible to **every agent** via the verb tools, even a chat app agent that will never touch the sandbox.

```
invoke('yaar://sandbox/*', { action: "write" | "edit" | "compile" | "typecheck" | "deploy" | "clone", ... })
```

The invoke schema already has 12 properties. As we add dev features (LSP diagnostics, formatting, refactoring, multi-file rename, dependency management...), this schema grows unboundedly and pollutes the context window of non-dev agents.

Meanwhile, the `APP_PROFILE` subagent (delegated via Task) duplicates much of this knowledge in its system prompt — sandbox workflow, compile steps, deploy args — creating a second maintenance surface.

## Proposal

Introduce a `devtools` app that uses **app protocol** to scope all development operations behind `query`/`command`, invisible to non-dev agents.

### What changes

| Today | After |
|-------|-------|
| `yaar://sandbox/*` handles file I/O + compile + typecheck + deploy + clone | Devtools app owns its workspace via app storage |
| Dedicated `sandbox/` directory on disk | Projects live in `storage/apps/devtools/projects/{id}/` |
| `APP_PROFILE` subagent with full verb tools | `devtools` app agent with `query`/`command`/`relay` |
| Dev features described in sandbox invoke schema (visible to all) | Dev features described in protocol manifest (visible only to devtools agent) |
| `clone` as a sandbox verb with dedicated directory management | Just "read app source → write to app storage" — a command, not a verb |

### What stays the same

- `yaar://sandbox/eval` — standalone ephemeral JS execution, no change
- The compiler, typechecker, deployer implementations (`lib/compiler/*`) — reused, they just take a filesystem path

## Architecture

### Storage model

Today, sandbox files live in a top-level `sandbox/` directory:
```
sandbox/{id}/src/main.ts     ← sandbox verb handler manages this
sandbox/{id}/dist/index.html  ← compiler outputs here
```

With devtools, projects live in **app storage** (`storage/apps/devtools/`):
```
storage/apps/devtools/
  projects/{id}/
    src/main.ts               ← devtools iframe manages via appStorage
    dist/index.html            ← compiler outputs here
    app.json                   ← project metadata (name)
```

The compiler functions (`compileTypeScript`, `typecheckSandbox`) already just take a filesystem path — they don't care whether it's `sandbox/` or app storage. No compiler changes needed.

### Flow

```
User: "build me a todo app"
  → Monitor agent opens devtools window (if not already open)
  → Devtools app agent takes over via app protocol
  → Agent uses command("createProject", { name: "todo-app" })
  → Agent uses command("writeFile", { path: "src/main.ts", content: "..." })
  → Agent uses command("compile")
  → Agent uses command("deploy", { appId: "todo", icon: "✅" })
  → Devtools iframe manages files via appStorage, calls server for compile/deploy
  → UI shows file tree, editor, diagnostics, preview in real-time
```

### How the iframe handles commands

The devtools iframe receives commands via app protocol and maps them to the right operations:

| Command | Iframe implementation |
|---------|----------------------|
| `createProject` | Create directory structure in `appStorage` |
| `writeFile` | `appStorage.save(path, content)` |
| `editFile` | Read → apply edit → save back |
| `compile` | `invokeJson('yaar://apps/self', { action: "compile", projectId })` |
| `typecheck` | `invokeJson('yaar://apps/self', { action: "typecheck", projectId })` |
| `deploy` | `invokeJson('yaar://apps/self', { action: "deploy", projectId, appId, ... })` |

### Server action dispatch

No new URI namespace or `features/` modules. The apps handler (`handlers/apps.ts`) dispatches server actions directly to `lib/compiler/` and `features/dev/deploy.ts`.

Apps declare **server actions** in `app.json`:

```json
// apps/devtools/app.json
{
  "serverActions": {
    "compile":   { "description": "Compile a project" },
    "typecheck": { "description": "Type check a project" },
    "deploy":    { "description": "Deploy project as an installed app" }
  }
}
```

The handler resolution:
```
invoke('yaar://apps/self', { action: "compile", projectId: "abc" })
  → apps handler sees action "compile" — not a built-in action
  → checks if app has serverActions["compile"] declared in app.json
  → handleServerAction() resolves project path: storage/apps/{appId}/projects/{projectId}/
  → calls lib/compiler/compileTypeScript(projectPath) directly
  → returns { success, previewUrl }
```

The dispatch lives in `handleServerAction()` at module level in `handlers/apps.ts` (~60 lines). Heavy modules (`lib/compiler/`, `features/dev/deploy.ts`) are dynamically imported. This pattern is generic — any app can declare server actions. But the schema only appears when describing that specific app, not in the global `yaar://apps/*` describe output.

### Preview serving

Compiled output lands at `storage/apps/devtools/projects/{id}/dist/index.html`. This is already served by the existing `/api/storage/` route:

```
/api/storage/apps/devtools/projects/{id}/dist/index.html
```

From inside the devtools iframe, use `apps/self/` which resolves via iframe token:

```
/api/storage/apps/self/projects/{id}/dist/index.html
```

No new route needed.

### Protocol manifest

```json
{
  "appProtocol": true,
  "permissions": [
    "yaar://apps/self/storage/",
    "yaar://apps/",
    "yaar://skills/"
  ],
  "protocol": {
    "state": {
      "project": { "description": "Active project — { id, name, files[], metadata }" },
      "projects": { "description": "All projects — [{ id, name, lastModified }]" },
      "openFile": { "description": "Currently open file — { path, content, language }" },
      "diagnostics": { "description": "TypeScript errors/warnings — [{ file, line, message, severity }]" },
      "compileStatus": { "description": "Compilation state — 'idle' | 'compiling' | 'success' | 'error'" },
      "previewUrl": { "description": "URL of last successful compilation, or null" }
    },
    "commands": {
      "createProject": { "description": "Create a new project ({ name, template? })" },
      "openProject": { "description": "Switch to an existing project ({ id })" },
      "deleteProject": { "description": "Delete a project ({ id })" },
      "openFile": { "description": "Open a file in the editor ({ path })" },
      "writeFile": { "description": "Write content to a file ({ path, content })" },
      "editFile": { "description": "Edit a file ({ path, oldString, newString })" },
      "deleteFile": { "description": "Delete a file ({ path })" },
      "compile": { "description": "Compile the active project" },
      "typecheck": { "description": "Run TypeScript type checker on the active project" },
      "deploy": { "description": "Deploy to apps/ ({ appId, name?, icon?, description?, permissions? })" },
      "preview": { "description": "Open/refresh the preview window" }
    }
  }
}
```

## The devtools UI

Solid.js app with IDE-style layout:

```
┌─────────────────────────────────┐
│ [project ▾] Typecheck Compile ▶ │
├────────┬────────────────────────┤
│ Files  │ src/main.ts            │
│        │                        │
│ ▸ src/ │  import { ... }        │
│  main  │  from '@bundled/...'   │
│  style │                        │
│        │  const App = () => {   │
│ app.j  │    return <div>...</   │
│        │  }                     │
│        ├────────────────────────┤
│        │ Problems               │
│        │ ❌ src/main.ts:12 ...  │
├────────┴────────────────────────┤
│ ● Ready                   name │
└─────────────────────────────────┘
```

- **Toolbar**: Project dropdown selector (+ "New Project"), Typecheck / Compile / Preview buttons
- **File tree**: Lists project files from appStorage, sorted (directories first), click to open
- **Editor**: Read-only code viewer with Prism.js syntax highlighting (TypeScript, CSS, JSON, Markdown)
- **Diagnostics panel**: Shows typecheck/compile errors with severity icon, file:line, message. Click to open file.
- **Statusbar**: Compile status indicator (idle/compiling/success/error with pulse animation), status text, project name
- **Preview**: "Preview" button sends `sendInteraction()` to the agent, which creates a proper window with the compiled output

User interactions flow back to the agent via `sendInteraction()` — e.g., preview requests, compile failures.

## Implementation

### Phase 1: Build the devtools app (done)

Fully additive — no changes to existing sandbox or agent code. Both paths work side by side.

#### Created files

| File | Purpose |
|------|---------|
| `apps/devtools/app.json` | Metadata, protocol manifest, server actions, permissions |
| `apps/devtools/SKILL.md` | Agent workflow instructions |
| `apps/devtools/src/main.ts` | Entry point: toolbar, layout assembly, project selector |
| `apps/devtools/src/project.ts` | State management (signals) + all operations (CRUD, compile, deploy) |
| `apps/devtools/src/protocol.ts` | App protocol registration (6 state keys, 11 commands) |
| `apps/devtools/src/file-tree.ts` | File tree sidebar component |
| `apps/devtools/src/editor.ts` | Prism.js code viewer with reactive highlighting |
| `apps/devtools/src/diagnostics.ts` | Problems panel with severity, location, click-to-open |
| `apps/devtools/src/styles.css` | IDE grid layout using `--yaar-*` design tokens |

#### Modified files

| File | Change |
|------|--------|
| `packages/server/src/handlers/apps.ts` | Server action dispatch (~60 lines): validates `projectId`, resolves path, dispatches `compile`/`typecheck`/`deploy` via dynamic imports to `lib/compiler/` and `features/dev/deploy.ts` |
| `packages/server/src/features/apps/discovery.ts` | Reads `serverActions` from `app.json` into `AppInfo` |
| `packages/server/src/features/dev/deploy.ts` | Added optional `sourcePath` to `DeployArgs` — uses it instead of `getSandboxPath(sandboxId)` when provided |

#### Design decisions

- **No `features/apps/server-actions/` directory** — the dispatch calls `lib/compiler/` directly from the handler. Compile/typecheck are already in `lib/`, deploy stays in `features/dev/` (has server deps like `actionEmitter`). No extra indirection layer.
- **`sourcePath` on `DeployArgs`** — minimal change to `doDeploy()`. When provided, overrides the sandbox path lookup.
- **Dynamic imports** — `compileTypeScript`, `typecheckSandbox`, and `doDeploy` are dynamically imported in the handler to avoid loading heavy modules at startup.
- **Path traversal prevention** — `projectId` is validated to not contain `..` or `/`.

### Phase 2: Advanced features

- **LSP-lite**: `tsc --watch` in background, pipe diagnostics to devtools via `yaar://` subscription
- **User editing**: Upgrade Prism.js to CodeMirror, add editable mode
- **Templates**: Project templates selectable from UI (solid, vanilla, game, widget)
- **Console capture**: Show iframe console.log output in diagnostics panel
- **Multi-project**: Tabbed project switching
- **Clone**: Read app source via `list`/`read` on `yaar://apps/{appId}/storage/`, write to devtools project storage

### Phase 3: Slim down (later, once devtools is proven)

1. Remove compile/typecheck/deploy/clone actions from `handlers/sandbox.ts` invoke schema
2. Remove `APP_PROFILE` agent profile (`agents/profiles/app.ts`)
3. Simplify `SANDBOX_SECTION` in shared-sections.ts
4. Optionally remove the `sandbox/` directory concept entirely — `yaar://sandbox/eval` could move to `yaar://eval` or stay as-is
5. Clean up `features/dev/deploy.ts` `doClone()` — no longer needed as a standalone function
6. **Remove line numbers from storage/sandbox reads**: Currently `applyReadOptions()` in `handlers/utils.ts` always prepends line numbers (`1│`, `2│`, ...) to text file reads. Once devtools owns code editing, non-dev agents no longer need line-numbered reads. Changes:
   - `handlers/utils.ts` `applyReadOptions()` — return raw content by default, line numbers only when explicitly requested
   - `features/sandbox/files.ts` `readSandboxFile()` — drop the `numbered` formatting
   - The devtools editor handles line display in the UI — the agent sees structured data, not formatted text

## Open questions

1. **Panel vs standard window**: Currently `createShortcut: false` (no desktop icon, agent opens it on demand). Could use `variant: "panel"` for docked IDE feel, or standard window for flexibility.

2. **CodeMirror bundling**: ~150KB min. Worth adding as `@bundled/codemirror`? Defer to Phase 2.

3. **How does the monitor agent know to open devtools?** The devtools app appears in `list('yaar://apps')` — the agent can discover it naturally. Could also add explicit guidance to the system prompt or use `fileAssociations`.

4. **Project isolation**: Each project in `storage/apps/devtools/projects/{id}/`. No concurrent project limit or disk cleanup policy yet.

5. **Server actions as a generic pattern**: The `serverActions` in `app.json` + handler delegation pattern could be useful for other apps too (e.g., server-side PDF generation, data processing). Currently the dispatch switch is in `handleServerAction()` in `handlers/apps.ts` — if more apps need server actions, extract to a plugin/module pattern.
