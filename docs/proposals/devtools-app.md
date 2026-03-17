# Proposal: `devtools` App

## Status: Phase 1 Implemented

Phase 1 is complete. The devtools app is fully additive — the existing sandbox path continues to work unchanged.

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
  → Devtools iframe manages files via appStorage, calls dev SDK for compile/deploy
  → UI shows file tree, editor, diagnostics, preview in real-time
```

### How the iframe handles commands

The devtools iframe receives commands via app protocol and maps them to the right operations:

| Command | Iframe implementation |
|---------|----------------------|
| `createProject` | Create directory structure in `appStorage` |
| `writeFile` | `appStorage.save(path, content)` |
| `editFile` | Read → apply edit → save back |
| `compile` | `dev.compile(projectPath)` via `@bundled/yaar` SDK |
| `typecheck` | `dev.typecheck(projectPath)` via `@bundled/yaar` SDK |
| `deploy` | `dev.deploy(projectPath, { appId, ... })` via `@bundled/yaar` SDK |

### Dev SDK (`@bundled/yaar`)

Compile, typecheck, and deploy are platform capabilities exposed via the `@bundled/yaar` SDK shim. Any iframe app can import and use them — no per-app configuration needed.

```typescript
import { dev } from '@bundled/yaar';

// path is relative to app storage (e.g., "projects/123")
await dev.compile(path, { title: 'My App' });
await dev.typecheck(path);
await dev.deploy(path, { appId: 'my-app', icon: '🎮' });
```

Under the hood, the SDK makes direct HTTP calls to `/api/dev/{action}` with iframe token auth. The server resolves the path relative to the calling app's storage directory (`storage/apps/{appId}/{path}`).

```
iframe: dev.compile("projects/123")
  → POST /api/dev/compile { path: "projects/123" }
  → server resolves: storage/apps/devtools/projects/123/
  → calls lib/compiler/compileTypeScript(absolutePath)
  → returns { success, previewUrl }
```

The route (`http/routes/dev.ts`) validates the iframe token, prevents path traversal, and dynamically imports heavy modules (`lib/compiler/`, `features/dev/deploy.ts`).

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
| `apps/devtools/app.json` | Metadata, protocol manifest, permissions |
| `apps/devtools/SKILL.md` | Agent workflow instructions |
| `apps/devtools/src/main.ts` | Entry point: toolbar, layout assembly, project selector |
| `apps/devtools/src/project.ts` | State management (signals) + all operations (CRUD, compile, deploy) |
| `apps/devtools/src/protocol.ts` | App protocol registration (6 state keys, 11 commands) |
| `apps/devtools/src/file-tree.ts` | File tree sidebar component |
| `apps/devtools/src/editor.ts` | Prism.js code viewer with reactive highlighting |
| `apps/devtools/src/diagnostics.ts` | Problems panel with severity, location, click-to-open |
| `apps/devtools/src/styles.css` | IDE grid layout using `--yaar-*` design tokens |
| `packages/server/src/http/routes/dev.ts` | `/api/dev/{compile,typecheck,deploy}` — iframe token auth, path resolution, dynamic imports |

#### Modified files

| File | Change |
|------|--------|
| `packages/server/src/lib/compiler/shims/yaar.ts` | Added `dev` namespace (compile, typecheck, deploy) to `@bundled/yaar` SDK |
| `packages/server/src/lib/bundled-types/yaar.d.ts` | Added `YaarDev` interface for type-checking |
| `packages/server/src/lib/bundled-types/index.d.ts` | Added `dev` export to `@bundled/yaar` module declaration |
| `packages/server/src/http/routes/index.ts` | Re-export `handleDevRoutes` |
| `packages/server/src/http/server.ts` | Register `/api/dev` route in dispatch chain |
| `packages/server/src/features/dev/deploy.ts` | Added optional `sourcePath` to `DeployArgs` — uses it instead of `getSandboxPath(sandboxId)` when provided |

#### Design decisions

- **Dev SDK, not server actions** — compile/typecheck/deploy are platform capabilities in `@bundled/yaar`, not per-app `serverActions` declarations. Any iframe app can use `dev.compile()`. This avoids a new config concept in `app.json` and the awkward round-trip of iframe → verb API → same app's handler → compiler.
- **Direct HTTP route** — The dev SDK calls `POST /api/dev/{action}` directly, bypassing the verb system. Simpler and faster than routing through `yaar://apps/self` invoke.
- **`sourcePath` on `DeployArgs`** — minimal change to `doDeploy()`. When provided, overrides the sandbox path lookup.
- **Dynamic imports** — `compileTypeScript`, `typecheckSandbox`, and `doDeploy` are dynamically imported in the route handler to avoid loading heavy modules at startup.
- **Path traversal prevention** — path is validated to not contain `..` or start with `/`.

### Phase 1.5: AGENT.md for app agents (done)

Added `AGENT.md` support for app agents. When `apps/{appId}/AGENT.md` exists, it replaces the generic hardcoded system prompt. Protocol manifest from `app.json` is still appended.

- `features/apps/discovery.ts` — added `loadAppAgentDoc(appId)` loader
- `agents/profiles/app-agent.ts` — loads AGENT.md as base prompt, falls back to generic prompt
- `apps/devtools/AGENT.md` — full app development reference adapted from the `app_dev` skill doc, reframed for command-based workflow

**Deferred: bundled libraries as protocol state** — Currently the bundled library list is hardcoded in `AGENT.md`. A cleaner approach is to expose it as a protocol state key (e.g., `query("bundledLibraries")`) so the agent always gets the live list from the compiler. This requires adding a `bundledLibraries` state handler in `apps/devtools/src/protocol.ts` backed by a new `/api/dev/bundled-libraries` endpoint (or a command that calls the server). Low priority since the library list changes infrequently.

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

5. **Extending `/api/dev`**: The dev route currently handles compile/typecheck/deploy. Future dev operations (format, lint, LSP) would be added here as new actions, keeping them as platform capabilities any app can use via the SDK.
