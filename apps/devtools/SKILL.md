# Devtools

IDE for building and deploying YAAR apps. Manages projects in app storage, provides file editing, compilation, type checking, and deployment.

## Workflow

1. Open devtools window if not already open
2. Create a project: `command("createProject", { name: "my-app" })`
3. Write files: `command("writeFile", { path: "src/main.ts", content: "..." })`
4. Write styles: `command("writeFile", { path: "src/styles.css", content: "..." })`
5. Type check: `command("typecheck")`
6. Compile: `command("compile")`
7. Deploy: `command("deploy", { appId: "my-app", name: "My App", icon: "✅" })`

## Reading Files

- **Single file**: `command("readFile", { path: "src/main.ts" })`
- **Multiple files at once**: `command("readFile", { path: ["src/main.ts", "src/store.ts", "src/types.ts"] })`
- **Line range**: `command("readFile", { path: "src/main.ts", startLine: 10, endLine: 50 })`
- **Read + open in editor**: `command("readFile", { path: "src/main.ts", openInEditor: true })`
- **`openFile`** opens file(s) in editor tabs; supports `files[]` array: `command("openFile", { files: ["src/a.ts", "src/b.ts"] })`
- `query("openFile")` returns the currently active editor tab content with line numbers

## Important

- Read `yaar://skills/app_dev` before writing any app code — it has bundled libraries, design tokens, and anti-patterns
- Entry point is always `src/main.ts`
- Split code across files (protocol.ts, styles.css, helpers.ts, etc.)
- Check diagnostics after typecheck/compile and fix errors before deploying
- Use `query("project")` to see current project state, `query("openFile")` to see open file
