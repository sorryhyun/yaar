# Devtools Roadmap

## Completed

### Phase 1 — IDE Foundation
- File tree with directory nesting
- Read-only code viewer (Prism.js syntax highlighting)
- Diagnostics panel (typecheck errors/warnings)
- Compile, typecheck, deploy commands via app protocol
- Project CRUD (create, open, delete, list)
- File CRUD (write, edit, delete, open)
- Preview window request via sendInteraction

### Phase 2 — Interactive Editing
- **User editing**: Textarea editor with debounced auto-save, Ctrl+S, Tab→2 spaces, dirty indicator
- **Multi-project tabs**: Tab bar with close buttons, auto-managed on open/create/delete
- **Console capture**: Injected script overrides console.log/warn/error/info in all compiled apps, postMessage to parent. Tabbed bottom panel (Problems | Console) with clear button
- **Clone app**: `invoke('yaar://apps/{appId}', { action: 'clone' })` reads `src/` recursively. Devtools creates a new project from the cloned files
- **Bundled library discovery**: `GET /api/dev/bundled-libraries` endpoint, `query("bundledLibraries")` state, hardcoded list removed from AGENTS.md

## Phase 3 — Proposals

Candidates roughly ordered by impact/effort ratio. Not all need to happen — pick what matters.

### 3.1 Visible Preview Pane

Currently the preview iframe is hidden (`display:none`) and only used for console capture. Show it as a resizable split pane next to the editor. Toggle via toolbar button. Agent's "Preview" button would switch to this pane instead of requesting a separate window.

- Add `[showPreview, setShowPreview]` signal
- Split `.editor-area` into editor + preview columns when active
- Reuse the hidden iframe, just make it visible

### 3.2 File Tabs (Open Files)

VS Code-style file tabs within a project. Currently clicking a file replaces the editor content. Multi-file tabs let users keep several files open and switch between them.

- `[openFileTabs, setOpenFileTabs]` signal (array of paths)
- Tab bar below the project tabs or above the editor
- Close tab = remove from list, switch to next
- Dirty indicators per tab

### 3.3 New File / Rename / Move

The file tree currently only supports open and delete. Add:
- Right-click context menu (or toolbar button) for New File, New Folder, Rename, Move
- New File command in protocol: `command("newFile", { path })`
- Rename: read old → write new → delete old

### 3.4 Find & Replace

Search within the current file (Ctrl+F) and optionally across all project files (Ctrl+Shift+F).

- Overlay search bar in editor area
- Highlight matches in textarea (tricky with plain textarea — may need to overlay a highlight layer or switch to a richer editor)
- Cross-file search returns results list, click to open file at line

### 3.5 Syntax Highlighting (CodeMirror)

Phase 2 traded Prism.js for an editable textarea. To get highlighting back:
- Option A: CodeMirror 6 as a `@bundled/codemirror` library — full editor with highlighting, but adds bundle weight
- Option B: Lightweight highlight overlay on top of textarea (transparent textarea over a `<pre>` with highlighted HTML)
- Option C: Keep textarea as-is — it works, and the agent does most editing anyway

### 3.6 Project Templates

When creating a new project, offer templates beyond the default "Hello, X!" scaffold:
- Blank (current default)
- App Protocol (with protocol.ts boilerplate)
- Canvas game (p5 or konva setup)
- Data dashboard (chart.js setup)
- Widget (panel variant, frameless)

Could be a `templates/` directory in devtools storage, or hardcoded in `createProject()`.

### 3.7 Hot Reload

After saving a file, auto-recompile and refresh the preview pane. The console capture iframe already loads `previewIframeUrl` — updating the URL (with a cache-bust query param) triggers a reload.

- Debounce: recompile 2s after last save
- Show "Recompiling..." status
- Preserve console logs across reloads (or clear, configurable)

### 3.8 Export / Import Project

Export a project as a `.zip` file (or JSON bundle) for sharing. Import from a file upload or URL.

- Export: collect all files from app storage, create zip via a bundled library or server endpoint
- Import: parse zip, write files to new project

### 3.9 Diff View

Show a diff when the agent edits a file (before/after). Useful for understanding what the agent changed.

- Capture previous content on `writeFile`/`editFile`
- Show inline diff in a modal or side panel
- Accept/reject changes

### 3.10 Collaborative Agent Editing

Let the user and agent edit the same file simultaneously. Currently, agent `writeFile` overwrites the editor content and resets dirty state. With collaborative editing:

- Merge agent changes with local unsaved edits (operational transform or last-write-wins with conflict detection)
- Notify user when agent modifies the currently open file
- Show "Agent edited this file" toast
