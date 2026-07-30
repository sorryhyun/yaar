# Devtools

IDE for building and deploying YAAR apps. Manages projects in app storage; provides file editing, type checking, compilation, preview and versioned deployment.

Note: devtools ships an `AGENTS.md`, which takes priority over this file for its own agent. This is the short description other agents see via `yaar://apps/devtools`.

## Workflow

1. Open the devtools window if not already open
2. `command("createProject", { name: "my-app" })` — or `command("cloneApp", { appId })` to edit an existing app. Both open the project they make.
3. `command("writeFile", { path: "src/main.ts", content: "..." })` — entry point is always `src/main.ts`
4. `command("compile", {}, { timeoutMs: 60000 })` — type checks *and* builds; no separate `typecheck` needed
5. `command("preview")` then `command("previewScreenshot")` — verify it actually renders
6. `command("deploy", { appId: "my-app", name: "My App", icon: "✅", message: "what changed" })`
7. `command("deleteProject", { id })` — clean up, especially clones

## Notes

- File commands only see the **active project's sandbox** — they return empty if no project is open
- Look a library up before writing against it: `command("describeBundledLibrary", { name })` — bundled libraries, design tokens (`name: "design-tokens"`), and SDK signatures
- Deploys are versioned — a bad one rolls back with `command("gitRestore", { appId, ref: "HEAD~1" })`
