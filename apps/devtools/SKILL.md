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

## Important

- Read `yaar://skills/app_dev` before writing any app code — it has bundled libraries, design tokens, and anti-patterns
- Entry point is always `src/main.ts`
- Split code across files (protocol.ts, styles.css, helpers.ts, etc.)
- Check diagnostics after typecheck/compile and fix errors before deploying
- Use `query("project")` to see current project state, `query("openFile")` to see open file
