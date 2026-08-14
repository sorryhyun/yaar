---
name: app-dev
description: Building, compiling, and verifying YAAR apps in apps/. Use when creating or editing an app, running build:apps, or debugging an app compile.
paths:
  - "apps/**"
---

# App Dev

Conventions live in [`apps/CLAUDE.md`](../../../apps/CLAUDE.md). Protocol schema details:
[`docs/reference/app_protocol_reference.md`](../../../docs/reference/app_protocol_reference.md).

## Compiling one app

```bash
bun run build:apps <appId>               # compile this app, whether or not it's stale
bun run build:apps <appId> --typecheck   # ...and tsc --noEmit over its src/
bun run build:apps                       # sweep every stale app (release/dev-server path)
bun run check:apps                       # guardrail lint across every app (no-web-storage, no-promise-sleep, ...)
```

Naming an app id means "compile this one" — the staleness hash only covers the app's own
sources, so an edit outside them (a bundled-library bump, `agent/prompt.md`) would otherwise
report "skipped". An id matching no app fails and lists the known ids. Run after
`bun run --filter '*' build` — the script uses the compiler's built `dist/`.

Each check answers only its own question:

- `build:apps` — Bun.build, the guards (Solid `html` templates, mount targets, design tokens),
  and protocol extraction. It **transpiles types away**, so a green compile says nothing about
  tsc.
- `build:apps --typecheck` — adds `tsc --noEmit` over the app's `src/`, with the gated
  `@bundled/*` types its `app.json` `bundles` allows. Opt-in because it's the slow half.
- `check:apps` — the repo's app guardrail lint, across every app at once.

None of these run the app. For a change whose effect is visual or stateful, still open it.

## Seeing a change for real

Use the `preview` route (`http://localhost:8000/api/dev/preview/{appId}`) or a real session —
see [`docs/guides/headless_driving.md`](../../../docs/guides/headless_driving.md) for driving
either one.

## Creating a new app

Folder name = app id. Minimum layout:

```
apps/my-app/
├── app.json         # { name, icon, description, ... } — see app.json Reference below
├── agent/
│   └── prompt.md     # optional: only if the app needs more than its manifest
└── src/
    └── main.ts        # compiled apps only; entry point is always src/main.ts
```

`app.json` is parsed leniently (unknown/wrong-typed fields are silently ignored — a typo fails
quietly). Full field table and the three app shapes (compiled / API-based / prompt-only manual):
[`docs/guides/app-development.md`](../../../docs/guides/app-development.md) (`app.json`
Reference, App Types sections).
